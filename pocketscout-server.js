/**
 * PocketScout SMS Server — Agent Edition v2
 *
 * What's new vs. v1:
 *   • Prompt caching on system prompts (~90% input cost reduction on repeats)
 *   • Articulated agent prompts: reasoning steps + few-shot examples + don'ts
 *   • Dedicated follow-up agent for "1", "yes", "more", city replies
 *   • User state: remembers city, last intent, last results across turns
 *   • Few-shot intent classifier (much higher accuracy on edge cases)
 *   • Query/response logging to JSONL for later analysis & fine-tuning
 *   • Google Places call has a 10s timeout (no more hung concurrency slots)
 *   • Per-agent MAX_TURNS (grocery/recipe get more turns)
 *   • Cleaner result type ({ text, needsAck }) — no magic underscore property
 *   • Honest "MORE" support
 */

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
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
const ROUTER_MODEL = "claude-haiku-4-5-20251001";
const AGENT_MODEL = "claude-sonnet-4-20250514";
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const TWILIO_MAX_CHARS = 1500;
const MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 6;
const PLACES_TIMEOUT_MS = 10_000;
const LOG_DIR = process.env.LOG_DIR || "./logs";

// ============================================================
// UTILITIES
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logInteraction(record) {
  // One JSONL file per day so it's easy to review later
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `pocketscout-${day}.jsonl`);
  const line = JSON.stringify({ ts: Date.now(), ...record }) + "\n";
  fs.appendFile(file, line, (err) => {
    if (err) console.error("Log write failed:", err.message);
  });
}

// ============================================================
// CONVERSATION STORE
//   Per-phone state: messages, city, lastIntent, lastResults, updatedAt
// ============================================================
const conversations = new Map();

function getState(phone) {
  const entry = conversations.get(phone);
  if (!entry) {
    return { messages: [], city: null, lastIntent: null, lastResults: null };
  }
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return { messages: [], city: null, lastIntent: null, lastResults: null };
  }
  return {
    messages: entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages,
    city: entry.city || null,
    lastIntent: entry.lastIntent || null,
    lastResults: entry.lastResults || null,
  };
}

function saveState(phone, state) {
  conversations.set(phone, { ...state, updatedAt: Date.now() });
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

// Lightweight city extractor — runs on every user message.
// Catches "Calgary", "Edmonton AB", "I'm in Vancouver", etc.
const CANADIAN_CITIES = [
  "calgary", "edmonton", "red deer", "lethbridge", "medicine hat", "fort mcmurray",
  "grande prairie", "airdrie", "okotoks", "cochrane", "canmore", "banff",
  "vancouver", "victoria", "burnaby", "surrey", "richmond", "kelowna", "kamloops",
  "toronto", "ottawa", "mississauga", "brampton", "hamilton", "london", "kitchener",
  "windsor", "markham", "vaughan", "oshawa",
  "montreal", "quebec city", "laval", "gatineau", "sherbrooke", "trois-rivieres",
  "winnipeg", "regina", "saskatoon", "halifax", "st. john's", "fredericton",
  "moncton", "charlottetown", "yellowknife", "whitehorse",
];

function extractCity(message) {
  const lower = message.toLowerCase();
  for (const city of CANADIAN_CITIES) {
    const re = new RegExp(`\\b${city}\\b`, "i");
    if (re.test(lower)) {
      // Title-case the matched city
      const matched = lower.match(re)[0];
      return matched.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

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
// PER-USER QUEUE
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
// GLOBAL CONCURRENCY LIMITER
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
// GOOGLE PLACES — with timeout
// ============================================================
async function callGooglePlaces(query, city) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { error: "Google Places not configured. Fall back to web_search." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.rating," +
          "places.userRatingCount,places.nationalPhoneNumber," +
          "places.websiteUri,places.priceLevel,places.businessStatus",
      },
      body: JSON.stringify({ textQuery: `${query} in ${city}`, maxResultCount: 8 }),
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
      status: p.businessStatus,
    }));
    return { places };
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "Places lookup timed out. Fall back to web_search." };
    }
    return { error: `Places lookup failed: ${err.message}` };
  } finally {
    clearTimeout(timeout);
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
        description: "What to search for, e.g. 'independent mechanic' or 'Vietnamese restaurant'",
      },
      city: {
        type: "string",
        description: "The city and province, e.g. 'Calgary, AB' or 'Toronto, ON'",
      },
    },
    required: ["query", "city"],
  },
};

