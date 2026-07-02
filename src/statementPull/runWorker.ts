import cron from "node-cron";
import { config } from "../config.js";
import { runAllCycles, runBankWithRetry } from "./runAllCycles.js";
import { isLoopEnabled } from "./loopControl.js";
import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";
import { NMB_SCREENSHOT_PATHS, CRDB_SCREENSHOT_PATHS } from "./cycleReport.js";

// On-demand fires: the dashboard's Fire NMB / Fire CRDB buttons write a
// value to app_settings.fire_request via BRAIN. The long-running worker
// polls between heartbeats and runs the requested bank in-process — on
// THIS service's Standard plan (2GB), not on Render's default Starter
// plan that one-off jobs use.
async function checkFireRequest(): Promise<"NMB" | "CRDB" | null> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return null;
  try {
    const r = await fetch(`${base}/cycles/fire-request`, {
      headers: { "X-Report-Secret": secret },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { value?: string };
    const v = (body.value || "").toUpperCase().trim();
    if (v === "NMB" || v === "CRDB") return v;
    return null;
  } catch {
    return null;
  }
}

async function clearFireRequest(): Promise<void> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/cycles/fire-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: JSON.stringify({ value: "" }),
    });
  } catch {}
}

/**
 * Long-running statement-pull + payment-upload worker.
 *
 * Each scheduled tick fires at the tick name's EAT time:
 *   1. Run NMB + CRDB scrappers (gap-fill — pulls last_passed_date..today
 *      inclusive, processor handles dedup).
 *   2. After both scrappers complete, fire payment uploads for all three
 *      channels (nmbnew, bank, iphone_bank) by calling
 *      POST /api/payment-batches/start/:channel which uses the catchup
 *      planner to compute the correct window(s) for each channel.
 *   3. Channels fire SEQUENTIALLY with arrears-cache invalidation between
 *      them — prevents the NMB-closes-X-then-iPhone-uses-stale-arrears
 *      double-pay race (Frank 2026-06-14).
 *
 *   tick (EAT)     cron expr (UTC)   notes
 *   meru0100       0 22 * * *        yesterday-tail flips to today via 16:16 boundary
 *   meru0300       0 0  * * *        today
 *   hanang0700     0 4  * * *        today
 *   loolmalas1000  0 7  * * *        today
 *   lengai1230     30 9 * * *        today
 *   mawenzi1400    0 11 * * *        today
 *   kili1615       15 13 * * *       today
 *   kibo1900       0 16 * * *        flips to tomorrow (post-16:16 boundary)
 *   kibo2100       0 18 * * *        flips to tomorrow
 *
 * The planner inside BRAIN owns the per-window AS_OF + payment_date logic
 * based on the 16:16 EAT business-day boundary — worker just calls start.
 *
 * Manual fires from the dashboard still work — fire-request is polled
 * every 60s. Manual fires DO NOT chain into payment uploads — Frank
 * 2026-06-14: auto-upload triggers statement-pull, not the other way round.
 *
 * Kill switches:
 *   STATEMENT_PULL_PAUSED=true        — skip ALL ticks (env)
 *   statement_pull_enabled=false      — skip scrapper phase (BRAIN app_settings)
 *   auto_upload_enabled=false         — skip payment phase (enforced by the
 *                                       BRAIN start endpoint itself)
 */

interface ScheduleEntry {
  label: string;
  utcExpr: string;
  eatLabel: string;
}

