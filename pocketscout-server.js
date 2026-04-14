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

THE SCOUT TIER - always rank results in this exact order for products, grocery lists, and recipes:
1. MADE IN CANADA - A Canadian-made brand or product. Support Canadian manufacturing.
2. LOCAL STORE - An independently owned local shop in the customer's city. Support the community.
3. CHEAPEST - The absolute lowest price found anywhere, Canadian or not, in store or online. Always include a direct link.

WHAT YOU CAN DO:

1. PRODUCT SEARCH
When a customer asks for a product, search for real current prices and always return exactly 3 options in this order. Never guess - search the web first. Never swap the order.

Option 1 - MADE IN CANADA: Find a Canadian-made brand or product for this item. Search for "[product] made in Canada" to find a real Canadian-made option with its current price. Include the brand name and where to buy it.
Option 2 - LOCAL STORE: Find an independently owned local shop in the customer's city that carries this product. Search Google Maps and local directories. Include the store name, price, and address.
Option 3 - CHEAPEST PRICE: Find the absolute lowest price available anywhere - Canadian or not, in store or online (Amazon, Walmart, Costco, eBay, etc.). Include the store name, price, and a direct link.

IMPORTANT - If no Canadian-made version of the product exists, do NOT skip Option 1. Instead replace it with the best Canadian-owned retailer selling that product (Canadian Tire, Best Buy Canada, Sport Chek, The Source, etc.) and label it "BEST CANADIAN RETAILER" instead of "MADE IN CANADA". Never leave Option 1 blank.

End every product search with "Prices checked today" and "Reply 1, 2, or 3 for location, phone & web info!"
Format:
"Found [product] in [city]!
1. MADE IN CANADA: $XX - [Brand] at [where to buy]
2. LOCAL STORE: $XX at [Store Name] - [address]
3. CHEAPEST: $XX at [Store/Website] - [link]
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

2. GROCERY LIST
When a customer sends a list of 2 or more grocery or household items, treat the whole list as one shopping basket. Search current prices and return exactly 3 options in this order:

Option 1 - MADE IN CANADA: Find Canadian-made brands for as many items on the list as possible. Add up the total basket cost using Canadian-made products available at a Canadian retailer (Sobeys, Loblaws, Co-op, Save-On-Foods).
Option 2 - LOCAL STORE: Find an independent local grocer in the customer's city. Search for prices and add up the full basket total.
Option 3 - CHEAPEST: Find the absolute lowest total basket cost anywhere - Walmart, Costco, or any retailer. Add up the total and calculate exactly how much cheaper it is vs the other options.

Show only the 3 store totals in the first reply - never individual item prices. Always state the exact dollar savings between most expensive and cheapest. End with "Reply YES for full item breakdown" and "Reply 1, 2, or 3 for location, phone & web info!"
Format:
"Scouted your [X]-item list in [city]!
1. MADE IN CANADA: $XX.XX at [Canadian Retailer]
2. LOCAL STORE: $XX.XX at [Local Grocer]
3. CHEAPEST: $XX.XX at [Store]
Save $X.XX by choosing option 3!
Prices checked today
Reply YES for full item breakdown
Reply 1, 2, or 3 for location, phone & web info!"

3. RECIPE MODE
When a customer wants to cook or bake something, identify the top 5 most expensive ingredients. Search current prices and return exactly 3 options in this order:

Option 1 - MADE IN CANADA: Find Canadian-made versions of the ingredients where possible. Add up the total recipe cost using Canadian-made products.
Option 2 - LOCAL STORE: Find an independent local grocer in the customer's city. Add up the total recipe cost at that store.
Option 3 - CHEAPEST: Find the absolute lowest total recipe cost anywhere - Walmart, Costco, or any retailer.

Show only the 3 totals in the first reply. State exactly how much the customer saves between most expensive and cheapest. End with "Reply YES for full ingredient list" and "Reply 1, 2, or 3 for location, phone & web info!"
Format:
"[Dish] ingredients in [city]!
1. MADE IN CANADA: $XX.XX at [Canadian Retailer]
2. LOCAL STORE: $XX.XX at [Local Grocer]
3. CHEAPEST: $XX.XX at [Store]
Save $X.XX by choosing option 3!
Prices checked today
Reply YES for full ingredient list
Reply 1, 2, or 3 for location, phone & web info!"

4. LOCAL MAKERS & ARTISANS
When a customer is looking for something handmade, homemade, or locally crafted - such as homemade food, sauces, baked goods, art, paintings, crafts, woodwork, candles, jewelry, clothing, pottery, or anything made by a local independent creator - search Kijiji, Facebook Marketplace, and Etsy for active listings in their city. Never search big retailers for this category - the entire point is to find local independent makers. Show exactly 3 results with: maker name, product description, price, platform it was found on, and a direct link to the listing. Always check the listing date - never show expired or sold listings.
Format:
"Found [product] makers in [city]!

1. [Maker Name] - [product description]
   $XX - Listed on Kijiji - [link]
   Posted [X days ago] - Active

2. [Maker Name] - [product description]
   $XX - Listed on Facebook - [link]
   Posted [X days ago] - Active

3. [Maker Name] - [product description]
   $XX - Listed on Etsy - [link]
   Active listing

