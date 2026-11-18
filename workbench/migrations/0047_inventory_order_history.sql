-- Positive historical order evidence; absence is never a statement of no orders.
CREATE TABLE inventory_order_history_runs (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, connection_revision TEXT,
  window_from INTEGER NOT NULL, window_through INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETE','FAILED')),
  created_at INTEGER NOT NULL, finished_at INTEGER, pages INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE UNIQUE INDEX inventory_order_history_running ON inventory_order_history_runs(seller) WHERE state='RUNNING';
CREATE TABLE inventory_order_history_staged (
  run_id TEXT NOT NULL REFERENCES inventory_order_history_runs(id), sku TEXT NOT NULL,
  PRIMARY KEY(run_id,sku)
);
CREATE TABLE inventory_order_history_qualifications (
  seller TEXT NOT NULL, sku TEXT NOT NULL,
  evidence_run TEXT NOT NULL REFERENCES inventory_order_history_runs(id), observed_at INTEGER NOT NULL,
  PRIMARY KEY(seller,sku)
);
