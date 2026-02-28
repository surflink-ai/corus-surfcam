const puppeteer = require('puppeteer-core');
const express = require('express');

// ── CONFIG ──
const EVENTS = {
  qs6000: {
    name: 'BTMI Barbados Surf Pro',
    shortName: 'QS 6000',
    divisions: {
      men: { statEventId: '5141', label: "Men's" },
      women: { statEventId: '5142', label: "Women's" }
    }
  },
  junior: {
    name: 'Live Like Zander Junior Pro',
    shortName: 'JR PRO',
    divisions: {
      men: { statEventId: '5143', label: "Men's JR" },
      women: { statEventId: '5144', label: "Women's JR" }
    }
  }
};

const BASE_URL = 'https://www.worldsurfleague.com/posts/552590/its-on-day-6-of-the-btmi-barbados-surf-pro-and-live-like-zander-junior-pro-presented-by-diamonds-international';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 3810;

let store = {
  liveHeat: null,         // The single currently-in-the-water heat
  liveEvent: null,        // Which event key it belongs to
  liveDivision: null,     // Which division key
  liveRound: '',
  liveTimer: null,
  divisions: {},          // keyed by "qs6000_men" etc — completed heats per division
  stats: {},
  lastUpdate: 0
};

let browser = null;
let page = null;
let scraping = false;