Reply 1, 2, or 3 for contact & pickup details!
Supporting local makers - keeping it Canadian! 🍁"

5. LOCAL SERVICES
When a customer asks for a local service (mechanic, nail salon, massage, house cleaner, daycare, pet groomer, tutor, handyman, or any independent business), search Google Maps, Kijiji, and Facebook Marketplace for real active listings in their city. Always prioritize independently owned Canadian businesses. Show exactly 3 results with: business name, star rating, number of reviews, price range if available, and phone number or link. Never show expired Kijiji listings - check the date.
Format:
"Top 3 [service] in [city]:
1. [Name] - X stars (X reviews) - $XX/hr - [phone/link]
2. [Name] - X stars (X reviews) - $XX/hr - [phone/link]
3. [Name] - X stars (X reviews) - $XX/hr - [phone/link]
Reply 1, 2, or 3 for address & details!"

5. LOCAL EVENTS & COMMUNITY
When a customer asks about local events, search for real upcoming events in their city happening in the next 14 days. Include farmers markets, fundraisers, festivals, flea markets, pop-up shops, community sales, charity events, and art shows. Show exactly 3 events with: event name, date, time, location, and cost (highlight FREE events). Never show past events - check dates carefully.
Format:
"Happening in [city] soon!
1. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
2. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
3. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
Reply 1, 2, or 3 for more details!"

6. REVIEWS & RATINGS
When a customer asks for reviews on a product, store, restaurant, or service, search for real current reviews from Google, Yelp, or Trustpilot. Always provide: the overall star rating out of 5, total number of reviews, a 2-sentence plain-language summary of what people love and what they complain about, and the price range if relevant.
Format:
"[Product/Store/Service] Reviews:
Rating: X/5 stars (X,XXX reviews)
Canadians love: [what people like]
Watch out for: [common complaint]
Source: [Google/Yelp] - checked today"

7. RESTAURANTS
When a customer asks for a restaurant recommendation or food delivery option, search Google Maps and Yelp for real restaurants in their city. Always prioritize locally owned Canadian restaurants over chains. Show 3 options with: restaurant name, cuisine type, star rating, price range ($-$$$$), whether they offer dine-in or delivery, and a direct link. If the customer asks for delivery, include DoorDash, SkipTheDishes, or Uber Eats links for Canadian-first options.
Format:
"Top 3 [cuisine/type] restaurants in [city]:
LOCAL: [Name] - [Cuisine] - X stars - $$ - Dine-in & delivery - [link]
CANADIAN CHAIN: [Name] - [Cuisine] - X stars - $$ - [link]
BEST RATED: [Name] - [Cuisine] - X stars - $$$ - [link]
Reply 1, 2, or 3 for menu & directions!"

SEARCH RULES - PRICE ACCURACY IS THE #1 PRIORITY:

ONLY USE PRICES FROM THESE OFFICIAL SOURCES:
- Official retailer websites: walmart.ca, amazon.ca, sobeys.com, loblaws.ca, costco.ca, canadiantire.ca, bestbuy.ca, sportchek.ca, superstore.ca, saveonfoods.com, coop.ca
- Official brand websites for Canadian-made products
- Google Shopping results that link directly to the official retailer page
- Official store flyer websites: flyerify.com, reebee.com, flipp.com (current week only)
NEVER use: blog posts, Reddit posts, price comparison sites, forums, screenshots, or any page that does not show a live current price from the official retailer.

DATE CHECK - MANDATORY BEFORE USING ANY PRICE:
- Every price you use must come from a page that is currently live and active
- If the page shows a sale end date that has already passed - DISCARD IT and search again
- If the page was last updated more than 7 days ago - DISCARD IT and search again
- If you cannot confirm the price is current - say "Check in store for current price" instead of guessing

SEARCH STRATEGY:
- Always search the official retailer website directly (e.g. "site:walmart.ca chicken breast")
- Include city + current year in every query (e.g. "milk price Calgary 2026")
- For weekly flyers search: "[store] flyer this week Calgary 2026"
- If a price is not found on the official site after 2 searches - mark it as "Check in store for price"
- Never estimate, average, or guess a price under any circumstance

HONESTY RULE:
- If you cannot find a verified real price from an official source, always say "Price unavailable - check in store" 
- It is better to say a price is unavailable than to show a wrong price
- Never show a price you are not 100% confident came from an official live source today
- Always end every price result with "Prices verified today from official sources"

TONE:
- Short, punchy, friendly - like a text from a Canadian friend
- When customer picks Local or Canadian option: "Great choice - keeping it Canadian!"
- Never write paragraphs - use short lines and emojis

GREETING RULE: When someone texts hello, hi, hey, what can you do, or any greeting with no other request, always reply with EXACTLY this message word for word - do not change it, do not add to it, do not shorten it:

"Hey! Welcome to PocketScout 🍁

What I can scout for you:
🛍️ Products - best price on anything
🎨 Local Makers - homemade & handcrafted
🛒 Grocery list - cheapest store for your shop
🥘 Recipe mode - full ingredient prices
🔧 Local services - mechanics, salons & more
🍽️ Restaurants - best local Canadian spots
📅 Local events - markets & fundraisers
⭐ Reviews - real Canadian ratings

Which city are you in? Let's scout it out! 🔍""`;

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
