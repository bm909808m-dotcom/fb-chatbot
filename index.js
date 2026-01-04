/**
 * Facebook Unified Inbox + Admin Dashboard
 * Feature: Keyword Based Auto-Reply (Manual Logic)
 * Removed: Google Gemini AI dependencies completely
 */

const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
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

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "my_secure_token_2026";
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "admin123"; 

// --- MANUAL KEYWORD LOGIC ---
// এই ফাংশনটি আপনার দেওয়া রুলস চেক করে উত্তর তৈরি করবে
function getKeywordReply(userMsg, rulesText) {
    if (!rulesText) return null;

    const msg = userMsg.toLowerCase().trim();
    const lines = rulesText.split('\n');
    let matchedResponse = null;
    let defaultResponse = null;

    for (const line of lines) {
        // ফরম্যাট: keyword -> response
        const parts = line.split('->');
        if (parts.length < 2) continue;

        const keyword = parts[0].trim().toLowerCase();
        const response = parts.slice(1).join('->').trim(); // বাকি অংশটুকু রেসপন্স

        // ডিফল্ট মেসেজ সেট করা (যদি কোনো কী-ওয়ার্ড না মিলে)
        if (keyword === 'default' || keyword === 'else') {
            defaultResponse = response;
            continue;
        }

        // যদি মেসেজের মধ্যে কী-ওয়ার্ড পাওয়া যায়
        if (msg.includes(keyword)) {
            matchedResponse = response;
            break; // প্রথম ম্যাচ পেলেই থামবে
        }
    }

    return matchedResponse || defaultResponse;
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

// Test Logic Route (No AI)
app.get('/test-bot', async (req, res) => {
    const rules = "hello -> Hi there!\nprice -> The price is 500tk.\ndefault -> I don't understand.";
    const testMsg1 = "hello bot";
    const testMsg2 = "what is the price?";
    const testMsg3 = "bla bla";

    const reply1 = getKeywordReply(testMsg1, rules);
    const reply2 = getKeywordReply(testMsg2, rules);
    const reply3 = getKeywordReply(testMsg3, rules);

    res.send(`
        <h1>Keyword Bot Test</h1>
        <p><b>Rules:</b> <pre>${rules}</pre></p>
        <p>Input: "${testMsg1}" => Output: <b>${reply1}</b></p>
        <p>Input: "${testMsg2}" => Output: <b>${reply2}</b></p>
        <p>Input: "${testMsg3}" => Output: <b>${reply3}</b></p>
    `);
});

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
                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        // Pause Logic (এখনও কাজ করবে)
                        if (await isAiPaused(pageId, senderId)) {
                            console.log(`⏸️ Bot Paused for ${senderId}`);
                            continue;
                        }

                        if (pageData?.Access_Token) {
                            console.log(`🔎 Checking keywords for User: ${senderId}`);
                            
                            // MANUAL KEYWORD LOGIC
                            // System_Prompt ফিল্ড থেকেই এখন রুলস নেবে
                            const rulesText = pageData.System_Prompt || "";
                            const replyText = getKeywordReply(userMsg, rulesText);

                            if (replyText) {
                                console.log(`✅ Match Found! Sending: ${replyText}`);
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                    recipient: { id: senderId }, message: { text: replyText }
                                }).catch(err => console.error("❌ FB API Error:", err.response?.data || err.message));
                                
                                await saveMessage(pageId, senderId, 'bot', replyText);
                            } else {
                                console.log("⚠️ No keyword match found. Silent.");
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
