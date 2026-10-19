"""Linux-only tests of init/standin_linux.c: the runtime locator over a fake /proc, the admission message, the prepare step, the descriptor layout handed to the provider worker, and the
refusals of the listener. Run as an ordinary process in a temporary directory; never PID 1. What needs root (the listener's chown to the runtime's group, the worker's privilege drop)
stays for the first boot (gate G1), as docs/research/2026-10-19-n2-standin-image-design.md says."""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_native import CC, ROOT, build

LINUX = sys.platform.startswith("linux")
INIT = ROOT / "init"
EXE = "/opt/winter/runtime/winter-host-query"
COMM = "winter-host-que"


@unittest.skipUnless(CC and LINUX, "needs Linux and a C compiler")
class StandinLinuxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-standin-linux-"))
        cls.tool = build([ROOT / "tests/standin_linux_tool.c", INIT / "standin_linux.c", INIT / "standin.c"], cls.folder / "tool", extra=["-DWG_STANDIN=1"])
        cls.worker = cls.folder / "fake-worker"
        result = subprocess.run([CC, "-std=gnu11", "-O1", "-Wall", "-Wextra", "-Werror", str(ROOT / "tests/fake_worker.c"), "-o", str(cls.worker)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-standin-case-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def run_tool(self, *args):
        result = subprocess.run([str(self.tool), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    # ---- the locator
    def proc_entry(self, pid, uids, exe=None, comm=None):
        entry = self.dir / "proc" / str(pid)
        entry.mkdir(parents=True)
        (entry / "status").write_text("Name:\tx\nUmask:\t0022\nUid:\t" + "\t".join(map(str, uids)) + "\nGid:\t1\t1\t1\t1\n")
        if exe is not None:
            (entry / "exe").symlink_to(exe)
        if comm is not None:
            (entry / "comm").write_text(comm + "\n")

    def scan(self, uid=4242):
        return self.run_tool("scan", self.dir / "proc", uid, EXE, COMM)[0]

    def test_exactly_one_runtime_of_the_uid_is_found_by_its_exe_link(self):
        self.proc_entry(100, [4242] * 4, exe=EXE)
        self.proc_entry(101, [4243] * 4, exe=EXE)           # another uid, same program
        self.proc_entry(102, [4242] * 4, exe="/usr/bin/bash")
        self.assertEqual(self.scan(), "found 100")

    def test_the_process_name_matches_when_the_exe_link_is_unreadable(self):
        self.proc_entry(100, [4242] * 4, comm=COMM)
        self.assertEqual(self.scan(), "found 100")

    def test_no_match_is_none(self):
        self.proc_entry(100, [4242] * 4, exe="/usr/bin/bash", comm="bash")
        self.assertEqual(self.scan(), "none")

    def test_two_candidates_are_ambiguous_not_a_guess(self):
        self.proc_entry(100, [4242] * 4, exe=EXE)
        self.proc_entry(101, [4242] * 4, comm=COMM)
        self.assertEqual(self.scan(), "ambiguous")

    def test_every_one_of_the_four_uids_must_equal_the_runtime_uid(self):
        for position in range(4):
            uids = [4242] * 4
            uids[position] = 0
            shutil.rmtree(self.dir / "proc", ignore_errors=True)
            self.proc_entry(100, uids, exe=EXE)
            self.assertEqual(self.scan(), "none", position)

    def test_pid_one_and_non_numeric_entries_are_never_candidates(self):
        self.proc_entry(1, [4242] * 4, exe=EXE)
        (self.dir / "proc" / "self").mkdir()
        (self.dir / "proc" / "self" / "status").write_text("Uid:\t4242\t4242\t4242\t4242\n")
        self.assertEqual(self.scan(), "none")

    def test_an_unreadable_proc_is_ambiguous(self):
        self.assertEqual(self.run_tool("scan", self.dir / "missing", 4242, EXE, COMM)[0], "ambiguous")

    # ---- the admission message
    def test_the_admission_message_is_one_byte_i_with_exactly_one_descriptor(self):
        lines = self.run_tool("admit")
        self.assertEqual(lines[0], "bytes=1 marker=I fds=1 chardev=1")
        self.assertEqual(lines[1], "closed channel refused")

    # ---- the listener (the happy path needs root: first boot)
    def make_control(self, mode=0o750):
        control = self.dir / "control"
        (control / "sid_1").mkdir(parents=True)
        os.chmod(control / "sid_1", mode)
        return control

    @unittest.skipIf(os.geteuid() == 0, "as root the directory would be root-owned")
    def test_a_control_directory_that_is_not_root_owned_is_refused(self):
        control = self.make_control()
        self.assertEqual(self.run_tool("listener", control, "sid_1", os.getgid())[0], "-1")
        self.assertFalse((control / "sid_1" / "provider.sock").exists())

    def test_a_missing_or_unsafe_session_directory_is_refused(self):
        control = self.make_control()
        for sid in ("sid_missing", "..", ".", "a/b", ""):
            self.assertEqual(self.run_tool("listener", control, sid, 4242)[0], "-1", sid)

    def test_a_symlinked_control_directory_is_not_followed(self):
        control = self.make_control()
        (control / "sid_2").symlink_to(control / "sid_1")
        self.assertEqual(self.run_tool("listener", control, "sid_2", 4242)[0], "-1")

    # ---- prepare
    def test_prepare_writes_the_items_read_only_and_runs_the_script_with_its_fixed_arguments(self):
        python = self.dir / "python"
        python.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\nexit 0\n')
        python.chmod(0o755)
        standin = self.dir / "standin"
        out = self.run_tool("prepare", standin, python, "/opt/p.py", "/opt/profile.json", "sid_1", '[{"a":1}]')
        self.assertEqual(out, ["0"])
        self.assertEqual((standin / "items.json").read_text(), '[{"a":1}]')
        self.assertEqual(stat.S_IMODE((standin / "items.json").stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(standin.stat().st_mode), 0o700)
        args = Path(str(python) + ".args").read_text().splitlines()
        self.assertEqual(args, ["-I", "-S", "-B", "/opt/p.py", "--profile", "/opt/profile.json", "--items", str(standin / "items.json"), "--sid", "sid_1", "--out", str(standin / "sid_1")])

    def test_prepare_fails_when_the_script_fails_or_the_items_file_exists_or_the_id_is_unsafe(self):
        python = self.dir / "python"
        python.write_text("#!/bin/sh\nexit 2\n")
        python.chmod(0o755)
        standin = self.dir / "standin"
        self.assertEqual(self.run_tool("prepare", standin, python, "/p", "/q", "sid_1", "[]"), ["-1"])
        self.assertEqual(self.run_tool("prepare", standin, python, "/p", "/q", "sid_1", "[]"), ["-1"])      # items.json is never overwritten
        self.assertEqual(self.run_tool("prepare", self.dir / "standin2", python, "/p", "/q", "../x", "[]"), ["-1"])

    # ---- the worker
    def start_worker(self):
        standin = self.dir / "standin"
        (standin / "sid_1").mkdir(parents=True)
        (standin / "sid_1" / "metadata.json").write_text("{}")
        library = self.dir / "owner.so"
        library.write_bytes(b"lib")
        log = self.dir / "log"
        lines = self.run_tool("worker", standin, self.worker, library, "sid_1", log, self.dir / "listen.sock")
        return lines, dict(l.split(" ", 1) for l in log.read_text().splitlines() if " " in l and not l.startswith("fd ") and not l.startswith("argv ")), log.read_text().splitlines()

    def test_the_worker_gets_the_fixed_argv_the_fixed_descriptors_and_nothing_else(self):
        lines, _, report = self.start_worker()
        self.assertEqual(lines, ["start 0", "exit 0"])
        argv = [l.split(" ", 2)[2] for l in report if l.startswith("argv ")]
        self.assertEqual(argv[1:], ["--listener-fd", "3", "--admission-fd", "4", "--owner-library-fd", "5", "--metadata-fd", "6"])
        fds = {int(l.split()[1]): l.split()[2:] for l in report if l.startswith("fd ")}
        self.assertEqual(sorted(fds), [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual(fds[0][0], "chardev")
        self.assertEqual(fds[3][0], "listener")
        self.assertEqual(fds[4][0], "seqpacket")
        self.assertEqual(fds[5][0], "file")
        self.assertEqual(fds[6][0], "file")
        self.assertIn("env 0", report)

    def test_the_worker_is_told_the_runtime_by_one_admission_message_and_runs_with_no_new_privileges(self):
        _, _, report = self.start_worker()
        admission = next(l for l in report if l.startswith("admission "))
        self.assertIn("bytes=1 marker=I fds=1", admission)
        self.assertIn("pidfd", admission)
        self.assertIn("nonewprivs 1", report)
        self.assertIn("blocked 0 sigpipe_default 1", report)


if __name__ == "__main__":
    unittest.main()