async function initBrowser() {
  console.log('[init] Launching headless Chrome...');
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions']
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  console.log('[init] Loading WSL page...');
  await page.goto(BASE_URL + '?trigger=live', { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[init] Page loaded');
  await page.waitForSelector('.hot-heat-athlete', { timeout: 15000 }).catch(() => console.log('[init] No athletes on initial load'));
}

// ── SCRAPE LIVE HEAT (from any page — it's always the same) ──
async function scrapeLiveHeat() {
  return await page.evaluate(() => {
    const result = { liveHeat: null, timer: null, round: '', eventLabel: '', divisionLabel: '' };

    // Detect which event/division is live from the nav
    const subNavItems = document.querySelectorAll('.post-event-watch-nav__sub-nav-item');
    subNavItems.forEach(item => {
      const text = item.textContent?.trim() || '';
      if (/in the water|live/i.test(text)) {
        result.divisionLabel = text.replace(/in the water/i, '').trim();
      }
    });

    // Also check the event-level nav for which event is active
    const eventNavItems = document.querySelectorAll('.post-event-watch-nav__event-item, .post-event-watch-nav__main-nav-item');
    eventNavItems.forEach(item => {
      if (item.classList.contains('active') || item.classList.contains('selected')) {
        result.eventLabel = item.textContent?.trim() || '';
      }
    });

    const currentSection = document.querySelector('.post-event-watch-current-heats');
    if (!currentSection) return result;

    const athletes = currentSection.querySelectorAll('.hot-heat-athlete[class*="athlete-id-"]');
    if (athletes.length === 0) return result;

    const headerText = currentSection.textContent || '';
    const roundMatch = headerText.match(/(Round of \d+|Quarterfinals|Semifinals|Final)/i);
    const heatNumMatch = headerText.match(/Heat\s*(\d+)/i);
    result.round = roundMatch?.[1] || '';

    const surfers = [];
    athletes.forEach(a => {
      const name = a.querySelector('.hot-heat-athlete__name--full')?.textContent?.trim() || '';
      const score = parseFloat(a.querySelector('.hot-heat-athlete__score')?.textContent?.trim()) || 0;
      const singlet = a.className.match(/singlet-(\w+)/)?.[1] || '';
      const sortOrder = parseInt(a.className.match(/athlete-sort-order-(\d+)/)?.[1]) || 0;
      const place = parseInt(a.className.match(/athlete-place-(\d+)/)?.[1]) || 0;
      const waveCount = parseInt(a.className.match(/waves-(\d+)/)?.[1]) || 0;
      const athleteId = a.className.match(/athlete-id-(\d+)/)?.[1] || '';
      const counted = a.querySelector('.hot-heat-athlete__counted-waves')?.textContent?.trim() || '';
      const diff = a.querySelector('.hot-heat-athlete__difference')?.textContent?.trim() || '';

      let status = 'active';
      if (a.className.includes('advance-winner')) status = 'advance-winner';
      else if (a.className.includes('advance')) status = 'advance';
      else if (a.className.includes('eliminated')) status = 'eliminated';

      const waves = [];
      a.querySelectorAll('.wave .wave-score').forEach(w => {
        const v = parseFloat(w.textContent?.trim());
        if (!isNaN(v)) waves.push(v);
      });
      const countedWaves = [];
      a.querySelectorAll('.wave--counted .wave-score').forEach(w => {
        const v = parseFloat(w.textContent?.trim());
        if (!isNaN(v)) countedWaves.push(v);
      });

      surfers.push({ name, score, singlet, sortOrder, place, waveCount, athleteId, counted, diff, status, waves, countedWaves });
    });

    // Timer
    const timerSelectors = ['.event-live-heat-time-remaining', '[class*="time-remaining"]', '.hot-heat__time'];
    for (const sel of timerSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.match(/\d+:\d+/)) {
        result.timer = el.textContent.trim().match(/(\d+:\d+)/)?.[1] || null;
        break;
      }
    }

    // Heat ID from grid
    const gridLive = document.querySelector('.post-event-watch-heat-grid__heat.status-live, .post-event-watch-heat-grid__heat[class*="status-live"]');
    const heatId = gridLive?.getAttribute('data-heat-id') || '';

    result.liveHeat = {
      heatId,
      heatNumber: parseInt(heatNumMatch?.[1]) || 0,
      round: result.round,
      surfers
    };

    return result;
  });
}

// ── SCRAPE COMPLETED HEATS FOR A DIVISION ──
async function scrapeDivisionHeats(eventKey, divKey) {
  const event = EVENTS[eventKey];
  const div = event.divisions[divKey];
  const url = BASE_URL + '?statEventId=' + div.statEventId;

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const data = await page.evaluate(() => {
      const result = { status: 'unknown', heats: [], roundInfo: [] };

      // Status from sub-nav
      const pageText = document.body.innerText || '';
      if (/in the water/i.test(pageText)) result.status = 'live';
      else if (/standby/i.test(pageText)) result.status = 'standby';
      else if (/completed/i.test(pageText)) result.status = 'completed';

      // Round navigation info
      const roundNavItems = document.querySelectorAll('.post-event-watch-rounds-nav__item, .post-event-watch-rounds__round-button, [class*="round-nav"] [class*="item"]');
      roundNavItems.forEach(item => {
        const text = item.textContent?.trim() || '';
        const parts = text.split('\n').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 1) {
          result.roundInfo.push({
            name: parts[0] || '',
            heatCount: parts[1] || '',
            status: parts[2] || ''
          });
        }
      });

      // All heat cards
      const heats = [];
      const heatCards = document.querySelectorAll('.post-event-watch-heat-grid__heat');
      heatCards.forEach(card => {
        const heatId = card.getAttribute('data-heat-id') || '';
        const isLive = card.className.includes('status-live');
        const headerEl = card.querySelector('[class*="heat-header"], [class*="heat-title"]');
        const heatLabel = headerEl?.textContent?.trim() || card.querySelector('.hot-heat-header')?.textContent?.trim() || '';
        const heatNumMatch = (heatLabel || card.textContent).match(/Heat\s*(\d+)/i);

        const athletes = [];
        card.querySelectorAll('.hot-heat-athlete[class*="athlete-id-"]').forEach(a => {
          const nameEl = a.querySelector('.hot-heat-athlete__name--full') || a.querySelector('[class*="name"]');
          const name = nameEl?.textContent?.trim() || '';
          const score = parseFloat(a.querySelector('.hot-heat-athlete__score, [class*="score"]')?.textContent?.trim()) || 0;
          const singlet = a.className.match(/singlet-(\w+)/)?.[1] || '';
          const athleteId = a.className.match(/athlete-id-(\d+)/)?.[1] || '';
          const sortOrder = parseInt(a.className.match(/athlete-sort-order-(\d+)/)?.[1]) || 0;
          const waveCount = parseInt(a.className.match(/waves-(\d+)/)?.[1]) || 0;
          const counted = a.querySelector('.hot-heat-athlete__counted-waves')?.textContent?.trim() || '';
          const diff = a.querySelector('.hot-heat-athlete__difference')?.textContent?.trim() || '';

          let status = 'active';
          if (a.className.includes('advance-winner')) status = 'advance-winner';
          else if (a.className.includes('advance')) status = 'advance';
          else if (a.className.includes('eliminated')) status = 'eliminated';

          const waves = [];
          a.querySelectorAll('.wave .wave-score').forEach(w => {
            const v = parseFloat(w.textContent?.trim());
            if (!isNaN(v)) waves.push(v);
          });

          athletes.push({ name, score, singlet, athleteId, sortOrder, waveCount, status, counted, diff, waves });
        });

        const isComplete = !isLive && athletes.some(a => a.status === 'advance' || a.status === 'eliminated' || a.status === 'advance-winner');

        heats.push({ heatId, heatNumber: parseInt(heatNumMatch?.[1]) || 0, isLive, isComplete, label: heatLabel, athletes });
      });

      result.heats = heats;
      return result;
    });

    return data;
  } catch (err) {
    console.error(`[scrape] Error ${eventKey}/${divKey}:`, err.message);
    return { status: 'error', heats: [], roundInfo: [] };
  }
}

