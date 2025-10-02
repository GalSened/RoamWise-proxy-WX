// Updated: 2025-10-01T16:42:00Z
import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";
import rateLimit from "express-rate-limit";
import compression from "compression";
import helmet from "helmet";
import NodeCache from "node-cache";
import { body, validationResult } from "express-validator";
import winston from "winston";

const app = express();

// ✨ ADVANCED MIDDLEWARE & CACHING SYSTEM

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow external resources for maps
  crossOriginEmbedderPolicy: false // Allow embedding for PWA
}));

// Compression middleware
app.use(compression({
  threshold: 1024,
  level: 6,
  memLevel: 8
}));

// Enhanced logging with Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Rate limiting with different tiers
const createRateLimit = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { ok: false, error: message },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.ip === '127.0.0.1' // Skip localhost
});

// Different rate limits for different endpoints
const generalLimit = createRateLimit(15 * 60 * 1000, 100, "Too many requests");
const aiLimit = createRateLimit(60 * 1000, 10, "Too many AI requests");
const searchLimit = createRateLimit(60 * 1000, 30, "Too many search requests");

// Apply general rate limiting
app.use(generalLimit);

// In-memory cache system
const cache = new NodeCache({ 
  stdTTL: 300, // 5 minutes default
  checkperiod: 60, // Check for expired keys every minute
  useClones: false // Better performance
});

// Cache middleware generator
const cacheMiddleware = (ttl = 300) => (req, res, next) => {
  const key = `${req.method}:${req.originalUrl}:${JSON.stringify(req.body)}`;
  const cached = cache.get(key);
  
  if (cached) {
    logger.info(`Cache hit: ${key}`);
    return res.json(cached);
  }
  
  // Store original json method
  const originalJson = res.json;
  res.json = function(body) {
    // Cache successful responses only
    if (body.ok) {
      cache.set(key, body, ttl);
      logger.info(`Cached response: ${key}`);
    }
    return originalJson.call(this, body);
  };
  
  next();
};

// Request validation middleware
const validateRequest = (validations) => [
  ...validations,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn(`[${req.id}] Validation failed:`, errors.array());
      return res.status(400).json({
        ok: false,
        code: 'invalid_request',
        message: 'Validation failed',
        details: errors.array()
      });
    }
    next();
  }
];

