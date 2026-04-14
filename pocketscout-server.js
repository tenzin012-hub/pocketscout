/**
 * PocketScout SMS Server — Booth Edition
 * Stack: Node.js + Express + Twilio + Anthropic Claude + Web Search
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Conversation store - 3 hour TTL, swept every 15 min ---
const conversations = new Map();
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;

function getHistory(phone) {
  const entry = conversations.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return [];
  }
  const messages = entry.messages;
  return messages.length > 10 ? messages.slice(-10) : messages;
}

function saveHistory(phone, messages) {
  conversations.set(phone, { messages, updatedAt: Date.now() });
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
    console.log(`Swept ${removed} expired conversation(s). Active: ${conversations.size}`);
  }
}, 15 * 60 * 1000);

// --- Duplicate message filter ---
const processedMessageIds = new Set();
const MESSAGE_ID_LIMIT = 200;

function isDuplicate(messageSid) {
  if (!messageSid) return false;
  if (processedMessageIds.has(messageSid)) return true;
  processedMessageIds.add(messageSid);
  if (processedMessageIds.size > MESSAGE_ID_LIMIT) {
    const firstKey = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstKey);
  }
  return false;
}

// --- Per-user message queue ---
const userQueues = new Map();

function enqueueForUser(phone, task) {
  if (!userQueues.has(phone)) {
    userQueues.set(phone, Promise.resolve());
  }
  const queue = userQueues.get(phone).then(task).catch(() => {});
  userQueues.set(phone, queue);
  queue.finally(() => {
    if (userQueues.get(phone) === queue) userQueues.delete(phone);
  });
}

// --- Global concurrency limiter - max 5 AI calls at once ---
const MAX_CONCURRENT = 5;
let activeCount = 0;
const waitingQueue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      waitingQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  if (waitingQueue.length > 0) {
    const next = waitingQueue.shift();
    next();
  } else {
    activeCount--;
  }
}

// --- PocketScout System Prompt ---
const SYSTEM_PROMPT = `You are PocketScout - Canada's deal-hunting assistant. Your mission: keep Canadian dollars in Canadian communities. You are warm, proud, and patriotic - like a knowledgeable Canadian friend, never a corporate chatbot.

You have web search access. Always search before responding. Never guess prices.

CRITICAL RULE: Every response MUST be under 1500 characters total. SMS has a hard limit. Be concise. Use short lines. Cut anything non-essential. If asked for details, give the highlights and say "Reply MORE for details".

THE SCOUT TIER - always rank results in this order:
1. LOCAL HERO - Independent local shop in the customer's city. Always first, even if slightly pricier. Tag: Support local!
2. GREAT CANADIAN - Canadian-owned brand or retailer (Canadian Tire, Sobeys, MEC, Sport Chek, Loblaws, etc.) or Canadian-made product.
3. BEST DEAL - Lowest price anywhere (Amazon.ca, Walmart.ca, Costco.ca, etc.). Include a direct link.

WHAT YOU CAN DO:
- Product search: 3 tiered options with real-time prices
- Grocery list: When a customer sends a list of grocery or household items, treat the entire list as one shopping basket. Search current prices for each item at 3 stores: one local independent grocer, one Canadian chain (Sobeys, Loblaws, Co-op), and one big-box retailer (Walmart, Costco). Add up the total for each store. Show the 3 store totals clearly, bold the cheapest one, state exactly how much the customer saves vs the most expensive option, and offer the item-by-item breakdown by saying "Reply YES for the full list". Never show individual item prices in the first reply - totals only to keep it within SMS limits.
- Recipe mode: Price top 5 ingredients, compare store totals
- Local services: Mechanics, salons, cleaners, daycares, etc. - search Kijiji, Facebook Marketplace, Google Maps
- Local events: Farmers markets, fundraisers, festivals - max 3 results, upcoming only
- Reviews: Star rating, review count, 1-sentence summary

SEARCH RULES:
- Always include city + current year in queries (e.g. "protein Calgary 2026")
- Check source dates - discard anything that looks old or expired
- For flyers: search "[store] flyer this week Canada 2026"
- End every price result with "Prices checked today"
- If price not found: say "Check in store for price"

TONE:
- Short, punchy, friendly - like a text from a Canadian friend
- When customer picks Local or Canadian option: "Great choice - keeping it Canadian!"
- Never write paragraphs - use short lines and emojis

GREETING RULE: When someone texts hello/hi/hey with no other request, reply with EXACTLY this (do not change it):

"Hey! Welcome to PocketScout - proudly Canadian, built to keep your dollars where they belong!

What I can do:
Find best prices (local, Canadian & online)
Grocery list - cheapest store for your full shop
Recipe prices - full ingredient breakdown
Local services - mechanics, salons & more
Local events - markets, fundraisers & festivals
Reviews - real Canadian ratings

Which city are you in? Let's scout it out!"`;

// --- Web search tool ---
const TOOLS = [
  {
    type: "web_search_20250305",
    name: "web_search",
  },
];

// --- Retry helper - handles 529 Overloaded AND 429 Rate Limit ---
async function callClaudeWithRetry(params, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    return await anthropic.messages.create(params);
  } catch (err) {
    const isOverloaded =
      err.status === 529 ||
      (err.message && err.message.includes("overloaded"));
    const isRateLimited =
      err.status === 429 ||
      (err.message && err.message.includes("rate_limit"));

    if ((isOverloaded || isRateLimited) && attempt <= MAX_ATTEMPTS) {
      const baseWait = isRateLimited ? 15000 : 2000;
      const waitMs = baseWait * attempt;
      const reason = isRateLimited ? "Rate limited" : "Overloaded";
      console.log(`${reason} - retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      return callClaudeWithRetry(params, attempt + 1);
    }
    throw err;
  }
}

// --- Claude API Call ---
async function askClaude(phone, userMessage) {
  const history = getHistory(phone);
  history.push({ role: "user", content: userMessage });

  let messages = [...history];
  let finalText = "";

  for (let i = 0; i < 8; i++) {
    const response = await callClaudeWithRetry({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    if (response.stop_reason === "end_turn") break;

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

  if (finalText) {
    history.push({ role: "assistant", content: finalText });
    saveHistory(phone, history);
  }

  const smsParts = finalText
    .split("---SMS---")
    .map((s) => s.trim())
    .filter(Boolean);

  return smsParts.length > 0
    ? smsParts
    : ["Scout couldn't find that one - try rephrasing and I'll look again!"];
}

// --- Character limit trimmer ---
// Twilio hard limit is 1600 chars. We cut at 1500 to be safe.
// If too long, trim at a clean line break and tell user to reply MORE.
const TWILIO_MAX_CHARS = 1500;

function trimToLimit(text) {
  if (text.length <= TWILIO_MAX_CHARS) return text;
  const trimmed = text.slice(0, TWILIO_MAX_CHARS);
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastSpace = trimmed.lastIndexOf(" ");
  const cutAt = lastNewline > TWILIO_MAX_CHARS * 0.7 ? lastNewline : lastSpace;
  return trimmed.slice(0, cutAt).trimEnd() + "\n\n(Reply MORE for full details)";
}

// --- Send SMS via Twilio ---
async function sendSms(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body: trimToLimit(body),
  });
}

// --- Twilio Webhook - incoming SMS ---
app.post("/sms", async (req, res) => {
  res.status(200).send("<Response></Response>");

  const fromNumber = req.body.From;
  const incomingMsg = (req.body.Body || "").trim();
  const messageSid = req.body.MessageSid;

  if (!fromNumber || !incomingMsg) return;

  if (isDuplicate(messageSid)) {
    console.log(`Duplicate ignored [${messageSid}]`);
    return;
  }

  console.log(`[${fromNumber}] -> "${incomingMsg}"`);

  enqueueForUser(fromNumber, async () => {
    await acquireSlot();

    try {
      await sendSms(fromNumber, "Scouting that for you now - reply coming shortly!");
    } catch (_) {}

    try {
      const smsParts = await askClaude(fromNumber, incomingMsg);
      const fullMessage = smsParts.join("\n\n");
      await sendSms(fromNumber, fullMessage);
      console.log(`[${fromNumber}] <- sent (${fullMessage.length} chars)`);
    } catch (err) {
      console.error(`Error [${fromNumber}]:`, err.message);
      await sendSms(fromNumber, "Scout hit a snag - try again in a moment!");
    } finally {
      releaseSlot();
    }
  });
});

// --- Health check ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout",
    activeConversations: conversations.size,
    activeAiCalls: activeCount,
    waitingInQueue: waitingQueue.length,
  });
});

// --- Clear a conversation ---
app.delete("/conversation/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  conversations.delete(phone);
  res.json({ cleared: phone });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║  PocketScout SMS Server          ║
  ║  Listening on port ${PORT}          ║
  ║  POST /sms  -> Twilio webhook    ║
  ║  GET  /health -> status check    ║
  ╚══════════════════════════════════╝
  `);
});
