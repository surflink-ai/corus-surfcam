/**
 * WSL Live Score Scraper v2
 * 
 * Pure HTTP + cheerio — no Puppeteer, no Chrome.
 * Fetches WSL event pages every 3s, parses HTML for live scores.
 * 50MB RAM vs 750MB. Instant restart. No stale DOM.
 */

const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3810;
const POLL_INTERVAL = 3_000; // 3 seconds

// ── Event Configuration ──
const EVENTS = {
  qs6000: {
    name: 'QS 6000',
    divisions: {
      men: {
        label: "Men's",
        statEventId: 5141,
        url: 'https://www.worldsurfleague.com/events/2026/qs/328/btmi-barbados-surf-pro/main?statEventId=5141'
      },
      women: {
        label: "Women's",
        statEventId: 5142,
        url: 'https://www.worldsurfleague.com/events/2026/qs/328/btmi-barbados-surf-pro/main?statEventId=5142'
      }
    }
  },
  junior: {
    name: 'JR PRO',
    divisions: {
      men: {
        label: "Men's JR",
        statEventId: 5143,
        url: 'https://www.worldsurfleague.com/events/2026/qs/328/btmi-barbados-surf-pro/main?statEventId=5143'
      },
      women: {
        label: "Women's JR",
        statEventId: 5144,
        url: 'https://www.worldsurfleague.com/events/2026/qs/328/btmi-barbados-surf-pro/main?statEventId=5144'
      }
    }
  }
};

// Also poll the main post page for the live overlay (has the most detailed live heat view)
const LIVE_PAGE = 'https://www.worldsurfleague.com/posts/552590/its-on-day-6-of-the-btmi-barbados-surf-pro-and-live-like-zander-junior-pro-presented-by-diamonds-international?trigger=live';

// ── State ──
const store = {
  liveEvent: null,
  liveDivision: null,
  liveRound: null,
  liveHeat: null,
  liveTimer: null,
  allDivisions: {},
  heats: {},       // { 'qs6000_men': [...], ... }
  rounds: {},      // { 'qs6000_men': [...], ... }
  lastUpdate: 0,
  errors: [],
  startedAt: Date.now()
};

let divisionIndex = 0; // Round-robin through divisions for completed heats
const allDivisionKeys = [];

// Build division keys
for (const [eventKey, event] of Object.entries(EVENTS)) {
  for (const [divKey, div] of Object.entries(event.divisions)) {
    const key = `${eventKey}_${divKey}`;
    allDivisionKeys.push(key);
    store.allDivisions[key] = {
      eventKey, eventName: event.name,
      divKey, label: div.label,
      statEventId: div.statEventId,
      url: div.url,
      status: 'unknown', isLive: false
    };
  }
}

// ── HTTP Fetch with retry ──
async function fetchPage(url, retries = 2) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
    }
  }
}