// Enhanced error handling middleware
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Request ID middleware for tracking
app.use((req, res, next) => {
  req.id = Math.random().toString(36).substr(2, 9);
  res.setHeader('X-Request-ID', req.id);
  logger.info(`[${req.id}] ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

app.use(express.json({ limit:'1mb' }));
app.use(morgan("combined", { stream: { write: message => logger.info(message.trim()) } }));

// Environment
const GMAPS_KEY = process.env.GMAPS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!GMAPS_KEY) { console.error("Missing GMAPS_KEY env"); process.exit(1); }

// CORS: limit to your GitHub Pages origin(s)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length===0) return cb(null, true);
    return ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"));
  }
}));

// Helpers
const g = (u) => `https://maps.googleapis.com${u}${u.includes("?") ? "&" : "?"}key=${GMAPS_KEY}`;
const ok = (res, data) => res.json({ ok:true, ...data });
const err = (res, code, msg) => res.status(code).json({ ok:false, error: msg });

// ---- Provider Stubs (no external API calls) ----
async function stubSearchPlaces(query, location) {
  // Stub: return mock places for the query
  return [
    { id: 'place-1', name: `${query} Spot A`, rating: 4.5, category: 'attraction' },
    { id: 'place-2', name: `${query} Spot B`, rating: 4.2, category: 'restaurant' }
  ];
}

async function stubGetWeather(lat, lon, ts) {
  // Stub: return mock weather
  return { temp: 22, conditions: 'sunny', humidity: 60 };
}

async function stubGetRouteSummary(waypoints) {
  // Stub: return mock route
  return {
    distance: waypoints.length * 5,
    duration: waypoints.length * 15,
    polyline: 'mock_polyline_stub'
  };
}

// ---- Guardrails Middleware ----
const MAX_INTERESTS = 50;
const MAX_BUDGET = 100000;

function plannerGuardrails(req, res, next) {
  const { preferences, startLocation } = req.body;

  // Semantic checks (after express-validator passes)
  try {
    // Check coordinates are valid and not zero-zero
    if (startLocation.lat === 0 && startLocation.lng === 0) {
      return res.status(422).json({
        ok: false,
        code: 'coords_invalid',
        message: 'Coordinates cannot be (0, 0) - null island'
      });
    }

    // Check budget is reasonable
    if (preferences.budget && preferences.budget > MAX_BUDGET) {
      return res.status(422).json({
        ok: false,
        code: 'budget_out_of_bounds',
        message: `Budget cannot exceed ${MAX_BUDGET}`
      });
    }

    // Check interests array is not empty
    if (!preferences.interests || preferences.interests.length === 0) {
      return res.status(422).json({
        ok: false,
        code: 'interests_required',
        message: 'At least one interest is required'
      });
    }

    // Normalize coordinates to 6 decimals for cache deduplication
    startLocation.lat = Number(startLocation.lat.toFixed(6));
    startLocation.lng = Number(startLocation.lng.toFixed(6));

    // Attach sanitized payload
    req.planPayload = { preferences, startLocation };
    next();
  } catch (error) {
    logger.error(`[${req.id}] Guardrails check failed:`, error);
    return res.status(400).json({
      ok: false,
      code: 'validation_error',
      message: 'Request validation failed'
    });
  }
}

// ---- /places ---- (Enhanced with caching and validation)
app.post("/places", 
  searchLimit,
  cacheMiddleware(600), // Cache for 10 minutes
  validateRequest([
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
    body('radius').optional().isInt({ min: 100, max: 50000 }).withMessage('Radius must be 100-50000m'),
    body('minRating').optional().isFloat({ min: 0, max: 5 }).withMessage('Rating must be 0-5')
  ]),
  asyncHandler(async (req, res) => {
    const { lat, lng, openNow=true, radius=4500, language='he', type='point_of_interest', keyword='', minRating=0, maxResults=12 } = req.body || {};
    logger.info(`[${req.id}] Places search: ${lat},${lng} radius:${radius}`);
    const p = new URLSearchParams({ location:`${lat},${lng}`, radius:String(radius), language, type });
    if (openNow) p.set("opennow","true");
    if (keyword) p.set("keyword", keyword);
    const r = await fetch(g(`/maps/api/place/nearbysearch/json?${p}`));
    const j = await r.json();
    if (!["OK","ZERO_RESULTS"].includes(j.status)) return err(res, 400, `Places: ${j.status}`);
    const items = (j.results||[]).filter(x => (x.rating||0) >= minRating).slice(0, maxResults).map(x => ({
      id:x.place_id, name:x.name, address: x.vicinity || x.formatted_address || "",
      rating:x.rating, userRatingsTotal:x.user_ratings_total,
      lat:x.geometry?.location?.lat, lng:x.geometry?.location?.lng,
      openNow:x.opening_hours?.open_now ?? null
    }));
    ok(res, { items });
  })
);

// ---- /place-details ----
app.post("/place-details", async (req, res) => {
  try {
    const { placeId, language='he' } = req.body || {};
    if (!placeId) return err(res, 400, "placeId required");
    const fields = ["name","formatted_address","formatted_phone_number","opening_hours","website","url","geometry","rating","user_ratings_total"].join(",");
    const r = await fetch(g(`/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&language=${language}&fields=${fields}`));
    const j = await r.json();
    if (j.status !== "OK") return err(res, 400, `Details: ${j.status}`);
    ok(res, { details: j.result });
  } catch(e){ err(res, 500, String(e)); }
});

// ---- /autocomplete ----
app.post("/autocomplete", async (req, res) => {
  try {
    const { input, language='he', sessionToken='' } = req.body || {};
    if (!input) return err(res, 400, "input required");
    const p = new URLSearchParams({ input, language });
    if (sessionToken) p.set("sessiontoken", sessionToken);
    const r = await fetch(g(`/maps/api/place/autocomplete/json?${p}`));
    const j = await r.json();
    if (!["OK","ZERO_RESULTS"].includes(j.status)) return err(res, 400, `Autocomplete: ${j.status}`);
    ok(res, { predictions: j.predictions || [] });
  } catch(e){ err(res, 500, String(e)); }
});

// ---- /geocode ----
app.post("/geocode", async (req, res) => {
  try {
    const { query, language='he' } = req.body || {};
    if (!query) return err(res, 400, "query required");
    const r = await fetch(g(`/maps/api/geocode/json?address=${encodeURIComponent(query)}&language=${language}`));
    const j = await r.json();
    if (j.status !== "OK" || !j.results?.length) return err(res, 404, "not found");
    const r0 = j.results[0];
    ok(res, { result: { address: r0.formatted_address, lat: r0.geometry?.location?.lat, lng: r0.geometry?.location?.lng, placeId: r0.place_id } });
  } catch(e){ err(res, 500, String(e)); }
});

// ---- /route ----
app.post("/route", async (req, res) => {
  try {
    const { origin, dest, mode='driving', language='he' } = req.body || {};
    if (!origin?.lat || !origin?.lng || !dest?.lat || !dest?.lng) return err(res, 400, "origin/dest lat/lng required");
    const p = new URLSearchParams({ origin: `${origin.lat},${origin.lng}`, destination: `${dest.lat},${dest.lng}`, mode, language, departure_time: "now" });
    const r = await fetch(g(`/maps/api/directions/json?${p}`));
    const j = await r.json();
    if (j.status !== "OK") return err(res, 400, `Directions: ${j.status}`);
    const route = j.routes?.[0]; const leg = route?.legs?.[0];
    ok(res, {
      summary: route?.summary,
      distanceText: leg?.distance?.text,
      durationText: leg?.duration_in_traffic?.text || leg?.duration?.text,
      startAddress: leg?.start_address,
      endAddress: leg?.end_address,
      polyline: route?.overview_polyline?.points
    });
  } catch(e){ err(res, 500, String(e)); }
});

// ---- /think (ChatGPT NLU) ----
app.post("/think", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return err(res, 500, "missing OPENAI_API_KEY");
    const { text, context } = req.body || {};
    if (!text) return err(res, 400, "text required");

    const systemPrompt = [
      "You are an NLU planner for a travel & local discovery app.",
      "Output STRICT JSON with keys:",
      "intent: 'route' | 'activities' | 'viewpoints' | 'pizza' | 'gelato' | 'food',",
      "mode: 'driving' | 'transit' | null,",
      "filters: { openNow?: boolean, minRating?: number, keyword?: string },",
      "destinationText: string | null,",
      "subcategory: string | null  // for activities: water|hike|bike|museum|park|amusement|spa|kids",
      "No prose, JSON only."
    ].join("\n");

    const userMsg = `Text: <<${req.body.text}>>. Locale: ${context?.locale||'he-IL'}. Be concise.`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg }
        ],
        response_format: { type: "json_object" }
      })
    });
    const j = await r.json();
    if (j.error) return err(res, 400, j.error.message || "openai error");
    let jsonText = null;
    try {
      if (j.choices && j.choices[0]?.message?.content) {
        jsonText = j.choices[0].message.content;
      }
    } catch{}
    if (!jsonText) return err(res, 500, "bad openai response shape");
    const parsed = JSON.parse(jsonText);
    ok(res, parsed);
  } catch(e){ err(res, 500, String(e)); }
});

