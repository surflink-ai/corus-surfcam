# Corus Surf Cam — Architecture Redesign

## Current Problems

### 1. Scraper Goes Stale
**Root cause:** Single Puppeteer page session. WSL's page uses WebSocket/XHR polling to update live scores. After ~20-60 minutes, Chrome's connection to WSL dies silently. The scraper keeps running `page.evaluate()` but reads the same frozen DOM. Express keeps serving the old data. Nobody knows it's stale.

**Why current fix doesn't work:** The watchdog checks `store.lastUpdate` but that gets set every 8s because `scrapeAll()` "succeeds" — it just reads stale DOM. The new score-hash watchdog helps but still has a 3-minute blind spot, and relies on page reload which can also fail.

### 2. Process Management is Fragile  
**Root cause:** SSH-launched Node processes die when SSH disconnects. `Start-Process -WindowStyle Hidden` doesn't reliably work for Puppeteer (Chrome needs a window station). `ssh -f` works but is unreliable. No proper service manager.

### 3. Monitor Creates False Alerts
**Root cause:** Monitor script takes >120s (SSH + restart + wait + recheck), gets killed by cron timeout, which triggers a false alert. Also, staleness threshold was too aggressive for between-heat pauses.

### 4. DNS Incident
**Root cause:** Added corus.surf to Cloudflare which hijacked DNS. Already fixed and documented in MEMORY.md. Won't happen again.

---

## Redesigned Architecture

### Core Principle: **Eliminate Puppeteer entirely.**

Puppeteer is the single point of failure. It's heavy (750MB RAM), fragile (Chrome sessions die), slow to restart (30s), and impossible to reliably keep alive as a background service on Windows.

### New Approach: Direct HTTP Scraping

WSL's live page loads data via XHR/fetch calls. We can intercept those URLs and call them directly — no browser needed. This gives us:

- **No Chrome process** — just Node.js HTTP requests
- **No stale DOM** — fresh HTTP response every request  
- **10x less RAM** — ~50MB vs 750MB
- **Instant restart** — 2s vs 30s
- **Runs as Windows Service** — trivial with node-windows or NSSM

### Implementation Plan

#### Phase 1: Reverse-engineer WSL data endpoints
1. Open WSL live page in Chrome DevTools
2. Monitor Network tab for XHR/fetch calls during a live heat
3. Find the JSON endpoint(s) that deliver:
   - Live heat surfers + scores
   - Heat status (in progress, completed)
   - Division/event status
4. Document the endpoints and response shapes

#### Phase 2: New scraper (`wsl-scraper-v2`)
```
wsl-scraper-v2/
├── index.js          # Express server + polling loop
├── wsl-client.js     # HTTP client for WSL endpoints
├── package.json
└── install-service.js # NSSM service installer
```

**Key features:**
- Pure HTTP fetch — no Puppeteer, no Chrome
- Poll WSL endpoints every 3 seconds
- Built-in health check with actual data freshness
- CORS headers for browser access
- Automatic retry with exponential backoff
- Structured logging with timestamps

**Fallback:** If WSL doesn't have clean JSON endpoints (everything is server-rendered HTML), use lightweight HTML parsing with `cheerio` instead of Puppeteer. Still no browser needed — just HTTP GET + parse.

#### Phase 3: Proper Windows service
- Install with NSSM (Non-Sucking Service Manager): `nssm install CorusScraper "C:\Program Files\nodejs\node.exe" "C:\Users\paew8\wsl-scraper-v2\index.js"`
- Auto-start on boot
- Auto-restart on crash (5s delay)
- Logs to file with rotation
- No SSH dependency

#### Phase 4: Tunnel as Windows service
- `nssm install CorusTunnel "C:\Program Files (x86)\cloudflared\cloudflared.exe" "tunnel --url http://localhost:3810 run --token <TOKEN>"`
- Same auto-start/restart behavior

#### Phase 5: Simplified monitor
- Only checks `scraper.corus.surf/health`
- Health endpoint returns: `{ status, age, event, heat, uptimeSeconds }`
- If age > 60s AND competition is live → alert (check WSL schedule)
- If HTTP error → alert
- No SSH, no restart attempts (NSSM handles restarts)
- Monitor just alerts — services self-heal

#### Phase 6: Frontend improvements
- Poll interval: 3 seconds (done)
- Event toggle pills (QS 6000 / JR PRO)
- Division toggle fix
- "Coming Up" card for standby divisions
- Drawer: full rounds view, stats tab

---

## Migration Plan

1. **Today:** Investigate WSL data endpoints (Phase 1)
2. **Build v2 scraper** with HTTP-only approach (Phase 2)
3. **Install NSSM** on Razer, set up both services (Phase 3-4)
4. **Switch DNS** from old scraper to v2 (same port, zero downtime)
5. **Simplify monitor** (Phase 5)
6. **Frontend features** (Phase 6)

Total effort: ~2-3 hours for phases 1-5. Phase 6 is separate.
