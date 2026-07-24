# eleganskyCrdb — Cold-start brief for Claude Code sessions

## What this is

The **CRDB portal scraper** — a Playwright-driven Node service that logs into `omnichannels.crdbbank.co.tz`, downloads bank statement rows every 5 minutes, and posts them to the shared Google Sheet's PASSED tab (CRDB channel).

Mirrors the same POC pattern used by the NMB puller (see BRAIN's `project_brain_consumers` memory).

## Where it runs

- **Host**: VPS `169.58.17.126` (same box as BRAIN)
- **App dir on VPS**: `/home/eleg/eleganskyCrdb`
- **Systemd service**: `crdb-live-puller.service`
- **ExecStart** (from unit file):
  ```
  /usr/bin/xvfb-run -a /usr/bin/node --env-file=/home/eleg/eleganskyCrdb/.env \
    /home/eleg/eleganskyCrdb/dist/poc/crdbLivePuller.js
  ```
- **Runtime**: `RuntimeMaxSec=7200` (2h) + `Restart=always` + `RestartSec=15` — every 2 hours systemd force-kills the process to reset browser state, then restarts 15s later
- **Rendering**: Xvfb virtual display :99 (headless Chromium via Playwright, `--no-sandbox`)
- **Git remote**: `git@github.com:cliffpyne/elegansky-crdb-disburser.git` — branch `main`
- **NB**: repo name is `elegansky-crdb-disburser` on GitHub but the on-disk dir is `eleganskyCrdb`. Historically this repo was for a "disburser" (outbound money) and now hosts the puller too — do not delete or rename without confirming.

## What it does per cycle (5-min interval)

1. Restore session cookies from BRAIN's `app_settings.crdb_cookies_latest` (or fresh login if missing)
2. Navigate to CRDB portal, click SEARCH button, wait for URL change (`page.waitForURL`, 15s timeout)
3. Fetch statement rows in the last window
4. POST rows to BRAIN (which appends to Google Sheet PASSED tab)
5. Update `app_settings` with: `crdb_pull_completed_at`, `crdb_pull_last_ok_completed_at` (only on ok), `crdb_pull_result_json`, refreshed `crdb_cookies_latest`

## How to deploy changes

```
git push origin main   # from operator's PC
```
Or (SCP fallback if GitHub SSH is unreachable):
```
scp <changed files> root@169.58.17.126:/home/eleg/eleganskyCrdb/<path>/
ssh root@169.58.17.126 "cd /home/eleg/eleganskyCrdb && npm run build && systemctl restart crdb-live-puller"
```

**Deploy safety**: check `auto_upload_locks` first (see BRAIN's CLAUDE.md rule) — a restart of this service alone shouldn't impact live QB pushes, but if a BRAIN fire depends on a mid-cycle CRDB pull, timing can bite.

## Health checks / debugging

```bash
# Is the service alive?
ssh root@169.58.17.126 "systemctl is-active crdb-live-puller.service"

# Latest pull result (ok:true or error?)
ssh root@169.58.17.126 "psql \$DB -c \"SELECT key, value FROM app_settings WHERE key='crdb_pull_result_json'\""

# Was the last OK pull recent?
ssh root@169.58.17.126 "psql \$DB -c \"SELECT EXTRACT(EPOCH FROM (NOW()-updated_at))::int AS age_s FROM app_settings WHERE key='crdb_pull_last_ok_completed_at'\""

# Journal tail
ssh root@169.58.17.126 "journalctl -u crdb-live-puller.service -n 50 --no-pager -o cat"
```

**"POC is off" symptom**: sheet stops getting fresh CRDB rows. Two flavors:
1. Service dead — `systemctl is-active` says failed
2. Service alive but pulls failing — check `crdb_pull_result_json` for the specific error

## Common failures + fixes

### `page.waitForURL: Timeout 15000ms exceeded`
Login succeeded but the post-login navigation stalled. Try in order:
1. `systemctl restart crdb-live-puller` (resets browser state, often enough)
2. If still failing: **clear cached cookies** then restart:
   ```sql
   DELETE FROM app_settings WHERE key='crdb_cookies_latest';
   ```
3. If still failing: portal side is degraded — check the CRDB portal manually in a real browser
4. If still failing: check OTP flow — `sms_inbox` should have a recent CRDB OTP; if empty, the phone-side SMS gateway isn't capturing

### `CRDB SEARCH button hung`
Post-login page loaded but SEARCH click hung. Same recovery ladder as above — restart usually clears it.

### Circuit breaker + gated OTP cascade (Frank 2026-07-24, commit `07ca7f4`)
Both pullers, on a failed cycle:
1. **Attempt 2 — cookie relogin** (cheap, no OTP if cookies still valid server-side)
2. **Attempt 3 — fresh OTP login**, but ONLY when portal-death is proven:
   the session-dead classifier fired OR the cookie relogin itself threw
   "cookies expired or invalid". A cookie-relogin rejection IS portal-death —
   this was the 07-22/07-24 CRDB trap where waitForURL timeouts (page stuck
   on Login.xhtml) were classified "unclassified" → OTP never fired →
   endless 30-min circuits until a human purged cookies.
3. **Max 1 OTP per failure streak** (`lastCycleBurnedOtp`, reset on success
   or circuit-close). The 07-23 overnight NMB storm burned ~1 OTP per failed
   cycle all night and got the VPS IP session-killed by NMB's fraud layer.
4. 3 consecutive transients → **circuit open**: 30-min pause, session
   preserved, no OTP. On-demand tick requests break the pause early.
5. 3 consecutive portal-deaths (or cycle-1 portal-death post-restart) →
   purge cookies + exit → systemd restarts → fresh OTP login.

## 2026-07-21 session — real-world debug walkthrough

**Symptom Frank flagged**: "the POC is not running" — but `systemctl is-active` said `active`. The service was alive but not producing fresh rows on the sheet (last row was ~1h old).

**Investigation ladder** (do this in order next time):

1. **Confirm the "alive but not delivering" pattern**:
   ```sql
   SELECT key, EXTRACT(EPOCH FROM (NOW()-updated_at))::int AS age_s, value
     FROM app_settings
    WHERE key IN ('crdb_pull_result_json','crdb_pull_last_ok_completed_at')
    ORDER BY key;
   ```
   If `crdb_pull_result_json` has `"ok":false`, service is running but failing every cycle. If `last_ok_completed_at` is > 10 min old, that's real trouble.

2. **Check the specific error** in `crdb_pull_result_json` value. Today's errors seen:
   - `"CRDB unclassified: page.waitForURL: Timeout 15000ms exceeded"` (login post-nav hang)
   - `"CRDB SEARCH button hung"` (post-login search click hang)

3. **Restart counter** — systemd's `NRestarts` (`systemctl show crdb-live-puller.service -p NRestarts`). Today it was at 34 by early afternoon — meaning `RuntimeMaxSec=7200` was killing the service every 2h and each restart was hitting the same login failure. High restart count = login flow needs cookie/OTP intervention, not just more restarts.

4. **First recovery attempt (restart alone)**: worked ONCE (first post-restart cycle was `ok:true, durationMs:57127`), but the SECOND cycle hit `SEARCH button hung` and subsequent cycles all failed the same way. So restart alone is fragile.

5. **Second recovery attempt (clear cookies + restart)**: this is the pattern that stuck.
   ```
   DELETE FROM app_settings WHERE key='crdb_cookies_latest';
   systemctl restart crdb-live-puller.service
   ```
   After this, the puller had to do a full fresh login. First cycle result: `ok:true, durationMs:53902`. Recovery held.

6. **If OTP is the blocker** (fresh login demands OTP): check the TAN relay's
   event log — `GET /internal/tan/events` on the Render relay with
   `X-Tan-Secret` (see "OTP flow" section). Codes flowing = pipeline fine;
   silence during a login attempt = boss/relay phone offline or forwarder
   app dead → physical phone check. (The original version of this step
   pointed at `sms_inbox`/`brain_pings` — both wrong, see OTP flow section.)

**Key insight from today's debug**: `systemctl is-active` = green ≠ puller delivering data. The real signal is `crdb_pull_last_ok_completed_at` freshness AND matching rows landing on the sheet at the last-received timestamp Frank sees.

**Frank's timing check to keep in mind**: If EAT time is 15:18 and the last CRDB row on the sheet is at 14:18 → 1h gap = broken, even if the service shows active. Always cross-check clock time (EAT) vs latest sheet row.

## 2026-07-22..24 outages — key learnings

- **CRDB endless-circuit trap (07-22 + 07-24)**: session dead + cookies dead,
  but errors classified "unclassified/waitForURL" → OTP never escalated →
  30-min circuits forever. Fixed in `07ca7f4`: cookie-relogin rejection now
  counts as portal-death and self-escalates to fresh OTP.
- **NMB OTP storm (07-23 overnight)**: unconditional attempt-3 OTP burned one
  code per failed cycle all night; NMB's fraud layer then killed fresh
  sessions within seconds (419 "User session expired") and SPA clicks timed
  out — from the VPS IP only. Fixed in `07ca7f4`: OTP gated on portal-death,
  max 1 per failure streak.
- **VPS-IP vs code disambiguation**: the same code ran flawlessly from the
  operator's PC while failing from the VPS. Debug pattern: `systemctl stop
  nmb-live-puller` on the VPS FIRST (one NMB session per user — two pullers
  kill each other), then locally `NMB_HEADLESS=false npm run nmb:live:poc`
  (visible browser; OTPs still come from the relay). If local is clean, the
  problem is the VPS IP's standing with the bank — cool it down a few hours,
  then move back.
- **"All rows skipped" ≠ broken**: processor responses with `passed: 0,
  skipped: N` mean dedup found nothing new — a quiet bank, not a dead
  puller. Check when the last `passed > 0` cycle was before declaring an
  outage: `grep 'processor response' <log> | grep -v '"passed":0'`.
- Logs live at `/var/log/nmb-live-puller.log` and
  `/var/log/crdb-live-puller.log` (systemd `StandardOutput=append:`), NOT in
  journalctl — the journal only shows service starts/stops.

## OTP flow (corrected 2026-07-24 — the old sms_inbox description was WRONG)

- Both CRDB and NMB need an OTP/TAN SMS on fresh login (not on cookie login)
- **Real pipeline**: bank SMS → boss phone → relay phone → POST to the Render
  TAN relay (`https://elegansky-crdb-disburser.onrender.com/internal/tan`,
  Redis-backed). Pullers poll `GET /internal/tan/latest` with `X-Tan-Secret`
  (from `.env`) for up to 240s after clicking SEND ME TAN / Login
- **Debug endpoint**: `GET /internal/tan/events` — last 50 webhook posts with
  masked codes + result (stored/duplicate/rejected). If it's silent during a
  login attempt, the break is PHONE-SIDE (physical check), even when the
  relay web service returns HTTP 200
- BRAIN's `sms_inbox` table is NOT part of this flow (it's empty/unused here)
- Phone heartbeat health lives in **`phone_heartbeats`** (NOT `brain_pings` —
  that table doesn't exist). NB: the heartbeat phone (255752900450) may not
  be the same phone as the TAN chain — a fresh heartbeat does not prove the
  TAN pipeline works
- **Gotcha**: `cycle_heartbeats` rows with worker_id `statement-pull` are
  written by these live pullers themselves (legacy default in
  cycleReport.ts) — a fresh `last_seen` there is NOT evidence that the old
  Render `elegansky-statement-pull` worker is running

## What NOT to do

- **Don't disable RuntimeMaxSec** — the 2h reset is intentional to avoid memory leaks + stale browser state
- **Don't log OTP codes or cookies** — sensitive
- **Don't push during payment tick fires** — check `auto_upload_locks` first per BRAIN rule
- **Don't `--no-sandbox` "just because"** — required for Chromium in Xvfb, keep it
- **Don't commit `.env`** — has portal credentials

## What this brief does NOT include

- The exact portal DOM selectors (they change; grep the code)
- Exact login credential storage (in `.env`, sensitive)
- The `disburser` side of this repo if it still exists (this file focuses on the puller)

## Cross-repo context (BRAIN is upstream)

When Claude Code loads this file, it also auto-loads the two imports below —
so you know what BRAIN is, what its sacred rules are, and what changed there
recently. Never re-derive BRAIN state from scratch when the answer is here.

@/var/www/html/EleganskyBrain/CLAUDE.md
@/home/clifforddennis/.claude/projects/-var-www-html-EleganskyBrain/memory/MEMORY.md

For recent BRAIN activity, run:

    git -C /var/www/html/EleganskyBrain log --oneline -20
