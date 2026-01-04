/**
 * Facebook Unified Inbox + Admin Dashboard
 * Feature: Keyword Based Auto-Reply (Manual Logic)
 * Updated: Smart Token Detection (Checks both Access_Token & access_token)
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
function getKeywordReply(userMsg, rulesText) {
    if (!rulesText) return null;

    const msg = userMsg.toLowerCase().trim();
    const lines = rulesText.split('\n');
    let matchedResponse = null;
    let defaultResponse = null;

    for (const line of lines) {
        const parts = line.split('->');
        if (parts.length < 2) continue;

        const keyword = parts[0].trim().toLowerCase();
        const response = parts.slice(1).join('->').trim();

        if (keyword === 'default' || keyword === 'else') {
            defaultResponse = response;
            continue;
        }

        if (msg.includes(keyword)) {
            matchedResponse = response;
            break; 
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

// পেজ খোঁজার লজিক
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

// Test Logic Route
app.get('/test-bot', async (req, res) => {
    const rules = "hello -> Hi there!\nprice -> The price is 500tk.\ndefault -> I don't understand.";
    const testMsg1 = "hello bot";
    const testMsg2 = "what is the price?";
    
    const reply1 = getKeywordReply(testMsg1, rules);
    const reply2 = getKeywordReply(testMsg2, rules);

    res.send(`
        <h1>Keyword Bot Test</h1>
        <p>Input: "${testMsg1}" => Output: <b>${reply1}</b></p>
        <p>Input: "${testMsg2}" => Output: <b>${reply2}</b></p>
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
    try { 
        const pageData = await getPageData(req.body.pageId);
        const token = pageData?.Access_Token || pageData?.access_token; // Smart check
        
        if (!token) return res.status(400).json({ error: "Page token not found in DB" }); 
        
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { recipient: { id: req.body.userId }, message: { text: req.body.text } }); 
        await saveMessage(req.body.pageId, req.body.userId, 'admin', req.body.text); 
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});
app.get('/api/stats', auth, async (req, res) => {
    const db = await getDb(); res.json({ totalLogs: await db.collection(COL_MESSAGES).countDocuments(), totalPages: await db.collection(COL_TOKENS).countDocuments() });
});
app.get('/api/pages', auth, async (req, res) => {
    const db = await getDb(); res.json(await db.collection(COL_TOKENS).find({}, { projection: { Access_Token: 0 } }).toArray());
});
app.get('/api/page/:id', auth, async (req, res) => {
    try {
        const db = await getDb();
        const pageId = req.params.id;
        let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
        if (!data && /^\d+$/.test(pageId)) data = await db.collection(COL_TOKENS).findOne({ Page_ID: parseInt(pageId) });
        if (data) res.json(data); else res.status(404).json({ error: "Page not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            console.log(`\n📨 New Event from Page: ${pageId}`);

            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;
                        console.log(`👤 User ${senderId} says: "${userMsg}"`);

                        if (senderId === pageId) {
                            console.log("➡️ Ignoring bot's own message.");
                            continue; 
                        }

                        // 1. Database Check
                        const pageData = await getPageData(pageId);
                        
                        if (!pageData) {
                            console.error(`❌ CRITICAL: Page ID ${pageId} NOT FOUND in MongoDB!`);
                            console.error(`👉 Action: Go to Dashboard -> Pages -> Add Page with ID: ${pageId}`);
                            continue;
                        }

                        // Handle both Case Sensitive Token names
                        const accessToken = pageData.Access_Token || pageData.access_token;

                        await saveMessage(pageId, senderId, 'user', userMsg, accessToken);

                        if (await isAiPaused(pageId, senderId)) {
                            console.log(`⏸️ Bot is Manually PAUSED for ${senderId}`);
                            continue;
                        }

                        // 2. Token Check
                        if (accessToken) {
                            // 3. Rules Check
                            const rulesText = pageData.System_Prompt || "";
                            
                            if (!rulesText) {
                                console.warn(`⚠️ Rules (System_Prompt) are EMPTY for Page ${pageId}. No reply sent.`);
                                continue;
                            }

                            console.log(`🔎 Checking keyword rules...`);
                            const replyText = getKeywordReply(userMsg, rulesText);

                            if (replyText) {
                                console.log(`✅ Match! Reply: "${replyText}"`);
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${accessToken}`, {
                                    recipient: { id: senderId }, message: { text: replyText }
                                }).then(() => {
                                    console.log("🚀 Reply Sent Successfully!");
                                    saveMessage(pageId, senderId, 'bot', replyText);
                                }).catch(err => {
                                    console.error("❌ Facebook API Error:", err.response?.data || err.message);
                                    if (err.response?.data?.error?.code === 190) {
                                        console.error("👉 Action: Token Expired! Please update token in Dashboard.");
                                    }
                                });
                            } else {
                                console.log("⚠️ No matching keyword found in rules. Bot stayed silent.");
                            }
                        } else {
                            // Debugging: Show what keys exist if token is missing
                            console.error(`❌ Missing Access Token for Page ${pageId} in DB!`);
                            console.error(`👉 Found Fields in DB: ${Object.keys(pageData).join(', ')}`);
                            console.error(`👉 Please update the token for this page in the Dashboard.`);
                        }
                    }
                }
            }
        }
    } else res.sendStatus(404);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));    const lines = rulesText.split('\n');
    let matchedResponse = null;
    let defaultResponse = null;

    for (const line of lines) {
        const parts = line.split('->');
        if (parts.length < 2) continue;

        const keyword = parts[0].trim().toLowerCase();
        const response = parts.slice(1).join('->').trim();

        if (keyword === 'default' || keyword === 'else') {
            defaultResponse = response;
            continue;
        }

        if (msg.includes(keyword)) {
            matchedResponse = response;
            break; 
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

// পেজ খোঁজার লজিক (String এবং Number দুইভাবেই চেক করবে)
async function getPageData(pageId) {
    const db = await getDb();
    
    // ১. স্ট্রিং হিসেবে খোঁজা
    let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
    
    // ২. না পেলে নম্বর হিসেবে খোঁজা
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

// Test Logic Route
app.get('/test-bot', async (req, res) => {
    const rules = "hello -> Hi there!\nprice -> The price is 500tk.\ndefault -> I don't understand.";
    const testMsg1 = "hello bot";
    const testMsg2 = "what is the price?";
    
    const reply1 = getKeywordReply(testMsg1, rules);
    const reply2 = getKeywordReply(testMsg2, rules);

    res.send(`
        <h1>Keyword Bot Test</h1>
        <p>Input: "${testMsg1}" => Output: <b>${reply1}</b></p>
        <p>Input: "${testMsg2}" => Output: <b>${reply2}</b></p>
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
app.get('/api/page/:id', auth, async (req, res) => {
    try {
        const db = await getDb();
        const pageId = req.params.id;
        let data = await db.collection(COL_TOKENS).findOne({ Page_ID: pageId.toString() });
        if (!data && /^\d+$/.test(pageId)) data = await db.collection(COL_TOKENS).findOne({ Page_ID: parseInt(pageId) });
        if (data) res.json(data); else res.status(404).json({ error: "Page not found" });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            console.log(`\n📨 New Event from Page: ${pageId}`);

            if (entry.messaging) {
                for (const event of entry.messaging) {
                    if (event.message && event.message.text) {
                        const senderId = event.sender.id;
                        const userMsg = event.message.text;
                        console.log(`👤 User ${senderId} says: "${userMsg}"`);

                        if (senderId === pageId) {
                            console.log("➡️ Ignoring bot's own message.");
                            continue; 
                        }

                        // 1. Database Check
                        const pageData = await getPageData(pageId);
                        
                        if (!pageData) {
                            console.error(`❌ CRITICAL: Page ID ${pageId} NOT FOUND in MongoDB!`);
                            console.error(`👉 Action: Go to Dashboard -> Pages -> Add Page with ID: ${pageId}`);
                            continue;
                        }

                        await saveMessage(pageId, senderId, 'user', userMsg, pageData?.Access_Token);

                        if (await isAiPaused(pageId, senderId)) {
                            console.log(`⏸️ Bot is Manually PAUSED for ${senderId}`);
                            continue;
                        }

                        // 2. Token Check
                        if (pageData?.Access_Token) {
                            // 3. Rules Check
                            const rulesText = pageData.System_Prompt || "";
                            
                            if (!rulesText) {
                                console.warn(`⚠️ Rules (System_Prompt) are EMPTY for Page ${pageId}. No reply sent.`);
                                continue;
                            }

                            console.log(`🔎 Checking keyword rules...`);
                            const replyText = getKeywordReply(userMsg, rulesText);

                            if (replyText) {
                                console.log(`✅ Match! Reply: "${replyText}"`);
                                await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageData.Access_Token}`, {
                                    recipient: { id: senderId }, message: { text: replyText }
                                }).then(() => {
                                    console.log("🚀 Reply Sent Successfully!");
                                    saveMessage(pageId, senderId, 'bot', replyText);
                                }).catch(err => {
                                    console.error("❌ Facebook API Error:", err.response?.data || err.message);
                                    if (err.response?.data?.error?.code === 190) {
                                        console.error("👉 Action: Token Expired! Please update token in Dashboard.");
                                    }
                                });
                            } else {
                                console.log("⚠️ No matching keyword found in rules. Bot stayed silent.");
                            }
                        } else {
                            console.error(`❌ Missing Access Token for Page ${pageId} in DB!`);
                        }
                    }
                }
            }
        }
    } else res.sendStatus(404);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));

