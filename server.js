const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PHYSICIAN_PHONE = process.env.PHYSICIAN_PHONE;

// Initialize Gemini AI - automatically tries latest models first
let genAI;
let isGeminiAvailable = false;
let currentModel = null;

// Model priority list - tries newest first, falls back to older
const MODEL_PRIORITY = [
  'gemini-2.0-flash-exp',     // Latest experimental (Feb 2025)
  'gemini-2.0-flash',         // Stable 2.0
  'gemini-1.5-flash-latest',  // Latest 1.5
  'gemini-1.5-flash',         // Stable 1.5
  'gemini-pro'                // Legacy fallback
];

async function initializeGemini() {
  try {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
      console.warn('⚠️  Gemini API key not configured - using fallback mode');
      return false;
    }

    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // Try each model until one works
    for (const modelName of MODEL_PRIORITY) {
      try {
        console.log(`🔄 Testing ${modelName}...`);
        const model = genAI.getGenerativeModel({ model: modelName });
        const testResult = await model.generateContent("Hi");
        
        if (testResult?.response) {
          currentModel = modelName;
          isGeminiAvailable = true;
          console.log(`✅ Connected to ${modelName}`);
          return true;
        }
      } catch (error) {
        console.log(`⚠️  ${modelName} unavailable: ${error.message}`);
        continue;
      }
    }
    
    console.error('❌ All Gemini models failed - using fallback');
    return false;
    
  } catch (error) {
    console.error('❌ Gemini init error:', error.message);
    return false;
  }
}

initializeGemini();

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

async function transcribeAudio(audioBuffer) {
  if (!isGeminiAvailable) return null;
  
  try {
    const model = genAI.getGenerativeModel({ model: currentModel });
    const result = await model.generateContent([
      "Transcribe this audio about diabetes/blood sugar. Return only transcription.",
      { inlineData: { data: audioBuffer.toString('base64'), mimeType: 'audio/ogg' } }
    ]);
    return result.response.text();
  } catch (error) {
    console.error('❌ Transcription failed:', error.message);
    return null;
  }
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

async function analyzeWithGemini(phone, message, history = []) {
  if (isGeminiAvailable) {
    try {
      const model = genAI.getGenerativeModel({ 
        model: currentModel,
        generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
      });

      const patient = await Patient.findOne({ phone });
      const readings = await GlucoseReading.find({ patientPhone: phone })
        .sort({ timestamp: -1 }).limit(5);

      const prompt = `You are Gluco Sahayak, a caring diabetes assistant for Indian patients.

Context:
- Patient: ${patient?.name || 'New'}
- Recent readings: ${readings.map(r => `${r.reading}mg/dL`).join(', ') || 'None'}

User: "${message}"

Respond (max 120 words):
- Warm and supportive
- If glucose mentioned: acknowledge, advise per guidelines
- Indian context (roti, dal, walking)
- Normal fasting <100, critical <70 or >250
- Encourage healthy habits`;

      const result = await model.generateContent(prompt);
      const text = await result.response.text();
      
      if (text?.length > 10) {
        console.log(`✅ Gemini (${currentModel})`);
        return text;
      }
    } catch (err) {
      console.error('❌ Gemini error:', err.message);
    }
  }
  
  console.log('ℹ️ Using fallback');
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
    alert = `🚨 HYPOGLYCEMIA\nPatient: ${phone}\nReading: ${reading} mg/dL\nTime: ${new Date().toLocaleString('en-IN')}\n⚠️ URGENT ACTION NEEDED`;
  } else if (reading > thresh.critical_high) {
    critical = true;
    alert = `🚨 HYPERGLYCEMIA\nPatient: ${phone}\nReading: ${reading} mg/dL\nTime: ${new Date().toLocaleString('en-IN')}\n⚠️ MEDICAL ATTENTION NEEDED`;
  }

  if (critical && PHYSICIAN_PHONE && PHYSICIAN_PHONE !== '+919876543210') {
    try {
      await sendWhatsAppMessage(PHYSICIAN_PHONE, alert);
      console.log('✅ Doctor alerted');
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
    return `📊 Week: ${high}/${readings.length} high (>180). Avg: ${avg.toFixed(0)}\n💡 Review diet with doctor`;
  }
  if (low > 2) {
    return `📊 Week: ${low} lows (<70). Avg: ${avg.toFixed(0)}\n⚠️ Discuss with doctor`;
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
      const audio = await downloadWhatsAppMedia(msg.audio.id);
      if (audio) {
        const text = await transcribeAudio(audio);
        if (text) {
          userMsg = text;
          await sendWhatsAppMessage(from, `🎤 "${text}"`);
        } else {
          return await sendWhatsAppMessage(from, "Couldn't transcribe. Please text instead 😊");
        }
      }
    } else {
      return await sendWhatsAppMessage(from, "Send text or voice 😊");
    }

    let conv = await Conversation.findOne({ patientPhone: from });
    if (!conv) conv = new Conversation({ patientPhone: from, messages: [] });

    conv.messages.push({ role: 'user', content: userMsg });
    if (conv.messages.length > 10) conv.messages = conv.messages.slice(-10);

    const aiReply = await analyzeWithGemini(from, userMsg, conv.messages);

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
      console.log(`✅ ${data.reading} mg/dL (${data.readingType})`);

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
    version: '2.2',
    gemini: isGeminiAvailable ? currentModel : 'fallback (fully functional)',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'connecting'
  });
});

// Reminders
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Morning reminders');
  const patients = await Patient.find({ 'reminderPreferences.medication': true });
  for (const p of patients) {
    try {
      await sendWhatsAppMessage(p.phone, '🌅 Morning! Take meds & check glucose. Have a healthy day! 😊');
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
        await sendWhatsAppMessage(p.phone, "🌙 Log your glucose! Send: 'My sugar is [number]' 😊");
      } catch (e) { console.error(`Failed: ${p.phone}`); }
    }
  }
});

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════╗
║  GLUCO SAHAYAK v2.2              ║
╠═══════════════════════════════════╣
║  Status: ✅ Running               ║
║  Port: ${PORT}                    ║
║  Gemini: ${isGeminiAvailable ? `✅ ${currentModel}` : '⚠️  Fallback'}      ║
║  DB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '⏳ Connecting'}           ║
╚═══════════════════════════════════╝
  `);
});
