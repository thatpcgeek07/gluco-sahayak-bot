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

// Initialize Gemini AI with error handling
let genAI;
let isGeminiAvailable = false;

try {
  if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here') {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    isGeminiAvailable = true;
    console.log('✅ Gemini AI initialized successfully');
  } else {
    console.warn('⚠️ Gemini API key not configured - using fallback mode');
  }
} catch (error) {
  console.error('❌ Failed to initialize Gemini AI:', error.message);
  isGeminiAvailable = false;
}

// MongoDB Schemas (same as before)
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
}).then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Medical Guidelines Constants
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

// Enhanced System Prompt
const SYSTEM_PROMPT = `You are "Gluco Sahayak", an AI diabetes management assistant for patients in India.

CORE RESPONSIBILITIES:
1. Log glucose readings and symptoms
2. Provide evidence-based diet/lifestyle advice
3. Support Hindi, Tamil, Telugu, Bengali, and other Indian languages
4. Be empathetic and culturally sensitive

MEDICAL KNOWLEDGE:
- Fasting: Normal <100, Prediabetes 100-125, Diabetes ≥126 mg/dL
- Postprandial: Normal <140, Prediabetes 140-199, Diabetes ≥200 mg/dL
- Critical: <70 (hypo) or >250 (hyper) requires immediate attention

RESPONSE STYLE:
- Concise and practical
- Suggest Indian foods (roti, dal, sabzi, fruits)
- Recommend local exercises
- Always clarify you're providing guidance, not replacing doctor visits
- Extract glucose data when mentioned

IMPORTANT:
- Never diagnose
- Recommend doctor consultation for treatment changes
- Be supportive and non-judgmental`;

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
    console.log(`✅ Message sent to ${to}`);
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

