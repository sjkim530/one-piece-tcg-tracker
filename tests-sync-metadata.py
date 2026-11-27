"""Protect metadata repair without mutating an already-recorded price day."""
import importlib.util
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sync_prices", Path(__file__).with_name("sync_prices.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
STAMP = datetime(2026, 11, 26, 20, 5, 59, tzinfo=timezone.utc)


class MetadataSyncTests(unittest.TestCase):
    def test_single_parsing_keeps_don_raw_fields_and_excludes_sealed(self):
        row = {"productId": 12, "name": "DON!! Card", "extendedData": [{"name": "CardType", "value": "DON!!"}]}
        product, card_type, card = sync.single_metadata(row)
        self.assertEqual((product, card_type), ("12", "DON!!"))
        self.assertEqual(card, {"card_name": "DON!! Card", "rarity": "", "card_type": "DON!!"})
        self.assertIsNone(sync.single_metadata({"productId": 13, "name": "Booster box"}))

    def test_saved_price_day_repairs_missing_metadata_without_reading_or_writing_quotes(self):
        with tempfile.TemporaryDirectory() as folder:
            history = Path(folder)
            status = history / "status.json"
            status.write_text(json.dumps({"sourceUpdatedAt": STAMP.isoformat(), "quotes": 1}))
            original = status.read_bytes()
            cards = {"1": {"card_name": "Test", "rarity": "R"}}
            with patch.object(sync, "HISTORY", history), patch.object(sync, "feed_timestamp", return_value=STAMP), \
                 patch.object(sync, "metadata_current", return_value=False), patch.object(sync, "collect_metadata", return_value=cards) as collect, \
                 patch.object(sync, "export_metadata") as export, patch.object(sync, "collect_quotes", side_effect=AssertionError("price collection must stay skipped")):
                sync.sync()
            collect.assert_called_once()
            export.assert_called_once_with(cards, STAMP)
            self.assertEqual(status.read_bytes(), original)
            self.assertEqual([path.name for path in history.iterdir()], ["status.json"])

    def test_fresh_metadata_and_offset_equivalent_prices_need_no_repair(self):
        with tempfile.TemporaryDirectory() as folder:
            history = Path(folder)
            (history / "status.json").write_text(json.dumps({"sourceUpdatedAt": "2026-11-26T15:05:59-05:00"}))
            with patch.object(sync, "HISTORY", history), patch.object(sync, "feed_timestamp", return_value=STAMP), \
                 patch.object(sync, "metadata_current", return_value=True), patch.object(sync, "collect_metadata") as collect, patch.object(sync, "export_metadata") as export:
                sync.sync()
            collect.assert_not_called()
            export.assert_not_called()

    def test_feed_change_during_repair_cannot_export_mismatched_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            history = Path(folder)
            (history / "status.json").write_text(json.dumps({"sourceUpdatedAt": STAMP.isoformat()}))
            with patch.object(sync, "HISTORY", history), patch.object(sync, "feed_timestamp", side_effect=[STAMP, STAMP + timedelta(days=1)]), \
                 patch.object(sync, "metadata_current", return_value=False), patch.object(sync, "collect_metadata", return_value={"1": {"rarity": "R"}}), patch.object(sync, "export_metadata") as export:
                with self.assertRaisesRegex(RuntimeError, "changed builds"):
                    sync.sync()
            export.assert_not_called()

    def test_older_feed_cannot_overwrite_metadata_for_newer_saved_prices(self):
        with tempfile.TemporaryDirectory() as folder:
            history = Path(folder)
            (history / "status.json").write_text(json.dumps({"sourceUpdatedAt": STAMP.isoformat()}))
            with patch.object(sync, "HISTORY", history), patch.object(sync, "feed_timestamp", return_value=STAMP - timedelta(days=1)), \
                 patch.object(sync, "metadata_current", return_value=False), patch.object(sync, "collect_metadata") as collect, patch.object(sync, "export_metadata") as export:
                with self.assertRaisesRegex(RuntimeError, "older than saved prices"):
                    sync.sync()
            collect.assert_not_called()
            export.assert_not_called()


if __name__ == "__main__":
    unittest.main()