// ── Parse live heat from the post page ──
function parseLiveHeat($) {
  const heatSection = $('.post-event-watch-current-heats');
  if (!heatSection.length) return null;

  // Heat info — WSL format: "MQS Quarterfinals - Heat 4" in .heat-name
  const heatName = heatSection.find('.heat-name').first().text().trim();
  
  // Parse "MQS Quarterfinals - Heat 4" or "Quarterfinals Heat 4"
  // Examples: "MQS Quarterfinals - Heat 4", "WQS Round of 32 - Heat 1", "MJQS Semifinals - Heat 2"
  // Split on last " - Heat N" to get prefix and heat number
  const heatMatch = heatName.match(/^(.+?)\s*[-–]\s*Heat\s+(\d+)\s*$/i);
  const fullPrefix = heatMatch ? heatMatch[1].trim() : heatName;
  const heatNumber = heatMatch ? parseInt(heatMatch[2]) : 0;
  
  // Split prefix into event code and round: "MQS Quarterfinals" → ["MQS", "Quarterfinals"]
  const prefixParts = fullPrefix.split(/\s+/);
  const eventPrefix = prefixParts.length > 1 ? prefixParts[0] : null;
  const round = prefixParts.length > 1 ? prefixParts.slice(1).join(' ') : fullPrefix;

  // Detect event from prefix
  // MQS = Men's QS, WQS = Women's QS, MJQS = Men's Junior, WJQS = Women's Junior
  let detectedEvent = null, detectedDivision = null;
  if (eventPrefix) {
    const p = eventPrefix.toUpperCase();
    if (p.includes('MJ') || p.includes('JUNIOR') && p.includes('M')) { detectedEvent = 'JR PRO'; detectedDivision = "Men's JR"; }
    else if (p.includes('WJ') || p.includes('JUNIOR') && p.includes('W')) { detectedEvent = 'JR PRO'; detectedDivision = "Women's JR"; }
    else if (p.includes('WQS') || p === 'W') { detectedEvent = 'QS 6000'; detectedDivision = "Women's"; }
    else if (p.includes('MQS') || p === 'M') { detectedEvent = 'QS 6000'; detectedDivision = "Men's"; }
  }

  // Check for LIVE indicator
  const isLive = heatSection.find('.live-indicator').length > 0 
    || heatSection.find('.hot-heat__hd-title').text().includes('LIVE');

  // Timer
  const timerText = heatSection.find('.hot-heat__timer, .hot-heat-module__timer').text().trim();

  // Status bar for division detection
  const statusText = heatSection.find('.hot-heat__status-bar').text().trim();

  // Surfers
  const surfers = [];
  heatSection.find('.hot-heat-athlete').each((i, el) => {
    const $a = $(el);
    const name = $a.find('.hot-heat-athlete__name--full').text().trim()
      || $a.find('.hot-heat-athlete__name').first().text().trim();
    const score = parseFloat($a.find('.hot-heat-athlete__score').text().trim()) || 0;
    const singlet = ($a.attr('data-athlete-singlet') || '').toLowerCase();
    const sortOrder = $a.hasClass('hot-heat-athlete--athlete-sort-order-1') ? 1 : 2;
    const diff = $a.find('.hot-heat-athlete__difference').first().text().trim();
    const waveCountText = $a.find('.hot-heat-athlete__num-waves').text().trim();
    const waveCount = parseInt(waveCountText) || 0;

    // Individual waves
    const waves = [];
    $a.find('.wave-score').each((j, wEl) => {
      const wScore = parseFloat($(wEl).text().trim()) || 0;
      const isCounted = $(wEl).closest('.wave').hasClass('wave--counted');
      waves.push({ score: wScore, counted: isCounted });
    });

    if (name) {
      surfers.push({
        name, score, singlet,
        priority: sortOrder === 1 ? 'P' : '',
        diff, waveCount, waves,
        status: $a.attr('data-athlete-status') || 'active'
      });
    }
  });

  // Sort by score descending
  surfers.sort((a, b) => b.score - a.score);

  return { round, heatNumber, timer: timerText || null, surfers, statusText, detectedEvent, detectedDivision, isLive, rawHeatName: heatName };
}

// ── Parse division status from event page ──
function parseDivisionPage($, key) {
  const divInfo = store.allDivisions[key];
  if (!divInfo) return;

  // Check for "In the Water" / "Standby" / "Complete" indicators
  const pageText = $('body').text();
  
  if (/in\s+the\s+water/i.test(pageText) || /live/i.test($('.event-status, .competition-status').text())) {
    divInfo.status = 'live';
    divInfo.isLive = true;
  } else if (/standby|lay\s*day|on\s*hold/i.test(pageText.slice(0, 5000))) {
    divInfo.status = 'standby';
    divInfo.isLive = false;
  } else if (/complet/i.test(pageText.slice(0, 5000))) {
    divInfo.status = 'completed';
    divInfo.isLive = false;
  }

  // Parse completed heats
  const heats = [];
  const rounds = [];
  
  // Round headers
  $('.post-event-watch-heat-results-round, .round-header').each((i, el) => {
    const roundName = $(el).text().trim();
    if (roundName) rounds.push(roundName);
  });

  // Completed heat results
  $('.post-event-watch-heat-result').each((i, el) => {
    const $h = $(el);
    const heatName = $h.find('.heat-name, .heat-title').text().trim();
    const athletes = [];
    $h.find('.athlete-name, .hot-heat-result-athlete__name').each((j, aEl) => {
      const aName = $(aEl).text().trim();
      const aScore = parseFloat($(aEl).closest('.hot-heat-result-athlete, .athlete-row').find('.score, .total').text().trim()) || 0;
      if (aName) athletes.push({ name: aName, score: aScore });
    });
    if (heatName || athletes.length) {
      heats.push({ name: heatName, athletes });
    }
  });

  store.heats[key] = heats;
  store.rounds[key] = rounds;
}

