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
  { label: "hanang0700",    utcExpr: "0 4 * * *",   eatLabel: "07:00" },
  { label: "loolmalas1000", utcExpr: "0 7 * * *",   eatLabel: "10:00" },
  { label: "lengai1230",    utcExpr: "30 9 * * *",  eatLabel: "12:30" },
  { label: "mawenzi1400",   utcExpr: "0 11 * * *",  eatLabel: "14:00" },
  { label: "kili1615",      utcExpr: "15 13 * * *", eatLabel: "16:15" },
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
async function firePaymentsForChannel(channel: string, tickLabel: string): Promise<void> {
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
      return;
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    status = String(body.status || `http_${r.status}`);
    planSize = typeof body.plan_size === "number" ? body.plan_size : 0;
    if (!r.ok) {
      console.error(`[statement-worker] ${channel} ${tickLabel} start HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return;
    }
    if (status === "up_to_date" || planSize === 0) {
      console.log(`[statement-worker] ${channel} ${tickLabel}: up-to-date — no windows to fire`);
      return;
    }
    console.log(`[statement-worker] ${channel} ${tickLabel}: ${status}, plan_size=${planSize} — polling lock`);
  } catch (err) {
    console.error(`[statement-worker] ${channel} ${tickLabel} start threw:`, (err as Error).message);
    return;
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
      return;
    }
    const locked = await isChannelLocked(channel);
    if (!locked) {
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      console.log(`[statement-worker] ✅ ${channel} ${tickLabel} done in ${elapsedSec}s (plan_size=${planSize})`);
      return;
    }
    await sleep(POLL_MS);
  }
  console.warn(`[statement-worker] ⚠ ${channel} ${tickLabel} timed out after ${MAX_WAIT_MS / 60_000} min — lock still held`);
}

async function firePaymentsForAllChannels(tickLabel: string): Promise<void> {
  for (const channel of PAYMENT_CHANNELS) {
    if (stopping) return;
    await firePaymentsForChannel(channel, tickLabel);
  }
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
      return;
    }

    // Phase 2: payments — start endpoint enforces auto_upload_enabled itself
    // (returns 503 if disabled). We still call it so logs show whether the
    // gate is open or closed.
    const paymentsStart = Date.now();
    await firePaymentsForAllChannels(label);
    const paymentsMin = ((Date.now() - paymentsStart) / 60_000).toFixed(1);
    const totalMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
    console.log(
      `[statement-worker] ── ${label} DONE total=${totalMin} min (payments=${paymentsMin} min) ──`,
    );
  } catch (err) {
    console.error("[statement-worker] tick threw (should not happen, runAllCycles swallows):", err);
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
