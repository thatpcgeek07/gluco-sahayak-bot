const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const pdfParse = require('pdf-parse');
const gtts = require('gtts');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Enable CORS for local testing with HTML files
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ========================================
// CONFIGURATION
// ========================================

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PHYSICIAN_PHONE = process.env.PHYSICIAN_PHONE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate critical environment variables
if (!WHATSAPP_TOKEN) console.error('❌ WHATSAPP_TOKEN not set');
if (!WHATSAPP_PHONE_ID) console.error('❌ WHATSAPP_PHONE_ID not set');
if (!VERIFY_TOKEN) console.error('❌ VERIFY_TOKEN not set');
if (!MONGODB_URI) console.error('❌ MONGODB_URI not set');
if (!ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set - using fallback');
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY not set - voice disabled');

const MEDICAL_PDF_FILES = [
  { fileId: '1bG1owFgs9AfJRc3c8XGJDTGzshyVqfYM', filename: 'medical_textbook_1.pdf', source: 'Medical_Reference_1' },
  { fileId: '1H3SmbA4ZMQ3hKcuoG-AoRkdU8Kyh9t1j', filename: 'medical_textbook_2.pdf', source: 'Medical_Reference_2' },
  { fileId: '1vYC0ncfuz1nsVldijZG3uG_ZzWc_MH9N', filename: 'medical_textbook_3.pdf', source: 'Medical_Reference_3' },
  { fileId: '127OJ05vyE3b7KcFvjTJZWmekHmCAwukA', filename: 'medical_textbook_4.pdf', source: 'Medical_Reference_4' }
];

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
// ✅ UPDATED: claude-sonnet-4-20250514 was retired. Using current model string.
const CLAUDE_MODEL = 'claude-sonnet-5';
let isClaudeAvailable = false;
let ragSystemInitialized = false;
let voiceEnabled = !!OPENAI_API_KEY;

// ========================================
// MONGODB SCHEMAS
// ========================================

const patientSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  language_pref: { type: String, enum: ['en', 'hi', 'kn'], default: 'en' },
  full_name: String,
  age: Number,
  gender: { type: String, enum: ['Male', 'Female', 'Other'] },
  emergency_contact: String,
  pincode: String,
  consent_given: { type: Boolean, default: false },
  diabetes_type: { type: String, enum: ['Type 1', 'Type 2', 'Gestational'] },
  duration_years: Number,
  medication_type: { type: String, enum: ['Insulin', 'Tablets', 'Both', 'None'] },
  current_meds: [String],
  comorbidities: [String],
  last_hba1c: Number,
  diet_preference: { type: String, enum: ['Veg', 'Non-Veg', 'Eggetarian'] },
  onboarding_completed: { type: Boolean, default: false },
  onboarding_step: { type: String, default: 'language' },
  registeredAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
  totalConversations: { type: Number, default: 0 },
  voiceMessagesCount: { type: Number, default: 0 },
  medicationSchedule: [{ medicationName: String, time: String, frequency: String }],
  reminderPreferences: {
    glucoseLogging: { type: Boolean, default: true },
    medication: { type: Boolean, default: true }
  }
});

const Patient = mongoose.model('Patient', patientSchema);

const onboardingStateSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  currentStep: { type: String, default: 'language' },
  data: { type: Map, of: mongoose.Schema.Types.Mixed },
  lastUpdated: { type: Date, default: Date.now }
});

const OnboardingState = mongoose.model('OnboardingState', onboardingStateSchema);

const medicalKnowledgeSchema = new mongoose.Schema({
  source: { type: String, required: true },
  content: { type: String, required: true },
  keywords: [String],
  pageNumber: Number,
  chunkIndex: Number,
  lastUpdated: { type: Date, default: Date.now }
});

medicalKnowledgeSchema.index({ content: 'text', keywords: 'text' });
medicalKnowledgeSchema.index({ source: 1, keywords: 1 });

const MedicalKnowledge = mongoose.model('MedicalKnowledge', medicalKnowledgeSchema);

const triageSchema = new mongoose.Schema({
  patientPhone: String,
  timestamp: { type: Date, default: Date.now },
  urgencyLevel: { type: String, enum: ['EMERGENCY', 'URGENT', 'ROUTINE', 'MONITORING'], required: true },
  symptoms: [String],
  glucoseReading: Number,
  aiAssessment: String,
  medicalReferences: [{ source: String, content: String }],
  physicianAlerted: Boolean
});

const Triage = mongoose.model('Triage', triageSchema);

const glucoseReadingSchema = new mongoose.Schema({
  patientPhone: String,
  reading: Number,
  readingType: { type: String, enum: ['fasting', 'postprandial', 'random'] },
  timestamp: { type: Date, default: Date.now },
  symptoms: [String],
  notes: String,
  alertSent: Boolean,
  triageId: mongoose.Schema.Types.ObjectId
});

const GlucoseReading = mongoose.model('GlucoseReading', glucoseReadingSchema);

const conversationSchema = new mongoose.Schema({
  patientPhone: String,
  messages: [{ role: String, content: String, messageType: { type: String, default: 'text' }, timestamp: Date }],
  lastActive: Date,
  voiceMessagesCount: { type: Number, default: 0 }
});

const Conversation = mongoose.model('Conversation', conversationSchema);

// ========================================
// DATABASE CONNECTION
// ========================================

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI).then(async () => {
    console.log('✅ MongoDB connected');
    await initializeRAGSystem();
  }).catch(err => console.error('❌ MongoDB:', err.message));
} else {
  console.error('❌ Cannot start - MONGODB_URI not set');
}

async function initializeRAGSystem() {
  try {
    const existingCount = await MedicalKnowledge.countDocuments();
    
    if (existingCount > 50) {
      console.log(`✅ RAG System ready (${existingCount} chunks)`);
      ragSystemInitialized = true;
      return;
    }
    
    console.log('📚 RAG not initialized');
    console.log('📝 Call: POST /admin/process-pdfs');
    ragSystemInitialized = false;
  } catch (error) {
    console.error('❌ RAG init error:', error.message);
  }
}

// ========================================
// VOICE MODULE (OpenAI Whisper + gTTS)
// ========================================

async function downloadWhatsAppAudio(mediaId) {
  try {
    console.log(`📥 Downloading audio: ${mediaId}`);
    
    const mediaUrlResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
    );
    
    const mediaUrl = mediaUrlResponse.data.url;
    const audioResponse = await axios.get(mediaUrl, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer'
    });
    
    const tempDir = '/tmp/whatsapp-audio';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const filePath = path.join(tempDir, `${mediaId}.ogg`);
    fs.writeFileSync(filePath, audioResponse.data);
    
    console.log(`✅ Audio downloaded`);
    return filePath;
  } catch (error) {
    console.error('❌ Download error:', error.message);
    throw new Error('Failed to download audio');
  }
}

async function transcribeWhatsAppAudio(mediaId, language = 'en') {
  try {
    console.log(`👂 Transcribing with Whisper (auto-detect)...`);
    
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set - voice features disabled');
    }
    
    const audioFilePath = await downloadWhatsAppAudio(mediaId);
    
    const form = new FormData();
    form.append('file', fs.createReadStream(audioFilePath));
    form.append('model', 'whisper-1');
    
    // ✅ DON'T specify language - let Whisper auto-detect!
    // This allows users to speak any language regardless of their registered preference
    // form.append('language', ...) // REMOVED!
    
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 30000
      }
    );
    
    const transcription = response.data.text;
    console.log(`✅ Transcribed: "${transcription}"`);
    
    try { fs.unlinkSync(audioFilePath); } catch (e) {}
    
    return transcription;
  } catch (error) {
    console.error('❌ Transcription error:', error.message);
    
    // ✅ IMPROVED ERROR MESSAGES
    if (error.response?.status === 401) {
      throw new Error('Invalid OpenAI API key');
    } else if (error.response?.status === 429) {
      throw new Error('⚠️ OpenAI rate limit reached. Please add credits at platform.openai.com/account/billing');
    } else if (error.response?.status === 402 || error.message.includes('insufficient_quota')) {
      throw new Error('⚠️ OpenAI account has insufficient credits. Add credits at platform.openai.com/account/billing');
    }
    
    throw new Error('Transcription failed: ' + error.message);
  }
}

async function speakResponse(text, language = 'en') {
  try {
    // ✅ USE gTTS (native voices) for Hindi and Kannada
    // ✅ USE OpenAI TTS for English (better quality)
    
    console.log(`🎙️  TTS Request: language="${language}", text="${text.substring(0, 50)}..."`);
    
    if (language === 'hi' || language === 'hi_pure' || language === 'kn' || language === 'kn_pure') {
      console.log(`✅ ROUTING TO gTTS for NATIVE ${language} voice`);
      return await speakResponseGTTS(text, language);
    }
    
    console.log(`✅ ROUTING TO Google Cloud TTS for ${language}`);
    
    // For English, try Google Cloud TTS first, then OpenAI
    console.log(`🗣️  Generating speech with Google Cloud TTS (${language})...`);
    
    // Google Cloud TTS has MUCH better Indian voices than OpenAI
    // Wavenet voices sound very natural and human-like
    
    const voiceMap = {
      'en': { languageCode: 'en-IN', name: 'en-IN-Wavenet-D', gender: 'MALE' },      // Indian English - Natural male
      'hi': { languageCode: 'hi-IN', name: 'hi-IN-Wavenet-D', gender: 'MALE' },      // Hindi - Natural male  
      'kn': { languageCode: 'kn-IN', name: 'kn-IN-Wavenet-A', gender: 'FEMALE' }     // Kannada - Natural female
    };
    
    const voice = voiceMap[language] || voiceMap['en'];
    
    // Build request for Google Cloud TTS
    const request = {
      input: { text: text },
      voice: {
        languageCode: voice.languageCode,
        name: voice.name,
        ssmlGender: voice.gender
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.85,  // Slightly slower for elderly users
        pitch: 0.0,          // Normal pitch
        volumeGainDb: 0.0    // Normal volume
      }
    };
    
    // Use Google Cloud TTS API
    const response = await axios.post(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_CLOUD_API_KEY || OPENAI_API_KEY}`,
      request,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    
    // Decode base64 audio
    const audioContent = response.data.audioContent;
    const audioBuffer = Buffer.from(audioContent, 'base64');
    
    // Save audio file
    const tempDir = '/tmp/whatsapp-tts';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    const fileName = `tts_google_${language}_${timestamp}.mp3`;
    const filePath = path.join(tempDir, fileName);
    
    fs.writeFileSync(filePath, audioBuffer);
    
    console.log(`✅ Speech generated (Google Cloud TTS - ${voice.name})`);
    return filePath;
    
  } catch (error) {
    console.error('❌ Google TTS error:', error.message);
    
    // If Google Cloud not configured, try OpenAI TTS
    if (error.response?.status === 403 || error.response?.status === 401) {
      console.log('⚠️  Google Cloud TTS not configured, trying OpenAI TTS...');
      return await speakResponseOpenAI(text, language);
    }
    
    // Otherwise fallback to gTTS
    console.log('⚠️  Falling back to gTTS...');
    return await speakResponseGTTS(text, language);
  }
}

// OpenAI TTS function (fallback)
async function speakResponseOpenAI(text, language = 'en') {
  try {
    console.log(`🗣️  Generating speech with OpenAI TTS (${language})...`);
    
    if (!OPENAI_API_KEY) {
      throw new Error('OpenAI API key required');
    }
    
    const voiceMap = {
      'en': 'alloy',      // Clear American English
      'hi': 'alloy',      // ✅ CHANGED: 'alloy' is clearer for Hindi than 'nova'
      'hi_pure': 'alloy', // Same for pure Hindi
      'kn': 'shimmer',    // Better for Kannada (clearer, more natural)
      'kn_pure': 'shimmer' // Same for pure Kannada
    };
    
    const voice = voiceMap[language] || 'alloy';
    
    // ✅ Use slower speed for Hindi to improve clarity
    const speedMap = {
      'en': 1.0,
      'hi': 0.85,     // Slower for Hindi clarity
      'hi_pure': 0.85,
      'kn': 0.9,      // Slightly slower for Kannada
      'kn_pure': 0.9
    };
    
    const speed = speedMap[language] || 1.0;
    
    const response = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: 'tts-1-hd',  // ✅ CHANGED: Use HD model for better quality
        voice: voice,
        input: text,
        speed: speed  // ✅ CHANGED: Variable speed based on language
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );
    
    const tempDir = '/tmp/whatsapp-tts';
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    const fileName = `tts_openai_${language}_${timestamp}.mp3`;
    const filePath = path.join(tempDir, fileName);
    
    fs.writeFileSync(filePath, response.data);
    
    console.log(`✅ Speech generated (OpenAI TTS)`);
    return filePath;
    
  } catch (error) {
    console.error('❌ OpenAI TTS error:', error.message);
    throw error;
  }
}

// Fallback gTTS function (if OpenAI TTS fails)
// ✅ NOW PRIMARY for Hindi and Kannada - has NATIVE voices!
async function speakResponseGTTS(text, language = 'en') {
  return new Promise((resolve, reject) => {
    try {
      console.log(`🗣️  Generating speech with gTTS (${language})...`);
      
      // ✅ Map all language variants to base codes
      const langMap = { 
        'en': 'en', 
        'hi': 'hi',
        'hi_pure': 'hi',  // Map hi_pure to hi
        'kn': 'kn',
        'kn_pure': 'kn'   // Map kn_pure to kn
      };
      const lang = langMap[language] || 'en';
      
      const gttsInstance = new gtts(text, lang);
      
      const tempDir = '/tmp/whatsapp-tts';
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const fileName = `tts_gtts_${language}_${timestamp}.mp3`;
      const filePath = path.join(tempDir, fileName);
      
      gttsInstance.save(filePath, (err) => {
        if (err) {
          console.error('❌ gTTS error:', err);
          reject(new Error('Failed to generate speech'));
          return;
        }
        
        console.log(`✅ Speech generated (gTTS - Native ${lang} voice)`);
        resolve(filePath);
      });
    } catch (error) {
      console.error('❌ gTTS error:', error.message);
      reject(new Error('Failed to generate speech'));
    }
  });
}

async function uploadAudioToWhatsApp(filePath) {
  try {
    console.log(`📤 Uploading audio...`);
    
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('type', 'audio/mpeg');
    form.append('messaging_product', 'whatsapp');
    
    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/media`,
      form,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          ...form.getHeaders()
        },
        timeout: 30000
      }
    );
    
    const mediaId = response.data.id;
    console.log(`✅ Audio uploaded: ${mediaId}`);
    
    try { fs.unlinkSync(filePath); } catch (e) {}
    
    return mediaId;
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    throw new Error('Failed to upload audio');
  }
}

