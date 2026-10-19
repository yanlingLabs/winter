"""bump_sdk_commit.py moves the SDK pin in all four places or in none."""
import json
import re
import unittest
from pathlib import Path

import bump_sdk_commit as bump

PINS_TEXT = bump.PINS.read_text()
WORKFLOW_TEXT = bump.WORKFLOW.read_text()
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


if __name__ == "__main__":
    unittest.main()
