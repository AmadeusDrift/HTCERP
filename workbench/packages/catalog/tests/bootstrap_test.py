import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


WORKBENCH = Path(__file__).resolve().parents[3]
BOOTSTRAP = WORKBENCH / "scripts" / "bootstrap.py"


class CatalogImport(unittest.TestCase):
    def test_real_cache_and_safe_replay(self):
        private_dir = WORKBENCH / ".local"
        private_dir.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=private_dir) as directory:
            target = Path(directory) / "cache.sqlite"
            def run():
                result = subprocess.run([sys.executable, str(BOOTSTRAP), "--sqlite", str(target)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)

            run()
            db = sqlite3.connect(target)
            self.assertEqual(dict(db.execute("select platform,count(*) from products group by platform")),
                             {"temu": 16272, "shein": 3185, "tiktok": 1595, "aliexpress": 1612})
            key = "temu:US:606597539559600"
            observed = db.execute("select count(distinct observed_at) from observations where product_id=?", (key,)).fetchone()[0]
            self.assertEqual(observed, 19)
            row = db.execute("select category_id, total_sold, total_sold_field,thumbnail,variants_json,fetched_at from products where id=?", (key,)).fetchone()
            self.assertEqual(row[:3], ("9711", 20100, "sold"))
            self.assertTrue(row[3].startswith("https://"))
            self.assertTrue(json.loads(row[4])[0]["sku_id"])
            self.assertIsNone(row[5])
            self.assertGreater(db.execute("select count(*) from products where total_sold is null").fetchone()[0], 0)
            self.assertGreater(db.execute("select count(*) from products where total_sold=0").fetchone()[0], 0)
            self.assertIsNone(db.execute("select total_sold from products where id='shein:US:438297795'").fetchone()[0])
            before = db.execute("select count(*) from product_snapshots").fetchone()[0]
            db.execute("update products set title='new observation',updated_at='2027-01-01T00:00:00.000Z' where id=?", (key,))
            db.commit()
            run()
            self.assertEqual(db.execute("select title from products where id=?", (key,)).fetchone()[0], "new observation")
            self.assertEqual(db.execute("select count(*) from product_snapshots").fetchone()[0], before)
            db.close()


if __name__ == "__main__":
    unittest.main()
