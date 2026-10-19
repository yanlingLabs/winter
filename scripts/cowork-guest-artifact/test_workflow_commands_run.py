"""Every python3 command the one-run image workflow runs must start. The run has ONE attempt, and `python3 -I` leaves a script's own directory off sys.path, so a script that imports a
sibling module fails with ModuleNotFoundError only when it is run (after the kernel builds). This test runs each such script with --help the way the workflow does, from an empty
temporary directory, with a minimal environment, and checks that every script which imports a sibling module puts its own directory on sys.path first."""
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
WORKFLOW = (REPO / ".github/workflows/cowork-guest-image-build.yml").read_text()
INSERT = "sys.path.insert(0, str(Path(__file__).resolve().parent))"


def workflow_scripts():
    return sorted(set(re.findall(r"python3 -I -S -B (scripts/cowork-guest-artifact/[\w./-]+\.py)", WORKFLOW)))


def run_help(script, *prefix):
    with tempfile.TemporaryDirectory() as empty:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"}
        return subprocess.run([sys.executable, "-I", "-S", "-B", str(REPO / script), *prefix, "--help"], cwd=empty, env=env, capture_output=True, text=True, timeout=60)


class WorkflowCommandsRun(unittest.TestCase):
    def test_the_workflow_runs_the_six_reviewed_scripts_and_no_others(self):
        self.assertEqual(workflow_scripts(), sorted(f"scripts/cowork-guest-artifact/{name}" for name in
                         ("unpack_bun.py", "kernel/native_build.py", "packages.py", "image.py", "verify.py", "image_build_report.py")))

    def test_every_script_the_workflow_runs_starts_under_dash_i_dash_s_dash_b_from_an_empty_directory(self):
        for script in workflow_scripts():
            result = run_help(script)
            self.assertEqual(result.returncode, 0, f"{script}: {result.stderr[-400:]}")
            self.assertNotIn("ModuleNotFoundError", result.stderr, script)
            self.assertNotIn("ImportError", result.stderr, script)

    def test_every_subcommand_the_workflow_uses_starts_too(self):
        for sub in ("report", "collect", "assert"):
            result = run_help("scripts/cowork-guest-artifact/image_build_report.py", sub)
            self.assertEqual(result.returncode, 0, f"{sub}: {result.stderr[-400:]}")

    def test_a_script_that_imports_a_sibling_module_puts_its_own_directory_on_sys_path_first(self):
        for script in workflow_scripts():
            text = (REPO / script).read_text()
            siblings = {path.stem for path in (REPO / script).parent.glob("*.py")} - {Path(script).stem}
            for name in sorted(siblings):
                match = re.search(rf"^\s*(?:from|import)\s+{name}\b", text, re.M)
                if match:
                    self.assertIn(INSERT, text, f"{script} imports {name}")
                    self.assertLess(text.index(INSERT), match.start(), f"{script} imports {name} before it fixes sys.path")

    def test_the_lazy_import_in_image_py_is_covered_by_the_same_insert(self):
        text = (HERE / "image.py").read_text()
        self.assertIn("from metrics import finish", text)
        self.assertIn(INSERT, text)
        self.assertLess(text.index(INSERT), text.index("from metrics import finish"))


if __name__ == "__main__":
    unittest.main()
