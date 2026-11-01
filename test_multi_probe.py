import tempfile
import unittest
from pathlib import Path


class MultiProbeTests(unittest.TestCase):
    def test_switch_only_after_local_budget_and_persist(self):
        from multi_probe import KeyPool
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            keys = [{'label': 'key1', 'key': 'test-a', 'secret': 'x', 'budget': 10},
                    {'label': 'key2', 'key': 'test-b', 'secret': 'y', 'budget': 10}]
            pool = KeyPool(keys, Path(directory))
            _, budget, label = pool.choose(10)
            self.assertEqual(label, 'key1')
            budget.reserve(10)
            pool = KeyPool(keys, Path(directory))
            _, budget, label = pool.choose(10)
            self.assertEqual(label, 'key2')
            budget.reserve(10)
            with self.assertRaises(RuntimeError):
                KeyPool(keys, Path(directory)).choose(10)

    def test_same_key_cannot_multiply_allowance(self):
        from multi_probe import KeyPool
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            keys = [{'label': 'one', 'key': 'duplicate', 'secret': 'x', 'budget': 1000},
                    {'label': 'two', 'key': 'duplicate', 'secret': 'x', 'budget': 1000}]
            with self.assertRaises(ValueError):
                KeyPool(keys, Path(directory))

    def test_exact_us_market_no_fallback_to_another_country(self):
        from multi_probe import us_site
        self.assertEqual(us_site([{'cnName': '美国', 'siteId': 48}]), 48)
        self.assertIsNone(us_site([{'cnName': '俄罗斯', 'siteId': 1}]))

    def test_shein_uses_documented_id_field(self):
        from multi_probe import us_site
        self.assertEqual(us_site([{'cnName': '美国', 'id': 7}], id_field='id'), 7)

    def test_discovery_uses_real_categories_and_has_no_amazon_jobs(self):
        from multi_probe import discovery_plan
        jobs = discovery_plan({'temu': 48, 'shein': 7}, [{'catId': 123}])
        self.assertTrue(any(j['params'].get('catIds') == '123' for j in jobs))
        self.assertTrue(all(j['platform'] in ['temu', 'shein'] for j in jobs))
        self.assertTrue(all(j['params']['size'] <= 200 for j in jobs))

    def test_secondary_platforms_have_small_page_diagnostics(self):
        from multi_probe import discovery_plan
        jobs = discovery_plan({'tiktok': 1, 'aliexpress': 1}, [])
        for platform in ['tiktok', 'aliexpress']:
            self.assertTrue(any(j['platform']==platform and j['params']['size']==20
                                and j['params']['page']==2 for j in jobs))


if __name__ == '__main__':
    unittest.main()
