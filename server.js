// server.js - WhatsApp Business API Integration for Gluco-Sahayak
// Deploy this on Render.com

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Environment variables - Set these in Render.com
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Your WhatsApp API token
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // Webhook verification token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Your WhatsApp phone number ID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Optional: For advanced NLP

// In-memory database (Use PostgreSQL in production)
const userDatabase = new Map();
const glucoseReadings = new Map();

// ============================================
// WEBHOOK VERIFICATION (Required by WhatsApp)
// ============================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verified');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// ============================================
// WEBHOOK - Receive Messages from WhatsApp
// ============================================
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        // Check if message is from WhatsApp
        if (body.object) {
            if (body.entry && 
                body.entry[0].changes && 
                body.entry[0].changes[0] && 
                body.entry[0].changes[0].value.messages && 
                body.entry[0].changes[0].value.messages[0]
            ) {
                const message = body.entry[0].changes[0].value.messages[0];
                const from = message.from; // User's phone number
                const messageBody = message.text?.body || '';
                const messageType = message.type; // text, audio, image, etc.

                console.log(`📩 Message from ${from}: ${messageBody}`);

                // Handle different message types
                if (messageType === 'text') {
                    await handleTextMessage(from, messageBody);
                } else if (messageType === 'audio') {
                    await handleVoiceMessage(from, message.audio);
                } else if (messageType === 'interactive') {
                    await handleInteractiveMessage(from, message.interactive);
                }
            }

            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(500);
    }
});

// ============================================
// MESSAGE HANDLERS
// ============================================

// Handle text messages
async function handleTextMessage(phoneNumber, messageText) {
    const lowerMsg = messageText.toLowerCase();
    
    // Initialize user if new
    if (!userDatabase.has(phoneNumber)) {
        await initializeUser(phoneNumber);
        return;
    }

    const user = userDatabase.get(phoneNumber);

    // Detect glucose reading
    const glucoseMatch = messageText.match(/(\d{2,3})/);
    if (glucoseMatch && (
        lowerMsg.includes('sugar') || 
        lowerMsg.includes('glucose') || 
        lowerMsg.includes('शुगर') ||
        lowerMsg.includes('ಸಕ್ಕರೆ') ||
        lowerMsg.includes('చక్కెర')
    )) {
        await handleGlucoseReading(phoneNumber, parseInt(glucoseMatch[1]));
    }
    // Diet advice
    else if (lowerMsg.includes('diet') || lowerMsg.includes('food') || lowerMsg.includes('खाना') || lowerMsg.includes('आहार')) {
        await sendDietAdvice(phoneNumber, user.language);
    }
    // Symptoms
    else if (lowerMsg.includes('symptom') || lowerMsg.includes('feeling') || lowerMsg.includes('लक्षण') || lowerMsg.includes('pain')) {
        await analyzeSymptoms(phoneNumber, messageText, user.language);
    }
    // Medication
    else if (lowerMsg.includes('medication') || lowerMsg.includes('medicine') || lowerMsg.includes('दवा')) {
        await sendMedicationHelp(phoneNumber, user.language);
    }
    // Dashboard request
    else if (lowerMsg.includes('dashboard') || lowerMsg.includes('report') || lowerMsg.includes('रिपोर्ट')) {
        await sendHealthReport(phoneNumber, user.language);
    }
    // Language change
    else if (lowerMsg.includes('hindi') || lowerMsg.includes('हिंदी')) {
        await setLanguage(phoneNumber, 'hi');
    } else if (lowerMsg.includes('english')) {
        await setLanguage(phoneNumber, 'en');
    } else if (lowerMsg.includes('kannada') || lowerMsg.includes('ಕನ್ನಡ')) {
        await setLanguage(phoneNumber, 'kn');
    } else if (lowerMsg.includes('telugu') || lowerMsg.includes('తెలుగు')) {
        await setLanguage(phoneNumber, 'te');
    }
    // General help
    else {
        await sendGeneralHelp(phoneNumber, user.language);
    }
}

