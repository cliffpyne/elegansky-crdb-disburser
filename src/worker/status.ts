import type { Page } from "playwright";
import { config } from "../config.js";

/**
 * Live-status reporter. The worker POSTs its current step (and screenshots) to
 * the webhook over HTTP, so it works whether the worker runs on Render, a VPS,
 * or locally — and the /live page reads it back. Failures are swallowed: status
 * reporting must never break a disbursement.
 */
const REPORT_URL = `${config.WEBHOOK_BASE_URL}/internal/worker/report`;

async function post(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tan-Secret": config.TAN_WEBHOOK_SECRET },
      body: JSON.stringify(body),
    });
  } catch {
    /* never let status reporting break the cycle */
  }
}

/** Report a step (text), optionally with extra fields. Also prints to logs. */
export async function reportStep(step: string, extra: Record<string, unknown> = {}): Promise<void> {
  console.log(`[step] ${step}`);
  await post({ step, worker: config.WORKER_ID, ts: Date.now(), ...extra });
}

/** Report a step AND a screenshot of the current page (base64 PNG). */
export async function reportShot(page: Page, step: string): Promise<void> {
  console.log(`[step] ${step} (+shot)`);
  let screenshotB64: string | undefined;
  try {
    screenshotB64 = (await page.screenshot()).toString("base64");
  } catch {
    /* page may be navigating; skip the shot */
  }
  await post({ step, worker: config.WORKER_ID, ts: Date.now(), screenshotB64 });
}
