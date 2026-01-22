import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// ======================
// CONFIG
// ======================
const VERIFY_TOKEN = "gluco_sahayak_verify";

// In-memory user storage
const userState = {};

// ======================
// HELPERS
// ======================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Message sent to", to);
  } catch (error) {
    console.error("❌ Send error:", error.response?.data || error.message);
  }
}

function getTimestamp() {
  return new Date().toLocaleString("en-IN", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

// ======================
// WEBHOOK VERIFICATION
// ======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ======================
// RECEIVE MESSAGES
// ======================
app.post("/webhook", async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (message && message.text) {
    const from = message.from;
    const rawText = message.text.body.trim();
    const text = rawText.toUpperCase();

    console.log("📩 From:", from);
    console.log("💬 Text:", rawText);

    // Init user
    if (!userState[from]) {
      userState[from] = { step: "NEW", readings: [] };
    }

    const user = userState[from];

    // START
    if (text === "START" && user.step === "NEW") {
      user.step = "CONSENT";
      await sendMessage(
        from,
        "Hi 👋 I’m *Gluco Sahayak*.\n\nI help you track blood sugar readings and reminders.\n\nDo you agree to share health-related data for tracking purposes?\n\nReply *YES* to continue or *NO* to exit."
      );
    }

    // CONSENT YES
    else if (text === "YES" && user.step === "CONSENT") {
      user.step = "ACTIVE";
      await sendMessage(
        from,
        "✅ Thank you.\n\nYou can now send readings like:\n\n• FASTING 110\n• PP 145\n• RANDOM 180\n\nType *HELP* anytime."
      );
    }

    // CONSENT NO
    else if (text === "NO" && user.step === "CONSENT") {
      user.step = "EXITED";
      await sendMessage(
        from,
        "No problem 👍\nIf you change your mind, type *START* anytime.\nTake care!"
      );
    }

    // HELP
    else if (text === "HELP" && user.step === "ACTIVE") {
      await sendMessage(
        from,
        "📋 *Gluco Sahayak Commands*\n\n• FASTING 110\n• PP 145\n• RANDOM 180\n• HISTORY\n• STOP"
      );
    }

    // HISTORY
    else if (text === "HISTORY" && user.step === "ACTIVE") {
      if (user.readings.length === 0) {
        await sendMessage(from, "No readings recorded yet.");
      } else {
        const last = user.readings
          .slice(-5)
          .map(r => `• ${r.type}: ${r.value} mg/dL (${r.time})`)
          .join("\n");

        await sendMessage(from, `📊 *Recent Readings*\n\n${last}`);
      }
    }

    // STOP
    else if (text === "STOP") {
      user.step = "EXITED";
      await sendMessage(
        from,
        "⏸️ Gluco Sahayak paused.\nType *START* anytime to resume."
      );
    }

    // SUGAR PARSER
    else if (user.step === "ACTIVE") {
      const parts = text.split(" ");
      const type = parts[0];
      const value = Number(parts[1]);

      if (
        ["FASTING", "PP", "RANDOM"].includes(type) &&
        !isNaN(value) &&
        value > 20 &&
        value < 600
      ) {
        user.readings.push({
          type,
          value,
          time: getTimestamp()
        });

        await sendMessage(
          from,
          `✅ Noted your *${type}* sugar: *${value} mg/dL*.\n\nIf you feel unwell, please consult your doctor.`
        );
      } else {
        await sendMessage(
          from,
          "❌ I couldn’t understand that.\n\nSend readings like:\nFASTING 110\nPP 145\nRANDOM 180"
        );
      }
    }

    // FALLBACK
    else {
      await sendMessage(
        from,
        "Type *START* to begin or *HELP* for options."
      );
    }
  }

  res.sendStatus(200);
});

// ======================
// HEALTH CHECK
// ======================
app.get("/", (req, res) => {
  res.send("Gluco Sahayak Bot is running");
});

// ======================
// START SERVER
// ======================
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
