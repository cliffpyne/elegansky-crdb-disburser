import type { Redis } from "ioredis";
import { redis, createRedisConnection } from "../redis.js";
import { config } from "../config.js";

/**
 * Redis-backed TAN inbox.
 *
 * Keys:
 *   tan:inbox        LIST  — codes waiting to be consumed by the disburse worker
 *   tan:latest       STRING(TTL) — most recent code, for read-only debugging/peek
 *   tan:seen:<code>  STRING(TTL) — dedupe marker so a multipart SMS isn't queued twice
 *
 * Flow:
 *   webhook  → storeTan()                (LPUSH inbox + set latest)
 *   worker   → flushInbox() then popTan() (DEL inbox, then BRPOP fresh code)
 */

const INBOX_KEY = "tan:inbox";
const LATEST_KEY = "tan:latest";

export interface TanEntry {
  code: string;
  sender: string;
  /** epoch ms the phone reported receiving the SMS */
  receivedAt: number;
  /** epoch ms the server stored it */
  storedAt: number;
}

/**
 * Store a scraped TAN. Returns false if it was a duplicate (already seen within
 * the dedupe window) and therefore skipped — multipart SMS can fire twice.
 */
export async function storeTan(entry: TanEntry): Promise<boolean> {
  // Dedupe: SET NX returns null if the key already exists.
  const fresh = await redis.set(
    `tan:seen:${entry.code}`,
    "1",
    "EX",
    config.TAN_DEDUPE_SECONDS,
    "NX",
  );
  if (fresh === null) return false;

  const payload = JSON.stringify(entry);

  // Push to the inbox list and refresh the inbox TTL so stale codes self-expire.
  const pipeline = redis.multi();
  pipeline.lpush(INBOX_KEY, payload);
  pipeline.expire(INBOX_KEY, config.TAN_TTL_SECONDS);
  pipeline.set(LATEST_KEY, payload, "EX", config.TAN_TTL_SECONDS);
  await pipeline.exec();

  return true;
}

/** Read the most recent TAN without consuming it. For debugging/health only. */
export async function peekLatest(): Promise<TanEntry | null> {
  const raw = await redis.get(LATEST_KEY);
  return raw ? (JSON.parse(raw) as TanEntry) : null;
}

/**
 * Discard everything currently in the inbox. The worker calls this immediately
 * BEFORE triggering the bank to send a fresh TAN, so it can never consume a
 * stale code from an earlier session.
 */
export async function flushInbox(): Promise<void> {
  await redis.del(INBOX_KEY);
}

/**
 * Block until a fresh TAN arrives or `timeoutSeconds` elapses. Uses its own
 * dedicated connection so the blocking read doesn't stall other Redis traffic.
 * Returns null on timeout.
 */
export async function popTan(timeoutSeconds: number): Promise<TanEntry | null> {
  const conn: Redis = createRedisConnection();
  try {
    const result = await conn.brpop(INBOX_KEY, timeoutSeconds);
    if (!result) return null; // timed out
    const [, raw] = result;
    return JSON.parse(raw) as TanEntry;
  } finally {
    conn.disconnect();
  }
}
