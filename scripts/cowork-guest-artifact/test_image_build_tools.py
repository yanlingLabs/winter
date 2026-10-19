"""The two small tools the one-run image build uses: the Bun unpacker and the two-build report. Synthetic inputs only; nothing is built."""
import contextlib, hashlib, io, json, os, shutil, tempfile, unittest, zipfile
from pathlib import Path

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


def write_image(folder, cpio=b"cpio", manifest=b"manifest", runtime=None, init="i" * 64):
    folder.mkdir()
    (folder / "immutable-root.cpio").write_bytes(cpio)
    (folder / "root.manifest.json").write_bytes(manifest)
    (folder / "receipt.json").write_text(json.dumps({"runtimeSha256": runtime or PINS["expectedArtifact"]["runtimeSha256"], "initSha256": init, "reproducibilityPinned": True}))


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
        for kw in ({"cpio": b"other"}, {"manifest": b"other"}, {"runtime": "f" * 64}, {"init": "j" * 64}):
            self.assertIn("the two image builds differ", ibr.problems(self.build(image2=kw)), kw)

    def test_a_nonzero_image_status_is_a_problem_even_when_the_files_agree(self):
        self.assertTrue(any("exited [3, 0]" in line for line in ibr.problems(self.build(s1=3))))
        self.assertTrue(any("exited [0, 3]" in line for line in ibr.problems(self.build(s2=3))))

    def test_all_pins_holding_and_all_builds_agreeing_is_clean(self):
        digests = self.build()
        digests["image"]["pinsHold"] = {key: True for key in digests["image"]["pinsHold"]}
        self.assertEqual(ibr.problems(digests), [])

    def test_collect_copies_exactly_the_published_files_under_the_installed_names_and_refuses_an_existing_folder(self):
        self.build()
        (self.dir / "i1" / "elf-dependencies.json").write_text("{}")
        (self.dir / "i1" / "size-breakdown.json").write_text("{}")
        (self.dir / "i1" / "cpio-verification.json").write_text("{}")
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

    def good(self, **kw):
        digests = self.build(**kw)
        digests["image"]["pinsHold"] = {key: True for key in digests["image"]["pinsHold"]}
        return digests

    def test_green_means_everything_matches_the_pins(self):
        digests = self.good()
        self.assertEqual(ibr.classify(digests), (ibr.EXIT_OK, []))
        for edit in (lambda d: d["image"]["pinsHold"].__setitem__("cpioSha256", False), lambda d: d["image"].__setitem__("imageExitStatus", [3, 0]),
                     lambda d: d["image"].__setitem__("imageExitStatus", [0, 3]), lambda d: d["kernel"].__setitem__("reproducible", False)):
            changed = self.good()
            edit(changed)
            self.assertNotEqual(ibr.classify(changed)[0], ibr.EXIT_OK)

    def test_stale_pins_with_reproducible_builds_is_its_own_code(self):
        digests = self.build()                                   # the synthetic image does not hold the real pins
        code, details = ibr.classify(digests)
        self.assertEqual(code, ibr.EXIT_PINS_STALE)
        self.assertIn("pins.json cpioSha256 does not hold", details)
        only_status = self.good(s1=3, s2=3)
        self.assertEqual(ibr.classify(only_status)[0], ibr.EXIT_PINS_STALE)

    def test_a_build_that_is_not_reproducible_outranks_stale_pins_and_an_odd_status(self):
        for kw in ({"kernel2": {"image": b"other"}}, {"image2": {"cpio": b"other"}}):
            digests = self.build(**kw)
            self.assertEqual(ibr.classify(digests)[0], ibr.EXIT_NOT_REPRODUCIBLE, kw)
            digests["image"]["imageExitStatus"] = [1, 1]
            self.assertEqual(ibr.classify(digests)[0], ibr.EXIT_NOT_REPRODUCIBLE, kw)

    def test_an_unexpected_image_status_is_its_own_code_when_the_builds_agree(self):
        digests = self.good()
        digests["image"]["imageExitStatus"] = [1, 0]
        self.assertEqual(ibr.classify(digests)[0], ibr.EXIT_UNEXPECTED_STATUS)

    def test_the_four_exit_codes_and_labels_are_distinct(self):
        codes = [ibr.EXIT_OK, ibr.EXIT_PINS_STALE, ibr.EXIT_NOT_REPRODUCIBLE, ibr.EXIT_UNEXPECTED_STATUS]
        self.assertEqual(len(set(codes)), 4)
        self.assertEqual(codes[0], 0)
        self.assertEqual(sorted(ibr.LABELS), sorted(codes))
        self.assertEqual(len(set(ibr.LABELS.values())), 4)
        self.assertEqual(sorted(ibr.MEANINGS), sorted(codes))

    def test_assert_writes_the_classification_to_the_step_summary_and_returns_the_code(self):
        for kw, code, label in (({}, ibr.EXIT_PINS_STALE, "PINS_STALE"), ({"kernel2": {"image": b"other"}}, ibr.EXIT_NOT_REPRODUCIBLE, "NOT_REPRODUCIBLE")):
            digests = self.build(**kw)
            path, summary = self.dir / f"digests-{label}.json", self.dir / f"summary-{label}.md"
            path.write_text(json.dumps(digests))
            previous = os.environ.get("GITHUB_STEP_SUMMARY")
            os.environ["GITHUB_STEP_SUMMARY"] = str(summary)
            try:
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(ibr.main(["assert", str(path)]), code)
            finally:
                if previous is None:
                    del os.environ["GITHUB_STEP_SUMMARY"]
                else:
                    os.environ["GITHUB_STEP_SUMMARY"] = previous
            text = summary.read_text()
            self.assertIn(f"## Guest image build: {label}", text)
            self.assertIn(digests["image"]["cpioSha256"], text)
            self.assertIn(digests["runtimeImageDigest"], text)
            self.assertIn(f"RESULT: {label} (exit {code})", printed.getvalue())
        self.assertIn("EXPECTED result after an sdkCommit bump", ibr.MEANINGS[ibr.EXIT_PINS_STALE])
        self.assertIn("do not pin anything", ibr.MEANINGS[ibr.EXIT_NOT_REPRODUCIBLE])

    def test_without_a_step_summary_nothing_is_written_and_the_code_is_still_returned(self):
        digests = self.good()
        path = self.dir / "d.json"
        path.write_text(json.dumps(digests))
        previous = os.environ.pop("GITHUB_STEP_SUMMARY", None)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ibr.main(["assert", str(path)]), ibr.EXIT_OK)
        finally:
            if previous is not None:
                os.environ["GITHUB_STEP_SUMMARY"] = previous

    def test_the_report_command_writes_the_file_and_exits_zero_while_assert_exits_one_on_problems(self):
        self.build()
        out = self.dir / "digests.json"
        args = ["report", "--kernel-1", str(self.dir / "k1"), "--kernel-2", str(self.dir / "k2"), "--image-1", str(self.dir / "i1"), "--image-2", str(self.dir / "i2"), "--status-1", "3", "--status-2", "3", "--out", str(out)]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ibr.main(args), 0)
            self.assertTrue(out.is_file())
            self.assertEqual(ibr.main(["assert", str(out)]), ibr.EXIT_PINS_STALE)


if __name__ == "__main__":
    unittest.main()