// ---- /weather (Open-Meteo) ---- (Enhanced with caching)
app.post("/weather", 
  cacheMiddleware(600), // Cache weather for 10 minutes
  validateRequest([
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required')
  ]),
  asyncHandler(async (req, res) => {
    const { lat, lng } = req.body || {};
    logger.info(`[${req.id}] Weather request: ${lat},${lng}`);
    const params = new URLSearchParams({
      latitude: String(lat), longitude: String(lng),
      current: ["temperature_2m","apparent_temperature","precipitation","wind_speed_10m","is_day"].join(","),
      hourly: ["temperature_2m","precipitation_probability","precipitation","wind_speed_10m","cloud_cover"].join(","),
      daily: ["temperature_2m_max","temperature_2m_min","precipitation_sum","sunrise","sunset"].join(","),
      timezone: "auto"
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) return err(res, 502, "weather upstream error");
    const j = await r.json();
    const out = {
      current: j.current || null,
      hourly: j.hourly ? {
        time: j.hourly.time,
        temperature_2m: j.hourly.temperature_2m,
        precipitation_probability: j.hourly.precipitation_probability,
        precipitation: j.hourly.precipitation,
        wind_speed_10m: j.hourly.wind_speed_10m,
        cloud_cover: j.hourly.cloud_cover
      } : null,
      daily: j.daily ? {
        time: j.daily.time,
        temperature_2m_max: j.daily.temperature_2m_max,
        temperature_2m_min: j.daily.temperature_2m_min,
        precipitation_sum: j.daily.precipitation_sum,
        sunrise: j.daily.sunrise,
        sunset: j.daily.sunset
      } : null,
      units: j.daily_units || j.hourly_units || {}
    };
    ok(res, { weather: out });
  })
);

// ---- /weather-compare ----
app.post("/weather-compare", async (req, res) => {
  try {
    const { src, dst } = req.body || {};
    if (!src?.lat || !src?.lng || !dst?.lat || !dst?.lng) return err(res, 400, "src/dst lat/lng required");
    const mk = (lat,lng)=> new URL(`https://api.open-meteo.com/v1/forecast?` + new URLSearchParams({
      latitude:String(lat), longitude:String(lng),
      current:["temperature_2m","apparent_temperature","precipitation","wind_speed_10m","is_day"].join(","),
      hourly:["temperature_2m","precipitation_probability","precipitation","wind_speed_10m","cloud_cover"].join(","),
      daily:["temperature_2m_max","temperature_2m_min","precipitation_sum","sunrise","sunset"].join(","),
      timezone:"auto"
    }).toString());
    const [r1,r2] = await Promise.all([fetch(mk(src.lat,src.lng)), fetch(mk(dst.lat,dst.lng))]);
    if (!r1.ok || !r2.ok) return err(res, 502, "weather upstream error");
    const [j1,j2] = await Promise.all([r1.json(), r2.json()]);
    ok(res, { src: j1, dst: j2 });
  } catch (e) { err(res, 500, String(e)); }
});

// ---- AI Recommendation Engine ----
const userProfiles = new Map(); // In production, use a database

class RecommendationEngine {
  constructor() {
    this.userBehavior = new Map();
    this.placeFeatures = new Map();
  }

  // Track user interactions
  trackInteraction(userId, placeId, interactionType, rating = null) {
    if (!this.userBehavior.has(userId)) {
      this.userBehavior.set(userId, {
        searches: [],
        visits: [],
        preferences: { cuisine: {}, priceRange: [0, 100], ratings: [] },
        mood: 'neutral'
      });
    }
    
    const profile = this.userBehavior.get(userId);
    profile.visits.push({ placeId, interactionType, timestamp: Date.now(), rating });
    
    if (rating) profile.preferences.ratings.push(rating);
  }

  // AI-powered personalized recommendations
  getPersonalizedRecommendations(userId, location, context = {}) {
    const profile = this.userBehavior.get(userId) || this.getDefaultProfile();
    const { mood = 'neutral', timeOfDay, weather, companionType = 'solo' } = context;
    
    // AI logic for recommendations
    let recommendations = [];
    
    // Mood-based filtering - using more common place types
    if (mood === 'adventurous') {
      recommendations.push({ type: 'tourist_attraction', keyword: 'adventure outdoor unique' });
      recommendations.push({ type: 'point_of_interest', keyword: 'hidden local special' });
    } else if (mood === 'relaxed') {
      recommendations.push({ type: 'park', keyword: 'peaceful quiet relaxing' });
      recommendations.push({ type: 'restaurant', keyword: 'cafe quiet peaceful' });
    } else if (mood === 'social') {
      recommendations.push({ type: 'restaurant', keyword: 'bar social buzzing' });
      recommendations.push({ type: 'night_club', keyword: 'social nightlife' });
    } else if (mood === 'romantic') {
      recommendations.push({ type: 'restaurant', keyword: 'romantic dinner fine dining' });
      recommendations.push({ type: 'park', keyword: 'romantic sunset view' });
    } else if (mood === 'hungry') {
      recommendations.push({ type: 'restaurant', keyword: 'food dining popular' });
      recommendations.push({ type: 'meal_takeaway', keyword: 'food quick' });
    }
    
    // Time-based recommendations
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 11) {
      recommendations.push({ type: 'restaurant', keyword: 'breakfast coffee brunch' });
    } else if (hour >= 17 && hour < 22) {
      recommendations.push({ type: 'restaurant', keyword: 'dinner food' });
    }
    
    // Weather-based recommendations
    if (weather?.current?.precipitation > 0) {
      recommendations.push({ type: 'shopping_mall', keyword: 'indoor covered' });
      recommendations.push({ type: 'restaurant', keyword: 'indoor cozy' });
    } else if (weather?.current?.temperature_2m > 25) {
      recommendations.push({ type: 'restaurant', keyword: 'ice cream outdoor terrace' });
      recommendations.push({ type: 'park', keyword: 'outdoor shade trees' });
    }
    
    return recommendations;
  }

  getDefaultProfile() {
    return {
      searches: [],
      visits: [],
      preferences: { cuisine: {}, priceRange: [0, 100], ratings: [] },
      mood: 'neutral'
    };
  }
}

