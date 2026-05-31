/**
 * Loop kill switch — backed by BRAIN's app_settings table.
 *
 *   isLoopEnabled()           — read on each tick start; false → skip tick
 *   autoDisableLoop(reason)   — DEPRECATED. Kept in case an admin button
 *                               wants to call it later. The worker itself
 *                               no longer self-disables after retry
 *                               exhaustion (policy change 2026-05-31:
 *                               failures are bank-side, not ours — keep
 *                               ticking + notify admin instead of stopping).
 *   notifyAdminFailure(reason)— best-effort POST to BRAIN's admin-sms queue
 *                               (consumed by the always-online relay phone
 *                               APK). 404 / network errors are swallowed —
 *                               this must never break the loop.
 *
 * All three use the shared X-Report-Secret to authenticate against BRAIN.
 * Failures are conservative: if BRAIN is unreachable we ASSUME the loop is
 * enabled (better to run when we shouldn't than block legitimate ticks).
 */

function brainUrl(): string | null {
  // Same env var the cycle reporter uses, but rewritten to the settings endpoints.
  const reportUrl = process.env.BRAIN_REPORT_URL;
  if (!reportUrl) return null;
  // BRAIN_REPORT_URL = "https://elegansky-brain.onrender.com/api/cycles"
  return reportUrl.replace(/\/api\/cycles\/?$/, "/api");
}

export async function isLoopEnabled(): Promise<boolean> {
  const base = brainUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(
      `[loopControl] no BRAIN config (base=${!!base} secret=${!!secret}) — assuming enabled`,
    );
    return true;
  }
  try {
    const res = await fetch(`${base}/settings/statement_pull_enabled`, {
      headers: { "X-Report-Secret": secret },
    });
    if (!res.ok) {
      console.warn(`[loopControl] GET → ${res.status} — assuming enabled`);
      return true;
    }
    const body = (await res.json()) as { setting?: { value?: string } };
    const enabled = body.setting?.value !== "false";
    return enabled;
  } catch (err) {
    console.warn(`[loopControl] network error: ${(err as Error).message} — assuming enabled`);
    return true;
  }
}

export async function autoDisableLoop(reason: string): Promise<void> {
  const base = brainUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[loopControl] cannot auto-disable — no BRAIN config`);
    return;
  }
  try {
    const res = await fetch(`${base}/settings/auto-disable-loop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Report-Secret": secret,
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[loopControl] auto-disable → ${res.status}: ${t.slice(0, 200)}`);
      return;
    }
    console.log(`[loopControl] 🛑 loop auto-disabled — reason: ${reason}`);
  } catch (err) {
    console.warn(`[loopControl] auto-disable network error: ${(err as Error).message}`);
  }
}

/**
 * Queue an admin SMS via BRAIN. The SMS gateway endpoint is consumed by the
 * always-online relay phone APK (task #23); until that ships the POST will
 * 404, which we treat as a no-op. We log a loud line either way so anyone
 * tailing the worker log sees what would have been sent.
 */
export async function notifyAdminFailure(reason: string): Promise<void> {
  console.error(`[ADMIN_ALERT] ${reason}`);
  const base = brainUrl();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) return;
  try {
    const res = await fetch(`${base}/admin-sms/queue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Report-Secret": secret,
      },
      body: JSON.stringify({
        kind: "statement_pull_failure",
        message: reason.slice(0, 500),
      }),
    });
    if (!res.ok && res.status !== 404) {
      const t = await res.text().catch(() => "");
      console.warn(`[loopControl] admin-sms → ${res.status}: ${t.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[loopControl] admin-sms network error: ${(err as Error).message}`);
  }
}
