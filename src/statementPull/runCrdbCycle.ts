import { crdbLogin } from "../portal/crdbLogin.js";
import {
  crdbDownloadStatement,
  startCrdbSessionKeepalive,
  ymdToDdMmYyyy,
} from "../portal/crdbStatement.js";
import { xlsToXlsx } from "./xlsToXlsx.js";
import { uploadStatement } from "./uploadToProcessor.js";

/**
 * Gap-fill CRDB statement-pull cycle (Frank 2026-06-14).
 *
 * Flow (mirrors runNmbCycle):
 *   1. Ask BRAIN for the last date stamped in the CRDB PASSED tab.
 *   2. Compute the gap list = [last_passed_date .. today] inclusive, ascending.
 *      The lower bound IS re-pulled so we catch yesterday-evening tail
 *      transactions that posted after the previous cron ran. The processor's
 *      dedup absorbs the overlap.
 *   3. For each gap day: fresh login + full-day download (no amount split) +
 *      .xls→.xlsx convert + upload to processor.
 *
 * If BRAIN is unreachable or returns nothing parseable, we fall back to a
 * single same-day pull for today so the cycle never silently fails.
 */
export async function runCrdbCycle(): Promise<unknown> {
  const today = ymd(new Date());
  const gapDays = await computeGapDays(today);
  console.log(`[runCrdbCycle] gap to pull (${gapDays.length}): ${gapDays.join(", ")}`);

  const results: Array<{ day: string; result: unknown }> = [];
  for (let i = 0; i < gapDays.length; i++) {
    const day = gapDays[i]!;
    console.log(`[runCrdbCycle] ──── DAY ${day} (${i + 1}/${gapDays.length}) — fresh login ────`);
    const xlsPath = `/tmp/crdb_statement_${day}.xls`;
    const xlsxPath = `/tmp/crdb_statement_${day}.xlsx`;

    const { browser, page, log } = await crdbLogin();
    const stopKeepalive = startCrdbSessionKeepalive(log, page);
    try {
      const ddmmyyyy = ymdToDdMmYyyy(day);
      await crdbDownloadStatement(page, log, {
        dateFromDdMmYyyy: ddmmyyyy,
        dateToDdMmYyyy: ddmmyyyy,
        savePath: xlsPath,
      });
      log.step("convert .xls → .xlsx for processor");
      xlsToXlsx(xlsPath, xlsxPath);
      log.detail("wrote xlsx", { xlsxPath });
      log.step(`upload ${day} statement to transaction-processor`);
      const result = await uploadStatement(xlsxPath, "CRDB");
      log.info(`processor response for ${day}`, { result });
      results.push({ day, result });
    } finally {
      stopKeepalive();
      if (browser.isConnected()) {
        log.info("closing browser");
        await browser.close().catch(() => {});
      }
    }
  }
  console.log(`[runCrdbCycle] ✅ cycle complete (${gapDays.length} day(s) pulled)`);
  return { days: gapDays, results, stats: aggregateStats(results) };
}

function aggregateStats(perDay: Array<{ day: string; result: unknown }>): Record<string, number> {
  const KEYS = ["passed", "passed_sav", "needs_review", "failed", "failed_nmb", "skipped", "total"];
  const agg: Record<string, number> = {};
  for (const k of KEYS) agg[k] = 0;
  for (const entry of perDay) {
    const r = entry.result as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    const s = (r.stats && typeof r.stats === "object" ? r.stats : r) as Record<string, unknown>;
    for (const k of KEYS) {
      const v = s[k];
      if (typeof v === "number") agg[k] = (agg[k] ?? 0) + v;
    }
  }
  return agg;
}

async function computeGapDays(todayYmd: string): Promise<string[]> {
  const last = await fetchLastPassedDate();
  if (!last) {
    console.warn(`[runCrdbCycle] last_passed_date unavailable — falling back to today-only`);
    return [todayYmd];
  }
  if (last > todayYmd) {
    console.warn(`[runCrdbCycle] last_passed_date ${last} is AFTER today ${todayYmd}? falling back to today-only`);
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
    console.warn(`[runCrdbCycle] BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET missing — cannot fetch last-passed-date`);
    return null;
  }
  try {
    const r = await fetch(`${base}/admin/crdb-last-passed-date`, {
      headers: { "X-Report-Secret": secret },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      console.error(`[runCrdbCycle] last-passed-date HTTP ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return null;
    }
    const ymd = typeof body.last_passed_date === "string" ? body.last_passed_date : null;
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      console.error(`[runCrdbCycle] last-passed-date returned malformed value: ${JSON.stringify(body)}`);
      return null;
    }
    console.log(`[runCrdbCycle] BRAIN says last_passed_date=${ymd} (sample=${JSON.stringify(body.sample).slice(0, 200)})`);
    return ymd;
  } catch (err) {
    console.error(`[runCrdbCycle] fetchLastPassedDate threw:`, (err as Error).message);
    return null;
  }
}

function enumerateYmd(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  const from = new Date(fromYmd + "T00:00:00Z");
  const to = new Date(toYmd + "T00:00:00Z");
  for (let i = 0; i <= 31; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    out.push(ymd(d));
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

// Manual fires (`npm run pull:crdb`, dashboard button, etc.) route through
// runBankWithRetry so the dashboard's reportCycle wrapper always fires
// even when this script throws.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  import("./runAllCycles.js")
    .then(async ({ runBankWithRetry }) => {
      const { CRDB_SCREENSHOT_PATHS, reportCycle } = await import("./cycleReport.js");
      const fireAndExit = async (label: string, err: unknown) => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
        console.error(`[CRDB] ${label}:`, msg.slice(0, 500));
        try {
          const now = new Date();
          await reportCycle({
            bank: "CRDB",
            status: "fail",
            startedAt: now,
            finishedAt: now,
            workerId: (process.env.WORKER_ID ?? "statement-pull") + `#${label}`,
            screenshotPaths: CRDB_SCREENSHOT_PATHS,
            errorText: `${label}: ${msg.slice(0, 2000)}`,
          });
        } catch (e2) {
          console.error(`[CRDB] reportCycle threw too:`, (e2 as Error).message);
        } finally {
          process.exit(1);
        }
      };
      process.on("uncaughtException", (e) => void fireAndExit("uncaughtException", e));
      process.on("unhandledRejection", (e) => void fireAndExit("unhandledRejection", e));
      const ok = await runBankWithRetry("CRDB", runCrdbCycle, CRDB_SCREENSHOT_PATHS);
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error("[runCrdbCycle main] uncaught:", err);
      process.exit(1);
    });
}
