import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";

/**
 * One full NMB statement-pull cycle. Every stage logs to stdout AND to
 * /tmp/nmb_bot.log so we can tail it in another terminal while the
 * browser runs.
 */
export async function runNmbCycle(): Promise<void> {
  const { dateFromYmd, dateToYmd } = yesterdayAndTodayYmd();
  const savePath = `/tmp/nmb_statement_${dateToYmd}.csv`;

  const { browser, page, log } = await nmbLogin();
  try {
    await nmbDownloadStatement(page, log, { dateFromYmd, dateToYmd, savePath });
    log.step("upload statement to transaction-processor");
    const result = await uploadStatement(savePath, "NMB");
    log.info("processor response", { result });
    log.info("✅ cycle complete");
  } finally {
    if (browser.isConnected()) {
      log.info("closing browser");
      await browser.close().catch(() => {});
    }
  }
}

function yesterdayAndTodayYmd(): { dateFromYmd: string; dateToYmd: string } {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return { dateFromYmd: ymd(yesterday), dateToYmd: ymd(today) };
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
