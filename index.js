/**
 * Facebook Unified Inbox + Admin Dashboard + Custom Persona + Auto Refresh
 * Fixed: Page Token Not Found Issue & AI Toggle Logic
 * Updated: Robust AI Error Handling & Safety Settings
 * Fixed: Persona Saving Issue (ID Type Mismatch)
 * Updated: Default Bangla Persona
 */

const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

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

// Check API Key on Startup
if (!GEMINI_API_KEY) {
    console.error("❌ CRITICAL ERROR: GEMINI_API_KEY is missing in Environment Variables!");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    // Safety Settings Relaxed (যাতে সাধারণ প্রশ্নে ব্লক না করে)
    safetySettings: [
        {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
        {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_NONE,
        },
    ]
});

// --- DATABASE HELPER ---
let dbClient;
async function getDb() {
    if (!dbClient) {
        dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
    }
    return dbClient.db(DB_NAME);
}

// FIX: পেজ আইডি স্ট্রিং বা নম্বর যাই হোক না কেন, খুঁজে বের করবে
async function getPageData(pageId) {
    const db = await getDb();
    // প্রথমে সরাসরি স্ট্রিং দিয়ে খোঁজা
    let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
    
    // না পেলে, নম্বর হিসেবে চেষ্টা করা (যদি CSV আপলোডে নম্বর হয়ে থাকে)
    if (!data) {
        // যদি pageId তে শুধু সংখ্যা থাকে
        if (/^\d+$/.test(pageId)) {
            data = await db.collection(COL_TOKENS).findOne({ Page_ID: parseInt(pageId) });
        }
    }
    return data;
}

async function getUserProfile(userId, pageAccessToken) {
    try {
        const url = `https://graph.facebook.com/${userId}?fields=first_name,last_name,profile_pic&access_token=${pageAccessToken}`;
        const res = await axios.get(url);
        const userData = res.data;
        return `${userData.first_name} ${userData.last_name}`;
    } catch (error) { return null; }
}

async function saveMessage(pageId, userId, sender, text, pageToken = null) {
    try {
        const db = await getDb();
        // স্ট্রিং হিসেবে সেভ করা নিশ্চিত করা
        const safePageId = pageId.toString();
        const safeUserId = userId.toString();

        await db.collection(COL_MESSAGES).insertOne({
            pageId: safePageId,
            userId: safeUserId,
            sender, 
            text,
            timestamp: new Date()
        });
        
        const updateData = { lastInteraction: new Date() };
        
        if (sender === 'user' && pageToken) {
            const existingState = await db.collection(COL_CONV_STATE).findOne({ pageId: safePageId, userId: safeUserId });
            if (!existingState || !existingState.userName) {
                const name = await getUserProfile(safeUserId, pageToken);
                if (name) updateData.userName = name;
            }
        }

        await db.collection(COL_CONV_STATE).updateOne(
            { pageId: safePageId, userId: safeUserId },
            { 
                $set: updateData,
                $setOnInsert: { aiPaused: false } 
            },
            { upsert: true }
        );
    } catch (e) { console.error("Save Msg Error:", e); }
}

