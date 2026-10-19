"""The stand-in lifecycle (init/standin.c) against a recording fake, natively. The Linux effects are in test_standin_linux.py."""
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_native import CC, ROOT, build


@unittest.skipUnless(CC, "no C compiler")
class StandinLifecycleTests(unittest.TestCase):
    def test_every_native_case_passes(self):
        folder = Path(tempfile.mkdtemp(prefix="guest-standin-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        binary = build([ROOT / "tests/test_standin.c", ROOT / "init/standin.c"], folder / "test_standin")
        result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=120)
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAIL") or line.startswith("      ")]
        self.assertEqual(failed, [], result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertGreaterEqual(len(re.findall(r"^PASS ", result.stdout, flags=re.M)), 17)


if __name__ == "__main__":
    unittest.main()
