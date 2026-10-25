"""The two small tools the one-run image build uses: the Bun unpacker and the two-build report. Synthetic inputs only; nothing is built."""
import contextlib, hashlib, io, json, shutil, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch

import image
import image_build_report as ibr
import runtime_image_digest as rid
import unpack_bun as ub

PINS = json.loads((Path(__file__).resolve().parent / "pins.json").read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_zip(entry, data):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        bundle.writestr(entry, data)
    return buffer.getvalue()


class ZigArchiveTests(unittest.TestCase):
    def test_either_pinned_host_archive_is_accepted_and_anything_else_is_not(self):
        mac, linux = b"macos archive", b"linux archive"
        pins = {"zig": {"archiveSha256": sha(mac), "linuxArchiveSha256": sha(linux)}}
        self.assertTrue(image.zig_archive_ok(mac, pins))
        self.assertTrue(image.zig_archive_ok(linux, pins))
        self.assertFalse(image.zig_archive_ok(b"other", pins))
        self.assertFalse(image.zig_archive_ok(b"", pins))

    def test_the_real_pins_name_two_different_official_archives(self):
        zig = PINS["zig"]
        self.assertNotEqual(zig["archiveSha256"], zig["linuxArchiveSha256"])
        for key in ("archiveSha256", "linuxArchiveSha256"):
            self.assertRegex(zig[key], r"^[0-9a-f]{64}$")
        self.assertIn("macos", zig["archiveUrl"])
        self.assertIn("linux", zig["linuxArchiveUrl"])
        self.assertTrue(zig["archiveUrl"].startswith("https://ziglang.org/download/0.14.1/"))
        self.assertTrue(zig["linuxArchiveUrl"].startswith("https://ziglang.org/download/0.14.1/"))


class UnpackBunTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.exe = b"pretend bun"
        self.archive = make_zip("bun-linux-aarch64/bun", self.exe)
        self.pins = {"archiveSha256": sha(self.archive), "archiveEntry": "bun-linux-aarch64/bun", "executableSha256": sha(self.exe)}
        (self.dir / "bun.zip").write_bytes(self.archive)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_pinned_archive_gives_the_pinned_executable_exclusively(self):
        ub.unpack(self.dir / "bun.zip", self.dir / "bun", self.pins)
        self.assertEqual((self.dir / "bun").read_bytes(), self.exe)
        with self.assertRaises(FileExistsError):
            ub.unpack(self.dir / "bun.zip", self.dir / "bun", self.pins)

    def test_a_different_archive_is_refused(self):
        with self.assertRaises(ValueError):
            ub.unpack(self.dir / "bun.zip", self.dir / "bun", {**self.pins, "archiveSha256": "0" * 64})

    def test_a_different_executable_inside_the_pinned_archive_is_refused(self):
        with self.assertRaises(ValueError):
            ub.unpack(self.dir / "bun.zip", self.dir / "bun", {**self.pins, "executableSha256": "0" * 64})
        self.assertFalse((self.dir / "bun").exists())

    def test_a_missing_entry_is_refused(self):
        with self.assertRaises(KeyError):
            ub.unpack(self.dir / "bun.zip", self.dir / "bun", {**self.pins, "archiveEntry": "other"})

    def test_an_existing_symlink_at_the_output_is_not_followed(self):
        (self.dir / "target").write_bytes(b"x")
        (self.dir / "bun").symlink_to(self.dir / "target")
        with self.assertRaises(FileExistsError):
            ub.unpack(self.dir / "bun.zip", self.dir / "bun", self.pins)
        self.assertEqual((self.dir / "target").read_bytes(), b"x")


def write_kernel(folder, image=b"image", vmlinux=b"vmlinux", config=b"config"):
    folder.mkdir()
    (folder / "kernel-receipt.json").write_text(json.dumps({"ImageSha256": sha(image), "ImageBytes": len(image), "vmlinuxSha256": sha(vmlinux), "resolvedConfigSha256": sha(config)}))


def write_image(folder, cpio=b"cpio", manifest=b"manifest", runtime=None, init="i" * 64, relay="r" * 64):
    folder.mkdir()
    (folder / "immutable-root.cpio").write_bytes(cpio)
    (folder / "root.manifest.json").write_bytes(manifest)
    (folder / "receipt.json").write_text(json.dumps({"runtimeSha256": runtime or PINS["expectedArtifact"]["runtimeSha256"], "initSha256": init, "relaySha256": relay, "reproducibilityPinned": True}))


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def build(self, **kw):
        for name in ("k1", "k2", "i1", "i2"):
            shutil.rmtree(self.dir / name, ignore_errors=True)
        write_kernel(self.dir / "k1")
        write_kernel(self.dir / "k2", **kw.get("kernel2", {}))
        write_image(self.dir / "i1")
        write_image(self.dir / "i2", **kw.get("image2", {}))
        return ibr.report(self.dir / "k1", self.dir / "k2", self.dir / "i1", self.dir / "i2", kw.get("s1", 0), kw.get("s2", 0))

    def test_the_digest_is_the_rule_applied_to_the_first_builds_files(self):
        digests = self.build()
        self.assertEqual(digests["runtimeImageDigest"], rid.runtime_image_digest(sha(b"image"), sha(b"cpio")))
        self.assertTrue(digests["kernel"]["reproducible"])
        self.assertTrue(digests["image"]["reproducible"])
        self.assertFalse(digests["kernel"]["bootVerified"])

    def test_identical_builds_that_hold_no_local_pin_still_report_which_pins_do_not_hold(self):
        found = ibr.problems(self.build())
        self.assertIn("pins.json cpioSha256 does not hold", found)
        self.assertIn("pins.json rootManifestSha256 does not hold", found)
        self.assertNotIn("pins.json runtimeSha256 does not hold", found)
        self.assertNotIn("the two kernel builds differ", found)
        self.assertNotIn("the two image builds differ", found)

    def test_every_kernel_difference_is_a_problem(self):
        for kw in ({"image": b"other"}, {"vmlinux": b"other"}, {"config": b"other"}):
            self.assertIn("the two kernel builds differ", ibr.problems(self.build(kernel2=kw)), kw)

    def test_every_image_difference_is_a_problem(self):
        for kw in ({"cpio": b"other"}, {"manifest": b"other"}, {"runtime": "f" * 64}, {"init": "j" * 64}, {"relay": "k" * 64}):
            self.assertIn("the two image builds differ", ibr.problems(self.build(image2=kw)), kw)

    def test_a_nonzero_image_status_is_a_problem_even_when_the_files_agree(self):
        self.assertTrue(any("exited [3, 0]" in line for line in ibr.problems(self.build(s1=3))))
        self.assertTrue(any("exited [0, 3]" in line for line in ibr.problems(self.build(s2=3))))

    def test_all_pins_holding_and_all_builds_agreeing_is_clean(self):
        digests = self.build()
        digests["image"]["pinsHold"] = {key: True for key in digests["image"]["pinsHold"]}
        digests["image"]["initPinned"] = digests["image"]["relayPinned"] = True
        digests["kernel"]["pinnedBefore"] = digests["kernel"]["ImageSha256"]            # the pinned kernel is the built one
        self.assertEqual(ibr.problems(digests), [])
        digests["kernel"]["pinnedBefore"] = None
        self.assertIn("the kernel Image is not pinned yet (kernel/pins.json expectedOutputs.Image)", ibr.problems(digests))
        digests["kernel"]["pinnedBefore"] = "0" * 64
        self.assertIn("the built kernel is not the pinned kernel (kernel/pins.json expectedOutputs.Image)", ibr.problems(digests))

    def test_both_guest_binary_digests_are_in_digests_json_with_whether_each_is_pinned(self):
        digests = self.build()
        self.assertEqual((digests["image"]["initSha256"], digests["image"]["relaySha256"]), ("i" * 64, "r" * 64))
        self.assertEqual((digests["image"]["initPinned"], digests["image"]["relayPinned"]), (False, False))     # pins.json holds null for both (or another digest): not pinned to this build
        found = ibr.problems(digests)
        self.assertTrue(any("guest.programs.init.binarySha256 is null or does not hold" in line and "image.initSha256" in line for line in found))
        self.assertTrue(any("guest.programs.winter-guest-relay.binarySha256 is null or does not hold" in line and "image.relaySha256" in line for line in found))
        pins = json.loads(json.dumps(ibr.PINS))
        pins["guest"]["programs"]["init"]["binarySha256"] = "i" * 64
        pins["guest"]["programs"]["winter-guest-relay"]["binarySha256"] = "q" * 64                                   # set, but not what this build produced
        with patch.object(ibr, "PINS", pins):
            digests = self.build()
        self.assertEqual((digests["image"]["initPinned"], digests["image"]["relayPinned"]), (True, False))
        found = ibr.problems(digests)
        self.assertFalse(any("guest.programs.init." in line for line in found))
        self.assertTrue(any("guest.programs.winter-guest-relay." in line for line in found))
        pins["guest"]["programs"]["init"]["binarySha256"] = "p" * 64                                                 # and the other way round: init stale, relay right
        pins["guest"]["programs"]["winter-guest-relay"]["binarySha256"] = "r" * 64
        with patch.object(ibr, "PINS", pins):
            digests = self.build()
        self.assertEqual((digests["image"]["initPinned"], digests["image"]["relayPinned"]), (False, True))
        self.assertTrue(any("guest.programs.init." in line for line in ibr.problems(digests)))
        pins["guest"]["programs"]["init"]["binarySha256"] = "i" * 64
        with patch.object(ibr, "PINS", pins):
            digests = self.build()
        self.assertEqual((digests["image"]["initPinned"], digests["image"]["relayPinned"]), (True, True))
        self.assertFalse(any("guest.programs" in line for line in ibr.problems(digests)))

    def test_a_package_lock_that_is_not_the_pinned_one_is_reported_with_its_digest_and_turns_the_run_red(self):
        digests = self.build()
        self.assertIn("packageLockSha256", digests["image"])
        self.assertIs(digests["image"]["pinsHold"]["packageLockSha256"], False)          # the fixture receipt carries no lock digest
        self.assertIn("pins.json packageLockSha256 does not hold", ibr.problems(digests))

    def test_collect_copies_exactly_the_published_files_under_the_installed_names_and_refuses_an_existing_folder(self):
        self.build()
        (self.dir / "i1" / "elf-dependencies.json").write_text("{}")
        (self.dir / "i1" / "size-breakdown.json").write_text("{}")
        (self.dir / "i1" / "cpio-verification.json").write_text("{}")
        (self.dir / "i1" / "packages.lock.json").write_text("{}")
        (self.dir / "k1" / "Image").write_bytes(b"image")
        (self.dir / "k1" / "resolved.config").write_bytes(b"config")
        ibr.collect(self.dir / "k1", self.dir / "i1", self.dir / "publish")
        self.assertEqual(sorted(p.name for p in (self.dir / "publish").iterdir()), sorted(name for _, _, name in ibr.PUBLISH))
        self.assertEqual((self.dir / "publish" / "kernel").read_bytes(), b"image")
        self.assertEqual((self.dir / "publish" / "initramfs.cpio").read_bytes(), b"cpio")
        with self.assertRaises(FileExistsError):
            ibr.collect(self.dir / "k1", self.dir / "i1", self.dir / "publish")

    def test_collect_refuses_when_a_build_file_is_missing(self):
        self.build()
        with self.assertRaises(FileNotFoundError):
            ibr.collect(self.dir / "k1", self.dir / "i1", self.dir / "publish")

    def test_the_report_command_writes_the_file_and_exits_zero_while_assert_exits_one_on_problems(self):
        self.build()
        out = self.dir / "digests.json"
        args = ["report", "--kernel-1", str(self.dir / "k1"), "--kernel-2", str(self.dir / "k2"), "--image-1", str(self.dir / "i1"), "--image-2", str(self.dir / "i2"), "--status-1", "3", "--status-2", "3", "--out", str(out)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ibr.main(args), 0)
            self.assertTrue(out.is_file())
            self.assertEqual(ibr.main(["assert", str(out)]), 1)


if __name__ == "__main__":
    unittest.main()
