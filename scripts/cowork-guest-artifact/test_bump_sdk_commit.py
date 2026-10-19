"""bump_sdk_commit.py moves the SDK pin in every place or in none."""
import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import bump_sdk_commit as bump

PINS_TEXT = bump.PINS.read_text()
WORKFLOW_TEXT = bump.WORKFLOW.read_text()
CLI_TEXT = bump.CLI.read_text()
NEW, SUP = "a" * 40, "b" * 64
SOURCES = {"launcher": "c" * 64, "ownerLibrary": "d" * 64}


def do(pins=PINS_TEXT, workflow=WORKFLOW_TEXT, cli=CLI_TEXT, commit=NEW, sup=SUP, sources=SOURCES):
    return bump.bump(pins, workflow, cli, commit, sup, sources)


class BumpTests(unittest.TestCase):
    def test_the_repository_is_consistent_before_any_bump(self):
        pins, cli = json.loads(PINS_TEXT), json.loads(CLI_TEXT)
        self.assertEqual(pins["sdkCommit"], pins["sdkPin"]["mainAt"])
        self.assertEqual(cli["sdkCommit"], pins["sdkCommit"])
        self.assertEqual(cli["supervisorSha256"], pins["sdkPin"]["supervisorSha256"])
        self.assertIn(f"AGENT_SDK_HEAD: '{pins['sdkCommit']}'", WORKFLOW_TEXT)

    def test_the_bump_changes_exactly_the_derived_constants_and_nothing_else(self):
        before_text = PINS_TEXT
        pins_text, workflow_text, cli_text = do()
        before, after = json.loads(before_text), json.loads(pins_text)
        self.assertEqual((after["sdkCommit"], after["sdkPin"]["mainAt"], after["sdkPin"]["supervisorSha256"]), (NEW, NEW, SUP))
        self.assertEqual({k: v["sourceSha256"] for k, v in after["runtimeArtifacts"].items() if "sourceSha256" in v}, SOURCES)
        for tree in (before, after):
            tree.pop("sdkCommit")
            tree["sdkPin"].pop("mainAt"), tree["sdkPin"].pop("supervisorSha256")
            for key in SOURCES:
                tree["runtimeArtifacts"][key].pop("sourceSha256")
        self.assertEqual(before, after)                                       # expectedArtifact, the binary digests and everything else stay (stale by design)
        self.assertEqual(len(before_text.splitlines()), len(pins_text.splitlines()))
        self.assertEqual(sum(a != b for a, b in zip(before_text.splitlines(), pins_text.splitlines())), 5)
        diff = [(a, b) for a, b in zip(WORKFLOW_TEXT.splitlines(), workflow_text.splitlines()) if a != b]
        self.assertEqual([b for _, b in diff], [f"  AGENT_SDK_HEAD: '{NEW}'"])
        cli = json.loads(cli_text)
        self.assertEqual((cli["sdkCommit"], cli["supervisorSha256"]), (NEW, SUP))
        original = json.loads(CLI_TEXT)
        self.assertEqual(cli["accepted"], original["accepted"])

    def test_an_unchanged_source_digest_is_left_alone(self):
        pins = json.loads(PINS_TEXT)
        same = {key: pins["runtimeArtifacts"][key]["sourceSha256"] for key in SOURCES}
        pins_text, _, _ = do(sources=same)
        self.assertEqual(sum(a != b for a, b in zip(PINS_TEXT.splitlines(), pins_text.splitlines())), 3)

    def test_every_malformed_input_is_refused(self):
        old = json.loads(PINS_TEXT)["sdkCommit"]
        for commit, sup in (("A" * 40, SUP), ("a" * 39, SUP), ("a" * 41, SUP), ("main", SUP), (NEW, "B" * 64), (NEW, "b" * 63), (old, SUP)):
            with self.assertRaises(ValueError, msg=(commit, sup)):
                do(commit=commit, sup=sup)
        for sources in ({"launcher": "c" * 64}, {**SOURCES, "x": "e" * 64}, {**SOURCES, "ownerLibrary": "D" * 64}, {**SOURCES, "ownerLibrary": "d" * 63}):
            with self.assertRaises(ValueError):
                do(sources=sources)

    def test_an_inconsistency_between_the_files_is_refused(self):
        pins, cli = json.loads(PINS_TEXT), json.loads(CLI_TEXT)
        with self.assertRaises(ValueError):
            do(pins=PINS_TEXT.replace(f'"mainAt": "{pins["sdkPin"]["mainAt"]}"', '"mainAt": "' + "c" * 40 + '"'))
        with self.assertRaises(ValueError):
            do(cli=CLI_TEXT.replace(f'"sdkCommit": "{cli["sdkCommit"]}"', '"sdkCommit": "' + "c" * 40 + '"'))
        with self.assertRaises(ValueError):
            do(cli=CLI_TEXT.replace(f'"supervisorSha256": "{cli["supervisorSha256"]}"', '"supervisorSha256": "' + "c" * 64 + '"'))
        with self.assertRaises(ValueError):
            do(workflow=WORKFLOW_TEXT.replace("AGENT_SDK_HEAD", "AGENT_SDK_HEADX"))
        with self.assertRaises(ValueError):
            do(workflow=WORKFLOW_TEXT + f"\n  AGENT_SDK_HEAD: '{pins['sdkCommit']}'\n")

    def test_a_bumped_set_is_again_consistent_and_a_second_bump_works(self):
        pins_text, workflow_text, cli_text = do()
        again = do(pins=pins_text, workflow=workflow_text, cli=cli_text, commit="e" * 40, sup="f" * 64, sources={"launcher": "1" * 64, "ownerLibrary": "2" * 64})
        self.assertEqual(json.loads(again[0])["sdkCommit"], "e" * 40)
        self.assertEqual(re.findall(r"AGENT_SDK_HEAD: '([0-9a-f]{40})'", again[1]), ["e" * 40])
        self.assertEqual(json.loads(again[2])["sdkCommit"], "e" * 40)

    def test_the_command_line_verdicts_check_rejects_a_supervisor_that_changed_its_mind(self):
        supervisor = (
            b"def parse_arguments(argv):\n"
            b"    if argv[1:] == ['--trusted-config-fd', '3']: return (3, None)\n"
            b"    raise SystemExit(2)\n")
        cli = json.dumps({"accepted": [{"argv": ["--trusted-config-fd", "3"], "result": [3, None]}], "refused": [["--bogus"]]})
        self.assertTrue(bump.cli_verdicts_unchanged(cli, supervisor))
        wrong = json.dumps({"accepted": [{"argv": ["--trusted-config-fd", "4"], "result": [4, None]}], "refused": []})
        self.assertFalse(bump.cli_verdicts_unchanged(wrong, supervisor))
        accepts_all = b"def parse_arguments(argv):\n    return (3, None)\n"
        self.assertFalse(bump.cli_verdicts_unchanged(cli, accepts_all))
        self.assertFalse(bump.cli_verdicts_unchanged(json.dumps({"accepted": [{"argv": ["--trusted-config-fd", "3"], "result": [9, None]}], "refused": []}), supervisor))