// ── MAIN SCRAPE LOOP ──
async function scrapeAll() {
  if (scraping || !page) return;
  scraping = true;

  try {
    // 1. Scrape live heat (same from any page)
    const live = await scrapeLiveHeat();
    if (live.liveHeat) {
      store.liveHeat = live.liveHeat;
      store.liveTimer = live.timer;
      store.liveRound = live.round;

      // Determine which event/division is live
      // Multiple divisions can show "live" status (round in progress).
      // Cross-reference: check which division has a live heat in the grid with matching athletes
      let foundLive = false;
      const liveSurferNames = new Set(store.liveHeat.surfers.map(s => s.name.toLowerCase()));
      
      for (const [key, div] of Object.entries(store.divisions)) {
        if (div.status === 'live' && div.heats?.length) {
          // Check if any athletes in this division's heats match the live heat surfers
          const divAthletes = new Set();
          div.heats.forEach(h => h.athletes?.forEach(a => divAthletes.add(a.name.toLowerCase())));
          const overlap = [...liveSurferNames].filter(n => divAthletes.has(n));
          if (overlap.length >= 2) {
            store.liveEvent = div.eventKey;
            store.liveDivision = div.divKey;
            foundLive = true;
            break;
          }
        }
      }
      // Fallback: just pick first live division
      if (!foundLive) {
        for (const [key, div] of Object.entries(store.divisions)) {
          if (div.status === 'live') {
            store.liveEvent = div.eventKey;
            store.liveDivision = div.divKey;
            foundLive = true;
            break;
          }
        }
      }
      // Fallback to page label parsing if no division data yet
      if (!foundLive) {
        const divLabel = (live.divisionLabel || '').toLowerCase();
        if (/jr|junior/i.test(divLabel)) {
          store.liveEvent = 'junior';
          store.liveDivision = /women/i.test(divLabel) ? 'women' : 'men';
        } else {
          store.liveEvent = 'qs6000';
          store.liveDivision = /women/i.test(divLabel) ? 'women' : 'men';
        }
      }
    } else {
      store.liveHeat = null;
      store.liveEvent = null;
      store.liveDivision = null;
    }

    console.log(`[live] ${store.liveEvent || 'none'} ${store.liveDivision || ''} | ${store.liveRound} Heat ${store.liveHeat?.heatNumber || '-'} | ${store.liveHeat?.surfers?.length || 0} surfers | Timer: ${store.liveTimer || 'N/A'}`);

    // 2. Scrape each division's completed heats (rotate — one per cycle to reduce load)
    const divKeys = [];
    for (const [ek, ev] of Object.entries(EVENTS)) {
      for (const [dk, dv] of Object.entries(ev.divisions)) {
        divKeys.push({ eventKey: ek, divKey: dk, label: `${ev.shortName} ${dv.label}` });
      }
    }

    // Scrape one division per cycle (round-robin)
    if (!store._divIndex) store._divIndex = 0;
    const divToScrape = divKeys[store._divIndex % divKeys.length];
    store._divIndex++;

    const divData = await scrapeDivisionHeats(divToScrape.eventKey, divToScrape.divKey);
    const storeKey = `${divToScrape.eventKey}_${divToScrape.divKey}`;
    store.divisions[storeKey] = {
      ...divData,
      label: divToScrape.label,
      eventKey: divToScrape.eventKey,
      divKey: divToScrape.divKey,
      scrapedAt: Date.now()
    };
    console.log(`[heats] ${divToScrape.label}: ${divData.status} | ${divData.heats.length} heats | ${divData.roundInfo.length} rounds`);

    // 3. Compute stats
    computeStats();
    store.lastUpdate = Date.now();

  } catch (err) {
    console.error('[scrapeAll] Error:', err.message);
    try {
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      console.error('[scrapeAll] Reload failed, reinitializing...');
      if (browser) await browser.close().catch(() => {});
      await initBrowser();
    }
  }

  scraping = false;
}

