CREATE TABLE api_audit (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL, at TEXT NOT NULL
);
CREATE INDEX audit_at ON api_audit(at);
CREATE TABLE write_limits(actor TEXT PRIMARY KEY, window INTEGER NOT NULL, used INTEGER NOT NULL);
CREATE TABLE connection_tests (
  service TEXT PRIMARY KEY, status TEXT NOT NULL, tested_at TEXT NOT NULL
);
CREATE TABLE amazon_searches (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), query TEXT NOT NULL,
  fetched_at TEXT NOT NULL, returned INTEGER NOT NULL, has_more INTEGER NOT NULL, actor TEXT NOT NULL
);
CREATE INDEX amazon_search_product ON amazon_searches(product_id,fetched_at DESC);
CREATE TABLE amazon_catalog_evidence (
  search_id TEXT NOT NULL REFERENCES amazon_searches(id), asin TEXT NOT NULL, snapshot TEXT NOT NULL,
  PRIMARY KEY(search_id,asin)
);
CREATE TABLE amazon_matches (
  product_id TEXT NOT NULL REFERENCES products(id), asin TEXT NOT NULL, latest_search TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', reviewed_at TEXT, reviewer TEXT,
  PRIMARY KEY(product_id,asin)
);
CREATE TABLE amazon_reviews (
  id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, asin TEXT NOT NULL, search_id TEXT NOT NULL,
  status TEXT NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE amazon_prices (
  id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, asin TEXT NOT NULL, price REAL, currency TEXT,
  shipping REAL, status TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE INDEX amazon_price_key ON amazon_prices(product_id,asin,id DESC);

