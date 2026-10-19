"""The stand-in image must not leak into the production image: static properties of the sources, the build and the pins. Reads files and runs the C preprocessor only."""
import importlib.util
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_native import CC, ROOT

REPO = ROOT.parents[2]
ARTIFACT = REPO / "scripts/cowork-guest-artifact"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load(ROOT / "build.py", "guest_build")
PINS = json.loads((ARTIFACT / "pins.json").read_text())
STANDIN_SOURCES = {"init/standin.c", "init/standin.h", "init/standin_linux.c", "init/standin_linux.h"}


def production_sources():
    return sorted(p for p in ROOT.rglob("*") if p.suffix in (".c", ".h") and "tests" not in p.parts and p.relative_to(ROOT).as_posix() not in STANDIN_SOURCES)


class ProductionStaysClean(unittest.TestCase):
    def test_the_production_programs_do_not_include_any_stand_in_source(self):
        for name, sources in BUILD.PROGRAMS.items():
            self.assertFalse(STANDIN_SOURCES & set(sources), name)
        self.assertEqual(sorted(BUILD.PROGRAMS), ["init", "winter-guest-relay"])
        self.assertEqual(sorted(PINS["guest"]["programs"]), ["init", "winter-guest-relay"])
        self.assertEqual(sorted(PINS["guest"]["scripts"]), ["guest_bootstrap.py"])

    def test_the_stand_in_program_is_the_production_init_plus_exactly_two_files_built_with_one_define(self):
        self.assertEqual(sorted(BUILD.STANDIN_PROGRAMS), ["init-standin"])
        self.assertEqual(BUILD.STANDIN_PROGRAMS["init-standin"], BUILD.PROGRAMS["init"] + ["init/standin.c", "init/standin_linux.c"])
        self.assertEqual(BUILD.STANDIN_FLAGS, ["-DWG_STANDIN=1"])
        self.assertEqual(sorted(BUILD.STANDIN_SCRIPTS), ["profile.json", "standin_prepare.py"])
        self.assertNotIn("standin_prepare.py", PINS["guest"]["scripts"])

    def test_no_production_source_names_the_provider_socket_or_the_stand_in_except_the_one_hooks_header(self):
        for path in production_sources():
            text = path.read_text()
            relative = path.relative_to(ROOT).as_posix()
            self.assertNotIn("provider.sock", text, relative)
            if relative in ("init/standin_hooks.h", "init/init_linux.c"):
                continue
            self.assertNotRegex(text.lower(), r"stand-?in", relative)

    def test_init_linux_c_reaches_the_stand_in_only_through_the_hooks_header_and_its_macros(self):
        text = (ROOT / "init/init_linux.c").read_text()
        self.assertIn('#include "standin_hooks.h"', text)
        self.assertNotIn("wg_standin_", text)
        self.assertNotIn("standin.h", text.replace("standin_hooks.h", ""))
        self.assertNotIn("WG_STANDIN\n", text)
        self.assertEqual(sorted(set(re.findall(r"WG_STANDIN_[A-Z_]+", text))), ["WG_STANDIN_CHILD", "WG_STANDIN_INIT", "WG_STANDIN_NOTE_SET", "WG_STANDIN_READY", "WG_STANDIN_STOP", "WG_STANDIN_TICK", "WG_STANDIN_TIMEOUT"])

    @unittest.skipUnless(CC, "no C compiler")
    def test_without_the_define_every_hook_preprocesses_to_nothing(self):
        text = (ROOT / "init/init_linux.c").read_text()
        calls = sorted(set(re.findall(r"WG_STANDIN_[A-Z_]+\([^;]*\);", text)))
        self.assertEqual(len(calls), 7)
        with tempfile.TemporaryDirectory() as folder:
            probe = Path(folder) / "probe.c"
            probe.write_text('#include "standin_hooks.h"\nint timeout = 5;\nvoid f(void) {\n' + "\n".join(calls).replace("(set)", "(0)") + "\n}\n")
            result = subprocess.run([CC, "-E", "-P", "-I", str(ROOT / "init"), str(probe)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        body = result.stdout
        self.assertNotIn("wg_standin", body)
        self.assertEqual(body.count("((void)0);"), 7)

    @unittest.skipUnless(CC, "no C compiler")
    def test_with_the_define_the_hooks_call_the_stand_in(self):
        with tempfile.TemporaryDirectory() as folder:
            probe = Path(folder) / "probe.c"
            probe.write_text('#include "standin_hooks.h"\nint timeout = 5;\nvoid f(void) { WG_STANDIN_READY(); WG_STANDIN_TIMEOUT(timeout); }\n')
            result = subprocess.run([CC, "-E", "-P", "-DWG_STANDIN=1", "-I", str(ROOT / "init"), str(probe)], capture_output=True, text=True)
        self.assertTrue("wg_standin_hook_ready();" in result.stdout and "((timeout) = wg_standin_hook_timeout(timeout))" in result.stdout, "the hooks did not expand to calls")

    def test_the_image_builder_and_the_verifier_know_nothing_of_the_stand_in(self):
        for name in ("image.py", "verify.py", "packages.py"):
            self.assertNotRegex((ARTIFACT / name).read_text().lower(), r"stand-?in", name)
        text = (ARTIFACT / "image.py").read_text()
        self.assertIn("def refuse_provider_bridge(tree):", text)          # unconditional: no parameter, no switch
        self.assertEqual(text.count("refuse_provider_bridge(tree)"), 2)     # the definition and the one call

    def test_the_stand_in_build_cannot_write_the_production_pins(self):
        text = (ROOT / "build.py").read_text()
        self.assertIn('if args.profile == "standin" and args.update_pins:', text)
        self.assertIn("the stand-in build never writes the production pins", text)

    def test_the_guided_profile_gate_is_the_same_source_in_the_stand_in(self):
        # init-standin compiles the same init_linux.c, so the profile gate that keeps guided off is the production one
        self.assertIn("if (profile != 1) return -1;", (ROOT / "init/init_linux.c").read_text())

    def test_the_worker_uid_is_outside_the_host_range_and_the_stand_in_serves_only_the_host_query_profile(self):
        standin = json.loads((ARTIFACT / "standin-pins.json").read_text())
        profile = json.loads((ROOT / "standin/profile.json").read_text())
        self.assertEqual(standin["workerUid"], profile["workerUid"])
        self.assertGreater(profile["workerUid"], 65533)
        self.assertIn("set->profile != 1", (ROOT / "init/standin.c").read_text())


if __name__ == "__main__":
    unittest.main()
