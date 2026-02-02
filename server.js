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
const PHYSICIAN_PHONE = process.env.PHYSICIAN_PHONE; // Doctor's WhatsApp number

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

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
    medication: { type: Boolean, default: true },
    preferredTimes: [String]
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

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Medical Guidelines Constants (Based on CMR, IDF, WHO)
const MEDICAL_THRESHOLDS = {
  fasting: {
    normal: { min: 70, max: 100 },
    prediabetes: { min: 100, max: 125 },
    diabetes: { min: 126, max: 300 },
    critical_low: 70,
    critical_high: 250
  },
  postprandial: {
    normal: { min: 70, max: 140 },
    prediabetes: { min: 140, max: 199 },
    diabetes: { min: 200, max: 300 },
    critical_low: 70,
    critical_high: 300
  },
  random: {
    critical_low: 70,
    critical_high: 250
  }
};

// System Prompt for Gemini AI
const SYSTEM_PROMPT = `You are "Gluco Sahayak" (Glucose Helper), an AI assistant for diabetes management in India. 

CORE RESPONSIBILITIES:
1. Help patients log glucose readings and symptoms
2. Provide evidence-based diet and lifestyle advice
3. Identify dangerous trends and alert when necessary
4. Support multiple Indian languages (Hindi, Tamil, Telugu, Bengali, etc.)
5. Be empathetic, clear, and culturally sensitive

MEDICAL KNOWLEDGE BASE:
- Follow CMR Guidelines for Management of Type 2 Diabetes (2018)
- Reference International Diabetes Federation (IDF) Atlas 2021 India Statistics
- Adhere to WHO Global Report on Diabetes guidelines

GUIDELINES:
- Fasting glucose: Normal <100 mg/dL, Prediabetes 100-125, Diabetes ≥126
- Postprandial (2hr): Normal <140 mg/dL, Prediabetes 140-199, Diabetes ≥200
- Critical levels: <70 (hypoglycemia) or >250 (hyperglycemia) require immediate attention
- HbA1c target: <7% for most adults with diabetes

RESPONSE STYLE:
- Be concise and practical
- Suggest Indian diet options (roti, rice, dal, sabzi, etc.)
- Recommend local exercises and lifestyle changes
- Always clarify you're providing general guidance, not replacing doctor consultation
- If critical values detected, strongly recommend immediate medical attention

IMPORTANT: 
- Never diagnose conditions
- Always recommend consulting healthcare provider for treatment changes
- Be supportive and non-judgmental
- Extract and structure glucose data from user messages`;

// Helper Functions
async function sendWhatsAppMessage(to, message) {
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      }
    });
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
  }
}

