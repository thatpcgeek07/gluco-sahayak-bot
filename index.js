import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "./models/User.js";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ===============================
// MongoDB Connection
// ===============================
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ===============================
// WhatsApp Config
// ===============================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ===============================
// Send WhatsApp Message
// ===============================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📤 Message sent to", to);
  } catch (error) {
    console.error("❌ Error sending message:", error.response?.data || error);
  }
}

// ===============================
// Webhook Verification (GET)
// ===============================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// ===============================
// Webhook Messages (POST)
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const message = entry?.changes?.[0]?.value?.messages?.[0];

    if (!message || message.type !== "text") {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text.body.trim().toUpperCase();

    console.log("📩 From:", from);
    console.log("💬 Text:", text);

    // Find or create user
    let user = await User.findOne({ phone: from });
    if (!user) {
      user = await User.create({ phone: from });
      console.log("🆕 New user created:", from);
    }

    let reply = "";

    // ===============================
    // BOT LOGIC
    // ===============================
    if (user.state === "NEW") {
      reply =
        "👋 Welcome to *Gluco Sahayak*!\n\n" +
        "I help you track sugar readings, reminders & healthy habits.\n\n" +
        "Reply *YES* to get started.";
    }

    else if (text === "YES") {
      user.state = "ACTIVE";
      await user.save();

      reply =
        "✅ You’re all set!\n\n" +
        "You can now:\n" +
        "• Track sugar readings\n" +
        "• Get reminders\n" +
        "• Ask for help\n\n" +
        "Type *HELP* anytime.";
    }

    else if (text === "HELP") {
      reply =
        "📖 *Gluco Sahayak Help*\n\n" +
        "Commands:\n" +
        "• YES – Activate bot\n" +
        "• HELP – Show this menu\n\n" +
        "More health features coming soon 💚";
    }

    else {
      reply =
        "🤖 I got your message!\n\n" +
        "Smart health tracking features are coming soon.\n\n" +
        "Type *HELP* to see options.";
    }

    await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.sendStatus(200);
  }
});

// ===============================
// Health Check
// ===============================
app.get("/", (req, res) => {
  res.send("Gluco Sahayak Bot is running 🚀");
});

// ===============================
// Start Server
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