async function downloadWhatsAppMedia(mediaId) {
  try {
    const mediaUrlResponse = await axios({
      method: 'GET',
      url: `https://graph.facebook.com/v18.0/${mediaId}`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`
      }
    });

    const mediaUrl = mediaUrlResponse.data.url;

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
    console.error('❌ Error downloading media:', error.message);
    return null;
  }
}

async function transcribeAudio(audioBuffer) {
  if (!isGeminiAvailable) {
    console.warn('⚠️ Gemini not available for transcription');
    return null;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    const audioPart = {
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: 'audio/ogg'
      }
    };

    const result = await model.generateContent([
      "Transcribe this audio message about blood sugar levels or diabetes. Provide only the transcription.",
      audioPart
    ]);

    return result.response.text();
  } catch (error) {
    console.error('❌ Transcription error:', error.message);
    return null;
  }
}

// Fallback response generator (when Gemini is unavailable)
function generateFallbackResponse(message) {
  const lowerMsg = message.toLowerCase();
  
  // Extract glucose reading
  const glucoseMatch = message.match(/(\d{2,3})/);
  const glucoseValue = glucoseMatch ? parseInt(glucoseMatch[1]) : null;
  
  // Check for greetings
  if (lowerMsg.includes('hi') || lowerMsg.includes('hello') || lowerMsg.includes('namaste') || lowerMsg.includes('नमस्ते')) {
    return `Hello! 🙏 I'm Gluco Sahayak, your diabetes management assistant.

I can help you:
✅ Log glucose readings
✅ Track your trends
✅ Get diet & exercise tips
✅ Receive medication reminders

Just send me your glucose reading like "My sugar is 120" or ask any diabetes-related question!`;
  }
  
  // Handle glucose readings
  if (glucoseValue && glucoseValue >= 40 && glucoseValue <= 500) {
    let response = `📊 I've logged your glucose reading: ${glucoseValue} mg/dL\n\n`;
    
    if (glucoseValue < 70) {
      response += `⚠️ This is LOW (hypoglycemia)!

IMMEDIATE ACTION:
• Eat 15g fast-acting carbs (3-4 glucose tablets, 1/2 cup juice, or 1 tbsp honey)
• Rest 15 minutes
• Recheck glucose
• If still low, repeat

🚨 If symptoms persist, seek medical help immediately!`;
    } else if (glucoseValue >= 70 && glucoseValue <= 140) {
      response += `✅ This is in the NORMAL range!

Keep up the good work:
• Continue balanced diet (roti, dal, sabzi)
• Stay active (30 min walk daily)
• Take medications as prescribed
• Log regularly`;
    } else if (glucoseValue > 140 && glucoseValue <= 200) {
      response += `⚠️ This is ELEVATED

Tips to improve:
• Choose whole grain roti over rice
• Add more vegetables (karela, methi, palak)
• Avoid sugary foods & drinks
• Walk 30 minutes after meals
• Check with your doctor if consistently high`;
    } else if (glucoseValue > 200) {
      response += `🚨 This is HIGH!

IMPORTANT STEPS:
• Drink plenty of water
• Avoid sugary foods completely
• Check if you took your medication
• Monitor symptoms (thirst, frequent urination)
• Contact your doctor if remains high

${glucoseValue > 250 ? '⚠️ CRITICAL LEVEL - Seek medical attention if you feel unwell!' : ''}`;
    }
    
    return response;
  }
  
  // Diet questions
  if (lowerMsg.includes('eat') || lowerMsg.includes('food') || lowerMsg.includes('diet') || lowerMsg.includes('breakfast') || lowerMsg.includes('lunch') || lowerMsg.includes('dinner')) {
    return `🍽️ Diabetes-Friendly Diet Tips:

BREAKFAST:
• Oats upma + boiled egg
• Moong dal cheela + curd
• Ragi porridge + nuts

LUNCH:
• 2 wheat rotis
• Dal (moong/masoor)
• Sabzi (palak, beans, karela)
• Salad
• Small bowl curd

DINNER:
• Similar to lunch but lighter
• Avoid rice at night
• Early dinner (before 8 PM)

SNACKS:
• Roasted chana
• Fruits (apple, guava, papaya)
• Nuts (almonds, walnuts)
• Buttermilk

AVOID:
• White rice, maida
• Sweets, biscuits
• Sugary drinks
• Fried foods`;
  }
  
  // Exercise questions
  if (lowerMsg.includes('exercise') || lowerMsg.includes('walk') || lowerMsg.includes('yoga')) {
    return `🚶 Exercise Guidelines for Diabetes:

DAILY ACTIVITIES:
• Walk 30-45 minutes (morning/evening)
• Break it into 2-3 short walks if needed
• Walk after meals helps control sugar

YOGA:
• Surya Namaskar (5-10 rounds)
• Pranayama (deep breathing)
• Bhujangasana, Dhanurasana
• Shavasana for relaxation

PRECAUTIONS:
• Check glucose before exercise
• Avoid if glucose >250 mg/dL
• Stay hydrated
• Wear comfortable shoes
• Stop if dizzy or unwell

Best time: 1-2 hours after meals`;
  }
  
  // Medication questions
  if (lowerMsg.includes('medicine') || lowerMsg.includes('medication') || lowerMsg.includes('tablet') || lowerMsg.includes('insulin')) {
    return `💊 Medication Reminders:

IMPORTANT:
• Take medicines as prescribed by your doctor
• Don't skip or change doses yourself
• Take at the same time daily
• With or without food as directed

COMMON TIMES:
• Morning (before/after breakfast)
• Evening (before dinner)
• Bedtime

I can remind you! Just tell me your medication schedule.

⚠️ Never stop medications without consulting your doctor.`;
  }
  
  // Symptoms
  if (lowerMsg.includes('tired') || lowerMsg.includes('dizzy') || lowerMsg.includes('thirsty') || lowerMsg.includes('symptom')) {
    return `⚠️ Common Diabetes Symptoms:

HIGH SUGAR (Hyperglycemia):
• Excessive thirst
• Frequent urination
• Blurred vision
• Fatigue
• Headache

LOW SUGAR (Hypoglycemia):
• Dizziness, shakiness
• Sweating
• Confusion
• Hunger
• Weakness

🚨 If you're experiencing severe symptoms, please contact your doctor or seek immediate medical attention.

Meanwhile, please send me your current glucose reading.`;
  }
  
  // Default response
  return `I received your message: "${message}"

I'm here to help with:
📊 Logging glucose readings
🍽️ Diet recommendations
🚶 Exercise tips
💊 Medication reminders
❓ Diabetes questions

You can:
• Send your glucose reading: "My sugar is 120"
• Ask about food: "What should I eat?"
• Ask about exercise: "What exercise is good?"
• Report symptoms: "I'm feeling tired"

How can I assist you today?`;
}

async function analyzeWithGemini(patientPhone, userMessage, conversationHistory = []) {
  // Try Gemini first
  if (isGeminiAvailable) {
    try {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500,
        }
      });

      const patient = await Patient.findOne({ phone: patientPhone });
      const recentReadings = await GlucoseReading.find({ patientPhone })
        .sort({ timestamp: -1 })
        .limit(5);

      const contextPrompt = `
PATIENT CONTEXT:
${patient ? `Name: ${patient.name || 'Not set'}, Age: ${patient.age || 'Not set'}` : 'New patient'}

RECENT READINGS:
${recentReadings.length > 0 ? recentReadings.map(r => `${r.reading} mg/dL (${r.readingType})`).join(', ') : 'None'}

USER MESSAGE: ${userMessage}

Provide a helpful, concise response (max 200 words). If glucose data is mentioned, acknowledge it and give relevant advice.`;

      const result = await model.generateContent([SYSTEM_PROMPT, contextPrompt]);
      const response = result.response.text();
      
      console.log('✅ Gemini response generated');
      return response;
      
    } catch (error) {
      console.error('❌ Gemini error, using fallback:', error.message);
      // Fall through to fallback
    }
  }
  
  // Use fallback
  console.log('ℹ️ Using fallback response generator');
  return generateFallbackResponse(userMessage);
}

