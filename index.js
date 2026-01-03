/**
 * Facebook Unified Inbox + Admin Dashboard + Custom Persona + Auto Refresh
 * Features: Live Chat, Human Takeover, AI Pause/Resume, Name Fetching
 */

const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

// পাবলিক ফোল্ডার পাথ
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = "fb_automation_db";

const COL_TOKENS = "page_tokens";
const COL_MESSAGES = "messages";          
const COL_CONV_STATE = "conversation_states"; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "my_secure_token_2026";
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "admin123"; 

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- DATABASE HELPER ---
let dbClient;
async function getDb() {
    if (!dbClient) {
        dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
    }
    return dbClient.db(DB_NAME);
}

// ইউজারের নাম ফেসবুক থেকে নিয়ে আসার ফাংশন (NEW)
async function getUserProfile(userId, pageAccessToken) {
    try {
        const url = `https://graph.facebook.com/${userId}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
        const res = await axios.get(url);
        const userData = res.data;
        return `${userData.first_name} ${userData.last_name}`;
    } catch (error) {
        // যদি নাম না পাওয়া যায়, তবে কিছু রিটার্ন করবে না
        return null;
    }
}

// মেসেজ সেভ করার সময় নামও সেভ করা হবে (Updated)
async function saveMessage(pageId, userId, sender, text, pageToken = null) {
    try {
        const db = await getDb();
        await db.collection(COL_MESSAGES).insertOne({
            pageId,
            userId,
            sender, 
            text,
            timestamp: new Date()
        });
        
        // কনভারসেশন স্টেট আপডেট (নাম সহ)
        const updateData = { lastInteraction: new Date() };
        
        // যদি ইউজার হয় এবং আমাদের কাছে টোকেন থাকে, তবে নাম আনার চেষ্টা করব
        if (sender === 'user' && pageToken) {
            // আগে চেক করি নাম অলরেডি আছে কিনা
            const existingState = await db.collection(COL_CONV_STATE).findOne({ pageId, userId });
            if (!existingState || !existingState.userName) {
                const name = await getUserProfile(userId, pageToken);
                if (name) {
                    updateData.userName = name;
                }
            }
        }

        await db.collection(COL_CONV_STATE).updateOne(
            { pageId, userId },
            { 
                $set: updateData,
                $setOnInsert: { aiPaused: false } 
            },
            { upsert: true }
        );
    } catch (e) { 
        console.error("Save Msg Error:", e); 
    }
}

async function isAiPaused(pageId, userId) {
    try {
        const db = await getDb();
        const state = await db.collection(COL_CONV_STATE).findOne({ pageId, userId });
        return state ? state.aiPaused : false;
    } catch (e) { 
        return false; 
    }
}

async function getPageData(pageId) {
    const db = await getDb();
    return await db.collection(COL_TOKENS).findOne({ Page_ID: pageId });
}

// --- ADMIN API ENDPOINTS ---

const auth = (req, res, next) => {
    if (req.headers['x-admin-pass'] === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
};

app.get('/api/inbox/conversations', auth, async (req, res) => {
    try {
        const db = await getDb();
        const convs = await db.collection(COL_CONV_STATE)
            .find({})
            .sort({ lastInteraction: -1 })
            .limit(20)
            .toArray();
        res.json(convs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inbox/messages', auth, async (req, res) => {
    try {
        const { pageId, userId } = req.query;
        const db = await getDb();
        const msgs = await db.collection(COL_MESSAGES)
            .find({ pageId, userId })
            .sort({ timestamp: 1 }) 
            .limit(100)
            .toArray();
        res.json(msgs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inbox/ai-status', auth, async (req, res) => {
    try {
        const { pageId, userId } = req.query;
        const paused = await isAiPaused(pageId, userId);
        res.json({ paused });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/toggle-ai', auth, async (req, res) => {
    try {
        const { pageId, userId, paused } = req.body;
        const db = await getDb();
        await db.collection(COL_CONV_STATE).updateOne(
            { pageId, userId },
            { $set: { aiPaused: paused } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/reply', auth, async (req, res) => {
    try {
        const { pageId, userId, text } = req.body;
        const pageData = await getPageData(pageId);
        
        if (!pageData || !pageData.Access_Token) {
            return res.status(400).json({ error: "Page token not found" });
        }

        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
            recipient: { id: userId },
            message: { text: text }
        });

        await saveMessage(pageId, userId, 'admin', text);
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: e.message }); 
    }
});

// Stats & Pages API
app.get('/api/stats', auth, async (req, res) => {
    const db = await getDb();
    const totalLogs = await db.collection(COL_MESSAGES).countDocuments();
    const totalPages = await db.collection(COL_TOKENS).countDocuments();
    res.json({ totalLogs, totalPages });
});

app.get('/api/pages', auth, async (req, res) => {
    const db = await getDb();
    const pages = await db.collection(COL_TOKENS).find({}, { projection: { Access_Token: 0 } }).toArray();
    res.json(pages);
});

app.post('/api/pages', auth, async (req, res) => {
    try {
        const { name, id, token, persona } = req.body;
        const db = await getDb();
        
        let updateFields = { Page_Name: name };
        if (token) updateFields.Access_Token = token; 
        if (persona !== undefined) updateFields.System_Prompt = persona;

        await db.collection(COL_TOKENS).updateOne(
            { Page_ID: id },
            { $set: updateFields },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- WEBHOOK LOGIC ---

app.get('/', (req, res) => {
    const dashboardPath = path.join(publicPath, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) res.sendFile(dashboardPath);
    else res.status(404).send("Dashboard not found. Check 'public' folder.");
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            const pageId = entry.id;
            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;

                        if (senderId === pageId) continue;

                        // 0. Get Page Token for Name Fetching
                        const pageData = await getPageData(pageId);
                        
                        // 1. Save User Message (and Fetch Name)
                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        // 2. Check Pause Status
                        const paused = await isAiPaused(pageId, senderId);
                        if (paused) {
                            console.log(`AI Paused for user ${senderId}.`);
                            continue;
                        }

                        try {
                            if (!pageData || !pageData.Access_Token) continue;

                            const defaultPersona = "You are a helpful customer support assistant. Keep replies short and polite.";
                            const systemInstruction = pageData.System_Prompt || defaultPersona;

                            const chatPrompt = `System: ${systemInstruction}\nUser: "${userMsg}"\nReply (in Bangla/English as appropriate):`;
                            
                            const result = await model.generateContent(chatPrompt);
                            const aiReply = result.response.text();

                            // 4. Send Reply
                            await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                recipient: { id: senderId },
                                message: { text: aiReply }
                            });

                            // 5. Save AI Message
                            await saveMessage(pageId, senderId, 'ai', aiReply);

                        } catch (err) {
                            console.error("AI Error:", err.message);
                        }
                    }
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

app.listen(PORT, () => {
    console.log(`Inbox Server running on port ${PORT}`);
});
