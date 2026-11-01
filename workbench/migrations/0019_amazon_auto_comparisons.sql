-- One immutable successful comparison per research input. The lease also bounds concurrent SP-API reads.
CREATE TABLE amazon_auto_comparisons (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
  lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  UNIQUE(run_id,product_id)
);
CREATE INDEX amazon_auto_product ON amazon_auto_comparisons(product_id);