async function extractGlucoseData(message, aiResponse) {
  // Simple regex-based extraction
  const glucoseMatch = message.match(/(\d{2,3})/);
  const glucoseValue = glucoseMatch ? parseInt(glucoseMatch[1]) : null;
  
  if (!glucoseValue || glucoseValue < 40 || glucoseValue > 500) {
    return { hasReading: false };
  }

  // Determine reading type
  let readingType = 'random';
  const lowerMsg = message.toLowerCase();
  
  if (lowerMsg.includes('fasting') || lowerMsg.includes('empty stomach') || lowerMsg.includes('morning')) {
    readingType = 'fasting';
  } else if (lowerMsg.includes('after') || lowerMsg.includes('post') || lowerMsg.includes('lunch') || lowerMsg.includes('dinner')) {
    readingType = 'postprandial';
  }

  // Extract symptoms
  const symptoms = [];
  const symptomKeywords = ['tired', 'dizzy', 'thirsty', 'headache', 'blurred', 'sweating', 'weak'];
  symptomKeywords.forEach(symptom => {
    if (lowerMsg.includes(symptom)) symptoms.push(symptom);
  });

  return {
    hasReading: true,
    reading: glucoseValue,
    readingType: readingType,
    symptoms: symptoms,
    notes: message.substring(0, 200)
  };
}