// ── COMPUTE STATS ──
function computeStats() {
  const allWaves = [];
  const allHeatTotals = [];

  // From completed heats
  for (const [key, div] of Object.entries(store.divisions)) {
    for (const heat of (div.heats || [])) {
      for (const a of heat.athletes) {
        if (a.waves) {
          a.waves.forEach(w => {
            if (w > 0) allWaves.push({ score: w, athlete: a.name, event: div.label, heat: heat.label || `Heat ${heat.heatNumber}` });
          });
        }
        if (a.score > 0 && heat.isComplete) {
          allHeatTotals.push({ total: a.score, athlete: a.name, event: div.label, heat: heat.label || `Heat ${heat.heatNumber}` });
        }
      }
    }
  }

  // From live heat
  if (store.liveHeat) {
    const evLabel = EVENTS[store.liveEvent]?.shortName || '';
    const divLabel = EVENTS[store.liveEvent]?.divisions[store.liveDivision]?.label || '';
    const label = `${evLabel} ${divLabel}`;
    for (const s of store.liveHeat.surfers) {
      if (s.waves) s.waves.forEach(w => {
        if (w > 0) allWaves.push({ score: w, athlete: s.name, event: label, heat: `Heat ${store.liveHeat.heatNumber}` });
      });
      if (s.score > 0) allHeatTotals.push({ total: s.score, athlete: s.name, event: label, heat: `Heat ${store.liveHeat.heatNumber}` });
    }
  }

  // Deduplicate
  const seen = new Set();
  const dedupeWaves = allWaves.filter(w => { const k = `${w.athlete}-${w.score}-${w.heat}-${w.event}`; if (seen.has(k)) return false; seen.add(k); return true; });
  dedupeWaves.sort((a, b) => b.score - a.score);

  const seen2 = new Set();
  const dedupeTotals = allHeatTotals.filter(t => { const k = `${t.athlete}-${t.total}-${t.heat}-${t.event}`; if (seen2.has(k)) return false; seen2.add(k); return true; });
  dedupeTotals.sort((a, b) => b.total - a.total);

  store.stats = {
    topWaves: dedupeWaves.slice(0, 15),
    topHeatTotals: dedupeTotals.slice(0, 15),
    excellentWaves: dedupeWaves.filter(w => w.score >= 8.0).length,
    totalHeatsScraped: Object.values(store.divisions).reduce((s, d) => s + (d.heats?.length || 0), 0)
  };
}

