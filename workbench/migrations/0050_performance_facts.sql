CREATE TABLE performance_order_lines (
  seller TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  order_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sku TEXT,
  asin TEXT,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  status TEXT,
  cancelled INTEGER NOT NULL CHECK(cancelled IN (0, 1)),
  item_cents INTEGER,
  shipping_cents INTEGER,
  discount_cents INTEGER,
  tax_cents INTEGER,
  known_cents INTEGER,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  observed_at TEXT NOT NULL,
  PRIMARY KEY(seller, connection_revision, order_id, item_id)
);
CREATE INDEX performance_order_lines_date ON performance_order_lines(seller, connection_revision, purchased_at);
CREATE INDEX performance_order_lines_sku ON performance_order_lines(seller, connection_revision, sku, purchased_at);

CREATE TABLE performance_order_versions (
  seller TEXT NOT NULL,
  connection_revision TEXT NOT NULL,
  order_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sku TEXT,
  asin TEXT,
  title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0),
  status TEXT,
  cancelled INTEGER NOT NULL CHECK(cancelled IN (0, 1)),
  item_cents INTEGER,
  shipping_cents INTEGER,
  discount_cents INTEGER,
  tax_cents INTEGER,
  known_cents INTEGER,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  observed_at TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  PRIMARY KEY(seller, connection_revision, order_id, item_id, version_hash)
);
CREATE INDEX performance_order_versions_date ON performance_order_versions(seller, connection_revision, updated_at);