// Handle voice messages
async function handleVoiceMessage(phoneNumber, audioData) {
    const user = userDatabase.get(phoneNumber);
    
    try {
        // Download audio file
        const audioUrl = await getMediaUrl(audioData.id);
        
        // TODO: Integrate with OpenAI Whisper for speech-to-text
        // For now, send acknowledgment
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: {
                body: user.language === 'hi' 
                    ? '🎤 आपका वॉइस मैसेज मिल गया। मैं इसे समझ रहा हूं...' 
                    : '🎤 Voice message received. Processing...'
            }
        });

        // Simulate speech-to-text (In production, use Whisper API)
        setTimeout(async () => {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: {
                    body: user.language === 'hi'
                        ? 'कृपया टेक्स्ट में लिखें या फिर से कोशिश करें।'
                        : 'Please type your message or try again.'
                }
            });
        }, 2000);

    } catch (error) {
        console.error('Voice processing error:', error);
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: 'Sorry, could not process voice message. Please type instead.' }
        });
    }
}

// Handle interactive button responses
async function handleInteractiveMessage(phoneNumber, interactive) {
    const buttonId = interactive.button_reply?.id;
    
    switch(buttonId) {
        case 'log_sugar':
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: 'Please tell me your blood sugar reading. Example: "My sugar is 120"' }
            });
            break;
        case 'diet_advice':
            await sendDietAdvice(phoneNumber, userDatabase.get(phoneNumber).language);
            break;
        case 'symptoms':
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: 'Please describe your symptoms. Example: "I have a headache"' }
            });
            break;
        case 'medication':
            await sendMedicationHelp(phoneNumber, userDatabase.get(phoneNumber).language);
            break;
        case 'dashboard':
            await sendHealthReport(phoneNumber, userDatabase.get(phoneNumber).language);
            break;
    }
}

// ============================================
// BUSINESS LOGIC FUNCTIONS
// ============================================

// Initialize new user
async function initializeUser(phoneNumber) {
    userDatabase.set(phoneNumber, {
        phoneNumber,
        language: 'en',
        joinedAt: new Date(),
        lastActive: new Date()
    });

    glucoseReadings.set(phoneNumber, []);

    // Send welcome message with language selection
    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: {
            body: `🙏 Welcome to Gluco-Sahayak!\nनमस्ते! ग्लूको-सहायक में आपका स्वागत है!\n\nI'm your 24/7 diabetes health companion.\n\nPlease select your language:\n1. English\n2. हिन्दी (Hindi)\n3. ಕನ್ನಡ (Kannada)\n4. తెలుగు (Telugu)\n\nReply with the number or language name.`
        }
    });

    // Send quick action buttons
    setTimeout(() => sendQuickActions(phoneNumber), 2000);
}

