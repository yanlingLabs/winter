"""Linux-only tests of the parts of /init that the portable tests cannot reach (init_linux.c), run as an ordinary process in a temporary directory.

tests/linux_init_tool.c compiles init_linux.c itself (its `main` renamed) so the real static functions run unchanged: the per-conversation
private directories, the device flush, and the supervisor's fork/exec with its three runtime pipes. It is never PID 1, never in a PID
namespace, and mounts, reboots and opens no real device. The supervisor is replaced by tests/fake_supervisor.c, which reports what it
was handed (command line, environment, signal state, every open descriptor).

Only what needs another user, a mount, a device or the real python3 stays untested here (see docs/research/2026-10-17-cowork-n2-guest-boot.md):
the root-only effect of chown to the runtime uid, the real `sync()`/`reboot`, and the real supervisor's startup.
"""
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path

import subprocess

from test_native import CC, ROOT, build

LINUX = sys.platform.startswith("linux")
INIT = ROOT / "init"
PATH_ENV = "PATH=/usr/sbin:/usr/bin:/sbin:/bin"


@unittest.skipUnless(CC and LINUX, "needs Linux and a C compiler")
class Pid1LinuxTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-pid1-"))
        cls.trusted = cls.folder / "trusted"
        cls.trusted.mkdir(mode=0o700)
        # plain build: a sanitizer runtime may hold descriptors of its own, and this program's whole job is to list the open ones
        cls.fake = cls.folder / "fake-supervisor"
        result = subprocess.run([CC, "-std=c11", "-O1", "-Wall", "-Wextra", "-Werror", "-pedantic", str(ROOT / "tests/fake_supervisor.c"), "-o", str(cls.fake)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        sources = [ROOT / "tests/linux_init_tool.c", INIT / "boot.c", INIT / "discover.c", INIT / "ext4sb.c", INIT / "mounts.c", INIT / "skeleton.c",
                   INIT / "trusted_config.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"]
        cls.tool = build(sources, cls.folder / "linux-init-tool", extra=[f'-DPYTHON_PATH="{cls.fake}"', f'-DTRUSTED_DIR="{cls.trusted}"'])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-pid1-case-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.uid = os.getuid()

    def run_tool(self, *args):
        result = subprocess.run([str(self.tool), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    @staticmethod
    def fields(line):
        return dict(part.split("=", 1) for part in line.split())

    # ---------------------------------------------------------------------------------------------- make_private_dir

    def privdir(self, parent, name, uid=None, chown="log", chmod="real"):
        out = self.fields(self.run_tool("privdir", parent, name, self.uid if uid is None else uid, chown, chmod).strip())
        return {key: int(value) for key, value in out.items()}

    def test_a_new_directory_is_0700_and_owned_through_its_open_descriptor(self):
        result = self.privdir(self.dir, "new")
        self.assertEqual((result["rc"], result["chown"], result["chmod"]), (0, 1, 1))
        self.assertEqual((result["uid"], result["gid"]), (self.uid, self.uid))     # the runtime uid is also its group
        self.assertEqual(result["inode"], os.stat(self.dir / "new").st_ino)         # the chown went to the directory itself
        self.assertEqual(stat.S_IMODE(os.stat(self.dir / "new").st_mode), 0o700)

    def test_a_new_directory_is_created_0700_even_if_the_later_fchmod_cannot_run(self):
        """The mkdirat mode is the only thing standing between creation and the fchmod; with umask 0 it must already be 0700."""
        result = self.privdir(self.dir, "new", chmod="fail")
        self.assertEqual((result["rc"], result["chown"], result["chmod"]), (-1, 1, 1))
        self.assertEqual(stat.S_IMODE(os.stat(self.dir / "new").st_mode), 0o700)

    def test_an_existing_directory_is_adopted_and_made_0700(self):
        (self.dir / "old").mkdir(mode=0o755)
        os.chmod(self.dir / "old", 0o755)
        result = self.privdir(self.dir, "old")
        self.assertEqual(result["rc"], 0)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir / "old").st_mode), 0o700)

    def test_a_failed_chown_or_chmod_is_a_failure_and_chmod_is_not_attempted_after_a_failed_chown(self):
        result = self.privdir(self.dir, "a", chown="fail")
        self.assertEqual((result["rc"], result["chown"], result["chmod"]), (-1, 1, 0))
        result = self.privdir(self.dir, "b", chmod="fail")
        self.assertEqual((result["rc"], result["chmod"]), (-1, 1))

    def test_the_result_is_verified_on_the_descriptor_owner_and_mode(self):
        (self.dir / "wrong-owner").mkdir()
        # the (replaced) fchown "succeeds" but the directory is not owned by the requested uid
        self.assertEqual(self.privdir(self.dir, "wrong-owner", uid=self.uid + 1)["rc"], -1)
        (self.dir / "wrong-mode").mkdir(mode=0o755)
        os.chmod(self.dir / "wrong-mode", 0o755)
        # the (replaced) fchmod "succeeds" and changes nothing
        self.assertEqual(self.privdir(self.dir, "wrong-mode", chmod="noop")["rc"], -1)

    def test_a_planted_symlink_in_the_leaf_is_refused_and_its_target_is_left_alone(self):
        target = self.dir / "target"
        target.mkdir(mode=0o755)
        os.chmod(target, 0o755)
        parent = self.dir / "parent"
        parent.mkdir()
        os.symlink(target, parent / "conv")
        result = self.privdir(parent, "conv")
        self.assertEqual((result["rc"], result["chown"], result["chmod"]), (-1, 0, 0))
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o755)

    def test_a_dangling_symlink_in_the_leaf_is_refused_and_nothing_is_created_behind_it(self):
        parent = self.dir / "parent"
        parent.mkdir()
        os.symlink(self.dir / "nowhere", parent / "conv")
        self.assertEqual(self.privdir(parent, "conv")["rc"], -1)
        self.assertFalse((self.dir / "nowhere").exists())

    def test_a_symlinked_parent_is_refused_and_nothing_is_created_inside_its_target(self):
        real = self.dir / "real"
        real.mkdir()
        os.symlink(real, self.dir / "linked")
        result = self.privdir(self.dir / "linked", "conv")
        self.assertEqual((result["rc"], result["chown"]), (-1, 0))
        self.assertEqual(os.listdir(real), [])

    def test_a_file_a_missing_parent_and_a_parent_that_is_a_file_are_refused(self):
        (self.dir / "file").write_text("x")
        self.assertEqual(self.privdir(self.dir, "file")["rc"], -1)
        self.assertEqual(self.privdir(self.dir / "missing", "conv")["rc"], -1)
        self.assertEqual(self.privdir(self.dir / "file", "conv")["rc"], -1)

    # ---------------------------------------------------------------------------------------------- op_flush_devices

    def flush(self, data, environment, volumes, fsync="log"):
        words = self.run_tool("flush", data, environment, volumes, fsync).split()
        fields = dict(part.split("=", 1) for part in words if "=" in part)
        return int(fields["rc"]), int(fields["fsync"]), [int(x) for x in words if "=" not in x]

    def make_nodes(self):
        data, environment = self.dir / "data", self.dir / "environment"
        data.write_bytes(b"d")
        environment.write_bytes(b"e")
        return data, environment, os.stat(data).st_ino, os.stat(environment).st_ino

    def test_each_selected_volume_is_fsynced_through_its_own_node_and_nothing_else(self):
        data, environment, data_inode, environment_inode = self.make_nodes()
        self.assertEqual(self.flush(data, environment, 0), (0, 0, []))
        self.assertEqual(self.flush(data, environment, 1), (0, 1, [data_inode]))
        self.assertEqual(self.flush(data, environment, 2), (0, 1, [environment_inode]))
        self.assertEqual(self.flush(data, environment, 3), (0, 2, [data_inode, environment_inode]))

    def test_a_node_that_cannot_be_opened_fails_the_flush_but_the_other_volume_is_still_synced(self):
        data, environment, _, environment_inode = self.make_nodes()
        os.unlink(data)
        self.assertEqual(self.flush(data, environment, 3), (-1, 1, [environment_inode]))
        self.assertEqual(self.flush(data, environment, 1), (-1, 0, []))

    def test_a_failed_fsync_fails_the_flush(self):
        data, environment, _, _ = self.make_nodes()
        self.assertEqual(self.flush(data, environment, 1, fsync="fail")[0], -1)
        self.assertEqual(self.flush(data, environment, 3, fsync="fail")[:2], (-1, 2))

    # ---------------------------------------------------------------------------------------------- op_start_supervisor

    def start(self, with_ports):
        try:
            os.unlink(self.trusted / "config.json")
        except FileNotFoundError:
            pass
        text = self.run_tool("startsup", 1 if with_ports else 0)
        lines = text.splitlines()
        self.assertEqual(lines[0], "rc=0", text)
        self.assertEqual(lines[1], "exit:0", text)
        facts = {}
        descriptors = {}
        for line in lines[2:]:
            key, _, value = line.partition(":")
            if key == "fd":
                number, _, rest = value.partition(" ")
                descriptors[int(number)] = self.fields(rest)
            else:
                facts[key] = value
        return facts, descriptors

    def accmode(self, descriptor):
        return int(descriptor["access"])      # 0 = O_RDONLY, 1 = O_WRONLY

    def nonblocking(self, descriptor):
        return descriptor["nonblock"] == "1"

    def common(self, facts):
        self.assertEqual(facts["umask"], "022")
        self.assertEqual(facts["env"], f"{PATH_ENV}|LANG=C|LC_ALL=C")
        self.assertEqual(facts["sigpipe"], "default")
        self.assertEqual(facts["sigmask"], "empty")
        self.assertEqual(facts["session"], "leader")
        self.assertEqual(facts["config"], '{"guestBootId":"x"}')
        # Net change in PID 1's open descriptors: it gains the write end of the supervisor's stdin and the read end of its stdout (+2) and
        # gives up its three runtime ends (-3); the config descriptor and the child's pipe ends must not stay open
        self.assertEqual(facts["parent"], "in=-1 out=-1 err=-1 closed=1 added=-1")
        self.assertEqual(facts["eof"], "out=1 err=1 input_reader_gone=1")

    def test_the_supervisor_gets_the_config_and_the_three_runtime_pipes_as_descriptors_3_to_6_and_nothing_else(self):
        facts, descriptors = self.start(True)
        self.common(facts)
        self.assertEqual(facts["argv"], "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3|--runtime-ports-fds|4,5,6")
        self.assertEqual(sorted(descriptors), [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual((descriptors[0]["kind"], descriptors[1]["kind"], descriptors[2]["kind"]), ("fifo", "fifo", "chr"))
        config = descriptors[3]
        self.assertEqual((config["kind"], config["mode"], config["nlink"], self.accmode(config)), ("reg", "400", "1", 0))
        # the runtime pipes: input is the read end, stdout and stderr the write ends, all three non-blocking and not close-on-exec
        self.assertEqual([(descriptors[n]["kind"], self.accmode(descriptors[n]), self.nonblocking(descriptors[n]), descriptors[n]["cloexec"]) for n in (4, 5, 6)],
                         [("fifo", 0, True, "0"), ("fifo", 1, True, "0"), ("fifo", 1, True, "0")])
        for n in (3, 4, 5, 6):
            self.assertEqual(descriptors[n]["cloexec"], "0")
        self.assertFalse(self.nonblocking(descriptors[0]) or self.nonblocking(descriptors[1]))   # its own stdin/stdout stay blocking

    def test_without_a_host_query_conversation_only_the_config_descriptor_is_passed(self):
        facts, descriptors = self.start(False)
        self.common(facts)
        self.assertEqual(facts["argv"], "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3")
        self.assertEqual(sorted(descriptors), [0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
