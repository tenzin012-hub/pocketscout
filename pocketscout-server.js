/**
 * PocketScout SMS Server — Agent Edition v6
 *
 * What's new vs. v5:
 *   • Date-aware event search: current date/time injected into Event agent prompt
 *     at request time so Claude knows the actual 14-day window
 *   • Per-city timezone awareness (Calgary = America/Edmonton, etc.)
 *   • Post-reply date validation: parses dates from event replies and flags any
 *     that fall in the past
 *   • Date hints added to the search queries themselves
 *
 * Carried from v5:
 *   • Parallel tool execution, quality fallback, neighbourhood radius,
 *     scout-tier check, prompt caching
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
const CONVERSATION_TTL_MS = 3 * 60 * 60 * 1000;
const TWILIO_MAX_CHARS = 1500;
const MAX_CONCURRENT = 5;
const DEFAULT_MAX_TURNS = 6;
const PLACES_TIMEOUT_MS = 10_000;
const GEOCODE_TIMEOUT_MS = 5_000;
const NEIGHBOURHOOD_RADIUS_M = 5_000; // 5 km ≈ 5–10 min drive
const WIDER_RADIUS_M = 12_000; // 12 km fallback when nothing good nearby
const DEFAULT_MIN_RATING = 4.0; // quality bar for restaurants/services
const DEFAULT_MIN_REVIEWS = 20; // ignore places with too few reviews
const LOG_DIR = process.env.LOG_DIR || "./logs";

// ============================================================
// UTILITIES
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logInteraction(record) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `pocketscout-${day}.jsonl`);
  const line = JSON.stringify({ ts: Date.now(), ...record }) + "\n";
  fs.appendFile(file, line, (err) => {
    if (err) console.error("Log write failed:", err.message);
  });
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ============================================================
// GEOCODE CACHE — neighbourhoods don't move, cache forever
// ============================================================
const geocodeCache = new Map();

async function geocodeNeighbourhood(neighbourhood, city) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return null;
  const key = `${neighbourhood.toLowerCase()}|${city.toLowerCase()}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "places.location,places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({
        textQuery: `${neighbourhood}, ${city}`,
        maxResultCount: 1,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const place = data.places?.[0];
    if (!place?.location) return null;
    const coords = {
      lat: place.location.latitude,
      lng: place.location.longitude,
      label: place.displayName?.text || neighbourhood,
    };
    geocodeCache.set(key, coords);
    return coords;
  } catch (err) {
    console.error(`Geocode failed for "${neighbourhood}, ${city}":`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// CONVERSATION STORE
// ============================================================
const conversations = new Map();

function getState(phone) {
  const entry = conversations.get(phone);
  if (!entry) {
    return {
      messages: [],
      city: null,
      neighbourhood: null,
      lastIntent: null,
      lastResults: null,
    };
  }
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return {
      messages: [],
      city: null,
      neighbourhood: null,
      lastIntent: null,
      lastResults: null,
    };
  }
  return {
    messages: entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages,
    city: entry.city || null,
    neighbourhood: entry.neighbourhood || null,
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
      const matched = lower.match(re)[0];
      return matched.replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  return null;
}

// ============================================================
// CITY → TIMEZONE
//   Used for event filtering — "tonight in Calgary" means
//   tonight in Mountain Time, not server time (UTC on Railway).
// ============================================================
const CITY_TIMEZONES = {
  // Mountain
  calgary: "America/Edmonton",
  edmonton: "America/Edmonton",
  "red deer": "America/Edmonton",
  lethbridge: "America/Edmonton",
  "medicine hat": "America/Edmonton",
  "fort mcmurray": "America/Edmonton",
  "grande prairie": "America/Edmonton",
  airdrie: "America/Edmonton",
  okotoks: "America/Edmonton",
  cochrane: "America/Edmonton",
  canmore: "America/Edmonton",
  banff: "America/Edmonton",
  yellowknife: "America/Yellowknife",
  whitehorse: "America/Whitehorse",
  // Pacific
  vancouver: "America/Vancouver",
  victoria: "America/Vancouver",
  burnaby: "America/Vancouver",
  surrey: "America/Vancouver",
  richmond: "America/Vancouver",
  kelowna: "America/Vancouver",
  kamloops: "America/Vancouver",
  // Central
  winnipeg: "America/Winnipeg",
  regina: "America/Regina",
  saskatoon: "America/Regina",
  // Eastern
  toronto: "America/Toronto",
  ottawa: "America/Toronto",
  mississauga: "America/Toronto",
  brampton: "America/Toronto",
  hamilton: "America/Toronto",
  london: "America/Toronto",
  kitchener: "America/Toronto",
  windsor: "America/Toronto",
  markham: "America/Toronto",
  vaughan: "America/Toronto",
  oshawa: "America/Toronto",
  montreal: "America/Toronto",
  "quebec city": "America/Toronto",
  laval: "America/Toronto",
  gatineau: "America/Toronto",
  sherbrooke: "America/Toronto",
  "trois-rivieres": "America/Toronto",
  // Atlantic
  halifax: "America/Halifax",
  fredericton: "America/Halifax",
  moncton: "America/Halifax",
  charlottetown: "America/Halifax",
  // Newfoundland
  "st. john's": "America/St_Johns",
};

function timezoneFor(city) {
  if (!city) return "America/Edmonton"; // sensible default for SAIT/Calgary
  return CITY_TIMEZONES[city.toLowerCase()] || "America/Edmonton";
}

// Build a human-readable "now" string in the city's local timezone.
// Returns:
//   { now, today, in14days, label }
function buildDateContext(city) {
  const tz = timezoneFor(city);
  const now = new Date();
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const fmtTime = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const fmtShort = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const todayStr = fmtDate.format(now);
  const timeStr = fmtTime.format(now);

  const in14 = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const in14Str = fmtShort.format(in14);
  const todayShort = fmtShort.format(now);

  return {
    nowLabel: `${todayStr}, ${timeStr} (${tz}${city ? `, ${city}` : ""})`,
    todayShort, // e.g. "May 2, 2026"
    in14Short: in14Str, // e.g. "May 16, 2026"
    timezone: tz,
    nowMs: now.getTime(),
    in14Ms: in14.getTime(),
  };
}

// Parse a date string from an agent reply. Returns Date or null.
// Handles "Sat May 4", "May 4 7pm", "Saturday May 4 2026", etc.
function parseDateFromText(text, referenceYear) {
  const monthMap = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  };
  // Match patterns like "May 4", "May 4 2026", "Sat May 4"
  const re = /\b([A-Z][a-z]{2,8})\s+(\d{1,2})(?:[,\s]+(\d{4}))?/;
  const m = text.match(re);
  if (!m) return null;
  const monthName = m[1].toLowerCase().slice(0, 4);
  const monthIdx =
    monthMap[monthName] !== undefined
      ? monthMap[monthName]
      : monthMap[m[1].toLowerCase().slice(0, 3)];
  if (monthIdx === undefined) return null;
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : referenceYear;
  if (day < 1 || day > 31) return null;
  return new Date(year, monthIdx, day);
}

// Validate that all event dates in a reply are in the future.
// Returns { ok, pastEventLines } where pastEventLines lists offending lines.
function validateEventDates(replyText, dateContext) {
  if (!replyText) return { ok: true, pastEventLines: [] };
  const lines = replyText.split("\n");
  const pastLines = [];
  // Only check lines that look like event entries (numbered list items)
  const eventLineRe = /^\s*\d+\.\s/;
  const referenceYear = new Date(dateContext.nowMs).getFullYear();
  const todayStart = new Date(dateContext.nowMs);
  todayStart.setHours(0, 0, 0, 0);

  for (const line of lines) {
    if (!eventLineRe.test(line)) continue;
    const parsed = parseDateFromText(line, referenceYear);
    if (!parsed) continue; // couldn't parse — don't false-flag
    if (parsed.getTime() < todayStart.getTime()) {
      pastLines.push(line.trim());
    }
  }
  return { ok: pastLines.length === 0, pastEventLines: pastLines };
}

// Detect a neighbourhood reference. We don't try to know every neighbourhood —
// we look for linguistic patterns that signal "the user named an area".
// Google Places handles the rest when we pass the matched string.
function extractNeighbourhood(message) {
  const patterns = [
    /\b(?:near|in|around|by|close to)\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})/,
    /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\s+(?:area|neighbourhood|neighborhood|district)\b/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (CANADIAN_CITIES.includes(candidate.toLowerCase())) continue;
      if (candidate.length < 4) continue;
      return candidate;
    }
  }
  return null;
}

// ============================================================
// DUPLICATE FILTER
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
// PER-USER QUEUE & CONCURRENCY LIMITER
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
// GOOGLE PLACES — neighbourhood-aware + quality-aware
//
// Strategy:
//   1. Search the tight neighbourhood radius
//   2. Filter to minRating + minReviewCount
//   3. If nothing qualifies, widen to WIDER_RADIUS_M and try again
//   4. Return a `widened: true` flag so the agent can be honest with the user
// ============================================================
async function placesRequest(textQuery, bias) {
  const body = { textQuery, maxResultCount: 10 };
  if (bias) body.locationBias = bias;

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
          "places.websiteUri,places.priceLevel,places.businessStatus," +
          "places.location",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { error: `Places API error: ${response.status}` };
    const data = await response.json();
    return { places: data.places || [] };
  } catch (err) {
    if (err.name === "AbortError") {
      return { error: "Places lookup timed out." };
    }
    return { error: `Places lookup failed: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

function filterAndFormat(places, center, radiusM, minRating, minReviews) {
  // Distance filter
  let filtered = places.filter((p) => {
    if (!p.location) return false;
    if (!center) return true;
    const d = haversineMeters(
      center.latitude,
      center.longitude,
      p.location.latitude,
      p.location.longitude
    );
    return d <= radiusM;
  });

  // Quality filter
  filtered = filtered.filter((p) => {
    const rating = p.rating || 0;
    const reviews = p.userRatingCount || 0;
    return rating >= minRating && reviews >= minReviews;
  });

  // Sort by rating descending, then by review count descending
  filtered.sort((a, b) => {
    const ra = a.rating || 0;
    const rb = b.rating || 0;
    if (rb !== ra) return rb - ra;
    return (b.userRatingCount || 0) - (a.userRatingCount || 0);
  });

  return filtered.slice(0, 5).map((p) => {
    const distanceM = center && p.location
      ? Math.round(
          haversineMeters(
            center.latitude,
            center.longitude,
            p.location.latitude,
            p.location.longitude
          )
        )
      : null;
    return {
      name: p.displayName?.text,
      address: p.formattedAddress,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      phone: p.nationalPhoneNumber,
      website: p.websiteUri,
      priceLevel: p.priceLevel,
      status: p.businessStatus,
      distanceKm: distanceM != null ? +(distanceM / 1000).toFixed(1) : null,
    };
  });
}

async function callGooglePlaces(query, city, near, opts = {}) {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { error: "Google Places not configured. Fall back to web_search." };
  }

  const minRating = opts.minRating ?? DEFAULT_MIN_RATING;
  const minReviews = opts.minReviews ?? DEFAULT_MIN_REVIEWS;

  let center = null;
  let neighbourhoodLabel = null;
  if (near && city) {
    const coords = await geocodeNeighbourhood(near, city);
    if (coords) {
      center = { latitude: coords.lat, longitude: coords.lng };
      neighbourhoodLabel = coords.label;
      console.log(
        `   ↳ centred on ${coords.label} (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
      );
    } else {
      console.log(`   ↳ couldn't geocode "${near}, ${city}" — falling back to city-wide`);
    }
  }

  // Pass 1: tight radius around the neighbourhood
  const tightQuery = near ? `${query} near ${near}, ${city}` : `${query} in ${city}`;
  const tightBias = center
    ? { circle: { center, radius: NEIGHBOURHOOD_RADIUS_M } }
    : null;

  const r1 = await placesRequest(tightQuery, tightBias);
  if (r1.error) return r1;

  let formatted = filterAndFormat(
    r1.places,
    center,
    NEIGHBOURHOOD_RADIUS_M,
    minRating,
    minReviews
  );

  if (formatted.length >= 3 || !center) {
    return {
      places: formatted,
      radiusKm: NEIGHBOURHOOD_RADIUS_M / 1000,
      widened: false,
      neighbourhood: neighbourhoodLabel,
      minRating,
    };
  }

  // Pass 2: widen the radius — there weren't enough quality results nearby
  console.log(
    `   ↳ only ${formatted.length} qualifying results within ${NEIGHBOURHOOD_RADIUS_M / 1000}km — widening to ${WIDER_RADIUS_M / 1000}km`
  );
  const wideBias = { circle: { center, radius: WIDER_RADIUS_M } };
  const r2 = await placesRequest(`${query} in ${city}`, wideBias);
  if (r2.error) return r2;

  const widerFormatted = filterAndFormat(
    r2.places,
    center,
    WIDER_RADIUS_M,
    minRating,
    minReviews
  );

  if (widerFormatted.length === 0) {
    return {
      places: [],
      radiusKm: WIDER_RADIUS_M / 1000,
      widened: true,
      neighbourhood: neighbourhoodLabel,
      minRating,
      note:
        `No spots rated ${minRating}+ stars with ${minReviews}+ reviews found within ` +
        `${WIDER_RADIUS_M / 1000}km of ${near}. Tell the user honestly and offer to ` +
        `lower the rating bar or expand to all of ${city}.`,
    };
  }

  return {
    places: widerFormatted,
    radiusKm: WIDER_RADIUS_M / 1000,
    widened: true,
    neighbourhood: neighbourhoodLabel,
    minRating,
    note:
      `No spots rated ${minRating}+ within ${NEIGHBOURHOOD_RADIUS_M / 1000}km of ${near}. ` +
      `Showing ${minRating}+ rated spots within ${WIDER_RADIUS_M / 1000}km instead. ` +
      `Tell the user this clearly so they understand the drive distance.`,
  };
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" };

const GOOGLE_PLACES_TOOL = {
  name: "google_places_search",
  description:
    "Search for real local businesses, restaurants, or services in a Canadian city. " +
    "Returns business names, addresses, phones, websites, star ratings, review counts, " +
    "and distance from the neighbourhood centre. " +
    "If user mentions a neighbourhood ('Strathcona', 'Kensington', 'Beltline'), pass it " +
    "as `near` — results are filtered to a 5km radius. " +
    "If fewer than 3 spots within 5km meet the quality bar, the tool AUTOMATICALLY " +
    "widens to 12km and returns `widened: true` so you can tell the user honestly. " +
    "Use `minRating` to set the quality bar (default 4.0). For restaurants and services " +
    "use 4.0; for things where quality matters less you can lower it. " +
    "If even the wider search returns nothing, the tool returns places=[] with a note — " +
    "tell the user honestly and offer to lower the bar or widen further.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for, e.g. 'Italian pasta restaurant' or 'independent mechanic'",
      },
      city: {
        type: "string",
        description: "City and province, e.g. 'Calgary, AB' or 'Toronto, ON'",
      },
      near: {
        type: "string",
        description:
          "Optional neighbourhood/area within the city. Examples: 'Strathcona', " +
          "'Kensington', 'Beltline', 'Inglewood', 'Yaletown'. Omit if user did not " +
          "mention a specific area.",
      },
      minRating: {
        type: "number",
        description:
          "Minimum star rating to include (default 4.0). Use 4.0 for restaurants " +
          "and services. Lower (e.g. 3.5) only if the user explicitly wants more " +
          "options regardless of quality.",
      },
      minReviews: {
        type: "number",
        description:
          "Minimum review count to trust the rating (default 20). A 5-star rating " +
          "with only 2 reviews is unreliable. Lower this only if the user is looking " +
          "for new/hidden gem businesses.",
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
// ============================================================
async function runAgent({ systemPrompt, tools, history, userMessage, maxTurns = DEFAULT_MAX_TURNS }) {
  history.push({ role: "user", content: userMessage });
  const messages = [...history];
  let finalText = "";
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;

  const cachedSystem = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

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

      // PARALLEL EXECUTION
      // All client tool calls in this turn run concurrently. Promise.all waits
      // for the slowest one — total time = max(individual call times), not sum.
      // For 3 simultaneous Places lookups at ~2s each, that's ~2s total instead of ~6s.
      const parallelStart = Date.now();
      const toolResults = await Promise.all(
        clientToolCalls.map(async (call) => {
          const callStart = Date.now();
          const result = await callGooglePlaces(
            call.input.query,
            call.input.city,
            call.input.near,
            {
              minRating: call.input.minRating,
              minReviews: call.input.minReviews,
            }
          );
          const ms = Date.now() - callStart;
          console.log(
            `   ↳ places("${call.input.query}"${call.input.near ? ` near ${call.input.near}` : ""}) ${ms}ms`
          );
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(result),
          };
        })
      );
      const parallelMs = Date.now() - parallelStart;
      if (clientToolCalls.length > 1) {
        console.log(
          `   ↳ ran ${clientToolCalls.length} tools in parallel: ${parallelMs}ms total`
        );
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
// SCOUT TIER SAFETY CHECK
// ============================================================
const TIER_REQUIREMENTS = {
  product: {
    required: ["MADE IN CANADA", "BEST CANADIAN RETAILER"],
    requireOneOf: true,
    tier2: ["LOCAL STORE"],
    tier3: ["CHEAPEST"],
  },
  grocery: {
    required: ["MADE IN CANADA"],
    tier2: ["LOCAL STORE"],
    tier3: ["CHEAPEST"],
  },
  recipe: {
    required: ["MADE IN CANADA"],
    tier2: ["LOCAL STORE"],
    tier3: ["CHEAPEST"],
  },
  restaurant: {
    required: ["LOCAL:"],
    minLocalCount: 2,
  },
};

function checkScoutTiers(intent, replyText) {
  const rules = TIER_REQUIREMENTS[intent];
  if (!rules) return { ok: true };

  const issues = [];
  const upper = replyText.toUpperCase();

  if (rules.required) {
    if (rules.requireOneOf) {
      const hasAny = rules.required.some((m) => upper.includes(m.toUpperCase()));
      if (!hasAny) {
        issues.push(`Missing Tier 1 marker (one of: ${rules.required.join(", ")})`);
      }
    } else {
      for (const marker of rules.required) {
        if (!upper.includes(marker.toUpperCase())) {
          issues.push(`Missing Tier 1 marker: ${marker}`);
        }
      }
    }
  }

  if (rules.tier2) {
    const has = rules.tier2.some((m) => upper.includes(m.toUpperCase()));
    if (!has) issues.push(`Missing Tier 2 marker (${rules.tier2.join(" or ")})`);
  }

  if (rules.tier3) {
    const has = rules.tier3.some((m) => upper.includes(m.toUpperCase()));
    if (!has) issues.push(`Missing Tier 3 marker (${rules.tier3.join(" or ")})`);
  }

  if (rules.minLocalCount) {
    const matches = upper.match(/LOCAL:/g) || [];
    if (matches.length < rules.minLocalCount) {
      issues.push(`Only ${matches.length} LOCAL: marker(s), expected ${rules.minLocalCount}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ============================================================
// SHARED RULES
// ============================================================
const SHARED_RULES = `
═══ TONE — Arlene Dickinson style ═══
- Warm, direct, honest. A trusted Canadian friend, not a corporate bot.
- BANNED openers: "Certainly", "Absolutely", "I'd be happy to", "Of course", "Sure thing".
- Never start a message with "I".
- Celebrate Canadian choices naturally, never preachy.
- When a local option costs more, SAY SO honestly.

═══ FORMAT ═══
- Hard limit: 1500 characters per reply (SMS).
- Short lines. No long paragraphs.
- Emojis sparingly: 🍁 for Canadian. Max 2 per message.
- Always end with a clear next-action prompt.

═══ PRICE HONESTY ═══
- Never guess prices. Search first.
- TRUSTED domains only: walmart.ca, amazon.ca, sobeys.com, loblaws.ca, costco.ca,
  canadiantire.ca, bestbuy.ca, sportchek.ca, superstore.ca, saveonfoods.com,
  coop.ca, marks.com, princessauto.com, official brand sites, flipp.com.
- IGNORE: blogs, Reddit, forums, Quora, generic listicles.
- If a sale date has passed OR the page wasn't updated in 7+ days, discard it.
- If you can't verify, write "Price unavailable - check in store".

═══ LOCATION AWARENESS ═══
- If the user mentions a neighbourhood/area (e.g. "near Strathcona", "in Kensington",
  "around Inglewood", "by the Beltline"), pass it as the \`near\` field of
  google_places_search. Results are filtered to a 5km radius (~5-10 min drive).
- If no results come back within that radius, tell the user honestly and offer
  to widen the search to the full city.
- City and neighbourhood may also be remembered from earlier — check history first.

═══ PARALLEL SEARCHING — IMPORTANT ═══
When you need to run MULTIPLE independent searches, request them ALL in the
SAME turn (i.e. emit multiple tool_use blocks in one response). The runtime
executes them in parallel — total time = the slowest one, not the sum.

DO this:
  Turn 1: emit web_search("Italian pasta site:opentable.ca Strathcona") AND
          google_places_search(query="pasta", near="Strathcona") AND
          web_search("Trattoria Al Centro menu") all in ONE turn.

DON'T do this:
  Turn 1: web_search → wait
  Turn 2: google_places_search → wait
  Turn 3: web_search for menu → wait
This serial pattern is 3-5x slower for users.

Searches are independent if knowing the result of one wouldn't change the
others. The first Places search and a menu lookup ARE independent. A menu
lookup that depends on which restaurants Places returned is NOT — that one
must wait for the Places result first.

═══ SELF-CHECK BEFORE REPLYING ═══
✓ Reply under 1500 characters
✓ Doesn't start with "I" or banned opener
✓ All required tiers filled (use fallback if needed)
✓ Every price from a TRUSTED domain
✓ Honest about local-vs-cheapest
✓ If user named a neighbourhood, results are actually near it
✓ Ends with a next-action prompt
`;

// ============================================================
// AGENT PROMPTS
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

const PRODUCT_PROMPT = `You are PocketScout's Product Agent. You find the best deal on a single product for Canadian customers, ranked by the Scout Tier system.
${SHARED_RULES}

═══ REASONING ═══
1. Parse: product, city, neighbourhood (if any).
   If city missing AND not in history, ask "Which city are you in?"
2. Run all THREE tier searches IN PARALLEL — emit them in one turn:
   - web_search "Canadian made <product> brand" → for Tier 1
   - web_search "independent <product category> store <city>" → for Tier 2
   - web_search "<product> price site:walmart.ca OR site:amazon.ca" → Tier 3
   These three are independent. Batching them cuts response time by ~60%.
3. If a tier comes back empty, fall back:
   - Tier 1 empty → BEST CANADIAN RETAILER (Best Buy, Mark's, etc.)
   - Tier 2 empty → "No independent shop found"
4. Self-check and reply.

═══ OUTPUT FORMAT ═══
Found <product> in <city>!
1. MADE IN CANADA: $XX - <Brand> at <retailer>
2. LOCAL STORE: $XX at <Store> - <address>
3. CHEAPEST: $XX at <Store> - <link>
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!

═══ EXAMPLES ═══
Example — Canadian brand exists:
User: "winter boots in Calgary"
Reply:
"Found winter boots in Calgary!
1. MADE IN CANADA: $189 - Baffin Tundra at Mark's
2. LOCAL STORE: $165 at Lammle's - 209 8 Ave SW
3. CHEAPEST: $89 at Amazon.ca (Columbia Bugaboot)
Local pick is $76 more but stays in Calgary 🍁
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

Example — no Canadian-made version:
User: "iPhone 15 case Edmonton"
Reply:
"Found iPhone 15 cases in Edmonton!
1. BEST CANADIAN RETAILER: $39 at Best Buy Canada (OtterBox)
2. LOCAL STORE: $35 at Mobile Klinik - Kingsway Mall
3. CHEAPEST: $14 at Amazon.ca (Spigen)
Prices checked today
Reply 1, 2, or 3 for location, phone & web info!"

═══ DON'T ═══
❌ Banned opener
❌ Prices from blogs, Reddit, forums
❌ Guess a price
❌ Skip Tier 1 — fall back to BEST CANADIAN RETAILER
❌ Hide that local costs more`;

const GROCERY_PROMPT = `You are PocketScout's Grocery Agent. Price full grocery lists across 3 stores.
${SHARED_RULES}

═══ REASONING ═══
1. Parse list, count items, confirm city.
2. Run THREE store-total estimates IN PARALLEL — emit in one turn:
   - web_search "<each item> price site:sobeys.com" → Tier 1 total
   - web_search "<items> independent grocer <city>" → Tier 2 total
   - web_search "<each item> price site:walmart.ca" → Tier 3 total
   The three store totals are independent. Batching is ~60% faster.
3. Per item: verified price preferred; otherwise mark "(est.)" internally.
4. Show 3 totals. State savings. Self-check. Reply.

═══ OUTPUT FORMAT ═══
Scouted your <X>-item list in <city>!
1. MADE IN CANADA: ~$XX.XX at <Canadian Retailer>
2. LOCAL STORE: ~$XX.XX at <Local Grocer>
3. CHEAPEST: ~$XX.XX at <Store>
Save ~$X.XX by choosing option 3!
* Some prices estimated - may vary at checkout
Reply YES for full item breakdown
Reply 1, 2, or 3 for location, phone & web info!`;

const RECIPE_PROMPT = `You are PocketScout's Recipe Agent. Price the top 5 most expensive ingredients across 3 stores.
${SHARED_RULES}

═══ REASONING ═══
1. Identify dish. Pick TOP 5 most expensive ingredients.
2. Confirm city.
3. Price 5 ingredients at Tier 1 / 2 / 3 stores.
4. Show 3 totals. State savings.

═══ OUTPUT FORMAT ═══
<Dish> ingredients in <city>!
1. MADE IN CANADA: $XX.XX at <Canadian Retailer>
2. LOCAL STORE: $XX.XX at <Local Grocer>
3. CHEAPEST: $XX.XX at <Store>
Save $X.XX by choosing option 3!
Prices checked today
Reply YES for full ingredient list
Reply 1, 2, or 3 for location, phone & web info!`;

const LOCAL_MAKER_PROMPT = `You are PocketScout's Local Maker Agent.
${SHARED_RULES}

═══ HARD CONSTRAINTS ═══
- Search ONLY: Etsy (Canadian sellers), Kijiji, Facebook Marketplace.
- NEVER big-box retailers.
- 30-DAY RULE: Only listings posted in the last 30 days.
- Each result MUST include: posted date, price, AND link.
- If <3 qualifying listings, show what you have and say so.

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
Supporting local - keeping it Canadian! 🍁`;

const SERVICE_PROMPT = `You are PocketScout's Service Agent. Find trusted local service providers.
${SHARED_RULES}

═══ CRITICAL WORKFLOW ═══
1. ALWAYS call google_places_search FIRST with minRating: 4.0.
2. If user mentioned a neighbourhood, pass it as \`near\`.
3. Handle the three response states the same way as the Restaurant Agent:
   - widened: false → show top 3 nearby (5km).
   - widened: true with results → tell user honestly, show distance.
   - widened: true with empty places → ask whether to lower bar or widen further.
4. Use web_search ONLY for pricing info Places doesn't return.
5. Prioritize independents over chains.
6. Return exactly 3 results when you have them.

═══ OUTPUT FORMAT — normal ═══
Top 3 <service> near <neighbourhood>:
1. <Name> - X.X stars (XXX reviews) - $XX/hr - <phone>
2. <Name> - X.X stars (XXX reviews) - $XX/hr - <phone>
3. <Name> - X.X stars (XXX reviews) - $XX/hr - <phone>
Reply 1, 2, or 3 for address & details!

═══ OUTPUT FORMAT — widened ═══
No 4★+ <service> within 5km of <neighbourhood>.
Closest highly-rated:
1. <Name> - X.X stars (XXX reviews) - <distance>km - $XX/hr - <phone>
2. <Name> - X.X stars (XXX reviews) - <distance>km - $XX/hr - <phone>
3. <Name> - X.X stars (XXX reviews) - <distance>km - $XX/hr - <phone>
Reply 1, 2, or 3 for address & details!

═══ EXAMPLE — STATE B (widened) ═══
User: "mechanic near Inglewood Calgary"
Tool returns widened=true with 3 results 6-9km away.
Reply:
"No 4★+ mechanics within 5km of Inglewood.
Closest highly-rated:
1. Bridgeland Auto - 4.8 (210 reviews) - 6.2km - $98/hr - (403) 555-0142
2. North Hill Mechanics - 4.7 (340 reviews) - 7.5km - $105/hr - (403) 555-0188
3. East Calgary Service - 4.9 (180 reviews) - 8.8km - $110/hr - (403) 555-0119
Reply 1, 2, or 3 for address & details!"

═══ DON'T ═══
❌ Show 3-star options when 4-star options exist further away
❌ Skip \`near\` when user mentioned an area
❌ Quote unverified prices`;

const RESTAURANT_PROMPT = `You are PocketScout's Restaurant Agent.
${SHARED_RULES}

═══ CRITICAL WORKFLOW ═══
1. Turn 1: call google_places_search(minRating: 4.0) WITH the \`near\` field
   if user mentioned an area. (This must be alone — menu lookups depend on
   which restaurants come back.)
2. Turn 2: emit ALL THREE menu lookups IN PARALLEL in one turn:
   - web_search "<restaurant 1> menu"
   - web_search "<restaurant 2> menu"
   - web_search "<restaurant 3> menu"
   These three are independent. Batching them is ~3x faster than serial.
3. The Places tool may return one of three states — handle each honestly:

   STATE A — widened: false, places.length >= 3
     → Normal case. Show top 3 within the 5km radius.

   STATE B — widened: true, places.length >= 1
     → Nothing 4.0+ within 5km, but tool found 4.0+ within 12km.
     → BE HONEST: tell the user "no 4-star+ pasta within 5km of Strathcona,
       here's the closest highly-rated options."
     → Show distance for each option (the tool returns distanceKm).

   STATE C — widened: true, places.length === 0
     → Nothing 4.0+ within 12km either.
     → Don't pretend. Reply: "No 4-star+ pasta found within 12km of Strathcona.
       Want me to lower the rating bar or check elsewhere?"
     → Do NOT show 3-star results unless the user explicitly asks.

4. Prioritize locally owned over chains.
5. Return exactly 3 results when you have them.

═══ FIELDS PER RESTAURANT ═══
cuisine • star rating • review count • price range • dine-in/takeout/delivery • website • menu link.
If no menu found after 2 searches: "Menu: Not found online - call to ask".
If widened, also show: distance from <neighbourhood>.

═══ NEW RESTAURANT WARNING ═══
If <50 reviews: "New restaurant - reviews may not be fully reliable yet."

═══ OUTPUT FORMAT — STATE A (normal) ═══
Top 3 <cuisine> spots near <neighbourhood>!

1. LOCAL: <Name> - <Cuisine>
   X.X/5 (XXX reviews)
   Price: $$ - Dine-in & delivery
   Web: <link>
   Menu: <link>

2. LOCAL: <Name> - <Cuisine>
   ... same fields ...

3. BEST RATED: <Name> - <Cuisine>
   ... same fields ...

Reply 1, 2, or 3 for address & directions!

═══ OUTPUT FORMAT — STATE B (widened) ═══
No 4★+ <cuisine> within 5km of <neighbourhood> right now.
Closest highly-rated spots:

1. LOCAL: <Name> - <Cuisine> - <distance>km away
   X.X/5 (XXX reviews)
   Price: $$ - Dine-in & delivery
   Web: <link>
   Menu: <link>

2. LOCAL: <Name> - <Cuisine> - <distance>km away
   ... same fields ...

3. BEST RATED: <Name> - <Cuisine> - <distance>km away
   ... same fields ...

Reply 1, 2, or 3 for address & directions!

═══ OUTPUT FORMAT — STATE C (nothing qualifies) ═══
No 4★+ <cuisine> spots found within 12km of <neighbourhood>.
Want me to:
- Lower the rating bar (reply LOWER)
- Check a different neighbourhood (reply with the area)
- See top spots citywide (reply CITYWIDE)

═══ EXAMPLE — STATE A ═══
User: "best pasta near Strathcona Calgary"
Tool: google_places_search(query="Italian pasta restaurant", city="Calgary, AB", near="Strathcona", minRating: 4.0)
Tool returns: widened=false, 4 places all 4.5+ stars within 5km.
Reply:
"Top 3 pasta spots near Strathcona!

1. LOCAL: Trattoria Al Centro - Italian
   4.8/5 (245 reviews)
   Price: $$ - Dine-in & takeout
   Web: trattoriaalcentro.ca
   Menu: trattoriaalcentro.ca/menu

2. LOCAL: Pasta La Vista - Italian
   4.7/5 (180 reviews)
   Price: $$ - Dine-in only
   Web: pastalavista.ca
   Menu: Not found online - call to ask

3. BEST RATED: Nonna's Kitchen - Italian
   4.9/5 (510 reviews)
   Price: $$$ - Dine-in & delivery
   Web: nonnaskitchen.ca
   Menu: nonnaskitchen.ca/menu

Reply 1, 2, or 3 for address & directions!"

═══ EXAMPLE — STATE B (your scenario) ═══
User: "best pasta near Strathcona Calgary"
Tool: google_places_search(query="Italian pasta restaurant", city="Calgary, AB", near="Strathcona", minRating: 4.0)
Tool returns: widened=true, 3 places 4.0+ but distances 7-10km.
Reply:
"No 4★+ pasta within 5km of Strathcona right now.
Closest highly-rated spots:

1. LOCAL: Posto Italian - Italian - 7.2km away
   4.6/5 (340 reviews)
   Price: $$$ - Dine-in & delivery
   Web: postoitalian.ca
   Menu: postoitalian.ca/menu

2. LOCAL: Pulcinella - Italian - 8.1km away
   4.7/5 (620 reviews)
   Price: $$ - Dine-in & takeout
   Web: pulcinella.ca
   Menu: pulcinella.ca/menu

3. BEST RATED: Cibo - Italian - 9.4km away
   4.8/5 (890 reviews)
   Price: $$$ - Dine-in only
   Web: cibocalgary.com
   Menu: cibocalgary.com/menu

Reply 1, 2, or 3 for address & directions!"

═══ EXAMPLE — STATE C ═══
User: "best ethiopian near Banff"
Tool returns: widened=true, places=[].
Reply:
"No 4★+ Ethiopian spots found within 12km of Banff.
Want me to:
- Lower the rating bar (reply LOWER)
- Check Calgary instead (reply CALGARY)
- See top restaurants citywide (reply CITYWIDE)"

═══ DON'T ═══
❌ Show 3-star spots when 4-star exist further away — widen instead
❌ Show 3-star spots when nothing qualifies — be honest, ask the user
❌ Hide that an option is 8km away — always show distance when widened
❌ Skip \`near\` when user named an area
❌ Recommend McDonald's or chains when locals are available`;

// Event prompt is built per-request because it embeds the live date.
// The static portion is cached separately by Anthropic; the live portion
// is small so the cache hit rate stays high.
function buildEventPrompt(dateContext) {
  return `You are PocketScout's Event Agent.
${SHARED_RULES}

═══ CURRENT DATE & TIME ═══
RIGHT NOW: ${dateContext.nowLabel}
TODAY: ${dateContext.todayShort}
14-DAY WINDOW: ${dateContext.todayShort} through ${dateContext.in14Short}

This is the ground truth. Trust this over anything you see in search results.
If a search result page says "2024 Stampede" or "this Saturday at 9pm" without
a year, you must verify the year matches ${new Date(dateContext.nowMs).getFullYear()} before showing it.

═══ HARD CONSTRAINTS ═══
- ONLY events happening between TODAY (${dateContext.todayShort}) and ${dateContext.in14Short}.
- Past events are FORBIDDEN. Even if the page shows up first in search, discard it.
- If a search result has no clear date, discard it. Don't guess.
- If today's date is past an event's date, discard it.
- Return exactly 3 events.
- Highlight FREE events.
- Prefer farmers markets, fundraisers, festivals, pop-ups, charity events.

═══ SEARCH STRATEGY ═══
When you search, INCLUDE THE CURRENT MONTH AND YEAR in your queries:
  ✓ web_search "${dateContext.todayShort.split(",")[0]} farmers market <city>"
  ✓ web_search "<city> events this week ${new Date(dateContext.nowMs).getFullYear()}"
  ✓ web_search "<city> fundraiser ${dateContext.todayShort.split(",")[0]}"
  ✗ web_search "<city> events" (too vague — pulls old indexed pages)

Run multiple queries IN PARALLEL in one turn (see Parallel Searching rule).

═══ DATE VERIFICATION CHECK ═══
For EACH event you're considering, verify:
- Does the page or listing show a date?
- Is that date between ${dateContext.todayShort} and ${dateContext.in14Short}?
- If you're unsure of the year, search for confirmation before including it.
- Skip the event if any answer is no.

═══ OUTPUT FORMAT ═══
Happening in <city> soon!
1. <Event> - <Day, Month Date> <Time> @ <Location> - <FREE or $XX>
2. <Event> - <Day, Month Date> <Time> @ <Location> - <FREE or $XX>
3. <Event> - <Day, Month Date> <Time> @ <Location> - <FREE or $XX>
Reply 1, 2, or 3 for more details!

═══ EXAMPLE ═══
Right now: ${dateContext.nowLabel}
User: "what's happening in Calgary"
Reply (every date is between today and ${dateContext.in14Short}):
"Happening in Calgary soon!
1. Crossroads Farmers Market - Sat May 9 9am-3pm @ 1235 26 Ave SE - FREE
2. Inglewood Night Market - Thu May 14 5pm-10pm @ 9 Ave SE - FREE
3. YYC Food Truck Festival - Sun May 11 11am-7pm @ Eau Claire - $5
Reply 1, 2, or 3 for more details!"

═══ DON'T ═══
❌ Show "Calgary Stampede 2024" or any past-year event
❌ Include an event whose date you can't verify
❌ Use the year from the search result without confirming it matches ${new Date(dateContext.nowMs).getFullYear()}
❌ Show events more than 14 days out`;
}

const REVIEW_PROMPT = `You are PocketScout's Review Agent.
${SHARED_RULES}

═══ WORKFLOW ═══
- Business: google_places_search FIRST (pass \`near\` if neighbourhood given).
  Then web_search for recent reviews.
- Product: web_search Trustpilot, Amazon.ca, Google Reviews, Reddit Canada.

═══ HARD CONSTRAINTS ═══
- 6-MONTH RULE.
- <10 recent reviews → "Not enough recent reviews to summarize."
- <50 total reviews OR opened within 6 months → new-business warning.

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
Reviews pulled from last 6 months only`;

const FOLLOWUP_PROMPT = `You are PocketScout's Follow-up Agent.
${SHARED_RULES}

═══ YOUR JOB ═══
The customer is replying to a previous result. Look at the LAST assistant message
in history. Match their reply to:
- "1", "2", "3" → full details (address, phone, hours, website).
- "YES" → full breakdown (e.g. per-item grocery prices).
- "MORE" → continue truncated reply.
- A bare city/neighbourhood → answer to a "which area?" question. Save and re-run.
- Anything else short → ask one short clarifying question.

═══ OUTPUT FORMAT (option detail) ═══
<Name> details:
📍 <full address>
📞 <phone>
🕐 <hours today>
🌐 <website or order link>
<one helpful tip if relevant>
Want anything else scouted? 🔍`;

// ============================================================
// CLASSIFIER
// ============================================================
const CLASSIFIER_PROMPT = `Classify the user SMS into EXACTLY ONE category. Respond with ONLY the category name.

Categories:
- greeting — hi, hello, hey, what can you do, help, start, menu
- product — ONE specific product to buy
- grocery — list of 2+ grocery/household items
- recipe — wants to cook or bake; mentions a dish
- local_maker — homemade, handmade, artisan, crafts
- service — mechanic, salon, massage, cleaner, daycare, groomer, tutor, handyman
- restaurant — food, places to eat, takeout, delivery, dinner, lunch
- event — markets, festivals, fundraisers, things to do
- review — reviews, ratings, "is X any good"
- followup — "1", "2", "3", "yes", "more", a bare city/neighbourhood, "details"
- other — truly unclear

═══ EXAMPLES ═══
"hi" → greeting
"what can you do" → greeting
"winter boots" → product
"baby formula in Calgary" → product
"milk eggs bread chicken pasta sauce" → grocery
"price my list - apples oats peanut butter yogurt" → grocery
"I want to make butter chicken tonight" → recipe
"recipe for lasagna for 6" → recipe
"handmade leather wallet" → local_maker
"someone making pottery in Edmonton" → local_maker
"I need a mechanic" → service
"good massage near me" → service
"mechanic near Inglewood" → service
"best ramen in Calgary" → restaurant
"best pasta near Strathcona" → restaurant
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
"tell me about the third one" → followup
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
// DISPATCHER
// ============================================================
const AGENT_CONFIG = {
  product:     { prompt: PRODUCT_PROMPT,     tools: [WEB_SEARCH_TOOL],                     maxTurns: 6 },
  grocery:     { prompt: GROCERY_PROMPT,     tools: [WEB_SEARCH_TOOL],                     maxTurns: 10 },
  recipe:      { prompt: RECIPE_PROMPT,      tools: [WEB_SEARCH_TOOL],                     maxTurns: 8  },
  local_maker: { prompt: LOCAL_MAKER_PROMPT, tools: [WEB_SEARCH_TOOL],                     maxTurns: 6  },
  service:     { prompt: SERVICE_PROMPT,     tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL], maxTurns: 6  },
  restaurant:  { prompt: RESTAURANT_PROMPT,  tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL], maxTurns: 7  },
  // Event uses a per-request builder so the live date can be injected
  event:       { promptBuilder: buildEventPrompt, tools: [WEB_SEARCH_TOOL],                maxTurns: 6  },
  review:      { prompt: REVIEW_PROMPT,      tools: [WEB_SEARCH_TOOL, GOOGLE_PLACES_TOOL], maxTurns: 6  },
  followup:    { prompt: FOLLOWUP_PROMPT,    tools: [WEB_SEARCH_TOOL],                     maxTurns: 4  },
  other:       { prompt: FOLLOWUP_PROMPT,    tools: [WEB_SEARCH_TOOL],                     maxTurns: 4  },
};

async function routeAndRun(phone, userMessage) {
  const state = getState(phone);

  const detectedCity = extractCity(userMessage);
  if (detectedCity) state.city = detectedCity;

  const detectedNeighbourhood = extractNeighbourhood(userMessage);
  if (detectedNeighbourhood) state.neighbourhood = detectedNeighbourhood;

  const intent = await classifyIntent(userMessage);
  console.log(
    `[${phone}] intent=${intent} city=${state.city || "?"} hood=${state.neighbourhood || "-"}`
  );

  if (intent === "greeting") {
    state.messages.push({ role: "user", content: userMessage });
    state.messages.push({ role: "assistant", content: GREETING_RESPONSE });
    state.lastIntent = "greeting";
    saveState(phone, state);
    return { text: GREETING_RESPONSE, needsAck: false, intent };
  }

  if (
    intent === "followup" &&
    detectedCity &&
    state.lastIntent &&
    state.lastIntent !== "greeting"
  ) {
    const previousUserMsg =
      [...state.messages].reverse().find((m) => m.role === "user")?.content || "";
    userMessage = `${previousUserMsg} in ${detectedCity}`;
    const config = AGENT_CONFIG[state.lastIntent] || AGENT_CONFIG.product;
    const systemPrompt = config.promptBuilder
      ? config.promptBuilder(buildDateContext(detectedCity))
      : config.prompt;
    const result = await runAgent({
      systemPrompt,
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

  let enrichedMessage = userMessage;
  const additions = [];
  if (state.city && !detectedCity && intent !== "followup") {
    additions.push(`city: ${state.city}`);
  }
  if (state.neighbourhood && !detectedNeighbourhood && intent !== "followup") {
    additions.push(`near: ${state.neighbourhood}`);
  }
  if (additions.length) enrichedMessage = `${userMessage} (${additions.join(", ")})`;

  const config = AGENT_CONFIG[intent] || AGENT_CONFIG.other;
  const isFollowUp = intent === "followup" || intent === "other";

  // For agents that need live date context (event), build the prompt now.
  // For others, use the static prompt.
  let systemPrompt;
  let dateContext = null;
  if (config.promptBuilder) {
    dateContext = buildDateContext(state.city);
    systemPrompt = config.promptBuilder(dateContext);
    console.log(`[${phone}] event date context: ${dateContext.nowLabel}`);
  } else {
    systemPrompt = config.prompt;
  }

  const result = await runAgent({
    systemPrompt,
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

  const tierCheck = checkScoutTiers(intent, text);
  if (!tierCheck.ok) {
    console.warn(`[${phone}] ⚠ Scout Tier issues:`, tierCheck.issues);
  }

  // Date validation for events — flag any past dates in the reply
  let dateIssues = null;
  if (intent === "event" && dateContext) {
    const dateCheck = validateEventDates(text, dateContext);
    if (!dateCheck.ok) {
      console.warn(`[${phone}] ⚠ Past event dates detected:`, dateCheck.pastEventLines);
      dateIssues = dateCheck.pastEventLines;
    }
  }

  return {
    text,
    needsAck: !isFollowUp,
    intent,
    cacheReadTokens: result.cacheReadTokens,
    cacheCreateTokens: result.cacheCreateTokens,
    tierIssues: tierCheck.ok ? null : tierCheck.issues,
    dateIssues,
  };
}

// ============================================================
// SMS SENDER
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
// SECURITY MIDDLEWARE
// ============================================================
function validateTwilioSignature(req, res, next) {
  if (process.env.SKIP_TWILIO_VALIDATION === "true") return next();
  const twilioSignature = req.headers["x-twilio-signature"];
  const url = process.env.TWILIO_WEBHOOK_URL;
  if (!twilioSignature || !url) {
    console.warn("Missing Twilio signature header or TWILIO_WEBHOOK_URL");
    return res.status(403).send("Forbidden");
  }
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body
  );
  if (!valid) return res.status(403).send("Forbidden");
  next();
}

function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!process.env.ADMIN_KEY) {
    return res.status(503).json({ error: "Admin key not configured" });
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
          `cache_read=${reply.cacheReadTokens || 0}, tier_ok=${reply.tierIssues ? "no" : "yes"}` +
          `${reply.dateIssues ? ", date_ok=no" : ""})`
      );

      logInteraction({
        phone: fromNumber,
        in: incomingMsg,
        out: reply.text,
        intent: reply.intent,
        durationMs,
        cacheReadTokens: reply.cacheReadTokens || 0,
        cacheCreateTokens: reply.cacheCreateTokens || 0,
        tierIssues: reply.tierIssues,
        dateIssues: reply.dateIssues,
      });
    } catch (err) {
      console.error(`Error [${fromNumber}]:`, err.message);
      try {
        await sendSms(fromNumber, "Scout hit a snag - try again in a moment!");
      } catch (_) {}
      logInteraction({ phone: fromNumber, in: incomingMsg, error: err.message });
    } finally {
      releaseSlot();
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PocketScout v6",
    activeConversations: conversations.size,
    activeAiCalls: activeCount,
    waitingInQueue: waitingQueue.length,
    googlePlacesEnabled: !!process.env.GOOGLE_PLACES_API_KEY,
    twilioValidationEnabled: process.env.SKIP_TWILIO_VALIDATION !== "true",
    geocodeCacheSize: geocodeCache.size,
    logDir: LOG_DIR,
  });
});

app.delete("/conversation/:phone", requireAdminKey, (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const existed = conversations.delete(phone);
  res.json({ cleared: phone, existed });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  PocketScout SMS Server v6           ║
  ║  Port: ${String(PORT).padEnd(30)}║
  ║  Date-aware events: ON               ║
  ║  Parallel tool execution: ON         ║
  ║  Quality fallback: ON (4.0★ / 12km)  ║
  ║  Neighbourhood-aware: 5km radius     ║
  ║  Scout Tier safety check: ON         ║
  ║  Prompt caching: ON                  ║
  ║  Logs: ${LOG_DIR.padEnd(30)}║
  ╚══════════════════════════════════════╝
  `);
});