async function sendVoiceMessage(to, mediaId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'audio',
        audio: { id: mediaId }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`✅ Voice sent to ${to}`);
  } catch (error) {
    console.error('❌ Send voice error:', error.message);
    throw new Error('Failed to send voice');
  }
}

async function sendVoiceResponse(to, text, language = 'en') {
  try {
    console.log(`🎙️  Voice pipeline start`);
    
    const audioFilePath = await speakResponse(text, language);
    const mediaId = await uploadAudioToWhatsApp(audioFilePath);
    await sendVoiceMessage(to, mediaId);
    
    console.log(`✅ Voice pipeline complete`);
    return true;
  } catch (error) {
    console.error('❌ Voice pipeline error:', error.message);
    return false;
  }
}

// ========================================
// ⭐ SIMPLE, RELIABLE ONBOARDING SYSTEM ⭐
// NO AI DEPENDENCY - PRODUCTION GRADE
// ========================================

const MESSAGES = {
  welcome: {
    en: `🙏 Welcome to Gluco Sahayak!

I'm your diabetes assistant.

Please select your language:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

Reply with 1, 2, or 3`,
    hi: `🙏 Gluco Sahayak में स्वागत!

मैं आपका diabetes assistant हूं।

कृपया अपनी भाषा चुनें:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

1, 2, या 3 भेजें`,
    kn: `🙏 Gluco Sahayak ಗೆ ಸ್ವಾಗತ!

ನಾನು ನಿಮ್ಮ diabetes assistant.

ದಯವಿಟ್ಟು ಭಾಷೆ ಆಯ್ಕೆಮಾಡಿ:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

1, 2, ಅಥವಾ 3 ಕಳುಹಿಸಿ`
  },
  
  choice: {
    en: `Perfect! Now choose how to proceed:

1️⃣ SETUP NOW (2 minutes) ⚙️
   Complete your profile for personalized care
   
2️⃣ EMERGENCY - Get Help Now! 🚨
   Skip setup, start chatting immediately
   (Type "SETUP" later anytime to complete profile)

Reply: 1 or 2`,
    hi: `बढ़िया! अब चुनें:

1️⃣ अभी SETUP करें (2 minute) ⚙️
   आपकी profile तैयार करें
   
2️⃣ EMERGENCY - तुरंत मदद! 🚨
   Setup skip करें, अभी chat शुरू
   (बाद में "SETUP" लिखकर profile पूरी करें)

1 या 2 भेजें`,
    kn: `ಚೆನ್ನಾಗಿದೆ! ಈಗ ಆಯ್ಕೆಮಾಡಿ:

1️⃣ ಈಗ SETUP ಮಾಡಿ (2 minute) ⚙️
   ನಿಮ್ಮ profile ಮಾಡಿ
   
2️⃣ EMERGENCY - ಈಗ ಸಹಾಯ! 🚨
   Setup skip, ಈಗ chat ಪ್ರಾರಂಭಿಸಿ
   (ನಂತರ "SETUP" ಎಂದು profile ಪೂರ್ಣಗೊಳಿಸಿ)

1 ಅಥವಾ 2`
  },
  
  ask_name: {
    en: `Great! 😊 What's your full name?`,
    hi: `बढ़िया! 😊 आपका पूरा नाम क्या है?`,
    kn: `ಚೆನ್ನಾಗಿದೆ! 😊 ನಿಮ್ಮ ಪೂರ್ಣ ಹೆಸರು?`
  },
  
  ask_age: {
    en: `Nice to meet you {name}! 👋\n\nHow old are you?`,
    hi: `{name} जी, मिलकर खुशी हुई! 👋\n\nआपकी उम्र क्या है?`,
    kn: `{name}, ಭೇಟಿಯಾಗಿ ಸಂತೋಷ! 👋\n\nನಿಮ್ಮ ವಯಸ್ಸು?`
  },
  
  ask_gender: {
    en: `Perfect! Are you:\n\n1️⃣ Male\n2️⃣ Female\n\nReply with 1 or 2`,
    hi: `बढ़िया! आप:\n\n1️⃣ पुरुष (Male)\n2️⃣ महिला (Female)\n\n1 या 2 भेजें`,
    kn: `ಚೆನ್ನಾಗಿದೆ! ನೀವು:\n\n1️⃣ ಪುರುಷ (Male)\n2️⃣ ಮಹಿಳೆ (Female)\n\n1 ಅಥವಾ 2`
  },
  
  ask_emergency: {
    en: `Got it! 📱\n\nEmergency contact number?\n(10 digits, e.g., 9876543210)`,
    hi: `समझ गया! 📱\n\nEmergency contact number?\n(10 अंक, जैसे 9876543210)`,
    kn: `ಅರ್ಥವಾಯಿತು! 📱\n\nEmergency contact number?\n(10 digits, ಉದಾ: 9876543210)`
  },
  
  ask_pincode: {
    en: `Thank you! 📍\n\nYour area pincode?\n(6 digits)`,
    hi: `धन्यवाद! 📍\n\nआपका pincode?\n(6 अंक)`,
    kn: `ಧನ್ಯವಾದಗಳು! 📍\n\nನಿಮ್ಮ pincode?\n(6 digits)`
  },
  
  ask_consent: {
    en: `Almost there! 🎯\n\nDo you consent to diabetes care support?\n\n1️⃣ Yes\n2️⃣ No\n\nReply 1 or 2`,
    hi: `लगभग हो गया! 🎯\n\nक्या diabetes care के लिए सहमति है?\n\n1️⃣ हां\n2️⃣ नहीं\n\n1 या 2`,
    kn: `ಬಹುತೇಕ ಮುಗಿಯಿತು! 🎯\n\nDiabetes care ಗೆ ಒಪ್ಪಿಗೆ?\n\n1️⃣ ಹೌದು\n2️⃣ ಇಲ್ಲ\n\n1 ಅಥವಾ 2`
  },
  
  ask_diabetes_type: {
    en: `Excellent! 🏥\n\nWhat type of diabetes?\n\n1️⃣ Type 1\n2️⃣ Type 2\n3️⃣ Gestational\n\nReply 1, 2, or 3`,
    hi: `बढ़िया! 🏥\n\nकिस प्रकार का diabetes?\n\n1️⃣ Type 1\n2️⃣ Type 2\n3️⃣ Gestational\n\n1, 2, या 3`,
    kn: `ಉತ್ತಮ! 🏥\n\nಯಾವ diabetes?\n\n1️⃣ Type 1\n2️⃣ Type 2\n3️⃣ Gestational\n\n1, 2, ಅಥವಾ 3`
  },
  
  ask_duration: {
    en: `Noted! ⏱️\n\nHow many years have you had diabetes?\n(Just the number, e.g., 5)`,
    hi: `समझ गया! ⏱️\n\nकितने साल से diabetes है?\n(सिर्फ number, जैसे 5)`,
    kn: `ಅರ್ಥವಾಯಿತು! ⏱️\n\nDiabetes ಎಷ್ಟು ವರ್ಷಗಳು?\n(Number, ಉದಾ: 5)`
  },
  
  ask_medication: {
    en: `Got it! 💊\n\nWhat medication do you take?\n\n1️⃣ Insulin\n2️⃣ Tablets\n3️⃣ Both\n4️⃣ None\n\nReply 1, 2, 3, or 4`,
    hi: `ठीक है! 💊\n\nकौन सी medicine लेते हैं?\n\n1️⃣ Insulin\n2️⃣ Tablets\n3️⃣ दोनों\n4️⃣ कोई नहीं\n\n1, 2, 3, या 4`,
    kn: `ಅರ್ಥವಾಯಿತು! 💊\n\nಯಾವ medicine?\n\n1️⃣ Insulin\n2️⃣ Tablets\n3️⃣ Both\n4️⃣ None\n\n1, 2, 3, ಅಥವಾ 4`
  },
  
  ask_medicine_names: {
    en: `Perfect! 📝\n\nMedicine names?\n(e.g., Metformin, Glimepiride)\n\nType "none" or "don't know" if unsure`,
    hi: `बढ़िया! 📝\n\nMedicine के नाम?\n(जैसे Metformin, Glimepiride)\n\n"none" या "पता नहीं" लिखें`,
    kn: `ಚೆನ್ನಾಗಿದೆ! 📝\n\nMedicine ಹೆಸರುಗಳು?\n(ಉದಾ: Metformin)\n\n"none" ಅಥವಾ "don't know"`
  },
  
  ask_diet: {
    en: `Thank you! 🍽️\n\nDiet preference?\n\n1️⃣ Vegetarian\n2️⃣ Non-Vegetarian\n3️⃣ Eggetarian\n\nReply 1, 2, or 3`,
    hi: `धन्यवाद! 🍽️\n\nआहार?\n\n1️⃣ शाकाहारी (Veg)\n2️⃣ मांसाहारी (Non-Veg)\n3️⃣ अंडा खाते हैं\n\n1, 2, या 3`,
    kn: `ಧನ್ಯವಾದ! 🍽️\n\nDiet?\n\n1️⃣ ಶಾಕಾಹಾರಿ (Veg)\n2️⃣ ಮಾಂಸಾಹಾರಿ (Non-Veg)\n3️⃣ Eggetarian\n\n1, 2, ಅಥವಾ 3`
  },
  
  ask_comorbidities: {
    en: `Almost done! 🎯\n\nAny other health issues?\n(e.g., BP, Cholesterol, Heart)\n\nType "none" if none`,
    hi: `लगभग पूरा! 🎯\n\nकोई और बीमारी?\n(जैसे BP, Cholesterol, दिल)\n\n"none" लिखें अगर नहीं`,
    kn: `ಬಹುತೇಕ ಮುಗಿಯಿತು! 🎯\n\nಇನ್ನೇನಾದರೂ?\n(ಉದಾ: BP, Cholesterol)\n\n"none" ಎಂದರೆ ಇಲ್ಲ`
  },
  
  ask_hba1c: {
    en: `Last question! 🔬\n\nLast HbA1c value?\n(e.g., 7.5 or 8)\n\nType "don't know" if you don't know`,
    hi: `आखिरी सवाल! 🔬\n\nLast HbA1c?\n(जैसे 7.5 या 8)\n\n"पता नहीं" अगर नहीं पता`,
    kn: `ಕೊನೆಯ ಪ್ರಶ್ನೆ! 🔬\n\nLast HbA1c?\n(ಉದಾ: 7.5 ಅಥವಾ 8)\n\n"don't know" ಎಂದರೆ ತಿಳಿದಿಲ್ಲ`
  },
  
  complete: {
    en: `✅ All set, {name}!

Your profile is complete! 🎉

I'll help you with:
📊 Glucose tracking
💊 Medicine reminders
🍽️ Diet advice
🚨 Emergency alerts
🎙️ Voice messages (send audio!)

Ready to start! What's your current glucose reading?

💡 Quick commands:
• "RESET" - Delete all data
• "HINDI" - Switch to Hinglish
• "KANNADA" - Switch to Kanglish
• "ENGLISH" - Switch to English`,
    hi: `✅ हो गया {name} जी!

Profile तैयार! 🎉

मैं मदद करूंगा:
📊 Glucose tracking
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice messages

तैयार! Current glucose reading?

💡 Commands:
• "RESET" - सब delete
• "HINDI" - Hinglish में
• "KANNADA" - Kanglish में  
• "ENGLISH" - English में`,
    kn: `✅ ಮುಗಿಯಿತು {name}!

Profile ready! 🎉

ನಾನು ಸಹಾಯ:
📊 Glucose tracking
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice messages

ತಯಾರು! Current glucose reading?

💡 Commands:
• "RESET" - ಎಲ್ಲಾ delete
• "HINDI" - Hinglish
• "KANNADA" - Kanglish
• "ENGLISH" - English`
  },
  
  emergency_ready: {
    en: `🚨 EMERGENCY MODE ACTIVATED!

You can start chatting immediately! 💬

Try:
• "My sugar is 180"
• "Diet advice"
• "मेरा sugar 150 hai" (Hindi)
• Send voice message 🎙️

💡 Type "SETUP" anytime to complete your profile for better personalized care.

What's your glucose reading or question?`,
    hi: `🚨 EMERGENCY MODE चालू!

अभी chat शुरू करें! 💬

Try करें:
• "Mera sugar 180 hai"
• "Diet advice chahiye"
• Voice message भेजें 🎙️

💡 "SETUP" लिखें profile पूरी करने के लिए।

Aapka glucose reading ya question?`,
    kn: `🚨 EMERGENCY MODE ಆರಂಭ!

ಈಗ chat ಪ್ರಾರಂಭಿಸಿ! 💬

Try ಮಾಡಿ:
• "Nanna sugar 180 ide"
• "Diet advice beku"
• Voice message ಕಳುಹಿಸಿ 🎙️

💡 "SETUP" profile complete ಮಾಡಲು.

Nimmadu glucose reading ಅಥವಾ question?`
  },
  
  error_retry: {
    en: `Sorry, I didn't understand. Please try again! 🙏`,
    hi: `माफ़ करें, समझ नहीं आया। फिर से भेजें! 🙏`,
    kn: `ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ. ಮತ್ತೆ ಕಳುಹಿಸಿ! 🙏`
  }
};

