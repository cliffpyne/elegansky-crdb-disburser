import fs from "node:fs";
import { config } from "../config.js";

/**
 * Persistent OTP request throttle (Frank 2026-07-25). The in-memory
 * one-OTP-per-failure-streak cap dies with the process — the overnight
 * 07-24→25 crdb2 loop (cycle-1 portal-death → purge → exit → systemd restart
 * → fresh OTP) burned a code every ~10 min because each restart forgot the
 * last burn. This stamp file survives restarts: any OTP request within
 * OTP_MIN_INTERVAL_SEC (default 900s) of the previous one sleeps out the
 * remainder first. File lives in the service WorkingDirectory, one per
 * instance tag, so two CRDB instances never throttle each other.
 */
const OTP_MIN_INTERVAL_MS = Number(process.env.OTP_MIN_INTERVAL_SEC ?? 900) * 1000;

export async function throttleOtpRequest(tag: string): Promise<void> {
  const file = `.otp-throttle-${tag}`;
  try {
    const last = Number(fs.readFileSync(file, "utf8"));
    const since = Date.now() - last;
    if (Number.isFinite(last) && since >= 0 && since < OTP_MIN_INTERVAL_MS) {
      const waitMs = OTP_MIN_INTERVAL_MS - since;
      console.warn(
        `[otp-throttle:${tag}] last OTP request was ${Math.round(since / 1000)}s ago — ` +
        `sleeping ${Math.round(waitMs / 1000)}s before requesting another (cap survives restarts)`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  } catch {
    /* no stamp yet — first request is free */
  }
  try {
    fs.writeFileSync(file, String(Date.now()));
  } catch {
    /* best-effort — throttling must never block a login outright */
  }
}

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
  // TAN_CHANNEL namespaces per bank account (Frank 2026-07-24): this puller
  // only ever sees codes its own boss phone posted with the same ?channel=.
  const channelQs = config.TAN_CHANNEL ? `?channel=${config.TAN_CHANNEL}` : "";
  const url = `${config.WEBHOOK_BASE_URL}/internal/tan/latest${channelQs}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "X-Tan-Secret": config.TAN_WEBHOOK_SECRET } });
      if (res.ok) {
        const body = (await res.json()) as LatestResponse;
        if (body.latest && body.latest.storedAt >= triggerTime) {
          // 2026-07-25: storedAt alone isn't enough — a code from a PREVIOUS
          // SEND ME TAN can post to the relay seconds after our click and get
          // consumed, but the bank invalidates all prior codes on a new
          // request, so the login fails. Require the SMS itself (issuedAt =
          // phone receive time) to postdate our click, with 60s clock-skew
          // tolerance. Missing issuedAt (legacy app) keeps old behavior.
          const issuedAt = body.latest.issuedAt ?? 0;
          if (!issuedAt || issuedAt >= triggerTime - 60_000) {
            return body.latest.code;
          }
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
