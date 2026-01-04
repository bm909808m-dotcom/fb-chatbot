/**
 * Facebook Unified Inbox + Admin Dashboard
 * Fix: Auto-detects available Gemini Models to fix 404 Errors
 * Features: Live Chat, Human Takeover, AI Pause, User Names
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
    console.error("❌ CRITICAL ERROR: GEMINI_API_KEY is missing!");
}

// Gemini Setup
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// fallback list if auto-detection fails
const DEFAULT_MODELS = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro", "gemini-pro"];

// --- SMART AI RESPONSE FUNCTION ---
async function generateAIResponse(prompt) {
    let errorLog = "";
    
    // 1. Try to fetch available models dynamically first
    let availableModels = [];
    try {
        const listRes = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
        if(listRes.data && listRes.data.models) {
            // Filter models that support 'generateContent'
            availableModels = listRes.data.models
                .filter(m => m.supportedGenerationMethods.includes("generateContent"))
                .map(m => m.name.replace('models/', '')); // remove 'models/' prefix
        }
    } catch (e) {
        console.warn("⚠️ Could not list models dynamically, using defaults.");
    }

    // Combine detected models with defaults (detected first)
    const modelsToTry = [...new Set([...availableModels, ...DEFAULT_MODELS])];

    // 2. Loop through models until one works
    for (const modelName of modelsToTry) {
        try {
            // console.log(`🤖 Trying Model: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            
            if (text) {
                console.log(`✅ Success with model: ${modelName}`);
                return { text: text, error: null };
            }
        } catch (error) {
            // console.warn(`⚠️ ${modelName} failed: ${error.message}`);
            errorLog += `[${modelName}]: ${error.message} <br>`;
        }
    }
    
    return { text: null, error: errorLog };
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

// Fixed: Robust Page ID Search
async function getPageData(pageId) {
    const db = await getDb();
    let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
    if (!data && /^\d+$/.test(pageId)) {
        data = await db.collection(COL_TOKENS).findOne({ Page_ID: parseInt(pageId) });
    }
    return data;
}

// Fetch User Name from Facebook
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

// NEW: Ultimate AI Tester Route
app.get('/test-ai', async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.send(`<h1 style="color:red">API Key Missing</h1>`);

        // Check available models first to show user
        let modelStatus = "";
        try {
            const listRes = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
            const models = listRes.data.models || [];
            const chatModels = models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
            modelStatus = `<b>Available Models for your Key:</b><br>` + chatModels.map(m => `<span style="color:blue">${m.name}</span>`).join(", ");
        } catch (e) {
            modelStatus = `<b style="color:red">Could not list models. Check if 'Generative Language API' is enabled in Google Cloud Console.</b> Error: ${e.message}`;
        }

        const prompt = "Hello Gemini, just say 'Active'";
        const result = await generateAIResponse(prompt);
        
        if (result.text) {
            res.send(`
                <div style="font-family:sans-serif; padding:20px; border:2px solid green; border-radius:10px;">
                    <h1 style="color:green">SUCCESS! 🎉</h1>
                    <p><b>AI Response:</b> ${result.text}</p>
                    <hr>
                    <p>${modelStatus}</p>
                </div>
            `);
        } else {
            res.send(`
                <div style="font-family:sans-serif; padding:20px; border:2px solid red; border-radius:10px;">
                    <h1 style="color:red">AI FAILED ❌</h1>
                    <p><b>Errors:</b><br> ${result.error}</p>
                    <hr>
                    <p>${modelStatus}</p>
                </div>
            `);
        }
    } catch (e) {
        res.status(500).send(`Server Error: ${e.message}`);
    }
});

// ... Standard API Routes ...
app.get('/api/inbox/conversations', auth, async (req, res) => {
    try { const db = await getDb(); res.json(await db.collection(COL_CONV_STATE).find({}).sort({ lastInteraction: -1 }).limit(20).toArray()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/inbox/messages', auth, async (req, res) => {
    try { const db = await getDb(); res.json(await db.collection(COL_MESSAGES).find({ pageId: req.query.pageId.toString(), userId: req.query.userId.toString() }).sort({ timestamp: 1 }).limit(100).toArray()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/inbox/ai-status', auth, async (req, res) => {
    try { res.json({ paused: await isAiPaused(req.query.pageId, req.query.userId) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/inbox/toggle-ai', auth, async (req, res) => {
    try { const db = await getDb(); await db.collection(COL_CONV_STATE).updateOne({ pageId: req.body.pageId.toString(), userId: req.body.userId.toString() }, { $set: { aiPaused: req.body.paused } }, { upsert: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/inbox/reply', auth, async (req, res) => {
    try { const pageData = await getPageData(req.body.pageId); if (!pageData?.Access_Token) return res.status(400).json({ error: "Page token not found in DB" }); await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, { recipient: { id: req.body.userId }, message: { text: req.body.text } }); await saveMessage(req.body.pageId, req.body.userId, 'admin', req.body.text); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});
app.get('/api/stats', auth, async (req, res) => {
    const db = await getDb(); res.json({ totalLogs: await db.collection(COL_MESSAGES).countDocuments(), totalPages: await db.collection(COL_TOKENS).countDocuments() });
});
app.get('/api/pages', auth, async (req, res) => {
    const db = await getDb(); res.json(await db.collection(COL_TOKENS).find({}, { projection: { Access_Token: 0 } }).toArray());
});
app.post('/api/pages', auth, async (req, res) => {
    try { const db = await getDb(); let update = { Page_Name: req.body.name }; if (req.body.token) update.Access_Token = req.body.token; if (req.body.persona !== undefined) update.System_Prompt = req.body.persona; await db.collection(COL_TOKENS).updateOne({ Page_ID: req.body.id.toString() }, { $set: update }, { upsert: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
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
                        // Save Msg & Fetch Name if possible
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

                            // Generate Response (Using new robust function)
                            const aiResult = await generateAIResponse(fullPrompt);

                            if (aiResult.text) {
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                    recipient: { id: senderId }, message: { text: aiResult.text }
                                }).catch(err => console.error("FB Send Error:", err.response?.data || err.message));
                                
                                await saveMessage(pageId, senderId, 'ai', aiResult.text);
                                console.log(`✅ AI Replied.`);
                            } else {
                                console.error("❌ AI Error:", aiResult.error);
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
