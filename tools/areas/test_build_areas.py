"""v0.18.172 (plan §2.2; reviewer 2026-11-28): the build tool's failure paths. Run in CI:
python3 -m unittest discover -s tools/areas -p 'test_*.py' (needs shapely)."""
import hashlib, json, os, sys, tempfile, unittest
from shapely.geometry import box

sys.path.insert(0, os.path.dirname(__file__))
import build_areas as b  # noqa: E402

feat = lambda name: {"properties": {"regsonamn": name, "kommunkod": "0180"}}


class DistrictTags(unittest.TestCase):
    def test_every_real_name_is_tagged_once(self):
        b.check_districts([feat(n) for n in b.DISTRICT_OF])

    def test_unmatched_regso_name_fails(self):
        with self.assertRaisesRegex(b.BuildError, "tagged to no district: \\['Nyby'\\]"):
            b.check_districts([feat(n) for n in b.DISTRICT_OF] + [feat("Nyby")])

    def test_list_name_with_no_regso_fails(self):
        with self.assertRaisesRegex(b.BuildError, "names a RegSO that does not exist"):
            b.check_districts([feat(n) for n in b.DISTRICT_OF if n != "Kista"])

    def test_unknown_district_name_fails(self):
        tags = {**b.DISTRICT_OF, "Kista": "Rinkeby-Kista"}
        with self.assertRaisesRegex(b.BuildError, "district names do not match"):
            b.check_districts([feat(n) for n in tags], tags)

    def test_enskededalen_is_skarpnack(self):
        self.assertEqual(b.DISTRICT_OF["Enskededalen"], "Skarpnäck")


class Geometry(unittest.TestCase):
    kommun = box(0, 0, 2, 1)

    def test_exact_cover_passes(self):
        b.geometry_check(self.kommun, {"A": box(0, 0, 1, 1), "B": box(1, 0, 2, 1)})

    def test_gap_fails(self):
        with self.assertRaisesRegex(b.BuildError, "gap"):
            b.geometry_check(self.kommun, {"A": box(0, 0, 0.9, 1), "B": box(1, 0, 2, 1)})

    def test_overlap_fails(self):
        with self.assertRaisesRegex(b.BuildError, "overlap"):
            b.geometry_check(self.kommun, {"A": box(0, 0, 1.1, 1), "B": box(1, 0, 2, 1)})


class Manifest(unittest.TestCase):
    def _write(self, d, rows=1):
        body = json.dumps({"features": [{"properties": {"country": "SE"}}]})
        open(os.path.join(d, "se.geojson"), "w").write(body)
        json.dump({"files": {"se.geojson": hashlib.sha256(body.encode()).hexdigest()}, "rows": {"SE": rows}}, open(os.path.join(d, "manifest.json"), "w"))

    def test_good_manifest_passes(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d); b.verify_manifest(d)

    def test_wrong_checksum_fails(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d)
            open(os.path.join(d, "se.geojson"), "a").write(" ")
            with self.assertRaisesRegex(b.BuildError, "checksum"):
                b.verify_manifest(d)

    def test_wrong_row_count_fails(self):
        with tempfile.TemporaryDirectory() as d:
            self._write(d, rows=2)
            with self.assertRaisesRegex(b.BuildError, "row counts"):
                b.verify_manifest(d)


if __name__ == "__main__":
    unittest.main()