// ========================================
// SIMPLE PARSING FUNCTIONS (NO AI NEEDED)
// ========================================

function parseLanguage(message) {
  const lower = message.toLowerCase().trim();
  
  // Accept: 1, english, eng, en
  if (lower === '1' || lower.includes('english') || lower === 'eng' || lower === 'en') {
    return 'en';
  }
  
  // Accept: 2, hindi, हिंदी, hi
  if (lower === '2' || lower.includes('hindi') || lower.includes('हिंदी') || lower === 'hi') {
    return 'hi';
  }
  
  // Accept: 3, kannada, ಕನ್ನಡ, kn
  if (lower === '3' || lower.includes('kannada') || lower.includes('ಕನ್ನಡ') || lower === 'kn') {
    return 'kn';
  }
  
  return null;
}

function parseName(message) {
  // Accept anything non-empty as a name
  const cleaned = message.trim();
  
  if (cleaned.length === 0) return null;
  if (cleaned.length > 100) return null; // Too long
  
  // Capitalize first letter of each word
  return cleaned.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function parseAge(message) {
  const cleaned = message.trim();
  
  // Extract number from message
  const match = cleaned.match(/(\d+)/);
  if (!match) return null;
  
  const age = parseInt(match[1]);
  
  // Validate age range
  if (age < 1 || age > 120) return null;
  
  return age;
}

function parseGender(message) {
  const lower = message.toLowerCase().trim();
  
  // Accept: 1, male, m, man
  if (lower === '1' || lower === 'male' || lower === 'm' || lower === 'man') {
    return 'Male';
  }
  
  // Accept: 2, female, f, woman
  if (lower === '2' || lower === 'female' || lower === 'f' || lower === 'woman' || lower === 'w') {
    return 'Female';
  }
  
  return null;
}

function parsePhone(message) {
  // Remove all non-digits
  const digits = message.replace(/\D/g, '');
  
  // Check for 10-digit number
  if (digits.length === 10 && digits.match(/^[6-9]\d{9}$/)) {
    return `+91${digits}`;
  }
  
  // Already has +91
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }
  
  return null;
}

function parsePincode(message) {
  // Extract 6-digit number
  const match = message.match(/\b(\d{6})\b/);
  if (!match) return null;
  
  return match[1];
}

function parseConsent(message) {
  const lower = message.toLowerCase().trim();
  
  // Accept: 1, yes, yeah, ok, हां, ಹೌದು
  if (lower === '1' || lower === 'yes' || lower === 'yeah' || lower === 'ok' || 
      lower === 'y' || lower.includes('हां') || lower.includes('ಹೌದು')) {
    return true;
  }
  
  // Accept: 2, no, nope, नहीं, ಇಲ್ಲ
  if (lower === '2' || lower === 'no' || lower === 'nope' || lower === 'n' || 
      lower.includes('नहीं') || lower.includes('ಇಲ್ಲ')) {
    return false;
  }
  
  return null;
}

function parseDiabetesType(message) {
  const lower = message.toLowerCase().trim();
  
  if (lower === '1' || lower.includes('type 1') || lower.includes('type1')) {
    return 'Type 1';
  }
  
  if (lower === '2' || lower.includes('type 2') || lower.includes('type2')) {
    return 'Type 2';
  }
  
  if (lower === '3' || lower.includes('gestational')) {
    return 'Gestational';
  }
  
  return null;
}

function parseDuration(message) {
  // Extract number
  const match = message.match(/(\d+)/);
  if (!match) return null;
  
  const years = parseInt(match[1]);
  
  if (years < 0 || years > 100) return null;
  
  return years;
}

function parseMedicationType(message) {
  const lower = message.toLowerCase().trim();
  
  if (lower === '1' || lower.includes('insulin')) {
    return 'Insulin';
  }
  
  if (lower === '2' || lower.includes('tablet')) {
    return 'Tablets';
  }
  
  if (lower === '3' || lower.includes('both') || lower.includes('दोनों')) {
    return 'Both';
  }
  
  if (lower === '4' || lower.includes('none') || lower.includes('नहीं') || lower.includes('ಇಲ್ಲ')) {
    return 'None';
  }
  
  return null;
}

function parseMedicineNames(message) {
  const lower = message.toLowerCase().trim();
  
  // Handle "none" or "don't know"
  if (lower === 'none' || lower.includes("don't know") || lower.includes('नहीं') || 
      lower.includes('पता नहीं') || lower.includes('ತಿಳಿದಿಲ್ಲ')) {
    return ['None'];
  }
  
  // Split by comma or "and"
  const medicines = message
    .split(/[,\n]|and|और|ಮತ್ತು/)
    .map(m => m.trim())
    .filter(m => m.length > 0 && m.length < 50);
  
  if (medicines.length === 0) return ['None'];
  
  return medicines;
}

function parseDiet(message) {
  const lower = message.toLowerCase().trim();
  
  if (lower === '1' || lower.includes('veg') || lower.includes('शाकाहारी') || lower.includes('ಶಾಕಾಹಾರಿ')) {
    return 'Veg';
  }
  
  if (lower === '2' || lower.includes('non') || lower.includes('मांसाहारी') || lower.includes('ಮಾಂಸಾಹಾರಿ')) {
    return 'Non-Veg';
  }
  
  if (lower === '3' || lower.includes('egg')) {
    return 'Eggetarian';
  }
  
  return null;
}

function parseComorbidities(message) {
  const lower = message.toLowerCase().trim();
  
  // Handle "none"
  if (lower === 'none' || lower.includes('नहीं') || lower.includes('ಇಲ್ಲ') || 
      lower === 'no' || lower === 'nil') {
    return ['None'];
  }
  
  const conditions = [];
  
  if (lower.includes('bp') || lower.includes('pressure') || lower.includes('hypertension')) {
    conditions.push('BP');
  }
  if (lower.includes('cholesterol') || lower.includes('lipid')) {
    conditions.push('Cholesterol');
  }
  if (lower.includes('heart') || lower.includes('cardiac') || lower.includes('दिल')) {
    conditions.push('Heart');
  }
  if (lower.includes('kidney') || lower.includes('renal') || lower.includes('गुर्दा')) {
    conditions.push('Kidney');
  }
  if (lower.includes('thyroid')) {
    conditions.push('Thyroid');
  }
  
  return conditions.length > 0 ? conditions : ['None'];
}

function parseHbA1c(message) {
  const lower = message.toLowerCase().trim();
  
  // Handle "don't know"
  if (lower.includes("don't know") || lower.includes('पता नहीं') || 
      lower.includes('ತಿಳಿದಿಲ್ಲ') || lower === 'dk' || lower === 'unknown') {
    return null;
  }
  
  // Extract decimal number
  const match = message.match(/(\d+\.?\d*)/);
  if (!match) return null;
  
  const value = parseFloat(match[1]);
  
  // Validate HbA1c range (typically 4-15)
  if (value < 3 || value > 20) return null;
  
  return value;
}

// ========================================
// 🌐 LANGUAGE DETECTION (AUTO-UPDATE)
// ========================================

