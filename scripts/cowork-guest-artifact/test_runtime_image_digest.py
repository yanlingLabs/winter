"""The runtimeImageDigest rule, and the separation of the stand-in test image from every production pin. Reads files only."""
import hashlib, json, re, tempfile, unittest
from pathlib import Path

import runtime_image_digest as rid

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
VECTORS = REPO / "apple/Cowork/WinterCoworkHVFWorker/Tests/fixtures/runtime-image.json"
STANDIN = json.loads((HERE / "standin-pins.json").read_text())
PINS = json.loads((HERE / "pins.json").read_text())

# Every file a production pin, fixture or launch decision can live in. An explicit list on purpose: a file that moves must fail here, not vanish from the scan.
PRODUCTION_FILES = [
    "scripts/cowork-guest-artifact/pins.json",
    "scripts/cowork-guest-artifact/kernel/pins.json",
    "scripts/cowork-guest-artifact/kernel/ci-build.json",
    "apple/Cowork/WinterCoworkGuest/vectors/PINS.json",
    "apple/Cowork/WinterCoworkHVFWorker/Tests/fixtures/runtime-image.json",
    "packages/core/test/cowork/native/vectors/runtime-image.json",
    "packages/core/src/cowork/images.ts",
    "packages/core/src/cowork/native-wiring.ts",
    "apple/Cowork/WinterCoworkHVFWorker/Sources/WorkerNative/RuntimeImage.h",
    "apple/Cowork/WinterCoworkHVFWorker/Sources/WorkerNative/WorkspaceWorker.c",
]
PRODUCTION_TREES = ["packages/core/src/cowork", "apple/Cowork/WinterCoworkHVFWorker/Sources"]


def standin_values(pins):
    """The digests that exist only for the test image: its initramfs digest and its runtimeImageDigest (the kernel is the production one)."""
    return [v for v in (pins.get("initramfsSha256"), pins.get("runtimeImageDigest")) if v]


def production_paths():
    paths = [REPO / name for name in PRODUCTION_FILES]
    for tree in PRODUCTION_TREES:
        paths += sorted(p for p in (REPO / tree).rglob("*") if p.is_file() and p.suffix in (".ts", ".c", ".h", ".json", ".swift", ".py"))
    return paths


def files_containing(values, paths):
    hits = []
    for path in paths:
        text = path.read_text(errors="replace").lower()
        hits += [(path.name, value) for value in values if value.lower() in text]
    return hits


class DigestRuleTests(unittest.TestCase):
    def test_the_golden_vectors_the_worker_is_held_to_hold_for_this_implementation(self):
        vectors = json.loads(VECTORS.read_text())
        self.assertGreaterEqual(len(vectors["positive"]), 2)
        for vector in vectors["positive"]:
            self.assertEqual(rid.runtime_image_digest(vector["kernelSha256"], vector["initramfsSha256"]), vector["runtimeImageDigest"], vector["name"])

    def test_the_inner_digests_are_raw_bytes_not_hex_text(self):
        k, i = "11" * 32, "22" * 32
        self.assertEqual(rid.runtime_image_digest(k, i), hashlib.sha256(bytes.fromhex(k) + bytes.fromhex(i)).hexdigest())
        self.assertNotEqual(rid.runtime_image_digest(k, i), hashlib.sha256((k + i).encode()).hexdigest())

    def test_two_images_that_share_a_kernel_and_differ_in_the_cpio_have_different_digests_in_both_directions(self):
        kernel, production, standin = "aa" * 32, "bb" * 32, "cc" * 32
        a, b = rid.runtime_image_digest(kernel, production), rid.runtime_image_digest(kernel, standin)
        self.assertNotEqual(a, b)
        self.assertNotEqual(rid.runtime_image_digest(kernel, production), rid.runtime_image_digest(production, kernel))

    def test_a_digest_that_is_not_64_lowercase_hex_is_refused(self):
        for bad in ("", "a" * 63, "A" * 64, "g" * 64, " " + "a" * 63):
            with self.assertRaises(ValueError):
                rid.runtime_image_digest(bad, "a" * 64)
            with self.assertRaises(ValueError):
                rid.runtime_image_digest("a" * 64, bad)

    def test_the_file_form_hashes_the_files(self):
        with tempfile.TemporaryDirectory() as folder:
            kernel, cpio = Path(folder) / "kernel", Path(folder) / "initramfs.cpio"
            kernel.write_bytes(b"kernel bytes")
            cpio.write_bytes(b"cpio bytes")
            self.assertEqual(rid.runtime_image_digest_of_files(kernel, cpio), rid.runtime_image_digest(hashlib.sha256(b"kernel bytes").hexdigest(), hashlib.sha256(b"cpio bytes").hexdigest()))


