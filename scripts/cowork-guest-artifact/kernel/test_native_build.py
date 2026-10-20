"""Offline checks of native_build.py's pure parts and of ci-build.json. Builds nothing, downloads nothing, needs no network."""
import calendar, json, shutil, subprocess, tempfile, time, unittest
from pathlib import Path

import native_build as nb
from test_kernel_pins import PINS, HERE, effective_config, parse_config


def gpg_available():
    return shutil.which("gpg") is not None


class ConfigTests(unittest.TestCase):
    def test_the_merge_gives_the_same_symbols_as_the_base_plus_the_fragment(self):
        merged = nb.merge_config((HERE / PINS["baseConfig"]["file"]).read_text(), (HERE / PINS["fragment"]["file"]).read_text())
        with tempfile.NamedTemporaryFile("w", suffix=".config") as handle:
            handle.write(merged)
            handle.flush()
            self.assertEqual(parse_config(handle.name), effective_config())

    def test_a_fragment_symbol_replaces_both_spellings_in_the_base_and_nothing_else(self):
        base = "CONFIG_A=y\n# CONFIG_B is not set\nCONFIG_C=m\n# a comment\n"
        self.assertEqual(nb.merge_config(base, "CONFIG_A=n\n"), "# CONFIG_B is not set\nCONFIG_C=m\n# a comment\nCONFIG_A=n\n")
        self.assertEqual(nb.merge_config(base, "CONFIG_B=y\n"), "CONFIG_A=y\nCONFIG_C=m\n# a comment\nCONFIG_B=y\n")

    def test_a_fragment_that_names_a_symbol_twice_is_refused(self):
        with self.assertRaises(ValueError):
            nb.merge_config("CONFIG_A=y\n", "CONFIG_A=n\n# CONFIG_A is not set\n")

    def test_the_resolved_config_check_accepts_the_effective_config_and_refuses_every_kind_of_drift(self):
        text = nb.merge_config((HERE / PINS["baseConfig"]["file"]).read_text(), (HERE / PINS["fragment"]["file"]).read_text())
        self.assertEqual(nb.resolved_config_problems(text, PINS["requiredSymbols"], PINS["mustBeAbsentFromTheBuild"]), [])
        symbol = "CONFIG_VIRTIO_BLK"
        dropped = "\n".join(line for line in text.splitlines() if nb.config_symbol(line) != symbol)
        self.assertEqual(len(nb.resolved_config_problems(dropped, PINS["requiredSymbols"], [])), 1)
        wrong = text.replace(f"{symbol}=y", f"{symbol}=m")
        self.assertEqual(len(nb.resolved_config_problems(wrong, PINS["requiredSymbols"], [])), 1)
        crypto = text + "CONFIG_DM_CRYPT=y\n"
        self.assertEqual(len(nb.resolved_config_problems(crypto, {}, PINS["mustBeAbsentFromTheBuild"])), 1)
        unset = text + "# CONFIG_DM_CRYPT is not set\n"
        self.assertEqual(nb.resolved_config_problems(unset, {}, PINS["mustBeAbsentFromTheBuild"]), [])

    def test_a_required_n_is_met_by_a_missing_symbol(self):
        self.assertEqual(nb.resolved_config_problems("CONFIG_X=y\n", {"CONFIG_Y": "n"}, []), [])


class CommandTests(unittest.TestCase):
    def test_the_pinned_commands_are_rewritten_to_this_host_and_keep_their_flags(self):
        for command in PINS["commands"]:
            out = nb.rewrite_command(command, "/w/src", "/w/out", "/w/llvm/bin", 4)
            self.assertEqual(out[0], "make")
            self.assertNotIn("/build", " ".join(out))
            self.assertIn("O=/w/out", out)
            self.assertIn("LLVM=/w/llvm/bin/", out)
            self.assertIn("-j4", out)
            self.assertIn("ARCH=arm64", out)
            self.assertIn("LLVM_IAS=1", out)
            self.assertEqual(out[1:3], ["-C", "/w/src"])
        self.assertEqual(nb.rewrite_command(PINS["commands"][0], "/s", "/o", "/l", 2)[-1], "olddefconfig")
        self.assertEqual(nb.rewrite_command(PINS["commands"][1], "/s", "/o", "/l", 2)[-2:], ["Image", "vmlinux"])

    def test_an_unknown_token_in_a_pinned_command_is_refused_not_passed_through(self):
        with self.assertRaises(ValueError):
            nb.rewrite_command(PINS["commands"][0] + ["CC=/tmp/evil"], "/s", "/o", "/l", 2)
        with self.assertRaises(ValueError):
            nb.rewrite_command(["/usr/bin/env", "-C", "/build/src/linux-6.18.35"], "/s", "/o", "/l", 2)

    def test_the_environment_is_the_pinned_one_plus_the_two_values_the_recipe_left_open(self):
        env = nb.build_environment("/w/llvm/bin")
        for key, value in PINS["environment"].items():
            if key != "PATH":
                self.assertEqual(env[key], value)
        self.assertEqual(env["PATH"], "/w/llvm/bin:/usr/bin:/bin")
        self.assertEqual(env["SOURCE_DATE_EPOCH"], nb.CI["sourceDateEpoch"])
        self.assertEqual(env["KBUILD_BUILD_TIMESTAMP"], nb.CI["kbuildBuildTimestamp"])
        self.assertEqual(set(env) - set(PINS["environment"]), {"SOURCE_DATE_EPOCH", "KBUILD_BUILD_TIMESTAMP", "HOME"})