const aiEngine = new RecommendationEngine();

// ---- /ai-recommendations ---- (Enhanced with AI rate limiting)
app.post("/ai-recommendations", 
  aiLimit,
  cacheMiddleware(900), // Cache AI recommendations for 15 minutes
  validateRequest([
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
    body('mood').optional().isIn(['adventurous', 'relaxed', 'social', 'romantic', 'hungry', 'curious']).withMessage('Invalid mood')
  ]),
  asyncHandler(async (req, res) => {
    const { lat, lng, userId = 'anonymous', mood, timeOfDay, companionType } = req.body || {};
    logger.info(`[${req.id}] AI recommendations: ${lat},${lng} mood:${mood}`);

    // Get weather context for AI recommendations
    const weatherResponse = await fetch(`${process.env.PROTOCOL || 'http'}://localhost:${process.env.PORT || 8080}/weather`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng })
    });
    const weatherData = weatherResponse.ok ? await weatherResponse.json() : null;

    // Get AI recommendations
    const recommendations = aiEngine.getPersonalizedRecommendations(userId, { lat, lng }, {
      mood,
      timeOfDay,
      weather: weatherData?.weather,
      companionType
    });

    // Execute recommendations and get actual places
    const results = [];
    for (const rec of recommendations.slice(0, 3)) { // Limit to 3 recommendations
      try {
        const placesResponse = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=2000&type=${rec.type}&keyword=${rec.keyword}&language=he&key=${GMAPS_KEY}`);
        const placesData = await placesResponse.json();
        
        if (placesData.status === "OK" && placesData.results?.length) {
          results.push({
            category: rec.type,
            reason: getRecommendationReason(rec, mood, weatherData?.weather),
            places: placesData.results.slice(0, 2).map(place => ({
              id: place.place_id,
              name: place.name,
              rating: place.rating,
              address: place.vicinity,
              lat: place.geometry?.location?.lat,
              lng: place.geometry?.location?.lng,
              openNow: place.opening_hours?.open_now
            }))
          });
        }
      } catch (e) {
        console.error('Recommendation error:', e);
      }
    }

    ok(res, { recommendations: results, context: { mood, weather: weatherData?.weather?.current } });
  })
);

// Helper method for recommendation reasons
function getRecommendationReason(rec, mood, weather) {
  if (mood === 'adventurous') return "🗺️ Based on your adventurous mood, here are some unique local experiences";
  if (mood === 'relaxed') return "😌 Perfect spots to unwind and relax";
  if (mood === 'social') return "👥 Great places to socialize and meet people";
  if (mood === 'romantic') return "💕 Perfect for a romantic experience";
  if (mood === 'hungry') return "🍽️ Delicious options to satisfy your hunger";
  if (weather?.precipitation > 0) return "☔ Great indoor options since it's raining";
  if (weather?.temperature_2m > 25) return "☀️ Cool treats for this warm weather";
  return "✨ Personalized recommendations just for you";
}

// ---- /track-interaction ----
app.post("/track-interaction", async (req, res) => {
  try {
    const { userId = 'anonymous', placeId, interactionType, rating } = req.body || {};
    if (!placeId || !interactionType) return err(res, 400, "placeId and interactionType required");
    
    aiEngine.trackInteraction(userId, placeId, interactionType, rating);
    ok(res, { tracked: true, message: "Interaction recorded for future recommendations" });
  } catch(e) { err(res, 500, String(e)); }
});

// ---- /user-insights ----
app.post("/user-insights", async (req, res) => {
  try {
    const { userId = 'anonymous' } = req.body || {};
    const profile = aiEngine.userBehavior.get(userId) || aiEngine.getDefaultProfile();
    
    // Calculate insights
    const insights = {
      totalVisits: profile.visits.length,
      averageRating: profile.preferences.ratings.length 
        ? (profile.preferences.ratings.reduce((a, b) => a + b, 0) / profile.preferences.ratings.length).toFixed(1)
        : null,
      preferredTypes: getTopPreferences(profile.visits),
      travelStyle: inferTravelStyle(profile),
      lastActive: profile.visits.length ? new Date(Math.max(...profile.visits.map(v => v.timestamp))) : null
    };
    
    ok(res, { insights, profile: { mood: profile.mood } });
  } catch(e) { err(res, 500, String(e)); }
});

// Helper methods for insights
function getTopPreferences(visits) {
  const types = {};
  visits.forEach(visit => {
    if (visit.placeId && visit.interactionType === 'visit') {
      const type = 'restaurant'; // Simplified - in production, store place types
      types[type] = (types[type] || 0) + 1;
    }
  });
  return Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([type]) => type);
}

function inferTravelStyle(profile) {
  if (profile.preferences.ratings.some(r => r >= 4.5)) return 'quality-focused';
  if (profile.visits.length > 10) return 'explorer';
  return 'casual';
}

// ---- Voice Processing ----
app.post("/voice-to-intent", async (req, res) => {
  try {
    const { text, userId = 'anonymous', location } = req.body || {};
    if (!text) return err(res, 400, "text required");

    // Enhanced NLU with voice-specific processing
    const voiceSystemPrompt = [
      "You are traveling AI, a smart travel assistant. Parse voice commands and respond with JSON.",
      "Available intents: 'ai_recommendations', 'route', 'places', 'weather', 'track_interaction'",
      "Extract mood from tone: adventurous, relaxed, social, hungry, curious, romantic",
      "Output JSON with:",
      "intent: string,",
      "mood: string,", 
      "params: object with relevant parameters,",
      "response: friendly conversational response in Hebrew",
      "No prose outside JSON."
    ].join("\n");

    const voicePrompt = `Voice command: "${text}". Location: ${location?.lat ? `${location.lat},${location.lng}` : 'unknown'}. User: ${userId}`;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: voiceSystemPrompt },
          { role: "user", content: voicePrompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    const aiResponse = await r.json();
    if (aiResponse.error) return err(res, 400, aiResponse.error.message);

    const voiceIntent = JSON.parse(aiResponse.choices[0].message.content);
    
    // Execute the intent automatically
    let actionResult = null;
    if (voiceIntent.intent === 'ai_recommendations' && location) {
      const recParams = {
        lat: location.lat,
        lng: location.lng,
        userId,
        mood: voiceIntent.mood,
        ...voiceIntent.params
      };
      
      // Internal API call
      try {
        const recResponse = await fetch(`http://localhost:${process.env.PORT || 8080}/ai-recommendations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(recParams)
        });
        actionResult = await recResponse.json();
      } catch (e) {
        console.error('Voice recommendation error:', e);
      }
    }

    ok(res, { 
      voiceIntent, 
      actionResult,
      conversationResponse: voiceIntent.response || "הבנתי! מחפש עבורך..."
    });
  } catch(e) { err(res, 500, String(e)); }
});

