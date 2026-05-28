import { nmbLogin } from "../portal/nmbLogin.js";
import { nmbDownloadStatement } from "../portal/nmbStatement.js";
import { uploadStatement } from "./uploadToProcessor.js";
import { reportStep } from "../worker/status.js";

/**
 * One full NMB statement-pull cycle:
 *   login → drill into account → set yesterday-and-today range (covers
 *   overnight settlement) → credits-only → download CSV →
 *   POST to transaction-processor → /process triggers the existing pipeline.
 *
 * Idempotent at the processor layer: transaction-processor already dedupes by
 * ref number + message body, so re-uploading the same statement is a no-op.
 */
export async function runNmbCycle(): Promise<void> {
  // We pull yesterday + today so any late-evening txns aren't missed.
  const { dateFromYmd, dateToYmd } = yesterdayAndTodayYmd();
  const savePath = `/tmp/nmb_statement_${dateToYmd}.csv`;

  await reportStep(`NMB cycle starting — range ${dateFromYmd} → ${dateToYmd}`);

  const { browser, page } = await nmbLogin();
  try {
    await nmbDownloadStatement(page, { dateFromYmd, dateToYmd, savePath });
  } finally {
    await browser.close();
  }

  await uploadStatement(savePath, "NMB");
  await reportStep(`NMB cycle complete — ${savePath} uploaded + processed`);
}

/** Returns YYYY-MM-DD strings for yesterday and today, in local time. */
function yesterdayAndTodayYmd(): { dateFromYmd: string; dateToYmd: string } {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return {
    dateFromYmd: ymd(yesterday),
    dateToYmd: ymd(today),
  };
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Standalone-script entry point: `npm run pull:nmb` will run one cycle.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runNmbCycle()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[runNmbCycle] FAILED:", err.message);
      process.exit(1);
    });
}
