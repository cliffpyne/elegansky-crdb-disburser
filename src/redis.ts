import { Redis } from "ioredis";
import { config } from "./config.js";

/**
 * Single shared Redis connection for normal commands.
 *
 * NOTE: blocking commands (BRPOP) monopolise a connection, so the worker that
 * waits for a TAN must use its own dedicated connection (see store.popTan).
 * We expose a factory for that.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on("error", (err: Error) => {
  console.error("Redis error:", err.message);
});

/** Create a separate connection — used for blocking reads so they don't stall the shared client. */
export function createRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
