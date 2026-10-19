"""build_standin_image.py: the stand-in cpio is the production cpio plus exactly the overlay, and nothing else. Synthetic trees only (the real cpio is read when STANDIN_PRODUCTION_CPIO names one)."""
import contextlib, copy, io, json, os, struct, tempfile, unittest
from pathlib import Path

import build_standin_image as bsi
import image
import runtime_image_digest as rid

HERE = Path(__file__).resolve().parent
GUEST = HERE.parents[1] / "apple/Cowork/WinterCoworkGuest"


def elf(extra=b"", machine=183):
    header = bytearray(64)
    header[:4] = b"\x7fELF"
    header[4], header[5] = 2, 1
    struct.pack_into("<H", header, 18, machine)
    return bytes(header) + extra


def production_tree():
    tree = image.Tree()
    tree.add("init", "file", elf(b"production init"), True, "guest")
    tree.add("opt/winter/libexec/linux-supervisor.py", "file", b"print(1)\n", False, "sdk")
    tree.add("opt/winter/runtime/winter-host-query", "file", elf(b"runtime"), True, "sdk")
    tree.add("bin", "symlink", b"usr/bin", False, "debian")
    tree.add("usr/bin/tool", "file", b"#!/bin/sh\n", True, "debian")
    tree.add("etc/os-release", "file", b"ID=debian\n", False, "debian")
    for path in ("proc", "dev", "run", "tmp"):
        tree.add(path, "directory")
    return tree


def cpio_bytes(tree):
    with tempfile.TemporaryDirectory() as folder:
        tree.cpio(Path(folder) / "x.cpio")
        return (Path(folder) / "x.cpio").read_bytes()


def clone(tree):
    other = image.Tree()
    other.nodes = {name: dict(node) for name, node in tree.nodes.items()}
    return other


PREPARE = (GUEST / "standin/standin_prepare.py").read_bytes()
PROFILE = (GUEST / "standin/profile.json").read_bytes()
INIT_STANDIN = elf(b"init-standin")
PROVIDER = elf(b"provider")


def standin_tree():
    tree = production_tree()
    bsi.overlay(tree, INIT_STANDIN, PROVIDER, PREPARE, PROFILE)
    return tree


class ReadCpioTests(unittest.TestCase):
    def test_a_tree_survives_a_write_a_read_and_a_rewrite_byte_for_byte(self):
        data = cpio_bytes(production_tree())
        self.assertEqual(cpio_bytes(bsi.read_cpio(data)), data)

    def corrupt(self, mutate):
        data = bytearray(cpio_bytes(production_tree()))
        mutate(data)
        with self.assertRaises(ValueError):
            bsi.read_cpio(bytes(data))

    def test_anything_the_writer_would_not_have_written_is_refused(self):
        self.corrupt(lambda d: d.__setitem__(slice(0, 6), b"070702"))                             # not newc
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 2, 6 + 8 * 3), b"00000001"))            # uid 1 on the first entry
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 4, 6 + 8 * 5), b"00000002"))            # nlink 2
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 5, 6 + 8 * 6), b"00000001"))            # mtime
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 1, 6 + 8 * 2), b"000081a4"))            # regular 0644
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 1, 6 + 8 * 2), b"000041ed"))            # directory 0755
        self.corrupt(lambda d: d.__setitem__(slice(6 + 8 * 1, 6 + 8 * 2), b"00006000"))            # block device
        self.corrupt(lambda d: d.__delitem__(slice(len(d) - 600, len(d))))                         # truncated

    def test_a_duplicate_name_is_refused(self):
        data = cpio_bytes(production_tree())
        first_end = data.index(b"070701", 6)
        entry = data[:first_end]
        with self.assertRaises(ValueError):
            bsi.read_cpio(entry + data)

    def test_a_symlink_must_be_0777_and_only_a_symlink(self):
        tree = image.Tree()
        tree.add("a", "file", b"x", False)
        data = bytearray(cpio_bytes(tree))
        data[6 + 8:6 + 16] = b"0000a1a4"                                                           # symlink with 0644
        with self.assertRaises(ValueError):
            bsi.read_cpio(bytes(data))