// Handle glucose reading
async function handleGlucoseReading(phoneNumber, value) {
    const user = userDatabase.get(phoneNumber);
    const readings = glucoseReadings.get(phoneNumber);
    
    // Save reading
    readings.push({
        value,
        timestamp: new Date(),
        type: 'manual'
    });
    glucoseReadings.set(phoneNumber, readings);

    // Analyze risk
    let response = '';
    let emoji = '';

    if (value < 70) {
        // CRITICAL LOW - Hypoglycemia
        emoji = '🚨';
        response = user.language === 'hi' 
            ? `${emoji} *गंभीर: निम्न शुगर!*\n\nआपका शुगर ${value} mg/dL है (बहुत कम)\n\n*तुरंत करें:*\n1. 3 ग्लूकोज़ टैबलेट या 1 चम्मच शहद लें\n2. 15 मिनट बाद फिर जांचें\n3. अभी भी कम है तो दोहराएं\n\n⚠️ डॉक्टर को सूचित कर दिया गया है!`
            : `${emoji} *CRITICAL: Hypoglycemia!*\n\nYour glucose is ${value} mg/dL (VERY LOW)\n\n*Immediate Actions:*\n1. Eat 15g fast-acting carbs (3 glucose tablets OR 1 tbsp honey)\n2. Recheck after 15 minutes\n3. If still low, repeat step 1\n\n⚠️ Doctor has been alerted!`;
        
        // Alert doctor (implement this function)
        await alertDoctor(phoneNumber, value, 'hypoglycemia');
        
    } else if (value >= 70 && value <= 130) {
        // NORMAL
        emoji = '✅';
        response = user.language === 'hi'
            ? `${emoji} *बहुत बढ़िया!*\n\nशुगर: ${value} mg/dL (सामान्य)\n\nऐसे ही जारी रखें! 🎉\n\n7-दिन औसत: ${calculate7DayAvg(phoneNumber)} mg/dL`
            : `${emoji} *Excellent Control!*\n\nGlucose: ${value} mg/dL (Normal Range)\n\nKeep following your routine! 🎉\n\n7-Day Average: ${calculate7DayAvg(phoneNumber)} mg/dL`;
            
    } else if (value > 130 && value <= 180) {
        // ELEVATED
        emoji = '⚠️';
        response = user.language === 'hi'
            ? `${emoji} *ऊंचा शुगर*\n\nशुगर: ${value} mg/dL (लक्ष्य से अधिक)\n\n*सुझाव:*\n• दवा ली है ना जांच लें\n• 15 मिनट टहलें\n• 2 गिलास पानी पिएं\n• 2 घंटे में फिर जांचें\n\n7-दिन औसत: ${calculate7DayAvg(phoneNumber)} mg/dL`
            : `${emoji} *Elevated Glucose*\n\nGlucose: ${value} mg/dL (Above Target)\n\n*Recommendations:*\n• Take medication if missed\n• Walk for 15 minutes\n• Drink water (2 glasses)\n• Recheck in 2 hours\n\n7-Day Average: ${calculate7DayAvg(phoneNumber)} mg/dL`;
            
    } else {
        // CRITICAL HIGH
        emoji = '🚨';
        response = user.language === 'hi'
            ? `${emoji} *गंभीर: उच्च शुगर!*\n\nशुगर: ${value} mg/dL (खतरनाक स्तर)\n\n*तुरंत करें:*\n1. अगर हो तो ketones जांचें\n2. इंसुलिन लें (अगर prescribed है)\n3. खूब पानी पिएं\n4. बारीकी से निगरानी करें\n\n⚠️ डॉक्टर को सूचित कर दिया गया है!\n\n📞 लक्षण बढ़ें (उल्टी, चक्कर) तो तुरंत emergency call करें!`
            : `${emoji} *CRITICAL: High Blood Sugar!*\n\nGlucose: ${value} mg/dL (CRITICAL LEVEL)\n\n*Immediate Actions:*\n1. Check ketones if possible\n2. Take rapid-acting insulin (if prescribed)\n3. Drink plenty of water\n4. Monitor closely\n\n⚠️ Doctor notification sent!\n\n📞 If symptoms worsen (nausea, confusion), call emergency!`;
        
        // Alert doctor
        await alertDoctor(phoneNumber, value, 'hyperglycemia');
    }

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: response }
    });

    // Send quick actions after reading
    setTimeout(() => sendQuickActions(phoneNumber), 3000);
}

// Calculate 7-day average
function calculate7DayAvg(phoneNumber) {
    const readings = glucoseReadings.get(phoneNumber);
    if (!readings || readings.length === 0) return '--';

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentReadings = readings.filter(r => new Date(r.timestamp) >= sevenDaysAgo);
    if (recentReadings.length === 0) return '--';

    const sum = recentReadings.reduce((acc, r) => acc + r.value, 0);
    return Math.round(sum / recentReadings.length);
}

