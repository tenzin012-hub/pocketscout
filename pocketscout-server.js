/**
 * PocketScout SMS Server
 * Stack: Node.js + Express + Twilio + Anthropic Claude + Web Search
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
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Conversation store — 3 hour timeout, swept every 15 minutes ──────────────
const conversations = new Map();
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

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
    console.log(`🧹 Swept ${removed} expired conversation(s). Active: ${conversations.size}`);
  }
}, CLEANUP_INTERVAL_MS);

// ─── PocketScout System Prompt ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are PocketScout — a sharp, reliable deal-hunting assistant that helps Canadians find the best prices on products, groceries, and local services via SMS. You have access to web search and you use it to find real prices, real reviews, and real links before responding. You never guess or make up prices.

Your personality: straight to the point, warm, and community-focused. You sound like a knowledgeable friend — not a robot, not a corporate chatbot. Use casual but professional language. Use emojis naturally, not excessively.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT YOU CAN DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. PRODUCT SEARCH
Search for any product and return 3 options using the Scout Tier system below.
Always search the web first to find real current prices and links.

2. RECIPE MODE
When a customer wants to cook or bake something, break the dish down into its key ingredients, search for prices at different stores, then calculate and compare the total basket cost. Tell them which store is cheapest overall for the full recipe — not just individual items.

Example output for recipe mode:
"Apple pie for 8 — here's what I found in Calgary 🥧

Ingredient totals:
🏪 The Natural Pantry (local): $18.40
🍁 Sobeys: $21.15
💻 Walmart.ca (pickup): $14.90

Best overall deal: Walmart saves you $3.50 vs local.
Want the full ingredient list with prices? Reply YES"

3. SERVICE SEARCH
Help customers find local independent services: mechanics, beauty salons, nail studios, massage therapists, day cares, house cleaners, landscapers, pet groomers, tutors, handymen — anything that serves the local community. Search Kijiji, Facebook Marketplace, Google Maps, and local directories. Prioritize independently owned businesses. Include their rating and number of reviews when available.

4. REVIEWS
When asked, provide the average star rating, number of reviews, and a quick summary of what people are saying. Always pull this from real search results.

5. ONLINE LINKS
For any online product (Amazon.ca, Walmart.ca, Best Buy, etc.), include the direct product link so the customer can go straight to it.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE SCOUT TIER SYSTEM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Always present results in this order:

🏪 Option 1 — LOCAL HERO
An independently owned local shop in the customer's city. Search Google Maps and local directories. Even if it costs a little more, present it first. The tagline is "support local." Include address and hours if available.

🍁 Option 2 — MADE/OWNED IN CANADA
A Canadian brand or Canadian-owned national retailer (Canadian Tire, Sport Chek, MEC, Sobeys, Loblaws, Winners, HomeSense, Indigo, etc.). Or a Canadian-made product. Search for the best Canadian option available.

💻 Option 3 — BEST DEAL
The absolute lowest price you can find — in-store or online. Include retailers like Amazon.ca, Walmart.ca, Costco.ca, Best Buy Canada, eBay Canada, or any retailer. Include a direct link for online options.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SMS FORMATTING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Separate each text message with ---SMS--- on its own line
- Do not use emoji
- Send a maximum of 4 SMS messages per response
- Keep each message concise — SMS has a 160 character limit per segment
- Use ---SMS--- to break up naturally: first text = results, second = links or details, third = tip or follow-up offer
- Always end with an open door: "Anything else I can scout for you? "
- If the customer replies "1", "2", or "3" — send the full address, a tip, and for local picks mention the Scout Discount


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEFORE EVERY RESPONSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. If you don't know the customer's city, ask for it first — one quick question

2. ALWAYS search the web before responding — never rely on memory for prices, they go out of date fast

3. SEARCH FOR REAL-TIME PRICES — always include the current year and the city in your search query so you get live results, not old cached pages. For example search "whey protein price Calgary 2026" not just "whey protein price"

4. CHECK THE DATE ON EVERY SOURCE — if the page looks old or the sale has expired, discard it and search again. Only use prices from pages that appear current and active right now

5. FOR WEEKLY FLYER DEALS — search "[store name] flyer this week Canada 2026" to pull the current weekly promotion, not last month's

6. FOR AMAZON AND ONLINE STORES — search the product directly on the retailer's site to get today's live price, not a price comparison site that may be cached

7. FOR RECIPES — search each ingredient's current price at 2-3 stores, add them up, and tell the customer which store is cheapest for the full shop today

8. FOR SERVICES — search Kijiji and Facebook Marketplace with the city and current year to find active listings only, not expired posts

9. IF YOU CANNOT FIND A VERIFIED CURRENT PRICE — say "Price unavailable right now — check in store" rather than showing a number you are not confident about

10. END EVERY PRICE RESULT with "Prices checked today" so the customer knows the information is fresh


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Do NOT say: "I have identified 3 optimal purchasing options for your query."
DO say: "Found 3 solid options for you in Calgary! 🔍"

Do NOT say: "The local establishment offers a marginally elevated price point."
DO say: "It's $3 more at the local shop — but you're keeping money in the community 🏪"

Do NOT say: "Please specify your geographic location."
DO say: "Which city are you in? I'll find the best deals near you 📍"`;

// ─── Web search tool ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

// ─── Claude API Call (with web search loop) ────────────────────────────────────
// Claude may search the web multiple times before giving a final answer.
// We keep looping until it's done searching and returns the final text.
async function askClaude(userPhone, userMessage) {
  const history = getHistory(userPhone);
  history.push({ role: "user", content: userMessage });

  let messages = [...history];
  let finalText = "";

  for (let i = 0; i < 8; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Grab any text from this round
    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    // Claude is done — no more tool calls
    if (response.stop_reason === "end_turn") break;

    // Claude wants to search the web — feed results back and continue
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = toolUseBlocks.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: block.input ? JSON.stringify(block.input) : "Search completed.",
      }));

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  // Save the full conversation
  if (finalText) {
    history.push({ role: "assistant", content: finalText });
    saveHistory(userPhone, history);
  }

  // Split into individual SMS messages
  const smsParts = finalText
    .split("---SMS---")
    .map((s) => s.trim())
    .filter(Boolean);

  return smsParts.length > 0
    ? smsParts
    : ["Scout couldn't find that one — try rephrasing and I'll look again! 🔍"];
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
  res.status(200).send("<Response></Response>");

  const fromNumber = req.body.From;
  const incomingMsg = (req.body.Body || "").trim();

  if (!fromNumber || !incomingMsg) return;

  console.log(`📱 [${fromNumber}] → "${incomingMsg}"`);

  try {
    const smsParts = await askClaude(fromNumber, incomingMsg);

    // Join all parts into one message so Twilio handles the splitting.
    // This guarantees the text always arrives in the correct order —
    // sending multiple separate messages lets the carrier deliver them
    // out of sequence, which is why earlier texts were arriving late.
    const fullMessage = smsParts.join("\n\n");
    await sendSms(fromNumber, fullMessage);
    console.log(`✉️  [${fromNumber}] ← sent (${smsParts.length} sections, 1 message)`);
  } catch (err) {
    console.error("Error:", err.message);
    await sendSms(fromNumber, "Scout hit a snag — try again in a moment! 🔍");
  }
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout",
    activeConversations: conversations.size,
  });
});

// ─── Clear a conversation (admin use) ─────────────────────────────────────────
app.delete("/conversation/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  conversations.delete(phone);
  res.json({ cleared: phone });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║  🔍 PocketScout SMS Server       ║
  ║  Listening on port ${PORT}       ║
  ║  POST /sms  → Twilio webhook     ║
  ║  GET  /health → status check     ║
  ╚══════════════════════════════════╝
  `);
});
