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

### Circuit breaker (Frank 2026-07-XX)
On transient errors: 3 retries → cookie re-login → OTP request → 30-min pause. Gated on portal-death only (per memory `project_brain_consumers` note "CRDB puller: gate the OTP retry cascade on portal-death only").

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

6. **If OTP is the blocker** (fresh login demands OTP): `sms_inbox` should populate with the OTP. If it's EMPTY over the 30-min window when CRDB should be logging in, the SMS-gateway phone is offline / APK not running. Check:
   ```sql
   SELECT COUNT(*) FROM sms_inbox WHERE received_at >= NOW() - INTERVAL '30 min';
   ```
   And `brain_pings` (columns `id, phone, battery_pct, received_at`) for the SMS gateway phone's heartbeat.

**Key insight from today's debug**: `systemctl is-active` = green ≠ puller delivering data. The real signal is `crdb_pull_last_ok_completed_at` freshness AND matching rows landing on the sheet at the last-received timestamp Frank sees.

**Frank's timing check to keep in mind**: If EAT time is 15:18 and the last CRDB row on the sheet is at 14:18 → 1h gap = broken, even if the service shows active. Always cross-check clock time (EAT) vs latest sheet row.

## OTP flow

- CRDB requires OTP SMS on login when session is expired
- OTP arrives on Frank's phone → SMS gateway APK captures → posts to BRAIN's `/api/sms-inbox` → row lands in `sms_inbox` table
- Puller polls `sms_inbox` for the recent CRDB-sender OTP within its login flow
- If phone offline / APK not running → OTP never lands → puller times out on login
- Phone heartbeat health lives in `brain_pings` table (managed by BRAIN)

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
