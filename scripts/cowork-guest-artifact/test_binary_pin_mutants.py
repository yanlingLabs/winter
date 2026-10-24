"""Mutation checks of the guest binary pin rule: an explicit null `binarySha256` is UNPINNED (reported with the built digest, exit 3, never accepted), a set pin that differs is a hard
failure, a missing key is an error. Each mutant is one change to image.py or verify.py in a scratch copy of the artifact scripts and the guest tree, and the tests meant to hold the
rule must fail on it. A survivor means "treat a mismatch as unpinned" (or any other slip of that branch) would go unnoticed."""
import shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

IMAGE = ["test_image.py", "-k", "GuestBuildCheckTests", "-k", "null_init_pin", "-k", "wrongly_typed_init_or_relay", "-k", "relay_in_the_cpio"]
REPORT = ["test_image_build_tools.py", "-k", "both_guest_binary_digests"]

MUTANTS = [
    # a set pin that differs is treated as unpinned (never raises), or an empty / falsy pin is
    ("image.py", "if entry['binarySha256'] is not None and built['binarySha256']!=entry['binarySha256']:raise", "if False and built['binarySha256']!=entry['binarySha256']:raise", IMAGE),
    ("image.py", "if entry['binarySha256'] is not None and built['binarySha256']!=entry['binarySha256']:raise", "if entry['binarySha256'] and built['binarySha256']!=entry['binarySha256']:raise", IMAGE),
    ("image.py", "if entry['binarySha256'] is not None and built['binarySha256']!=entry['binarySha256']:raise", "if entry['binarySha256'] is None and built['binarySha256']!=entry['binarySha256']:raise", IMAGE),
    # a null pin is refused as a mismatch
    ("image.py", "if entry['binarySha256'] is not None and built['binarySha256']!=entry['binarySha256']:raise", "if built['binarySha256']!=entry['binarySha256']:raise", IMAGE),
    # a missing key is let through
    ("image.py", "if 'binarySha256' not in entry:raise", "if False:raise", IMAGE),
    # the unpinned report
    ("image.py", "if entry['binarySha256'] is None]", "if entry['binarySha256'] is not None]", IMAGE),
    ("image.py", "if entry['binarySha256'] is None]", "if not entry['binarySha256']]", IMAGE),
    ("image.py", "' binarySha256 is not pinned (built '+receipt['programs'][name]['binarySha256']+')'", "' binarySha256 is not pinned'", IMAGE),
    ("image.py", "problems=check_expected(receipt,pins['expectedArtifact'])+lock_problems+guest_binary_problems(guest_receipt,pins)", "problems=check_expected(receipt,pins['expectedArtifact'])+lock_problems", IMAGE),
    # the read-back
    ("verify.py", "if not allow_unpinned:raise ValueError('the init binary is not pinned in pins.json (binarySha256 is null)')", "pass", IMAGE),
    ("verify.py", "        pinned_init=init_pins['binarySha256']\n        if pinned_init is None:", "        pinned_init=init_pins['binarySha256']\n        if not pinned_init:", IMAGE),
    ("verify.py", "            pinned_relay=relay_pins['binarySha256']\n            if pinned_relay is None:", "            pinned_relay=relay_pins['binarySha256']\n            if not pinned_relay:", IMAGE),
    ("verify.py", "if not allow_unpinned:raise ValueError('the relay binary is not pinned in pins.json (binarySha256 is null)')", "pass", IMAGE),
    ("verify.py", "init_pinned=False;pinned_init=receipt.get('initSha256')", "pinned_init=receipt.get('initSha256')", IMAGE),
    ("verify.py", "relay_pinned=False;pinned_relay=receipt.get('relaySha256')", "pinned_relay=receipt.get('relaySha256')", IMAGE),
    ("verify.py", "if 'binarySha256' not in init_pins:raise", "if False:raise", IMAGE),
    ("verify.py", "if 'binarySha256' not in relay_pins:raise", "if False:raise", IMAGE),
    ("verify.py", "if not isinstance(pinned_init,str) or not re.fullmatch(r'[0-9a-f]{64}',pinned_init):raise", "if False:raise", IMAGE),
    ("verify.py", "if not isinstance(pinned_relay,str) or not re.fullmatch(r'[0-9a-f]{64}',pinned_relay):raise", "if False:raise", IMAGE),
    ("verify.py", " or found['mode']!=0o555 or found['sha256']!=pinned_relay:raise", " or found['sha256']!=pinned_relay:raise", IMAGE),
    ("verify.py", " or found['mode']!=0o555 or found['sha256']!=pinned_relay:raise", " or found['mode']!=0o555:raise", IMAGE),
    ("verify.py", "if receipt.get('relaySha256')!=pinned_relay:raise", "if False:raise", IMAGE),
    ("verify.py", "(pinned_relay is not None or RELAY_PATH in records or 'relaySha256' in receipt)", "(pinned_relay is not None or 'relaySha256' in receipt)", IMAGE),
    # digests.json
    ("image_build_report.py", '"initPinned": PINS["guest"]["programs"]["init"]["binarySha256"] == receipt["initSha256"]', '"initPinned": PINS["guest"]["programs"]["init"]["binarySha256"] is not None', REPORT),
    ("image_build_report.py", '"relayPinned": PINS["guest"]["programs"]["winter-guest-relay"]["binarySha256"] == receipt["relaySha256"]', '"relayPinned": PINS["guest"]["programs"]["winter-guest-relay"]["binarySha256"] is not None', REPORT),
    ("image_build_report.py", '"relaySha256": receipt["relaySha256"], ', '', REPORT),
    ("image_build_report.py", 'if digests["image"].get(pinned) is False:', 'if False:', REPORT),
]


def run(mutant):
    name, old, new, select = mutant
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        ignore = shutil.ignore_patterns("__pycache__")
        shutil.copytree(HERE, root / "scripts/cowork-guest-artifact", ignore=ignore)
        shutil.copytree(REPO / "apple/Cowork/WinterCoworkGuest", root / "apple/Cowork/WinterCoworkGuest", ignore=ignore)
        path = root / "scripts/cowork-guest-artifact" / name
        text = path.read_text()
        if old not in text:
            return "STALE"
        path.write_text(text.replace(old, new, 1))
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-m", "unittest", "discover", "-s", str(root / "scripts/cowork-guest-artifact"), "-p", select[0], *select[1:]],
                                capture_output=True, text=True, timeout=300)
        return "KILLED" if result.returncode != 0 else "SURVIVED"


class BinaryPinMutantTests(unittest.TestCase):
    def test_every_mutant_is_caught(self):
        for mutant in MUTANTS:
            with self.subTest(file=mutant[0], old=mutant[1][:60], new=mutant[2][:40]):
                self.assertEqual(run(mutant), "KILLED")


if __name__ == "__main__":
    unittest.main()