// ---- AI Trip Planning ----
app.post("/plan-trip", async (req, res) => {
  try {
    const { 
      startLocation, 
      duration, // 'half-day', 'full-day', 'weekend', 'custom'
      customHours = 8,
      interests = [], // ['food', 'culture', 'adventure', 'relaxation', 'nightlife']
      budget = 'medium', // 'low', 'medium', 'high'
      groupSize = 1,
      mobility = 'walking', // 'walking', 'car', 'public'
      userId = 'anonymous'
    } = req.body || {};

    if (!startLocation?.lat || !startLocation?.lng) return err(res, 400, "startLocation required");

    // Get weather context
    const weatherResponse = await fetch(`http://localhost:${process.env.PORT || 8080}/weather`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(startLocation)
    });
    const weatherData = weatherResponse.ok ? await weatherResponse.json() : null;

    // Calculate trip duration in hours
    let hours;
    switch(duration) {
      case 'half-day': hours = 4; break;
      case 'full-day': hours = 8; break;
      case 'weekend': hours = 16; break;
      case 'custom': hours = customHours; break;
      default: hours = 8;
    }

    // AI prompt for trip planning
    const planningPrompt = [
      "You are traveling AI, an expert trip planner. Create a detailed itinerary.",
      `Duration: ${hours} hours`,
      `Interests: ${interests.join(', ')}`,
      `Budget: ${budget}`,
      `Group: ${groupSize} people`,
      `Transport: ${mobility}`,
      `Weather: ${weatherData?.weather?.current?.temperature_2m || 'unknown'}°C`,
      "",
      "Output JSON with:",
      "title: string,",
      "overview: string,", 
      "estimated_cost: string,",
      "activities: [{ name, type, duration_minutes, description, priority, cost_estimate }],",
      "tips: string[]",
      "No prose outside JSON."
    ].join("\n");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: planningPrompt },
          { role: "user", content: `Plan a ${duration} trip starting from Tel Aviv area` }
        ],
        response_format: { type: "json_object" }
      })
    });

    const aiResponse = await r.json();
    if (aiResponse.error) return err(res, 400, aiResponse.error.message);

    const tripPlan = JSON.parse(aiResponse.choices[0].message.content);

    // Get real places for each activity
    const enrichedActivities = [];
    for (const activity of tripPlan.activities.slice(0, 6)) { // Limit to 6 activities
      try {
        const placesResponse = await fetch(`https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${startLocation.lat},${startLocation.lng}&radius=5000&type=point_of_interest&keyword=${encodeURIComponent(activity.name)}&language=he&key=${GMAPS_KEY}`);
        const placesData = await placesResponse.json();
        
        if (placesData.status === "OK" && placesData.results?.length) {
          const place = placesData.results[0];
          enrichedActivities.push({
            ...activity,
            place: {
              id: place.place_id,
              name: place.name,
              rating: place.rating,
              address: place.vicinity,
              lat: place.geometry?.location?.lat,
              lng: place.geometry?.location?.lng,
              photos: place.photos?.slice(0, 1) || []
            }
          });
        } else {
          enrichedActivities.push({ ...activity, place: null });
        }
      } catch (e) {
        enrichedActivities.push({ ...activity, place: null });
      }
    }

    // Store trip plan for user
    if (!userProfiles.has(userId)) {
      userProfiles.set(userId, { trips: [], preferences: {} });
    }
    const profile = userProfiles.get(userId);
    const tripId = `trip_${Date.now()}`;
    profile.trips.push({
      id: tripId,
      created: new Date(),
      plan: { ...tripPlan, activities: enrichedActivities },
      status: 'planned'
    });

    ok(res, {
      tripPlan: { ...tripPlan, activities: enrichedActivities },
      tripId,
      context: { weather: weatherData?.weather?.current, duration: hours }
    });
  } catch(e) { err(res, 500, String(e)); }
});

