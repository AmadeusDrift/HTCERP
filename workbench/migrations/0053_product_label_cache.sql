-- Only validated Amazon originals and fixed-template compositions are published here.
-- Object names include the lease owner, so an expired worker cannot overwrite a winner.
CREATE TABLE product_label_cache (
  cache_key TEXT PRIMARY KEY,
  r2_key TEXT,
  content_sha256 TEXT,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK ((r2_key IS NULL) = (content_sha256 IS NULL))
);
CREATE INDEX product_label_cache_lease_owner ON product_label_cache(lease_owner)
  WHERE lease_owner IS NOT NULL;
