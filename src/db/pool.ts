import pg from "pg";
import { config } from "../config.js";

if (!config.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (put it in .env)");
}

/** Shared Postgres pool (Supabase). Small pool — the worker is low-concurrency. */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

pool.on("error", (err) => console.error("[db] pool error:", err.message));