// ---- AI Planner Orchestrator (Stub) ----
app.post("/api/plan", aiLimit, validateRequest([
  // Validate preferences object
  body("preferences").isObject().withMessage('preferences must be an object'),
  body("preferences.interests")
    .isArray({ min: 1, max: MAX_INTERESTS })
    .withMessage(`interests must be array with 1-${MAX_INTERESTS} items`),
  body("preferences.interests.*")
    .isString()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('each interest must be a non-empty string (max 100 chars)'),
  body("preferences.duration")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('duration must be a string (max 50 chars)'),
  body("preferences.budget")
    .isInt({ min: 0, max: MAX_BUDGET })
    .withMessage(`budget must be 0-${MAX_BUDGET}`),

  // Validate startLocation object
  body("startLocation").isObject().withMessage('startLocation must be an object'),
  body("startLocation.lat")
    .isFloat({ min: -90, max: 90 })
    .withMessage('lat must be -90 to 90'),
  body("startLocation.lng")
    .isFloat({ min: -180, max: 180 })
    .withMessage('lng must be -180 to 180'),
  body("startLocation.name")
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('name must be non-empty string (max 200 chars)')
]), plannerGuardrails, async (req, res) => {
  try {
    // Use sanitized payload from guardrails
    const { preferences, startLocation } = req.planPayload || req.body;

    logger.info(`[${req.id}] Plan request (stub mode)`);

    // Call provider stubs
    const places = await stubSearchPlaces(
      preferences.interests?.[0] || 'attraction',
      startLocation
    );
    const weather = await stubGetWeather(
      startLocation.lat,
      startLocation.lng,
      Date.now()
    );
    const route = await stubGetRouteSummary(places.map(p => ({
      lat: startLocation.lat,
      lng: startLocation.lng
    })));

    // Return grounded response with rationales and citations
    const itinerary = {
      id: `plan-${Date.now()}`,
      title: `Trip from ${startLocation.name || 'Start'}`,
      days: [{
        date: new Date().toISOString().split('T')[0],
        activities: places.map(p => ({
          time: '10:00',
          place: p.name,
          duration: 60,
          notes: 'Suggested based on preferences'
        }))
      }],
      metadata: {
        distance: route.distance,
        duration: route.duration,
        weather: weather.conditions
      }
    };

    const rationales = [
      `Selected ${places[0].name} based on "${preferences.interests?.[0]}" interest`,
      `Weather is ${weather.conditions}, suitable for outdoor activities`
    ];

    const citations = places.map(p => ({
      source: 'stub-provider',
      placeId: p.id,
      rating: p.rating
    }));

    res.json({
      ok: true,
      itinerary,
      rationales,
      citations,
      stub: true // Mark as stub response
    });

  } catch(e) {
    logger.error(`[${req.id}] Plan error:`, e);
    res.status(500).json({
      ok: false,
      code: 'internal_error',
      message: 'Failed to generate plan',
      error: String(e)
    });
  }
});