function detectLanguage(message) {
  const text = message.toLowerCase();
  
  // Hindi indicators - including both Devanagari and romanized
  const hindiWords = [
    // Devanagari
    'मेरा', 'है', 'में', 'का', 'को', 'से', 'के', 'की', 'हूं', 'हैं', 
    'था', 'थी', 'गया', 'गई', 'हो', 'ही', 'तो', 'यह', 'वह', 'कर',
    'था', 'हुआ', 'हुई', 'होना', 'करना', 'लेना', 'देना',
    // Romanized/Hinglish
    'mera', 'hai', 'mein', 'ka', 'ko', 'se', 'ke', 'ki', 'hoon', 'hain',
    'kya', 'kaise', 'kab', 'kahan', 'kyun', 'aur', 'nahi', 'haan', 'ji',
    'aapka', 'aapko', 'mere', 'tera', 'tumhara', 'uska', 'iske',
    'bohot', 'bahut', 'thoda', 'zyada', 'kam', 'bilkul', 'abhi', 'turant',
    'karo', 'karna', 'piyo', 'peena', 'khao', 'khana', 'bataiye', 'batao',
    'theek', 'achha', 'accha', 'sahi', 'galat'
  ];
  const hindiChars = /[\u0900-\u097F]/; // Devanagari script
  
  // Kannada indicators
  const kannadaWords = [
    'ನನ್ನ', 'ನಾನು', 'ಇದೆ', 'ಆಗಿದೆ', 'ಮಾಡಿ', 'ಹೇಗೆ', 'ಏನು',
    'ನಿಮ್ಮ', 'ನಿಮ್ಮದು', 'ಅವರ', 'ನಮ್ಮ', 'ತುಂಬಾ', 'ಸ್ವಲ್ಪ',
    // Romanized/Kanglish
    'nimmadu', 'nannu', 'naanu', 'ide', 'aagide', 'maadi', 'maadu',
    'hege', 'enu', 'ella', 'chennaagide', 'tumba', 'swalpa',
    'jaasthi', 'kammi', 'kuDi', 'kuDu', 'tini', 'tinnu'
  ];
  const kannadaChars = /[\u0C80-\u0CFF]/; // Kannada script
  
  // Check for scripts first (most reliable)
  if (hindiChars.test(text)) {
    console.log('🌐 Detected Devanagari script → Hindi (pure)');
    return 'hi_pure'; // Pure Hindi in Devanagari
  }
  if (kannadaChars.test(text)) {
    console.log('🌐 Detected Kannada script → Kannada (pure)');
    return 'kn_pure'; // Pure Kannada script
  }
  
  // Check for words (works for romanized text)
  const hindiCount = hindiWords.filter(word => {
    // Use word boundaries to avoid partial matches
    const regex = new RegExp('\\b' + word + '\\b', 'i');
    return regex.test(text);
  }).length;
  
  const kannadaCount = kannadaWords.filter(word => {
    const regex = new RegExp('\\b' + word + '\\b', 'i');
    return regex.test(text);
  }).length;
  
  console.log(`🌐 Language detection: Hindi=${hindiCount} words, Kannada=${kannadaCount} words`);
  
  // Need at least 2 matching words to switch language
  if (hindiCount >= 2) {
    console.log('🌐 Detected Hindi/Hinglish (romanized)');
    return 'hi'; // Hinglish (romanized)
  }
  if (kannadaCount >= 2) {
    console.log('🌐 Detected Kannada/Kanglish (romanized)');
    return 'kn'; // Kanglish (romanized)
  }
  
  // Default to English
  return 'en';
}

async function updateLanguagePreference(phone, detectedLang, currentLang) {
  // Map script types to base language
  const baseLang = detectedLang.replace('_pure', '');
  const currentBase = (currentLang || 'en').replace('_pure', '');
  
  // Only update if base language changed
  if (baseLang !== currentBase) {
    await Patient.findOneAndUpdate(
      { phone },
      { 
        language_pref: baseLang,
        script_pref: detectedLang // Store script preference (hi/hi_pure/kn/kn_pure)
      }
    );
    console.log(`🌐 Language updated: ${currentLang} → ${detectedLang} (base: ${baseLang}) for ${phone}`);
    return true;
  }
  
  // Update script preference even if base language is same
  // (e.g., user switches from Hinglish to pure Hindi)
  const currentScript = currentLang;
  if (detectedLang !== currentScript) {
    await Patient.findOneAndUpdate(
      { phone },
      { script_pref: detectedLang }
    );
    console.log(`🌐 Script updated: ${currentScript} → ${detectedLang} for ${phone}`);
    return true;
  }
  
  return false;
}

// ========================================
// ✅ RELIABLE ONBOARDING HANDLER (FIXED!)
// ========================================

