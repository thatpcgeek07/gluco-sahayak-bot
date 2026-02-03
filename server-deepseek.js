const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const PHYSICIAN_PHONE = process.env.PHYSICIAN_PHONE;

// DeepSeek Configuration
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
let isDeepSeekAvailable = false;

// Test DeepSeek API on startup
async function initializeDeepSeek() {
  try {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      console.warn('⚠️  DeepSeek API key not configured - using fallback mode');
      return false;
    }

    // Test API connection
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 50
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data?.choices?.[0]?.message) {
      isDeepSeekAvailable = true;
      console.log('✅ DeepSeek R1 connected successfully');
      return true;
    }
  } catch (error) {
    console.error('❌ DeepSeek initialization failed:', error.response?.data || error.message);
    isDeepSeekAvailable = false;
    return false;
  }
}

initializeDeepSeek();

// MongoDB Schemas
const patientSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: String,
  age: Number,
  diabetesType: String,
  registeredAt: { type: Date, default: Date.now },
  language: { type: String, default: 'en' },
  medicationSchedule: [{
    medicationName: String,
    time: String,
    frequency: String
  }],
  reminderPreferences: {
    glucoseLogging: { type: Boolean, default: true },
    medication: { type: Boolean, default: true }
  }
});

const glucoseReadingSchema = new mongoose.Schema({
  patientPhone: { type: String, required: true },
  reading: { type: Number, required: true },
  readingType: { type: String, enum: ['fasting', 'postprandial', 'random'], required: true },
  timestamp: { type: Date, default: Date.now },
  symptoms: [String],
  notes: String,
  alertSent: { type: Boolean, default: false }
});

const conversationSchema = new mongoose.Schema({
  patientPhone: String,
  messages: [{
    role: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  lastActive: { type: Date, default: Date.now }
});

const Patient = mongoose.model('Patient', patientSchema);
const GlucoseReading = mongoose.model('GlucoseReading', glucoseReadingSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

mongoose.connect(MONGODB_URI).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// Medical Thresholds (CMR Guidelines 2018, IDF Atlas 2021, WHO)
const MEDICAL_THRESHOLDS = {
  fasting: { normal: { max: 100 }, diabetes: { min: 126 }, critical_low: 70, critical_high: 250 },
  postprandial: { normal: { max: 140 }, diabetes: { min: 200 }, critical_low: 70, critical_high: 300 },
  random: { critical_low: 70, critical_high: 250 }
};

// WhatsApp Functions
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    }, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    console.log(`✅ Sent to ${to}`);
  } catch (error) {
    console.error('❌ Send error:', error.response?.data || error.message);
  }
}

async function downloadWhatsAppMedia(mediaId) {
  try {
    const { data } = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    
    const mediaResponse = await axios.get(data.url, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });
    
    return Buffer.from(mediaResponse.data);
  } catch (error) {
    console.error('❌ Media download failed:', error.message);
    return null;
  }
}

// Note: DeepSeek doesn't support audio transcription natively
// Would need a separate transcription service like OpenAI Whisper
async function transcribeAudio(audioBuffer) {
  console.warn('⚠️  Audio transcription not available with DeepSeek');
  return null;
}

// Smart Fallback System
function generateSmartResponse(message) {
  const lower = message.toLowerCase();
  const glucoseMatch = message.match(/(\d{2,3})/);
  const glucose = glucoseMatch ? parseInt(glucoseMatch[1]) : null;
  
  // Greetings
  if (lower.match(/^(hi|hello|hey|namaste|नमस्ते)/)) {
    return `Hello! 🙏 I'm Gluco Sahayak, your diabetes assistant.

I help with:
📊 Glucose logging
🍽️ Diet advice
🚶 Exercise tips
💊 Medication reminders

Send: "My sugar is 120" or ask anything! 😊`;
  }
  
  // Glucose readings
  if (glucose && glucose >= 40 && glucose <= 500) {
    let response = `✅ Logged: ${glucose} mg/dL\n\n`;
    
    if (glucose < 70) {
      response += `🚨 LOW! (Hypoglycemia)

DO NOW:
• Eat 15g fast carbs (juice/honey/glucose tablets)
• Rest 15 min
• Recheck
• If still low, repeat

Get help if worse! 🏥`;
    } else if (glucose <= 100) {
      response += `✅ EXCELLENT! Normal range.

Keep it up:
• Healthy eating
• Stay active
• Take meds
Great job! 👏`;
    } else if (glucose <= 125) {
      response += `⚠️ PREDIABETES range

Improve:
• More vegetables
• Daily walk 30min
• Less rice/sweets
• See doctor`;
    } else if (glucose <= 180) {
      response += `⚠️ ELEVATED

Action:
• Review diet
• Exercise daily
• Check medication
• Monitor closely`;
    } else if (glucose <= 250) {
      response += `🚨 HIGH!

Steps:
• Drink water
• No sweets
• Walk 15min
• Recheck in 2hr
• Call doctor if stays high`;
    } else {
      response += `🚨🚨 CRITICAL HIGH!

URGENT:
• Contact doctor NOW
• Drink water
• DON'T exercise
• Watch for nausea/confusion
• Go to ER if very sick! 🏥`;
    }
    return response;
  }
  
  // Diet
  if (lower.match(/eat|food|diet|breakfast|lunch|dinner/)) {
    return `🍽️ Diabetes Diet

MEALS:
• Breakfast: Oats/upma + egg/paneer
• Lunch: Roti + dal + vegetables + salad
• Dinner: Light, early (before 8pm)
• Snacks: Nuts, fruits, roasted chana

AVOID:
❌ White rice, sweets, fried foods, sugary drinks

CHOOSE:
✅ Vegetables, whole grains, protein, water

Portion control is key! 💪`;
  }
  
  // Exercise
  if (lower.match(/exercise|walk|yoga/)) {
    return `🚶 Exercise Guide

DAILY:
• Walk 30-45 min
• After meals: 15-20 min
• Yoga: Surya namaskar, pranayama

SAFETY:
⚠️ Check glucose first
⚠️ Don't exercise if >250
⚠️ Carry glucose tablets
⚠️ Stay hydrated

Best time: 1-2hr after meals 💪`;
  }
  
  // Default
  return `Got it: "${message}"

How can I help?
📊 "My sugar is 120"
🍽️ "What to eat?"
🚶 "Exercise tips?"
💊 "Set reminder"

Just ask! 😊`;
}