// ---- Live Trip Navigation ----
app.post("/navigate-trip", async (req, res) => {
  try {
    const { tripId, userId = 'anonymous', currentLocation, currentActivity = 0 } = req.body || {};
    if (!tripId || !currentLocation?.lat || !currentLocation?.lng) {
      return err(res, 400, "tripId and currentLocation required");
    }

    const profile = userProfiles.get(userId);
    const trip = profile?.trips?.find(t => t.id === tripId);
    if (!trip) return err(res, 404, "Trip not found");

    const activities = trip.plan.activities;
    const nextActivity = activities[currentActivity];
    
    if (!nextActivity?.place) {
      return ok(res, { message: "Trip completed!", hasNext: false });
    }

    // Calculate route to next activity
    const routeResponse = await fetch(`http://localhost:${process.env.PORT || 8080}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: currentLocation,
        dest: { lat: nextActivity.place.lat, lng: nextActivity.place.lng },
        mode: 'walking'
      })
    });
    const routeData = routeResponse.ok ? await routeResponse.json() : null;

    // Check for weather/time adjustments
    const now = new Date();
    let adjustments = [];
    
    if (now.getHours() > 20 && nextActivity.type === 'outdoor') {
      adjustments.push({
        type: 'time_warning',
        message: 'מקום חיצוני - שקול לעבור למחר או למקום מקורה',
        suggestion: 'indoor_alternative'
      });
    }

    ok(res, {
      currentActivity: nextActivity,
      navigation: routeData,
      progress: `${currentActivity + 1}/${activities.length}`,
      adjustments,
      hasNext: currentActivity < activities.length - 1
    });
  } catch(e) { err(res, 500, String(e)); }
});

// ---- Smart Notifications ----
app.post("/smart-notifications", async (req, res) => {
  try {
    const { userId = 'anonymous', location, timeContext } = req.body || {};
    if (!location?.lat || !location?.lng) return err(res, 400, "location required");

    const notifications = [];
    const profile = aiEngine.userBehavior.get(userId) || aiEngine.getDefaultProfile();
    
    // Time-based notifications
    const hour = new Date().getHours();
    const day = new Date().getDay();
    
    // Meal time suggestions
    if (hour === 12 && day !== 6 && day !== 0) { // Weekday lunch
      notifications.push({
        type: 'suggestion',
        priority: 'medium',
        title: '🍽️ זמן צהריים!',
        message: 'מצאתי כמה מסעדות נהדרות בקרבתך',
        action: 'ai_recommendations',
        params: { mood: 'hungry', type: 'restaurant' }
      });
    }
    
    // Weather-based notifications
    try {
      const weatherResponse = await fetch(`http://localhost:${process.env.PORT || 8080}/weather`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(location)
      });
      const weatherData = await weatherResponse.json();
      
      if (weatherData.ok && weatherData.weather?.current) {
        const temp = weatherData.weather.current.temperature_2m;
        const precipitation = weatherData.weather.current.precipitation;
        
        if (temp > 28) {
          notifications.push({
            type: 'weather_advice',
            priority: 'high',
            title: '☀️ חום בחוץ!',
            message: `${temp}°C - מה דעתך על גלידה או מקום עם מיזוג?`,
            action: 'ai_recommendations',
            params: { mood: 'cooling', keyword: 'ice cream air conditioning' }
          });
        }
        
        if (precipitation > 0) {
          notifications.push({
            type: 'weather_alert',
            priority: 'high',
            title: '🌧️ גשם בדרך',
            message: 'מצאתי מקומות מקורים שיתאימו לך',
            action: 'ai_recommendations',
            params: { mood: 'indoor', type: 'museum' }
          });
        }
      }
    } catch (e) {
      console.error('Weather notification error:', e);
    }
    
    // Personal pattern notifications
    if (profile.visits.length > 5) {
      const avgRating = profile.preferences.ratings.reduce((a, b) => a + b, 0) / profile.preferences.ratings.length;
      if (avgRating > 4.2) {
        notifications.push({
          type: 'personal_insight',
          priority: 'low',
          title: '⭐ אתה בעל טעם מעולה!',
          message: `הציון הממוצע שלך: ${avgRating.toFixed(1)} - נמצא לך עוד מקומות איכותיים?`,
          action: 'ai_recommendations',
          params: { mood: 'quality', minRating: 4.5 }
        });
      }
    }

    ok(res, { notifications, context: { hour, userId, profileExists: !!aiEngine.userBehavior.has(userId) } });
  } catch(e) { err(res, 500, String(e)); }
});

