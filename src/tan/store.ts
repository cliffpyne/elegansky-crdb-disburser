import type { Redis } from "ioredis";
import { redis, createRedisConnection } from "../redis.js";
import { config } from "../config.js";

/**
 * Redis-backed TAN inbox.
 *
 * Keys (per channel — Frank 2026-07-24 second-account POC):
 *   tan:inbox[:<ch>]        LIST  — codes waiting to be consumed by the disburse worker
 *   tan:latest[:<ch>]       STRING(TTL) — most recent code, for read-only debugging/peek
 *   tan:seen[:<ch>]:<code>  STRING(TTL) — dedupe marker so a multipart SMS isn't queued twice
 *   tan:events[:<ch>]       LIST — recent webhook posts for debugging
 *
 * The empty channel "" maps to the ORIGINAL un-suffixed keys, so account-1
 * phones and pullers keep working untouched. A second account's phone posts
 * with ?channel=<name> and its puller polls the same channel — the two
 * accounts' codes can never cross.
 *
 * Flow:
 *   webhook  → storeTan()                (LPUSH inbox + set latest)
 *   worker   → flushInbox() then popTan() (DEL inbox, then BRPOP fresh code)
 */

const INBOX_KEY = "tan:inbox";
const LATEST_KEY = "tan:latest";
const EVENTS_KEY = "tan:events";

/** Append the channel suffix to a base key; "" = legacy unsuffixed key. */
function chKey(base: string, channel: string): string {
  return channel ? `${base}:${channel}` : base;
}

export interface TanEntry {
  code: string;
  sender: string;
  /** epoch ms the bank's SMS was received by the phone — the TRUE issue-time used for ordering */
  issuedAt: number;
  /** epoch ms the phone reported receiving the SMS */
  receivedAt: number;
  /** epoch ms the server stored it */
  storedAt: number;
}

/** A record of every POST that hit the webhook — for debugging the relay. */
export interface TanEvent {
  ts: number;
  sender: string;
  codeMasked: string | null;
  result: "stored" | "duplicate" | "rejected_sender" | "no_code" | "stale";
}

/** Append an event to the recent-events log (keeps the last 50 for ~1 day). */
export async function recordEvent(e: TanEvent, channel = ""): Promise<void> {
  const pipe = redis.multi();
  pipe.lpush(chKey(EVENTS_KEY, channel), JSON.stringify(e));
  pipe.ltrim(chKey(EVENTS_KEY, channel), 0, 49);
  pipe.expire(chKey(EVENTS_KEY, channel), 86400);
  await pipe.exec();
}

/** Read the recent-events log, newest first. */
export async function getEvents(limit = 50, channel = ""): Promise<TanEvent[]> {
  const raw = await redis.lrange(chKey(EVENTS_KEY, channel), 0, limit - 1);
  return raw.map((r) => JSON.parse(r) as TanEvent);
}

/**
 * Store a scraped TAN. Returns false if it was a duplicate (already seen within
 * the dedupe window) and therefore skipped — multipart SMS can fire twice.
 */
export async function storeTan(entry: TanEntry, channel = ""): Promise<boolean> {
  // Dedupe: SET NX returns null if the key already exists.
  const fresh = await redis.set(
    `${chKey("tan:seen", channel)}:${entry.code}`,
    "1",
    "EX",
    config.TAN_DEDUPE_SECONDS,
    "NX",
  );
  if (fresh === null) return false;

  const payload = JSON.stringify(entry);

  // Push to the inbox list and refresh the inbox TTL so stale codes self-expire.
  const pipeline = redis.multi();
  pipeline.lpush(chKey(INBOX_KEY, channel), payload);
  pipeline.expire(chKey(INBOX_KEY, channel), config.TAN_TTL_SECONDS);
  await pipeline.exec();

  // Update "latest" ONLY if this code was issued at least as recently as the
  // current latest. This is what defeats out-of-order bursts: a code that
  // arrives late but was issued earlier can never overwrite a fresher one.
  // Guard against a malformed/legacy entry with no numeric issuedAt (treat as 0).
  const cur = await peekLatest(channel);
  const curIssued = typeof cur?.issuedAt === "number" ? cur.issuedAt : 0;
  if (!cur || entry.issuedAt >= curIssued) {
    await redis.set(chKey(LATEST_KEY, channel), payload, "EX", config.TAN_TTL_SECONDS);
  }

  return true;
}

/** Read the most recent TAN without consuming it. For debugging/health only. */
export async function peekLatest(channel = ""): Promise<TanEntry | null> {
  const raw = await redis.get(chKey(LATEST_KEY, channel));
  return raw ? (JSON.parse(raw) as TanEntry) : null;
}

/**
 * Discard everything currently in the inbox. The worker calls this immediately
 * BEFORE triggering the bank to send a fresh TAN, so it can never consume a
 * stale code from an earlier session.
 */
export async function flushInbox(channel = ""): Promise<void> {
  await redis.del(chKey(INBOX_KEY, channel));
}

/**
 * Block until a fresh TAN arrives or `timeoutSeconds` elapses. Uses its own
 * dedicated connection so the blocking read doesn't stall other Redis traffic.
 * Returns null on timeout.
 */
export async function popTan(timeoutSeconds: number, channel = ""): Promise<TanEntry | null> {
  const conn: Redis = createRedisConnection();
  try {
    const result = await conn.brpop(chKey(INBOX_KEY, channel), timeoutSeconds);
    if (!result) return null; // timed out
    const [, raw] = result;
    return JSON.parse(raw) as TanEntry;
  } finally {
    conn.disconnect();
  }
}
