CREATE TABLE amazon_request_pacing (
  operation TEXT PRIMARY KEY,
  next_at INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL,
  slow_until INTEGER NOT NULL DEFAULT 0
);
