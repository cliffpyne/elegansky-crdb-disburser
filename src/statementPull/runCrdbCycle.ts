import { crdbLogin } from "../portal/crdbLogin.js";
import { crdbDownloadStatement, startCrdbSessionKeepalive, ymdToDdMmYyyy } from "../portal/crdbStatement.js";
import { xlsToXlsx } from "./xlsToXlsx.js";
import { uploadStatement } from "./uploadToProcessor.js";

/**
 * One full CRDB statement-pull cycle. Mirrors runNmbCycle: login → download
 * → upload-to-processor. Differences vs NMB:
 *
 *  - CRDB exports legacy .xls; we convert to .xlsx (the processor sniffs by
 *    OOXML magic bytes, not the file extension).
 *  - The portal pops a session-expiry warning after a couple of minutes idle;
 *    a 5s keepalive timer clicks YES whenever it appears.
 */
export async function runCrdbCycle(): Promise<unknown> {
  // Today-only window. The bot runs every ~30 min, so a 1-day slice is enough
  // to stay in sync without making CRDB's search hang on a wide query (this
  // account has thousands of rows per day, and User-Defined > 1 day never
  // returns). Processor-side dedup means re-ingesting the same day is safe.
  const { dateFromYmd, dateToYmd } = todayOnlyYmd();
  const xlsPath = `/tmp/crdb_statement_${dateToYmd}.xls`;
  const xlsxPath = `/tmp/crdb_statement_${dateToYmd}.xlsx`;

  const { browser, page, log } = await crdbLogin();
  const stopKeepalive = startCrdbSessionKeepalive(log, page);
  try {
    await crdbDownloadStatement(page, log, {
      dateFromDdMmYyyy: ymdToDdMmYyyy(dateFromYmd),
      dateToDdMmYyyy: ymdToDdMmYyyy(dateToYmd),
      savePath: xlsPath,
    });

    log.step("convert .xls → .xlsx for processor");
    xlsToXlsx(xlsPath, xlsxPath);
    log.detail("wrote xlsx", { xlsxPath });

    log.step("upload statement to transaction-processor");
    const result = await uploadStatement(xlsxPath, "CRDB");
    log.info("processor response", { result });
    log.info("✅ cycle complete");
    return result;
  } finally {
    stopKeepalive();
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCrdbCycle()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[runCrdbCycle] FAILED:", err.message);
      process.exit(1);
    });
}
