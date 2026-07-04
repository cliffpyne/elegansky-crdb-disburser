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

/**
 * brainCall + retry on 5xx or network throw. Fixes 07-03 loolmalas1000
 * incident: a 1-sec BRAIN 502 blip during cold-start took down the bank/CRDB
 * fire AND the tick-outcome SMS in the same window. Frank's rule: retry the
 * per-channel fetch independently, still one bundled SMS at the end.
 *
 * The retry is caller-opt-in — `clearArrearsCache` and lock polling stay
 * single-shot (they poll on their own cadence), only the load-bearing calls
 * (payment start + tick-outcome) use this.
 */
async function brainCallRetry(
  path: string,
  init: RequestInit | undefined,
  attempts = 5,       // Frank 2026-07-04 kibo1900: was 3×2s = 6s coverage,
  backoffMs = 5000,   // not enough for typical Render cold-starts. 5×5s
                      // = 25s covers most transient BRAIN outages without
                      // sacrificing responsiveness on healthy paths.
): Promise<Response | null> {
  let lastErr: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await brainCall(path, init);
      if (r === null) return null; // BRAIN not configured — don't retry
      if (r.ok) return r;
      // Retry on 5xx (transient) — NOT on 4xx (client error, deterministic)
      if (r.status >= 500 && i < attempts) {
        console.warn(`[statement-worker] brainCall ${path} HTTP ${r.status} attempt ${i}/${attempts} — retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      return r; // non-retryable OR last attempt with error
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.warn(`[statement-worker] brainCall ${path} threw attempt ${i}/${attempts}: ${(err as Error).message.slice(0, 100)} — retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
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
    const r = await brainCallRetry(`/payment-batches/start/${channel}`, {
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
    const r = await brainCallRetry("/admin/tick-outcome", {
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
 * {NMB,CRDB}_VIA_POC=true path: signal the hosted live-pull POC to fire an
 * immediate pull cycle, then wait for it to complete. The POC polls BRAIN
 * every ~15s and breaks its 5-min sleep when a new request appears. We poll
 * completion state every 10s until completed_at is set past requested_at,
 * or until timeoutMs elapses.
 *
 * On timeout we treat it as fail so the asymmetric policy handles it — the
 * next scheduled tick will retry. If the POC has crashed or is offline, no
 * scheduled tick fires payments until it recovers (correct safety behavior).
 *
 * @param channel "nmb" or "crdb" — selects the pull endpoint pair
 */
async function requestPocPullAndWait(
  channel: "nmb" | "crdb",
  timeoutMs: number,
): Promise<{ ok: boolean; reason?: string; durationMs: number }> {
  const t0 = Date.now();
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    return { ok: false, reason: "BRAIN_REPORT_URL/SECRET missing", durationMs: 0 };
  }
  const requestPath = `/${channel}-pull/request`;
  const statePath = `/${channel}-pull/state`;
  // 1. POST the request so the POC sees it on its next 15s poll.
  let requestedAt: string;
  try {
    const r = await fetch(`${base}${requestPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      return { ok: false, reason: `BRAIN ${requestPath} HTTP ${r.status}`, durationMs: Date.now() - t0 };
    }
    const body = (await r.json()) as { requested_at?: string };
    requestedAt = body.requested_at || new Date().toISOString();
  } catch (err) {
    return { ok: false, reason: `request threw: ${(err as Error).message.slice(0, 120)}`, durationMs: Date.now() - t0 };
  }
  console.log(`[statement-worker] ${channel.toUpperCase()} POC pull requested at ${requestedAt} — waiting up to ${timeoutMs / 60_000} min`);

  const POLL_MS = 10_000;
  const deadline = Date.now() + timeoutMs;
  await sleep(15_000);
  while (Date.now() < deadline) {
    if (stopping) return { ok: false, reason: "worker shutting down", durationMs: Date.now() - t0 };
    try {
      const r = await fetch(`${base}${statePath}`, {
        headers: { "X-Report-Secret": secret },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) {
        const body = (await r.json()) as { completed_at?: string | null; pending?: boolean; result?: { ok?: boolean; error?: string } };
        const completed = body.completed_at || "";
        if (completed && completed > requestedAt) {
          if (body.result?.ok) {
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`[statement-worker] ✅ ${channel.toUpperCase()} POC pull complete in ${dur}s`);
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
 * Fallback freshness check for POC delegation: if the on-demand pull failed,
 * check BRAIN's /{channel}-pull/state.last_ok_completed_at. The POC's own
 * 5-min schedule populates this on every successful cycle, so a recent value
 * means the sheet has fresh rows even when on-demand fails.
 */
async function checkPocSheetFreshness(
  channel: "nmb" | "crdb",
  maxAgeMs: number,
): Promise<{ fresh: boolean; ageSec: number; lastOkAt: string | null }> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return { fresh: false, ageSec: Infinity, lastOkAt: null };
  try {
    const r = await fetch(`${base}/${channel}-pull/state`, {
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
    } else if (process.env.NMB_VIA_POC === "true" || process.env.CRDB_VIA_POC === "true") {
      // Frank 2026-06-16 / 2026-07-03: NMB and CRDB each allow only ONE
      // active session — when a hosted live-puller holds the persistent
      // session, this worker MUST NOT log in itself (bank rejects the
      // second login). Each channel is delegated independently:
      //   NMB_VIA_POC=true  → delegate NMB; run CRDB locally (unless
      //                        CRDB_VIA_POC=true, then delegate too)
      //   CRDB_VIA_POC=true → delegate CRDB; run NMB locally (unless
      //                        NMB_VIA_POC=true, then delegate too)
      const nmbViaPoc = process.env.NMB_VIA_POC === "true";
      const crdbViaPoc = process.env.CRDB_VIA_POC === "true";
      console.log(
        `[statement-worker] ${label} POC delegation: NMB=${nmbViaPoc ? "POC" : "local"} CRDB=${crdbViaPoc ? "POC" : "local"}`,
      );
      const [nmbResult, crdbResult] = await Promise.all([
        nmbViaPoc
          ? requestPocPullAndWait("nmb", 15 * 60_000)
          : runBankWithRetry("NMB", runNmbCycle, NMB_SCREENSHOT_PATHS).then((ok) => ({ ok, reason: undefined as string | undefined, durationMs: 0 })),
        crdbViaPoc
          ? requestPocPullAndWait("crdb", 15 * 60_000)
          : runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS).then((ok) => ({ ok, reason: undefined as string | undefined, durationMs: 0 })),
      ]);

      // Asymmetric-policy nuance for POC delegation: transient on-demand
      // failures can happen even when the POC's 5-min schedule is healthy.
      // Treat OK if EITHER on-demand succeeded OR last_ok_completed_at is
      // within the freshness window (6 min = 5-min cadence + 60s slack).
      const resolveChannel = async (
        channel: "nmb" | "crdb",
        viaPoc: boolean,
        result: { ok: boolean; reason?: string },
      ): Promise<{ ok: boolean; label: string }> => {
        if (!viaPoc) return { ok: result.ok, label: result.ok ? "ok" : "fail" };
        if (result.ok) return { ok: true, label: "ok" };
        const fresh = await checkPocSheetFreshness(channel, 6 * 60_000);
        if (fresh.fresh) {
          return {
            ok: true,
            label: `ok (on-demand failed: ${result.reason || "POC timeout"}; sheet still fresh, last good POC cycle ${fresh.ageSec.toFixed(0)}s ago)`,
          };
        }
        return {
          ok: false,
          label: `fail (${result.reason || "POC timeout"}; last good POC cycle ${fresh.lastOkAt || "unknown"} — sheet stale)`,
        };
      };
      const nmbResolved = await resolveChannel("nmb", nmbViaPoc, nmbResult);
      const crdbResolved = await resolveChannel("crdb", crdbViaPoc, crdbResult);
      nmbOk = nmbResolved.ok;
      crdbOk = crdbResolved.ok;
      const scrapperMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
      console.log(
        `[statement-worker] ${label} scrappers DONE in ${scrapperMin} min — ` +
          `nmb=${nmbResolved.label} crdb=${crdbResolved.label}`,
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
      // Build a human-readable failure reason (Frank 2026-07-04). Never emit
      // "worker: nmb_scrapper_failed" — that language is wrong (workers don't
      // fail; the NMB or CRDB site does). Read the categorized error the
      // puller wrote into the POC state and hand that to postTickOutcome so
      // the SMS says exactly what's wrong on the bank's side.
      const readCategorized = async (channel: "nmb" | "crdb"): Promise<string | null> => {
        const base = brainBase();
        const secret = process.env.STATEMENT_REPORT_SECRET;
        if (!base || !secret) return null;
        try {
          const r = await fetch(`${base}/${channel}-pull/state`, {
            headers: { "X-Report-Secret": secret },
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) return null;
          const body = (await r.json()) as { result?: { error?: string } };
          return body.result?.error || null;
        } catch { return null; }
      };
      const nmbReason = await readCategorized("nmb");
      const crdbReason = crdbOk ? null : await readCategorized("crdb");
      const parts: string[] = [];
      if (nmbReason) parts.push(nmbReason);
      else parts.push("NMB site unresponsive");
      if (crdbReason) parts.push(crdbReason);
      const reason = parts.join("; ");
      console.warn(
        `[statement-worker] ── ${label} SKIPPED PAYMENTS total=${totalMin} min — ` +
          `${reason} (nmb=fail crdb=${crdbOk ? "ok" : "fail"})`,
      );
      await postTickOutcome(label, "fail", {}, reason);
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
