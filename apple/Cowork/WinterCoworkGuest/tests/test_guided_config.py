"""PID 1's trusted config against what the agent SDK's supervisor reads for a GUIDED conversation (agent-sdk #35, main 68e57c64): the `reader` block under
`hostQueryGuidedRuntime` and the per-conversation `guidanceDirectory`.

vectors/sdk-guided-config.json holds the supervisor's own verdict on every case, derived by running its real functions (tests/derive_guided_config_fixture.py).
Offline (CI) this file holds the guest's writer to that file; with WINTER_SDK_CHECKOUT set it also re-derives the file from the SDK checkout and fails on any drift.

Guided stays OFF in the first session (decision D10): nothing here reads a guided artifacts file from the image, and `op_read_runtime_artifacts` refuses profile 2
(hygiene-pinned). The block and the member are written only when PID 1 is handed a guided set AND the image carries a guided artifacts object, and the image
carries neither a reader launcher, a loader nor a guided executable.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_init_modules import InitModuleCase
from test_native import CC, ROOT
import runtime_blocks as rb

sys.path.insert(0, str(ROOT / "bootstrap"))
import guest_bootstrap as gb  # noqa: E402

FIXTURE = json.loads((ROOT / "vectors/sdk-guided-config.json").read_text())
SDK_COMMIT = "68e57c646f23feba09b00c78d05d8c80d6f2962d"

# Cases the supervisor accepts and PID 1 refuses, each for a reason that makes the guest STRICTER and never looser.
UID_OUTSIDE_THE_HOST_RANGE = ("guided: uid in the host range", "guided: uid at the bottom of the supervisor's range", "guided: reader uid 20004", "guided: reader uid 1000", "guided: reader uid 65533")
CANONICAL_ARTIFACT_PATHS = ("guided: relative artifact path", "guided: artifact path with ..", "guided: artifact path with an empty component", "guided: artifact path with a trailing slash",
                            "guided: artifact path with a dot", "guided: artifact path with a space", "guided: artifact path just a slash", "guided: artifact path too long",
                            "guided: dependency path with ..", "guided: dependency path with an empty component", "guided: dependency path with a trailing slash",
                            "guided: dependency path relative", "guided: dependency path too long")


@unittest.skipUnless(CC, "no C compiler")
class GuidedConfigAgreementTests(InitModuleCase):
    def c_accepts(self, profile, text):
        path = self.dir / "block.json"
        path.write_text(text)
        return self.run_tool("runtimeblock", profile, path) == "1"

    def test_the_fixture_file_is_the_one_pinned_in_the_vector_pins(self):
        pins = json.loads((ROOT / "vectors/PINS.json").read_text())["files"]["sdk-guided-config.json"]
        self.assertEqual(hashlib.sha256((ROOT / "vectors/sdk-guided-config.json").read_bytes()).hexdigest(), pins["sha256"])
        self.assertEqual(pins["sdkCommit"], SDK_COMMIT)
        self.assertEqual(pins["sdkCommit"], FIXTURE["sdkCommit"])

    def test_the_fixture_is_the_pinned_supervisors(self):
        self.assertEqual(FIXTURE["sdkCommit"], SDK_COMMIT)
        self.assertRegex(FIXTURE["supervisorSha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(FIXTURE["supervisorPath"], "packages/runtime/src/guest/linux-supervisor.py")
        self.assertGreater(len(FIXTURE["blocks"]), 60)
        self.assertEqual({item["supervisor"] for item in FIXTURE["items"]}, {"keys_ok", "runtime_config", "guided_guidance_required"})

    def test_pid_1_never_accepts_an_object_the_supervisor_refuses(self):
        for case in FIXTURE["blocks"]:
            with self.subTest(case["label"]):
                if self.c_accepts(case["profile"], case["block"]):
                    self.assertEqual(case["supervisor"], "accepted", case["label"])

    def test_pid_1_refuses_what_the_supervisor_accepts_only_where_it_is_deliberately_stricter(self):
        stricter = set(UID_OUTSIDE_THE_HOST_RANGE) | set(CANONICAL_ARTIFACT_PATHS)
        seen = set()
        for case in FIXTURE["blocks"]:
            if case["supervisor"] == "accepted" and not self.c_accepts(case["profile"], case["block"]):
                seen.add(case["label"])
        self.assertEqual(seen, stricter)

    def test_the_objects_the_image_would_carry_are_accepted_by_both(self):
        for label, profile in (("host-query: the image's object", 1), ("guided: the image's object", 2)):
            case = next(c for c in FIXTURE["blocks"] if c["label"] == label)
            self.assertEqual((case["supervisor"], case["how"]), ("accepted", "executed"))
            self.assertTrue(self.c_accepts(profile, case["block"]), label)
            self.assertEqual(case["block"], rb.text(rb.v1_block() if profile == 1 else rb.guided_block()))

    def test_absent_and_empty_are_told_apart_the_way_the_supervisor_tells_them_apart(self):
        by = {c["label"]: c for c in FIXTURE["blocks"]}
        # `dependencies` must be present even when empty
        self.assertEqual(by["guided: the image's object"]["supervisor"], "accepted")
        self.assertIn('"dependencies":[]', by["guided: the image's object"]["block"])
        self.assertEqual(by["guided: reader without dependencies (absent, not empty)"]["supervisor"], "guided_reader_config")
        # `reader` is required for guided and forbidden for host-query, whether absent, empty or full
        self.assertEqual(by["guided: no reader"]["supervisor"], "runtime_artifacts")
        self.assertEqual(by["guided: the host-query object"]["supervisor"], "runtime_artifacts")
        self.assertEqual(by["host-query: with a reader"]["supervisor"], "runtime_artifacts")
        self.assertEqual(by["host-query: with an empty reader"]["supervisor"], "runtime_artifacts")
        for label in ("guided: no reader", "guided: the host-query object", "host-query: with a reader", "host-query: with an empty reader", "guided: reader without dependencies (absent, not empty)"):
            self.assertFalse(self.c_accepts(by[label]["profile"], by[label]["block"]), label)
        # `guidanceDirectory`: required for guided, refused for host-query
        items = {i["label"]: i["supervisor"] for i in FIXTURE["items"]}
        self.assertEqual(items["guided: every key"], "keys_ok")
        self.assertEqual(items["guided: no guidanceDirectory"], "guided_guidance_required")
        self.assertEqual(items["host-query: with guidanceDirectory"], "runtime_config")
        self.assertEqual(items["host-query: its keys"], "keys_ok")

    def test_the_helpers_per_conversation_members_are_exactly_the_keys_the_supervisor_accepts(self):
        vectors = json.loads((ROOT / "vectors/mux-frames.json").read_text())["positive"]
        guided_message = gb.parse_bootstrap_message(next(bytes.fromhex(v["hex"])[16:] for v in vectors if v["name"] == "bootstrap-down-conversations-guided"), "down")
        guided_keys = sorted(gb.supervisor_items(guided_message)[0]["hostQueryGuidedRuntime"])
        plain = json.loads(json.dumps(guided_message))
        plain["profile"] = "host-query-v1"
        plain["conversations"][0]["runtime"]["guided"] = None
        plain_keys = sorted(gb.supervisor_items(plain)[0]["hostQueryRuntime"])
        items = {i["label"]: i for i in FIXTURE["items"]}
        self.assertEqual(guided_keys, items["guided: every key"]["keys"])
        self.assertEqual(plain_keys, items["host-query: its keys"]["keys"])
        self.assertEqual(items["guided: every key"]["supervisor"], "keys_ok")
        self.assertEqual(items["host-query: its keys"]["supervisor"], "keys_ok")
        self.assertEqual(gb.supervisor_items(guided_message)[0]["hostQueryGuidedRuntime"]["guidanceDirectory"], FIXTURE["guidanceDirectory"])

    def test_the_limits_pid_1_enforces_are_the_supervisors(self):
        header = (ROOT / "init/trusted_config.h").read_text()
        self.assertIn("#define WG_READER_DEPENDENCIES_MAX %du" % FIXTURE["readerDependencyLimit"], header)
        self.assertEqual(FIXTURE["readerDependencyLimit"], 32)
        # the reader's per-read view directories live under /run/winter, which the skeleton makes; nothing here creates that parent
        self.assertEqual(FIXTURE["readerViewsRoot"], "/run/winter/instruction-reader-views")

    def test_the_guidance_directory_is_one_path_everywhere(self):
        self.assertEqual(FIXTURE["guidanceDirectory"], "/run/winter/shared-instructions")
        self.assertEqual(gb.GUIDANCE_DIRECTORY, FIXTURE["guidanceDirectory"])
        self.assertEqual(rb.GUIDANCE_DIRECTORY, FIXTURE["guidanceDirectory"])
        header = (ROOT / "init/trusted_config.h").read_text()
        self.assertIn('#define WG_GUIDANCE_DIRECTORY "%s"' % FIXTURE["guidanceDirectory"], header)
        skeleton = (ROOT / "init/skeleton.c").read_text()
        self.assertIn('"winter/shared-instructions", 0755, 0, 0', skeleton)      # the directory PID 1 makes under /run for the tool view and the guidance source

    def test_a_whole_guided_config_is_what_the_supervisor_reads(self):
        """The helper's items and the image's object through the real config builder: the guided key holds the object unchanged, and every conversation member carries
        the guidance directory; the same pieces for host-query carry neither the reader nor the member."""
        vectors = json.loads((ROOT / "vectors/mux-frames.json").read_text())["positive"]
        message = gb.parse_bootstrap_message(next(bytes.fromhex(v["hex"])[16:] for v in vectors if v["name"] == "bootstrap-down-conversations-guided"), "down")
        items = gb.canonical_text(gb.supervisor_items(message))
        base = json.dumps({"artifacts": {"launcher": {"path": "/opt/winter/helpers/linux-tool-compartment", "sha256": "1" * 64}}, "controlDirectory": "/run/winter/control"}, separators=(",", ":"), sort_keys=True)
        for key, block in (("hostQueryGuidedRuntime", rb.guided_block()),):
            code, text = self.config(base, items, key, rb.text(block))
            self.assertEqual(code, 0)
            config = json.loads(text)
            self.assertEqual(config[key], block)
            self.assertEqual(config["conversations"][0][key]["guidanceDirectory"], FIXTURE["guidanceDirectory"])
            self.assertEqual(set(config), {"guestBootId", "conversations", "artifacts", "controlDirectory", key})
            # the supervisor's own verdict on this very object
            verdict = next(c for c in FIXTURE["blocks"] if c["label"] == "guided: the image's object")
            self.assertEqual((json.loads(verdict["block"]), verdict["supervisor"]), (block, "accepted"))
        # an object for the other profile under the guided key is the image's defect, and the builder refuses it (6 = WG_CONFIG_RUNTIME_SHAPE)
        self.assertEqual(self.config(base, items, "hostQueryGuidedRuntime", rb.text(rb.v1_block()))[0], 6)
        self.assertEqual(self.config(base, items, "hostQueryRuntime", rb.text(rb.guided_block()))[0], 6)

    def config(self, base, conversations, key, artifacts):
        paths = [self.dir / name for name in ("base.json", "conv.json", "art.json")]
        for path, text in zip(paths, (base, conversations, artifacts)):
            path.write_text(text)
        code, _, text = self.run_tool("configrt", self.BOOT, paths[0], paths[1], key, paths[2]).partition("|")
        return int(code), text

    BOOT = "66666666-6666-4666-8666-666666666666"

    @unittest.skipUnless(os.environ.get("WINTER_SDK_CHECKOUT"), "set WINTER_SDK_CHECKOUT to an agent SDK clone to re-derive the fixture")
    def test_the_fixture_is_what_the_pinned_supervisor_derives(self):
        checkout = os.environ["WINTER_SDK_CHECKOUT"]
        self.assertEqual(subprocess.check_output(["git", "-C", checkout, "rev-parse", SDK_COMMIT], text=True).strip(), SDK_COMMIT)
        data = subprocess.check_output(["git", "-C", checkout, "show", SDK_COMMIT + ":" + FIXTURE["supervisorPath"]])
        self.assertEqual(hashlib.sha256(data).hexdigest(), FIXTURE["supervisorSha256"])
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "linux-supervisor.py"
            path.write_bytes(data)
            result = subprocess.run([sys.executable, "-I", str(ROOT / "tests/derive_guided_config_fixture.py"), str(path), SDK_COMMIT, str(Path(folder) / "out.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((Path(folder) / "out.json").read_text()), FIXTURE)


if __name__ == "__main__":
    unittest.main()