const SCHEDULE: ScheduleEntry[] = [
  { label: "meru0100",      utcExpr: "0 22 * * *",  eatLabel: "01:00" }, // prev-day UTC
  { label: "meru0300",      utcExpr: "0 0 * * *",   eatLabel: "03:00" },
  // Frank 2026-06-28: meru0300 has been failing many days in a row; add a
  // 05:00 EAT catchup so the morning ritual has a fresh upload to read.
  // Holds the same yesterday-tail rules as meru0100/meru0300.
  { label: "meru0500",      utcExpr: "0 2 * * *",   eatLabel: "05:00" },
  { label: "hanang0700",    utcExpr: "0 4 * * *",   eatLabel: "07:00" },
  { label: "loolmalas1000", utcExpr: "0 7 * * *",   eatLabel: "10:00" },
  { label: "lengai1230",    utcExpr: "30 9 * * *",  eatLabel: "12:30" },
  { label: "mawenzi1400",   utcExpr: "0 11 * * *",  eatLabel: "14:00" },
  // Frank 2026-07-02: env-driven override — set KILI_CRON_OVERRIDE to
  // shift the last-tick-of-the-day (e.g. "0 14 * * *" for 17:00 EAT).
  // Label stays 'kili1615' for downstream watchers that match on name.
  // Unset the env var to revert to standard 16:15.
  { label: "kili1615",
    utcExpr: process.env.KILI_CRON_OVERRIDE || "15 13 * * *",
    eatLabel: process.env.KILI_EAT_LABEL_OVERRIDE || "16:15" },
  { label: "kibo1900",      utcExpr: "0 16 * * *",  eatLabel: "19:00" },
  { label: "kibo2100",      utcExpr: "0 18 * * *",  eatLabel: "21:00" },
];

// Frank 2026-06-15: iphone_bank OUT of scheduled auto-upload for now.
// Manual fires only via dashboard. Re-add to the array once validated.
const PAYMENT_CHANNELS = ["nmbnew", "bank"] as const;

let stopping = false;
let tickInFlight = false;

