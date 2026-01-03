/**
 * Facebook 45 Pages Automation Master Script
 * Tech Stack: Node.js, Express, MongoDB, Gemini AI
 */

const express = require('express');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(express.json());

// --- ১. কনফিগারেশন ভেরিয়েবল (Environment Variables) ---
// এই তথ্যগুলো Render-এর সেটিংসে থাকবে, কোডে সরাসরি বসাবেন না
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; 
const DB_NAME = "fb_automation_db";
const COLLECTION_NAME = "page_tokens";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// ফেসবুকে যে ভেরিফাই টোকেন দেবেন, সেটা এখানেও মিলতে হবে
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "my_secure_token_2026";

// Gemini AI সেটআপ
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Gemini 1.5 Flash মডেল ব্যবহার করা হচ্ছে কারণ এটি দ্রুত এবং সাশ্রয়ী
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- ২. ডাটাবেস হেল্পার ফাংশন ---

// ডাটাবেস থেকে নির্দিষ্ট পেজের টোকেন খুঁজে বের করা
async function getPageAccessToken(pageId) {
    // প্রতিবার নতুন কানেকশন তৈরি না করে গ্লোবাল ক্লায়েন্ট ব্যবহার করা ভালো, 
    // তবে সহজলব্যের জন্য এখানে ফাংশনাল স্কোপ ব্যবহার করা হয়েছে।
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db(DB_NAME);
        
        // পেজ আইডি দিয়ে টোকেন খোঁজা হচ্ছে
        // আমাদের আপলোড করা CSV ফাইলে কলামের নাম ছিল 'Page_ID'
        const pageData = await db.collection(COLLECTION_NAME).findOne({ Page_ID: pageId });
        
        return pageData ? pageData.Access_Token : null;
    } catch (error) {
        console.error("Database Error:", error);
        return null;
    } finally {
        await client.close();
    }
}

// --- ৩. মেইন সার্ভার রুট ---

// রুট চেক (সার্ভার বেঁচে আছে কিনা দেখার জন্য)
app.get('/', (req, res) => {
    res.send('Facebook Automation Server is Running... 🚀');
});

// ফেসবুক ভেরিফিকেশন (Webhook Setup এর সময় এটি লাগে)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// মেসেজ হ্যান্ডলিং (আসল কাজ এখানে হয়)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    // চেক করা ইভেন্টটি পেজ থেকে এসেছে কিনা
    if (body.object === 'page') {
        // সাথে সাথে ফেসবুককে জানানো যে আমরা মেসেজ পেয়েছি 
        // (দেরি করলে ফেসবুক এরর মনে করে আবার মেসেজ পাঠাবে)
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            // পেজের আইডি (কোন পেজে মেসেজ এসেছে)
            const pageId = entry.id;
            // মেসেজ ইভেন্ট অ্যারে থেকে প্রথমটি নেওয়া
            if (entry.messaging && entry.messaging.length > 0) {
                const webhook_event = entry.messaging[0];
                
                // শুধুমাত্র টেক্সট মেসেজ আসলে কাজ করবে
                if (webhook_event.message && webhook_event.message.text) {
                    const senderId = webhook_event.sender.id;
                    const userMessage = webhook_event.message.text;

                    // বটের নিজের মেসেজ ইগনোর করা (ইনফিনিট লুপ আটকানোর জন্য)
                    if (senderId === pageId) continue;

                    console.log(`New Message on Page ${pageId}: ${userMessage}`);

                    try {
                        // ১. ডাটাবেস থেকে পেজ টোকেন আনা
                        const pageAccessToken = await getPageAccessToken(pageId);

                        if (!pageAccessToken) {
                            console.error(`Token not found for Page ID: ${pageId}. Make sure it's in MongoDB.`);
                            continue;
                        }

                        // ২. জেমিনি (AI) থেকে উত্তর তৈরি করা
                        // প্রম্পট কাস্টমাইজ করতে পারেন এখানে
                        const chatPrompt = `You are a polite customer support assistant used by a business page. 
                        User message: "${userMessage}". 
                        Reply in the same language as the user (Bengali or English). 
                        Keep the reply short, helpful, and professional.`;
                        
                        const result = await model.generateContent(chatPrompt);
                        const aiReply = result.response.text();

                        // ৩. ফেসবুকে রিপ্লাই পাঠানো
                        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`, {
                            recipient: { id: senderId },
                            message: { text: aiReply }
                        });

                        // ৪. টেলিগ্রামে নোটিফিকেশন পাঠানো (যদি টোকেন থাকে)
                        if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
                            const telegramMsg = `🔔 <b>New Interaction!</b>\n\n<b>Page ID:</b> ${pageId}\n<b>User:</b> ${userMessage}\n<b>AI Reply:</b> ${aiReply}`;
                            try {
                                await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                                    chat_id: TELEGRAM_CHAT_ID,
                                    text: telegramMsg,
                                    parse_mode: 'HTML'
                                });
                            } catch (telError) {
                                console.error("Telegram Error:", telError.message);
                            }
                        }

                    } catch (error) {
                        console.error("Processing Error:", error.message);
                    }
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// সার্ভার স্টার্ট
app.listen(PORT, () => console.log(`Server is live on port ${PORT}`));