// DeepSeek AI Integration
async function analyzeWithDeepSeek(phone, message, history = []) {
  if (isDeepSeekAvailable) {
    try {
      const patient = await Patient.findOne({ phone });
      const readings = await GlucoseReading.find({ patientPhone: phone })
        .sort({ timestamp: -1 }).limit(5);

      const systemPrompt = `You are Gluco Sahayak, a caring diabetes management assistant for patients in India.

PATIENT CONTEXT:
- Name: ${patient?.name || 'New patient'}
- Recent glucose readings: ${readings.map(r => `${r.reading} mg/dL (${r.readingType})`).join(', ') || 'No previous readings'}

MEDICAL GUIDELINES (CMR 2018, IDF 2021, WHO):
- Fasting glucose: Normal <100, Prediabetes 100-125, Diabetes ≥126 mg/dL
- Postprandial (2hr): Normal <140, Prediabetes 140-199, Diabetes ≥200 mg/dL
- Critical levels: <70 (hypoglycemia - urgent!), >250 (severe hyperglycemia - urgent!)
- HbA1c target: <7% for most adults

YOUR ROLE:
1. Log and analyze glucose readings when mentioned
2. Provide evidence-based diet/lifestyle advice for Indian patients
3. Be warm, supportive, and culturally sensitive
4. Use Indian context: roti, dal, sabzi, walking, yoga
5. If critical levels detected, strongly urge immediate medical attention
6. Always clarify you provide guidance, not replace doctor consultation

RESPONSE STYLE:
- Concise (max 150 words)
- Empathetic and encouraging
- Practical and actionable
- Clear warnings for dangerous levels

Current user message: "${message}"

Respond naturally and helpfully:`;

      const response = await axios.post(
        DEEPSEEK_API_URL,
        {
          model: 'deepseek-reasoner',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
          ],
          max_tokens: 600,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );

      const aiResponse = response.data?.choices?.[0]?.message?.content;
      
      if (aiResponse && aiResponse.length > 10) {
        console.log('✅ DeepSeek R1 response generated');
        return aiResponse;
      }
    } catch (error) {
      console.error('❌ DeepSeek error:', error.response?.data || error.message);
      // Fall through to fallback
    }
  }
  
  console.log('ℹ️ Using fallback response');
  return generateSmartResponse(message);
}

function extractGlucoseData(message) {
  const match = message.match(/(\d{2,3})/);
  const reading = match ? parseInt(match[1]) : null;
  
  if (!reading || reading < 40 || reading > 500) return { hasReading: false };

  const lower = message.toLowerCase();
  const readingType = lower.match(/fasting|empty|morning/) ? 'fasting' :
                       lower.match(/after|post|lunch|dinner/) ? 'postprandial' : 'random';

  const symptoms = [];
  ['tired', 'dizzy', 'thirsty', 'blur', 'sweat', 'weak'].forEach(s => {
    if (lower.includes(s)) symptoms.push(s);
  });

  return {
    hasReading: true,
    reading,
    readingType,
    symptoms,
    notes: message.substring(0, 200)
  };
}

