ALTER TABLE weekly_feedback_settings ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 0 CHECK(notify_enabled IN (0,1));
CREATE TABLE weekly_feedback_owners (
  seller TEXT NOT NULL, marketplace TEXT NOT NULL, sku TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id), source TEXT NOT NULL DEFAULT 'manual',
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(seller,marketplace,sku)
);
CREATE TABLE weekly_feedback_members (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id), userid TEXT NOT NULL UNIQUE,
  updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE weekly_feedback_deliveries (
  run TEXT NOT NULL REFERENCES weekly_feedback_runs(id), account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK(status IN ('preparing','sending','sent','failed','unknown')),
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(run,account_id)
);
