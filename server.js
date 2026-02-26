import express from 'express';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3800;

const WSL_URL = 'https://www.worldsurfleague.com/posts/552432/its-on-day-3-of-the-btmi-barbados-surf-pro-and-live-like-zander-junior-pro-presented-by-diamonds-international?trigger=live';

let cache = { data: null, ts: 0 };
const CACHE_TTL = 10_000;

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

  // Parse counted into individual wave scores
  const waves = counted ? counted.split('+').map(w => parseFloat(w.trim())).filter(n => !isNaN(n)) : [];

  return { name, score, diff, counted, waves, waveCount, singlet, place, status, athleteId };
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

    // If this is the live heat, also set the heatId on liveHeat
    if (status === 'live' && result.liveHeat) {
      result.liveHeat.heatId = heatId;
      result.liveHeat.heatNumber = i + 1;
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

app.get('/api/live', async (req, res) => {
  try {
    const data = await fetchWSLData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
