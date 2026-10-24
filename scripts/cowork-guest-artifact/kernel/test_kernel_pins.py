"""Static checks of the kernel pin file. Builds nothing, boots nothing, needs no network."""
import hashlib
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_config(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        if line.startswith("CONFIG_") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
        elif line.startswith("# CONFIG_") and line.endswith(" is not set"):
            values[line[2:-len(" is not set")]] = "n"
    return values


def effective_config():
    values = parse_config(HERE / PINS["baseConfig"]["file"])
    values.update(parse_config(HERE / PINS["fragment"]["file"]))
    return values


class KernelPinTests(unittest.TestCase):
    def test_it_is_built_and_reproduced_but_never_booted_and_claims_nothing_else(self):
        self.assertEqual(PINS["status"], "built-reproduced-unbooted")
        self.assertFalse(PINS["bootVerified"])
        for key in ("Image", "vmlinux", "resolvedConfig"):
            self.assertRegex(PINS["expectedOutputs"][key], r"^[0-9a-f]{64}$")

    def test_the_base_config_and_fragment_are_the_pinned_bytes(self):
        self.assertEqual(sha(HERE / PINS["baseConfig"]["file"]), PINS["baseConfig"]["sha256"])
        self.assertEqual(sha(HERE / PINS["fragment"]["file"]), PINS["fragment"]["sha256"])

    def test_there_is_no_crypto_fragment_and_the_only_change_is_the_btf_switch(self):
        self.assertIsNone(PINS["cryptoFragment"])
        self.assertEqual(PINS["fragment"]["symbols"], {"CONFIG_DEBUG_INFO_BTF": "n"})
        self.assertEqual(parse_config(HERE / PINS["fragment"]["file"]), {"CONFIG_DEBUG_INFO_BTF": "n"})
        self.assertFalse((HERE / "crypto-candidate.fragment").exists())

    def test_the_base_plus_the_fragment_has_every_required_symbol(self):
        effective = effective_config()
        for symbol, value in PINS["requiredSymbols"].items():
            self.assertEqual(effective.get(symbol, "n"), value, symbol)

    def test_no_disk_encryption_machinery_is_requested(self):
        effective = effective_config()
        for symbol in PINS["mustBeAbsentFromTheBuild"]:
            self.assertNotEqual(effective.get(symbol, "n"), "y", symbol)

    def test_the_fragment_actually_changes_the_base(self):
        base = parse_config(HERE / PINS["baseConfig"]["file"])
        self.assertEqual(base["CONFIG_DEBUG_INFO_BTF"], "y")
        self.assertEqual(effective_config()["CONFIG_DEBUG_INFO_BTF"], "n")

    def test_source_and_toolchain_are_digest_pinned(self):
        for section, key in (("kernel", "sha256"), ("toolchain", "sha256"), ("toolchain", "signatureSha256"), ("toolchain", "publicKeySha256"),
                             ("kernel", "signatureSha256"), ("kernel", "publicKeySha256")):
            self.assertRegex(PINS[section][key], r"^[0-9a-f]{64}$", f"{section}.{key}")
        self.assertRegex(PINS["kernel"]["signerFingerprint"], r"^[0-9A-F]{40}$")
        self.assertTrue(PINS["kernel"]["url"].startswith("https://cdn.kernel.org/"))
        self.assertEqual(PINS["kernel"]["version"], "6.18.35")
        self.assertEqual(PINS["toolchain"]["version"], "LLVM-20.1.8")

    def test_the_builder_is_an_immutable_image_and_its_files_are_digest_pinned(self):
        self.assertRegex(PINS["builder"]["imageId"], r"^sha256:[0-9a-f]{64}$")
        self.assertRegex(PINS["builder"]["baseManifest"], r"^sha256:[0-9a-f]{64}$")
        self.assertRegex(PINS["builderSource"]["commit"], r"^[0-9a-f]{40}$")
        self.assertGreaterEqual(len(PINS["builderSource"]["files"]), 10)
        for name, digest in PINS["builderSource"]["files"].items():
            self.assertRegex(digest, r"^[0-9a-f]{64}$", name)
        self.assertEqual(PINS["builderSource"]["files"]["Builder.Dockerfile"], PINS["builder"]["dockerfileSha256"])

    def test_the_commands_build_the_image_and_vmlinux_with_llvm_offline_with_two_jobs(self):
        commands = PINS["commands"]
        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0][-1], "olddefconfig")
        self.assertEqual(commands[1][-2:], ["Image", "vmlinux"])
        for command in commands:
            self.assertIn("ARCH=arm64", command)
            self.assertIn("LLVM_IAS=1", command)
            self.assertIn("-j2", command)
            self.assertTrue(any(part.startswith("LLVM=/build/llvm/") for part in command))
        self.assertEqual(PINS["limits"]["network"], "none")

    def test_the_open_environment_values_are_named_not_invented(self):
        self.assertEqual(PINS["environmentOpen"], ["SOURCE_DATE_EPOCH", "KBUILD_BUILD_TIMESTAMP"])
        self.assertNotIn("SOURCE_DATE_EPOCH", PINS["environment"])

    def test_no_machine_specific_path_is_pinned(self):
        text = (HERE / "pins.json").read_text() + (HERE / "RECIPE.md").read_text()
        pieces = ["/Us" + "ers/", "/ho" + "me/", "C:" + "\\\\"]  # assembled so this file does not match itself
        self.assertFalse(re.search("|".join(re.escape(piece) for piece in pieces), text))


if __name__ == "__main__":
    unittest.main()
