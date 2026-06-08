import cron from "node-cron";
import { config } from "../config.js";
import { runAllCycles, runAllMeruCycles, runBankWithRetry } from "./runAllCycles.js";
import { isLoopEnabled } from "./loopControl.js";
import { runNmbCycle } from "./runNmbCycle.js";
import { runCrdbCycle } from "./runCrdbCycle.js";
import { NMB_SCREENSHOT_PATHS, CRDB_SCREENSHOT_PATHS } from "./cycleReport.js";
import { triggerAutoUpload, triggerAutoUploadAll } from "./triggerAutoUpload.js";

// On-demand fires: the dashboard's Fire NMB / Fire CRDB buttons write a
// value to app_settings.fire_request via BRAIN. The long-running worker
// polls between heartbeats and runs the requested bank in-process — on
// THIS service's Standard plan (2GB), not on Render's default Starter
// plan that one-off jobs use.
async function checkFireRequest(): Promise<"NMB" | "CRDB" | null> {
  const base = (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
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
  const base = (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
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
 * Long-running statement-pull worker.
 *
 * Scheduling: cron-aligned to fire exactly 15 minutes BEFORE each BRAIN
 * autonomous-Claude upload tick. This guarantees the sheet is up-to-date
 * before the upload reads it, and prevents the race where the scraper
 * appends rows mid-upload-batch. Operator-mandated 2026-06-04 (refined
 * from the initial 20-min to 15-min — same intent, tighter buffer).
 *
 *   BRAIN upload tick (EAT)  →  scraper fires at (EAT)  →  cron expr (UTC)
 *   meru0300          03:00  →   02:45                  →  45 23 * * *  (prev day UTC)
 *   hanang0700        07:00  →   06:45                  →  45 3  * * *
 *   loolmalas1000     10:00  →   09:45                  →  45 6  * * *
 *   lengai1300        13:00  →   12:45                  →  45 9  * * *
 *   kili1615          16:15  →   16:00                  →   0 13 * * *
 *   mawenzi1800       18:00  →   17:45                  →  45 14 * * *
 *   kibo2100          21:00  →   20:45                  →  45 17 * * *
 *
 * Each tick runs NMB first, then CRDB (sequential — one OTP relay phone).
 * The worker NO LONGER auto-triggers the BRAIN upload at end-of-tick;
 * BRAIN's own scheduler is the sole owner of upload scheduling now.
 *
 * Manual fires from the dashboard still work — fire-request is polled
 * every 60s between scheduled ticks. Same behavior as before.
 *
 * Kill switches:
 *   STATEMENT_PULL_PAUSED=true        — skip ALL ticks (env)
 *   statement_pull_enabled=false      — skip ticks (BRAIN app_settings)
 */

interface ScheduleEntry {
  label: string;
  utcExpr: string;
  eatLabel: string;
}

const SCHEDULE: ScheduleEntry[] = [
  { label: "pre-meru0300",      utcExpr: "45 23 * * *", eatLabel: "02:45" },
  { label: "pre-hanang0700",    utcExpr: "45 3 * * *",  eatLabel: "06:45" },
  { label: "pre-loolmalas1000", utcExpr: "45 6 * * *",  eatLabel: "09:45" },
  { label: "pre-lengai1300",    utcExpr: "45 9 * * *",  eatLabel: "12:45" },
  { label: "pre-kili1615",      utcExpr: "0 13 * * *",  eatLabel: "16:00" },
  { label: "pre-mawenzi1800",   utcExpr: "45 14 * * *", eatLabel: "17:45" },
  { label: "pre-kibo2100",      utcExpr: "45 17 * * *", eatLabel: "20:45" },
];

let stopping = false;
let tickInFlight = false;

async function runScheduledTick(label: string): Promise<void> {
  if (tickInFlight) {
    console.log(`[statement-worker] ${label} fired but a tick is already in flight — skipping`);
    return;
  }
  if (config.STATEMENT_PULL_PAUSED) {
    console.log(`[statement-worker] ${label} fired but STATEMENT_PULL_PAUSED=true → skipping`);
    return;
  }
  if (!(await isLoopEnabled())) {
    console.log(`[statement-worker] ${label} fired but statement_pull_enabled=false in app_settings → skipping`);
    return;
  }

  tickInFlight = true;
  const tickStart = Date.now();
  console.log(`[statement-worker] ── ${label} START ${new Date().toISOString()} ──`);
  try {
    // pre-meru0300 uses runAllMeruCycles which scrapes YESTERDAY + TODAY
    // in two separate sync phases per bank (Frank 2026-06-08 spec). All
    // other ticks use the regular today-only cycle.
    const isMeru = label === "pre-meru0300";
    const result = isMeru ? await runAllMeruCycles() : await runAllCycles();
    const elapsedMin = ((Date.now() - tickStart) / 60_000).toFixed(1);
    console.log(
      `[statement-worker] ── ${label} DONE in ${elapsedMin} min — ` +
        `nmb=${result.nmbOk ? "ok" : "fail"} crdb=${result.crdbOk ? "ok" : "fail"} mode=${isMeru ? "MERU(yesterday+today)" : "regular(today-only)"}`,
    );
    // NOTE: deliberately do NOT call triggerAutoUploadAll() here. BRAIN's
    // autonomous-Claude scheduler is the sole owner of QB upload timing
    // now (it fires 20 min after this tick). Frank's rule from 2026-06-04:
    // the 20-min gap prevents mid-batch race conditions where the scraper
    // appends rows while an upload reads them.
  } catch (err) {
    console.error("[statement-worker] tick threw (should not happen, runAllCycles swallows):", err);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Background poller that watches for manual fire-requests from the
 * dashboard. Runs every 60s independently of the cron schedule. Manual
 * fires DO still trigger an immediate auto-upload for the bank in
 * question — keeps the dashboard "Fire NMB" button useful for operators
 * who want an out-of-cycle pull → push.
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
      // Manual fires still chain into an immediate auto-upload — operator
      // intent is "pull and push now", not "pull and wait for next BRAIN
      // tick". Per Frank: "i need to manual to stay the same" (2026-06-04).
      if (fireBank === "NMB") {
        await triggerAutoUpload("nmbnew");
      } else {
        await triggerAutoUpload("bank");
        await triggerAutoUpload("iphone_bank");
      }
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