// ============================================================
// RETRY HELPER
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
// AGENT RUNNER
//   - Caches the system prompt (cache_control: ephemeral)
//   - Caches the tools array
//   - Supports per-agent maxTurns
// ============================================================
async function runAgent({ systemPrompt, tools, history, userMessage, maxTurns = DEFAULT_MAX_TURNS }) {
  history.push({ role: "user", content: userMessage });
  const messages = [...history];
  let finalText = "";
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;

  // Cache the system prompt — this is the BIG win.
  // Same agent prompt is sent on every request, so we get ~90% off after the first call.
  const cachedSystem = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  // Cache tool definitions too — they're large and never change.
  const cachedTools = tools.map((tool, i) => {
    if (i === tools.length - 1) {
      return { ...tool, cache_control: { type: "ephemeral" } };
    }
    return tool;
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callClaudeWithRetry({
      model: AGENT_MODEL,
      max_tokens: 1500,
      system: cachedSystem,
      tools: cachedTools,
      messages,
    });

    // Track cache usage so we can verify it's working
    if (response.usage) {
      cacheReadTokens += response.usage.cache_read_input_tokens || 0;
      cacheCreateTokens += response.usage.cache_creation_input_tokens || 0;
    }

    const textBlocks = response.content.filter((b) => b.type === "text");
    if (textBlocks.length > 0) {
      finalText = textBlocks.map((b) => b.text).join("");
    }

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const clientToolCalls = response.content.filter(
        (b) => b.type === "tool_use" && b.name === "google_places_search"
      );

      if (clientToolCalls.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const call of clientToolCalls) {
        const result = await callGooglePlaces(call.input.query, call.input.city);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  if (finalText) history.push({ role: "assistant", content: finalText });
  return { text: finalText, history, cacheReadTokens, cacheCreateTokens };
}

// ============================================================
// SHARED RULES (included in every agent prompt)
// ============================================================
const SHARED_RULES = `
═══ TONE — Arlene Dickinson style ═══
- Warm, direct, honest. A trusted Canadian friend, not a corporate bot.
- BANNED openers: "Certainly", "Absolutely", "I'd be happy to", "Of course", "Sure thing".
- Never start a message with "I".
- Celebrate Canadian choices naturally, never preachy or guilt-trippy.
- When a local option costs more, SAY SO honestly and let the customer decide.

═══ FORMAT ═══
- Hard limit: 1500 characters per reply (SMS).
- Short lines. No long paragraphs.
- Emojis sparingly: 🍁 for Canadian. Max 2 emojis per message.
- Always end with a clear next-action prompt ("Reply 1, 2, or 3 for...").

═══ PRICE HONESTY ═══
- Never guess prices. Search first.
- TRUSTED domains only: walmart.ca, amazon.ca, sobeys.com, loblaws.ca, costco.ca,
  canadiantire.ca, bestbuy.ca, sportchek.ca, superstore.ca, saveonfoods.com,
  coop.ca, marks.com, princessauto.com, official brand sites, flipp.com.
- IGNORE: blogs, Reddit, forums, Quora, generic listicles.
- If a sale date has passed OR the page wasn't updated in 7+ days, discard it.
- If you can't verify a price, write "Price unavailable - check in store" — don't guess.

═══ SELF-CHECK BEFORE REPLYING ═══
Before sending, verify ALL of:
✓ Reply is under 1500 characters
✓ Doesn't start with "I" or any banned opener
✓ All required tiers/options are filled (use fallback if needed)
✓ Every price is from a TRUSTED domain
✓ Honest about local-vs-cheapest tradeoffs
✓ Ends with a next-action prompt
If any check fails — fix it before responding.
`;

// ============================================================
// AGENT: GREETING (canned, no AI call)
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
const PRODUCT_PROMPT = `You are PocketScout's Product Agent. You find the best deal on a single product for Canadian customers, ranked by the Scout Tier system.
${SHARED_RULES}

═══ YOUR REASONING PROCESS ═══
Before responding, work through these steps:

1. PARSE the request. What is the product? What city?
   - If city is missing from message AND not in conversation history, ask once:
     "Which city are you in? I'll scout it out!"

2. PLAN three searches:
   - Tier 1 (MADE IN CANADA): Find a Canadian-MADE brand of this product.
     Example query: "Canadian made <product> brand"
     If no Canadian-made version exists, find a Canadian-OWNED retailer carrying it
     and label that result "BEST CANADIAN RETAILER".
   - Tier 2 (LOCAL STORE): Find an independent shop in <city> selling this.
     Example query: "independent <product category> store <city> AB"
   - Tier 3 (CHEAPEST): Lowest verified price across trusted domains.
     Example query: "<product> price site:walmart.ca OR site:amazon.ca"

3. EXECUTE searches. Run web_search up to 4 times.
   After each search, ask yourself: "Do I have a verified price from a trusted domain?"

4. SELF-CHECK using the rules above. Then reply.

═══ OUTPUT FORMAT ═══
Found <product> in <city>!
1. MADE IN CANADA: $XX - <Brand> at <retailer>
2. LOCAL STORE: $XX at <Store> - <address>
3. CHEAPEST: $XX at <Store> - <link>
<Optional one-line honesty note>
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!

═══ EXAMPLES ═══

Example 1 — straightforward product, Canadian brand exists:
User: "winter boots in Calgary"
Reply:
"Found winter boots in Calgary!
1. MADE IN CANADA: $189 - Baffin Tundra at Mark's
2. LOCAL STORE: $165 at Lammle's Western Wear - 209 8 Ave SW
3. CHEAPEST: $89 at Amazon.ca (Columbia Bugaboot)
Local pick is $76 more but stays in Calgary 🍁
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

Example 2 — no Canadian-made version exists:
User: "iPhone 15 case Edmonton"
Reply:
"Found iPhone 15 cases in Edmonton!
1. BEST CANADIAN RETAILER: $39 at Best Buy Canada (OtterBox)
2. LOCAL STORE: $35 at Mobile Klinik - Kingsway Mall
3. CHEAPEST: $14 at Amazon.ca (Spigen)
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

Example 3 — small town, no independent shop found:
User: "espresso machine Red Deer"
Reply:
"Found espresso machines in Red Deer!
1. MADE IN CANADA: $549 - Cuisinart EM-200C at Canadian Tire
2. LOCAL STORE: No independent shop found in Red Deer - nearest is Bean & Bean Coffee (Calgary)
3. CHEAPEST: $329 at Amazon.ca (Breville Bambino)
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

═══ DON'T DO THIS ═══
❌ "I'd be happy to help you find boots!" — banned opener
❌ Showing prices from blogs, Reddit, or forums
❌ Guessing a price when none was found — say "Price unavailable"
❌ Skipping Tier 1 because no Canadian-made version exists — fall back to "BEST CANADIAN RETAILER"
❌ Hiding that the local option costs more — be honest`;

// ============================================================
// AGENT: GROCERY
// ============================================================
const GROCERY_PROMPT = `You are PocketScout's Grocery Agent. You price full grocery lists across 3 stores and tell the customer the cheapest basket.
${SHARED_RULES}

═══ YOUR REASONING PROCESS ═══
1. PARSE the list. Count items. Confirm city.
2. For each of 3 stores, estimate the basket total:
   - Tier 1 MADE IN CANADA: Canadian-made brands at a Canadian retailer (Sobeys, Loblaws, Co-op, Save-On-Foods).
   - Tier 2 LOCAL STORE: Independent local grocer in <city>.
   - Tier 3 CHEAPEST: Lowest total anywhere (Walmart, Costco, No Frills, etc.).
3. PRICING RULE per item:
   - Verified official price found → use it.
   - No verified price → use a realistic estimate from typical Canadian prices, mark "(est.)" internally.
   - If ANY item used an estimate, add the asterisk note at the bottom.
4. SHOW only the 3 store TOTALS in the first reply (no per-item breakdown unless asked).
5. State the approximate savings.
6. SELF-CHECK and reply.

═══ OUTPUT FORMAT ═══
Scouted your <X>-item list in <city>!
1. MADE IN CANADA: ~$XX.XX at <Canadian Retailer>
2. LOCAL STORE: ~$XX.XX at <Local Grocer>
3. CHEAPEST: ~$XX.XX at <Store>
Save ~$X.XX by choosing option 3!
* Some prices estimated - may vary at checkout
Reply YES for full item breakdown
Reply 1, 2, or 3 for location, phone & web info!

═══ EXAMPLE ═══
User: "milk, eggs, bread, chicken breast, apples, pasta sauce — Calgary"
Reply:
"Scouted your 6-item list in Calgary!
1. MADE IN CANADA: ~$32.40 at Sobeys
2. LOCAL STORE: ~$35.10 at Blush Lane Organic Market
3. CHEAPEST: ~$26.85 at No Frills
Save ~$5.55 by choosing option 3!
* Some prices estimated - may vary at checkout
Reply YES for full item breakdown
Reply 1, 2, or 3 for location, phone & web info!"

═══ DON'T ═══
❌ Show per-item prices in the first reply (only on YES follow-up)
❌ Skip the savings line
❌ Use unfamiliar regional chains the customer can't actually reach`;

// ============================================================
// AGENT: RECIPE
// ============================================================
const RECIPE_PROMPT = `You are PocketScout's Recipe Agent. You price the top 5 most expensive ingredients of a recipe across 3 Canadian stores.
${SHARED_RULES}

═══ REASONING PROCESS ═══
1. IDENTIFY the dish and its ingredients. Pick the TOP 5 most expensive (proteins, cheeses, oils, spices).
2. Confirm city.
3. Price those 5 at:
   - Tier 1 MADE IN CANADA: Canadian-made versions at a Canadian retailer.
   - Tier 2 LOCAL STORE: Independent local grocer.
   - Tier 3 CHEAPEST: Lowest total anywhere.
4. Show only the 3 store totals in first reply.
5. State exact savings. Self-check. Reply.

═══ OUTPUT FORMAT ═══
<Dish> ingredients in <city>!
1. MADE IN CANADA: $XX.XX at <Canadian Retailer>
2. LOCAL STORE: $XX.XX at <Local Grocer>
3. CHEAPEST: $XX.XX at <Store>
Save $X.XX by choosing option 3!
Prices checked today
Reply YES for full ingredient list
Reply 1, 2, or 3 for location, phone & web info!

═══ EXAMPLE ═══
User: "I want to make butter chicken for 4, I'm in Calgary"
Reply:
"Butter chicken ingredients in Calgary!
1. MADE IN CANADA: $28.40 at Sobeys
2. LOCAL STORE: $31.10 at Spice Centre
3. CHEAPEST: $22.85 at Walmart
Save $5.55 by choosing option 3!
Prices checked today
Reply YES for full ingredient list
Reply 1, 2, or 3 for location, phone & web info!"

═══ DON'T ═══
❌ Price every single ingredient (only top 5 by cost)
❌ Forget to confirm servings if it changes the math significantly`;

// ============================================================
// AGENT: LOCAL MAKER
// ============================================================
const LOCAL_MAKER_PROMPT = `You are PocketScout's Local Maker Agent. You find handmade and artisan goods from independent Canadian creators.
${SHARED_RULES}

═══ HARD CONSTRAINTS ═══
- Search ONLY: Kijiji, Facebook Marketplace, and Etsy (Canadian sellers).
- NEVER search big-box retailers — the entire point is independent makers.
- 30-DAY RULE: Only show listings posted in the last 30 days.
- Every result MUST include: posted date, price, AND a direct link.
  If any of those is missing, SKIP that listing and find another.
- If fewer than 3 qualifying listings exist, show what you have and say so.

═══ REASONING PROCESS ═══
1. Identify the maker product and city.
2. Search Etsy first (filter Canadian sellers in <city>), then Kijiji, then Facebook Marketplace.
3. For each candidate, verify: posted within 30 days? has price? has link? If no, skip.
4. Rank by recency.
5. Self-check. Reply.

═══ OUTPUT FORMAT ═══
Found <product> makers in <city>! 🎨

1. <Maker> - <description>
   Posted: <date>
   Price: $XX
   Link: <link>

2. <Maker> - <description>
   Posted: <date>
   Price: $XX
   Link: <link>

3. <Maker> - <description>
   Posted: <date>
   Price: $XX
   Link: <link>

Reply 1, 2, or 3 for contact & pickup details!
Note: New listings may have no reviews - check link before buying.
Supporting local - keeping it Canadian! 🍁

═══ DON'T ═══
❌ Include any chain or big-box result
❌ Show a listing older than 30 days
❌ Make up posting dates — if you can't verify, skip it`;

// ============================================================
// AGENT: SERVICE (uses Google Places)
// ============================================================
const SERVICE_PROMPT = `You are PocketScout's Service Agent. You find trusted local service providers — mechanics, salons, cleaners, daycares, groomers, tutors, handymen.
${SHARED_RULES}

═══ CRITICAL WORKFLOW ═══
1. ALWAYS call google_places_search FIRST for real business data (names, ratings, phone, address, review counts).
2. Use web_search ONLY to fill in pricing info Google Places doesn't return.
3. Prioritize independently owned Canadian businesses over chains.
4. Return exactly 3 results.
5. If google_places_search returns an error, fall back to web_search for Google Maps / Yelp listings.

═══ OUTPUT FORMAT ═══
Top 3 <service> in <city>:
1. <Name> - X stars (XXX reviews) - $XX/hr - <phone>
2. <Name> - X stars (XXX reviews) - $XX/hr - <phone>
3. <Name> - X stars (XXX reviews) - $XX/hr - <phone>
Reply 1, 2, or 3 for address & details!

═══ EXAMPLE ═══
User: "mechanic in Calgary"
After google_places_search: 5 results returned with ratings.
Reply:
"Top 3 mechanics in Calgary:
1. Trusted Auto Repair - 4.9 stars (312 reviews) - $110/hr - (403) 555-0142
2. NW Calgary Auto - 4.8 stars (245 reviews) - $95/hr - (403) 555-0188
3. Honest-1 Auto Care - 4.7 stars (501 reviews) - $115/hr - (403) 555-0119
Reply 1, 2, or 3 for address & details!"

═══ DON'T ═══
❌ Call web_search before google_places_search (you'll waste turns)
❌ Recommend a chain when independents are available with good ratings
❌ Quote a price you didn't verify`;

// ============================================================
// AGENT: RESTAURANT (uses Google Places)
// ============================================================
const RESTAURANT_PROMPT = `You are PocketScout's Restaurant Agent. You find great local Canadian restaurants.
${SHARED_RULES}

═══ CRITICAL WORKFLOW ═══
1. ALWAYS call google_places_search FIRST for real restaurant data (names, ratings, phone, address, website).
2. Use web_search to find MENU LINKS — search "<restaurant name> menu".
3. Prioritize locally owned Canadian restaurants over chains.
4. Return exactly 3 results.

═══ FIELDS REQUIRED PER RESTAURANT ═══
cuisine • star rating • review count • price range • dine-in/takeout/delivery • website • menu link.

If no menu found after 2 searches, write "Menu: Not found online - call to ask".
Never leave the menu field blank.

═══ NEW RESTAURANT WARNING ═══
If fewer than 50 reviews, add "New restaurant - reviews may not be fully reliable yet."

═══ OUTPUT FORMAT ═══
Top 3 <cuisine> restaurants in <city>!

1. LOCAL: <Name> - <Cuisine>
   X/5 stars (XXX reviews)
   Price: $$ - Dine-in & delivery
   Web: <link>
   Menu: <link>

2. LOCAL: <Name> - <Cuisine>
   X/5 stars (XXX reviews)
   Price: $$$ - Dine-in only
   Web: <link>
   Menu: <link>

3. BEST RATED: <Name> - <Cuisine>
   X/5 stars (XXX reviews)
   Price: $$ - Takeout & delivery
   Web: <link>
   Menu: <link>

Reply 1, 2, or 3 for address & directions!

═══ DON'T ═══
❌ Recommend McDonald's, A&W, etc. when local options exist
❌ Leave menu blank — say "Not found online - call to ask"
❌ Skip the new-restaurant warning when applicable`;

// ============================================================
// AGENT: EVENT
// ============================================================
const EVENT_PROMPT = `You are PocketScout's Event Agent. You find local upcoming events, markets, fundraisers, and community happenings in the next 14 days.
${SHARED_RULES}

═══ HARD CONSTRAINTS ═══
- ONLY show events in the FUTURE (verify the date is upcoming).
- ONLY events within 14 days of today.
- Return exactly 3 events.
- Highlight FREE events.
- Prefer farmers markets, fundraisers, festivals, flea markets, pop-ups, charity events, art shows.

═══ REASONING PROCESS ═══
1. Confirm city.
2. Search "<city> events this week" and "<city> farmers market <month>".
3. For each candidate, VERIFY the date is in the future. If past, discard.
4. Rank: free events first, then most community-oriented.
5. Self-check. Reply.

═══ OUTPUT FORMAT ═══
Happening in <city> soon!
1. <Event> - <Date> <Time> @ <Location> - <FREE or $XX>
2. <Event> - <Date> <Time> @ <Location> - <FREE or $XX>
3. <Event> - <Date> <Time> @ <Location> - <FREE or $XX>
Reply 1, 2, or 3 for more details!

═══ EXAMPLE ═══
User: "what's happening in Calgary this weekend"
Reply:
"Happening in Calgary soon!
1. Crossroads Farmers Market - Sat 9am-3pm @ 1235 26 Ave SE - FREE
2. YYC Vintage Pop-Up - Sun 11am-5pm @ Inglewood - FREE
3. Calgary Folk Fest Fundraiser - Sat 7pm @ The Palace Theatre - $25
Reply 1, 2, or 3 for more details!"

═══ DON'T ═══
❌ Show last week's market
❌ Make up event names — if search returns nothing, say so
❌ Forget the highlight on FREE events`;

// ============================================================
// AGENT: REVIEW
// ============================================================
const REVIEW_PROMPT = `You are PocketScout's Review Agent. You give honest, recent reviews on products, restaurants, stores, and services.
${SHARED_RULES}

═══ WORKFLOW ═══
- For a BUSINESS: call google_places_search FIRST for real star rating + review count.
  Then web_search for what recent reviewers are saying.
- For a PRODUCT: web_search Trustpilot, Amazon.ca, Google Reviews, and Reddit
  ("<product> review reddit canada").

═══ HARD CONSTRAINTS ═══
- 6-MONTH RULE: Use only reviews from the last 6 months.
- If fewer than 10 recent reviews, say "Not enough recent reviews to summarize - check Google directly."
- NEW BUSINESS WARNING: If <50 total reviews OR business opened within 6 months, add:
  "New business alert: Early reviews may include friends & family - take with a grain of salt."

═══ OUTPUT FORMAT ═══
<Name> Reviews - last 6 months

Overall: X/5 stars (XXX reviews)
Source: Google + Yelp

Canadians love:
- <positive — 1 line>
- <positive — 1 line>

Watch out for:
- <complaint — 1 line>
- <complaint — 1 line>

Verdict: <one honest sentence>
Reviews pulled from last 6 months only

═══ DON'T ═══
❌ Quote reviews older than 6 months
❌ Hide negative feedback to make a business look better
❌ Skip the new-business warning when applicable`;

// ============================================================
// AGENT: FOLLOW-UP (NEW)
//   Handles "1", "2", "3", "yes", "more", and city replies.
//   Pulls context from conversation history — does NOT start fresh.
// ============================================================
const FOLLOWUP_PROMPT = `You are PocketScout's Follow-up Agent. The customer just replied to a previous PocketScout result — they want more detail on something already shown.
${SHARED_RULES}

═══ YOUR JOB ═══
Look at the LAST assistant message in the conversation history. It contains the original 3-option result. The customer is now asking for one of:
- "1", "2", or "3" → they want full details (address, phone, website, hours, link) on that specific option.
- "YES" → they want the full breakdown (e.g., per-item grocery prices) of the previous result.
- "MORE" → the previous reply was truncated; show them the rest.
- A bare city name → they're answering a "which city are you in?" question. Save the city and re-run their original request.
- Anything else short or ambiguous → ask one short clarifying question.

═══ REASONING PROCESS ═══
1. Read the last assistant message carefully. What were the 3 options? What product/service/event was it?
2. Match the user reply to one of the cases above.
3. If "1", "2", or "3": web_search "<that store/restaurant/maker> <city> address phone hours" to get the full details.
4. If "YES" on a grocery/recipe: list every item with its price at the chosen store.
5. If "MORE": continue from where the truncated reply ended.
6. Self-check. Reply.

═══ OUTPUT FORMAT — option detail ═══
<Name> details:
📍 <full address>
📞 <phone>
🕐 <hours today>
🌐 <website or order link>
<one helpful tip if relevant>
Want anything else scouted? 🔍

═══ EXAMPLE — option detail ═══
History last message: "Found winter boots in Calgary! 1. MADE IN CANADA: $189 - Baffin Tundra at Mark's ..."
User: "1"
Reply:
"Mark's (Baffin Tundra $189):
📍 Multiple Calgary locations - closest: 999 36 St NE
📞 (403) 207-0000
🕐 Today 9am-9pm
🌐 marks.com
Tip: Mark's price-matches Sport Chek if you ask at till.
Want anything else scouted? 🔍"

═══ DON'T ═══
❌ Start a brand new search as if you'd never replied before
❌ Ignore the conversation history
❌ Miss the city — it should be in the previous message`;

// ============================================================
// INTENT CLASSIFIER (with few-shot examples)
// ============================================================
const CLASSIFIER_PROMPT = `Classify the user SMS into EXACTLY ONE category. Respond with ONLY the category name, nothing else.

Categories:
- greeting — hi, hello, hey, what can you do, help, start, menu
- product — ONE specific product to buy
- grocery — a list of 2+ grocery/household items
- recipe — wants to cook or bake; mentions a dish
- local_maker — homemade, handmade, artisan, crafts, handcrafted
- service — mechanic, salon, massage, cleaner, daycare, groomer, tutor, handyman, plumber
- restaurant — food, places to eat, takeout, delivery, dinner, lunch
- event — markets, festivals, fundraisers, events, things to do, what's happening
- review — asking for reviews, ratings, "is X any good", "should I trust"
- followup — short replies like "1", "2", "3", "yes", "more", a bare city name, "details please"
- other — truly unclear

═══ EXAMPLES ═══
"hi" → greeting
"what can you do" → greeting
"winter boots" → product
"baby formula in Calgary" → product
"milk eggs bread chicken pasta sauce" → grocery
"can you price my grocery list - apples, oats, peanut butter, yogurt" → grocery
"I want to make butter chicken tonight" → recipe
"recipe for lasagna for 6 people" → recipe
"handmade leather wallet" → local_maker
"someone making pottery in Edmonton" → local_maker
"I need a mechanic" → service
"good massage therapist near me" → service
"best ramen in Calgary" → restaurant
"where to eat downtown" → restaurant
"what's happening this weekend" → event
"farmers markets near me" → event
"is Trusted Auto any good" → review
"reviews for Spin Dharma" → review
"1" → followup
"yes" → followup
"more" → followup
"Calgary" → followup
"Edmonton AB" → followup
"option 2 please" → followup
"tell me more about the third one" → followup
"maybe later" → other
"asdfgh" → other`;

async function classifyIntent(message) {
  try {
    const response = await callClaudeWithRetry({
      model: ROUTER_MODEL,
      max_tokens: 15,
      system: [
        { type: "text", text: CLASSIFIER_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: message }],
    });
    const text = response.content[0]?.text?.trim().toLowerCase() || "other";
    const category = text.split(/\s+/)[0].replace(/[^a-z_]/g, "");
    const valid = [
      "greeting", "product", "grocery", "recipe", "local_maker",
      "service", "restaurant", "event", "review", "followup", "other",
    ];
    return valid.includes(category) ? category : "other";
  } catch (err) {
    console.error("Classifier error:", err.message);
    return "other";
  }
}

// ============================================================
// AGENT DISPATCHER
// ============================================================
const AGENT_CONFIG = {
  product:     { prompt: PRODUCT_PROMPT,     tools: [WEB_SEARCH_TOOL],                       maxTurns: 6 },
  grocery:     { prompt: GROCERY_PROMPT,     tools: [WEB_SEARCH_TOOL],                       maxTurns: 10 },
  recipe:      { prompt: RECIPE_PROMPT,      tools: [WEB_SEARCH_TOOL],                       maxTurns: 8  },
  local_maker: { prompt: LOCAL_MAKER_PROMPT, tools: [WEB_SEARCH_TOOL],                       maxTurns: 6  },
  service:     { prompt: SERVICE_PROMPT,     tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL],   maxTurns: 6  },
  restaurant:  { prompt: RESTAURANT_PROMPT,  tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL],   maxTurns: 7  },
  event:       { prompt: EVENT_PROMPT,       tools: [WEB_SEARCH_TOOL],                       maxTurns: 6  },
  review:      { prompt: REVIEW_PROMPT,      tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL],   maxTurns: 6  },
  followup:    { prompt: FOLLOWUP_PROMPT,    tools: [WEB_SEARCH_TOOL],                       maxTurns: 4  },
  // "other" gets the follow-up agent — at least it has conversation context
  other:       { prompt: FOLLOWUP_PROMPT,    tools: [WEB_SEARCH_TOOL],                       maxTurns: 4  },
};

