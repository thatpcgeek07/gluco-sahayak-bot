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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHYSICIAN_PHONE = process.env.PHYSICIAN_PHONE;

// Claude - Use claude-3-5-sonnet-latest or claude-3-sonnet-20240229
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-3-5-sonnet-latest'; // This will always use latest
let isClaudeAvailable = false;

async function initializeClaude() {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
    console.warn('⚠️  Claude API key not set');
    return false;
  }

  try {
    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Hi' }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 10000
    });

    if (response.data?.content?.[0]?.text) {
      isClaudeAvailable = true;
      console.log(`✅ Claude connected (${CLAUDE_MODEL})`);
      return true;
    }
  } catch (error) {
    console.error('❌ Claude failed:', error.response?.data?.error?.message || error.message);
    console.log('ℹ️  Using fallback');
  }
  return false;
}

initializeClaude();

// MongoDB
const patientSchema = new mongoose.Schema({
  phone: String,
  name: String,
  age: Number,
  diabetesType: String,
  registeredAt: { type: Date, default: Date.now },
  medicationSchedule: [{ medicationName: String, time: String }],
  reminderPreferences: { glucoseLogging: Boolean, medication: Boolean }
});

const glucoseReadingSchema = new mongoose.Schema({
  patientPhone: String,
  reading: Number,
  readingType: { type: String, enum: ['fasting', 'postprandial', 'random'] },
  timestamp: { type: Date, default: Date.now },
  symptoms: [String],
  notes: String,
  alertSent: Boolean
});

const conversationSchema = new mongoose.Schema({
  patientPhone: String,
  messages: [{ role: String, content: String, timestamp: Date }],
  lastActive: Date
});

const Patient = mongoose.model('Patient', patientSchema);
const GlucoseReading = mongoose.model('GlucoseReading', glucoseReadingSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

mongoose.connect(MONGODB_URI).then(() => console.log('✅ MongoDB'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// Medical Thresholds
const THRESHOLDS = {
  fasting: { critical_low: 70, critical_high: 250 },
  postprandial: { critical_low: 70, critical_high: 300 },
  random: { critical_low: 70, critical_high: 250 }
};

// WhatsApp
async function sendWhatsAppMessage(to, message) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
    console.log(`✅ Sent to ${to}`);
  } catch (e) {
    console.error('❌ Send failed');
  }
}

// Fallback
function fallbackResponse(msg) {
  const lower = msg.toLowerCase();
  const num = msg.match(/(\d{2,3})/);
  const glucose = num ? parseInt(num[1]) : null;
  
  if (lower.match(/^(hi|hello|namaste)/)) {
    return `Hello! 🙏 I'm Gluco Sahayak.\n\n📊 Log glucose\n🍽️ Diet tips\n🚶 Exercise\n💊 Reminders\n\nSend: "My sugar is 120" 😊`;
  }
  
  if (glucose && glucose >= 40 && glucose <= 500) {
    let r = `✅ Logged: ${glucose} mg/dL\n\n`;
    if (glucose < 70) r += `🚨 LOW! Eat 15g carbs now. Rest 15min. Recheck.`;
    else if (glucose <= 100) r += `✅ EXCELLENT! Normal range. Keep it up! 👏`;
    else if (glucose <= 125) r += `⚠️ PREDIABETES. More vegetables, walk 30min daily, see doctor.`;
    else if (glucose <= 180) r += `⚠️ ELEVATED. Review diet, exercise, medication.`;
    else if (glucose <= 250) r += `🚨 HIGH! Drink water, avoid sweets, walk 15min, recheck in 2hr.`;
    else r += `🚨🚨 CRITICAL! Contact doctor NOW. Drink water. Don't exercise. Go to ER if sick!`;
    return r;
  }
  
  if (lower.match(/eat|food|diet/)) {
    return `🍽️ Diet:\n• Breakfast: Oats + egg\n• Lunch: Roti + dal + vegetables\n• Dinner: Light\n• Snacks: Nuts, fruits\n\nAVOID: Rice, sweets, fried foods 💪`;
  }
  
  if (lower.match(/exercise|walk|yoga/)) {
    return `🚶 Exercise:\n• Walk 30-45min daily\n• After meals: 15-20min\n• Yoga: Surya namaskar\n\n⚠️ Check glucose first\n⚠️ Don't exercise if >250`;
  }
  
  return `Got it! How can I help?\n📊 "My sugar is 120"\n🍽️ "What to eat?"\n🚶 "Exercise tips?"`;
}

// Claude AI
async function analyzeWithClaude(phone, msg) {
  if (!isClaudeAvailable) return fallbackResponse(msg);

  try {
    const patient = await Patient.findOne({ phone });
    const readings = await GlucoseReading.find({ patientPhone: phone }).sort({ timestamp: -1 }).limit(5);

    const system = `You are Gluco Sahayak, diabetes assistant for Indian patients.

Patient: ${patient?.name || 'New'}
Recent: ${readings.map(r => `${r.reading}mg/dL`).join(', ') || 'None'}

Guidelines: Fasting <100 normal, <70 or >250 critical
Be warm, concise (150 words), Indian context (roti, dal, walking, yoga)
Acknowledge glucose if mentioned, give actionable advice

User: "${msg}"`;

    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: msg }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 15000
    });

    const text = response.data?.content?.[0]?.text;
    if (text) {
      console.log('✅ Claude response');
      return text;
    }
  } catch (e) {
    console.error('❌ Claude error');
  }
  
  return fallbackResponse(msg);
}

