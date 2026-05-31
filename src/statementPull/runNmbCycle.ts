import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";

/**
 * One full NMB statement-pull cycle. Every stage logs to stdout AND to
 * /tmp/nmb_bot.log so we can tail it in another terminal while the
 * browser runs.
 */
export async function runNmbCycle(): Promise<unknown> {
  // Today-only window (mirror CRDB). The bot runs every ~30 min and the
  // processor dedups, so re-ingesting the same day repeatedly is safe.
  // Going wider triggers NMB's "Big Data Statement" queue (15-20 min lag),
  // which would break the sync model.
  const { dateFromYmd, dateToYmd } = todayOnlyYmd();
  const savePath = `/tmp/nmb_statement_${dateToYmd}.csv`;

  const { browser, page, log } = await nmbLogin();
  try {
    await nmbDownloadStatement(page, log, { dateFromYmd, dateToYmd, savePath });
    // NOTE: NMB CSV row reversal was attempted (commit 9065904) but broke the
    // processor — it expected a header row that wasn't there and pandas read
    // the first data row as a header. Reverted here; sheet-ordering fix is
    // pending a real NMB CSV sample so we can write the right reverser.
    log.step("upload statement to transaction-processor");
    const result = await uploadStatement(savePath, "NMB");
    log.info("processor response", { result });
    log.info("✅ cycle complete");
    return result;
  } finally {
    if (browser.isConnected()) {
      log.info("closing browser");
      await browser.close().catch(() => {});
    }
  }
}

function todayOnlyYmd(): { dateFromYmd: string; dateToYmd: string } {
  const today = ymd(new Date());
  return { dateFromYmd: today, dateToYmd: today };
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