async function checkCriticalLevels(reading, readingType, patientPhone) {
  const thresholds = MEDICAL_THRESHOLDS[readingType] || MEDICAL_THRESHOLDS.random;
  
  let isCritical = false;
  let alertMessage = '';

  if (reading < thresholds.critical_low) {
    isCritical = true;
    alertMessage = `🚨 CRITICAL HYPOGLYCEMIA ALERT
Patient: ${patientPhone}
Reading: ${reading} mg/dL
Time: ${new Date().toLocaleString('en-IN')}
Status: IMMEDIATE ACTION REQUIRED`;
  } else if (reading > thresholds.critical_high) {
    isCritical = true;
    alertMessage = `🚨 CRITICAL HYPERGLYCEMIA ALERT
Patient: ${patientPhone}
Reading: ${reading} mg/dL
Time: ${new Date().toLocaleString('en-IN')}
Status: MEDICAL ATTENTION NEEDED`;
  }

  if (isCritical && PHYSICIAN_PHONE && PHYSICIAN_PHONE !== '+919876543210') {
    try {
      await sendWhatsAppMessage(PHYSICIAN_PHONE, alertMessage);
      console.log('✅ Physician alert sent');
    } catch (error) {
      console.error('❌ Failed to send physician alert:', error.message);
    }
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

  if (highReadings > readings.length * 0.5) {
    return `📊 Weekly Trend: ${highReadings}/${readings.length} readings were high (>180). Average: ${avgReading.toFixed(0)}. Consider reviewing diet and medication with your doctor.`;
  } else if (lowReadings > 2) {
    return `📊 Weekly Trend: ${lowReadings} low readings this week. Please discuss this pattern with your doctor to prevent hypoglycemia.`;
  }

  return null;
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Webhook message handler
app.post('/webhook', async (req, res) => {
  // Respond immediately to avoid timeout
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('📨 Webhook received:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      const changes = body.entry?.[0]?.changes?.[0];
      const value = changes?.value;

      if (value?.messages?.[0]) {
        const message = value.messages[0];
        const from = message.from;
        const messageType = message.type;

        console.log(`📱 Message from ${from}, type: ${messageType}`);

        let userMessage = '';

        // Handle different message types
        if (messageType === 'text') {
          userMessage = message.text.body;
          console.log(`💬 Text message: ${userMessage}`);
        } else if (messageType === 'audio') {
          try {
            const audioBuffer = await downloadWhatsAppMedia(message.audio.id);
            if (audioBuffer) {
              const transcription = await transcribeAudio(audioBuffer);
              if (transcription) {
                userMessage = transcription;
                await sendWhatsAppMessage(from, `🎤 I heard: "${transcription}"`);
              } else {
                await sendWhatsAppMessage(from, "Sorry, I couldn't transcribe your voice note. Please send a text message instead.");
                return;
              }
            }
          } catch (error) {
            console.error('❌ Audio processing error:', error);
            await sendWhatsAppMessage(from, "Sorry, I had trouble processing your voice note. Please try sending a text message.");
            return;
          }
        } else {
          await sendWhatsAppMessage(from, "I support text and voice messages. Please send your message as text or voice note. 😊");
          return;
        }

        // Get or create conversation
        let conversation = await Conversation.findOne({ patientPhone: from });
        if (!conversation) {
          conversation = new Conversation({ patientPhone: from, messages: [] });
        }

        // Add user message
        conversation.messages.push({
          role: 'user',
          content: userMessage,
          timestamp: new Date()
        });

        // Keep last 10 messages
        if (conversation.messages.length > 10) {
          conversation.messages = conversation.messages.slice(-10);
        }

        // Get AI response with retry logic
        let aiResponse;
        let retries = 0;
        const maxRetries = 2;
        
        while (retries <= maxRetries) {
          try {
            aiResponse = await analyzeWithGemini(from, userMessage, conversation.messages);
            break;
          } catch (error) {
            retries++;
            console.error(`❌ Attempt ${retries} failed:`, error.message);
            if (retries > maxRetries) {
              aiResponse = generateFallbackResponse(userMessage);
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
            }
          }
        }

        // Add AI response to history
        conversation.messages.push({
          role: 'assistant',
          content: aiResponse,
          timestamp: new Date()
        });

        conversation.lastActive = new Date();
        await conversation.save();

        // Send response
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
          console.log(`✅ Glucose reading saved: ${glucoseData.reading} mg/dL`);

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

          // Send trend analysis
          const trendMessage = await analyzeTrends(from);
          if (trendMessage) {
            setTimeout(() => sendWhatsAppMessage(from, trendMessage), 3000);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Gluco Sahayak Bot',
    gemini: isGeminiAvailable ? 'available' : 'fallback mode',
    timestamp: new Date().toISOString()
  });
});

// Scheduled reminders
cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running morning reminders...');
  const patients = await Patient.find({ 'reminderPreferences.medication': true });
  
  for (const patient of patients) {
    try {
      const message = `🌅 Good morning!

Time to:
✅ Take your morning medication
📊 Check your fasting glucose
💧 Drink water

Have a healthy day! 😊`;
      
      await sendWhatsAppMessage(patient.phone, message);
    } catch (error) {
      console.error(`❌ Failed to send reminder to ${patient.phone}`);
    }
  }
});

cron.schedule('0 20 * * *', async () => {
  console.log('⏰ Running evening reminders...');
  const patients = await Patient.find({ 'reminderPreferences.glucoseLogging': true });
  
  for (const patient of patients) {
    const todayReadings = await GlucoseReading.find({
      patientPhone: patient.phone,
      timestamp: { $gte: new Date().setHours(0, 0, 0, 0) }
    });

    if (todayReadings.length === 0) {
      try {
        await sendWhatsAppMessage(patient.phone, 
          "🌙 Evening reminder: Don't forget to log your glucose reading today! Just send me your levels. 😊"
        );
      } catch (error) {
        console.error(`❌ Failed to send reminder to ${patient.phone}`);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Gemini AI: ${isGeminiAvailable ? 'Enabled' : 'Fallback mode'}`);
  console.log(`✅ MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Connecting...'}`);
});
