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
if (!ANTHROPIC_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set - using fallback responses');
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY not set - voice features disabled');

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
// VOICE MODULE (FREE - OpenAI Whisper + gTTS)
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
// MULTI-LANGUAGE MESSAGES (NO "NAMASTE")
// ========================================

const MESSAGES = {
  welcome: {
    en: `Hello! Welcome to Gluco Sahayak! 🙏

I am your personal diabetes health assistant.

First, select your language:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

Just type 1, 2, or 3`,
    hi: `Hello! Gluco Sahayak में आपका स्वागत है! 🙏

मैं आपका diabetes assistant हूं।

भाषा चुनें:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

1, 2, या 3 टाइप करें`,
    kn: `Hello! Gluco Sahayak ಗೆ ಸ್ವಾಗತ! 🙏

ನಾನು ನಿಮ್ಮ diabetes assistant.

ಭಾಷೆ ಆಯ್ಕೆ:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ ಕನ್ನಡ (Kannada)

1, 2, ಅಥವಾ 3 ಟೈಪ್ ಮಾಡಿ`
  },
  
  ask_name_age: {
    en: `Great! I'll help you in English/Hindi mix. 😊

Please tell me:
• Your Name
• Your Age

Example: "My name is Ramesh Kumar, age 55"`,
    hi: `बढ़िया! मैं English/Hindi mix में बात करूंगा। 😊

बताइए:
• आपका नाम (Name)
• उम्र (Age)

Example: "Mera naam Ramesh Kumar hai, umar 55"`,
    kn: `ಚೆನ್ನಾಗಿದೆ! English/Kannada mix. 😊

ದಯವಿಟ್ಟು ಹೇಳಿ:
• ನಿಮ್ಮ ಹೆಸರು (Name)
• ವಯಸ್ಸು (Age)

Example: "My name is Ramesh, age 55"`
  },
  
  ask_gender_emergency: {
    en: `Nice to meet you, {name}! 🤝

Please tell me:
• Are you Male or Female?
• Emergency contact number (family member)

Example: "Male, emergency number 9876543210"`,
    hi: `{name} ji, खुशी हुई! 🤝

बताइए:
• आप Male हैं या Female?
• Emergency contact number (परिवार)

Example: "Male, emergency number 9876543210"`,
    kn: `{name}, ಸಂತೋಷ! 🤝

ದಯವಿಟ್ಟು:
• ನೀವು Male/Female?
• Emergency contact

Example: "Male, emergency 9876543210"`
  },
  
  ask_pincode_consent: {
    en: `Thank you! 📝

Last basic info:
• Your area Pincode (6 digits)
• Do you consent for diabetes management help? (Yes/No)

Example: "Pincode 585104, Yes I consent"`,
    hi: `धन्यवाद! 📝

आखिरी basic जानकारी:
• Pincode (6 अंक)
• Diabetes manage करने की permission? (हां/नहीं)

Example: "Pincode 585104, haan consent"`,
    kn: `ಧನ್ಯವಾದ! 📝

ಕೊನೆಯ info:
• Pincode (6 ಅಂಕಿ)
• Diabetes manage permission? (Yes/No)

Example: "Pincode 585104, Yes"`
  },
  
  ask_diabetes_type: {
    en: `Perfect! Now about your diabetes. 🏥

What type do you have?
1️⃣ Type 2 (most common, tablets)
2️⃣ Type 1 (insulin from young age)
3️⃣ Gestational (pregnancy)
4️⃣ Don't know

Type the number.`,
    hi: `Perfect! अब diabetes के बारे में। 🏥

कौन सा type है?
1️⃣ Type 2 (common, tablets)
2️⃣ Type 1 (insulin)
3️⃣ Gestational (pregnancy)
4️⃣ पता नहीं

Number टाइप करें।`,
    kn: `ಸರಿ! ಈಗ diabetes ಬಗ್ಗೆ. 🏥

ಯಾವ type?
1️⃣ Type 2 (tablets)
2️⃣ Type 1 (insulin)
3️⃣ Gestational
4️⃣ ಗೊತ್ತಿಲ್ಲ

Number ಟೈಪ್.`
  },
  
  ask_duration: {
    en: `Got it. 📝

How many years have you had diabetes?

Example: "10 years" or "Just diagnosed"`,
    hi: `समझे। 📝

कितने साल से diabetes?

Example: "10 saal" या "Abhi naya"`,
    kn: `ಅರ್ಥವಾಯಿತು. 📝

ಎಷ್ಟು ವರ್ಷ diabetes?

Example: "10 years"`
  },
  
  ask_medication: {
    en: `Important! 💊

What medicine for diabetes?
1️⃣ Only Tablets
2️⃣ Only Insulin
3️⃣ Both
4️⃣ No medicine

Type number.`,
    hi: `Important! 💊

Diabetes medicine?
1️⃣ Tablets
2️⃣ Insulin
3️⃣ दोनों
4️⃣ कोई नहीं

Number टाइप करें।`,
    kn: `ಮುಖ್ಯ! 💊

Medicine?
1️⃣ Tablets
2️⃣ Insulin
3️⃣ ಎರಡೂ
4️⃣ ಇಲ್ಲ

Number ಟೈಪ್.`
  },
  
  ask_medicine_names: {
    en: `Good! Please TYPE the medicine names.

This is important for your safety!`,
    hi: `अच्छा! Medicine names TYPE करें।

Safety के लिए जरूरी!`,
    kn: `ಚೆನ್ನಾಗಿದೆ! Medicine names TYPE ಮಾಡಿ।

Safety ಗೆ ಮುಖ್ಯ!`
  },
  
  ask_comorbidities: {
    en: `Noted! ✅

Any other health issues?
• High BP
• High Cholesterol
• Heart problem
• Kidney problem

Example: "BP and Cholesterol" or "No, only diabetes"`,
    hi: `ठीक! ✅

और कोई problem?
• High BP
• Cholesterol
• दिल
• Kidney

Example: "BP aur Cholesterol" या "Nahi"`,
    kn: `ಸರಿ! ✅

ಇನ್ನೇನಾದರೂ?
• BP
• Cholesterol
• Heart
• Kidney

Example: "BP and Cholesterol"`
  },
  
  ask_hba1c: {
    en: `Thank you! 📊

Last HbA1c value?
(3-month sugar test)

Example: "8.5" or "Don't remember"`,
    hi: `धन्यवाद! 📊

Last HbA1c?
(3 महीने का test)

Example: "8.5" या "याद नहीं"`,
    kn: `ಧನ್ಯವಾದ! 📊

Last HbA1c?
(3 month test)

Example: "8.5"`
  },
  
  ask_diet: {
    en: `Almost done! 🍽️

What do you eat?
1️⃣ Vegetarian
2️⃣ Non-Vegetarian
3️⃣ Eggetarian

Type number.`,
    hi: `लगभग हो गया! 🍽️

क्या खाते हैं?
1️⃣ Veg
2️⃣ Non-Veg
3️⃣ Egg

Number टाइप करें।`,
    kn: `ಬಹುತೇಕ ಮುಗಿಯಿತು! 🍽️

ಏನು ತಿನ್ನುತ್ತೀರಿ?
1️⃣ Veg
2️⃣ Non-Veg
3️⃣ Egg

Number ಟೈಪ್.`
  },
  
  onboarding_complete: {
    en: `Perfect! ✅ Profile complete.

I will help you with:
📊 Glucose monitoring
💊 Medicine reminders
🍽️ Diet advice
🚨 Emergency alerts
🎙️ Voice support

What is your current sugar reading?
(Or just say "Hi" to chat)`,
    hi: `Perfect! ✅ Profile complete.

मैं मदद करूंगा:
📊 Glucose monitoring
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice support

Current sugar reading?
(या "Hi" बोलें)`,
    kn: `Perfect! ✅ Profile complete.

ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ:
📊 Glucose monitoring
💊 Medicine reminder
🍽️ Diet advice
🚨 Emergency alert
🎙️ Voice support

Current sugar reading?
("Hi" ಹೇಳಿ)`
  }
};

// ========================================
// ONBOARDING SYSTEM (FIXED)
// ========================================

async function handleOnboarding(phone, message, messageType = 'text', mediaData = null) {
  try {
    let state = await OnboardingState.findOne({ phone });
    
    // CRITICAL FIX: New user gets welcome immediately
    if (!state) {
      state = await OnboardingState.create({
        phone,
        currentStep: 'language',
        data: new Map()
      });
      
      console.log(`🆕 New user: ${phone}`);
      return { response: MESSAGES.welcome.en, completed: false };
    }

    const lower = message.toLowerCase();
    let response = '';
    let nextStep = state.currentStep;
    let lang = state.data.get('language_pref') || 'en';

    switch (state.currentStep) {
      case 'language':
        if (lower.includes('1') || lower.includes('english')) {
          lang = 'en';
        } else if (lower.includes('2') || lower.includes('hindi') || lower.includes('हिंदी')) {
          lang = 'hi';
        } else if (lower.includes('3') || lower.includes('kannada') || lower.includes('ಕನ್ನಡ')) {
          lang = 'kn';
        }
        
        state.data.set('language_pref', lang);
        nextStep = 'name_age';
        response = MESSAGES.ask_name_age[lang];
        break;

      case 'name_age':
        const nameAgeMatch = message.match(/(?:name|naam|ನಾನು|ಹೆಸರು)[\s:]*([a-zA-Z\s]+)[\s,]+(?:age|umar|ವಯಸ್ಸು|years?)[\s:]*(\d+)/i);
        
        if (nameAgeMatch) {
          state.data.set('full_name', nameAgeMatch[1].trim());
          state.data.set('age', parseInt(nameAgeMatch[2]));
          
          nextStep = 'gender_emergency';
          const name = nameAgeMatch[1].trim().split(' ')[0];
          response = MESSAGES.ask_gender_emergency[lang].replace('{name}', name);
        } else {
          response = "Please tell me: Name and Age\nExample: 'My name is Ramesh, age 55'";
        }
        break;

      case 'gender_emergency':
        let gender = null;
        if (lower.includes('male') || lower.includes('पुरुष')) gender = 'Male';
        if (lower.includes('female') || lower.includes('महिला')) gender = 'Female';
        
        const phoneMatch = message.match(/(\d{10})/);
        
        if (gender && phoneMatch) {
          state.data.set('gender', gender);
          state.data.set('emergency_contact', '+91' + phoneMatch[1]);
          
          nextStep = 'pincode_consent';
          response = MESSAGES.ask_pincode_consent[lang];
        } else {
          response = "Please: Gender (Male/Female) and Emergency contact (10 digits)";
        }
        break;

      case 'pincode_consent':
        const pincodeMatch = message.match(/(\d{6})/);
        const hasConsent = lower.includes('yes') || lower.includes('हां') || lower.includes('ha') || 
                          lower.includes('consent') || lower.includes('ಹೌದು');
        
        if (pincodeMatch && hasConsent) {
          state.data.set('pincode', pincodeMatch[1]);
          state.data.set('consent_given', true);
          
          nextStep = 'diabetes_type';
          response = MESSAGES.ask_diabetes_type[lang];
        } else {
          response = "Please: Pincode (6 digits) and Yes/No for consent";
        }
        break;

      case 'diabetes_type':
        let diabetesType = 'Type 2';
        
        if (lower.includes('1') || lower.includes('type 1')) {
          diabetesType = 'Type 1';
        } else if (lower.includes('2') || lower.includes('type 2')) {
          diabetesType = 'Type 2';
        } else if (lower.includes('3') || lower.includes('gestational')) {
          diabetesType = 'Gestational';
        }
        
        state.data.set('diabetes_type', diabetesType);
        nextStep = 'duration';
        response = MESSAGES.ask_duration[lang];
        break;

      case 'duration':
        const yearMatch = message.match(/(\d+)/);
        const duration = yearMatch ? parseInt(yearMatch[1]) : 0;
        
        state.data.set('duration_years', duration);
        nextStep = 'medication';
        response = MESSAGES.ask_medication[lang];
        break;

      case 'medication':
        let medType = 'Tablets';
        
        if (lower.includes('1') || lower.includes('tablet')) {
          medType = 'Tablets';
        } else if (lower.includes('2') || lower.includes('insulin')) {
          medType = 'Insulin';
        } else if (lower.includes('3') || lower.includes('both')) {
          medType = 'Both';
        } else if (lower.includes('4') || lower.includes('no')) {
          medType = 'None';
        }
        
        state.data.set('medication_type', medType);
        nextStep = 'medicine_names';
        response = MESSAGES.ask_medicine_names[lang];
        break;

      case 'medicine_names':
        const commonMeds = ['metformin', 'glimepiride', 'glyburide', 'insulin', 'glargine', 'lispro', 'sitagliptin', 'dapagliflozin'];
        const foundMeds = [];
        
        commonMeds.forEach(med => {
          if (lower.includes(med)) {
            foundMeds.push(med.charAt(0).toUpperCase() + med.slice(1));
          }
        });
        
        if (foundMeds.length > 0 || lower.includes('no medicine') || lower.includes('कोई नहीं')) {
          state.data.set('current_meds', foundMeds.length > 0 ? foundMeds : ['None']);
          nextStep = 'comorbidities';
          response = MESSAGES.ask_comorbidities[lang];
        } else {
          response = "Please tell me medicine names";
        }
        break;

      case 'comorbidities':
        const comorbidities = [];
        
        if (lower.includes('bp') || lower.includes('blood pressure') || lower.includes('hypertension')) {
          comorbidities.push('Hypertension');
        }
        if (lower.includes('cholesterol')) {
          comorbidities.push('High Cholesterol');
        }
        if (lower.includes('heart')) {
          comorbidities.push('Heart Disease');
        }
        if (lower.includes('kidney')) {
          comorbidities.push('Kidney Disease');
        }
        
        state.data.set('comorbidities', comorbidities.length > 0 ? comorbidities : ['None']);
        nextStep = 'hba1c';
        response = MESSAGES.ask_hba1c[lang];
        break;

      case 'hba1c':
        const hba1cMatch = message.match(/(\d+\.?\d*)/);
        
        if (hba1cMatch) {
          state.data.set('last_hba1c', parseFloat(hba1cMatch[1]));
        } else {
          state.data.set('last_hba1c', null);
        }
        
        nextStep = 'diet';
        response = MESSAGES.ask_diet[lang];
        break;

      case 'diet':
        let diet = 'Veg';
        
        if (lower.includes('1') || lower.includes('veg')) {
          diet = 'Veg';
        } else if (lower.includes('2') || lower.includes('non-veg')) {
          diet = 'Non-Veg';
        } else if (lower.includes('3') || lower.includes('egg')) {
          diet = 'Eggetarian';
        }
        
        state.data.set('diet_preference', diet);
        
        await savePatientData(phone, state.data);
        nextStep = 'completed';
        response = MESSAGES.onboarding_complete[lang];
        break;
    }

    state.currentStep = nextStep;
    state.lastUpdated = new Date();
    await state.save();

    return { response, completed: nextStep === 'completed' };

  } catch (error) {
    console.error('❌ Onboarding error:', error);
    return { 
      response: "Sorry, error. Type 'start' to begin again.",
      completed: false 
    };
  }
}

async function savePatientData(phone, dataMap) {
  try {
    const patientData = {
      phone,
      language_pref: dataMap.get('language_pref'),
      full_name: dataMap.get('full_name'),
      age: dataMap.get('age'),
      gender: dataMap.get('gender'),
      emergency_contact: dataMap.get('emergency_contact'),
      pincode: dataMap.get('pincode'),
      consent_given: dataMap.get('consent_given'),
      diabetes_type: dataMap.get('diabetes_type'),
      duration_years: dataMap.get('duration_years'),
      medication_type: dataMap.get('medication_type'),
      current_meds: dataMap.get('current_meds'),
      comorbidities: dataMap.get('comorbidities'),
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

    // DELETE onboarding state after completion
    await OnboardingState.findOneAndDelete({ phone });

    console.log(`✅ Patient saved: ${patientData.full_name}`);
  } catch (error) {
    console.error('❌ Save error:', error);
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
// PDF PROCESSING (RAG SYSTEM - FIXED)
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
// CLAUDE AI (FIXED - ACTUALLY USES RAG!)
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
    await axios.post(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    }, { 
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 10000
    });
    console.log(`✅ Message sent to ${to}`);
  } catch (e) {
    console.error('❌ Send failed:', e.message);
  }
}

function fallbackResponse(msg) {
  const lower = msg.toLowerCase().trim();
  const num = msg.match(/(\d{2,3})/);
  const glucose = num ? parseInt(num[1]) : null;
  
  // ONLY greet if user EXPLICITLY says just "hi" or "hello" - nothing else
  if (lower === 'hi' || lower === 'hello' || lower === 'hey') {
    return `Hello! 🏥 Gluco Sahayak\n\n📊 Send: "My sugar is 120"\n🍽️ Ask: "Diet advice"\n🎙️ Use voice messages`;
  }
  
  // For glucose readings - NO GREETING, just direct feedback
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
  
  // For other questions - NO GREETING, just helpful response
  return `I can help with:\n📊 Glucose tracking\n🍽️ Diet advice\n💊 Medication guidance\n🎙️ Voice messages`;
}

async function analyzeWithClaudeRAG(phone, msg, patient) {
  if (!isClaudeAvailable) {
    console.log('⚠️  Using fallback (Claude unavailable)');
    return fallbackResponse(msg);
  }

  try {
    // CRITICAL: Actually retrieve medical knowledge!
    const medicalContext = ragSystemInitialized 
      ? await retrieveMedicalKnowledge(msg, 5)
      : [];
    
    console.log(`📚 Retrieved ${medicalContext.length} medical references`);
    
    const readings = await GlucoseReading.find({ patientPhone: phone })
      .sort({ timestamp: -1 }).limit(10);

    // Build references properly
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
- Recent: ${readings.slice(0, 5).map(r => `${r.reading}mg/dL`).join(', ') || 'No data'}
`;

    const system = `You are Gluco Sahayak, medical diabetes assistant.

CRITICAL RULES:
1. ALWAYS use medical textbook excerpts below
2. ALWAYS cite source [Reference Name]
3. Address patient by name
4. Consider FULL patient profile
5. Personalize for meds/comorbidities/diet
6. Indian context (roti, dal, walk)
7. Max 150 words
8. NEVER EVER start with greetings - NO "Hello", NO "Hi", NO "Namaste", NO "Good morning" - START DIRECTLY WITH THE MEDICAL ADVICE

WRONG (DO NOT DO THIS):
"Hello! Your sugar is..."
"Hi Rajesh! Let me help..."
"Namaste! 180 is..."

CORRECT (DO THIS):
"Rajesh ji, 180 is elevated..."
"Your reading of 120 is good..."
"For Type 2 diabetes..."

MEDICAL TEXTBOOK EXCERPTS:
${references}

${patientProfile}

User: "${msg}"

IMPORTANT: Start your response DIRECTLY with the patient's name and medical advice. NO GREETING WORDS AT ALL.`;

    const response = await axios.post(CLAUDE_API_URL, {
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: msg }]
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
      console.log(`✅ Claude + RAG (${medicalContext.length} refs used)`);
      
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
// WEBHOOK (FIXED - VOICE + ONBOARDING + RAG)
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
    let mediaData = null;
    let isVoiceMessage = false;

    // Handle message types
    if (messageType === 'text') {
      text = msg.text.body;
      
    } else if (messageType === 'image') {
      text = msg.image.caption || '';
      mediaData = { id: msg.image.id, mime_type: msg.image.mime_type };
      
    } else if (messageType === 'audio') {
      isVoiceMessage = true;
      
      console.log(`🎙️  Voice from ${from}`);
      
      const patient = await Patient.findOne({ phone: from });
      const langCode = patient?.language_pref || 'en';
      
      try {
        text = await transcribeWhatsAppAudio(msg.audio.id, langCode);
        
        if (!text) {
          await sendWhatsAppMessage(from, "Couldn't hear clearly. Try text. 😊");
          return;
        }
        
        console.log(`👂 Transcribed: "${text}"`);
        
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
      return;
    }

    // Check onboarding
    const onboardingStatus = await checkOnboardingStatus(from);

    if (onboardingStatus.needsOnboarding) {
      if (isVoiceMessage) {
        await sendWhatsAppMessage(from, 
          "👋 For registration, please send text. After setup, voice works! 😊");
        return;
      }
      
      const { response, completed } = await handleOnboarding(from, text, messageType, mediaData);
      await sendWhatsAppMessage(from, response);
      
      if (completed) {
        console.log(`✅ ${from} onboarding complete`);
      }
      return;
    }

    // Process with Claude + RAG + Patient Context
    const patient = onboardingStatus.patient;
    const reply = await analyzeWithClaudeRAG(from, text, patient);

    // Respond (voice or text)
    if (isVoiceMessage && voiceEnabled && OPENAI_API_KEY) {
      console.log(`🗣️  Sending voice response...`);
      
      const success = await sendVoiceResponse(
        from,
        reply,
        patient.language_pref || 'en'
      );
      
      if (!success) {
        await sendWhatsAppMessage(from, reply);
      }
      
    } else {
      await sendWhatsAppMessage(from, reply);
    }

    // Process glucose
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
    console.log(`✅ Reset complete: ${formattedPhone}`);
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

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    version: '5.0.0-FINAL',
    ai: isClaudeAvailable ? 'Claude Sonnet 4' : 'fallback',
    rag: ragSystemInitialized ? `ready` : 'call /admin/process-pdfs',
    voice: OPENAI_API_KEY ? 'enabled (FREE)' : 'disabled',
    features: ['Onboarding', 'RAG', 'Voice', 'Multi-lang', 'Patient Context']
  });
});

// ========================================
// SCHEDULED REMINDERS (NO "NAMASTE")
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
║  GLUCO SAHAYAK v5.0 FINAL             ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                           ║
║  Claude: ${isClaudeAvailable ? '✅' : '⚠️ '}                          ║
║  RAG: ${ragSystemInitialized ? '✅' : '⚠️ '}                             ║
║  Voice: ${OPENAI_API_KEY ? '✅ FREE' : '❌'}                      ║
╠════════════════════════════════════════╣
║  FEATURES:                            ║
║    ✅ Onboarding (FIXED)              ║
║    ✅ Voice (Whisper + gTTS)          ║
║    ✅ RAG (Actually working!)         ║
║    ✅ Patient Context                 ║
║    ✅ Multi-language                  ║
║    ✅ No "Namaste"                    ║
║    ✅ No repeated greetings           ║
║    ✅ Admin endpoints                 ║
╚════════════════════════════════════════╝

🎉 PRODUCTION READY!
📝 Process PDFs: POST /admin/process-pdfs
🔧 Reset user: POST /admin/reset-user
📊 Status: GET /admin/health
`));
