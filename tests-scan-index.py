"""Focused visual-index format/cache regressions; run with the build's OpenCV env."""

import importlib.util
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np


spec = importlib.util.spec_from_file_location("scan_index", Path(__file__).with_name("build-scan-index.py"))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


def artwork():
    # Reproducible textured reference; this is not a fixture of any real card.
    image = np.random.default_rng(17).integers(0, 256, (560, 400), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


class ScanIndexTests(unittest.TestCase):
    def test_spatial_selection_keeps_artwork_even_when_rules_text_is_stronger(self):
        points = []
        for row in range(6):
            for column in range(4):
                for n in range(10):
                    points.append(SimpleNamespace(pt=((column + .3 + n * .02) * 100, (row + .4) * 100),
                                                  response=(100 if row >= 4 else 1) + n / 100,
                                                  octave=0))
        selected = index.spatial_features(points, 400, 600)
        self.assertEqual(len(selected), 96)
        self.assertEqual(len(set(selected)), 96)
        self.assertEqual(sum(points[i].pt[1] < 400 for i in selected), 64)
        self.assertEqual(selected, index.spatial_features(points, 400, 600))

    def test_spatial_selection_fills_sparse_cells_without_repeating_points(self):
        points = [SimpleNamespace(pt=(20 + n, 30), response=n, octave=0) for n in range(12)]
        selected = index.spatial_features(points, 400, 600)
        self.assertEqual(sorted(selected), list(range(12)))

    def test_identical_references_preserve_every_printing_as_aliases(self):
        blob = bytes(range(36)) * 8
        found = {str(i): (blob, 300, 420, 8) for i in range(22)}
        entries, binary, count = index.pack_references(found)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["id"], "0")
        self.assertEqual(entries[0]["aliases"], [str(i) for i in range(1, 22)])
        self.assertEqual(count, 8)
        self.assertEqual(binary, blob)
        # Matching one artwork must still expose all 22 compatible printings.
        self.assertEqual({entries[0]["id"], *entries[0]["aliases"]}, set(found))
        entries, _, _ = index.pack_references({"1": (blob, 300, 420, 8), "2": (blob, 299, 420, 8)})
        self.assertEqual(len(entries), 2)

    def test_singles_include_unnumbered_don_and_exclude_sealed_products(self):
        body = b"productId,name,extNumber,extCardType,imageUrl,modifiedOn\n1,Box,,,,\n2,DON!!,,DON!!,https://example.invalid/a.jpg,\n3,Card,OP18-119,Character,,\n"
        self.assertEqual([card["id"] for card in index.parse_cards(body)], ["2", "3"])

    def test_interleaved_binary_has_normalized_little_endian_coordinates(self):
        binary, width, height, count = index.features(artwork())
        self.assertEqual((width, height), (300, 420))
        self.assertGreaterEqual(count, 8)
        self.assertLessEqual(count, 96)
        self.assertEqual(len(binary), count * 36)
        positions = [struct.unpack_from("<HH", binary, offset + 32)
                     for offset in range(0, len(binary), 36)]
        self.assertTrue(all(0 < x < 65535 and 0 < y < 65535 for x, y in positions))

    def test_cache_reuses_matching_reference_and_invalidates_modified_art(self):
        card = {"id": "123", "image": "https://tcgplayer-cdn.tcgplayer.com/product/123_200w.jpg",
                "modified": "a"}
        with tempfile.TemporaryDirectory() as folder, patch.object(index, "fetch", return_value=artwork()) as fetch:
            first = index.reference(card, Path(folder))
            second = index.reference(card, Path(folder))
            self.assertFalse(first[-1])
            self.assertTrue(second[-1])
            self.assertEqual(fetch.call_count, 1)
            index.reference({**card, "modified": "b"}, Path(folder))
            self.assertEqual(fetch.call_count, 2)
            with patch.dict(index.ORB, {"nfeatures": 1100}):
                index.reference({**card, "modified": "b"}, Path(folder))
            self.assertEqual(fetch.call_count, 3)

    def test_build_deduplicates_finishes_and_records_missing_artwork(self):
        rows = [{"id": str(i), "name": "card", "number": "OP01-001", "image": "", "modified": ""}
                for i in range(10)]
        rows += [rows[0].copy()]
        blob, width, height, count = index.features(artwork())
        def reference(card, cache):
            if card["id"] == "9":
                raise ValueError("No artwork")
            return blob, width, height, count, False
        with tempfile.TemporaryDirectory() as folder:
            args = type("Args", (), {"cache": Path(folder) / "cache", "output": Path(folder) / "index",
                                     "workers": 2, "limit": None})()
            with patch.object(index, "catalog", return_value=(rows, {"mode": "local", "groups": 1})), patch.object(index, "reference", side_effect=reference):
                manifest = index.build(args)
            self.assertEqual(manifest["coverage"]["catalogCards"], 10)
            self.assertEqual(manifest["coverage"]["indexedCards"], 9)
            self.assertEqual(manifest["coverage"]["referenceImages"], 1)
            self.assertFalse(manifest["coverage"]["complete"])
            self.assertEqual(manifest["coverage"]["failures"][0]["id"], "9")
            self.assertEqual([card["offset"] for card in manifest["cards"]], [0])
            self.assertEqual(manifest["cards"][0]["aliases"], [str(i) for i in range(1, 9)])
            self.assertEqual((args.output / manifest["binary"]).stat().st_size, count * 36)
            self.assertEqual(json.loads((args.output / "manifest.json").read_text())["sha256"], manifest["sha256"])

    def test_empty_or_failed_build_preserves_existing_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / "manifest.json").write_text('{"existing":true}')
            args = type("Args", (), {"cache": output / "cache", "output": output,
                                     "workers": 1, "limit": None})()
            with patch.object(index, "catalog", return_value=([], {"groups": 1})):
                with self.assertRaises(ValueError):
                    index.build(args)
            self.assertEqual((output / "manifest.json").read_text(), '{"existing":true}')


if __name__ == "__main__":
    unittest.main()