// ── EXPRESS API ──
const app = express();
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// Live heat — backward compatible + supports ?event=junior
app.get('/api/live', (req, res) => {
  const filterEvent = req.query.event; // qs6000, junior, or omitted for auto
  
  // Build allDivisions first (always included)
  const allDivisions = Object.fromEntries(
    Object.entries(EVENTS).flatMap(([ek, ev]) =>
      Object.entries(ev.divisions).map(([dk, dv]) => {
        const storeKey = `${ek}_${dk}`;
        return [`${ek}_${dk}`, {
          eventKey: ek,
          divKey: dk,
          eventName: ev.shortName,
          label: dv.label,
          status: store.divisions[storeKey]?.status || 'unknown',
          isLive: store.liveEvent === ek && store.liveDivision === dk
        }];
      })
    )
  );

  // If filtering by event and it's NOT the currently live event,
  // return the most recent completed heat data from that event's divisions
  if (filterEvent && filterEvent !== store.liveEvent && EVENTS[filterEvent]) {
    const event = EVENTS[filterEvent];
    // Find the division with the most recent/best data
    let bestDiv = null;
    let bestKey = null;
    for (const [dk, dv] of Object.entries(event.divisions)) {
      const storeKey = `${filterEvent}_${dk}`;
      const stored = store.divisions[storeKey];
      if (stored && stored.heats?.length > 0) {
        if (!bestDiv || stored.heats.length > bestDiv.heats.length) {
          bestDiv = stored;
          bestKey = dk;
        }
      }
    }

    // Return last completed heat as "most recent" for this event
    let lastHeat = null;
    if (bestDiv?.heats?.length) {
      const completed = bestDiv.heats.filter(h => h.isComplete);
      const latest = completed[completed.length - 1];
      if (latest) {
        lastHeat = {
          heatId: latest.heatId || '',
          heatNumber: latest.heatNumber,
          round: latest.label || '',
          timer: null,
          surfers: latest.athletes.map(a => ({
            ...a,
            priority: a.sortOrder === 1 ? 'P' : a.sortOrder > 0 ? String(a.sortOrder) : null
          }))
        };
      }
    }

    return res.json({
      source: 'puppeteer-multi-event',
      timestamp: store.lastUpdate,
      age: Date.now() - store.lastUpdate,
      liveEvent: store.liveEvent,
      liveDivision: store.liveDivision,
      filteredEvent: filterEvent,
      event: event.shortName,
      division: bestKey ? event.divisions[bestKey].label : null,
      timer: null,
      round: lastHeat?.round || '',
      status: bestDiv?.status || 'standby',
      liveHeat: lastHeat,
      isFiltered: true,
      allDivisions
    });
  }

  // Default: return the current live heat
  const response = {
    source: 'puppeteer-multi-event',
    timestamp: store.lastUpdate,
    age: Date.now() - store.lastUpdate,
    liveEvent: store.liveEvent,
    liveDivision: store.liveDivision,
    event: store.liveEvent ? EVENTS[store.liveEvent].shortName : null,
    division: store.liveDivision ? EVENTS[store.liveEvent]?.divisions[store.liveDivision]?.label : null,
    timer: store.liveTimer,
    round: store.liveRound,
    liveHeat: store.liveHeat ? {
      heatId: store.liveHeat.heatId || '',
      heatNumber: store.liveHeat.heatNumber,
      round: store.liveHeat.round || store.liveRound,
      timer: store.liveTimer ? { remaining: store.liveTimer } : null,
      surfers: store.liveHeat.surfers.map(s => ({
        ...s,
        priority: s.sortOrder === 1 ? 'P' : s.sortOrder > 0 ? String(s.sortOrder) : null
      }))
    } : null,
    allDivisions
  };
  res.json(response);
});

// Events summary
app.get('/api/events', (req, res) => {
  const events = {};
  for (const [ek, ev] of Object.entries(EVENTS)) {
    events[ek] = { name: ev.name, shortName: ev.shortName, divisions: {} };
    for (const [dk, dv] of Object.entries(ev.divisions)) {
      const storeKey = `${ek}_${dk}`;
      const stored = store.divisions[storeKey];
      events[ek].divisions[dk] = {
        label: dv.label,
        status: stored?.status || 'unknown',
        heatCount: stored?.heats?.length || 0,
        roundInfo: stored?.roundInfo || [],
        isLive: store.liveEvent === ek && store.liveDivision === dk
      };
    }
  }
  res.json({ events, liveEvent: store.liveEvent, liveDivision: store.liveDivision, lastUpdate: store.lastUpdate });
});

// Rounds + heats for a division
app.get('/api/rounds', (req, res) => {
  const { event, division } = req.query;
  if (!event || !division) return res.json({ error: 'Provide ?event=qs6000&division=men' });
  const storeKey = `${event}_${division}`;
  const div = store.divisions[storeKey];
  if (!div) return res.json({ error: 'Not found', heats: [], roundInfo: [] });
  res.json({ event: EVENTS[event]?.shortName, division: EVENTS[event]?.divisions[division]?.label, ...div });
});

// Stats
app.get('/api/stats', (req, res) => res.json(store.stats));

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true, lastUpdate: store.lastUpdate, age: Date.now() - store.lastUpdate,
    liveEvent: store.liveEvent, liveDivision: store.liveDivision,
    divisions: Object.fromEntries(Object.entries(store.divisions).map(([k, v]) => [k, { status: v.status, heats: v.heats?.length || 0 }]))
  });
});

process.on('uncaughtException', (err) => console.error('Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err.message || err));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] WSL Multi-Event Scraper on port ${PORT}`);
  initBrowser().then(() => {
    scrapeAll();
    setInterval(scrapeAll, 8_000); // Live heat every 8s, one division's heats per cycle
  }).catch(err => console.error('[server] Browser init failed:', err.message));
});