class PathIndependenceTests(unittest.TestCase):
    """The kernel must not carry the runner's work path: run 39471145301 differed from run 39406043639 only by the random work folder."""
    WORK = "/home/runner/work/_temp/winter-kernel-work"

    def test_the_build_passes_file_debug_and_macro_prefix_maps_for_the_work_folder_to_c_and_assembly(self):
        env = nb.build_environment("/w/llvm/bin", self.WORK)
        for key in ("KCFLAGS", "KAFLAGS"):
            self.assertEqual(env[key].split(), [f"-ffile-prefix-map={self.WORK}=.", f"-fdebug-prefix-map={self.WORK}=.", f"-fmacro-prefix-map={self.WORK}=."])

    def test_the_identity_values_are_fixed_and_the_pinned_ones_are_unchanged(self):
        env = nb.build_environment("/w/llvm/bin", self.WORK)
        self.assertEqual((env["KBUILD_BUILD_USER"], env["KBUILD_BUILD_HOST"]), ("cowork-fixture", "isolated"))
        self.assertEqual(env["KBUILD_BUILD_TIMESTAMP"], nb.CI["kbuildBuildTimestamp"])
        self.assertEqual(env["SOURCE_DATE_EPOCH"], nb.CI["sourceDateEpoch"])
        for key, value in PINS["environment"].items():
            if key != "PATH":
                self.assertEqual(env[key], value)

    def test_the_build_function_hands_its_own_work_folder_to_the_environment(self):
        import inspect
        self.assertIn("build_environment(str(llvm_bin), work)", inspect.getsource(nb.build))

    def test_the_workflow_builds_at_one_fixed_work_path(self):
        text = (HERE.parents[2] / ".github/workflows/cowork-guest-image-build.yml").read_text()
        self.assertIn('kernel_work="$RUNNER_TEMP/winter-kernel-work"', text)

    def test_the_two_kernel_builds_use_different_work_paths_and_must_still_agree_byte_for_byte(self):
        text = (HERE.parents[2] / ".github/workflows/cowork-guest-image-build.yml").read_text()
        self.assertIn('kernel_work_b="$RUNNER_TEMP/winter-kernel-work-b"', text)
        self.assertIn('test "$kernel_work" != "$kernel_work_b"', text)
        self.assertIn('--work "$kernel_work" --out "$IMAGE_WORK/kernel-1"', text)
        self.assertIn('--work "$kernel_work_b" --out "$IMAGE_WORK/kernel-2"', text)
        import image_build_report as ibr
        self.assertIn("the two kernel builds differ", ibr.problems({"kernel": {"reproducible": False, "pinnedBefore": "0" * 64, "ImageSha256": "0" * 64}, "image": {"reproducible": True, "imageExitStatus": [0, 0], "pinsHold": {}}}))