async function handleOnboarding(phone, message) {
  try {
    console.log(`🔧 Onboarding: ${phone} → "${message}"`);
    
    let state = await OnboardingState.findOne({ phone });
    
    // New user
    if (!state) {
      console.log(`🆕 New user: ${phone}`);
      state = await OnboardingState.create({
        phone,
        currentStep: 'language',
        data: new Map()
      });
      
      // ✅ ALWAYS start new users in ENGLISH - they choose language in step 1
      return { response: MESSAGES.welcome.en, completed: false };
    }

    const lang = state.data.get('language_pref') || 'en';
    let response = '';
    let nextStep = state.currentStep;

    // STEP-BY-STEP PROCESSING
    switch (state.currentStep) {
      case 'language': {
        const parsedLang = parseLanguage(message);
        if (parsedLang) {
          state.data.set('language_pref', parsedLang);
          nextStep = 'choice';
          response = MESSAGES.choice[parsedLang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.welcome[lang];
        }
        break;
      }
      
      case 'choice': {
        const choice = message.trim();
        if (choice === '1') {
          // User chose SETUP NOW
          nextStep = 'name';
          response = MESSAGES.ask_name[lang];
        } else if (choice === '2') {
          // User chose EMERGENCY - skip setup
          console.log(`🚨 User ${phone} chose EMERGENCY mode`);
          
          try {
            // Create minimal patient profile (use findOneAndUpdate to avoid duplicates)
            const patient = await Patient.findOneAndUpdate(
              { phone },
              {
                phone,
                language_pref: state.data.get('language_pref') || 'en',
                full_name: 'Emergency User',
                age: 30,
                gender: 'Not Specified',
                emergency_contact: '+919999999999',
                pincode: '000000',
                consent_given: true,
                diabetes_type: 'Not Specified',
                duration_years: 0,
                medication_type: 'Not Specified',
                current_meds: ['Not Specified'],
                comorbidities: ['None'],
                last_hba1c: null,
                diet_preference: 'Not Specified',
                onboarding_completed: true,
                onboarding_step: 'emergency_skip',
                registeredAt: new Date(),
                lastActive: new Date()
              },
              { upsert: true, new: true }
            );
            
            // Delete onboarding state
            await OnboardingState.findOneAndDelete({ phone });
            
            console.log(`✅ Emergency profile created for ${phone}`);
            
            return {
              response: MESSAGES.emergency_ready[lang],
              completed: true
            };
          } catch (emergencyError) {
            console.error(`❌ Emergency mode error:`, emergencyError);
            // Fallback to normal onboarding
            nextStep = 'name';
            response = `Emergency mode failed. Let's do quick setup!\n\n` + MESSAGES.ask_name[lang];
          }
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.choice[lang];
        }
        break;
      }
      
      case 'name': {
        const parsedName = parseName(message);
        if (parsedName) {
          state.data.set('full_name', parsedName);
          nextStep = 'age';
          response = MESSAGES.ask_age[lang].replace('{name}', parsedName);
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_name[lang];
        }
        break;
      }
      
      case 'age': {
        const parsedAge = parseAge(message);
        if (parsedAge) {
          state.data.set('age', parsedAge);
          nextStep = 'gender';
          response = MESSAGES.ask_gender[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_age[lang].replace('{name}', state.data.get('full_name') || '');
        }
        break;
      }
      
      case 'gender': {
        const parsedGender = parseGender(message);
        if (parsedGender) {
          state.data.set('gender', parsedGender);
          nextStep = 'emergency_contact';
          response = MESSAGES.ask_emergency[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_gender[lang];
        }
        break;
      }
      
      case 'emergency_contact': {
        const parsedPhone = parsePhone(message);
        if (parsedPhone) {
          state.data.set('emergency_contact', parsedPhone);
          nextStep = 'pincode';
          response = MESSAGES.ask_pincode[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_emergency[lang];
        }
        break;
      }
      
      case 'pincode': {
        const parsedPincode = parsePincode(message);
        if (parsedPincode) {
          state.data.set('pincode', parsedPincode);
          nextStep = 'consent';
          response = MESSAGES.ask_consent[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_pincode[lang];
        }
        break;
      }
      
      case 'consent': {
        const parsedConsent = parseConsent(message);
        if (parsedConsent !== null) {
          state.data.set('consent_given', parsedConsent);
          nextStep = 'diabetes_type';
          response = MESSAGES.ask_diabetes_type[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_consent[lang];
        }
        break;
      }
      
      case 'diabetes_type': {
        const parsedType = parseDiabetesType(message);
        if (parsedType) {
          state.data.set('diabetes_type', parsedType);
          nextStep = 'duration';
          response = MESSAGES.ask_duration[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_diabetes_type[lang];
        }
        break;
      }
      
      case 'duration': {
        const parsedDuration = parseDuration(message);
        if (parsedDuration !== null) {
          state.data.set('duration_years', parsedDuration);
          nextStep = 'medication_type';
          response = MESSAGES.ask_medication[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_duration[lang];
        }
        break;
      }
      
      case 'medication_type': {
        const parsedMedType = parseMedicationType(message);
        if (parsedMedType) {
          state.data.set('medication_type', parsedMedType);
          
          // Skip medicine names if "None"
          if (parsedMedType === 'None') {
            state.data.set('current_meds', ['None']);
            nextStep = 'diet';
            response = MESSAGES.ask_diet[lang];
          } else {
            nextStep = 'medicine_names';
            response = MESSAGES.ask_medicine_names[lang];
          }
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_medication[lang];
        }
        break;
      }
      
      case 'medicine_names': {
        const parsedMeds = parseMedicineNames(message);
        state.data.set('current_meds', parsedMeds);
        nextStep = 'diet';
        response = MESSAGES.ask_diet[lang];
        break;
      }
      
      case 'diet': {
        const parsedDiet = parseDiet(message);
        if (parsedDiet) {
          state.data.set('diet_preference', parsedDiet);
          nextStep = 'comorbidities';
          response = MESSAGES.ask_comorbidities[lang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.ask_diet[lang];
        }
        break;
      }
      
      case 'comorbidities': {
        const parsedComorb = parseComorbidities(message);
        state.data.set('comorbidities', parsedComorb);
        nextStep = 'hba1c';
        response = MESSAGES.ask_hba1c[lang];
        break;
      }
      
      case 'hba1c': {
        const parsedHba1c = parseHbA1c(message);
        state.data.set('last_hba1c', parsedHba1c);
        
        // SAVE TO DATABASE
        await savePatientData(phone, state.data);
        
        nextStep = 'completed';
        response = MESSAGES.complete[lang].replace('{name}', state.data.get('full_name') || 'friend');
        break;
      }
      
      default:
        console.error(`❌ Unknown step: ${state.currentStep}`);
        nextStep = 'language';
        response = "Something went wrong. Type 'start' to begin again.";
    }

    // ✅✅✅ CRITICAL FIX: Don't save state if onboarding completed ✅✅✅
    // (savePatientData already deleted the OnboardingState document)
    if (nextStep === 'completed') {
      console.log(`✅ Onboarding completed for ${phone}`);
      return { response, completed: true };
    }

    // Save state (only for non-completed steps)
    state.currentStep = nextStep;
    state.lastUpdated = new Date();
    await state.save();
    
    console.log(`✅ Step: ${state.currentStep} → Response: ${response.length} chars`);
    
    return { response, completed: false };
  
  } catch (error) {
    console.error('❌ Onboarding error:', error.message);
    console.error(error.stack);
    
    return {
      response: "Sorry, an error occurred. Please type 'start' to begin again.",
      completed: false
    };
  }
}

async function savePatientData(phone, dataMap) {
  try {
    const patientData = {
      phone,
      language_pref: dataMap.get('language_pref') || 'en',
      full_name: dataMap.get('full_name'),
      age: dataMap.get('age'),
      gender: dataMap.get('gender'),
      emergency_contact: dataMap.get('emergency_contact'),
      pincode: dataMap.get('pincode'),
      consent_given: dataMap.get('consent_given'),
      diabetes_type: dataMap.get('diabetes_type'),
      duration_years: dataMap.get('duration_years') || 0,
      medication_type: dataMap.get('medication_type'),
      current_meds: dataMap.get('current_meds') || ['None'],
      comorbidities: dataMap.get('comorbidities') || ['None'],
      last_hba1c: dataMap.get('last_hba1c'),
      diet_preference: dataMap.get('diet_preference'),
      onboarding_completed: true,
      onboarding_step: 'completed'
    };
    
    await Patient.findOneAndUpdate(
      { phone },
      patientData,
      { upsert: true, new: true }
    );
    
    await OnboardingState.findOneAndDelete({ phone });
    
    console.log(`✅ Patient saved: ${patientData.full_name}`);
  } catch (error) {
    console.error('❌ Save error:', error.message);
  }
}

async function checkOnboardingStatus(phone) {
  const patient = await Patient.findOne({ phone });
  
  if (!patient || !patient.onboarding_completed) {
    return { needsOnboarding: true };
  }
  
  return { needsOnboarding: false, patient };
}

// ========================================
// PDF PROCESSING (RAG SYSTEM)
// ========================================

function extractKeywords(text) {
  const keywords = [];
  const terms = [
    'diabetes', 'glucose', 'insulin', 'hyperglycemia', 'hypoglycemia',
    'HbA1c', 'blood sugar', 'pancreas', 'type 1', 'type 2',
    'metformin', 'glycemic', 'fasting', 'postprandial', 'complications',
    'retinopathy', 'neuropathy', 'nephropathy', 'cardiovascular',
    'diet', 'exercise', 'medication', 'management', 'monitoring'
  ];
  
  const lower = text.toLowerCase();
  terms.forEach(term => {
    if (lower.includes(term)) keywords.push(term);
  });
  
  return [...new Set(keywords)];
}

async function downloadFromGoogleDrive(fileId, filename) {
  try {
    console.log(`📥 Downloading ${filename}...`);
    
    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 120000
    });
    
    const filePath = path.join('/tmp', filename);
    fs.writeFileSync(filePath, response.data);
    
    console.log(`✅ Downloaded`);
    return filePath;
  } catch (error) {
    console.error(`❌ Download failed`);
    
    try {
      const altUrl = `https://drive.google.com/u/0/uc?id=${fileId}&export=download&confirm=t`;
      const response = await axios({
        method: 'GET',
        url: altUrl,
        responseType: 'arraybuffer',
        timeout: 120000
      });
      
      const filePath = path.join('/tmp', filename);
      fs.writeFileSync(filePath, response.data);
      console.log(`✅ Downloaded (alt)`);
      return filePath;
    } catch (altError) {
      console.error(`❌ Alt failed`);
      return null;
    }
  }
}

async function processPDFFile(filePath, source) {
  try {
    console.log(`📖 Processing ${source}...`);
    
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    const paragraphs = data.text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 200 && p.length < 2000);
    
    let saved = 0;
    
    for (let i = 0; i < paragraphs.length; i++) {
      const chunk = paragraphs[i];
      const keywords = extractKeywords(chunk);
      
      if (keywords.length > 0) {
        await MedicalKnowledge.create({
          source,
          content: chunk,
          keywords,
          pageNumber: Math.floor((i / paragraphs.length) * data.numpages),
          chunkIndex: i
        });
        saved++;
      }
      
      if ((i + 1) % 50 === 0) {
        console.log(`   Progress: ${i + 1}/${paragraphs.length}`);
      }
    }
    
    console.log(`✅ ${source}: ${saved} chunks`);
    
    try { fs.unlinkSync(filePath); } catch (e) {}
    
    return saved;
  } catch (error) {
    console.error(`❌ Process error: ${error.message}`);
    return 0;
  }
}

app.post('/admin/process-pdfs', async (req, res) => {
  res.json({ 
    status: 'started',
    message: 'Processing medical textbooks',
    files: MEDICAL_PDF_FILES.length
  });
  
  processAllPDFs();
});

async function processAllPDFs() {
  console.log('\n🏥 PROCESSING MEDICAL TEXTBOOKS\n');
  
  let totalChunks = 0;
  
  for (let i = 0; i < MEDICAL_PDF_FILES.length; i++) {
    const file = MEDICAL_PDF_FILES[i];
    
    console.log(`\n[${i + 1}/${MEDICAL_PDF_FILES.length}] ${file.source}`);
    
    const filePath = await downloadFromGoogleDrive(file.fileId, file.filename);
    
    if (filePath) {
      const chunks = await processPDFFile(filePath, file.source);
      totalChunks += chunks;
    }
  }
  
  ragSystemInitialized = totalChunks > 0;
  
  console.log(`\n✅ COMPLETE! ${totalChunks} total chunks\n`);
}

app.get('/admin/rag-status', async (req, res) => {
  const totalChunks = await MedicalKnowledge.countDocuments();
  const bySource = await MedicalKnowledge.aggregate([
    { $group: { _id: '$source', count: { $sum: 1 } } }
  ]);
  
  res.json({
    initialized: ragSystemInitialized,
    totalChunks,
    bySource,
    ready: totalChunks > 50
  });
});

async function retrieveMedicalKnowledge(query, topK = 5) {
  try {
    const results = await MedicalKnowledge
      .find(
        { $text: { $search: query } },
        { score: { $meta: 'textScore' } }
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(topK);
    
    if (results.length === 0) {
      const keywords = extractKeywords(query);
      if (keywords.length > 0) {
        return await MedicalKnowledge.find({ keywords: { $in: keywords } }).limit(topK);
      }
    }
    
    return results;
  } catch (error) {
    return [];
  }
}

// ========================================
// TRIAGE SYSTEM
// ========================================

function assessUrgency(glucose, symptoms = []) {
  if (glucose < 54 || glucose > 400) return 'EMERGENCY';
  if (symptoms.some(s => ['unconscious', 'confusion', 'seizure'].includes(s.toLowerCase()))) {
    return 'EMERGENCY';
  }
  if (glucose < 70 || glucose > 250) return 'URGENT';
  if (glucose > 180 || glucose < 80) return 'ROUTINE';
  return 'MONITORING';
}

async function createTriageRecord(phone, glucose, symptoms, aiAssessment, medicalRefs) {
  const urgency = assessUrgency(glucose, symptoms);
  
  await Triage.create({
    patientPhone: phone,
    urgencyLevel: urgency,
    symptoms,
    glucoseReading: glucose,
    aiAssessment,
    medicalReferences: medicalRefs,
    physicianAlerted: urgency === 'EMERGENCY' || urgency === 'URGENT'
  });
  
  console.log(`🏥 Triage: ${urgency}`);
  return urgency;
}

// ========================================
// CLAUDE AI + RAG (FOR MEDICAL QUERIES)
// ========================================

async function initializeClaude() {
  if (!ANTHROPIC_API_KEY) return false;
  
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
    
    // ✅ FIXED: with extended thinking on, content[0] can be a "thinking" block,
    // not the reply. Find the actual text block regardless of position.
    const textBlock = response.data?.content?.find(b => b.type === 'text');
    if (textBlock?.text) {
      isClaudeAvailable = true;
      console.log('✅ Claude ready:', CLAUDE_MODEL);
      return true;
    }
    // ✅ FIXED: this branch was previously silent - log unexpected response shape
    console.error('❌ Claude init: unexpected response shape:', JSON.stringify(response.data));
  } catch (error) {
    // ✅ FIXED: log the actual reason instead of a bare message
    console.error('❌ Claude init failed:', JSON.stringify(error.response?.data || error.message));
  }
  return false;
}

initializeClaude();

const THRESHOLDS = {
  fasting: { critical_low: 70, critical_high: 250 },
  postprandial: { critical_low: 70, critical_high: 300 },
  random: { critical_low: 70, critical_high: 250 }
};

async function sendWhatsAppMessage(to, message) {
  try {
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      console.error('❌ Empty message - bug detected!');
      return;
    }
    
    if (message.length > 4096) {
      console.warn(`⚠️  Truncating message (${message.length} chars)`);
      message = message.substring(0, 4090) + '...';
    }
    
    await axios.post(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    }, { 
      headers: { 
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    console.log(`✅ Sent to ${to}`);
  } catch (e) {
    console.error('❌ Send failed:', e.message);
  }
}

// ========================================
// 📤 TEMPLATE MESSAGE SENDING
// ========================================
// Use this to initiate conversations with new users
// or send messages outside 24-hour window

async function sendTemplateMessage(toPhone, templateName, languageCode = 'en', parameters = []) {
  try {
    console.log(`📤 Sending template "${templateName}" to ${toPhone}...`);
    console.log(`📋 Parameters:`, parameters.length > 0 ? parameters : 'None');
    
    const payload = {
      messaging_product: 'whatsapp',
      to: toPhone,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode // e.g., 'en', 'hi', 'en_US'
        },
        components: parameters.length > 0 ? [
          {
            type: 'body',
            parameters: parameters.map(param => ({
              type: 'text',
              text: param
            }))
          }
        ] : []
      }
    };
    
    console.log(`📤 Payload:`, JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    console.log(`✅ Template sent to ${toPhone}:`, response.data.messages?.[0]?.id);
    return response.data;
    
  } catch (error) {
    console.error('❌ Template send error:', error.response?.data || error.message);
    console.error('❌ Full error:', JSON.stringify(error.response?.data, null, 2));
    throw error;
  }
}

// Send template to multiple users (campaign)
async function sendCampaignToMultipleUsers(userList, templateName, languageCode = 'en') {
  const results = [];
  
  console.log(`🚀 Starting campaign: ${userList.length} users`);
  
  for (const user of userList) {
    try {
      // Prepare parameters if user has name
      const parameters = user.name ? [user.name] : [];
      
      await sendTemplateMessage(
        user.phone,
        templateName,
        languageCode,
        parameters
      );
      
      results.push({ 
        phone: user.phone, 
        success: true,
        timestamp: new Date()
      });
      
      // Rate limiting - 1 second between messages
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      results.push({ 
        phone: user.phone, 
        success: false, 
        error: error.message,
        timestamp: new Date()
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  console.log(`✅ Campaign complete: ${successCount}/${userList.length} sent`);
  
  return results;
}

function fallbackResponse(msg) {
  const lower = msg.toLowerCase().trim();
  const num = msg.match(/(\d{2,3})/);
  const glucose = num ? parseInt(num[1]) : null;
  
  if (lower === 'hi' || lower === 'hello' || lower === 'hey' || lower === 'नमस्ते' || lower === 'ನಮಸ್ಕಾರ') {
    return `Namaste! 👋 Send your sugar reading or ask me anything.`;
  }
  
  if (glucose && glucose >= 40 && glucose <= 500) {
    let r = `${glucose} mg/dL - `;
    
    if (glucose < 54) r += `🚨 Very LOW! Eat something sweet NOW!`;
    else if (glucose < 70) r += `⚠️ Low. Eat 3 biscuits now.`;
    else if (glucose <= 100) r += `✅ Perfect!`;
    else if (glucose <= 140) r += `👍 Good!`;
    else if (glucose <= 180) r += `⚠️ High. Walk 10 mins.`;
    else if (glucose <= 250) r += `🚨 Very high! Walk & drink water.`;
    else if (glucose <= 400) r += `🚨🚨 Call doctor NOW!`;
    else r += `🚨🚨🚨 Go to hospital!`;
    
    return r;
  }
  
  return `Send your sugar reading 📊 or ask questions about diet, medicine, etc.`;
}

async function analyzeWithClaudeRAG(phone, msg, patient) {
  if (!isClaudeAvailable) {
    console.log('⚠️  Using fallback (Claude unavailable)');
    return fallbackResponse(msg);
  }
  
  try {
    // ========================================
    // 🧠 RETRIEVE CONVERSATION HISTORY
    // ========================================
    let conversation = await Conversation.findOne({ patientPhone: phone });
    
    if (!conversation) {
      conversation = await Conversation.create({
        patientPhone: phone,
        messages: [],
        lastActive: new Date()
      });
    }
    
    // Get last 10 messages for context (5 exchanges)
    const recentMessages = conversation.messages.slice(-10);
    
    console.log(`💬 Loading ${recentMessages.length} previous messages`);
    
    // ========================================
    // 📚 RETRIEVE MEDICAL KNOWLEDGE
    // ========================================
    const medicalContext = ragSystemInitialized 
      ? await retrieveMedicalKnowledge(msg, 5)
      : [];
    
    console.log(`📚 Retrieved ${medicalContext.length} medical references`);
    
    // ========================================
    // 📊 TIME-AWARE GLUCOSE READINGS
    // ========================================
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const last7DaysStart = new Date(todayStart);
    last7DaysStart.setDate(last7DaysStart.getDate() - 7);
    
    // Get readings by time period
    const todayReadings = await GlucoseReading.find({
      patientPhone: phone,
      timestamp: { $gte: todayStart }
    }).sort({ timestamp: -1 });
    
    const yesterdayReadings = await GlucoseReading.find({
      patientPhone: phone,
      timestamp: { $gte: yesterdayStart, $lt: todayStart }
    }).sort({ timestamp: -1 });
    
    const last7DaysReadings = await GlucoseReading.find({
      patientPhone: phone,
      timestamp: { $gte: last7DaysStart }
    }).sort({ timestamp: -1 });
    
    // Build time-aware summary
    let glucoseSummary = '';
    
    if (todayReadings.length > 0) {
      glucoseSummary += `TODAY: ${todayReadings.map(r => `${r.reading}mg/dL`).join(', ')}`;
    } else {
      glucoseSummary += 'TODAY: No readings yet';
    }
    
    if (yesterdayReadings.length > 0) {
      glucoseSummary += `\nYESTERDAY: ${yesterdayReadings.slice(0, 3).map(r => `${r.reading}mg/dL`).join(', ')}`;
    }
    
    if (last7DaysReadings.length > 0) {
      const avg7Days = Math.round(
        last7DaysReadings.reduce((sum, r) => sum + r.reading, 0) / last7DaysReadings.length
      );
      glucoseSummary += `\nLAST 7 DAYS AVERAGE: ${avg7Days}mg/dL (${last7DaysReadings.length} readings)`;
    }
    
    console.log(`📊 Glucose summary:\n${glucoseSummary}`);
    
    const references = medicalContext.length > 0
      ? medicalContext.map(doc => `[${doc.source}]\n${doc.content.substring(0, 600)}`).join('\n\n')
      : 'No specific textbook reference found. Use general diabetes management protocols.';
    
    const patientProfile = `
PATIENT PROFILE:
- Name: ${patient.full_name} (${patient.age} years, ${patient.gender})
- Diabetes: ${patient.diabetes_type}, ${patient.duration_years} years
- Medications: ${patient.medication_type} - ${patient.current_meds?.join(', ')}
- Comorbidities: ${patient.comorbidities?.join(', ')}
- HbA1c: ${patient.last_hba1c || 'Unknown'}
- Diet: ${patient.diet_preference}
- Language: ${patient.language_pref}

GLUCOSE READINGS (TIME-AWARE):
${glucoseSummary}
`;
    
    // ========================================
    // 🎯 LANGUAGE-SPECIFIC RESPONSE RULES
    // ========================================
    let languageInstruction = '';
    let responseExample = '';
    
    // Get script preference (user's last message format)
    const scriptPref = patient.script_pref || patient.language_pref || 'en';
    const baseLang = scriptPref.replace('_pure', '');
    
    console.log(`🎯 Response language: ${scriptPref} (base: ${baseLang})`);
    
    if (scriptPref === 'hi_pure') {
      // User sent Devanagari - respond in pure Hindi
      languageInstruction = `
🚨🚨🚨 CRITICAL: RESPOND IN PURE HINDI (DEVANAGARI SCRIPT) 🚨🚨🚨

USER SENT DEVANAGARI - YOU MUST RESPOND IN DEVANAGARI!

USE ONLY HINDI WORDS IN DEVANAGARI SCRIPT:
- आपका (NOT "aapka" or "your")
- है (NOT "hai" or "is")
- करो/करें (NOT "karo" or "do")
- पियो/पिएं (NOT "piyo" or "drink")
- खाओ/खाएं (NOT "khao" or "eat")
- थोड़ा (NOT "thoda" or "little")
- ज़्यादा (NOT "zyada" or "more")

MEDICAL TERMS CAN BE IN ENGLISH: sugar, medicine, doctor, diabetes`;

      responseExample = `
CORRECT EXAMPLE:
User: "मेरा sugar 180 है"
YOU MUST SAY: "आपका sugar 180 है, थोड़ा ज़्यादा। walk करो और पानी पियो।"

WRONG - DO NOT DO THIS:
"Aapka sugar 180 hai..." ❌ USER SENT DEVANAGARI, RESPOND IN DEVANAGARI!
"Your sugar is 180..." ❌ NOT PURE ENGLISH!

REMEMBER: USER SENT DEVANAGARI → RESPOND IN DEVANAGARI!`;
      
    } else if (baseLang === 'hi') {
      // User sent romanized Hinglish - respond in Hinglish
      languageInstruction = `
🚨🚨🚨 CRITICAL: RESPOND IN HINGLISH (ROMANIZED) 🚨🚨🚨

USER SENT ROMANIZED HINGLISH - RESPOND IN ROMANIZED HINGLISH!

HINGLISH = Hindi + English mixed, written in Roman script

MANDATORY WORDS YOU MUST USE:
- aapka/tumhara (NOT "your")
- hai (NOT "is")  
- karo (NOT "do")
- piyo (NOT "drink")
- khao (NOT "eat")
- theek (NOT "okay")
- zyada (NOT "high/more")
- kam (NOT "low/less")

KEEP MEDICAL TERMS IN ENGLISH: sugar, medicine, doctor`;

      responseExample = `
CORRECT EXAMPLE:
User: "Mera sugar 180 hai"
YOU MUST SAY: "Aapka sugar 180 hai, thoda zyada. Walk karo aur paani piyo."

WRONG - DO NOT DO THIS:
"Your sugar is 180..." ❌ THIS IS PURE ENGLISH!
"आपका sugar..." ❌ USER SENT ROMAN SCRIPT, NOT DEVANAGARI!

REMEMBER: USE ROMANIZED HINGLISH!`;
      
    } else if (scriptPref === 'kn_pure') {
      // User sent Kannada script - respond in pure Kannada
      languageInstruction = `
🚨🚨🚨 CRITICAL: RESPOND IN PURE KANNADA (KANNADA SCRIPT) 🚨🚨🚨

USER SENT KANNADA SCRIPT - YOU MUST RESPOND IN KANNADA SCRIPT!

USE ONLY KANNADA WORDS IN KANNADA SCRIPT:
- ನಿಮ್ಮದು (NOT "nimmadu" or "your")
- ಇದೆ (NOT "ide" or "is")
- ಮಾಡಿ (NOT "maadi" or "do")
- ಕುಡಿ (NOT "kuDi" or "drink")

MEDICAL TERMS CAN BE IN ENGLISH: sugar, medicine, doctor`;

      responseExample = `
CORRECT:
User: "ನನ್ನ sugar 180 ಇದೆ"
YOU SAY: "ನಿಮ್ಮದು 180, slightly high ಇದೆ. walk ಮಾಡಿ, water ಕುಡಿ."

WRONG:
"Nimmadu 180..." ❌ USER SENT KANNADA SCRIPT!
"Your sugar..." ❌ NOT PURE ENGLISH!`;
      
    } else if (baseLang === 'kn') {
      // User sent romanized Kanglish - respond in Kanglish
      languageInstruction = `
🚨🚨🚨 CRITICAL: RESPOND IN KANGLISH (ROMANIZED) 🚨🚨🚨

USER SENT ROMANIZED KANGLISH - RESPOND IN ROMANIZED KANGLISH!

KANGLISH = Kannada + English mixed, written in Roman script

MANDATORY WORDS:
- nimmadu (NOT "your")
- ide (NOT "is")
- maadi (NOT "do")
- kuDi (NOT "drink")
- chennaagide (NOT "good")

KEEP MEDICAL TERMS IN ENGLISH.`;

      responseExample = `
CORRECT: "Nimmadu 180, slightly high ide. Walk maadi, water kuDi."
WRONG: 
"Your sugar is 180..." ❌ PURE ENGLISH!
"ನಿಮ್ಮದು..." ❌ USER SENT ROMAN SCRIPT!`;
      
    } else {
      languageInstruction = `RESPOND IN SIMPLE ENGLISH`;
      responseExample = `EXAMPLE: "Your sugar is 180, bit high. Walk 10 mins, drink water."`;
    }
    
    const system = `${languageInstruction}

${responseExample}

🎯 USER'S MESSAGE FORMAT: ${scriptPref.toUpperCase()}
${scriptPref !== 'en' ? '⚠️ MATCH USER\'S FORMAT - IF THEY USE DEVANAGARI, USE DEVANAGARI!' : ''}
${scriptPref !== 'en' ? '⚠️ IF THEY USE ROMAN SCRIPT, USE ROMAN SCRIPT!' : ''}

You are Gluco Sahayak for elderly/rural patients.

RESPONSE RULES:
✅ Maximum 40-50 words
✅ 2-3 simple sentences  
✅ ONE action point
❌ NO pure English if language is Hindi/Kannada
${baseLang === 'hi' ? '❌ NO "your", "is", "do" - USE "aapka", "hai", "karo" (or Devanagari equivalents)!' : ''}
${scriptPref === 'hi_pure' ? '❌ USE DEVANAGARI SCRIPT - आपका, है, करो NOT aapka, hai, karo!' : ''}
${scriptPref === 'kn_pure' ? '❌ USE KANNADA SCRIPT - ನಿಮ್ಮದು, ಇದೆ, ಮಾಡಿ NOT nimmadu, ide, maadi!' : ''}

MEMORY: Remember conversation. Don't repeat old advice.

${scriptPref !== 'en' ? '\n🚨 CRITICAL: MATCH USER\'S SCRIPT/FORMAT EXACTLY! 🚨\n' : ''}

MEDICAL CONTEXT:
${references}

${patientProfile}

${scriptPref !== 'en' ? 'RESPOND IN SAME FORMAT AS USER\'S MESSAGE!' : ''}`;
    
    // ========================================
    // 🔄 BUILD CONVERSATION HISTORY FOR CLAUDE
    // ========================================
    const conversationHistory = [];
    
    // Add previous messages from database
    recentMessages.forEach(m => {
      conversationHistory.push({
        role: m.role,
        content: m.content
      });
    });
    
    // Add current user message
    conversationHistory.push({
      role: 'user',
      content: msg
    });
    
    console.log(`📤 Sending ${conversationHistory.length} messages to Claude`);
    
    // ========================================
    // 🤖 CALL CLAUDE WITH FULL CONTEXT
    // ========================================
    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      max_tokens: 200,  // ✅ Reduced from 600 for concise responses
      system,
      messages: conversationHistory
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 20000
    });
    
    // ✅ FIXED: content[0] can be a "thinking" block when extended thinking is on -
    // find the text block by type instead of assuming position 0
    const text = response.data?.content?.find(b => b.type === 'text')?.text;
    
    if (text) {
      console.log(`✅ Claude + RAG (${medicalContext.length} refs, ${recentMessages.length} history)`);
      
      // ========================================
      // 💾 SAVE CONVERSATION TO DATABASE
      // ========================================
      conversation.messages.push({
        role: 'user',
        content: msg,
        messageType: 'text',
        timestamp: new Date()
      });
      
      conversation.messages.push({
        role: 'assistant',
        content: text,
        messageType: 'text',
        timestamp: new Date()
      });
      
      // ========================================
      // 🧹 CLEANUP: Keep only last 20 messages
      // ========================================
      if (conversation.messages.length > 20) {
        conversation.messages = conversation.messages.slice(-20);
        console.log(`🧹 Trimmed conversation to last 20 messages`);
      }
      
      conversation.lastActive = new Date();
      await conversation.save();
      
      console.log(`💾 Conversation saved (${conversation.messages.length} total messages)`);
      
      await Patient.findOneAndUpdate(
        { phone },
        { 
          lastActive: new Date(),
          $inc: { totalConversations: 1 }
        }
      );
      
      return text;
    }
  } catch (e) {
    // ✅ FIXED: log the actual API error, not just e.message
    console.error('❌ Claude error:', JSON.stringify(e.response?.data || e.message));
  }
  
  console.log('⚠️  Using fallback');
  return fallbackResponse(msg);
}

function extractGlucose(msg) {
  const match = msg.match(/(\d{2,3})/);
  const reading = match ? parseInt(match[1]) : null;
  if (!reading || reading < 40 || reading > 500) return { hasReading: false };
  
  const lower = msg.toLowerCase();
  const type = lower.match(/fasting|empty|morning/) ? 'fasting' :
               lower.match(/after|post|lunch|dinner/) ? 'postprandial' : 'random';
  
  const symptoms = [];
  ['tired', 'dizzy', 'thirsty', 'blur', 'sweat', 'weak'].forEach(s => {
    if (lower.includes(s)) symptoms.push(s);
  });
  
  return { hasReading: true, reading, readingType: type, symptoms, notes: msg.substring(0, 200) };
}

async function checkCritical(reading, type, phone) {
  const t = THRESHOLDS[type] || THRESHOLDS.random;
  let critical = false;
  let urgency = 'MONITORING';
  
  if (reading < 54 || reading > 400) {
    critical = true;
    urgency = 'EMERGENCY';
  } else if (reading < t.critical_low || reading > t.critical_high) {
    critical = true;
    urgency = 'URGENT';
  }
  
  if (critical && PHYSICIAN_PHONE && PHYSICIAN_PHONE !== '+919876543210') {
    await sendWhatsAppMessage(PHYSICIAN_PHONE, 
      `🚨 ${urgency}\nPatient: ${phone}\nGlucose: ${reading} mg/dL`);
  }
  
  return { critical, urgency };
}

// ========================================
// WEBHOOK
// ========================================

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    
    const from = msg.from;
    const messageType = msg.type;
    let text = '';
    let isVoiceMessage = false;
    
    console.log(`\n📨 Message from: ${from} (${messageType})`);
    
    if (messageType === 'text') {
      text = msg.text.body;
      
    } else if (messageType === 'audio') {
      isVoiceMessage = true;
      
      try {
        // ✅ Let Whisper auto-detect language (don't pass preference)
        text = await transcribeWhatsAppAudio(msg.audio.id);
        
        if (!text) {
          await sendWhatsAppMessage(from, "Couldn't hear clearly. Try text. 😊");
          return;
        }
        
        const patient = await Patient.findOne({ phone: from });
        if (patient) {
          await Patient.findOneAndUpdate(
            { phone: from },
            { $inc: { voiceMessagesCount: 1 } }
          );
        }
        
      } catch (error) {
        console.error('❌ Transcription failed:', error.message);
        
        // ✅ IMPROVED: Better error messages for credit issues
        if (error.message.includes('credits') || error.message.includes('insufficient_quota')) {
          await sendWhatsAppMessage(from, 
            "🎙️ Voice feature temporarily unavailable.\n\n" +
            "💡 Tip: Add OpenAI credits to enable voice!\n\n" +
            "Please send text for now. 😊");
        } else {
          await sendWhatsAppMessage(from, "Voice error. Please send text. 😊");
        }
        return;
      }
      
    } else {
      console.log(`⚠️  Unsupported type: ${messageType}`);
      return;
    }
    
    // ========================================
    // 📝 PREPARE TEXT FOR PROCESSING
    // ========================================
    const lowerText = text.toLowerCase().trim();
    
    // ========================================
    // 🌐 LANGUAGE SWITCH COMMANDS
    // ========================================
    if (lowerText === 'hindi' || lowerText === 'हिंदी' || lowerText === 'switch to hindi') {
      console.log(`🌐 Manual switch to Hindi from ${from}`);
      
      await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'hi' });
      await sendWhatsAppMessage(from, 
        `✅ Language switched to Hindi!\n\n` +
        `Ab main Hinglish mein reply karunga. Aapka sugar reading bataiye! 😊`
      );
      return;
    }
    
    if (lowerText === 'kannada' || lowerText === 'ಕನ್ನಡ' || lowerText === 'switch to kannada') {
      console.log(`🌐 Manual switch to Kannada from ${from}`);
      
      await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'kn' });
      await sendWhatsAppMessage(from, 
        `✅ Language switched to Kannada!\n\n` +
        `Eeega naanu Kanglish nalli reply maadtini. Nimmadu sugar reading heli! 😊`
      );
      return;
    }
    
    if (lowerText === 'english' || lowerText === 'switch to english') {
      console.log(`🌐 Manual switch to English from ${from}`);
      
      await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'en' });
      await sendWhatsAppMessage(from, 
        `✅ Language switched to English!\n\n` +
        `I'll respond in English now. What's your sugar reading? 😊`
      );
      return;
    }
    
    // ========================================
    // 🔓 BYPASS COMMAND (Admin/Testing - Skip Onboarding)
    // ========================================
    if (lowerText === 'bypasssaad') {
      console.log(`🔓 BYPASS command from ${from}`);
      
      try {
        // Check if user already exists and is registered
        let patient = await Patient.findOne({ phone: from });
        
        if (patient && patient.onboarding_completed) {
          // Already registered and bypassed
          await sendWhatsAppMessage(from,
            `✅ Already bypassed!\n\n` +
            `You're all set. Send your glucose reading or ask anything! 😊`
          );
          return;
        }
        
        // Create minimal patient profile (bypass onboarding)
        patient = await Patient.findOneAndUpdate(
          { phone: from },
          {
            phone: from,
            language_pref: 'en',
            full_name: 'Test User',
            age: 30,
            gender: 'Male',
            emergency_contact: '+919999999999',
            pincode: '560001',
            consent_given: true,
            diabetes_type: 'Type 2',
            duration_years: 5,
            medication_type: 'Tablets',
            current_meds: ['Metformin'],
            comorbidities: ['None'],
            last_hba1c: null,
            diet_preference: 'Veg',
            onboarding_completed: true,
            onboarding_step: 'completed',
            registeredAt: new Date(),
            lastActive: new Date()
          },
          { upsert: true, new: true }
        );
        
        // Delete any incomplete onboarding state
        await OnboardingState.findOneAndDelete({ phone: from });
        
        console.log(`✅ Bypass complete for ${from} - created Test User profile`);
        
        await sendWhatsAppMessage(from,
          `🔓 BYPASS ACTIVATED!\n\n` +
          `✅ Onboarding skipped\n` +
          `✅ Test profile created\n` +
          `✅ Name: Test User\n\n` +
          `You can now chat directly! 💬\n\n` +
          `Try:\n` +
          `• "My sugar is 150"\n` +
          `• "Diet advice"\n` +
          `• "मेरा sugar 120 hai" (Hindi)\n\n` +
          `💡 Type "RESET" for normal registration.`
        );
        
        return;
        
      } catch (error) {
        console.error(`❌ Bypass error for ${from}:`, error.message);
        console.error(error.stack);
        await sendWhatsAppMessage(from, 
          `❌ Bypass failed: ${error.message}\n\nTry "RESET" instead.`
        );
        return;
      }
    }
    
    // ========================================
    // 🔄 RESET COMMAND (User Self-Reset)
    // ========================================
    if (lowerText === 'reset') {
      console.log(`🔄 RESET command from ${from}`);
      
      try {
        // Delete all user data
        await Patient.findOneAndDelete({ phone: from });
        await OnboardingState.findOneAndDelete({ phone: from });
        await GlucoseReading.deleteMany({ patientPhone: from });
        await Conversation.deleteMany({ patientPhone: from });
        await Triage.deleteMany({ patientPhone: from });
        
        // Create fresh onboarding state so next message is processed correctly
        await OnboardingState.create({
          phone: from,
          currentStep: 'language',
          data: new Map()
        });
        
        console.log(`✅ User reset complete: ${from}`);
        
        // ✅ Send confirmation and start fresh in ENGLISH
        await sendWhatsAppMessage(from, 
          `✅ Account reset complete!\n\n` +
          `All your data has been deleted.\n\n` +
          `Let's start fresh! 🎉\n\n` +
          MESSAGES.welcome.en
        );
        
        return; // Exit here, onboarding will continue with next message
      } catch (error) {
        console.error(`❌ Reset error for ${from}:`, error.message);
        await sendWhatsAppMessage(from, 
          `Sorry, reset failed. Please try again or contact support.`
        );
        return;
      }
    }
    
    // ========================================
    // 🎤 TTS TEST COMMANDS (Test different voice engines)
    // ========================================
    if (lowerText.startsWith('test voice') || lowerText.startsWith('test tts') || lowerText === 'test hindi voice') {
      console.log(`🎤 TTS TEST command from ${from}`);
      
      const testText = "Namaste! Mera naam Gluco Sahayak hai. Main aapki madad karunga.";
      
      try {
        await sendWhatsAppMessage(from, 
          `🎤 Testing NATIVE Hindi voice (gTTS)...\n\n` +
          `Text: "${testText}"\n\n` +
          `Wait for audio...`
        );
        
        const audioPath = await speakResponseGTTS(testText, 'hi');
        const mediaId = await uploadAudioToWhatsApp(audioPath);
        await sendVoiceMessage(from, mediaId);
        
        await sendWhatsAppMessage(from,
          `✅ That was gTTS (Native Hindi speaker)\n\n` +
          `Does it sound clear?\n\n` +
          `Reply:\n` +
          `• "test openai" - Try OpenAI (HD quality, accent)\n` +
          `• "YES" - Keep this voice`
        );
        
        return;
      } catch (error) {
        console.error('❌ TTS test error:', error.message);
        await sendWhatsAppMessage(from, 
          `❌ Test failed: ${error.message}`
        );
        return;
      }
    }
    
    if (lowerText.startsWith('test openai') || lowerText === 'test english voice') {
      console.log(`🎤 OpenAI TTS TEST command from ${from}`);
      
      const testText = "Namaste! Mera naam Gluco Sahayak hai. Main aapki madad karunga.";
      
      try {
        await sendWhatsAppMessage(from, 
          `🎤 Testing OpenAI TTS...\n\n` +
          `Wait for audio...`
        );
        
        const audioPath = await speakResponseOpenAI(testText, 'hi');
        const mediaId = await uploadAudioToWhatsApp(audioPath);
        await sendVoiceMessage(from, mediaId);
        
        await sendWhatsAppMessage(from,
          `✅ That was OpenAI TTS (HD quality, English accent)\n\n` +
          `Reply "test voice" to try native Hindi again`
        );
        
        return;
      } catch (error) {
        console.error('❌ OpenAI TTS test error:', error.message);
        await sendWhatsAppMessage(from, `❌ Test failed: ${error.message}`);
        return;
      }
    }
    
    // ========================================
    // 🌐 MANUAL LANGUAGE SWITCH COMMANDS
    // ========================================
    if (lowerText === 'english' || lowerText === 'eng') {
      const patient = await Patient.findOne({ phone: from });
      if (patient) {
        await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'en' });
        await sendWhatsAppMessage(from, 
          `✅ Language switched to English!\n\n` +
          `I'll now respond in English. 😊`
        );
        console.log(`🌐 Manual language switch: ${from} → English`);
        return;
      }
    }
    
    if (lowerText === 'hindi' || lowerText === 'हिंदी' || lowerText === 'hin') {
      const patient = await Patient.findOne({ phone: from });
      if (patient) {
        await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'hi' });
        await sendWhatsAppMessage(from, 
          `✅ Language Hinglish mein switch ho gaya!\n\n` +
          `Ab main Hinglish mein respond karunga. 😊`
        );
        console.log(`🌐 Manual language switch: ${from} → Hindi`);
        return;
      }
    }
    
    if (lowerText === 'kannada' || lowerText === 'ಕನ್ನಡ' || lowerText === 'kan') {
      const patient = await Patient.findOne({ phone: from });
      if (patient) {
        await Patient.findOneAndUpdate({ phone: from }, { language_pref: 'kn' });
        await sendWhatsAppMessage(from, 
          `✅ Language Kannada ge switch aayitu!\n\n` +
          `Naanu Kanglish nalli respond maadthini. 😊`
        );
        console.log(`🌐 Manual language switch: ${from} → Kannada`);
        return;
      }
    }
    
    // ========================================
    // 🆕 START COMMAND (Restart Onboarding)
    // ========================================
    if (lowerText === 'start' || lowerText === 'begin') {
      console.log(`🆕 START command from ${from}`);
      
      // Check if user already exists
      const existingPatient = await Patient.findOne({ phone: from });
      
      if (existingPatient && existingPatient.onboarding_completed) {
        // User already registered
        await sendWhatsAppMessage(from,
          `👋 Welcome back ${existingPatient.full_name}!\n\n` +
          `You're already registered.\n\n` +
          `Send your glucose reading or ask me anything! 😊\n\n` +
          `💡 Commands:\n` +
          `• Type "RESET" to delete all data\n` +
          `• Type "ENGLISH", "HINDI", or "KANNADA" to switch language`
        );
      } else {
        // ✅ New user or incomplete onboarding - show welcome in ENGLISH
        await sendWhatsAppMessage(from, MESSAGES.welcome.en);
      }
      
      return;
    }
    
    // ========================================
    // ⚙️ SETUP COMMAND (Complete Profile for Emergency Users)
    // ========================================
    if (lowerText === 'setup') {
      console.log(`⚙️ SETUP command from ${from}`);
      
      // Check if user exists
      const existingPatient = await Patient.findOne({ phone: from });
      
      if (!existingPatient) {
        // ✅ New user - start normal onboarding in ENGLISH
        await sendWhatsAppMessage(from, MESSAGES.welcome.en);
        return;
      }
      
      if (existingPatient.onboarding_step === 'emergency_skip') {
        // User chose emergency before, now wants to complete setup
        console.log(`🔄 Emergency user ${from} starting full setup`);
        
        // Delete emergency profile
        await Patient.findOneAndDelete({ phone: from });
        await OnboardingState.findOneAndDelete({ phone: from });
        
        // ✅ ALWAYS start fresh onboarding in ENGLISH
        await sendWhatsAppMessage(from,
          `✅ Let's complete your profile!\n\n` +
          `This will help me give you better personalized care. 🩺\n\n` +
          MESSAGES.welcome.en
        );
        
        return;
        
      } else if (existingPatient.onboarding_completed) {
        // Already completed setup
        await sendWhatsAppMessage(from,
          `✅ Your profile is already complete!\n\n` +
          `Type "RESET" if you want to start over. 😊`
        );
        return;
        
      } else {
        // Incomplete onboarding - resume
        await sendWhatsAppMessage(from,
          `👋 Let's continue your registration!\n\n` +
          `Reply to the next question. 😊`
        );
        return;
      }
    }
    
    // CHECK ONBOARDING
    const onboardingStatus = await checkOnboardingStatus(from);
    
    if (onboardingStatus.needsOnboarding) {
      if (isVoiceMessage) {
        await sendWhatsAppMessage(from, 
          "👋 For registration, please send text. After setup, voice works! 😊");
        return;
      }
      
      const { response, completed } = await handleOnboarding(from, text);
      
      if (response && response.length > 0) {
        await sendWhatsAppMessage(from, response);
      } else {
        console.error('❌ Empty onboarding response!');
        await sendWhatsAppMessage(from, "Error. Type 'start' to restart.");
      }
      
      if (completed) {
        console.log(`✅ ${from} onboarding complete!`);
      }
      return;
    }
    
    // PROCESS WITH CLAUDE + RAG
    let patient = onboardingStatus.patient;
    
    // ========================================
    // 🌐 AUTO-DETECT AND UPDATE LANGUAGE
    // ========================================
    const detectedLang = detectLanguage(text);
    const currentLang = patient.language_pref || 'en';
    const currentScript = patient.script_pref || currentLang;
    
    console.log(`📝 Message: "${text.substring(0, 50)}..."`);
    console.log(`🌐 Current: ${currentScript}, Detected: ${detectedLang}`);
    
    // ALWAYS use detected script for this response
    const baseLang = detectedLang.replace('_pure', '');
    
    if (detectedLang !== currentScript) {
      // Update database for future messages
      await updateLanguagePreference(from, detectedLang, currentScript);
      
      // Update patient object for THIS response
      patient.language_pref = baseLang;
      patient.script_pref = detectedLang;
      
      console.log(`✅ Script switched: ${currentScript} → ${detectedLang}`);
      console.log(`🔥 RESPONDING IN: ${detectedLang.toUpperCase()}!`);
    } else {
      // Ensure script_pref is set for response
      patient.script_pref = detectedLang;
    }
    
    // Pass the updated patient object to Claude
    const reply = await analyzeWithClaudeRAG(from, text, patient);
    
    if (!reply || reply.length === 0) {
      console.error('❌ Empty Claude response!');
      await sendWhatsAppMessage(from, fallbackResponse(text));
      return;
    }
    
    // SEND RESPONSE
    if (isVoiceMessage && voiceEnabled) {
      const voiceLang = patient.script_pref || patient.language_pref || 'en';
      const success = await sendVoiceResponse(from, reply, voiceLang);
      if (!success) {
        await sendWhatsAppMessage(from, reply);
      }
    } else {
      await sendWhatsAppMessage(from, reply);
    }
    
    // PROCESS GLUCOSE
    const data = extractGlucose(text);
    if (data.hasReading) {
      const { critical, urgency } = await checkCritical(data.reading, data.readingType, from);
      
      await createTriageRecord(from, data.reading, data.symptoms, reply, []);
      await GlucoseReading.create({
        patientPhone: from,
        reading: data.reading,
        readingType: data.readingType,
        symptoms: data.symptoms,
        notes: data.notes,
        alertSent: critical
      });
      
      console.log(`✅ ${patient.full_name}: ${data.reading}mg/dL (${urgency})`);
    }
    
  } catch (e) {
    console.error('❌ Webhook error:', e.message);
  }
});

