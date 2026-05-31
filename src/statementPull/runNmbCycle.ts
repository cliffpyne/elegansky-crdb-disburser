import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";
import { reverseCsvDataRowsInPlace } from "./reverseCsvRows.js";

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
    // NMB emits rows newest-first; the sheet is append-only ascending and the
    // processor appends in CSV order. Flip data rows here so the sheet stays
    // chronological.
    log.step("reverse NMB CSV rows (NMB exports newest-first, sheet is ascending)");
    const { rowsReversed } = reverseCsvDataRowsInPlace(savePath);
    log.detail(`reversed ${rowsReversed} data rows`);
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

// Standalone-script entry point: `npm run pull:nmb` or `pull:nmb:dev`
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runNmbCycle()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[runNmbCycle] FAILED:", err.message);
      process.exit(1);
    });
}
