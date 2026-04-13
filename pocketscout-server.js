/**
 * PocketScout SMS Server — Booth Edition
 * Stack: Node.js + Express + Twilio + Anthropic Claude + Web Search
 *
 * Hardened for high traffic:
 *  - Per-user message queue     → no crossed conversations
 *  - Duplicate message filter   → Twilio retries are ignored
 *  - Concurrency limiter        → max 5 AI calls at once, rest wait in line
 *  - Auto retry on 529          → recovers from Anthropic overload silently
 *  - "Please wait" reply        → user knows Scout received their text
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Conversation store — 3 hour TTL, swept every 15 min ──────────────────────
const conversations = new Map();
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;

function getHistory(phone) {
  const entry = conversations.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return [];
  }
  // Keep only the last 10 messages per user (5 exchanges).
  // Each web search adds tokens fast — trimming old history keeps us
  // well under the 30,000 tokens/minute rate limit.
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
    console.log(`🧹 Swept ${removed} expired conversation(s). Active: ${conversations.size}`);
  }
}, 15 * 60 * 1000);

// ─── Duplicate message filter ──────────────────────────────────────────────────
// Twilio resends a webhook if your server is slow to respond.
// We track the last 200 message IDs and ignore any we've already processed.
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

// ─── Per-user message queue ────────────────────────────────────────────────────
// If the same person texts twice quickly, the second message waits for the
// first one to finish. This prevents crossed or out-of-order conversations.
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

// ─── Global concurrency limiter ────────────────────────────────────────────────
// Limits how many AI calls run at the same time.
// At a busy booth with 20 people texting at once, this keeps Anthropic
// from getting hammered and triggering 529 errors.
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

3. GROCERY LIST MODE
When a customer sends a grocery list (any list of food or household items), search for the total basket price at multiple stores and tell them which store is cheapest for the entire list — not item by item. Add up each store's total and clearly show the savings.

Example output for grocery list mode:
"Scouted your 8-item grocery list in Edmonton 🛒

Store totals (est.):
🏪 Blush Lane Organic Market: $47.20
🍁 Sobeys: $38.90
💻 Walmart (pickup): $31.45

Best overall: Walmart saves you ~$15.75 vs local!
Reply YES for the full item breakdown 📋"

If the customer replies YES, send each item with the price at the cheapest store.

4. SERVICE SEARCH
Help customers find local independent services: mechanics, beauty salons, nail studios, massage therapists, day cares, house cleaners, landscapers, pet groomers, tutors, handymen — anything that serves the local community. Search Kijiji, Facebook Marketplace, Google Maps, and local directories. Prioritize independently owned businesses. Include their rating and number of reviews when available.

5. LOCAL EVENTS & COMMUNITY
When a customer asks about what's happening locally — events, fundraisers, farmers markets, festivals, flea markets, community sales, charity drives, pop-up shops, art shows, or anything community-related — search for current and upcoming events in their city. Include the date, location, and a brief description. Prioritize free or low-cost events and highlight anything that supports local vendors or community causes.

Example output for events mode:
"Here's what's happening in Calgary this weekend 📅

🌱 Farmers Market — Crossroads Market, Sat 9am–2pm. 80+ local vendors, fresh produce & crafts.
🎪 Inglewood Night Market — Fri 5–10pm. Free entry, live music & local food trucks.
🤝 YWCA Fundraiser Gala — Sat 6pm @ Hotel Arts. Tickets $75, supports local women & families.

Want more details on any of these? Reply 1, 2, or 3!"

6. REVIEWS
When asked, provide the average star rating, number of reviews, and a quick summary of what people are saying. Always pull this from real search results.

7. ONLINE LINKS
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
- Send a maximum of 4 SMS messages per response
- Keep each message concise — SMS has a 160 character limit per segment
- Use ---SMS--- to break up naturally: first text = results, second = links or details, third = tip or follow-up offer
- Always end with an open door: "Anything else I can scout for you? 🔍"
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

8. FOR GROCERY LISTS — treat the whole list as one shopping basket. Search total prices at 2-3 stores, add them up, and tell the customer exactly how much they save by choosing the cheapest store. Never just list individual item prices without showing the basket total.

9. FOR LOCAL EVENTS — search "[city] events this weekend 2026", "[city] farmers market", "[city] fundraiser", "[city] community events" etc. Only show events that are happening now or in the next 2 weeks. Include date, time, location, and cost (highlight free events).

10. FOR SERVICES — search Kijiji and Facebook Marketplace with the city and current year to find active listings only, not expired posts

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

// ─── Retry helper — handles 529 Overloaded AND 429 Rate Limit ────────────────
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
      // Rate limit needs a longer wait than overload — give it 15s minimum
      const baseWait = isRateLimited ? 15000 : 2000;
      const waitMs = baseWait * attempt;
      const reason = isRateLimited ? "Rate limited" : "Overloaded";
      console.log(`⏳ ${reason} — retrying in ${waitMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      return callClaudeWithRetry(params, attempt + 1);
    }
    throw err;
  }
}

// ─── Claude API Call ───────────────────────────────────────────────────────────
async function askClaude(phone, userMessage) {
  const history = getHistory(phone);
  history.push({ role: "user", content: userMessage });

  let messages = [...history];
  let finalText = "";

  for (let i = 0; i < 8; i++) {
    const response = await callClaudeWithRetry({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
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
    : ["Scout couldn't find that one — try rephrasing and I'll look again! 🔍"];
}

// ─── Send SMS via Twilio ───────────────────────────────────────────────────────
async function sendSms(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
}

// ─── Twilio Webhook — incoming SMS ────────────────────────────────────────────
app.post("/sms", async (req, res) => {
  // Reply to Twilio immediately — if we wait, Twilio retries and sends duplicates
  res.status(200).send("<Response></Response>");

  const fromNumber = req.body.From;
  const incomingMsg = (req.body.Body || "").trim();
  const messageSid = req.body.MessageSid;

  if (!fromNumber || !incomingMsg) return;

  // Drop duplicate webhooks (Twilio retries when your server is busy)
  if (isDuplicate(messageSid)) {
    console.log(`⚠️  Duplicate ignored [${messageSid}]`);
    return;
  }

  console.log(`📱 [${fromNumber}] → "${incomingMsg}"`);

  // Queue this message behind any other message from the same person.
  // This guarantees their conversation stays in order even if they text fast.
  enqueueForUser(fromNumber, async () => {
    // Wait for a free AI slot — max 5 run at the same time
    await acquireSlot();

    // Let the user know Scout is working — search takes 5-15 seconds
    try {
      await sendSms(fromNumber, "🔍 Scouting that for you now — reply coming shortly!");
    } catch (_) {}

    try {
      const smsParts = await askClaude(fromNumber, incomingMsg);
      const fullMessage = smsParts.join("\n\n");
      await sendSms(fromNumber, fullMessage);
      console.log(`✉️  [${fromNumber}] ← sent`);
    } catch (err) {
      console.error(`Error [${fromNumber}]:`, err.message);
      await sendSms(fromNumber, "Scout hit a snag — try again in a moment! 🔍");
    } finally {
      releaseSlot();
    }
  });
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout",
    activeConversations: conversations.size,
    activeAiCalls: activeCount,
    waitingInQueue: waitingQueue.length,
  });
});

// ─── Clear a conversation ──────────────────────────────────────────────────────
app.delete("/conversation/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  conversations.delete(phone);
  res.json({ cleared: phone });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
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