// ========================================
// ADMIN ENDPOINTS
// ========================================

app.post('/admin/reset-user', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    
    const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    
    await Patient.findOneAndDelete({ phone: formattedPhone });
    await OnboardingState.findOneAndDelete({ phone: formattedPhone });
    await GlucoseReading.deleteMany({ patientPhone: formattedPhone });
    await Conversation.deleteMany({ patientPhone: formattedPhone });
    await Triage.deleteMany({ patientPhone: formattedPhone });
    
    res.json({ success: true, message: 'User reset complete', phone: formattedPhone });
    console.log(`✅ Reset: ${formattedPhone}`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/user-status/:phone', async (req, res) => {
  try {
    const phone = req.params.phone.startsWith('+') ? req.params.phone : `+${req.params.phone}`;
    const patient = await Patient.findOne({ phone });
    const state = await OnboardingState.findOne({ phone });
    
    res.json({
      phone,
      exists: !!patient,
      onboarding_completed: patient?.onboarding_completed,
      current_step: state?.currentStep || patient?.onboarding_step,
      patient: patient ? {
        name: patient.full_name,
        age: patient.age,
        diabetes_type: patient.diabetes_type
      } : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// 📤 TEMPLATE MESSAGE ENDPOINTS
// ========================================

// Send template to single user
app.post('/admin/send-template', async (req, res) => {
  try {
    const { phone, templateName, languageCode, parameters } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const template = templateName || 'welcome_message'; // Default template
    const language = languageCode || 'en';
    const params = parameters || [];
    
    console.log(`📤 Admin sending template "${template}" to ${formattedPhone}`);
    
    const result = await sendTemplateMessage(
      formattedPhone,
      template,
      language,
      params
    );
    
    res.json({
      success: true,
      message: 'Template sent successfully',
      phone: formattedPhone,
      template,
      messageId: result.messages?.[0]?.id
    });
    
  } catch (error) {
    console.error('❌ Template send failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

// Send campaign to multiple users
app.post('/admin/send-campaign', async (req, res) => {
  try {
    const { users, templateName, languageCode } = req.body;
    
    if (!users || !Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: 'Users array required' });
    }
    
    const template = templateName || 'welcome_message';
    const language = languageCode || 'en';
    
    console.log(`📤 Starting campaign: ${users.length} users, template: ${template}`);
    
    const results = await sendCampaignToMultipleUsers(users, template, language);
    
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    
    res.json({
      success: true,
      message: 'Campaign completed',
      stats: {
        total: users.length,
        sent: successCount,
        failed: failedCount
      },
      results
    });
    
  } catch (error) {
    console.error('❌ Campaign failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/admin/health', async (req, res) => {
  try {
    const totalPatients = await Patient.countDocuments();
    const completed = await Patient.countDocuments({ onboarding_completed: true });
    const knowledgeCount = await MedicalKnowledge.countDocuments();
    
    res.json({
      status: 'healthy',
      timestamp: new Date(),
      claude: isClaudeAvailable,
      rag: ragSystemInitialized,
      voice: !!OPENAI_API_KEY,
      patients: { total: totalPatients, completed },
      knowledge: knowledgeCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/conversation/:phone', async (req, res) => {
  try {
    const phone = req.params.phone.startsWith('+') ? req.params.phone : `+${req.params.phone}`;
    const conversation = await Conversation.findOne({ patientPhone: phone });
    
    if (!conversation) {
      return res.json({
        phone,
        exists: false,
        message: 'No conversation history found'
      });
    }
    
    res.json({
      phone,
      exists: true,
      totalMessages: conversation.messages.length,
      lastActive: conversation.lastActive,
      messages: conversation.messages.map(m => ({
        role: m.role,
        content: m.content.substring(0, 200) + (m.content.length > 200 ? '...' : ''),
        timestamp: m.timestamp
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    version: '7.10.1-MODEL-FIX',
    onboarding: 'Simple & Fast (NO AI)',
    medical: 'Claude + RAG + FORCED Language',
    voice: 'OpenAI TTS (High Quality)',
    features: {
      onboarding: '✅ Reliable',
      medical_ai: '✅ Claude + RAG - SHORT responses',
      conversation_memory: '✅ Remembers context',
      voice_input: voiceEnabled ? '✅ Whisper STT' : '❌ Disabled',
      voice_output: voiceEnabled ? '✅ OpenAI TTS (clear)' : '❌ Disabled',
      multilang: '✅ EN/HI/KN + Auto-detect',
      language_switching: '✅ Auto-updates based on user language',
      language_forcing: '✅ FORCED Hinglish/Kanglish responses',
      response_style: '✅ Short & conversational (40-50 words)',
      triage: '✅ Automatic'
    }
  });
});

// ========================================
// SCHEDULED REMINDERS
// ========================================

cron.schedule('0 8 * * *', async () => {
  const patients = await Patient.find({ 
    'reminderPreferences.medication': true,
    onboarding_completed: true 
  });
  
  for (const p of patients) {
    const greeting = p.language_pref === 'hi' ? '🌅 Good morning' :
                     p.language_pref === 'kn' ? '🌅 Good morning' : '🌅 Good morning';
    await sendWhatsAppMessage(p.phone, `${greeting} ${p.full_name}! Time for meds & glucose check 😊`);
  }
});

cron.schedule('0 20 * * *', async () => {
  const patients = await Patient.find({ 
    'reminderPreferences.glucoseLogging': true,
    onboarding_completed: true 
  });
  
  for (const p of patients) {
    const today = await GlucoseReading.findOne({
      patientPhone: p.phone,
      timestamp: { $gte: new Date().setHours(0,0,0,0) }
    });
    
    if (!today) {
      const reminder = p.language_pref === 'hi' ? '🌙 Please log glucose!' :
                       p.language_pref === 'kn' ? '🌙 Glucose log!' : '🌙 Log your glucose!';
      await sendWhatsAppMessage(p.phone, reminder);
    }
  }
});

app.listen(PORT, () => console.log(`
╔════════════════════════════════════════╗
║  GLUCO SAHAYAK v7.10.1 - MODEL FIX!   ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                           ║
║  Onboarding: SETUP or EMERGENCY       ║
║  Medical: Claude + RAG                ║
║  Voice: OpenAI TTS (Normal Speed)     ║
║  Language: Script-Aware Responses     ║
╠════════════════════════════════════════╣
║  FIXED:                               ║
║    - Claude model string updated      ║
║    - Real error logging on init fail  ║
╚════════════════════════════════════════╝

PRODUCTION READY!
Process PDFs: POST /admin/process-pdfs
Reset user: POST /admin/reset-user
Send template: POST /admin/send-template
Send campaign: POST /admin/send-campaign
Status: GET /admin/health

Bot can now initiate conversations with templates!
`));