async function isAiPaused(pageId, userId) {
    try {
        const db = await getDb();
        const state = await db.collection(COL_CONV_STATE).findOne({ 
            pageId: pageId.toString(), 
            userId: userId.toString() 
        });
        return state ? state.aiPaused : false;
    } catch (e) { return false; }
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
            .find({ pageId: pageId.toString(), userId: userId.toString() })
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

// FIX: Toggle AI Logic updated
app.post('/api/inbox/toggle-ai', auth, async (req, res) => {
    try {
        const { pageId, userId, paused } = req.body;
        if(!pageId || !userId) return res.status(400).json({error: "Missing ID"});

        const db = await getDb();
        await db.collection(COL_CONV_STATE).updateOne(
            { pageId: pageId.toString(), userId: userId.toString() },
            { $set: { aiPaused: paused } },
            { upsert: true }
        );
        res.json({ success: true, status: paused ? "Paused" : "Active" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// FIX: Reply Logic with Better Token Search
app.post('/api/inbox/reply', auth, async (req, res) => {
    try {
        const { pageId, userId, text } = req.body;
        console.log(`Sending reply to ${userId} from page ${pageId}`);

        const pageData = await getPageData(pageId);
        
        if (!pageData || !pageData.Access_Token) {
            console.error(`Token missing for Page ID: ${pageId}. Check page_tokens collection.`);
            return res.status(400).json({ 
                error: `Page token not found for ID: ${pageId}. Please re-add the page in 'Pages' tab.` 
            });
        }

        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
            recipient: { id: userId },
            message: { text: text }
        });

        await saveMessage(pageId, userId, 'admin', text);
        res.json({ success: true });
    } catch (e) { 
        console.error("Send Reply Error:", e.response ? e.response.data : e.message);
        res.status(500).json({ 
            error: e.response && e.response.data && e.response.data.error 
                ? e.response.data.error.message 
                : e.message 
        }); 
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

// FIX: Page Saving Logic (ID Type Mismatch Fix)
app.post('/api/pages', auth, async (req, res) => {
    try {
        const { name, id, token, persona } = req.body;
        const db = await getDb();
        
        let updateFields = { Page_Name: name };
        if (token) updateFields.Access_Token = token; 
        if (persona !== undefined) updateFields.System_Prompt = persona;

        // ডিফল্ট হিসেবে স্ট্রিং আইডি ব্যবহার করব
        const safeIdStr = id.toString();
        let filterQuery = { Page_ID: safeIdStr };

        // ১. প্রথমে চেক করি এই আইডি স্ট্রিং হিসেবে আছে কিনা
        const existingDoc = await db.collection(COL_TOKENS).findOne({ Page_ID: safeIdStr });
        
        // ২. যদি স্ট্রিং হিসেবে না পাই, তবে নম্বর হিসেবে চেক করি (পুরাতন ডাটা বা CSV আপলোডের ক্ষেত্রে)
        if (!existingDoc && /^\d+$/.test(safeIdStr)) {
            const idNum = parseInt(safeIdStr);
            const existingDocNum = await db.collection(COL_TOKENS).findOne({ Page_ID: idNum });
            // যদি নম্বর হিসেবে পাই, তবে আপডেট করার সময় নম্বর দিয়েই ফিল্টার করব
            if (existingDocNum) {
                filterQuery = { Page_ID: idNum };
            }
        }

        await db.collection(COL_TOKENS).updateOne(
            filterQuery,
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
            const pageId = entry.id; // Facebook sends this as String
            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;

                        if (senderId === pageId) continue;

                        const pageData = await getPageData(pageId);
                        
                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        const paused = await isAiPaused(pageId, senderId);
                        if (paused) {
                            console.log(`AI Paused for user ${senderId}.`);
                            continue;
                        }

                        try {
                            if (!pageData || !pageData.Access_Token) {
                                console.log(`Missing token for Page ${pageId}, skipping AI reply.`);
                                continue;
                            }

                            console.log(`🤖 Generating AI reply for User: ${senderId}`);

                            // UPDATE: Default Bangla Persona
                            const defaultPersona = `তুমি একজন প্রফেশনাল কাস্টমার সাপোর্ট এজেন্ট, কিন্তু অন্য দিকে তুমি একজন ভাল বন্ধু ও বটে। তুমি কাস্টমারের সমস্যার কথা মনোযোগ দিয়ে শোনো এবং সমাধানের চেষ্টা করো।
নিয়ম:
১. সর্বদা 'জি', 'হুম', 'ওকে', 'ধন্যবাদ' এবং সম্মানসূচক শব্দ ব্যবহার করো।
২. কোনো প্রশ্নের উত্তর জানা না থাকলে মিথ্যা বলবে না, বরং বলো 'আমি এ ব্যাপারে জানিনা'।`;
                            
                            const systemInstruction = pageData.System_Prompt || defaultPersona;

                            const chatPrompt = `System: ${systemInstruction}\nUser: "${userMsg}"\nReply (in Bangla unless asked otherwise):`;
                            
                            const result = await model.generateContent(chatPrompt);
                            const response = await result.response;
                            const aiReply = response.text();
                            
                            console.log(`✅ AI Reply generated: ${aiReply.substring(0, 20)}...`);

                            await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                recipient: { id: senderId },
                                message: { text: aiReply }
                            });

                            await saveMessage(pageId, senderId, 'ai', aiReply);

                        } catch (err) {
                            console.error("❌ AI/Facebook Error:", err);
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