// ---- Backend-v2 Pass-Through Handlers ----
const BACKEND_V2_URL = process.env.BACKEND_V2_URL || '';

// Forward /api/route to backend-v2 (OSRM routing)
app.post('/api/route', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/api/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 route error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /api/hazards to backend-v2
app.get('/api/hazards', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(`${BACKEND_V2_URL}/api/hazards?${qs}`);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 hazards error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /api/profile to backend-v2 (JWT auth via cookies)
app.all('/api/profile', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/api/profile`, {
      method: req.method,
      headers: {
        'content-type': 'application/json',
        cookie: req.headers.cookie || '',
      },
      body: req.method === 'PUT' ? JSON.stringify(req.body || {}) : undefined,
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 profile error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /api/family/signin/start to backend-v2 (Family Mode signin - step 1)
app.post('/api/family/signin/start', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/api/family/signin/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: req.headers.cookie || '',
      },
      body: JSON.stringify(req.body || {}),
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 family signin/start error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /api/family/signin/finish to backend-v2 (Family Mode signin - step 2)
app.post('/api/family/signin/finish', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/api/family/signin/finish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: req.headers.cookie || '',
      },
      body: JSON.stringify(req.body || {}),
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 family signin/finish error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /api/me to backend-v2 (Get current family session)
app.get('/api/me', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/api/me`, {
      method: 'GET',
      headers: {
        cookie: req.headers.cookie || '',
      },
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 /api/me error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /admin/healthz to backend-v2 (JSON health endpoint)
app.get('/admin/healthz', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/admin/healthz`);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    logger.error('Backend-v2 health error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Forward /admin/health to backend-v2 (HTML dashboard)
app.get('/admin/health', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await fetch(`${BACKEND_V2_URL}/admin/health`);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'text/html').send(txt);
  } catch (error) {
    logger.error('Backend-v2 dashboard error:', error);
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// ✨ ENHANCED ERROR HANDLING & MONITORING

// Global error handler
app.use((error, req, res, next) => {
  logger.error(`[${req.id}] Error:`, error);
  
  // Don't leak error details in production
  const isDev = process.env.NODE_ENV !== 'production';
  
  res.status(error.status || 500).json({
    ok: false,
    error: isDev ? error.message : 'Internal server error',
    ...(isDev && { stack: error.stack }),
    requestId: req.id
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "roamwise-proxy",
    version: "1.1.0",
    time: new Date().toISOString(),
    endpoints: [
      "/health", "/metrics", "/places", "/geocode", "/route", "/weather", "/think"
    ]
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();
  
  res.json({
    ok: true,
    status: 'healthy',
    uptime: Math.floor(uptime),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB'
    },
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats()
    },
    timestamp: new Date().toISOString()
  });
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  res.json({
    ok: true,
    cache: cache.getStats(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// 404 handler (must be last route)
app.use('*', (req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint not found',
    requestId: req.id
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  cache.close();
  process.exit(0);
});

const port = process.env.PORT || 8080;
app.listen(port, ()=> {
  logger.info(`🚀 RoamWise AI proxy listening on port ${port}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Cache TTL: ${cache.options.stdTTL}s`);
  logger.info(`Health endpoints: GET / and GET /health`);
});