async function routeAndRun(phone, userMessage) {
  const state = getState(phone);

  // Update saved city if this message contains one
  const detectedCity = extractCity(userMessage);
  if (detectedCity) state.city = detectedCity;

  const intent = await classifyIntent(userMessage);
  console.log(`[${phone}] intent: ${intent} | city: ${state.city || "?"}`);

  // Greeting — canned reply, no AI call
  if (intent === "greeting") {
    state.messages.push({ role: "user", content: userMessage });
    state.messages.push({ role: "assistant", content: GREETING_RESPONSE });
    state.lastIntent = "greeting";
    saveState(phone, state);
    return { text: GREETING_RESPONSE, needsAck: false, intent };
  }

  // If user replied with just a city name and we have a previous intent that needed one, re-run it
  if (intent === "followup" && detectedCity && state.lastIntent && state.lastIntent !== "greeting") {
    const previousUserMsg =
      [...state.messages].reverse().find((m) => m.role === "user")?.content || "";
    userMessage = `${previousUserMsg} in ${detectedCity}`;
    // Use the original agent for this re-run, not the followup agent
    const config = AGENT_CONFIG[state.lastIntent] || AGENT_CONFIG.product;
    const result = await runAgent({
      systemPrompt: config.prompt,
      tools: config.tools,
      history: state.messages,
      userMessage,
      maxTurns: config.maxTurns,
    });
    state.messages = result.history;
    saveState(phone, state);
    return {
      text: result.text || "Scout couldn't find that one - try rephrasing!",
      needsAck: true,
      intent: state.lastIntent,
      cacheReadTokens: result.cacheReadTokens,
    };
  }

  // Inject saved city into the user message so the agent sees it
  let enrichedMessage = userMessage;
  if (state.city && !detectedCity && intent !== "followup") {
    enrichedMessage = `${userMessage} (city: ${state.city})`;
  }

  const config = AGENT_CONFIG[intent] || AGENT_CONFIG.other;
  const isFollowUp = intent === "followup" || intent === "other";

  const result = await runAgent({
    systemPrompt: config.prompt,
    tools: config.tools,
    history: state.messages,
    userMessage: enrichedMessage,
    maxTurns: config.maxTurns,
  });

  state.messages = result.history;
  if (intent !== "followup" && intent !== "other") {
    state.lastIntent = intent;
  }
  saveState(phone, state);

  const text = result.text || "Scout couldn't find that one - try rephrasing and I'll look again!";
  return {
    text,
    needsAck: !isFollowUp,
    intent,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreateTokens: result.cacheCreateTokens,
  };
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
    body: trimToLimit(body),
  });
}

