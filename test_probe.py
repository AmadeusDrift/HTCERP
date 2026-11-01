import tempfile
import unittest
from pathlib import Path


class ProbeTests(unittest.TestCase):
    def test_budget_survives_restart_and_blocks_overrun(self):
        from geekbi_probe import Budget
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            path = Path(directory) / 'ledger.json'
            budget = Budget(path, 500)
            for _ in range(50):
                budget.reserve(10)
            with self.assertRaises(RuntimeError):
                Budget(path, 500).reserve(10)
            self.assertEqual(Budget(path, 500).used, 500)

    def test_plan_fits_budget_and_has_both_pagination_modes(self):
        from geekbi_probe import build_plan
        plan = build_plan(48, [12, 34, 56])
        self.assertLessEqual(len(plan) * 10, 500)
        self.assertTrue(any(p['params'].get('page') == 100 for p in plan))
        self.assertTrue(any(p['params'].get('mode') == 'cursor' for p in plan))
        self.assertTrue(any('catIds' in p['params'] for p in plan))

    def test_analysis_deduplicates_and_keeps_unknown_ids_separate(self):
        from geekbi_probe import analyze
        result, seen = analyze({'list': [{'goodsId': 'a'}, {'goodsId': 'a'}, {}]}, set())
        self.assertEqual(result['rows'], 3)
        self.assertEqual(result['new_ids'], 1)
        self.assertEqual(result['missing_ids'], 1)
        result, _ = analyze({'list': [{'goodsId': 'a'}, {'goodsId': 'b'}]}, seen)
        self.assertEqual(result['new_ids'], 1)


if __name__ == '__main__':
    unittest.main()
