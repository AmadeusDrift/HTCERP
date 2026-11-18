CREATE TABLE weekly_feedback_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
INSERT INTO weekly_feedback_settings VALUES(1,0);
CREATE TABLE weekly_feedback_runs (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, marketplace TEXT NOT NULL,
  week TEXT NOT NULL, started TEXT NOT NULL, finished TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','done','partial','failed')),
  error TEXT, reported INTEGER NOT NULL DEFAULT 0, incomplete INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX weekly_feedback_active ON weekly_feedback_runs(seller,marketplace) WHERE status='running';
CREATE TABLE weekly_feedback_listings (
  run TEXT NOT NULL REFERENCES weekly_feedback_runs(id) ON DELETE CASCADE,
  sku TEXT NOT NULL, asin TEXT, title TEXT NOT NULL, image TEXT,
  role TEXT NOT NULL, operator_id TEXT,
  PRIMARY KEY(run,sku)
);
CREATE INDEX weekly_feedback_asins ON weekly_feedback_listings(run,asin);
CREATE TABLE weekly_feedback_items (
  run TEXT NOT NULL REFERENCES weekly_feedback_runs(id) ON DELETE CASCADE,
  asin TEXT NOT NULL, data TEXT, image TEXT,
  status TEXT NOT NULL CHECK(status IN ('available','no_data','failed')),
  error TEXT, image_error TEXT,
  PRIMARY KEY(run,asin)
);
CREATE TABLE weekly_feedback_actions (
  seller TEXT NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL, topic TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','working','verified','closed')),
  note TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(seller,marketplace,asin,topic)
);
CREATE TABLE weekly_feedback_action_history (
  id TEXT PRIMARY KEY, seller TEXT NOT NULL, marketplace TEXT NOT NULL, asin TEXT NOT NULL,
  topic TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
);