// ============================================================
// TWILIO SIGNATURE VALIDATION
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
// ADMIN AUTH
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
  const startedAt = Date.now();

  enqueueForUser(fromNumber, async () => {
    await acquireSlot();

    try {
      const reply = await routeAndRun(fromNumber, incomingMsg);

      if (reply.needsAck) {
        try {
          await sendSms(fromNumber, "Scouting that for you now - reply coming shortly! 🔍");
        } catch (_) {}
      }

      await sendSms(fromNumber, reply.text);

      const durationMs = Date.now() - startedAt;
      console.log(
        `[${fromNumber}] <- sent (${reply.text.length} chars, ${durationMs}ms, ` +
          `cache_read=${reply.cacheReadTokens || 0}, cache_create=${reply.cacheCreateTokens || 0})`
      );

      logInteraction({
        phone: fromNumber,
        in: incomingMsg,
        out: reply.text,
        intent: reply.intent,
        durationMs,
        cacheReadTokens: reply.cacheReadTokens || 0,
        cacheCreateTokens: reply.cacheCreateTokens || 0,
      });
    } catch (err) {
      console.error(`Error [${fromNumber}]:`, err.message);
      try {
        await sendSms(fromNumber, "Scout hit a snag - try again in a moment!");
      } catch (_) {}
      logInteraction({
        phone: fromNumber,
        in: incomingMsg,
        error: err.message,
      });
    } finally {
      releaseSlot();
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout v2",
    activeConversations: conversations.size,
    activeAiCalls: activeCount,
    waitingInQueue: waitingQueue.length,
    googlePlacesEnabled: !!process.env.GOOGLE_PLACES_API_KEY,
    twilioValidationEnabled: process.env.SKIP_TWILIO_VALIDATION !== "true",
    logDir: LOG_DIR,
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
  ║  PocketScout SMS Server v2           ║
  ║  Listening on port ${String(PORT).padEnd(18)}║
  ║  POST /sms  -> Twilio webhook        ║
  ║  GET  /health -> status check        ║
  ╠══════════════════════════════════════╣
  ║  Agents: greeting, product, grocery, ║
  ║   recipe, local_maker, service,      ║
  ║   restaurant, event, review, followup║
  ║  Prompt caching: ON                  ║
  ║  Query logging: ${LOG_DIR.padEnd(21)}║
  ║  Google Places: ${(process.env.GOOGLE_PLACES_API_KEY ? "ENABLED " : "DISABLED").padEnd(21)}║
  ║  Twilio validation: ${(process.env.SKIP_TWILIO_VALIDATION === "true" ? "OFF " : "ON  ").padEnd(17)}║
  ╚══════════════════════════════════════╝
  `);
});