SUPERVISOR = b"def parse_arguments(argv):\n    if argv[1:] == ['--trusted-config-fd', '3']:\n        return (3, None)\n    raise SystemExit(2)\n"
CLI = json.dumps({"sdkCommit": json.loads(CLI_TEXT)["sdkCommit"], "supervisorSha256": json.loads(CLI_TEXT)["supervisorSha256"],
                  "accepted": [{"argv": ["--trusted-config-fd", "3"], "result": [3, None]}], "refused": [["--bogus"]]}, indent=2) + "\n"


class MainTests(unittest.TestCase):
    """main() against a throwaway git repository standing in for the SDK checkout and copies of the three pin files."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.saved = (bump.PINS, bump.WORKFLOW, bump.CLI)
        bump.PINS, bump.WORKFLOW, bump.CLI = self.dir / "pins.json", self.dir / "workflow.yml", self.dir / "cli.json"
        bump.PINS.write_text(PINS_TEXT)
        bump.WORKFLOW.write_text(WORKFLOW_TEXT)
        bump.CLI.write_text(CLI)
        self.repo = self.dir / "sdk"
        guest = self.repo / "packages/runtime/src/guest"
        guest.mkdir(parents=True)
        (guest / "linux-supervisor.py").write_bytes(SUPERVISOR)
        (guest / "linux-runtime-compartment.c").write_bytes(b"launcher source")
        (guest / "linux-session-owner.c").write_bytes(b"owner source")
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid", "PATH": "/usr/bin:/bin:/opt/homebrew/bin"}
        for command in (["init", "-q"], ["add", "."], ["commit", "-q", "-m", "x"]):
            subprocess.run(["git", "-C", str(self.repo), *command], check=True, env=env, capture_output=True)
        self.commit = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        self.sup = hashlib.sha256(SUPERVISOR).hexdigest()

    def tearDown(self):
        bump.PINS, bump.WORKFLOW, bump.CLI = self.saved
        self.folder.cleanup()

    def snapshot(self):
        return bump.PINS.read_text(), bump.WORKFLOW.read_text(), bump.CLI.read_text()

    def test_main_reads_the_digests_from_the_checkout_and_writes_all_three_files(self):
        self.assertEqual(bump.main([self.commit, "--supervisor-sha256", self.sup, "--sdk", str(self.repo)]), 0)
        pins = json.loads(bump.PINS.read_text())
        self.assertEqual((pins["sdkCommit"], pins["sdkPin"]["supervisorSha256"]), (self.commit, self.sup))
        self.assertEqual(pins["runtimeArtifacts"]["launcher"]["sourceSha256"], hashlib.sha256(b"launcher source").hexdigest())
        self.assertEqual(pins["runtimeArtifacts"]["ownerLibrary"]["sourceSha256"], hashlib.sha256(b"owner source").hexdigest())
        self.assertIn(f"AGENT_SDK_HEAD: '{self.commit}'", bump.WORKFLOW.read_text())
        self.assertEqual(json.loads(bump.CLI.read_text())["sdkCommit"], self.commit)

    def test_a_supervisor_digest_that_is_not_the_one_at_that_commit_changes_nothing(self):
        before = self.snapshot()
        with self.assertRaises(SystemExit):
            bump.main([self.commit, "--supervisor-sha256", "0" * 64, "--sdk", str(self.repo)])
        self.assertEqual(self.snapshot(), before)

    def test_a_supervisor_whose_command_line_verdicts_changed_changes_nothing(self):
        cli = json.loads(bump.CLI.read_text())
        cli["accepted"] = [{"argv": ["--trusted-config-fd", "4"], "result": [4, None]}]
        bump.CLI.write_text(json.dumps(cli, indent=2) + "\n")
        before = self.snapshot()
        with self.assertRaises(SystemExit):
            bump.main([self.commit, "--supervisor-sha256", self.sup, "--sdk", str(self.repo)])
        self.assertEqual(self.snapshot(), before)

    def test_a_commit_the_checkout_does_not_have_changes_nothing(self):
        before = self.snapshot()
        with self.assertRaises(subprocess.CalledProcessError):
            bump.main(["1" * 40, "--supervisor-sha256", self.sup, "--sdk", str(self.repo)])
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