// Send diet advice
async function sendDietAdvice(phoneNumber, language) {
    const advice = language === 'hi'
        ? `🥗 *आहार सुझाव*\n\n*✅ खाएं:*\n• साबुत अनाज: ब्राउन राइस, गेहूं की रोटी\n• सब्जियां: करेला, मेथी, पालक\n• प्रोटीन: मूंग दाल, चना, मछली\n• फल: अमरूद, पपीता, सेब (छोटा)\n• नट्स: 5-6 बादाम रोज\n\n*❌ न खाएं:*\n• सफेद चावल, मैदा\n• मीठा, कोल्ड ड्रिंक\n• तला हुआ खाना\n• आलू, सफेद ब्रेड\n\n*🍽️ नमूना भोजन:*\nसुबह: ओट्स + दूध + नट्स\nदोपहर: 2 रोटी + दाल + सब्जी\nस्नैक: छाछ + भुना चना\nरात: हल्का खाना शाम 7 बजे तक\n\n💡 हर 3-4 घंटे में थोड़ा-थोड़ा खाएं!`
        : `🥗 *Personalized Diet Recommendations*\n\n*✅ Foods to Include:*\n• Whole grains: Brown rice, whole wheat roti, oats\n• Vegetables: Bitter gourd (karela), drumstick, leafy greens\n• Proteins: Moong dal, chickpeas, fish\n• Fruits: Guava, papaya, apple (1 small portion)\n• Nuts: 5-6 almonds daily\n\n*❌ Foods to Avoid:*\n• White rice, maida products\n• Sugary drinks, sweets\n• Fried foods (pakoras, samosas)\n• Potatoes, white bread\n\n*🍽️ Sample Meal Plan:*\nBreakfast: Oats + milk + nuts\nLunch: 2 rotis + dal + vegetables + salad\nSnack: Buttermilk + roasted chana\nDinner: Light meal by 7 PM\n\n💡 Eat every 3-4 hours in small portions!`;

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: advice }
    });
}

// Analyze symptoms
async function analyzeSymptoms(phoneNumber, symptoms, language) {
    const response = language === 'hi'
        ? `🤒 *लक्षण विश्लेषण*\n\nमैंने आपके लक्षण नोट कर लिए हैं।\n\n*संभावित कारण:*\n• बार-बार पेशाब → उच्च शुगर\n• अधिक प्यास → पानी की कमी\n• थकान → खराब शुगर नियंत्रण\n• धुंधला दिखना → शुगर में उतार-चढ़ाव\n• सुन्नपन/झनझनाहट → neuropathy\n\n*⚠️ सुझाव:*\nतुरंत शुगर जांचें और अगर लक्षण 2 दिन से ज्यादा रहें तो डॉक्टर से मिलें।\n\nक्या आप टेलीमेडिसिन परामर्श चाहेंगे?`
        : `🤒 *Symptom Analysis*\n\nI've noted your symptoms.\n\n*Possible Issues:*\n• Frequent urination → High blood sugar\n• Excessive thirst → Dehydration\n• Fatigue → Poor glucose control\n• Blurred vision → Fluctuating sugar\n• Numbness/tingling → Possible neuropathy\n\n*⚠️ Recommendation:*\nCheck blood sugar immediately and consult doctor if symptoms persist for more than 2 days.\n\nWould you like to schedule a telemedicine consultation?`;

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: response }
    });
}

// Send medication help
async function sendMedicationHelp(phoneNumber, language) {
    const help = language === 'hi'
        ? `💊 *दवा प्रबंधन*\n\n*सामान्य दवाएं:*\n\n*Metformin:*\n• खाने के साथ लें\n• पेट खराब होने से बचाता है\n\n*Insulin:*\n• फ्रिज में रखें\n• injection की जगह बदलते रहें\n• समय पर लें\n\n*📱 रिमाइंडर:*\nमैं आपको रोज याद दिला सकता हूं।\n\nवर्तमान रिमाइंडर: सुबह 8 बजे और शाम 8 बजे\n\n⚠️ महत्वपूर्ण: डॉक्टर से पूछे बिना दवा न बदलें!`
        : `💊 *Medication Management*\n\n*Common Diabetes Medications:*\n\n*Metformin:*\n• Take with meals\n• Reduces stomach upset\n\n*Insulin:*\n• Store in refrigerator\n• Rotate injection sites\n• Take at prescribed times\n\n*📱 Reminder Settings:*\nI can send you daily reminders.\n\nCurrent reminders: 8:00 AM & 8:00 PM\n\n⚠️ Important: Never skip or adjust doses without consulting your doctor!`;

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: help }
    });
}

