CREATE TABLE partner_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  writes INTEGER NOT NULL DEFAULT 0 CHECK(writes IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO partner_settings(singleton) VALUES (1);
CREATE TABLE partner_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seller TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK(marketplace='ATVPDKIKX0DER'),
  token_hash TEXT NOT NULL UNIQUE,
  amazon_revision TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE partner_seller_keys (seller TEXT PRIMARY KEY, order_key TEXT NOT NULL);
CREATE TABLE partner_permissions (
  client_id TEXT NOT NULL REFERENCES partner_clients(id),
  permission TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY(client_id,permission)
);
CREATE TABLE partner_quota (
  client_id TEXT NOT NULL REFERENCES partner_clients(id),
  bucket TEXT NOT NULL,
  window INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY(client_id,bucket)
);
CREATE TABLE partner_audit (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES partner_clients(id),
  actor TEXT,
  operation TEXT NOT NULL,
  scope TEXT,
  status INTEGER NOT NULL,
  row_count INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX partner_audit_recent ON partner_audit(created_at DESC,id DESC);
CREATE INDEX partner_audit_client ON partner_audit(client_id,created_at DESC,id DESC);
CREATE TABLE partner_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES partner_clients(id),
  operation TEXT NOT NULL CHECK(operation IN('inventory.request','inventory.quantity.write','price.write')),
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  write_revision INTEGER NOT NULL,
  permission_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','APPROVED','SENDING','ACCEPTED','REJECTED','UNKNOWN','CANCELLED','CONFIRMED')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewer TEXT,
  reference TEXT,
  outcome TEXT,
  UNIQUE(client_id,idempotency_key)
);
CREATE INDEX partner_requests_recent ON partner_requests(created_at DESC,id DESC);
CREATE UNIQUE INDEX partner_requests_active_sku ON partner_requests(operation,json_extract(input_json,'$.sku'))
  WHERE status IN('SENDING','ACCEPTED','UNKNOWN') OR (status='APPROVED' AND operation='inventory.quantity.write');
CREATE TABLE partner_cursors (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES partner_clients(id),
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  scope TEXT NOT NULL,
  upstream TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX partner_cursors_expiring ON partner_cursors(expires_at);
CREATE TABLE partner_sales_cache (
  seller TEXT NOT NULL, scope TEXT NOT NULL, connection_revision TEXT NOT NULL,
  result TEXT NOT NULL, checked_at INTEGER NOT NULL,
  PRIMARY KEY(seller,scope)
);
CREATE TABLE partner_orders_budget (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  tokens REAL NOT NULL, rate REAL NOT NULL, updated_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);
