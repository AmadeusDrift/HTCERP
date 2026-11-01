-- Stable ordered research inputs from the original discovery evidence, including
-- earlier runs. Crawl times, archive paths and tracking URLs do not identify a new product state.
CREATE VIEW discovery_input_facts AS
SELECT q.run_id,q.product_id,q.child_id,q.tier,q.total_sold,r.strategy_version,
  json_array(
    json_extract(s.snapshot_json,'$.title'),json_extract(s.snapshot_json,'$.title_cn'),
    json_extract(s.snapshot_json,'$.category_id'),json_extract(s.snapshot_json,'$.brand'),
    json_extract(s.snapshot_json,'$.min_price'),json_extract(s.snapshot_json,'$.max_price'),
    json_extract(s.snapshot_json,'$.currency'),json_extract(s.snapshot_json,'$.total_sold'),
    json_extract(s.snapshot_json,'$.total_sold_field'),json_extract(s.snapshot_json,'$.day_sold'),
    json_extract(s.snapshot_json,'$.week_sold'),json_extract(s.snapshot_json,'$.month_sold'),
    json_extract(s.snapshot_json,'$.rating'),json_extract(s.snapshot_json,'$.review_count'),
    json_extract(s.snapshot_json,'$.shop_id'),json_extract(s.snapshot_json,'$.variants_json')
  ) AS facts
FROM job_seen q JOIN job_runs r ON r.id=q.run_id
JOIN product_snapshots s ON s.product_id=q.product_id AND s.evidence_ref=q.evidence_ref
WHERE q.tier IS NOT NULL;
CREATE INDEX seen_linked_product ON job_seen(product_id,child_id) WHERE child_id IS NOT NULL;
