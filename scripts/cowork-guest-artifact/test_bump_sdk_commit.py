"""bump_sdk_commit.py moves the SDK pin in all four places or in none."""
import json
import re
import unittest
from pathlib import Path

import bump_sdk_commit as bump

PINS_TEXT = bump.PINS.read_text()
WORKFLOW_TEXT = bump.WORKFLOW.read_text()
CLI_TEXT = bump.CLI.read_text()
README_TEXT = bump.README.read_text()
NEW = "a" * 40
SUP = "b" * 64


class BumpTests(unittest.TestCase):
    def test_the_repository_is_consistent_before_any_bump(self):
        pins = json.loads(PINS_TEXT)
        self.assertEqual(pins["sdkCommit"], pins["sdkPin"]["mainAt"])
        self.assertIn(f"AGENT_SDK_HEAD: '{pins['sdkCommit']}'", WORKFLOW_TEXT)

    def test_the_bump_changes_exactly_the_four_constants(self):
        pins_text, workflow_text = bump.bump(PINS_TEXT, WORKFLOW_TEXT, NEW, SUP)
        before, after = json.loads(PINS_TEXT), json.loads(pins_text)
        self.assertEqual((after["sdkCommit"], after["sdkPin"]["mainAt"], after["sdkPin"]["supervisorSha256"]), (NEW, NEW, SUP))
        for key in ("sdkCommit",):
            before.pop(key), after.pop(key)
        for key in ("mainAt", "supervisorSha256"):
            before["sdkPin"].pop(key), after["sdkPin"].pop(key)
        self.assertEqual(before, after)                                    # expectedArtifact and everything else untouched
        changed = [(a, b) for a, b in zip(PINS_TEXT.splitlines(), pins_text.splitlines()) if a != b]
        self.assertEqual(len(changed), 3)
        self.assertEqual(len(PINS_TEXT.splitlines()), len(pins_text.splitlines()))
        diff = [(a, b) for a, b in zip(WORKFLOW_TEXT.splitlines(), workflow_text.splitlines()) if a != b]
        self.assertEqual(len(diff), 1)
        self.assertEqual(diff[0][1], f"  AGENT_SDK_HEAD: '{NEW}'")

    def test_every_malformed_input_is_refused_and_nothing_is_returned(self):
        old = json.loads(PINS_TEXT)["sdkCommit"]
        for commit, sup in (("A" * 40, SUP), ("a" * 39, SUP), ("a" * 41, SUP), ("main", SUP), (NEW, "B" * 64), (NEW, "b" * 63), (old, SUP)):
            with self.assertRaises(ValueError, msg=(commit, sup)):
                bump.bump(PINS_TEXT, WORKFLOW_TEXT, commit, sup)

    def test_an_inconsistent_pin_or_a_missing_workflow_constant_is_refused(self):
        pins = json.loads(PINS_TEXT)
        broken = PINS_TEXT.replace(f'"mainAt": "{pins["sdkPin"]["mainAt"]}"', '"mainAt": "' + "c" * 40 + '"')
        with self.assertRaises(ValueError):
            bump.bump(broken, WORKFLOW_TEXT, NEW, SUP)
        with self.assertRaises(ValueError):
            bump.bump(PINS_TEXT, WORKFLOW_TEXT.replace("AGENT_SDK_HEAD", "AGENT_SDK_HEADX"), NEW, SUP)
        with self.assertRaises(ValueError):
            bump.bump(PINS_TEXT, WORKFLOW_TEXT + f"\n  AGENT_SDK_HEAD: '{pins['sdkCommit']}'\n", NEW, SUP)

    def test_a_bumped_pair_is_again_consistent_and_a_second_bump_works(self):
        pins_text, workflow_text = bump.bump(PINS_TEXT, WORKFLOW_TEXT, NEW, SUP)
        again_pins, again_workflow = bump.bump(pins_text, workflow_text, "d" * 40, "e" * 64)
        self.assertEqual(json.loads(again_pins)["sdkCommit"], "d" * 40)
        self.assertEqual(re.findall(r"AGENT_SDK_HEAD: '([0-9a-f]{40})'", again_workflow), ["d" * 40])


class NothingSdkDerivedIsLeftStale(unittest.TestCase):
    LAUNCHER, OWNER = "1" * 64, "2" * 64

    def full(self, pins_text=PINS_TEXT, workflow=WORKFLOW_TEXT, cli=CLI_TEXT, readme=README_TEXT, commit=NEW):
        return bump.bump(pins_text, workflow, commit, SUP, self.LAUNCHER, self.OWNER, cli, readme)

    def test_the_repository_has_no_stale_sdk_derived_pin(self):
        self.assertEqual(bump.sdk_derived_problems(PINS_TEXT, WORKFLOW_TEXT, CLI_TEXT, README_TEXT), [])

    def test_a_full_bump_moves_every_sdk_derived_pin_and_leaves_none_stale(self):
        pins_text, workflow, cli, readme = self.full()
        self.assertEqual(bump.sdk_derived_problems(pins_text, workflow, cli, readme), [])
        pins, old = json.loads(pins_text), json.loads(PINS_TEXT)
        self.assertEqual((pins["runtimeArtifacts"]["launcher"]["sourceSha256"], pins["runtimeArtifacts"]["ownerLibrary"]["sourceSha256"]), (self.LAUNCHER, self.OWNER))
        self.assertEqual(json.loads(cli)["sdkCommit"], NEW)
        self.assertEqual(json.loads(cli)["supervisorSha256"], SUP)
        self.assertIn(f"SDK main at `{NEW[:8]}`", readme)
        self.assertEqual(pins["packageLockSha256"], old["packageLockSha256"])             # the package lock comes from the Debian snapshot pins, not the SDK
        self.assertEqual(pins["expectedArtifact"], old["expectedArtifact"])

    def test_each_stale_leftover_is_detected(self):
        pins_text, workflow, cli, readme = self.full()
        stale = json.loads(PINS_TEXT)["sdkCommit"]
        for label, args in (("cli", (pins_text, workflow, CLI_TEXT, readme)), ("readme", (pins_text, workflow, cli, README_TEXT)),
                            ("workflow", (pins_text, WORKFLOW_TEXT, cli, readme)), ("pins", (PINS_TEXT, workflow, cli, readme))):
            with self.subTest(label):
                self.assertNotEqual(bump.sdk_derived_problems(*args), [])
        self.assertNotIn(stale, pins_text)

    def test_a_bump_without_the_cli_fixture_for_the_pinned_commit_is_refused(self):
        with self.assertRaises(ValueError):
            self.full(cli=CLI_TEXT.replace(json.loads(PINS_TEXT)["sdkCommit"], "9" * 40))
        with self.assertRaises(ValueError):
            self.full(readme="no commit named here")


if __name__ == "__main__":
    unittest.main()