class CiBuildPinTests(unittest.TestCase):
    def test_the_open_environment_values_are_pinned_and_agree_with_each_other(self):
        ci = nb.CI
        self.assertRegex(ci["sourceDateEpoch"], r"^[1-9][0-9]{9}$")
        self.assertEqual(ci["kbuildBuildTimestamp"], time.strftime("%a %b %d %H:%M:%S UTC %Y", time.gmtime(int(ci["sourceDateEpoch"]))))
        self.assertEqual(calendar.timegm(time.strptime(ci["kbuildBuildTimestamp"], "%a %b %d %H:%M:%S UTC %Y")), int(ci["sourceDateEpoch"]))
        self.assertEqual(sorted(ci["signatureUrls"]), ["kernel", "toolchain"])
        for url in ci["signatureUrls"].values():
            self.assertTrue(url.startswith("https://cdn.kernel.org/"))
        self.assertIsInstance(ci["jobs"], int)
        self.assertGreaterEqual(ci["jobs"], 1)
        self.assertEqual(ci["installedKernel"]["buildOutput"], "arch/arm64/boot/Image")

    def test_the_recipe_is_built_and_reproduced_once_and_still_unbooted(self):
        self.assertEqual(PINS["status"], "built-reproduced-unbooted")
        self.assertEqual(nb.CI["status"], "run-once-reproduced")
        self.assertFalse(PINS["bootVerified"])

    def test_the_host_packages_are_build_tools_only(self):
        self.assertEqual(sorted(nb.CI["hostPackages"]), ["bc", "bison", "flex", "libelf-dev", "libssl-dev"])


class FakeGpgTests(unittest.TestCase):
    """The decision logic around gpg, with a stand-in program that prints the status lines and exits as told. Needs no real gpg."""

    def fake(self, folder, status, code):
        script = Path(folder) / "gpg"
        script.write_text(f"#!/bin/sh\ncase \"$*\" in *--verify*) printf '%s\\n' '{status}'; exit {code};; esac\nexit 0\n")
        script.chmod(0o755)
        return str(script)

    def verify(self, status, code, fingerprints):
        with tempfile.TemporaryDirectory() as folder:
            for name in ("sig", "data", "key"):
                (Path(folder) / name).write_bytes(b"x")
            nb.gpg_verify(Path(folder) / "sig", Path(folder) / "data", Path(folder) / "key", fingerprints, gpg=self.fake(folder, status, code))

    def test_a_valid_signature_by_the_pinned_signer_with_exit_zero_passes(self):
        self.verify("[GNUPG:] VALIDSIG " + "A" * 40 + " 2026-10-18 1 0 4 0 22 8 00 " + "B" * 40, 0, {"B" * 40})

    def test_the_signing_key_matches_field_0_and_the_primary_only_field_9_never_another_field(self):
        self.verify("[GNUPG:] VALIDSIG " + "A" * 40 + " 2026-10-18 1 0 4 0 22 8 00 " + "B" * 40, 0, {"A" * 40})
        for line in ("[GNUPG:] VALIDSIG " + "A" * 40 + " " + "C" * 40 + " 1 0 4 0 22 8 00 " + "B" * 40,  # pinned value in a middle field
                     "[GNUPG:] VALIDSIG " + "A" * 40 + " 2026-10-18 1 0 4 0 22 8 00"):  # no primary field at all, so the last field is not one
            with self.assertRaises(ValueError):
                self.verify(line, 0, {"C" * 40} if "C" in line else {"00"})

    def test_a_nonzero_exit_is_a_refusal_even_if_the_status_line_looks_valid(self):
        with self.assertRaises(ValueError) as caught:
            self.verify("[GNUPG:] VALIDSIG " + "A" * 40 + " x x x x x x x x " + "B" * 40, 1, {"A" * 40})
        self.assertIn("does not verify", str(caught.exception))

    def test_no_valid_signature_line_is_a_refusal_even_with_exit_zero(self):
        with self.assertRaises(ValueError):
            self.verify("[GNUPG:] GOODSIG something", 0, {"A" * 40})


class FlowTests(unittest.TestCase):
    """The order and the gates of a build, with the processes replaced by fakes."""

    def good_config(self):
        return nb.merge_config((HERE / PINS["baseConfig"]["file"]).read_text(), (HERE / PINS["fragment"]["file"]).read_text())

    def run_flow(self, config_text):
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)

            def runner(command, cwd, env, log):
                calls.append(command[-1])
                if command[-1] == "olddefconfig":
                    (output / ".config").write_text(config_text)

            try:
                nb.resolve_and_build([["x", "olddefconfig"], ["x", "vmlinux"]], "/s", output, {}, None, runner=runner)
                error = None
            except ValueError as caught:
                error = str(caught)
        return calls, error

    def test_a_good_resolved_config_lets_the_real_build_start_after_olddefconfig(self):
        calls, error = self.run_flow(self.good_config())
        self.assertIsNone(error)
        self.assertEqual(calls, ["olddefconfig", "vmlinux"])

    def test_a_dropped_required_symbol_stops_the_build_before_it_starts(self):
        text = "\n".join(line for line in self.good_config().splitlines() if nb.config_symbol(line) != "CONFIG_VIRTIO_BLK")
        calls, error = self.run_flow(text)
        self.assertIn("CONFIG_VIRTIO_BLK", error)
        self.assertEqual(calls, ["olddefconfig"])

    def test_disk_encryption_in_the_resolved_config_stops_the_build(self):
        calls, error = self.run_flow(self.good_config() + "CONFIG_DM_CRYPT=y\n")
        self.assertIn("CONFIG_DM_CRYPT", error)
        self.assertEqual(calls, ["olddefconfig"])


