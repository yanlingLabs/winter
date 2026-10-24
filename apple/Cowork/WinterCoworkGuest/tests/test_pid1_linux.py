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


@unittest.skipUnless(CC and LINUX, "needs Linux and a C compiler")
class FileChannelPid1Tests(unittest.TestCase):
    """init_linux.c built with WG_FILE_CHANNEL_V1 (an image that declares `file-channel-v1`): the two FIFOs, the supervisor's last two arguments and descriptors, the
    hard-link sysctl, the data device and the data roots. Same driver as Pid1LinuxTests; the production build has none of this (test_hygiene.py)."""

    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-pid1-fc-"))
        cls.trusted = cls.folder / "trusted"
        cls.trusted.mkdir(mode=0o700)
        cls.workspace = cls.folder / "workspace"
        cls.workspace.mkdir()
        cls.sysctl = cls.folder / "protected_hardlinks"
        cls.conversations_store = cls.folder / "conversations-store"
        cls.conversations_run = cls.folder / "conversations-run"
        cls.conversations_store.mkdir()
        cls.conversations_run.mkdir()
        cls.fake = cls.folder / "fake-supervisor"
        result = subprocess.run([CC, "-std=c11", "-O1", "-Wall", "-Wextra", "-Werror", "-pedantic", str(ROOT / "tests/fake_supervisor.c"), "-o", str(cls.fake)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        sources = [ROOT / "tests/linux_init_tool.c", INIT / "boot.c", INIT / "discover.c", INIT / "ext4sb.c", INIT / "mounts.c", INIT / "skeleton.c",
                   INIT / "trusted_config.c", INIT / "dataroots.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"]
        cls.tool = build(sources, cls.folder / "linux-init-tool", extra=["-DWG_FILE_CHANNEL_V1", f'-DPYTHON_PATH="{cls.fake}"', f'-DTRUSTED_DIR="{cls.trusted}"',
                                                                         f'-DWG_WORKSPACE_PATH="{cls.workspace}"', f'-DWORKSPACE_CONVERSATIONS="{cls.conversations_store}"',
                                                                         f'-DRUN_CONVERSATIONS="{cls.conversations_run}"'])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-pid1-fc-case-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        # The workspace is shared by the whole class, and the plan view's record of epochs is the disk itself: an epoch an earlier test made (rightly) makes every lower one stale, so each
        # test starts with no plan folder, as a fresh data volume would.
        shutil.rmtree(self.workspace / "plan", ignore_errors=True)

    def run_tool(self, *args):
        result = subprocess.run([str(self.tool), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    @staticmethod
    def fields(line):
        return dict(part.split("=", 1) for part in line.split())

    # ---- the FIFOs

    def test_the_two_fifos_are_nonblocking_owned_by_pid_1_single_link_and_close_on_exec(self):
        lines = [line for line in self.run_tool("fifos").splitlines() if line.startswith("end:")]
        self.assertEqual(len(lines), 4)
        for index, line in enumerate(lines):
            fields = self.fields(line.split(" ", 1)[1])
            self.assertEqual((fields["fifo"], fields["owner"], fields["nlink"], fields["nonblock"], fields["cloexec"]), ("1", "1", "1", "1", "1"), line)
            self.assertEqual(fields["access"], str(index % 2))          # each pipe: read end first, write end second

    def fifook(self, path, flags):
        return self.run_tool("fifook", path, flags).strip()

    def test_the_supervisors_file_descriptor_check_refuses_what_is_not_a_nonblocking_single_link_fifo(self):
        fifo = self.dir / "fifo"
        os.mkfifo(fifo, 0o600)
        self.assertEqual(self.fifook(fifo, os.O_RDWR | os.O_NONBLOCK), "1")
        self.assertEqual(self.fifook(fifo, os.O_RDWR), "0")                           # blocking
        regular = self.dir / "regular"
        regular.write_text("x")
        self.assertEqual(self.fifook(regular, os.O_RDWR | os.O_NONBLOCK), "0")        # not a FIFO
        os.link(fifo, self.dir / "second-name")
        self.assertEqual(self.fifook(fifo, os.O_RDWR | os.O_NONBLOCK), "0")           # two links

    # ---- the supervisor's descriptors and last two arguments

    def start(self, flags):
        try:
            os.unlink(self.trusted / "config.json")
        except FileNotFoundError:
            pass
        text = self.run_tool("startsup", flags)
        lines = text.splitlines()
        self.assertEqual(lines[0], "rc=0", text)
        self.assertEqual(lines[1], "exit:0", text)
        facts, descriptors = {}, {}
        for line in lines[2:]:
            key, _, value = line.partition(":")
            if key == "fd":
                number, _, rest = value.partition(" ")
                descriptors[int(number)] = self.fields(rest)
            else:
                facts[key] = value
        return facts, descriptors

    def check_parent(self, facts):
        # PID 1 keeps none of the supervisor's ends: after the fork the file ends are closed here whether or not the supervisor was given them, so a left-over copy cannot keep a
        # FIFO open after the supervisor and the relay are gone.
        self.assertEqual(facts["parentfile"], "in=-1 out=-1 closed=1")
        self.assertEqual(facts["fileeof"], "out=1 in_reader_gone=1")
        self.assertEqual(facts["parent"], "in=-1 out=-1 err=-1 closed=1 added=-3")

    def test_with_runtime_ports_the_file_channel_is_descriptors_7_and_8_and_the_last_two_arguments(self):
        facts, descriptors = self.start(3)
        self.check_parent(facts)
        self.assertEqual(facts["argv"], "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3|--runtime-ports-fds|4,5,6|--file-channel-fds|7,8")
        self.assertEqual(sorted(descriptors), [0, 1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual([(descriptors[n]["kind"], int(descriptors[n]["access"]), descriptors[n]["nonblock"], descriptors[n]["cloexec"], descriptors[n]["nlink"]) for n in (7, 8)],
                         [("fifo", 0, "1", "0", "1"), ("fifo", 1, "1", "0", "1")])           # IN is the read end, OUT the write end

    def test_without_runtime_ports_the_file_channel_is_descriptors_4_and_5(self):
        facts, descriptors = self.start(2)
        self.check_parent(facts)
        self.assertEqual(facts["argv"], "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3|--file-channel-fds|4,5")
        self.assertEqual(sorted(descriptors), [0, 1, 2, 3, 4, 5])
        self.assertEqual([(descriptors[n]["kind"], int(descriptors[n]["access"]), descriptors[n]["nonblock"]) for n in (4, 5)], [("fifo", 0, "1"), ("fifo", 1, "1")])

    def test_without_a_browse_uid_the_supervisor_gets_no_file_descriptors_and_no_file_arguments(self):
        for flags, argv, count in ((1, "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3|--runtime-ports-fds|4,5,6", 7),
                                   (0, "-I|-S|-B|/opt/winter/libexec/linux-supervisor.py|--trusted-config-fd|3", 4)):
            with self.subTest(flags=flags):
                facts, descriptors = self.start(flags)
                self.check_parent(facts)
                self.assertEqual(facts["argv"], argv)
                self.assertEqual(sorted(descriptors), list(range(count)))

    def test_a_supervisor_end_that_is_not_a_nonblocking_fifo_stops_the_start_before_anything_runs(self):
        try:
            os.unlink(self.trusted / "config.json")
        except FileNotFoundError:
            pass
        self.assertEqual(self.run_tool("startsup", 2, "blocking").splitlines()[0], "rc=-1")
        try:
            os.unlink(self.trusted / "config.json")
        except FileNotFoundError:
            pass
        self.assertEqual(self.run_tool("startsup", 2).splitlines()[0], "rc=0")

    # ---- the hard-link sysctl

    def hardlinks(self, path):
        return self.run_tool("hardlinks", path).strip()

    def test_protected_hardlinks_is_written_as_1(self):
        self.sysctl.write_text("0\n")
        os.chmod(self.sysctl, 0o644)
        self.assertEqual(self.hardlinks(self.sysctl), "rc=0")
        self.assertEqual(self.sysctl.read_text(), "1\n")

    def test_a_sysctl_that_cannot_be_written_or_is_a_link_is_a_failure(self):
        self.assertEqual(self.hardlinks("/dev/full"), "rc=-1")                         # the open works and the write fails: only the result of the write says so
        self.assertEqual(self.hardlinks("/dev/null"), "rc=0")
        self.assertEqual(self.hardlinks(self.dir / "missing"), "rc=-1")
        target = self.dir / "target"
        target.write_text("0\n")
        link = self.dir / "link"
        os.symlink(target, link)
        self.assertEqual(self.hardlinks(link), "rc=-1")                                # O_NOFOLLOW: a link is never followed
        self.assertEqual(target.read_text(), "0\n")
        if os.getuid() != 0:
            readonly = self.dir / "readonly"
            readonly.write_text("0\n")
            os.chmod(readonly, 0o444)
            self.assertEqual(self.hardlinks(readonly), "rc=-1")

    # ---- the data device and the data roots

    def test_the_data_device_is_the_st_dev_of_the_workspace(self):
        out = self.fields(self.run_tool("datadev").strip())
        self.assertEqual((out["rc"], int(out["device"])), ("0", os.stat(self.workspace).st_dev))

    def test_a_workspace_that_is_missing_or_not_a_directory_has_no_device(self):
        moved = self.folder_moved = self.workspace.with_name("workspace-away")
        self.workspace.rename(moved)
        try:
            self.assertEqual(self.fields(self.run_tool("datadev").strip())["rc"], "-1")
            self.workspace.write_text("file")
            self.assertEqual(self.fields(self.run_tool("datadev").strip())["rc"], "-1")
            self.workspace.unlink()
        finally:
            moved.rename(self.workspace)

    def roots(self, browse, *sources):
        return self.fields(self.run_tool("roots", browse, os.getgid(), *sources).strip())["rc"]

    def test_the_conversation_directories_are_made_and_the_data_roots_only_for_a_workspace_with_a_browse_uid(self):
        """op_prepare_conversation_dirs itself, with the paths of this test: the private per-conversation directories always, the data roots when there is a browse uid."""
        self.assertEqual(self.roots(0, "/workspace/repos/off"), "0")
        self.assertTrue((self.conversations_store / "s1").is_dir() and (self.conversations_run / "s1").is_dir())
        self.assertFalse((self.workspace / "repos/off").exists())
        self.assertEqual(self.roots(40001, "/workspace/repos/on"), "0")
        mode = stat.S_IMODE(os.stat(self.workspace / "repos/on").st_mode)
        self.assertEqual((mode, os.stat(self.workspace / "repos/on").st_gid), (0o2770, os.getgid()))
        self.assertEqual(self.roots(40001, "/etc/passwd"), "-1")

    def test_the_plan_view_is_made_by_pid_1_for_its_own_conversation_and_an_earlier_epoch_never_again(self):
        """Through op_prepare_conversation_dirs (the conversation here is `s1`): /workspace/plan/s1/<epoch> (the conversation's tool uid, 0700) below /workspace/plan and /workspace/plan/s1 (root, 0711); a stale epoch refused.
        The tool does not run as root, so what the file system keeps is the invoking user's; the owner PID 1 asks for (41001) is covered by test_filechannel's request log."""
        self.assertEqual(self.roots(40001, "/workspace/plan/s1/3"), "0")
        view = self.workspace / "plan/s1/3"
        self.assertEqual(stat.S_IMODE(view.stat().st_mode), 0o700)
        self.assertEqual((stat.S_IMODE((self.workspace / "plan").stat().st_mode), stat.S_IMODE((self.workspace / "plan/s1").stat().st_mode)), (0o711, 0o711))
        self.assertEqual(self.roots(40001, "/workspace/plan/s1/2"), "-1")        # below 3
        self.assertFalse((self.workspace / "plan/s1/2").exists())
        self.assertEqual(self.roots(40001, "/workspace/plan/other/1"), "-1")     # not this conversation's
        self.assertEqual(self.roots(40001, "/workspace/plan/s1/4"), "0")
        self.assertEqual(sorted(p.name for p in (self.workspace / "plan/s1").iterdir()), ["3", "4"])

    def test_a_workspace_without_a_browse_uid_still_gets_its_plan_view_and_no_other_root(self):
        self.assertEqual(self.roots(0, "/workspace/repos/off2", "/workspace/plan/s1/9"), "0")
        self.assertTrue((self.workspace / "plan/s1/9").is_dir())
        self.assertFalse((self.workspace / "repos/off2").exists())
        self.assertEqual(self.roots(0, "/workspace/plan/s1/8"), "-1")                              # stale on this path too


if __name__ == "__main__":
    unittest.main()
