import express from 'express';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3800;

const WSL_URL = 'https://www.worldsurfleague.com/posts/552432/its-on-day-3-of-the-btmi-barbados-surf-pro-and-live-like-zander-junior-pro-presented-by-diamonds-international?trigger=live';

let cache = { data: null, ts: 0 };
const CACHE_TTL = 5_000; // 5s — WSL updates every ~30s

// Heat timer tracking — server-side for accuracy
let heatTimer = { heatId: null, startedAt: null };
const HEAT_DURATION_MS = 25 * 60 * 1000; // 25 min for QS

app.use(express.static(path.join(__dirname, 'public')));

function parseAthlete(el) {
  const name = el.querySelector('.hot-heat-athlete__name--full')?.textContent?.trim() || '';
  const score = parseFloat(el.querySelector('.hot-heat-athlete__score')?.textContent?.trim()) || 0;
  const diff = el.querySelector('.hot-heat-athlete__difference')?.textContent?.trim() || '';
  const counted = el.querySelector('.hot-heat-athlete__counted-waves')?.textContent?.trim() || '';
  const wavesText = el.querySelector('.hot-heat-athlete__num-waves')?.textContent?.trim() || '';
  const waveCount = parseInt(wavesText) || 0;
  const singlet = el.className.match(/singlet-(\w+)/)?.[1] || '';
  const place = parseInt(el.className.match(/athlete-place-(\d+)/)?.[1]) || 0;
  const athleteId = el.className.match(/athlete-id-(\d+)/)?.[1] || '';
  
  let status = 'active';
  if (el.className.includes('advance-winner')) status = 'advance-winner';
  else if (el.className.includes('advance')) status = 'advance';
  else if (el.className.includes('eliminated')) status = 'eliminated';

  // Priority from sort-order class
  const sortOrder = parseInt(el.className.match(/athlete-sort-order-(\d+)/)?.[1]) || 0;

  // Parse counted into individual wave scores
  const waves = counted ? counted.split('+').map(w => parseFloat(w.trim())).filter(n => !isNaN(n)) : [];

  return { name, score, diff, counted, waves, waveCount, singlet, place, status, athleteId, sortOrder };
}

function parseWSL(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const body = doc.body?.textContent || '';

  const result = {
    event: 'BTMI Barbados Surf Pro',
    subtitle: 'Presented By Diamonds International',
    location: 'Soup Bowl, Bathsheba, Barbados',
    tier: 'QS 6,000',
    updatedAt: new Date().toISOString(),
    liveHeat: null,
    heats: [],
    divisions: [],
    rounds: []
  };

  // Divisions
  const divRegex = /(Men's|Women's) Heats\s+(Standby|In the Water|Completed|Upcoming|Lay Day)/gi;
  let dm;
  while ((dm = divRegex.exec(body))) {
    result.divisions.push({ name: dm[1], status: dm[2] });
  }

  // Rounds
  const roundRegex = /(Round of \d+|Quarterfinals|Semifinals|Final)\s+(\d+)\s+Heats?\s+(Completed[^A-Z]*|In Progress|Upcoming)/gi;
  let rm;
  while ((rm = roundRegex.exec(body))) {
    result.rounds.push({ name: rm[1], heats: parseInt(rm[2]), status: rm[3].trim() });
  }

  // Current live heat (big section at top)
  const currentHeatEl = doc.querySelector('.post-event-watch-current-heats');
  if (currentHeatEl) {
    const athletes = currentHeatEl.querySelectorAll('.hot-heat-athlete[class*="athlete-id-"]');
    if (athletes.length > 0) {
      // Get round info from the header
      const headerMatch = body.match(/(Round of \d+|Quarterfinals|Semifinals|Final)\s*-\s*Heat\s*(\d+)\s*LIVE/i);
      
      result.liveHeat = {
        round: headerMatch?.[1] || '',
        heatNumber: parseInt(headerMatch?.[2]) || 0,
        heatId: '',
        surfers: Array.from(athletes).map(a => parseAthlete(a))
      };
    }
  }

  // All heats from the grid
  const heatEls = doc.querySelectorAll('.post-event-watch-heat-grid__heat');
  heatEls.forEach((h, i) => {
    const status = h.className.match(/status-(\w+)/)?.[1] || 'unknown';
    const heatId = h.getAttribute('data-heat-id') || h.querySelector('[data-heat-id]')?.getAttribute('data-heat-id') || '';
    const athletes = h.querySelectorAll('.hot-heat-athlete[class*="athlete-id-"]');
    
    const heat = {
      number: i + 1,
      heatId,
      status, // 'live', 'over', 'upcoming'
      surfers: Array.from(athletes).map(a => parseAthlete(a))
    };

    // Track all live heats — pick the highest heat number (most recent)
    if (status === 'live') {
      if (!result.liveHeat || heat.number > result.liveHeat.heatNumber) {
        const roundInfo = body.match(new RegExp(`(Round of \\d+|Quarterfinals|Semifinals|Final)\\s*-\\s*Heat\\s*${heat.number}\\s*LIVE`, 'i'));
        result.liveHeat = {
          round: roundInfo?.[1] || result.liveHeat?.round || '',
          heatNumber: heat.number,
          heatId,
          surfers: Array.from(athletes).map(a => parseAthlete(a))
        };
      }
    }

    result.heats.push(heat);
  });

  return result;
}

