/**
 * PocketScout SMS Server
 * Stack: Node.js + Express + Twilio + Anthropic Claude
 *
 * Setup:
 *   npm install express twilio @anthropic-ai/sdk dotenv
 *
 * .env file:
 *   ANTHROPIC_API_KEY=your_key
 *   TWILIO_ACCOUNT_SID=your_sid
 *   TWILIO_AUTH_TOKEN=your_token
 *   TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
 *   PORT=3000
 */

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded POST
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory conversation store (swap for Redis/DB in production) ───────────
const conversations = new Map();
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;      // sweep every 15 minutes

function getHistory(phoneNumber) {
  const entry = conversations.get(phoneNumber);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phoneNumber);
    return [];
  }
  return entry.messages;
}

function saveHistory(phoneNumber, messages) {
  conversations.set(phoneNumber, { messages, updatedAt: Date.now() });
}

// Active cleanup — removes conversations idle for 3+ hours every 15 minutes.
// Without this, users who never text again would linger in memory indefinitely.
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [phone, entry] of conversations.entries()) {
    if (now - entry.updatedAt > CONVERSATION_TTL_MS) {
      conversations.delete(phone);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🧹 Cleanup swept ${removed} expired conversation(s). Active: ${conversations.size}`);
  }
}, CLEANUP_INTERVAL_MS);

// ─── PocketScout System Prompt ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are PocketScout, a friendly and efficient AI deal-finding assistant that operates over SMS for Canadians. Your personality is warm, locally-focused, and community-minded.

## Scout Tier Logic — always use this hierarchy:

**Tier 1 — THE LOCAL HERO 🏪**
Small, independent local businesses within 5-10km of the user. Prioritize these even if the price is slightly higher. Frame it as "keeping dollars in the community." Make up realistic, plausible local shop names if needed.

**Tier 2 — THE GREAT CANADIAN 🍁**
Canadian-owned brands or national Canadian retailers: Canadian Tire, Sport Chek, Atmosphere, MEC, Sobeys, Loblaws, Winners, HomeSense, Indigo, etc. Or Canadian-made brands (Kaizen Naturals, Genuine Health, etc.)

**Tier 3 — THE BEST DEAL 💻**
Lowest price found anywhere — including Amazon.ca, Walmart.ca, Costco.ca, Best Buy Canada, eBay, or any online retailer. This is the "bottom line" option.

## Response Rules for SMS:
- Keep each SMS under 160 characters when possible (hard limit for standard SMS)
- Use the ---SMS--- separator between messages — the server will send them as separate texts with a 1-second delay between each
- Maximum 3 SMS messages per response
- Use light emoji (🏪 🍁 💻 ✅ 📍) — they render well on SMS
- Never make up exact real prices as facts — frame as "typically around" or "est."
- Always ask for the city/neighborhood if not provided
- For recipe requests, list the top 3-5 key ingredients and scout deals for them

## Clarification Flow:
If the user's request is missing city/product details, ask 1-2 short clarifying questions before scouting.

## Selection Flow (when user replies "1", "2", or "3"):
Send back the address (real or plausible), a tip about the store, and a "Scout Discount" mention for local picks.

## Format Example:
Scouted 3 deals for vanilla whey (5lb) in Calgary! 🔍

🏪 LOCAL: $58 at YYC Supplements (local gym owner!)
🍁 CANADIAN: $62 at Sobeys — Kaizen Naturals brand
💻 BEST DEAL: $49 at Costco.ca

Reply 1, 2, or 3 for address + details!
---SMS---
Tip: Local shops often price-match if you show them the Costco price 💡`;

// ─── Claude API Call ───────────────────────────────────────────────────────────
async function askClaude(userPhone, userMessage) {
  const history = getHistory(userPhone);

  history.push({ role: "user", content: userMessage });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  history.push({ role: "assistant", content: assistantText });
  saveHistory(userPhone, history);

  // Split into individual SMS parts
  const smsParts = assistantText
    .split("---SMS---")
    .map((s) => s.trim())
    .filter(Boolean);

  return smsParts;
}

// ─── Send SMS via Twilio ────────────────────────────────────────────────────────
async function sendSms(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
}

// ─── Twilio Webhook — incoming SMS ────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  // Respond immediately so Twilio doesn't retry
  res.status(200).send("<Response></Response>");

  const fromNumber = req.body.From;
  const incomingMsg = (req.body.Body || "").trim();

  if (!fromNumber || !incomingMsg) return;

  console.log(`📱 [${fromNumber}] → "${incomingMsg}"`);

  try {
    const smsParts = await askClaude(fromNumber, incomingMsg);

    // Send parts sequentially with 1s delay between each
    for (let i = 0; i < smsParts.length; i++) {
      if (i > 0) await sleep(1000);
      await sendSms(fromNumber, smsParts[i]);
      console.log(`✉️  [${fromNumber}] ← SMS ${i + 1}/${smsParts.length}`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    await sendSms(
      fromNumber,
      "Scout is taking a break! Try again in a moment. 🔍"
    );
  }
});

// ─── Health check endpoint ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout",
    activeConversations: conversations.size,
  });
});

// ─── Admin: clear a conversation ───────────────────────────────────────────────
app.delete("/conversation/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  conversations.delete(phone);
  res.json({ cleared: phone });
});

// ─── Start ──────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║  🔍 PocketScout SMS Server       ║
  ║  Listening on port ${PORT}          ║
  ║  POST /sms  → Twilio webhook     ║
  ║  GET  /health → status check     ║
  ╚══════════════════════════════════╝
  `);
});
