/**
 * SMS notifier — Africa's Talking implementation.
 *
 * Picked AT because we're in Tanzania, it's cheap (~$0.02/SMS), it has free
 * credits to start, and a stable HTTP API. The interface (sendSms) is
 * provider-agnostic so we can swap later (Twilio, Plivo, the boss phone's
 * own SMS APK, etc.) without touching callers.
 *
 * Env vars:
 *   AT_USERNAME       — Africa's Talking username (use "sandbox" for testing)
 *   AT_API_KEY        — AT API key from the dashboard
 *   AT_SENDER_ID      — (optional) registered sender ID; AT default if unset
 *   ADMIN_PHONE       — destination phone in E.164 (+255...)
 *
 * Failure is logged but never thrown — a failed SMS must not break the
 * worker. The retry-exhaustion path has already written the dashboard
 * report; SMS is a courtesy ping.
 */

export interface SmsResult {
  ok: boolean;
  provider: string;
  status?: string;
  cost?: string;
  messageId?: string;
  error?: string;
}

/** Send an SMS to the admin. Returns the result; never throws. */
export async function notifyAdminBySms(message: string): Promise<SmsResult> {
  const username = process.env.AT_USERNAME;
  const apiKey = process.env.AT_API_KEY;
  const to = process.env.ADMIN_PHONE;
  const senderId = process.env.AT_SENDER_ID;

  if (!username || !apiKey || !to) {
    const missing = [
      !username && "AT_USERNAME",
      !apiKey && "AT_API_KEY",
      !to && "ADMIN_PHONE",
    ]
      .filter(Boolean)
      .join(",");
    console.warn(`[sms] skipping — missing env: ${missing}`);
    return { ok: false, provider: "africas-talking", error: `missing env: ${missing}` };
  }

  // AT sandbox uses the api.sandbox host; production uses api.africastalking.com.
  const host =
    username === "sandbox"
      ? "https://api.sandbox.africastalking.com"
      : "https://api.africastalking.com";

  // Cap message at 320 chars (2x SMS) — keeps cost predictable.
  const truncated = message.slice(0, 320);

  const body = new URLSearchParams({
    username,
    to,
    message: truncated,
    ...(senderId ? { from: senderId } : {}),
  });

  try {
    const res = await fetch(`${host}/version1/messaging`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
      },
      body,
    });
    const json = (await res.json().catch(() => null)) as {
      SMSMessageData?: { Message?: string; Recipients?: Array<{ status: string; cost: string; messageId: string }> };
    } | null;

    if (!res.ok || !json) {
      const msg = `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`;
      console.warn(`[sms] failed — ${msg}`);
      return { ok: false, provider: "africas-talking", error: msg };
    }

    const recipient = json.SMSMessageData?.Recipients?.[0];
    if (!recipient || !recipient.status.toLowerCase().includes("success")) {
      const msg = json.SMSMessageData?.Message ?? "no recipient feedback";
      console.warn(`[sms] AT rejected — ${msg}`);
      return { ok: false, provider: "africas-talking", error: msg };
    }

    console.log(
      `[sms] ✅ sent — id=${recipient.messageId} cost=${recipient.cost} status=${recipient.status}`,
    );
    return {
      ok: true,
      provider: "africas-talking",
      status: recipient.status,
      cost: recipient.cost,
      messageId: recipient.messageId,
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.warn(`[sms] network error — ${msg}`);
    return { ok: false, provider: "africas-talking", error: msg };
  }
}