async function fetchWSLData() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;

  try {
    const res = await fetch(WSL_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html'
      }
    });
    const html = await res.text();
    const data = parseWSL(html);
    cache = { data, ts: now };
    return data;
  } catch (err) {
    console.error('WSL fetch error:', err.message);
    return cache.data || { error: 'Failed to fetch WSL data' };
  }
}

// Puppeteer scraper on Razer (real-time JS-rendered data)
const PUPPETEER_BASE = 'http://100.64.217.14:3810';

async function fetchPuppeteerData(query) {
  try {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const resp = await fetch(`${PUPPETEER_BASE}/api/live${qs}`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.age > 60000) return null; // Stale
    return data;
  } catch { return null; }
}

app.get('/api/live', async (req, res) => {
  try {
    // Try Puppeteer scraper first (real-time), fall back to HTML scraping
    let data = await fetchPuppeteerData(req.query);
    let source = 'puppeteer';
    if (!data) {
      data = await fetchWSLData();
      source = 'html';
    } else {
      // Puppeteer data already has priority set, just need timer logic
      if (data.liveHeat && !data.liveHeat.timer) {
        // Use server-side timer as fallback
        if (data.liveHeat.heatId && heatTimer.heatId !== data.liveHeat.heatId) {
          heatTimer = { heatId: data.liveHeat.heatId, startedAt: Date.now() };
        }
        if (heatTimer.heatId === data.liveHeat.heatId) {
          const elapsed = Date.now() - heatTimer.startedAt;
          const remainingMs = Math.max(0, HEAT_DURATION_MS - elapsed);
          const remainingSec = Math.floor(remainingMs / 1000);
          const mins = Math.floor(remainingSec / 60);
          const secs = remainingSec % 60;
          data.liveHeat.timer = { remaining: `${mins}:${String(secs).padStart(2, '0')}`, remainingSec, startedAt: heatTimer.startedAt };
        }
      }
      data.source = source;
      return res.json(data);
    }
    
    // ── Heat Timer (server-side) ──
    if (data.liveHeat?.heatId) {
      if (heatTimer.heatId !== data.liveHeat.heatId) {
        // New heat detected
        heatTimer = { heatId: data.liveHeat.heatId, startedAt: Date.now() };
      }
      const elapsed = Date.now() - heatTimer.startedAt;
      const remainingMs = Math.max(0, HEAT_DURATION_MS - elapsed);
      const remainingSec = Math.floor(remainingMs / 1000);
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      data.liveHeat.timer = {
        remaining: `${mins}:${String(secs).padStart(2, '0')}`,
        remainingSec,
        startedAt: heatTimer.startedAt,
        elapsed: Math.floor(elapsed / 1000)
      };
    }

    // ── Priority (from WSL sort-order) ──
    if (data.liveHeat?.surfers?.length) {
      const surfers = data.liveHeat.surfers;
      const hasSortOrder = surfers.some(s => s.sortOrder > 0);
      if (hasSortOrder) {
        surfers.forEach(s => {
          s.priority = s.sortOrder === 1 ? 'P' : String(s.sortOrder);
        });
      }
    }

    data.source = 'html';
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy new scraper endpoints
const SCRAPER_BASE = 'http://100.64.217.14:3810';

app.get('/api/events', async (req, res) => {
  try {
    const r = await fetch(`${SCRAPER_BASE}/api/events`, { signal: AbortSignal.timeout(3000) });
    res.json(await r.json());
  } catch { res.json({ error: 'Scraper unavailable', events: {} }); }
});

app.get('/api/rounds', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await fetch(`${SCRAPER_BASE}/api/rounds?${qs}`, { signal: AbortSignal.timeout(3000) });
    res.json(await r.json());
  } catch { res.json({ error: 'Scraper unavailable', heats: [], roundInfo: [] }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const r = await fetch(`${SCRAPER_BASE}/api/stats`, { signal: AbortSignal.timeout(3000) });
    res.json(await r.json());
  } catch { res.json({ error: 'Scraper unavailable', topWaves: [], topHeatTotals: [] }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Vercel serverless export
export default app;

// Local dev
if (process.env.VERCEL !== '1') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Corus Surf Cam running at http://0.0.0.0:${PORT}`);
  });
}
