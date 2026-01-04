/**
 * Facebook Unified Inbox + Admin Dashboard
 * Fix: Updated for Gemini 1.5 Flash compatibility & Fallback logic
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

if (!GEMINI_API_KEY) {
    console.error("❌ CRITICAL: GEMINI_API_KEY is missing! AI will not work.");
}

// Gemini Setup with Safety Settings
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// AI Response Function (With Fallback)
async function generateAIResponse(prompt) {
    try {
        // Try fast model first
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", safetySettings });
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("⚠️ Gemini 1.5 Flash failed, trying Gemini Pro...", error.message);
        try {
            // Fallback to stable model
            const modelPro = genAI.getGenerativeModel({ model: "gemini-pro", safetySettings });
            const result = await modelPro.generateContent(prompt);
            return result.response.text();
        } catch (finalError) {
            console.error("❌ All AI models failed:", finalError.message);
            return null; // Return null to indicate failure
        }
    }
}

// --- DATABASE HELPER ---
let dbClient;
async function getDb() {
    if (!dbClient) {
        dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
    }
    return dbClient.db(DB_NAME);
}

async function getPageData(pageId) {
    const db = await getDb();
    let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
    if (!data && /^\d+$/.test(pageId)) {
        data = await db.collection(COL_TOKENS).findOne({ Page_ID: parseInt(pageId) });
    }
    return data;
}

async function getUserProfile(userId, pageAccessToken) {
    try {
        const url = `https://graph.facebook.com/${userId}?fields=first_name,last_name&access_token=${pageAccessToken}`;
        const res = await axios.get(url);
        return `${res.data.first_name} ${res.data.last_name}`;
    } catch (error) { return null; }
}

async function saveMessage(pageId, userId, sender, text, pageToken = null) {
    try {
        const db = await getDb();
        const safePageId = pageId.toString();
        const safeUserId = userId.toString();

        await db.collection(COL_MESSAGES).insertOne({
            pageId: safePageId, userId: safeUserId, sender, text, timestamp: new Date()
        });
        
        const updateData = { lastInteraction: new Date() };
        if (sender === 'user' && pageToken) {
            const existing = await db.collection(COL_CONV_STATE).findOne({ pageId: safePageId, userId: safeUserId });
            if (!existing || !existing.userName) {
                const name = await getUserProfile(safeUserId, pageToken);
                if (name) updateData.userName = name;
            }
        }

        await db.collection(COL_CONV_STATE).updateOne(
            { pageId: safePageId, userId: safeUserId },
            { $set: updateData, $setOnInsert: { aiPaused: false } },
            { upsert: true }
        );
    } catch (e) { console.error("DB Error:", e.message); }
}

async function isAiPaused(pageId, userId) {
    try {
        const db = await getDb();
        const state = await db.collection(COL_CONV_STATE).findOne({ 
            pageId: pageId.toString(), userId: userId.toString() 
        });
        return state ? state.aiPaused : false;
    } catch (e) { return false; }
}

// --- API ENDPOINTS ---
const auth = (req, res, next) => {
    if (req.headers['x-admin-pass'] === ADMIN_PASSWORD) next();
    else res.status(401).json({ error: "Unauthorized" });
};

app.get('/api/inbox/conversations', auth, async (req, res) => {
    try {
        const db = await getDb();
        const convs = await db.collection(COL_CONV_STATE).find({}).sort({ lastInteraction: -1 }).limit(20).toArray();
        res.json(convs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inbox/messages', auth, async (req, res) => {
    try {
        const { pageId, userId } = req.query;
        const db = await getDb();
        const msgs = await db.collection(COL_MESSAGES)
            .find({ pageId: pageId.toString(), userId: userId.toString() })
            .sort({ timestamp: 1 }).limit(100).toArray();
        res.json(msgs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inbox/ai-status', auth, async (req, res) => {
    try {
        const { pageId, userId } = req.query;
        res.json({ paused: await isAiPaused(pageId, userId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/toggle-ai', auth, async (req, res) => {
    try {
        const { pageId, userId, paused } = req.body;
        const db = await getDb();
        await db.collection(COL_CONV_STATE).updateOne(
            { pageId: pageId.toString(), userId: userId.toString() },
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
        if (!pageData?.Access_Token) return res.status(400).json({ error: "Token not found" });

        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
            recipient: { id: userId }, message: { text: text }
        });
        await saveMessage(pageId, userId, 'admin', text);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', auth, async (req, res) => {
    const db = await getDb();
    res.json({ 
        totalLogs: await db.collection(COL_MESSAGES).countDocuments(),
        totalPages: await db.collection(COL_TOKENS).countDocuments()
    });
});

app.get('/api/pages', auth, async (req, res) => {
    const db = await getDb();
    res.json(await db.collection(COL_TOKENS).find({}, { projection: { Access_Token: 0 } }).toArray());
});

app.post('/api/pages', auth, async (req, res) => {
    try {
        const { name, id, token, persona } = req.body;
        const db = await getDb();
        let update = { Page_Name: name };
        if (token) update.Access_Token = token;
        if (persona !== undefined) update.System_Prompt = persona;
        
        await db.collection(COL_TOKENS).updateOne({ Page_ID: id.toString() }, { $set: update }, { upsert: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- WEBHOOK ---
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(publicPath, 'dashboard.html'))) res.sendFile(path.join(publicPath, 'dashboard.html'));
    else res.status(404).send("Dashboard not found.");
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    if (req.body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED');
        for (const entry of req.body.entry) {
            const pageId = entry.id;
            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;
                        if (senderId === pageId) continue;

                        const pageData = await getPageData(pageId);
                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        if (await isAiPaused(pageId, senderId)) {
                            console.log(`⏸️ AI Paused for ${senderId}`);
                            continue;
                        }

                        if (pageData?.Access_Token) {
                            console.log(`🤖 AI Processing for ${senderId}...`);
                            
                            const defaultPersona = `তুমি একজন প্রফেশনাল কাস্টমার সাপোর্ট এজেন্ট, কিন্তু অন্য দিকে তুমি একজন ভাল বন্ধু ও বটে। তুমি কাস্টমারের সমস্যার কথা মনোযোগ দিয়ে শোনো এবং সমাধানের চেষ্টা করো। নিয়ম: ১. সর্বদা 'জি', 'হুম', 'ওকে', 'ধন্যবাদ' এবং সম্মানসূচক শব্দ ব্যবহার করো। ২. কোনো প্রশ্নের উত্তর জানা না থাকলে মিথ্যা বলবে না, বরং বলো 'আমি এ ব্যাপারে জানিনা'।`;
                            const systemInstruction = pageData.System_Prompt || defaultPersona;
                            const fullPrompt = `System: ${systemInstruction}\nUser: "${userMsg}"\nReply (in Bangla unless asked otherwise):`;

                            // Generate Response
                            const aiReply = await generateAIResponse(fullPrompt);

                            if (aiReply) {
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                    recipient: { id: senderId }, message: { text: aiReply }
                                }).catch(err => console.error("FB Send Error:", err.response?.data || err.message));
                                
                                await saveMessage(pageId, senderId, 'ai', aiReply);
                                console.log(`✅ AI Replied: ${aiReply.substring(0,20)}...`);
                            } else {
                                console.error("❌ AI returned null response.");
                            }
                        } else {
                            console.error(`❌ Token missing for Page ${pageId}`);
                        }
                    }
                }
            }
        }
    } else res.sendStatus(404);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
