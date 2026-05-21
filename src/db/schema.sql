-- Logging tables for the CRDB bulk-payment automation.
-- Separate from the existing disburser tables so we never interfere with them.

-- One row per batch run.
CREATE TABLE IF NOT EXISTS crdb_bulk_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id         text NOT NULL,
  bank_batch_number text,                 -- the BATCH NUMBER shown on the bank confirm page
  recipient_count   integer NOT NULL,
  total_tzs         numeric NOT NULL,
  status            text NOT NULL,         -- submitted | failed | dry_run
  result_message    text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- One row per disbursed person (for dashboards: who, how much, when, phone, name).
CREATE TABLE IF NOT EXISTS crdb_bulk_disbursements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid NOT NULL REFERENCES crdb_bulk_batches(id),
  queue_id         uuid,                   -- cash_disbursement_queue.id
  loan_id          text,
  borrower_id      text,
  phone            text NOT NULL,          -- local format sent to the bank (0XXXXXXXXX)
  beneficiary_name text,
  amount_tzs       numeric NOT NULL,
  status           text NOT NULL,          -- submitted | failed
  submitted_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crdb_bulk_disb_phone ON crdb_bulk_disbursements (phone);
CREATE INDEX IF NOT EXISTS idx_crdb_bulk_disb_time  ON crdb_bulk_disbursements (submitted_at);
CREATE INDEX IF NOT EXISTS idx_crdb_bulk_disb_batch ON crdb_bulk_disbursements (batch_id);
CREATE INDEX IF NOT EXISTS idx_crdb_bulk_batches_time ON crdb_bulk_batches (started_at);
