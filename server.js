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
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
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
    console.log(`👂 Transcribing with Whisper (${language})...`);
    
    if (!OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set');
    }
    
    const audioFilePath = await downloadWhatsAppAudio(mediaId);
    
    const form = new FormData();
    form.append('file', fs.createReadStream(audioFilePath));
    form.append('model', 'whisper-1');
    
    const languageMap = { 'en': 'en', 'hi': 'hi', 'kn': 'kn' };
    form.append('language', languageMap[language] || 'en');
    
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
    
    if (error.response?.status === 401) {
      throw new Error('Invalid OpenAI API key');
    }
    
    throw new Error('Transcription failed');
  }
}

async function speakResponse(text, language = 'en') {
  return new Promise((resolve, reject) => {
    try {
      console.log(`🗣️  Generating speech (${language})...`);
      
      const langMap = { 'en': 'en', 'hi': 'hi', 'kn': 'kn' };
      const lang = langMap[language] || 'en';
      
      const gttsInstance = new gtts(text, lang);
      
      const tempDir = '/tmp/whatsapp-tts';
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const timestamp = Date.now();
      const fileName = `tts_${language}_${timestamp}.mp3`;
      const filePath = path.join(tempDir, fileName);
      
      gttsInstance.save(filePath, (err) => {
        if (err) {
          console.error('❌ TTS error:', err);
          reject(new Error('Failed to generate speech'));
          return;
        }
        
        console.log(`✅ Speech generated`);
        resolve(filePath);
      });
    } catch (error) {
      console.error('❌ TTS error:', error.message);
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

Ready to start! What's your current glucose reading?`,
    hi: `✅ हो गया {name} जी!

Profile तैयार! 🎉

मैं मदद करूंगा:
📊 Glucose tracking
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice messages

तैयार! Current glucose reading?`,
    kn: `✅ ಮುಗಿಯಿತು {name}!

Profile ready! 🎉

ನಾನು ಸಹಾಯ:
📊 Glucose tracking
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice messages

ತಯಾರು! Current glucose reading?`
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
// RELIABLE ONBOARDING HANDLER
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
          nextStep = 'name';
          response = MESSAGES.ask_name[parsedLang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.welcome[lang];
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
          nextStep = 'name';
          response = MESSAGES.ask_name[parsedLang];
        } else {
          response = MESSAGES.error_retry[lang] + '\n\n' + MESSAGES.welcome[lang];
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

    // ✅ ✅ ✅ THIS IS THE CRITICAL FIX ✅ ✅ ✅
    // Don't try to save state if onboarding is completed
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
        
    return { response, completed: nextStep === 'completed' };
  
  } catch (error) {
    console.error('❌ Onboarding error:', error.message);
    console.error(error.stack);
        
    return {
      response: "Sorry, an error occurred. Please type 'start' to begin again.",
      completed: false
    };
  }
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

    // Save state
    state.currentStep = nextStep;
    state.lastUpdated = new Date();
    await state.save();
    
    console.log(`✅ Step: ${state.currentStep} → Response: ${response.length} chars`);
    
    return { response, completed: nextStep === 'completed' };

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

    if (response.data?.content?.[0]?.text) {
      isClaudeAvailable = true;
      console.log('✅ Claude Sonnet 4 ready');
      return true;
    }
  } catch (error) {
    console.error('❌ Claude init failed');
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

function fallbackResponse(msg) {
  const lower = msg.toLowerCase().trim();
  const num = msg.match(/(\d{2,3})/);
  const glucose = num ? parseInt(num[1]) : null;
  
  if (lower === 'hi' || lower === 'hello' || lower === 'hey') {
    return `Hello! 🏥 Gluco Sahayak\n\n📊 Send: "My sugar is 120"\n🍽️ Ask: "Diet advice"\n🎙️ Use voice messages`;
  }
  
  if (glucose && glucose >= 40 && glucose <= 500) {
    let r = `Reading: ${glucose} mg/dL\n\n`;
    
    if (glucose < 54) r += `🚨🚨 EMERGENCY! Eat 15g carbs NOW!`;
    else if (glucose < 70) r += `🚨 LOW! Eat 15g fast carbs.`;
    else if (glucose <= 100) r += `✅ EXCELLENT! Normal 👏`;
    else if (glucose <= 125) r += `⚠️ Slightly elevated. Watch diet.`;
    else if (glucose <= 180) r += `⚠️ ELEVATED. Review diet.`;
    else if (glucose <= 250) r += `🚨 HIGH! Water, walk, recheck.`;
    else if (glucose <= 400) r += `🚨🚨 SEVERE! Contact doctor!`;
    else r += `🚨🚨🚨 CRITICAL! Go to ER!`;
    
    return r;
  }
  
  return `I can help with:\n📊 Glucose tracking\n🍽️ Diet advice\n💊 Medication guidance\n🎙️ Voice messages`;
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

    const system = `You are Gluco Sahayak, medical diabetes assistant.

CRITICAL RULES FOR CONVERSATION MEMORY:
1. 🧠 REMEMBER EVERYTHING from conversation history - this is MANDATORY
2. 🚫 NEVER repeat recommendations already given
3. 🔄 BUILD ON previous discussion - reference what patient told you
4. ✅ If patient mentions equipment (pump, CGM) - ACKNOWLEDGE IT in all future responses
5. ✅ If patient provides updates (weight change, new symptoms) - UPDATE your advice
6. 🕐 DISTINGUISH between TODAY vs YESTERDAY vs LAST WEEK readings
7. ⚠️ Don't alarm about old readings - focus on current status

EXAMPLE - CORRECT BEHAVIOR:
User: "I'm on insulin pump"
Assistant: [acknowledges pump]
User: "I gained weight"
Assistant: "Given your insulin pump settings and weight gain..." ✅

EXAMPLE - WRONG BEHAVIOR:
User: "I'm on insulin pump"  
Assistant: [acknowledges pump]
User: "I gained weight"
Assistant: "You need to start insulin therapy" ❌ WRONG - they already have pump!

MEDICAL GUIDANCE:
8. ALWAYS use medical textbook excerpts below
9. ALWAYS cite source [Reference Name]
10. Address patient by name
11. Consider FULL patient profile AND conversation history
12. Personalize for meds/comorbidities/diet
13. Indian context (roti, dal, walk)
14. Max 150 words
15. NEVER start with greetings - START DIRECTLY with medical advice

MEDICAL TEXTBOOK EXCERPTS:
${references}

${patientProfile}

REMEMBER: You have access to the full conversation history. Use it to provide contextual, personalized advice that builds on what you already know about the patient.

START DIRECTLY with patient's name and medical advice. NO greetings.`;

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
      max_tokens: 600,
      system,
      messages: conversationHistory  // ✅ NOW INCLUDES HISTORY!
    }, {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 20000
    });

    const text = response.data?.content?.[0]?.text;
    
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
    console.error('❌ Claude error:', e.message);
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
      
      const patient = await Patient.findOne({ phone: from });
      const langCode = patient?.language_pref || 'en';
      
      try {
        text = await transcribeWhatsAppAudio(msg.audio.id, langCode);
        
        if (!text) {
          await sendWhatsAppMessage(from, "Couldn't hear clearly. Try text. 😊");
          return;
        }
        
        if (patient) {
          await Patient.findOneAndUpdate(
            { phone: from },
            { $inc: { voiceMessagesCount: 1 } }
          );
        }
        
      } catch (error) {
        console.error('❌ Transcription failed:', error.message);
        await sendWhatsAppMessage(from, "Voice error. Please send text. 😊");
        return;
      }
      
    } else {
      console.log(`⚠️  Unsupported type: ${messageType}`);
      return;
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
    const patient = onboardingStatus.patient;
    const reply = await analyzeWithClaudeRAG(from, text, patient);

    if (!reply || reply.length === 0) {
      console.error('❌ Empty Claude response!');
      await sendWhatsAppMessage(from, fallbackResponse(text));
      return;
    }

    // SEND RESPONSE
    if (isVoiceMessage && voiceEnabled) {
      const success = await sendVoiceResponse(from, reply, patient.language_pref || 'en');
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
    version: '7.1.0-MEMORY',
    onboarding: 'Simple & Fast (NO AI)',
    medical: 'Claude + RAG + Conversation Memory',
    voice: OPENAI_API_KEY ? 'enabled' : 'disabled',
    features: {
      onboarding: '✅ Reliable (no AI dependency)',
      medical_ai: '✅ Claude + RAG',
      conversation_memory: '✅ Remembers context',
      voice: voiceEnabled ? '✅ Enabled' : '❌ Disabled',
      multilang: '✅ EN/HI/KN',
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
║  GLUCO SAHAYAK v7.0 - RELIABLE        ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                           ║
║  🚀 Onboarding: SIMPLE (No AI)        ║
║  🤖 Medical: Claude + RAG             ║
║  🎙️  Voice: ${OPENAI_API_KEY ? '✅' : '❌'}                      ║
╠════════════════════════════════════════╣
║  IMPROVEMENTS:                        ║
║    ✅ Zero AI dependency onboarding   ║
║    ✅ Fast, reliable responses        ║
║    ✅ One question at a time          ║
║    ✅ Flexible input parsing          ║
║    ✅ Can't fail                      ║
║    💡 AI only for medical queries     ║
╚════════════════════════════════════════╝

🎉 PRODUCTION READY!
📝 Process PDFs: POST /admin/process-pdfs
🔧 Reset user: POST /admin/reset-user
📊 Status: GET /admin/health
`));