class OverlayTests(unittest.TestCase):
    def test_the_overlay_adds_exactly_the_four_files_and_changes_only_init(self):
        production, standin = snapshot_pair()
        self.assertEqual(bsi.overlay_problems(production, standin), [])
        added = sorted(set(standin) - set(production))
        self.assertEqual(added, ["opt/winter/standin", "opt/winter/standin/profile.json", "opt/winter/standin/standin_prepare.py", "opt/winter/standin/winter-provider"])
        self.assertEqual([n for n in production if production[n] != standin.get(n)], ["init"])
        self.assertEqual(standin["init"][2], INIT_STANDIN)
        self.assertEqual(standin["opt/winter/standin/winter-provider"][:2], ("file", 0o555))
        self.assertEqual(standin["opt/winter/standin/profile.json"][:2], ("file", 0o444))
        self.assertEqual(standin["opt/winter/standin/standin_prepare.py"][2], PREPARE)

    def test_the_overlay_refuses_inputs_that_are_not_what_it_says(self):
        for init, provider in ((b"not an elf" * 20, PROVIDER), (INIT_STANDIN, b"x" * 100), (elf(machine=62), PROVIDER), (INIT_STANDIN, elf(machine=3))):
            with self.assertRaises(ValueError):
                bsi.overlay(production_tree(), init, provider, PREPARE, PROFILE)

    def test_the_overlay_refuses_a_tree_that_is_not_the_production_shape(self):
        no_init = production_tree()
        del no_init.nodes["init"]
        with self.assertRaises(ValueError):
            bsi.overlay(no_init, INIT_STANDIN, PROVIDER, PREPARE, PROFILE)
        not_exec = production_tree()
        not_exec.nodes["init"]["mode"] = 0o444
        with self.assertRaises(ValueError):
            bsi.overlay(not_exec, INIT_STANDIN, PROVIDER, PREPARE, PROFILE)
        already = production_tree()
        already.add("opt/winter/standin/old", "file", b"x")
        with self.assertRaises(ValueError):
            bsi.overlay(already, INIT_STANDIN, PROVIDER, PREPARE, PROFILE)
        with self.assertRaises(ValueError):
            bsi.overlay(production_tree(), production_tree().nodes["init"]["data"], PROVIDER, PREPARE, PROFILE)

    def test_every_departure_from_the_exact_overlay_is_a_problem(self):
        production, standin = snapshot_pair()
        def mutated(edit):
            other = copy.deepcopy(standin)
            edit(other)
            return bsi.overlay_problems(production, other)
        self.assertTrue(mutated(lambda s: s.pop("etc/os-release")))                                                  # a production file removed
        self.assertTrue(mutated(lambda s: s.__setitem__("etc/os-release", ("file", 0o444, b"ID=other\n"))))            # a production file changed
        self.assertTrue(mutated(lambda s: s.__setitem__("usr/bin/extra", ("file", 0o555, b"x"))))                      # a file added
        self.assertTrue(mutated(lambda s: s.__setitem__("opt/winter/standin/extra", ("file", 0o444, b"x"))))           # a stand-in file added
        self.assertTrue(mutated(lambda s: s.pop("opt/winter/standin/profile.json")))                                   # an overlay file missing
        self.assertTrue(mutated(lambda s: s.__setitem__("opt/winter/standin/winter-provider", ("file", 0o444, PROVIDER))))  # wrong mode
        self.assertTrue(mutated(lambda s: s.__setitem__("opt/winter/standin/profile.json", ("file", 0o555, PROFILE))))      # wrong mode
        self.assertTrue(mutated(lambda s: s.__setitem__("opt/winter/standin", ("directory", 0o755, b""))))             # directory mode
        self.assertTrue(mutated(lambda s: s.__setitem__("init", production["init"])))                                  # init not replaced
        self.assertTrue(mutated(lambda s: s.__setitem__("bin", ("symlink", 0o777, b"elsewhere"))))                     # a link retargeted


