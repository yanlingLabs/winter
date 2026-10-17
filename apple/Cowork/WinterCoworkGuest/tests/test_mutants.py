"""Mutation checks of the guards that the behavioural tests were written for: each mutant is a one-line change to the real source in a scratch
copy of this tree, and the test that is meant to catch it must fail on the copy. A mutant that survives means a guard lost its test.

The Linux-only mutants (init_linux.c, exercised by test_pid1_linux.py) run only where that suite runs. Two guards are deliberately absent because
they cannot change behaviour: `!S_ISDIR` on a descriptor opened with O_DIRECTORY, and `!S_ISREG` next to the size, mode and link-count checks
(a replacement would need to be a non-regular file of the same size, mode and link count; the open of a FIFO there would block, which the
function's single caller never meets because it created the file itself a moment earlier).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from test_native import CC, ROOT

LINUX = sys.platform.startswith("linux")

# (file, old text, new text, suite) -- suite: a key of SUITES
MUTANTS = [
    ("init/init_linux.c","    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);","    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);","pid1"),
    ("init/init_linux.c","    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);","    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);","pid1"),
    ("init/init_linux.c","if (rc == 0) rc = sys_calls.fchmod_fn(fd, 0700);","if (rc == 0) rc = 0;","pid1"),
    ("init/init_linux.c","int rc = sys_calls.fchown_fn(fd, uid, (gid_t)uid);","int rc = 0;","pid1"),
    ("init/init_linux.c","sys_calls.fchown_fn(fd, uid, (gid_t)uid)","sys_calls.fchown_fn(fd, uid, (gid_t)0)","pid1"),
    ("init/init_linux.c","sys_calls.fchown_fn(fd, uid, (gid_t)uid)","sys_calls.fchown_fn(fd, 0, (gid_t)uid)","pid1"),
    ("init/init_linux.c","sys_calls.fchmod_fn(fd, 0700)","sys_calls.fchmod_fn(fd, 0755)","pid1"),
    ("init/init_linux.c","mkdirat(parent, name, 0700)","mkdirat(parent, name, 0755)","pid1"),
    ("init/init_linux.c","mkdirat(parent, name, 0700)","mkdirat(parent, name, 0)","pid1"),
    ("init/init_linux.c","&& errno != EEXIST) { close(parent); return -1; }","&& 1) { close(parent); return -1; }","pid1"),
    ("init/init_linux.c","st.st_uid != uid ||","0 ||","pid1"),
    ("init/init_linux.c","(st.st_mode & 07777) != 0700)) rc = -1;","0)) rc = -1;","pid1"),
    ("init/init_linux.c","if (rc == 0 && (fstat(fd, &st) != 0 ||","if (rc == 0 && (0 ||","pid1"),
    ("init/init_linux.c","if (sys_calls.fsync_fn(fd) != 0) result = -1;","sys_calls.fsync_fn(fd);","pid1"),
    ("init/init_linux.c","if (fd < 0) { result = -1; continue; }","if (fd < 0) { continue; }","pid1"),
    ("init/init_linux.c","if (!(volumes & (1u << v))) continue;","if (0) continue;","pid1"),
    ("init/init_linux.c","open(v == WG_VOLUME_DATA ? G.data.node : G.environment.node, O_RDONLY | O_CLOEXEC)","open(v == WG_VOLUME_DATA ? G.environment.node : G.data.node, O_RDONLY | O_CLOEXEC)","pid1"),
    ("init/init_linux.c","    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : -1;","    return 0;","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_in_r) == 0 &&","1 &&","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_out_w) == 0 &&","1 &&","pid1"),
    ("init/init_linux.c","set_nonblocking(G.rt_err_w) == 0 ?","1 ?","pid1"),
    ("init/init_linux.c","if (with_ports && runtime_ends_nonblocking() != 0)","if (0)","pid1"),
    ("init/init_linux.c","    release_runtime_ends();\n    G.supervisor = pid;","    G.supervisor = pid;","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_in_r);\n    close_fd(&G.rt_out_w);","    close_fd(&G.rt_out_w);","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_out_w);\n    close_fd(&G.rt_err_w);\n}","    close_fd(&G.rt_err_w);\n}","pid1"),
    ("init/init_linux.c","    close_fd(&G.rt_err_w);\n}","}","pid1"),
    ("init/init_linux.c","    umask(022); ","    ","pid1"),
    ("init/init_linux.c","    signal(SIGPIPE, SIG_DFL); ","    ","pid1"),
    ("init/init_linux.c","    sigprocmask(SIG_SETMASK, &none, NULL);","","pid1"),
    ("init/init_linux.c","        setsid();\n        int sources[4]","        int sources[4]","pid1"),
    ("init/init_linux.c","    close(config_fd);\n    close(stdin_pipe[0]);\n    close(stdout_pipe[1]);\n    release","    close(stdin_pipe[0]);\n    close(stdout_pipe[1]);\n    release","pid1"),
    ("init/trusted_config.c","st.st_nlink != 1 ||","0 ||","config"),
    ("init/trusted_config.c","(st.st_mode & 0777) != 0400 ||","0 ||","config"),
    ("init/trusted_config.c","|| (size_t)st.st_size != length)","|| 0)","config"),
    ("init/trusted_config.c","SYNC_CONFIG(fd) != 0","0","config"),
    ("init/trusted_config.c","SYNC_CONFIG(fd) != 0) { close(fd); unlink(path); return -1; }","SYNC_CONFIG(fd) != 0) { close(fd); return -1; }","config"),
    ("init/trusted_config.c","if (reader < 0) return -1;","if (reader < 0) return -1; if (0)","config"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !out_end_sent", "if (runtime_ready_framed && !out_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !err_end_sent", "if (runtime_ready_framed && !err_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !out_end_sent", "if (runtime_open && !out_end_sent", "relay"),
    ("relay/relay.c", "if (runtime_open && runtime_ready_framed && !err_end_sent", "if (runtime_open && !err_end_sent", "relay"),
    ("relay/relay.c", 'runtime_ready\\"", 19) != NULL', 'runtime_ready\\"", 19) == NULL', "relay"),
    ("relay/relay.c", 'runtime_ready\\"", 19)', 'runtime_ready\\"", 18)', "relay"),
    # contract re-pin round: unixId 1000 to 65533, a workspaceGid that is no uid, nothing from the host before `mounted`, runtime IN flow, guided profile
    ("bootstrap/guest_bootstrap.py", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65533", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65535", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65533", "UNIX_ID_MIN, UNIX_ID_MAX = 999, 65533", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", 'a["workspaceGid"] in (b["runtimeUid"], b["toolUid"])', 'a["workspaceGid"] == b["runtimeUid"]', "bootstrap"),
    ("bootstrap/guest_bootstrap.py", 'a["workspaceGid"] in (b["runtimeUid"], b["toolUid"])', 'a["workspaceGid"] == b["toolUid"]', "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "        if self.channel.has_pending():", "        if False:", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "return waiting[0] > 0", "return waiting[0] >= 0", "bootstrap"),
    ("bootstrap/guest_bootstrap.py", "fcntl.ioctl(self.read_fd, termios.FIONREAD, waiting, True)", "pass", "bootstrap"),
    ("init/boot.c", "uid < WG_UNIX_ID_MIN || uid > WG_UNIX_ID_MAX", "uid < WG_UNIX_ID_MIN || uid > 65535", "cboot"),
    ("init/boot.c", "uid < WG_UNIX_ID_MIN || uid > WG_UNIX_ID_MAX", "uid < 999 || uid > WG_UNIX_ID_MAX", "cboot"),
    ("init/boot.c", "ops->read_runtime_artifacts(ops->ctx, set.profile, runtime_buffer,", "ops->read_runtime_artifacts(ops->ctx, 1, runtime_buffer,", "cboot"),
    ("init/init_linux.c", "    if (profile != 1) return -1;", "    if (profile == 0) return -1;", "hygiene"),
    ("relay/relay.c", "static uint8_t rt_in_storage[4u * 1024u * 1024u];", "static uint8_t rt_in_storage[512u * 1024u];", "flow"),
]

SUITES = {
    "pid1": ("tests", "test_pid1_linux.py", []),
    "config": ("tests", "test_init_modules.py", ["-k", "TrustedConfig"]),
    "relay": ("tests", "test_relay.py", ["-k", "output_written_before_g", "-k", "runtime_ready", "-k", "held_until"]),
    "flow": ("tests", "test_relay.py", ["-k", "runtime_flow"]),
    "cboot": ("tests", "test_init_modules.py", ["-k", "BootStateMachine"]),
    "hygiene": ("tests", "test_hygiene.py", []),
    "bootstrap": ("bootstrap", "test_guest_bootstrap.py", []),
}


def run_mutant(mutant):
    relative, old, new, suite = mutant
    folder = Path(tempfile.mkdtemp(prefix="guest-mutant-"))
    try:
        copy = folder / "g"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("__pycache__"))
        path = copy / relative
        text = path.read_text()
        if old not in text:
            return "STALE"
        path.write_text(text.replace(old, new, 1))
        directory, script, arguments = SUITES[suite]
        result = subprocess.run([sys.executable, "-I", "-S", "-B", "-m", "unittest", "discover", "-s", str(copy / directory), "-p", script, *arguments],
                                capture_output=True, text=True, timeout=900)
        return "KILLED" if result.returncode != 0 else "SURVIVED"
    finally:
        shutil.rmtree(folder, ignore_errors=True)


@unittest.skipUnless(CC, "no C compiler")
class MutantTests(unittest.TestCase):
    def test_every_mutant_is_caught_by_its_suite(self):
        runnable = [m for m in MUTANTS if m[3] != "pid1" or LINUX]
        with ThreadPoolExecutor(4) as pool:
            outcomes = list(pool.map(run_mutant, runnable))
        for mutant, outcome in zip(runnable, outcomes):
            with self.subTest(file=mutant[0], old=mutant[1].strip()[:60], new=mutant[2].strip()[:30]):
                self.assertEqual(outcome, "KILLED")


if __name__ == "__main__":
    unittest.main()
