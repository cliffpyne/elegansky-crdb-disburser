import type { PoolClient } from "pg";
import { config } from "../config.js";
import { normalizePhone } from "./phone.js";

/** Arbitrary key for the single-bank-session advisory lock. */
const BANK_LOCK_KEY = 778899;

export interface ClaimedRow {
  id: string;
  loanId: string | null;
  borrowerId: string | null;
  phone: string; // normalised local format
  amountTzs: number;
  name: string;
}

/**
 * Try to grab the global bank-session lock on THIS connection. Only one worker
 * can hold it, so only one bank session/OTP stream is ever active. Session
 * pooler (port 5432) keeps the connection sticky, so the lock persists across
 * statements until released. Returns false if another worker holds it.
 */
export async function tryAcquireBankLock(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got", [BANK_LOCK_KEY]);
  return rows[0]?.got === true;
}

export async function releaseBankLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1)", [BANK_LOCK_KEY]);
}

/**
 * Atomically claim up to `limit` pending people. FOR UPDATE SKIP LOCKED means
 * no other transaction can grab the same rows → impossible to double-claim.
 * Marks them 'processing' and stamps claimed_by. Joins names from registrations.
 */
export async function claimPending(client: PoolClient, limit: number): Promise<ClaimedRow[]> {
  const { rows } = await client.query(
    `UPDATE cash_disbursement_queue q
        SET status='processing', claimed_by=$1, claimed_at=now(), updated_at=now()
       FROM (
         SELECT id FROM cash_disbursement_queue
          WHERE status='pending'
          ORDER BY enqueued_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ) sel
      WHERE q.id = sel.id
      RETURNING q.id, q.loan_id, q.borrower_id, q.phone, q.principal_amount`,
    [config.WORKER_ID, limit],
  );
  if (rows.length === 0) return [];

  const borrowerIds = [...new Set(rows.map((r) => r.borrower_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (borrowerIds.length) {
    const { rows: nrows } = await client.query(
      `SELECT borrower_id, full_name FROM registrations WHERE borrower_id = ANY($1)`,
      [borrowerIds],
    );
    for (const n of nrows) if (n.full_name) names.set(n.borrower_id, n.full_name);
  }

  return rows.map((r) => ({
    id: r.id,
    loanId: r.loan_id,
    borrowerId: r.borrower_id,
    phone: normalizePhone(r.phone),
    amountTzs: Math.round(Number(r.principal_amount)),
    name: names.get(r.borrower_id) ?? "CUSTOMER",
  }));
}

/** Release claims back to 'pending' (used on dry-run or any failure → retried next cycle). */
export async function releaseClaims(client: PoolClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client.query(
    `UPDATE cash_disbursement_queue
        SET status='pending', claimed_by=NULL, claimed_at=NULL, updated_at=now()
      WHERE id = ANY($1) AND status='processing'`,
    [ids],
  );
}

/** Mark claimed rows as completed after a successful bank submit. */
export async function markCompleted(client: PoolClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client.query(
    `UPDATE cash_disbursement_queue SET status='completed', updated_at=now() WHERE id = ANY($1)`,
    [ids],
  );
}

/** Insert a batch row; returns its id. */
export async function logBatch(
  client: PoolClient,
  b: { bankBatchNumber: string | null; count: number; total: number; status: string; message: string },
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO crdb_bulk_batches
       (worker_id, bank_batch_number, recipient_count, total_tzs, status, result_message, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
    [config.WORKER_ID, b.bankBatchNumber, b.count, b.total, b.status, b.message],
  );
  return rows[0].id;
}

/** Insert one log row per disbursed person. */
export async function logDisbursements(
  client: PoolClient,
  batchId: string,
  rows: ClaimedRow[],
  status: string,
): Promise<void> {
  for (const r of rows) {
    await client.query(
      `INSERT INTO crdb_bulk_disbursements
         (batch_id, queue_id, loan_id, borrower_id, phone, beneficiary_name, amount_tzs, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [batchId, r.id, r.loanId, r.borrowerId, r.phone, r.name, r.amountTzs, status],
    );
  }
}
