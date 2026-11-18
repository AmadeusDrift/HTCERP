// Build the read-only Worker catalogue from a vetted public-risk SQLite release.
import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
if (!process.argv[2]) throw new Error('Provide the v0.3 SQLite path')
const db = new DatabaseSync(process.argv[2], { readOnly: true })
const terms = db
  .prepare(
    'SELECT brand_key,MIN(serial) AS serial FROM current_pool GROUP BY brand_key ORDER BY brand_key',
  )
  .all()
  .map((r) => [r.brand_key, r.serial])
const ip = db
  .prepare(`SELECT a.spelling,s.standard_name,coalesce(p.standard_name,s.standard_name) AS family,r.proposed_action,
 (SELECT min(url) FROM ip_evidence ev WHERE ev.subject_id=s.id) AS url
 FROM ip_alias a JOIN ip_subject s ON s.id=a.subject_id JOIN ip_review_rule r ON s.id=r.subject_id
 LEFT JOIN ip_relation e ON e.child_id=s.id AND s.is_family=0 LEFT JOIN ip_subject p ON p.id=e.parent_id ORDER BY 1,2,3`)
  .all()
  .map((r) => [r.spelling, r.standard_name, r.family, r.proposed_action, r.url])
db.close()
writeFileSync(
  new URL('../packages/title-audit/dictionary.json', import.meta.url),
  JSON.stringify({ terms, ip }),
)
