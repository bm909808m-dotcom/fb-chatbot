/**
 * Facebook Unified Inbox + Admin Dashboard
 * Fix: Optimized Model List (Prioritizing 'Lite' models to avoid 429 Errors)
 * Fix: Increased Retry Delay to 10s for Rate Limits
 * Fix: Removed unavailable 1.5/1.0 models to prevent 404s
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

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// UPDATED: Optimized Model List based on your available models
// Using 'Lite' first as it consumes less quota
const DEFAULT_MODELS = [
    "gemini-2.0-flash-lite",   // Lite version (Often has better availability)
    "gemini-2.5-flash",        // Newest Flash
    "gemini-2.0-flash",        // Standard Flash
    "gemini-flash-latest"      // Generic Fallback
];

// Helper to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- SMART AI RESPONSE FUNCTION WITH RETRY ---
async function generateAIResponse(prompt) {
    let errorLog = "";
    
    for (const modelName of DEFAULT_MODELS) {
        let attempts = 0;
        const maxAttempts = 2; 

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`🤖 AI Engine: Trying ${modelName} (Attempt ${attempts})...`);
                
                const model = genAI.getGenerativeModel({ model: modelName, safetySettings });
                
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 15000));
                const aiPromise = model.generateContent(prompt);
                
                const result = await Promise.race([aiPromise, timeoutPromise]);
                const response = await result.response;
                const text = response.text();
                
                if (text) {
                    console.log(`✅ AI Success with: ${modelName}`);
                    return { text: text, error: null };
                }
            } catch (error) {
                const isRateLimit = error.message.includes("429") || error.message.includes("Quota");
                console.warn(`⚠️ ${modelName} attempt ${attempts} failed:`, error.message);
                
                if (isRateLimit && attempts < maxAttempts) {
                    console.log("⏳ Rate limit hit. Waiting 10 seconds before retry...");
                    await sleep(10000); // Increased wait time to 10s
                } else {
                    errorLog += `[${modelName}]: ${error.message} | `;
                    break; 
                }
            }
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

        const prompt = "Hello Gemini, just say 'Active'";
        const result = await generateAIResponse(prompt);
        
        if (result.text) {
            res.send(`
                <div style="font-family:sans-serif; padding:20px; border:2px solid green; border-radius:10px;">
                    <h1 style="color:green">SUCCESS! 🎉</h1>
                    <p><b>AI Response:</b> ${result.text}</p>
                    <p>Gemini is working correctly.</p>
                </div>
            `);
        } else {
            res.send(`
                <div style="font-family:sans-serif; padding:20px; border:2px solid red; border-radius:10px;">
                    <h1 style="color:red">AI FAILED ❌</h1>
                    <p><b>Errors:</b><br> ${result.error}</p>
                    <hr>
                    <h3>Quota Limit Reached?</h3>
                    <p>If you see "429 Too Many Requests", you have used up your free quota for now. Wait a few minutes and try again.</p>
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
    console.log("📨 Webhook Hit!"); // START LOG
    
    if (req.body.object === 'page') {
        res.status(200).send('EVENT_RECEIVED'); // FB needs immediate response
        
        for (const entry of req.body.entry) {
            const pageId = entry.id;
            console.log(`📄 Event for Page ID: ${pageId}`); // LOG PAGE ID

            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;
                        console.log(`👤 User ${senderId} says: ${userMsg}`); // LOG USER MSG

                        if (senderId === pageId) continue; // Ignore self

                        // 1. Get Token
                        const pageData = await getPageData(pageId);
                        if (!pageData) console.log("⚠️ Page Data NOT FOUND in DB!");
                        
                        // 2. Save User Msg
                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        // 3. Check Pause
                        if (await isAiPaused(pageId, senderId)) {
                            console.log(`⏸️ AI is PAUSED for ${senderId}`);
                            continue;
                        }

                        // 4. Generate AI
                        if (pageData?.Access_Token) {
                            console.log(`🤖 Generating AI Response...`);
                            
                            const defaultPersona = `তুমি একজন প্রফেশনাল কাস্টমার সাপোর্ট এজেন্ট, কিন্তু অন্য দিকে তুমি একজন ভাল বন্ধু ও বটে।`;
                            const systemInstruction = pageData.System_Prompt || defaultPersona;
                            const fullPrompt = `System: ${systemInstruction}\nUser: "${userMsg}"\nReply (in Bangla unless asked otherwise):`;

                            // Generate Response
                            const aiResult = await generateAIResponse(fullPrompt);

                            if (aiResult.text) {
                                console.log(`✅ Sending to FB: ${aiResult.text.substring(0,20)}...`);
                                
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                    recipient: { id: senderId }, message: { text: aiResult.text }
                                }).then(() => {
                                    console.log("🚀 Message SENT to FB successfully!");
                                    saveMessage(pageId, senderId, 'ai', aiResult.text);
                                }).catch(err => {
                                    console.error("❌ FB API Error:", err.response?.data || err.message);
                                });
                                
                            } else {
                                console.error("❌ AI returned NULL. Log:", aiResult.error);
                            }
                        } else {
                            console.error(`❌ Missing Access Token for Page ${pageId}`);
                        }
                    }
                }
            }
        }
    } else res.sendStatus(404);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