def snapshot_pair():
    return bsi.snapshot(production_tree()), bsi.snapshot(standin_tree())


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.base = cpio_bytes(production_tree())
        (self.dir / "base.cpio").write_bytes(self.base)
        (self.dir / "init-standin").write_bytes(INIT_STANDIN)
        (self.dir / "winter-provider").write_bytes(PROVIDER)
        self.production_pins = {"expectedArtifact": {"cpioSha256": bsi.sha(self.base)}}
        self.pins = {"initramfsSha256": None}

    def tearDown(self):
        self.folder.cleanup()

    def run_build(self, **kw):
        return bsi.build(self.dir / "base.cpio", self.dir / "init-standin", self.dir / "winter-provider", self.dir / "out", pins=kw.get("pins", self.pins),
                         production_pins=kw.get("production_pins", self.production_pins))

    def test_the_built_cpio_reads_back_as_exactly_the_overlay_on_the_production_tree(self):
        receipt = self.run_build()
        built = bsi.read_cpio((self.dir / "out/initramfs.cpio").read_bytes())
        self.assertEqual(bsi.overlay_problems(bsi.snapshot(production_tree()), bsi.snapshot(built)), [])
        self.assertTrue(receipt["baseIsTheProductionPin"])
        self.assertTrue(receipt["testOnly"])
        self.assertFalse(receipt["bootVerified"])
        self.assertFalse(receipt["pinned"])
        self.assertEqual(receipt["initramfsSha256"], bsi.sha((self.dir / "out/initramfs.cpio").read_bytes()))
        self.assertNotEqual(receipt["initramfsSha256"], receipt["baseCpioSha256"])
        self.assertEqual(json.loads((self.dir / "out/receipt.json").read_text()), receipt)

    def test_the_build_is_deterministic(self):
        first = self.run_build()
        second = bsi.build(self.dir / "base.cpio", self.dir / "init-standin", self.dir / "winter-provider", self.dir / "out2", pins=self.pins, production_pins=self.production_pins)
        self.assertEqual(first["initramfsSha256"], second["initramfsSha256"])

    def test_a_base_that_is_not_the_production_pin_is_reported_and_main_exits_3(self):
        receipt = self.run_build(production_pins={"expectedArtifact": {"cpioSha256": "0" * 64}})
        self.assertFalse(receipt["baseIsTheProductionPin"])

    def test_a_pinned_stand_in_digest_that_differs_is_reported(self):
        receipt = self.run_build(pins={"initramfsSha256": "0" * 64})
        self.assertTrue(receipt["pinMismatch"])
        self.assertTrue(receipt["pinned"])

    def test_a_pinned_stand_in_digest_that_matches_is_not_a_mismatch(self):
        digest = self.run_build()["initramfsSha256"]
        receipt = bsi.build(self.dir / "base.cpio", self.dir / "init-standin", self.dir / "winter-provider", self.dir / "out3", pins={"initramfsSha256": digest}, production_pins=self.production_pins)
        self.assertNotIn("pinMismatch", receipt)

    def test_a_production_cpio_that_does_not_round_trip_is_refused(self):
        data = bytearray(self.base)
        data[-5] = 1                                                                   # padding after the trailer is not zero
        (self.dir / "base.cpio").write_bytes(bytes(data))
        with self.assertRaises(ValueError):
            self.run_build()

    def test_an_existing_output_folder_is_refused(self):
        (self.dir / "out").mkdir()
        with self.assertRaises(FileExistsError):
            self.run_build()

    def test_main_prints_the_stand_in_runtime_image_digest_for_a_given_kernel_and_exits_3_off_the_pin(self):
        args = ["--production-cpio", str(self.dir / "base.cpio"), "--init-standin", str(self.dir / "init-standin"), "--provider", str(self.dir / "winter-provider"),
                "--out", str(self.dir / "out"), "--kernel-sha256", "ab" * 32]
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            real_pins = bsi.json.loads((HERE / "pins.json").read_text())
            code = bsi.main(args)
        receipt = json.loads((self.dir / "out/receipt.json").read_text())
        self.assertEqual(receipt["runtimeImageDigest"], rid.runtime_image_digest("ab" * 32, receipt["initramfsSha256"]))
        self.assertEqual(code, 3)          # the synthetic base is not the real production pin
        self.assertFalse(receipt["baseIsTheProductionPin"])
        self.assertNotEqual(real_pins["expectedArtifact"]["cpioSha256"], receipt["baseCpioSha256"])


@unittest.skipUnless(os.environ.get("STANDIN_PRODUCTION_CPIO"), "set STANDIN_PRODUCTION_CPIO to a real production immutable-root.cpio")
class RealCpioTests(unittest.TestCase):
    def test_the_real_production_cpio_survives_a_read_and_a_rewrite_unchanged(self):
        data = Path(os.environ["STANDIN_PRODUCTION_CPIO"]).read_bytes()
        self.assertEqual(cpio_bytes(bsi.read_cpio(data)), data)


if __name__ == "__main__":
    unittest.main()