class InputTests(unittest.TestCase):
    def prepare(self, folder):
        downloads = Path(folder)
        for key in nb.ARCHIVES:
            for name in nb.ARCHIVES[key]:
                (downloads / name).write_bytes(b"x")
        return downloads

    def test_every_one_of_the_six_downloads_is_checked_individually(self):
        # Make each pinned digest the digest of b"x" except one, and require that one to be the refusal.
        import hashlib
        good = hashlib.sha256(b"x").hexdigest()
        slots = [(key, field) for key in ("kernel", "toolchain") for field in ("sha256", "signatureSha256", "publicKeySha256")]
        base_pins, base_files = {key: dict(nb.PINS[key]) for key in ("kernel", "toolchain")}, (nb.PINS["baseConfig"]["sha256"], nb.PINS["fragment"]["sha256"])
        try:
            for bad_key, bad_field in slots:
                for key, field in slots:
                    nb.PINS[key][field] = "0" * 64 if (key, field) == (bad_key, bad_field) else good
                with tempfile.TemporaryDirectory() as folder:
                    with self.assertRaises(ValueError) as caught:
                        nb.check_inputs(self.prepare(folder))
                    archive, signature, key_file = nb.ARCHIVES[bad_key]
                    self.assertIn({"sha256": archive, "signatureSha256": signature, "publicKeySha256": key_file}[bad_field], str(caught.exception))
        finally:
            for key, saved in base_pins.items():
                nb.PINS[key].clear()
                nb.PINS[key].update(saved)

    def test_the_two_config_files_are_checked_against_their_pins_each_on_its_own(self):
        import hashlib
        good = hashlib.sha256(b"x").hexdigest()
        saved = {key: dict(nb.PINS[key]) for key in ("kernel", "toolchain", "baseConfig", "fragment")}
        try:
            for key in ("kernel", "toolchain"):
                for field in ("sha256", "signatureSha256", "publicKeySha256"):
                    nb.PINS[key][field] = good
            with tempfile.TemporaryDirectory() as folder:
                downloads = self.prepare(folder)
                nb.check_inputs(downloads)  # the real config files are the pinned bytes, so the six matching downloads are enough
                for key in ("baseConfig", "fragment"):
                    nb.PINS[key]["sha256"] = "0" * 64
                    with self.assertRaises(ValueError) as caught:
                        nb.check_inputs(downloads)
                    self.assertIn(nb.PINS[key]["file"], str(caught.exception))
                    nb.PINS[key]["sha256"] = saved[key]["sha256"]
        finally:
            for key, value in saved.items():
                nb.PINS[key].clear()
                nb.PINS[key].update(value)

    def test_both_signatures_are_verified_over_the_decompressed_tar_never_the_xz_by_the_pinned_signers(self):
        seen = []
        original = nb.gpg_verify
        nb.gpg_verify = lambda signature, data, key, fingerprints, gpg="gpg": seen.append((Path(signature).name, Path(data).name, Path(key).name, set(fingerprints)))
        try:
            nb.verify_signatures("/d", Path("/w/linux-6.18.35.tar"), Path("/w/llvm-20.1.8-aarch64.tar"))
        finally:
            nb.gpg_verify = original
        self.assertEqual(seen[0], ("linux-6.18.35.tar.sign", "linux-6.18.35.tar", "gregkh.key", {PINS["kernel"]["signerFingerprint"]}))
        self.assertEqual(seen[1], ("llvm-20.1.8-aarch64.tar.sign", "llvm-20.1.8-aarch64.tar", "nathan.key", {PINS["toolchain"]["signerFingerprint"], PINS["toolchain"]["primaryFingerprint"]}))