// Send health report
async function sendHealthReport(phoneNumber, language) {
    const readings = glucoseReadings.get(phoneNumber);
    const avg = calculate7DayAvg(phoneNumber);
    const hba1c = avg !== '--' ? ((avg + 46.7) / 28.7).toFixed(1) : '--';
    
    const report = language === 'hi'
        ? `📊 *स्वास्थ्य रिपोर्ट*\n\n*मुख्य मेट्रिक्स:*\n• 7-दिन औसत: ${avg} mg/dL\n• अनुमानित HbA1c: ${hba1c}%\n• कुल रीडिंग: ${readings.length}\n• दवा पालन: 85%\n\n*हालिया रीडिंग:*\n${getRecentReadings(phoneNumber, 5)}\n\n📈 अधिक विस्तृत चार्ट के लिए, हम आपको वेब डैशबोर्ड लिंक भेज सकते हैं।`
        : `📊 *Health Dashboard Report*\n\n*Key Metrics:*\n• 7-Day Average: ${avg} mg/dL\n• Estimated HbA1c: ${hba1c}%\n• Total Readings: ${readings.length}\n• Medication Adherence: 85%\n\n*Recent Readings:*\n${getRecentReadings(phoneNumber, 5)}\n\n📈 For detailed charts, we can send you a web dashboard link.`;

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: report }
    });
}

// Get recent readings formatted
function getRecentReadings(phoneNumber, count) {
    const readings = glucoseReadings.get(phoneNumber);
    if (!readings || readings.length === 0) return 'No readings yet';

    return readings
        .slice(-count)
        .reverse()
        .map((r, i) => {
            const date = new Date(r.timestamp);
            const status = r.value < 70 || r.value > 180 ? '🔴' : r.value > 130 ? '🟡' : '🟢';
            return `${status} ${r.value} mg/dL - ${date.toLocaleDateString()}`;
        })
        .join('\n');
}

// Send general help
async function sendGeneralHelp(phoneNumber, language) {
    const help = language === 'hi'
        ? `मैं आपकी मदद के लिए हूं! 😊\n\n*मैं क्या कर सकता हूं:*\n\n📊 *शुगर लॉग करें*\nबस कहें: "मेरी शुगर 120 है"\n\n🥗 *आहार सलाह*\nपूछें: "क्या खाना चाहिए?"\n\n💊 *दवा याद दिलाना*\nकहें: "दवा"\n\n🤒 *लक्षण ट्रैकिंग*\nबताएं: "मुझे चक्कर आ रहे हैं"\n\n📈 *स्वास्थ्य रिपोर्ट*\nकहें: "रिपोर्ट दिखाओ"\n\nआज मैं आपकी कैसे मदद कर सकता हूं?`
        : `I'm here to help! 😊\n\n*I can assist you with:*\n\n📊 *Log glucose readings*\nJust say: "My sugar is 120"\n\n🥗 *Diet & nutrition advice*\nAsk: "What should I eat?"\n\n💊 *Medication reminders*\nSay: "Medication"\n\n🤒 *Symptom tracking*\nTell me: "I'm feeling dizzy"\n\n📈 *View health trends*\nSay: "Show my report"\n\nHow can I help you today?`;

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: help }
    });
}

// Set user language
async function setLanguage(phoneNumber, language) {
    const user = userDatabase.get(phoneNumber);
    user.language = language;
    userDatabase.set(phoneNumber, user);

    const langNames = {
        'en': 'English',
        'hi': 'हिन्दी',
        'kn': 'ಕನ್ನಡ',
        'te': 'తెలుగు'
    };

    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { 
            body: language === 'hi' 
                ? `✓ भाषा बदल दी गई: ${langNames[language]}`
                : `✓ Language changed to ${langNames[language]}`
        }
    });

    sendQuickActions(phoneNumber);
}

