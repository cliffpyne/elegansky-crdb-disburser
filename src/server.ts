import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { scrapeTan } from "./tan/scrapeTan.js";
import { storeTan, peekLatest, recordEvent, getEvents } from "./tan/store.js";
import { saveReport, getStatus, getShot } from "./worker/statusStore.js";
import { livePageHtml } from "./worker/livePage.js";

const tanBodySchema = z.object({
  forwarded: z.string().min(1).max(2000),
  sender: z.string().max(64).default(""),
  received_at: z.coerce.number().int().positive().optional(),
  /** original SMS receive-time (ms) — the true issue-time used for ordering */
  issued_at: z.coerce.number().int().positive().optional(),
});

/** Constant-time secret comparison so we don't leak length/timing. */
function secretOk(provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.TAN_WEBHOOK_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The phone already filters, but double-check the sender server-side. */
function senderAllowed(sender: string): boolean {
  const cleaned = sender.toUpperCase().replace(/[-\s]/g, "");
  if (cleaned === "") return true; // sender optional; don't reject on absence
  return config.ALLOWED_SENDERS.some((a) => {
    const allowed = a.replace(/[-\s]/g, "");
    return cleaned.includes(allowed) || allowed.includes(cleaned);
  });
}

function requireSecret(req: FastifyRequest): boolean {
  // Accept the secret via header (API callers) OR ?token= (browser /live link).
  const header = req.headers["x-tan-secret"] as string | undefined;
  const token = (req.query as Record<string, string> | undefined)?.token;
  return secretOk(header) || secretOk(token);
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  // Receives the phone app's numbers+emojis string, scrapes the TAN, stores it.
  app.post("/internal/tan", async (req, reply) => {
    if (!requireSecret(req)) {
      return reply.code(401).send({ ok: false, error: "bad secret" });
    }

    const parsed = tanBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "bad body", details: parsed.error.flatten() });
    }
    const { forwarded, sender, received_at, issued_at } = parsed.data;

    if (!senderAllowed(sender)) {
      req.log.warn({ sender }, "rejected TAN: sender not allowed");
      await recordEvent({ ts: Date.now(), sender, codeMasked: null, result: "rejected_sender" });
      return reply.code(403).send({ ok: false, error: "sender not allowed" });
    }

    const code = scrapeTan(forwarded, config.TAN_LENGTH);
    if (!code) {
      req.log.warn({ forwarded }, "no TAN found in forwarded message");
      await recordEvent({ ts: Date.now(), sender, codeMasked: null, result: "no_code" });
      return reply.code(422).send({ ok: false, error: "no TAN found" });
    }

    // Issue-time = when the bank's SMS hit the phone. Falls back to now if the
    // sender didn't provide it (older app), preserving the old arrival-order behaviour.
    const issuedAt = issued_at ?? Date.now();

    // Reject codes that were issued too long ago — a late-arriving expired OTP
    // must never become "latest".
    const ageSeconds = (Date.now() - issuedAt) / 1000;
    if (ageSeconds > config.TAN_MAX_AGE_SECONDS) {
      req.log.warn({ code: mask(code), ageSeconds }, "rejected TAN: too old (expired)");
      await recordEvent({ ts: Date.now(), sender, codeMasked: mask(code), result: "stale" });
      return reply.code(200).send({ ok: true, code, stored: false, stale: true });
    }

    const stored = await storeTan({
      code,
      sender,
      issuedAt,
      receivedAt: received_at ?? Date.now(),
      storedAt: Date.now(),
    });

    req.log.info({ code: mask(code), stored }, stored ? "TAN stored" : "TAN duplicate, skipped");
    await recordEvent({
      ts: Date.now(),
      sender,
      codeMasked: mask(code),
      result: stored ? "stored" : "duplicate",
    });
    return reply.code(stored ? 201 : 200).send({ ok: true, code, stored, duplicate: !stored });
  });

  // Read-only peek for debugging — never consumes the code. Returns the FULL
  // code: this endpoint already requires the shared secret, so the caller is
  // the system owner and is authorised to see it.
  app.get("/internal/tan/latest", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).send({ ok: false, error: "bad secret" });
    const latest = await peekLatest();
    return reply.send({ ok: true, latest });
  });

  // Recent-events log — shows EVERY post that hit the webhook (direct + relay),
  // so a relay post tagged "CRDB RELAY" is visible even if a direct post stored
  // a different code afterwards. Used to confirm the relay leg works.
  app.get("/internal/tan/events", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).send({ ok: false, error: "bad secret" });
    const events = await getEvents();
    return reply.send({ ok: true, count: events.length, events });
  });

  // ── Worker live status ───────────────────────────────────────────────
  // Worker POSTs its current step (+ optional screenshot) here.
  app.post("/internal/worker/report", async (req, reply) => {
    if (!secretOk(req.headers["x-tan-secret"] as string | undefined)) {
      return reply.code(401).send({ ok: false, error: "bad secret" });
    }
    await saveReport(req.body as Parameters<typeof saveReport>[0]);
    return reply.code(204).send();
  });

  // JSON status (current step + recent step timeline).
  app.get("/internal/worker/status", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).send({ ok: false, error: "bad secret" });
    return reply.send({ ok: true, ...(await getStatus()) });
  });

  // Latest screenshot as a PNG.
  app.get("/internal/worker/shot", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).send({ ok: false, error: "bad secret" });
    const png = await getShot();
    if (!png) return reply.code(404).send({ ok: false, error: "no screenshot yet" });
    return reply.header("Content-Type", "image/png").header("Cache-Control", "no-store").send(png);
  });

  // Human live view: open https://<host>/live?token=<secret> in a browser.
  app.get("/live", async (req, reply) => {
    if (!requireSecret(req)) return reply.code(401).type("text/html").send("<h3>Unauthorized — add ?token=YOUR_SECRET</h3>");
    const token = (req.query as Record<string, string>)?.token ?? "";
    return reply.type("text/html").send(livePageHtml(token));
  });

  return app;
}

/** Mask a code in logs/responses: 852456 → 85**56 */
function mask(code: string): string {
  if (code.length <= 3) return "*".repeat(code.length);
  return code.slice(0, 2) + "*".repeat(code.length - 4) + code.slice(-2);
}