class DigestTests(unittest.TestCase):
    def test_a_file_that_is_not_the_pinned_bytes_is_refused_by_name(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "x.bin"
            path.write_bytes(b"abc")
            nb.check_pinned_file(path, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            with self.assertRaises(ValueError) as caught:
                nb.check_pinned_file(path, "0" * 64)
            self.assertIn("x.bin", str(caught.exception))

    def test_a_build_refuses_an_existing_work_or_output_folder_before_touching_anything(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                nb.build(folder, folder, Path(folder) / "out")

    def test_a_build_refuses_downloads_that_are_not_the_pinned_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            downloads = Path(folder) / "d"
            downloads.mkdir()
            for names in nb.ARCHIVES.values():
                for name in names:
                    (downloads / name).write_bytes(b"not the pinned bytes")
            with self.assertRaises(ValueError):
                nb.build(downloads, Path(folder) / "w", Path(folder) / "o")


@unittest.skipUnless(gpg_available(), "gpg is not installed")
class SignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.mkdtemp()
        cls.home = Path(cls.folder) / "home"
        cls.home.mkdir(mode=0o700)
        base = ["gpg", "--homedir", str(cls.home), "--batch", "--no-tty"]
        subprocess.run(base + ["--passphrase", "", "--quick-gen-key", "Fixture <fixture@example.invalid>", "ed25519", "sign", "1d"], check=True, capture_output=True)
        listing = subprocess.run(base + ["--with-colons", "--list-keys"], check=True, capture_output=True, text=True).stdout
        cls.fingerprint = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        cls.data = Path(cls.folder) / "data"
        cls.data.write_bytes(b"payload")
        cls.signature = Path(cls.folder) / "data.sig"
        subprocess.run(base + ["--passphrase", "", "--detach-sign", "--output", str(cls.signature), str(cls.data)], check=True, capture_output=True)
        cls.key = Path(cls.folder) / "key.asc"
        subprocess.run(base + ["--export", "--output", str(cls.key)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def test_the_pinned_signer_verifies(self):
        nb.gpg_verify(self.signature, self.data, self.key, {self.fingerprint})

    def test_another_signer_is_refused_even_though_the_signature_is_valid(self):
        with self.assertRaises(ValueError):
            nb.gpg_verify(self.signature, self.data, self.key, {"0" * 40})

    def test_a_signature_over_the_tar_does_not_verify_over_its_xz_compression(self):
        xz = Path(self.folder) / "data.xz"
        xz.write_bytes(subprocess.run(["xz", "-c", str(self.data)], check=True, capture_output=True).stdout)
        with self.assertRaises(ValueError):
            nb.gpg_verify(self.signature, xz, self.key, {self.fingerprint})

    def test_changed_data_is_refused(self):
        other = Path(self.folder) / "other"
        other.write_bytes(b"payload!")
        with self.assertRaises(ValueError):
            nb.gpg_verify(self.signature, other, self.key, {self.fingerprint})

    def test_a_signing_subkey_verifies_under_either_the_subkey_or_the_primary_fingerprint(self):
        home = Path(self.folder) / "home2"
        home.mkdir(mode=0o700)
        base = ["gpg", "--homedir", str(home), "--batch", "--no-tty", "--passphrase", ""]
        subprocess.run(base + ["--quick-gen-key", "Primary <primary@example.invalid>", "ed25519", "cert", "1d"], check=True, capture_output=True)
        listing = subprocess.run(base + ["--with-colons", "--list-keys"], check=True, capture_output=True, text=True).stdout
        primary = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
        subprocess.run(base + ["--quick-add-key", primary, "ed25519", "sign", "1d"], check=True, capture_output=True)
        listing = subprocess.run(base + ["--with-colons", "--list-keys"], check=True, capture_output=True, text=True).stdout
        fingerprints = [line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:")]
        subkey = next(f for f in fingerprints if f != primary)
        signature, key = Path(self.folder) / "sub.sig", Path(self.folder) / "sub.asc"
        subprocess.run(base + ["--detach-sign", "--output", str(signature), str(self.data)], check=True, capture_output=True)
        subprocess.run(base + ["--export", "--output", str(key)], check=True, capture_output=True)
        nb.gpg_verify(signature, self.data, key, {primary})
        nb.gpg_verify(signature, self.data, key, {subkey})
        with self.assertRaises(ValueError):
            nb.gpg_verify(signature, self.data, key, {"1" * 40})

    def test_a_missing_key_is_refused(self):
        empty = Path(self.folder) / "empty.asc"
        empty.write_bytes(b"")
        with self.assertRaises(Exception):
            nb.gpg_verify(self.signature, self.data, empty, {self.fingerprint})


if __name__ == "__main__":
    unittest.main()