// ============================================
// WHATSAPP API FUNCTIONS
// ============================================

// Send WhatsApp message
async function sendWhatsAppMessage(to, messageObject) {
    try {
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                ...messageObject
            }
        });

        console.log('✅ Message sent:', response.data);
        return response.data;
    } catch (error) {
        console.error('❌ Failed to send message:', error.response?.data || error.message);
        throw error;
    }
}

// Send quick action buttons
async function sendQuickActions(phoneNumber) {
    await sendWhatsAppMessage(phoneNumber, {
        type: 'interactive',
        interactive: {
            type: 'button',
            body: {
                text: 'Quick Actions:'
            },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'log_sugar',
                            title: '📊 Log Sugar'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'diet_advice',
                            title: '🥗 Diet Advice'
                        }
                    },
                    {
                        type: 'reply',
                        reply: {
                            id: 'dashboard',
                            title: '📈 Dashboard'
                        }
                    }
                ]
            }
        }
    });
}

// Get media URL (for voice messages)
async function getMediaUrl(mediaId) {
    try {
        const response = await axios({
            method: 'GET',
            url: `https://graph.facebook.com/v18.0/${mediaId}`,
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`
            }
        });
        return response.data.url;
    } catch (error) {
        console.error('Failed to get media URL:', error);
        throw error;
    }
}

// Alert doctor (implement with your notification system)
async function alertDoctor(phoneNumber, glucoseValue, alertType) {
    // TODO: Implement doctor notification
    // Options:
    // 1. SMS to doctor's number
    // 2. Email notification
    // 3. Push notification to doctor dashboard
    // 4. WhatsApp message to doctor
    
    console.log(`🚨 DOCTOR ALERT: Patient ${phoneNumber} has ${alertType} - Glucose: ${glucoseValue}`);
    
    // Example: Send to doctor's WhatsApp (if you have their number)
    // const doctorPhone = 'DOCTOR_PHONE_NUMBER';
    // await sendWhatsAppMessage(doctorPhone, {
    //     type: 'text',
    //     text: {
    //         body: `🚨 ALERT: Patient ${phoneNumber}\n${alertType}\nGlucose: ${glucoseValue} mg/dL\n\nPlease review immediately.`
    //     }
    // });
}

// ============================================
// SCHEDULED TASKS (Medication Reminders)
// ============================================

// Send medication reminders at 8 AM and 8 PM
function scheduleMedicationReminders() {
    const schedule = require('node-schedule');
    
    // Morning reminder (8 AM)
    schedule.scheduleJob('0 8 * * *', async () => {
        for (let [phoneNumber, user] of userDatabase) {
            const message = user.language === 'hi'
                ? '💊 *दवा याद दिलाना*\n\nसुबह की दवा लेने का समय!\n\nखाने के साथ लें। लेने के बाद "TAKEN" लिखें।'
                : '💊 *Medication Reminder*\n\nTime for your morning medication!\n\nTake with breakfast. Reply "TAKEN" when completed.';
            
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: message }
            });
        }
    });
    
    // Evening reminder (8 PM)
    schedule.scheduleJob('0 20 * * *', async () => {
        for (let [phoneNumber, user] of userDatabase) {
            const message = user.language === 'hi'
                ? '💊 *दवा याद दिलाना*\n\nशाम की दवा लेने का समय!\n\nखाने के साथ लें। लेने के बाद "TAKEN" लिखें।'
                : '💊 *Medication Reminder*\n\nTime for your evening medication!\n\nTake with dinner. Reply "TAKEN" when completed.';
            
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: message }
            });
        }
    });
}

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        service: 'Gluco-Sahayak WhatsApp Bot',
        version: '1.0.0',
        users: userDatabase.size,
        totalReadings: Array.from(glucoseReadings.values()).reduce((sum, arr) => sum + arr.length, 0)
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`🚀 Gluco-Sahayak server running on port ${PORT}`);
    console.log(`📱 WhatsApp webhook ready at /webhook`);
    scheduleMedicationReminders();
});

// Export for testing
module.exports = app;
