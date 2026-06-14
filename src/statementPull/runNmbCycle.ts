import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";
import { sortNmbCsvByDateInPlace } from "./sortNmbCsv.js";

/**
 * Gap-fill NMB statement-pull cycle (Frank 2026-06-14).
 *
 * Flow:
 *   1. Ask BRAIN for the last date stamped in the NMB PASSED tab (looks at
 *      the last 10 non-empty rows of date col B and picks the max).
 *   2. Compute the gap list = [last_passed_date .. today] inclusive, ascending.
 *      The lower bound IS re-pulled so we catch yesterday-evening tail
 *      transactions that posted after the previous cron ran. The processor's
 *      dedup absorbs the overlap.
 *   3. Log in ONCE (one OTP) and pull each gap day same-day, sorting +
 *      uploading after each.
 *
 * Examples:
 *   last=2026-06-13, today=2026-06-14  →  pull [2026-06-13, 2026-06-14]
 *   last=2026-06-10, today=2026-06-14  →  pull [10,11,12,13,14]
 *
 * If BRAIN is unreachable or the sheet has no parseable date, we fall back
 * to a single same-day pull for today so the cycle never silently fails.
 */
export async function runNmbCycle(): Promise<unknown> {
  const today = ymd(new Date());
  const gapDays = await computeGapDays(today);
  console.log(`[runNmbCycle] gap to pull (${gapDays.length}): ${gapDays.join(", ")}`);

  const results: unknown[] = [];
  for (let i = 0; i < gapDays.length; i++) {
    const day = gapDays[i]!;
    console.log(`[runNmbCycle] ──── DAY ${day} (${i + 1}/${gapDays.length}) — fresh login ────`);
    // Frank 2026-06-14: per-day fresh login. NMB's post-login "Attention"
    // promo modal + the Oracle JET account-details page state both make
    // single-session multi-day brittle (Day 2 silently sees stale page
    // and the date-period control scroll times out). One OTP per day,
    // tested locally before deploy.
    const savePath = `/tmp/nmb_statement_${day}.csv`;
    const { browser, page, log } = await nmbLogin();
    try {
      await nmbDownloadStatement(page, log, { dateFromYmd: day, dateToYmd: day, savePath });
      log.step("sort NMB CSV by Value Date (preserve metadata + header)");
      const sortRes = sortNmbCsvByDateInPlace(savePath);
      log.detail(`sorted ${sortRes.rowsSorted} data rows, ${sortRes.rowsUnparsed} unparseable (kept at end)`);
      log.step(`upload ${day} statement to transaction-processor`);
      const result = await uploadStatement(savePath, "NMB");
      log.info(`processor response for ${day}`, { result });
      results.push({ day, result });
    } finally {
      if (browser.isConnected()) {
        log.info("closing browser");
        await browser.close().catch(() => {});
      }
    }
  }
  console.log(`[runNmbCycle] ✅ cycle complete (${gapDays.length} day(s) pulled)`);
  return { days: gapDays, results };
}

/**
 * Ask BRAIN what the last date in NMB's PASSED tab is, then return the
 * inclusive ascending list of days from that date through today. If BRAIN
 * is unavailable or returns nothing parseable, fall back to [today] so the
 * cycle still runs.
 */
async function computeGapDays(todayYmd: string): Promise<string[]> {
  const last = await fetchLastPassedDate();
  if (!last) {
    console.warn(`[runNmbCycle] last_passed_date unavailable — falling back to today-only`);
    return [todayYmd];
  }
  if (last > todayYmd) {
    console.warn(`[runNmbCycle] last_passed_date ${last} is AFTER today ${todayYmd}? falling back to today-only`);
    return [todayYmd];
  }
  return enumerateYmd(last, todayYmd);
}

function brainBase(): string {
  return (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
}

async function fetchLastPassedDate(): Promise<string | null> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[runNmbCycle] BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET missing — cannot fetch last-passed-date`);
    return null;
  }
  try {
    const r = await fetch(`${base}/admin/nmb-last-passed-date`, {
      headers: { "X-Report-Secret": secret },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      console.error(`[runNmbCycle] last-passed-date HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return null;
    }
    const ymd = typeof body.last_passed_date === "string" ? body.last_passed_date : null;
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      console.error(`[runNmbCycle] last-passed-date returned malformed value: ${JSON.stringify(body)}`);
      return null;
    }
    console.log(`[runNmbCycle] BRAIN says last_passed_date=${ymd} (sample=${JSON.stringify(body.sample).slice(0, 200)})`);
    return ymd;
  } catch (err) {
    console.error(`[runNmbCycle] fetchLastPassedDate threw:`, (err as Error).message);
    return null;
  }
}

/** Inclusive ascending ["2026-06-10","2026-06-11",...,"2026-06-14"]. */
function enumerateYmd(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const from = new Date(fromYmd + "T00:00:00Z");
  const to = new Date(toYmd + "T00:00:00Z");
  const MAX = 31; // safety rail — never pull more than a month in one cycle
  for (let i = 0; i <= MAX; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const s = ymd(d);
    out.push(s);
    if (d.getTime() >= to.getTime()) break;
  }
  return out;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Standalone-script entry point: `npm run pull:nmb` or `pull:nmb:dev`.
// We delegate to runBankWithRetry so manual fires get the same retry
// policy AND — crucially — always-fire reportCycle wrapper as the
// scheduled worker. Without this, any thrown error here bypassed BRAIN
// and the cycle vanished from the dashboard.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  import("./runAllCycles.js")
    .then(async ({ runBankWithRetry }) => {
      const { NMB_SCREENSHOT_PATHS } = await import("./cycleReport.js");
      // Top-level safety nets: even if reportCycle throws, never exit
      // before flushing logs.
      installCrashHandlers("NMB", NMB_SCREENSHOT_PATHS);
      const ok = await runBankWithRetry("NMB", runNmbCycle, NMB_SCREENSHOT_PATHS);
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("[runNmbCycle main] uncaught:", err);
      process.exit(1);
    });
}

function installCrashHandlers(bank: "NMB" | "CRDB", paths: string[]) {
  const fireAndExit = async (label: string, err: unknown) => {
    const msg = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
    console.error(`[${bank}] ${label}:`, msg.slice(0, 500));
    try {
      const { reportCycle } = await import("./cycleReport.js");
      const now = new Date();
      await reportCycle({
        bank,
        status: "fail",
        startedAt: now,
        finishedAt: now,
        workerId: (process.env.WORKER_ID ?? "statement-pull") + `#${label}`,
        screenshotPaths: paths,
        errorText: `${label}: ${msg.slice(0, 2000)}`,
      });
    } catch (reportErr) {
      console.error(`[${bank}] reportCycle also threw:`, (reportErr as Error).message);
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", (e) => void fireAndExit("uncaughtException", e));
  process.on("unhandledRejection", (e) => void fireAndExit("unhandledRejection", e));
}
