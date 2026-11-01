-- A reviewer can act only on the version of the catalog evidence they viewed.
CREATE TRIGGER guard_amazon_review BEFORE INSERT ON amazon_reviews
WHEN NOT EXISTS (SELECT 1 FROM amazon_matches WHERE product_id=NEW.product_id AND asin=NEW.asin AND latest_search=NEW.search_id)
BEGIN
  SELECT RAISE(ABORT,'stale_amazon_review');
END;
CREATE TRIGGER check_amazon_specs BEFORE UPDATE OF latest_search ON amazon_matches
WHEN OLD.latest_search <> NEW.latest_search AND EXISTS (
  SELECT 1 FROM amazon_catalog_evidence a JOIN amazon_catalog_evidence b ON a.asin=b.asin
  WHERE a.search_id=OLD.latest_search AND b.search_id=NEW.latest_search AND a.asin=NEW.asin
    AND (json_extract(a.snapshot,'$.specs') IS NOT json_extract(b.snapshot,'$.specs')
      OR json_extract(a.snapshot,'$.title') IS NOT json_extract(b.snapshot,'$.title'))
)
BEGIN
  UPDATE amazon_matches SET status='pending',note='',reviewer=NULL,reviewed_at=NULL
    WHERE product_id=OLD.product_id AND asin=OLD.asin;
END;
CREATE TABLE amazon_pages (
  search_id TEXT PRIMARY KEY REFERENCES amazon_searches(id), next_token TEXT, parent_id TEXT UNIQUE
);
CREATE TABLE amazon_search_failures (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL, query TEXT NOT NULL, fetched_at TEXT NOT NULL,
  status TEXT NOT NULL, actor TEXT NOT NULL
);
CREATE INDEX amazon_fail_product ON amazon_search_failures(product_id,fetched_at);