// ── Determine which event/division is live ──
function detectLive() {
  // Find first division with status 'live'
  for (const [key, div] of Object.entries(store.allDivisions)) {
    if (div.isLive) {
      store.liveEvent = div.eventName;
      store.liveDivision = div.label;
      return;
    }
  }
  // If none explicitly live, keep previous
}

// ── Main scrape cycle ──
let scraping = false;

async function scrapeAll() {
  if (scraping) return;
  scraping = true;
  const start = Date.now();

  try {
    // 1. Fetch the live post page (has the most detailed live heat view)
    const liveHtml = await fetchPage(LIVE_PAGE);
    const $live = cheerio.load(liveHtml);
    const liveHeat = parseLiveHeat($live);
    
    if (liveHeat && liveHeat.surfers.length > 0) {
      store.liveHeat = liveHeat;
      store.liveRound = liveHeat.round;
      store.liveTimer = liveHeat.timer;
      store.lastUpdate = Date.now();
      
      // Use detected event/division from heat name prefix
      if (liveHeat.detectedEvent) store.liveEvent = liveHeat.detectedEvent;
      if (liveHeat.detectedDivision) store.liveDivision = liveHeat.detectedDivision;
    }

    // 2. Fetch one division page per cycle (round-robin) for status + completed heats
    const divKey = allDivisionKeys[divisionIndex % allDivisionKeys.length];
    divisionIndex++;
    const divInfo = store.allDivisions[divKey];
    
    try {
      const divHtml = await fetchPage(divInfo.url);
      const $div = cheerio.load(divHtml);
      parseDivisionPage($div, divKey);
    } catch (err) {
      console.error(`[scrape] Division ${divKey} fetch failed: ${err.message}`);
    }

    // 3. Detect which event/division is live
    detectLive();

    const elapsed = Date.now() - start;
    console.log(`[scrape] ${store.liveEvent || '?'} ${store.liveDivision || '?'} | ${store.liveRound || '?'} Heat ${store.liveHeat?.heatNumber || '?'} | ${store.liveHeat?.surfers?.length || 0} surfers | ${elapsed}ms`);
    
  } catch (err) {
    console.error(`[scrape] Error: ${err.message}`);
    store.errors.push({ time: Date.now(), message: err.message });
    if (store.errors.length > 50) store.errors.shift();
  }

  scraping = false;
}

// ── Express API ──
const app = express();
app.use(cors());

app.get('/api/live', (req, res) => {
  const age = store.lastUpdate > 0 ? Math.round((Date.now() - store.lastUpdate) / 1000) : -1;
  res.json({
    event: store.liveEvent,
    division: store.liveDivision,
    round: store.liveRound,
    age,
    timestamp: store.lastUpdate,
    liveHeat: store.liveHeat || { surfers: [], heatNumber: 0 },
    allDivisions: store.allDivisions
  });
});

app.get('/api/events', (req, res) => {
  res.json({
    events: Object.entries(EVENTS).map(([key, e]) => ({
      key, name: e.name,
      divisions: Object.entries(e.divisions).map(([dk, d]) => ({
        key: dk, label: d.label, statEventId: d.statEventId
      }))
    }))
  });
});

app.get('/api/rounds', (req, res) => {
  const event = req.query.event || 'qs6000';
  const division = req.query.division || 'men';
  const key = `${event}_${division}`;
  res.json({ rounds: store.rounds[key] || [], heats: store.heats[key] || [] });
});

app.get('/api/stats', (req, res) => {
  // TODO: per-athlete stats aggregation
  res.json({ message: 'Stats endpoint — coming soon' });
});

app.get('/health', (req, res) => {
  const age = store.lastUpdate > 0 ? Math.round((Date.now() - store.lastUpdate) / 1000) : -1;
  const uptime = Math.round((Date.now() - store.startedAt) / 1000);
  res.json({
    status: age < 30 ? 'healthy' : age < 120 ? 'ok' : 'stale',
    age,
    uptime,
    event: store.liveEvent,
    division: store.liveDivision,
    heat: store.liveHeat?.heatNumber,
    surfers: store.liveHeat?.surfers?.length || 0,
    errors: store.errors.slice(-5),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    version: '2.0.0'
  });
});

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] WSL Scraper v2 on port ${PORT} — HTTP + cheerio, no Puppeteer`);
  console.log(`[server] Polling ${Object.keys(store.allDivisions).length} divisions every ${POLL_INTERVAL}ms`);
  
  // Initial scrape
  scrapeAll();
  
  // Poll every 3 seconds
  setInterval(scrapeAll, POLL_INTERVAL);
});
