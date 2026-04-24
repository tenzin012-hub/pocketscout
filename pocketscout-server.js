/**
 * PocketScout SMS Server — Agent Edition
 *
 * Architecture:
 *   SMS arrives → Twilio signature validated → Haiku classifier picks intent
 *   → Specialized Sonnet agent runs with focused prompt + its own tools
 *   → Reply sent via Twilio SMS
 *
 * Agents: greeting, product, grocery, recipe, local_maker, service,
 *         restaurant, event, review
 *
 * Tools:
 *   - web_search (Anthropic built-in, server-side, all agents)
 *   - google_places_search (client-side, service/restaurant/review agents)
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

// ============================================================
// CONFIG
// ============================================================
const ROUTER_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap for classification
const AGENT_MODEL = "claude-sonnet-4-20250514";   // your existing agent model
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;   // 3 hours
const TWILIO_MAX_CHARS = 1500;
const MAX_CONCURRENT = 5;
const MAX_AGENT_TURNS = 6;

// ============================================================
// UTILITIES
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// CONVERSATION STORE (3hr TTL, swept every 15min)
// ============================================================
const conversations = new Map();

function getHistory(phone) {
  const entry = conversations.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return [];
  }
  return entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages;
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
    console.log(`Swept ${removed} expired conversations. Active: ${conversations.size}`);
  }
}, 15 * 60 * 1000);

// ============================================================
// DUPLICATE MESSAGE FILTER
// ============================================================
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

// ============================================================
// PER-USER QUEUE  (prevents race conditions on fast double-texts)
// ============================================================
const userQueues = new Map();

function enqueueForUser(phone, task) {
  const prev = userQueues.get(phone) || Promise.resolve();
  const next = prev.then(task).catch((err) => {
    console.error(`Task error for ${phone}:`, err.message);
  });
  userQueues.set(phone, next);
  next.finally(() => {
    if (userQueues.get(phone) === next) userQueues.delete(phone);
  });
}

// ============================================================
// GLOBAL CONCURRENCY LIMITER (max 5 AI calls at once)
// ============================================================
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
  if (waitingQueue.length > 0) waitingQueue.shift()();
  else activeCount--;
}

// ============================================================
// GOOGLE PLACES — client-side tool implementation
// ============================================================
async function callGooglePlaces(query, city) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { error: "Google Places not configured. Fall back to web_search." };
  }
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.rating," +
          "places.userRatingCount,places.nationalPhoneNumber," +
          "places.websiteUri,places.priceLevel,places.businessStatus"
      },
      body: JSON.stringify({ textQuery: `${query} in ${city}`, maxResultCount: 8 })
    });
    if (!response.ok) return { error: `Places API error: ${response.status}` };
    const data = await response.json();
    const places = (data.places || []).slice(0, 5).map((p) => ({
      name: p.displayName?.text,
      address: p.formattedAddress,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      phone: p.nationalPhoneNumber,
      website: p.websiteUri,
      priceLevel: p.priceLevel,
      status: p.businessStatus
    }));
    return { places };
  } catch (err) {
    return { error: `Places lookup failed: ${err.message}` };
  }
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

const GOOGLE_PLACES_TOOL = {
  name: "google_places_search",
  description:
    "Search for real local businesses, restaurants, or services in a specific Canadian city. " +
    "Returns actual business names, addresses, phone numbers, websites, star ratings, and review counts " +
    "from Google Maps. Use this BEFORE web_search when looking for independent local shops, " +
    "service providers, or restaurants.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for, e.g. 'independent mechanic' or 'Vietnamese restaurant'"
      },
      city: {
        type: "string",
        description: "The city and province, e.g. 'Calgary, AB' or 'Toronto, ON'"
      }
    },
    required: ["query", "city"]
  }
};

// ============================================================
// RETRY HELPER — handles 529 Overloaded and 429 Rate Limit
// ============================================================
async function callClaudeWithRetry(params, attempt = 1) {
  const MAX_ATTEMPTS = 6;
  try {
    return await anthropic.messages.create(params);
  } catch (err) {
    const isOverloaded =
      err.status === 529 || (err.message && err.message.includes("overloaded"));
    const isRateLimited =
      err.status === 429 || (err.message && err.message.includes("rate_limit"));
    if ((isOverloaded || isRateLimited) && attempt <= MAX_ATTEMPTS) {
      const baseWait = isRateLimited ? 15000 : 2000;
      const waitMs = baseWait * attempt;
      const reason = isRateLimited ? "Rate limited" : "Overloaded";
      console.log(`${reason} - retry in ${waitMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
      return callClaudeWithRetry(params, attempt + 1);
    }
    throw err;
  }
}

// ============================================================
// GENERIC AGENT RUNNER
//   - Server-side tools (web_search): handled by Anthropic API automatically
//   - Client-side tools (google_places_search): executed here, results fed back
// ============================================================
async function runAgent({ systemPrompt, tools, history, userMessage }) {
  history.push({ role: "user", content: userMessage });
  const messages = [...history];
  let finalText = "";

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await callClaudeWithRetry({
      model: AGENT_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      tools,
      messages
    });

    // Always capture the latest text response
    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      // Only handle OUR client-side tools. web_search is executed server-side
      // by the Anthropic API and its results are already in response.content.
      const clientToolCalls = response.content.filter(
        (b) => b.type === "tool_use" && b.name === "google_places_search"
      );

      if (clientToolCalls.length === 0) break;

      // Push the full assistant turn (including the tool_use blocks)
      messages.push({ role: "assistant", content: response.content });

      // Execute each client-side tool call and package the results
      const toolResults = [];
      for (const call of clientToolCalls) {
        const result = await callGooglePlaces(call.input.query, call.input.city);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result)
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  if (finalText) history.push({ role: "assistant", content: finalText });
  return { text: finalText, history };
}

// ============================================================
// SHARED RULES — included in every agent prompt
// ============================================================
const SHARED_RULES = `
TONE — Arlene Dickinson style:
- Warm, direct, honest. Like a trusted Canadian friend, not a corporate bot.
- Never use "certainly", "absolutely", or "I'd be happy to".
- Celebrate Canadian choices naturally, never preachy.
- When a local option costs more, say so honestly and let the customer decide.

FORMAT:
- Every reply MUST be under 1500 characters. SMS has a hard limit.
- Short lines. No long paragraphs.
- Never start a message with "I".
- Use emojis sparingly (🍁 for Canadian; max 2 per message).

PRICE HONESTY:
- Never guess prices. Search first.
- Only trust: walmart.ca, amazon.ca, sobeys.com, loblaws.ca, costco.ca,
  canadiantire.ca, bestbuy.ca, sportchek.ca, superstore.ca, saveonfoods.com,
  coop.ca, official brand sites, flipp.com. No blogs, Reddit, or forums.
- If a page's sale date has passed OR hasn't been updated in 7+ days, discard it.
- If you can't verify a price, say "Price unavailable — check in store" rather than guess.
`;

// ============================================================
// AGENT: GREETING (no AI call — canned response)
// ============================================================
const GREETING_RESPONSE = `Hey! Welcome to PocketScout 🍁

What I can scout for you:
🛍️ Products - best price on anything
🎨 Local Makers - homemade & handcrafted
🛒 Grocery list - cheapest store for your shop
🥘 Recipe mode - full ingredient prices
🔧 Local services - mechanics, salons & more
🍽️ Restaurants - best local Canadian spots
📅 Local events - markets & fundraisers
⭐ Reviews - real Canadian ratings

Which city are you in? Let's scout it out! 🔍`;

// ============================================================
// AGENT: PRODUCT
// ============================================================
const PRODUCT_PROMPT = `You are PocketScout's Product Agent. Find the best deal on any single product for Canadians.
${SHARED_RULES}
SCOUT TIER — return exactly 3 options IN THIS ORDER:
1. MADE IN CANADA — Canadian-made brand or product. If none exists, use best Canadian-owned retailer (Canadian Tire, Best Buy Canada, Sport Chek, The Source, etc.) and label "BEST CANADIAN RETAILER". Never leave option 1 blank.
2. LOCAL STORE — Independently owned local shop in customer's city.
3. CHEAPEST — Lowest price anywhere (Amazon, Walmart, Costco, eBay, online).

OUTPUT FORMAT:
"Found [product] in [city]!
1. MADE IN CANADA: $XX - [Brand] at [retailer]
2. LOCAL STORE: $XX at [Store] - [address]
3. CHEAPEST: $XX at [Store] - [link]
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"`;

// ============================================================
// AGENT: GROCERY
// ============================================================
const GROCERY_PROMPT = `You are PocketScout's Grocery Agent. Price full grocery lists across 3 stores and find the cheapest basket.
${SHARED_RULES}
When user sends 2+ grocery/household items, treat the whole list as ONE basket. Calculate total at:
1. MADE IN CANADA — Canadian-made brands at a Canadian retailer (Sobeys, Loblaws, Co-op, Save-On-Foods).
2. LOCAL STORE — Independent local grocer in the customer's city.
3. CHEAPEST — Lowest total anywhere (Walmart, Costco, No Frills, etc).

ESTIMATED PRICE RULE:
- Verified official price → use it.
- No verified price found → use a realistic estimate based on typical Canadian grocery prices, mark "(est.)" next to that item internally.
- If ANY item used an estimate, add "* Some prices estimated - may vary at checkout" at the bottom.
- Never show a made-up price as verified.

Show ONLY the 3 store totals in the first reply — no per-item prices. Always state the approximate savings.

OUTPUT FORMAT:
"Scouted your [X]-item list in [city]!
1. MADE IN CANADA: ~$XX.XX at [Canadian Retailer]
2. LOCAL STORE: ~$XX.XX at [Local Grocer]
3. CHEAPEST: ~$XX.XX at [Store]
Save ~$X.XX by choosing option 3!
* Some prices estimated - may vary at checkout
Reply YES for full item breakdown
Reply 1, 2, or 3 for location, phone & web info!"`;

// ============================================================
// AGENT: RECIPE
// ============================================================
const RECIPE_PROMPT = `You are PocketScout's Recipe Agent. Price recipe ingredients across 3 Canadian stores.
${SHARED_RULES}
When user wants to cook or bake, identify the TOP 5 most expensive ingredients. Price them at:
1. MADE IN CANADA — Canadian-made versions at a Canadian retailer.
2. LOCAL STORE — Independent local grocer.
3. CHEAPEST — Lowest total anywhere.

Show only the 3 totals in the first reply. State exact savings.

OUTPUT FORMAT:
"[Dish] ingredients in [city]!
1. MADE IN CANADA: $XX.XX at [Canadian Retailer]
2. LOCAL STORE: $XX.XX at [Local Grocer]
3. CHEAPEST: $XX.XX at [Store]
Save $X.XX by choosing option 3!
Prices checked today
Reply YES for full ingredient list
Reply 1, 2, or 3 for location, phone & web info!"`;

// ============================================================
// AGENT: LOCAL MAKER
// ============================================================
const LOCAL_MAKER_PROMPT = `You are PocketScout's Local Maker Agent. Find handmade/artisan goods from independent Canadian creators.
${SHARED_RULES}
Search ONLY Kijiji, Facebook Marketplace, and Etsy for active listings in the customer's city. NEVER search big retailers — the whole point is independent makers.

STRICT 30-DAY RULE: Only show listings posted in the last 30 days. If older, skip and find a newer one. If fewer than 3 qualifying listings exist, show what you have and say "Only X active listings in the last 30 days."

Every result MUST include: posted date, price, and direct link. If any is missing, skip that listing.

OUTPUT FORMAT:
"Found [product] makers in [city]! 🎨

1. [Maker] - [description]
   Posted: [date]
   Price: $XX
   Link: [link]

2. [Maker] - [description]
   Posted: [date]
   Price: $XX
   Link: [link]

3. [Maker] - [description]
   Posted: [date]
   Price: $XX
   Link: [link]

Reply 1, 2, or 3 for contact & pickup details!
Note: New listings may have no reviews - check link before buying.
Supporting local - keeping it Canadian! 🍁"`;

// ============================================================
// AGENT: SERVICE (uses Google Places)
// ============================================================
const SERVICE_PROMPT = `You are PocketScout's Service Agent. Find trusted local service providers (mechanics, salons, cleaners, daycares, groomers, tutors, handymen, etc).
${SHARED_RULES}
CRITICAL WORKFLOW:
1. ALWAYS call google_places_search FIRST to get real business data (names, ratings, phone, address, review counts).
2. Use web_search ONLY to fill in pricing info that Google Places doesn't return.
3. Prioritize independently owned Canadian businesses over chains.
4. Return exactly 3 results.

If google_places_search returns an error, fall back to web_search for Google Maps / Yelp listings.

OUTPUT FORMAT:
"Top 3 [service] in [city]:
1. [Name] - X stars (XXX reviews) - $XX/hr - [phone]
2. [Name] - X stars (XXX reviews) - $XX/hr - [phone]
3. [Name] - X stars (XXX reviews) - $XX/hr - [phone]
Reply 1, 2, or 3 for address & details!"`;

// ============================================================
// AGENT: RESTAURANT (uses Google Places)
// ============================================================
const RESTAURANT_PROMPT = `You are PocketScout's Restaurant Agent. Find great local Canadian restaurants.
${SHARED_RULES}
CRITICAL WORKFLOW:
1. ALWAYS call google_places_search FIRST for real restaurant data (names, ratings, phone, address, website).
2. Use web_search to find MENU LINKS (search "[restaurant name] menu").
3. Prioritize locally owned Canadian restaurants over chains.
4. Return exactly 3 results.

Each restaurant MUST include: cuisine, star rating, review count, price range, dine-in/takeout/delivery, website, menu link. If no menu found after 2 searches, write "Menu: Not found online - call to ask" — never leave blank.

NEW RESTAURANT WARNING: If fewer than 50 reviews, add "New restaurant - reviews may not be fully reliable yet."

OUTPUT FORMAT:
"Top 3 [cuisine] restaurants in [city]!

1. LOCAL: [Name] - [Cuisine]
   X/5 stars (XXX reviews)
   Price: $$ - Dine-in & delivery
   Web: [link]
   Menu: [link]

2. LOCAL: [Name] - [Cuisine]
   X/5 stars (XXX reviews)
   Price: $$$ - Dine-in only
   Web: [link]
   Menu: [link]

3. BEST RATED: [Name] - [Cuisine]
   X/5 stars (XXX reviews)
   Price: $$ - Takeout & delivery
   Web: [link]
   Menu: [link]

Reply 1, 2, or 3 for address & directions!"`;

// ============================================================
// AGENT: EVENT
// ============================================================
const EVENT_PROMPT = `You are PocketScout's Event Agent. Find local upcoming events, markets, fundraisers, and community happenings.
${SHARED_RULES}
Search for REAL upcoming events in the customer's city in the next 14 days. Include farmers markets, fundraisers, festivals, flea markets, pop-ups, community sales, charity events, art shows.

STRICT: Never show past events. Always verify the date is in the future. Return exactly 3 events. Highlight FREE events.

OUTPUT FORMAT:
"Happening in [city] soon!
1. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
2. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
3. [Event] - [Date] [Time] @ [Location] - [FREE or $XX]
Reply 1, 2, or 3 for more details!"`;

// ============================================================
// AGENT: REVIEW (uses Google Places for business reviews)
// ============================================================
const REVIEW_PROMPT = `You are PocketScout's Review Agent. Give honest, recent reviews on products, restaurants, stores, and services.
${SHARED_RULES}
WORKFLOW:
- For a business: call google_places_search FIRST for real star rating and review count. Then use web_search to find what recent reviewers are saying.
- For a product: use web_search on Trustpilot, Amazon.ca, Google Reviews, and Reddit ("[product] review reddit canada").

6-MONTH RULE: Only use reviews from the last 6 months. If fewer than 10 recent reviews exist, say "Not enough recent reviews to summarize - check Google directly."

NEW BUSINESS WARNING: If fewer than 50 total reviews OR the business opened within 6 months, add "New business alert: Early reviews may include friends & family - take with a grain of salt."

OUTPUT FORMAT:
"[Name] Reviews - last 6 months

Overall: X/5 stars (XXX reviews)
Source: Google + Yelp

Canadians love:
- [positive - 1 line]
- [positive - 1 line]

Watch out for:
- [complaint - 1 line]
- [complaint - 1 line]

Verdict: [1 honest sentence]
Reviews pulled from last 6 months only"`;

// ============================================================
// INTENT CLASSIFIER (Haiku — fast + cheap)
// ============================================================
const CLASSIFIER_PROMPT = `Classify the user SMS into EXACTLY ONE category. Respond with ONLY the category name, nothing else.

Categories:
- greeting (hi, hello, hey, what can you do, help, start)
- product (ONE specific product to buy, e.g. "winter boots", "baby formula")
- grocery (a list of 2+ grocery/household items)
- recipe (wants to cook or bake something, mentions a dish)
- local_maker (homemade, handmade, artisan, crafts, handcrafted)
- service (mechanic, salon, massage, cleaner, daycare, groomer, tutor, handyman)
- restaurant (food, places to eat, takeout, delivery, dinner, lunch)
- event (markets, festivals, fundraisers, events, things to do)
- review (asking for reviews, ratings, "is X any good")
- other (follow-ups like "yes", "1", "more", city responses, anything unclear)`;

async function classifyIntent(message) {
  try {
    const response = await callClaudeWithRetry({
      model: ROUTER_MODEL,
      max_tokens: 15,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: message }]
    });
    const text = response.content[0]?.text?.trim().toLowerCase() || "other";
    const category = text.split(/\s+/)[0].replace(/[^a-z_]/g, "");
    const valid = [
      "greeting", "product", "grocery", "recipe", "local_maker",
      "service", "restaurant", "event", "review", "other"
    ];
    return valid.includes(category) ? category : "other";
  } catch (err) {
    console.error("Classifier error:", err.message);
    return "other"; // safe fallback
  }
}

// ============================================================
// AGENT DISPATCHER
// ============================================================
const AGENT_CONFIG = {
  product:     { prompt: PRODUCT_PROMPT,     tools: [WEB_SEARCH_TOOL] },
  grocery:     { prompt: GROCERY_PROMPT,     tools: [WEB_SEARCH_TOOL] },
  recipe:      { prompt: RECIPE_PROMPT,      tools: [WEB_SEARCH_TOOL] },
  local_maker: { prompt: LOCAL_MAKER_PROMPT, tools: [WEB_SEARCH_TOOL] },
  service:     { prompt: SERVICE_PROMPT,     tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL] },
  restaurant:  { prompt: RESTAURANT_PROMPT,  tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL] },
  event:       { prompt: EVENT_PROMPT,       tools: [WEB_SEARCH_TOOL] },
  review:      { prompt: REVIEW_PROMPT,      tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL] },
  // "other" = follow-ups; use product agent as a general fallback
  other:       { prompt: PRODUCT_PROMPT,     tools: [WEB_SEARCH_TOOL] }
};

async function routeAndRun(phone, userMessage) {
  const history = getHistory(phone);
  const intent = await classifyIntent(userMessage);
  console.log(`[${phone}] intent: ${intent}`);

  // Greeting — no AI call, canned response (saves $), no ack needed
  if (intent === "greeting") {
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: GREETING_RESPONSE });
    saveHistory(phone, history);
    return { text: GREETING_RESPONSE, __needsAck: false };
  }

  // Short follow-ups ("yes", "1", "more", city name) are quick — no ack needed
  const isFollowUp = intent === "other" || userMessage.trim().length < 15;

  const config = AGENT_CONFIG[intent] || AGENT_CONFIG.other;
  const result = await runAgent({
    systemPrompt: config.prompt,
    tools: config.tools,
    history,
    userMessage
  });
  saveHistory(phone, result.history);
  const text = result.text || "Scout couldn't find that one - try rephrasing and I'll look again!";
  return { text, __needsAck: !isFollowUp };
}

// ============================================================
// SMS TRIMMER + SENDER
// ============================================================
function trimToLimit(text) {
  if (text.length <= TWILIO_MAX_CHARS) return text;
  const trimmed = text.slice(0, TWILIO_MAX_CHARS);
  const lastNewline = trimmed.lastIndexOf("\n");
  const lastSpace = trimmed.lastIndexOf(" ");
  const cutAt = lastNewline > TWILIO_MAX_CHARS * 0.7 ? lastNewline : lastSpace;
  return trimmed.slice(0, cutAt).trimEnd() + "\n\n(Reply MORE for full details)";
}

async function sendSms(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body: trimToLimit(body)
  });
}

// ============================================================
// TWILIO SIGNATURE VALIDATION
// Set env var TWILIO_WEBHOOK_URL to your full public URL
// (e.g. https://pocketscout.up.railway.app/sms)
// Set SKIP_TWILIO_VALIDATION=true for local dev only.
// ============================================================
function validateTwilioSignature(req, res, next) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return next();

  const twilioSignature = req.headers["x-twilio-signature"];
  const url = process.env.TWILIO_WEBHOOK_URL;
  if (!twilioSignature || !url) {
    console.warn("Missing Twilio signature header or TWILIO_WEBHOOK_URL env var");
    return res.status(403).send("Forbidden");
  }
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body
  );
  if (!valid) {
    console.warn("Invalid Twilio signature - request rejected");
    return res.status(403).send("Forbidden");
  }
  next();
}

// ============================================================
// ADMIN AUTH (for DELETE /conversation)
// Set env var ADMIN_KEY and send as x-admin-key header or ?key=
// ============================================================
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ error: "Admin key not configured on server" });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ============================================================
// ROUTES
// ============================================================
app.post("/sms", validateTwilioSignature, async (req, res) => {
  // Respond to Twilio immediately so the webhook doesn't time out
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
      const reply = await routeAndRun(fromNumber, incomingMsg);

      // Only send the ack for real searches (greeting & follow-ups reply instantly,
      // so the ack would arrive AFTER the answer — confusing and wasteful).
      // routeAndRun stamps the intent on the result so we can check it here.
      if (reply.__needsAck) {
        try {
          await sendSms(fromNumber, "Scouting that for you now - reply coming shortly! 🔍");
        } catch (_) {}
      }

      await sendSms(fromNumber, reply.text ?? reply);
      console.log(`[${fromNumber}] <- sent (${(reply.text ?? reply).length} chars)`);
    } catch (err) {
      console.error(`Error [${fromNumber}]:`, err.message);
      try {
        await sendSms(fromNumber, "Scout hit a snag - try again in a moment!");
      } catch (_) {}
    } finally {
      releaseSlot();
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout",
    activeConversations: conversations.size,
    activeAiCalls: activeCount,
    waitingInQueue: waitingQueue.length,
    googlePlacesEnabled: !!process.env.GOOGLE_PLACES_API_KEY,
    twilioValidationEnabled: process.env.SKIP_TWILIO_VALIDATION !== "true"
  });
});

app.delete("/conversation/:phone", requireAdminKey, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const existed = conversations.delete(phone);
  res.json({ cleared: phone, existed });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  PocketScout SMS Server - Agents     ║
  ║  Listening on port ${String(PORT).padEnd(18)}║
  ║  POST /sms  -> Twilio webhook        ║
  ║  GET  /health -> status check        ║
  ╠══════════════════════════════════════╣
  ║  Agents: greeting, product, grocery, ║
  ║    recipe, local_maker, service,     ║
  ║    restaurant, event, review         ║
  ║  Google Places: ${(process.env.GOOGLE_PLACES_API_KEY ? "ENABLED " : "DISABLED").padEnd(21)}║
  ║  Twilio validation: ${(process.env.SKIP_TWILIO_VALIDATION === "true" ? "OFF " : "ON  ").padEnd(17)}║
  ╚══════════════════════════════════════╝
  `);
});
