/**
 * After a successful statement-pull cycle, ask BRAIN to run the algorithm
 * + post Payments to QB for every channel that just got new rows.
 *
 * BRAIN's /api/payment-batches/auto-upload/:channel endpoint returns 202
 * immediately and does the QB calls in setImmediate, so we don't block
 * the worker waiting for QB.
 *
 * Each channel call is sequential — concurrent calls for DIFFERENT
 * channels would be safe (BRAIN's locks are per-channel) but doing them
 * one at a time keeps the worker log readable.
 */

type Channel = "nmbnew" | "bank" | "iphone_bank";

const CHANNELS: Channel[] = ["nmbnew", "bank", "iphone_bank"];

function brainBase(): string {
  return (process.env.BRAIN_REPORT_URL ?? "").replace(/\/api\/cycles\/?$/, "/api");
}

export async function triggerAutoUpload(channel: Channel): Promise<void> {
  const base = brainBase();
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!base || !secret) {
    console.warn(`[auto-upload] skipped ${channel} — BRAIN_REPORT_URL or STATEMENT_REPORT_SECRET missing`);
    return;
  }
  try {
    const r = await fetch(`${base}/payment-batches/auto-upload/${channel}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Report-Secret": secret },
      body: "{}",
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      console.error(`[auto-upload] ${channel} HTTP ${r.status}:`, JSON.stringify(body));
      return;
    }
    if (body.skipped) {
      console.log(`[auto-upload] ${channel} skipped: ${body.reason}`);
    } else {
      console.log(
        `[auto-upload] ${channel} batch=${body.batch_id} paid_planned=${body.paid_planned} unused_planned=${body.unused_planned}`,
      );
    }
  } catch (err) {
    // Don't let an auto-upload failure crash the worker — the operator can
    // re-trigger via the dashboard or the next cycle picks up missed rows.
    console.error(`[auto-upload] ${channel} threw:`, err);
  }
}

/**
 * Fire-and-forget auto-upload for every channel. Sequenced (one at a time)
 * so the log reads cleanly. Each call is non-blocking on BRAIN's side
 * because the endpoint returns 202 immediately.
 */
export async function triggerAutoUploadAll(): Promise<void> {
  for (const ch of CHANNELS) {
    await triggerAutoUpload(ch);
  }
}