async function downloadWhatsAppMedia(mediaId) {
  try {
    // Get media URL
    const mediaUrlResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v18.0/${mediaId}`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`
      }
    });

    const mediaUrl = mediaUrlResponse.data.url;

    // Download media
    const mediaResponse = await axios({
      method: 'GET',
      url: mediaUrl,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`
      },
      responseType: 'arraybuffer'
    });

    return Buffer.from(mediaResponse.data);
  } catch (error) {
    console.error('Error downloading media:', error.message);
    return null;
  }
}

async function transcribeAudio(audioBuffer) {
  // Using Gemini's audio capabilities
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const audioPart = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: 'audio/ogg'
      }
    };

    const result = await model.generateContent([
      "Transcribe this audio message. The speaker may be talking about their blood sugar levels, symptoms, or asking questions about diabetes management. Provide only the transcription in the language spoken.",
      audioPart
    ]);

    return result.response.text();
  } catch (error) {
    console.error('Transcription error:', error.message);
    return null;
  }
}

async function analyzeWithGemini(patientPhone, userMessage, conversationHistory = []) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Get patient context
    const patient = await Patient.findOne({ phone: patientPhone });
    const recentReadings = await GlucoseReading.find({ patientPhone })
      .sort({ timestamp: -1 })
      .limit(10);

    const contextPrompt = `
PATIENT CONTEXT:
${patient ? `Name: ${patient.name}, Age: ${patient.age}, Type: ${patient.diabetesType}` : 'New patient - collect information'}

RECENT GLUCOSE READINGS:
${recentReadings.map(r => `${r.timestamp.toLocaleDateString()}: ${r.reading} mg/dL (${r.readingType})`).join('\n') || 'No previous readings'}

CONVERSATION HISTORY:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

CURRENT USER MESSAGE:
${userMessage}

TASK: Analyze the message and provide:
1. A helpful, empathetic response
2. Extract any glucose reading data (value, type, time)
3. Identify any concerning symptoms or patterns
4. Provide relevant advice based on medical guidelines

Format your response as natural conversation. If you extract glucose data, mention it naturally in your response.`;

    const result = await model.generateContent([SYSTEM_PROMPT, contextPrompt]);
    return result.response.text();
  } catch (error) {
    console.error('Gemini AI error:', error.message);
    return "I'm having trouble processing your message right now. Please try again in a moment.";
  }
}

async function extractGlucoseData(message, aiResponse) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const extractionPrompt = `From this conversation, extract ONLY glucose reading data in JSON format:

User message: "${message}"
AI response: "${aiResponse}"

Return ONLY a JSON object (no markdown, no explanation) with this structure:
{
  "hasReading": true/false,
  "reading": number or null,
  "readingType": "fasting" or "postprandial" or "random" or null,
  "symptoms": ["symptom1", "symptom2"] or [],
  "notes": "any additional context" or null
}

If no glucose reading is mentioned, return {"hasReading": false}`;

    const result = await model.generateContent(extractionPrompt);
    const jsonText = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(jsonText);
  } catch (error) {
    console.error('Extraction error:', error.message);
    return { hasReading: false };
  }
}

async function checkCriticalLevels(reading, readingType, patientPhone) {
  const thresholds = MEDICAL_THRESHOLDS[readingType] || MEDICAL_THRESHOLDS.random;
  
  let isCritical = false;
  let alertMessage = '';

  if (reading < thresholds.critical_low) {
    isCritical = true;
    alertMessage = `🚨 CRITICAL ALERT: Hypoglycemia detected for patient ${patientPhone}\nReading: ${reading} mg/dL\nImmediate action required!`;
  } else if (reading > thresholds.critical_high) {
    isCritical = true;
    alertMessage = `🚨 CRITICAL ALERT: Severe hyperglycemia for patient ${patientPhone}\nReading: ${reading} mg/dL\nImmediate medical attention needed!`;
  }

  if (isCritical && PHYSICIAN_PHONE) {
    // Alert physician
    await sendWhatsAppMessage(PHYSICIAN_PHONE, alertMessage);
    
    // Alert patient
    await sendWhatsAppMessage(patientPhone, 
      "⚠️ Your glucose level is in a critical range. Your doctor has been notified. Please seek immediate medical attention if you're feeling unwell."
    );
  }

  return isCritical;
}

async function analyzeTrends(patientPhone) {
  const last7Days = new Date();
  last7Days.setDate(last7Days.getDate() - 7);

  const readings = await GlucoseReading.find({
    patientPhone,
    timestamp: { $gte: last7Days }
  }).sort({ timestamp: -1 });

  if (readings.length < 3) return null;

  const avgReading = readings.reduce((sum, r) => sum + r.reading, 0) / readings.length;
  const highReadings = readings.filter(r => r.reading > 180).length;
  const lowReadings = readings.filter(r => r.reading < 70).length;

  let trendMessage = '';
  
  if (highReadings > readings.length * 0.5) {
    trendMessage = `📊 Weekly Trend Alert: More than half of your readings this week were high (>180 mg/dL). Consider reviewing your diet and medication with your doctor.`;
  } else if (lowReadings > 2) {
    trendMessage = `📊 Weekly Trend Alert: You've had ${lowReadings} low glucose readings this week. Please discuss this pattern with your doctor.`;
  } else if (avgReading > 160) {
    trendMessage = `📊 Weekly Trend: Your average glucose is ${avgReading.toFixed(1)} mg/dL. Let's work on bringing this closer to target range (<140 mg/dL).`;
  }

  return trendMessage;
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook message handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0];
      const value = changes?.value;

      if (value?.messages?.[0]) {
        const message = value.messages[0];
        const from = message.from;
        const messageType = message.type;

        let userMessage = '';

        // Handle different message types
        if (messageType === 'text') {
          userMessage = message.text.body;
        } else if (messageType === 'audio') {
          const audioBuffer = await downloadWhatsAppMedia(message.audio.id);
          if (audioBuffer) {
            const transcription = await transcribeAudio(audioBuffer);
            if (transcription) {
              userMessage = transcription;
              await sendWhatsAppMessage(from, `🎤 I heard: "${transcription}"\n\nLet me help you with that...`);
            } else {
              await sendWhatsAppMessage(from, "Sorry, I couldn't transcribe your voice message. Could you please type your message?");
              return res.sendStatus(200);
            }
          }
        } else {
          await sendWhatsAppMessage(from, "I currently support text and voice messages. Please send your message as text or voice note.");
          return res.sendStatus(200);
        }

        // Get or create conversation
        let conversation = await Conversation.findOne({ patientPhone: from });
        if (!conversation) {
          conversation = new Conversation({
            patientPhone: from,
            messages: []
          });
        }

        // Add user message to history
        conversation.messages.push({
          role: 'user',
          content: userMessage,
          timestamp: new Date()
        });

        // Keep last 20 messages for context
        if (conversation.messages.length > 20) {
          conversation.messages = conversation.messages.slice(-20);
        }

        // Get AI response
        const aiResponse = await analyzeWithGemini(from, userMessage, conversation.messages);

        // Add AI response to history
        conversation.messages.push({
          role: 'assistant',
          content: aiResponse,
          timestamp: new Date()
        });

        conversation.lastActive = new Date();
        await conversation.save();

        // Send response to user
        await sendWhatsAppMessage(from, aiResponse);

        // Extract and save glucose data
        const glucoseData = await extractGlucoseData(userMessage, aiResponse);
        
        if (glucoseData.hasReading && glucoseData.reading) {
          const reading = new GlucoseReading({
            patientPhone: from,
            reading: glucoseData.reading,
            readingType: glucoseData.readingType || 'random',
            symptoms: glucoseData.symptoms || [],
            notes: glucoseData.notes
          });

          await reading.save();

          // Check for critical levels
          const isCritical = await checkCriticalLevels(
            glucoseData.reading,
            glucoseData.readingType || 'random',
            from
          );

          if (isCritical) {
            reading.alertSent = true;
            await reading.save();
          }

          // Send trend analysis weekly
          const trendMessage = await analyzeTrends(from);
          if (trendMessage) {
            setTimeout(() => sendWhatsAppMessage(from, trendMessage), 2000);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Scheduled reminders
cron.schedule('0 8 * * *', async () => {
  // Morning medication reminder
  const patients = await Patient.find({ 'reminderPreferences.medication': true });
  
  for (const patient of patients) {
    const morningMeds = patient.medicationSchedule.filter(med => 
      med.time.includes('morning') || med.time.includes('8')
    );
    
    if (morningMeds.length > 0) {
      const message = `🌅 Good morning! Time for your medication:\n${morningMeds.map(m => `• ${m.medicationName}`).join('\n')}\n\nDon't forget to log your fasting glucose level!`;
      await sendWhatsAppMessage(patient.phone, message);
    }
  }
});

cron.schedule('0 20 * * *', async () => {
  // Evening glucose logging reminder
  const patients = await Patient.find({ 'reminderPreferences.glucoseLogging': true });
  
  for (const patient of patients) {
    const todayReadings = await GlucoseReading.find({
      patientPhone: patient.phone,
      timestamp: { $gte: new Date().setHours(0, 0, 0, 0) }
    });

    if (todayReadings.length === 0) {
      await sendWhatsAppMessage(patient.phone, 
        "🌙 Evening reminder: Don't forget to log your glucose reading today! Send me your levels anytime."
      );
    }
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Gluco Sahayak Bot is running! 🩺');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