function brainBase(): string {
  return (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
}

async function brainCall(path: string, init?: RequestInit): Promise<Response | null> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return null;
  const headers = new Headers(init?.headers);
  headers.set("X-Report-Secret", secret);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

async function clearArrearsCache(): Promise<void> {
  try {
    const r = await brainCall("/admin/clear-arrears-cache", { method: "POST" });
    if (r && !r.ok) console.warn(`[statement-worker] clear-arrears-cache HTTP ${r.status}`);
  } catch (err) {
    console.warn(`[statement-worker] clear-arrears-cache threw:`, (err as Error).message);
  }
}

async function isChannelLocked(channel: string): Promise<boolean> {
  try {
    const r = await brainCall(`/admin/auto-upload-lock-status?channel=${channel}`);
    if (!r || !r.ok) return false;
    const body = (await r.json()) as { locked?: boolean };
    return !!body.locked;
  } catch {
    return false;
  }
}

/**
 * Fire payments for one channel and wait until the channel lock releases.
 * The start endpoint runs windows in setImmediate background and only
 * releases the lock in its finally block — so lock-released = all windows
 * finalized (or errored out).
 *
 * Returns even if the wait times out — the next tick can pick up any gap
 * via the catchup planner.
 */
// Per-channel outcome so the tick-end report to BRAIN can describe what
// each channel actually did (Frank 2026-06-28 — boss-watches-the-SMS rule).
type ChannelOutcome = {
  status: "ok" | "fail" | "skip"; // skip = up_to_date / planSize=0 / BRAIN unconfigured
  plan_size: number;
  reason?: string;
};

async function firePaymentsForChannel(channel: string, tickLabel: string): Promise<ChannelOutcome> {
  console.log(`[statement-worker] firing payments: channel=${channel} tick=${tickLabel}`);
  await clearArrearsCache();

  const t0 = Date.now();
  let planSize = 0;
  let status = "unknown";
  try {
    const r = await brainCall(`/payment-batches/start/${channel}`, {
      method: "POST",
      body: JSON.stringify({ tick_name: tickLabel }),
    });
    if (!r) {
      console.warn(`[statement-worker] ${channel} ${tickLabel}: BRAIN not configured, skipping`);
      return { status: "skip", plan_size: 0, reason: "brain_not_configured" };
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    status = String(body.status || `http_${r.status}`);
    planSize = typeof body.plan_size === "number" ? body.plan_size : 0;
    if (!r.ok) {
      console.error(`[statement-worker] ${channel} ${tickLabel} start HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return { status: "fail", plan_size: 0, reason: `start_http_${r.status}` };
    }
    if (status === "up_to_date" || planSize === 0) {
      console.log(`[statement-worker] ${channel} ${tickLabel}: up-to-date — no windows to fire`);
      return { status: "skip", plan_size: 0, reason: "up_to_date" };
    }
    console.log(`[statement-worker] ${channel} ${tickLabel}: ${status}, plan_size=${planSize} — polling lock`);
  } catch (err) {
    console.error(`[statement-worker] ${channel} ${tickLabel} start threw:`, (err as Error).message);
    return { status: "fail", plan_size: 0, reason: `start_threw:${(err as Error).message.slice(0, 60)}` };
  }

  // Poll the channel lock every 10s for up to 20 min — plenty for a
  // multi-window catchup (each window ~30-90s incl QB pre-flight + push).
  const MAX_WAIT_MS = 20 * 60_000;
  const POLL_MS = 10_000;
  const deadline = Date.now() + MAX_WAIT_MS;
  // Give the start endpoint a moment to acquire the lock before we start polling.
  await sleep(3_000);
  while (Date.now() < deadline) {
    if (stopping) {
      console.warn(`[statement-worker] ${channel} ${tickLabel}: shutdown requested, aborting wait`);
      return { status: "fail", plan_size: planSize, reason: "shutdown_requested" };
    }
    const locked = await isChannelLocked(channel);
    if (!locked) {
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      console.log(`[statement-worker] ✅ ${channel} ${tickLabel} done in ${elapsedSec}s (plan_size=${planSize})`);
      return { status: "ok", plan_size: planSize };
    }
    await sleep(POLL_MS);
  }
  console.warn(`[statement-worker] ⚠ ${channel} ${tickLabel} timed out after ${MAX_WAIT_MS / 60_000} min — lock still held`);
  return { status: "fail", plan_size: planSize, reason: "lock_timeout" };
}

/**
 * Self-report tick outcome to BRAIN so the m6pm tick-result watcher
 * decides what to SMS based on what the worker actually believes
 * happened — not just the row count in payment_batches at +20min.
 * Frank 2026-06-28: prevents transient BRAIN restarts that eat the
 * batch insert from reaching the admin broadcast list as false panic.
 *
 * Best-effort: any error here is swallowed; the tick itself succeeded
 * or failed independently of telemetry delivery.
 */
async function postTickOutcome(
  tick: string,
  status: "ok" | "fail",
  channels: Record<string, ChannelOutcome>,
  reason?: string,
): Promise<void> {
  try {
    const totalRows = Object.values(channels).reduce((s, c) => s + (c.plan_size || 0), 0);
    const channelMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(channels)) channelMap[k] = v.status;
    const r = await brainCall("/admin/tick-outcome", {
      method: "POST",
      body: JSON.stringify({
        tick,
        status,
        rows_seen: totalRows,
        channels: channelMap,
        reason: reason || null,
      }),
    });
    if (r && !r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[statement-worker] tick-outcome POST HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[statement-worker] tick-outcome POST threw (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * NMB_VIA_POC=true path: signal the hosted NMB-live-pull service to fire
 * an immediate pull cycle, then wait for it to complete. The POC service
 * polls BRAIN every ~15s and breaks its 5-min sleep when a new request
 * appears. We poll completion state every 10s until completed_at is set
 * past requested_at, or until timeoutMs elapses.
 *
 * On timeout we treat it as nmb=fail so the asymmetric policy skips
 * payments — the next scheduled tick will retry. If the POC has crashed
 * or is offline, no scheduled tick fires payments until it recovers,
 * which is the correct safety behavior.
 */
async function requestPocPullAndWait(timeoutMs: number): Promise<{ ok: boolean; reason?: string; durationMs: number }> {
  const t0 = Date.now();
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    return { ok: false, reason: "BRAIN_REPORT_URL/SECRET missing", durationMs: 0 };
  }
  // 1. POST the request so the POC sees it on its next 15s poll.
  let requestedAt: string;
  try {
    const r = await fetch(`${base}/nmb-pull/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return { ok: false, reason: `BRAIN /nmb-pull/request HTTP ${r.status}`, durationMs: Date.now() - t0 };
    }
    const body = (await r.json()) as { requested_at?: string };
    requestedAt = body.requested_at || new Date().toISOString();
  } catch (err) {
    return { ok: false, reason: `request threw: ${(err as Error).message.slice(0, 120)}`, durationMs: Date.now() - t0 };
  }
  console.log(`[statement-worker] POC pull requested at ${requestedAt} — waiting up to ${timeoutMs / 60_000} min`);

  // 2. Poll completion. Sleep 10s between probes — POC fires within ~15s
  //    of seeing the request and takes ~2 min to download+upload, so most
  //    polls hit during the pull and we want responsiveness when it lands.
  const POLL_MS = 10_000;
  const deadline = Date.now() + timeoutMs;
  // Give the POC a moment to see the request before our first probe.
  await sleep(15_000);
  while (Date.now() < deadline) {
    if (stopping) return { ok: false, reason: "worker shutting down", durationMs: Date.now() - t0 };
    try {
      const r = await fetch(`${base}/nmb-pull/state`, {
        headers: { "X-Report-Secret": secret },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const body = (await r.json()) as { completed_at?: string | null; pending?: boolean; result?: { ok?: boolean; error?: string } };
        const completed = body.completed_at || "";
        if (completed && completed > requestedAt) {
          if (body.result?.ok) {
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`[statement-worker] ✅ POC pull complete in ${dur}s`);
            return { ok: true, durationMs: Date.now() - t0 };
          }
          return { ok: false, reason: body.result?.error || "POC reported failure", durationMs: Date.now() - t0 };
        }
      }
    } catch {
      /* transient — keep polling */
    }
    await sleep(POLL_MS);
  }
  return { ok: false, reason: `timed out after ${timeoutMs / 60_000} min`, durationMs: Date.now() - t0 };
}

/**
 * Fallback freshness check for NMB POC delegation: if the on-demand pull
 * failed, check BRAIN's /nmb-pull/state.last_ok_completed_at. The POC's
 * own 5-min schedule populates this on every successful cycle, so a recent
 * value means the NMB sheet has fresh rows even when on-demand fails.
 */
async function checkPocSheetFreshness(
  maxAgeMs: number,
): Promise<{ fresh: boolean; ageSec: number; lastOkAt: string | null }> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return { fresh: false, ageSec: Infinity, lastOkAt: null };
  try {
    const r = await fetch(`${base}/nmb-pull/state`, {
      headers: { "X-Report-Secret": secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { fresh: false, ageSec: Infinity, lastOkAt: null };
    const body = (await r.json()) as { last_ok_completed_at?: string | null };
    const lastOk = body.last_ok_completed_at || null;
    if (!lastOk) return { fresh: false, ageSec: Infinity, lastOkAt: null };
    const ageMs = Date.now() - new Date(lastOk).getTime();
    return { fresh: ageMs >= 0 && ageMs <= maxAgeMs, ageSec: ageMs / 1000, lastOkAt: lastOk };
  } catch {
    return { fresh: false, ageSec: Infinity, lastOkAt: null };
  }
}

async function firePaymentsForAllChannels(tickLabel: string): Promise<Record<string, ChannelOutcome>> {
  const out: Record<string, ChannelOutcome> = {};
  for (const channel of PAYMENT_CHANNELS) {
    if (stopping) {
      out[channel] = { status: "skip", plan_size: 0, reason: "shutdown_requested" };
      continue;
    }
    out[channel] = await firePaymentsForChannel(channel, tickLabel);
  }
  return out;
}

async function runScheduledTick(label: string): Promise<void> {
  if (tickInFlight) {
    console.log(`[statement-worker] ${label} fired but a tick is already in flight — skipping`);
    return;
  }
  if (config.STATEMENT_PULL_PAUSED) {
    console.log(`[statement-worker] ${label} fired but STATEMENT_PULL_PAUSED=true → skipping`);
    return;
  }
  const loopEnabled = await isLoopEnabled();

  tickInFlight = true;
  const tickStart = Date.now();
  console.log(`[statement-worker] ── ${label} START ${new Date().toISOString()} ──`);
  try {
    // Phase 1: scrappers
    let nmbOk = false;
    let crdbOk = false;
    if (!loopEnabled) {
      console.log(`[statement-worker] ${label} skipping scrapper phase — statement_pull_enabled=false in app_settings`);
    } else if (process.env.NMB_VIA_POC === "true") {
      // Frank 2026-06-16: NMB allows only ONE active session. When the
      // hosted NMB-live-pull service holds the persistent session, this
      // worker MUST NOT log in to NMB itself (NMB rejects the second
      // login as suspicious — meru0300 failure 2026-06-16). Instead we
      // signal the POC to fire an immediate pull and wait for it. CRDB
      // still runs locally on this worker — no conflict.
      console.log(`[statement-worker] ${label} NMB_VIA_POC=true — delegating NMB to POC service`);
      const [nmbPocResult, crdbResult] = await Promise.all([
        requestPocPullAndWait(15 * 60_000),
        runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS),
      ]);
      // Asymmetric-policy nuance: an on-demand POC pull can fail
      // transiently (NMB SPA flake, CSV download timeout, etc.) even when
      // the POC's own 5-min schedule is healthy and the sheet has fresh
      // rows from a recent good cycle. Treat NMB as OK if EITHER the
      // on-demand call succeeded OR the POC's last successful cycle
      // completed within NMB_FRESH_MS — meaning the sheet is fresh enough
      // to fire payments accurately.
      let nmbStatusLabel: string;
      if (nmbPocResult.ok) {
        nmbOk = true;
        nmbStatusLabel = "ok";
      } else {
        // Freshness window = POC scheduled interval (5 min) + cycle duration
        // slack (~60s). If last_ok_completed_at is within 6 min, POC has not
        // missed a scheduled cycle — sheet has data from the last good pull.
        // Older than 6 min means POC missed at least one scheduled cycle and
        // the sheet might be stale, so nmb=fail correctly.
        const fresh = await checkPocSheetFreshness(6 * 60_000);
        if (fresh.fresh) {
          nmbOk = true;
          nmbStatusLabel = `ok (on-demand failed: ${nmbPocResult.reason || "POC timeout"}; sheet still fresh, last good POC cycle ${fresh.ageSec.toFixed(0)}s ago)`;
        } else {
          nmbOk = false;
          nmbStatusLabel = `fail (${nmbPocResult.reason || "POC timeout"}; last good POC cycle ${fresh.lastOkAt || "unknown"} — sheet stale)`;
        }
      }
      crdbOk = crdbResult;
      const scrapperMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
      console.log(
        `[statement-worker] ${label} scrappers DONE in ${scrapperMin} min — ` +
          `nmb=${nmbStatusLabel} crdb=${crdbOk ? "ok" : "fail"}`,
      );
    } else {
      const result = await runAllCycles();
      nmbOk = result.nmbOk;
      crdbOk = result.crdbOk;
      const scrapperMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
      console.log(
        `[statement-worker] ${label} scrappers DONE in ${scrapperMin} min — ` +
          `nmb=${nmbOk ? "ok" : "fail"} crdb=${crdbOk ? "ok" : "fail"}`,
      );
    }

    // Asymmetric failure policy (Frank 2026-06-15):
    //   NMB OK + CRDB OK   → fire payments (normal path)
    //   NMB OK + CRDB FAIL → fire payments anyway (CRDB is few txns, NMB is main)
    //   NMB FAIL           → SKIP payments entirely (NMB is essential; CRDB alone not worth firing)
    if (loopEnabled && !nmbOk) {
      const totalMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
      console.warn(
        `[statement-worker] ── ${label} SKIPPED PAYMENTS total=${totalMin} min — ` +
          `NMB scrapper failed (nmb=fail crdb=${crdbOk ? "ok" : "fail"}); NMB is the main channel, ` +
          `firing payments without it not worth it. Manual fix the NMB scrapper / sheet then re-fire.`,
      );
      await postTickOutcome(label, "fail", {}, `nmb_scrapper_failed`);
      return;
    }

    // Phase 2: payments — start endpoint enforces auto_upload_enabled itself
    // (returns 503 if disabled). We still call it so logs show whether the
    // gate is open or closed.
    const paymentsStart = Date.now();
    const channelOutcomes = await firePaymentsForAllChannels(label);
    const paymentsMin = ((Date.now() - paymentsStart) / 60_000).toFixed(1);
    const totalMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
    console.log(
      `[statement-worker] ── ${label} DONE total=${totalMin} min (payments=${paymentsMin} min) ──`,
    );

    // Self-report outcome. Tick is "ok" overall when EVERY channel
    // ended ok or skip (skip = up_to_date / no windows). Any fail
    // surfaces in the channels map and the watcher decides what to
    // SMS — it no longer relies on payment_batches row count alone.
    const channelStatuses = Object.values(channelOutcomes).map((c) => c.status);
    const anyFail = channelStatuses.includes("fail");
    const tickStatus: "ok" | "fail" = anyFail ? "fail" : "ok";
    const failReasons = Object.entries(channelOutcomes)
      .filter(([, v]) => v.status === "fail")
      .map(([k, v]) => `${k}:${v.reason || "fail"}`)
      .join("; ");
    await postTickOutcome(label, tickStatus, channelOutcomes, failReasons || undefined);
  } catch (err) {
    console.error("[statement-worker] tick threw (should not happen, runAllCycles swallows):", err);
    await postTickOutcome(label, "fail", {}, `tick_threw:${(err as Error).message.slice(0, 80)}`);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Background poller that watches for manual fire-requests from the
 * dashboard. Runs every 60s independently of the cron schedule.
 */
async function startFireRequestPoller(): Promise<void> {
  while (!stopping) {
    await sleep(60_000);
    if (stopping) break;
    const fireBank = await checkFireRequest();
    if (!fireBank) continue;
    if (tickInFlight) {
      console.log(`[statement-worker] fire request for ${fireBank} received but a tick is in flight — will retry`);
      continue;
    }
    console.log(`[statement-worker] 🔥 manual fire received — bank=${fireBank}`);
    tickInFlight = true;
    await clearFireRequest();
    const t0 = Date.now();
    try {
      if (fireBank === "NMB") {
        await runBankWithRetry("NMB", runNmbCycle, NMB_SCREENSHOT_PATHS);
      } else {
        await runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS);
      }
      console.log(`[statement-worker] manual ${fireBank} done in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
    } catch (err) {
      console.error(`[statement-worker] manual ${fireBank} threw:`, err);
    } finally {
      tickInFlight = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function startScheduledTicks(): void {
  console.log(
    `[statement-worker] starting cron-aligned scheduler — ${SCHEDULE.length} ticks/day, ` +
      `paused=${config.STATEMENT_PULL_PAUSED}`,
  );
  for (const s of SCHEDULE) {
    cron.schedule(s.utcExpr, () => {
      void runScheduledTick(s.label);
    }, { timezone: "UTC" });
    console.log(`[statement-worker]   ${s.label} → ${s.eatLabel} EAT (cron: ${s.utcExpr} UTC)`);
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[statement-worker] received ${sig} — shutting down`);
    stopping = true;
  });
}

startScheduledTicks();
startFireRequestPoller().catch((err) => {
  console.error("[statement-worker] fire-request poller FATAL:", err);
  process.exit(1);
});

// Keep the process alive even if both functions return.
setInterval(() => {}, 1 << 30);