function extractGlucose(msg) {
  const match = msg.match(/(\d{2,3})/);
  const reading = match ? parseInt(match[1]) : null;
  if (!reading || reading < 40 || reading > 500) return { hasReading: false };

  const lower = msg.toLowerCase();
  const type = lower.match(/fasting|empty|morning/) ? 'fasting' :
               lower.match(/after|post|lunch|dinner/) ? 'postprandial' : 'random';

  return { hasReading: true, reading, readingType: type, notes: msg.substring(0, 200) };
}

async function checkCritical(reading, type, phone) {
  const t = THRESHOLDS[type] || THRESHOLDS.random;
  let critical = false;
  let alert = '';

  if (reading < t.critical_low) {
    critical = true;
    alert = `🚨 HYPOGLYCEMIA\nPatient: ${phone}\nReading: ${reading}\nTime: ${new Date().toLocaleString('en-IN')}\n⚠️ URGENT`;
  } else if (reading > t.critical_high) {
    critical = true;
    alert = `🚨 HYPERGLYCEMIA\nPatient: ${phone}\nReading: ${reading}\nTime: ${new Date().toLocaleString('en-IN')}\n⚠️ HIGH PRIORITY`;
  }

  if (critical && PHYSICIAN_PHONE && PHYSICIAN_PHONE !== '+919876543210') {
    await sendWhatsAppMessage(PHYSICIAN_PHONE, alert);
    console.log('✅ Doctor alerted');
  }

  return critical;
}

// Webhooks
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook OK');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from = msg.from;
    const text = msg.text.body;

    const reply = await analyzeWithClaude(from, text);
    await sendWhatsAppMessage(from, reply);

    const data = extractGlucose(text);
    if (data.hasReading) {
      const reading = new GlucoseReading({
        patientPhone: from,
        reading: data.reading,
        readingType: data.readingType,
        notes: data.notes
      });
      await reading.save();
      console.log(`✅ ${data.reading} (${data.readingType})`);

      if (await checkCritical(data.reading, data.readingType, from)) {
        reading.alertSent = true;
        await reading.save();
      }
    }
  } catch (e) {
    console.error('❌ Webhook:', e.message);
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    ai: isClaudeAvailable ? CLAUDE_MODEL : 'fallback',
    db: mongoose.connection.readyState === 1 ? 'ok' : 'connecting'
  });
});

// Reminders
cron.schedule('0 8 * * *', async () => {
  const patients = await Patient.find({ 'reminderPreferences.medication': true });
  for (const p of patients) {
    await sendWhatsAppMessage(p.phone, '🌅 Morning! Take meds & check glucose 😊');
  }
});

cron.schedule('0 20 * * *', async () => {
  const patients = await Patient.find({ 'reminderPreferences.glucoseLogging': true });
  for (const p of patients) {
    const today = await GlucoseReading.findOne({
      patientPhone: p.phone,
      timestamp: { $gte: new Date().setHours(0,0,0,0) }
    });
    if (!today) await sendWhatsAppMessage(p.phone, "🌙 Log glucose: 'My sugar is [number]' 😊");
  }
});

app.listen(PORT, () => console.log(`
╔═══════════════════════════╗
║  GLUCO SAHAYAK v3.0      ║
║  Claude: ${isClaudeAvailable ? '✅' : '⚠️ '}            ║
║  DB: ${mongoose.connection.readyState === 1 ? '✅' : '⏳'}                ║
╚═══════════════════════════╝
`));