class StandinSeparationTests(unittest.TestCase):
    def test_the_standin_file_is_test_only_and_shares_the_production_kernel(self):
        self.assertIs(STANDIN["testOnly"], True)
        self.assertIs(STANDIN["kernelSharedWithProduction"], True)
        self.assertNotIn("kernelSha256", STANDIN)

    def test_its_digests_are_null_or_a_consistent_pair_that_differs_from_production_once_filled(self):
        cpio, runtime = STANDIN["initramfsSha256"], STANDIN["runtimeImageDigest"]
        if cpio is None and runtime is None:
            self.assertEqual(STANDIN["status"], "stopped-not-built")
            return
        self.assertRegex(cpio, r"^[0-9a-f]{64}$")
        self.assertRegex(runtime, r"^[0-9a-f]{64}$")
        self.assertNotEqual(cpio, PINS["expectedArtifact"]["cpioSha256"])
        kernel = STANDIN.get("kernelSha256") or json.loads((HERE / "kernel/pins.json").read_text())["expectedOutputs"]["Image"]
        self.assertIsNotNone(kernel, "a filled stand-in needs the production kernel digest to be known")
        self.assertEqual(runtime, rid.runtime_image_digest(kernel, cpio))
        production = rid.runtime_image_digest(kernel, PINS["expectedArtifact"]["cpioSha256"])
        self.assertNotEqual(runtime, production)

    def test_the_production_file_list_exists_and_the_scan_covers_real_files(self):
        for name in PRODUCTION_FILES:
            self.assertTrue((REPO / name).is_file(), name)
        self.assertGreater(len(production_paths()), len(PRODUCTION_FILES))

    def test_no_stand_in_digest_is_in_any_production_pin_fixture_or_source(self):
        # While the stand-in digests are null this scans for nothing and says so; it goes live on its own the day they are filled.
        values = standin_values(STANDIN)
        self.assertEqual(files_containing(values, production_paths()), [])

    def test_the_scanner_finds_a_planted_digest_so_an_empty_result_means_something(self):
        planted = "d" * 63 + "e"
        with tempfile.TemporaryDirectory() as folder:
            clean, dirty = Path(folder) / "clean.json", Path(folder) / "dirty.json"
            clean.write_text(json.dumps({"a": "f" * 64}))
            dirty.write_text(json.dumps({"runtimeImageDigest": planted.upper()}))
            self.assertEqual(files_containing([planted], [clean]), [])
            self.assertEqual(files_containing([planted], [clean, dirty]), [("dirty.json", planted)])
        self.assertEqual(standin_values({"initramfsSha256": planted, "runtimeImageDigest": None}), [planted])
        self.assertEqual(standin_values({"initramfsSha256": None, "runtimeImageDigest": None}), [])

    def test_the_production_pin_file_has_no_standin_profile_or_test_only_marker(self):
        text = (HERE / "pins.json").read_text().lower()
        for word in ("standin", "stand-in", "testonly"):
            self.assertNotIn(word, text)
        self.assertNotIn("standin", (HERE / "kernel/pins.json").read_text().lower())


if __name__ == "__main__":
    unittest.main()
