import { config } from "../config.js";

interface LatestResponse {
  ok: boolean;
  latest: { code: string; sender: string; issuedAt: number; receivedAt: number; storedAt: number } | null;
}

/**
 * Polls the webhook for a TAN that arrived AFTER `triggerTime` (the moment we
 * clicked "SEND ME TAN"). This guarantees we never use a stale code — even
 * without flushing — because we only accept one stored after we asked for it.
 *
 * The TAN reaches the server via the relay pipeline (boss phone → relay phone →
 * webhook), so the worker just reads it here. Returns the 6-digit code.
 */
export async function waitForFreshTan(triggerTime: number, timeoutMs = 90_000): Promise<string> {
  const url = `${config.WEBHOOK_BASE_URL}/internal/tan/latest`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "X-Tan-Secret": config.TAN_WEBHOOK_SECRET } });
      if (res.ok) {
        const body = (await res.json()) as LatestResponse;
        if (body.latest && body.latest.storedAt >= triggerTime) {
          return body.latest.code;
        }
      }
    } catch {
      // network blip — keep polling until the deadline
    }
    await sleep(2000);
  }
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for the login TAN. ` +
      `Check the relay/boss phone is online and forwarding.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