async function checkCriticalLevels(reading, type, phone) {
  const thresh = MEDICAL_THRESHOLDS[type] || MEDICAL_THRESHOLDS.random;
  let critical = false;
  let alert = '';

  if (reading < thresh.critical_low) {
    critical = true;
    alert = `🚨 HYPOGLYCEMIA ALERT

Patient: ${phone}
Reading: ${reading} mg/dL
Type: ${type}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

⚠️ IMMEDIATE ACTION REQUIRED
Patient needs urgent attention for dangerously low blood sugar!`;
    
  } else if (reading > thresh.critical_high) {
    critical = true;
    alert = `🚨 HYPERGLYCEMIA ALERT

Patient: ${phone}
Reading: ${reading} mg/dL
Type: ${type}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

⚠️ HIGH PRIORITY
Patient requires immediate medical evaluation for severely elevated glucose!`;
  }

  if (critical && PHYSICIAN_PHONE && PHYSICIAN_PHONE !== '+919876543210') {
    try {
      await sendWhatsAppMessage(PHYSICIAN_PHONE, alert);
      console.log('✅ Critical alert sent to physician');
    } catch (err) {
      console.error('❌ Alert failed:', err.message);
    }
  }

  return critical;
}

async function analyzeTrends(phone) {
  const week = new Date();
  week.setDate(week.getDate() - 7);

  const readings = await GlucoseReading.find({
    patientPhone: phone,
    timestamp: { $gte: week }
  });

  if (readings.length < 3) return null;

  const avg = readings.reduce((s, r) => s + r.reading, 0) / readings.length;
  const high = readings.filter(r => r.reading > 180).length;
  const low = readings.filter(r => r.reading < 70).length;

  if (high > readings.length * 0.5) {
    return `📊 7-Day Trend Alert:
${high}/${readings.length} readings were high (>180 mg/dL)
Average: ${avg.toFixed(0)} mg/dL

💡 Recommendation: Review diet and medication with your doctor to improve control.`;
  }
  if (low > 2) {
    return `📊 7-Day Trend Alert:
${low} low glucose episodes (<70 mg/dL)
Average: ${avg.toFixed(0)} mg/dL

⚠️ Important: Discuss these lows with your doctor to prevent hypoglycemia.`;
  }
  return null;
}

// Webhooks
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const type = msg.type;
    let userMsg = '';

    if (type === 'text') {
      userMsg = msg.text.body;
    } else if (type === 'audio') {
      // DeepSeek doesn't support audio - ask user to send text
      return await sendWhatsAppMessage(from, "I can't process voice notes yet. Please send your message as text. 😊");
    } else {
      return await sendWhatsAppMessage(from, "Please send text messages. 😊");
    }

    let conv = await Conversation.findOne({ patientPhone: from });
    if (!conv) conv = new Conversation({ patientPhone: from, messages: [] });

    conv.messages.push({ role: 'user', content: userMsg });
    if (conv.messages.length > 10) conv.messages = conv.messages.slice(-10);

    const aiReply = await analyzeWithDeepSeek(from, userMsg, conv.messages);

    conv.messages.push({ role: 'assistant', content: aiReply });
    conv.lastActive = new Date();
    await conv.save();

    await sendWhatsAppMessage(from, aiReply);

    const data = extractGlucoseData(userMsg);
    if (data.hasReading) {
      const reading = new GlucoseReading({
        patientPhone: from,
        reading: data.reading,
        readingType: data.readingType,
        symptoms: data.symptoms,
        notes: data.notes
      });

      await reading.save();
      console.log(`✅ Saved: ${data.reading} mg/dL (${data.readingType})`);

      if (await checkCriticalLevels(data.reading, data.readingType, from)) {
        reading.alertSent = true;
        await reading.save();
      }

      const trend = await analyzeTrends(from);
      if (trend) setTimeout(() => sendWhatsAppMessage(from, trend), 3000);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err);
  }
});

// Health
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Gluco Sahayak',
    version: '3.0',
    ai: isDeepSeekAvailable ? 'DeepSeek R1 (active)' : 'Fallback mode (fully functional)',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
    timestamp: new Date().toISOString()
  });
});

// Reminders
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Morning reminders');
  const patients = await Patient.find({ 'reminderPreferences.medication': true });
  for (const p of patients) {
    try {
      await sendWhatsAppMessage(p.phone, '🌅 Good morning! Time to take your medication and check your fasting glucose. Have a healthy day! 😊');
    } catch (e) { console.error(`Failed: ${p.phone}`); }
  }
});

cron.schedule('0 20 * * *', async () => {
  console.log('⏰ Evening reminders');
  const patients = await Patient.find({ 'reminderPreferences.glucoseLogging': true });
  for (const p of patients) {
    const today = await GlucoseReading.findOne({
      patientPhone: p.phone,
      timestamp: { $gte: new Date().setHours(0, 0, 0, 0) }
    });
    if (!today) {
      try {
        await sendWhatsAppMessage(p.phone, "🌙 Evening reminder: Don't forget to log your glucose reading today! Just send: 'My sugar is [number]' 😊");
      } catch (e) { console.error(`Failed: ${p.phone}`); }
    }
  }
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║  GLUCO SAHAYAK v3.0              ║
║  Powered by DeepSeek R1          ║
╠═══════════════════════════════════╣
║  Status: ✅ Running               ║
║  Port: ${PORT}                    ║
║  AI: ${isDeepSeekAvailable ? '✅ DeepSeek R1' : '⚠️  Fallback'}        ║
║  DB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting'}           ║
╚═══════════════════════════════════╝
  `);
});
