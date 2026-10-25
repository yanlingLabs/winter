"""Linux-only tests of the parts of /init that the portable tests cannot reach (init_linux.c), run as an ordinary process in a temporary directory.

tests/linux_init_tool.c compiles init_linux.c itself (its `main` renamed) so the real static functions run unchanged: the per-conversation
private directories, the device flush, and the supervisor's fork/exec with its three runtime pipes. It is never PID 1, never in a PID
namespace, and mounts, reboots and opens no real device. The supervisor is replaced by tests/fake_supervisor.c, which reports what it
was handed (command line, environment, signal state, every open descriptor).

Only what needs another user, a mount, a device or the real python3 stays untested here (see docs/research/2026-10-17-cowork-n2-guest-boot.md):
the root-only effect of chown to the runtime uid, the real `sync()`/`reboot`, and the real supervisor's startup.
"""
import errno
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


def realmount_requirement_problem(environ, linux, cc, euid, unshare):
    """Why CI's root step could not run the `realmount` tests here, or None. Only with WG_REQUIRE_REALMOUNT=1: elsewhere they may skip."""
    if environ.get("WG_REQUIRE_REALMOUNT") != "1":
        return None
    if not linux or not cc:
        return "needs Linux and a C compiler"
    if euid != 0:
        return "needs root"
    if not unshare:
        return "needs unshare(1)"
    return None


def setUpModule():
    """The class decorators below skip on a machine without Linux or a compiler before any test body runs, so `-k realmount` would pass with every test skipped.
    Under WG_REQUIRE_REALMOUNT=1 that is an error of the whole module instead."""
    problem = realmount_requirement_problem(os.environ, LINUX, CC, os.geteuid(), shutil.which("unshare"))
    if problem:
        raise RuntimeError("WG_REQUIRE_REALMOUNT=1 but the real-mount tests cannot run: " + problem)
INIT = ROOT / "init"
PATH_ENV = "PATH=/usr/sbin:/usr/bin:/sbin:/bin"


class RealmountRequirementTests(unittest.TestCase):
    """Runs everywhere: CI's root step cannot pass with its real-mount tests skipped."""

    def test_the_requirement_names_every_reason_the_root_tests_could_not_run(self):
        required = {"WG_REQUIRE_REALMOUNT": "1"}
        self.assertIsNone(realmount_requirement_problem({}, False, None, 1000, None))                  # not required: they may skip
        self.assertIsNone(realmount_requirement_problem(required, True, "cc", 0, "/usr/bin/unshare"))
        self.assertEqual(realmount_requirement_problem(required, False, "cc", 0, "/usr/bin/unshare"), "needs Linux and a C compiler")
        self.assertEqual(realmount_requirement_problem(required, True, None, 0, "/usr/bin/unshare"), "needs Linux and a C compiler")
        self.assertEqual(realmount_requirement_problem(required, True, "cc", 1000, "/usr/bin/unshare"), "needs root")
        self.assertEqual(realmount_requirement_problem(required, True, "cc", 0, None), "needs unshare(1)")

    def test_the_module_fails_rather_than_skips_when_the_requirement_is_not_met(self):
        import unittest.mock
        module = sys.modules[__name__]
        with unittest.mock.patch.dict(os.environ, {"WG_REQUIRE_REALMOUNT": "1"}), unittest.mock.patch.object(module, "LINUX", False):
            with self.assertRaises(RuntimeError):
                setUpModule()
        with unittest.mock.patch.dict(os.environ, {"WG_REQUIRE_REALMOUNT": "0"}), unittest.mock.patch.object(module, "LINUX", False):
            setUpModule()

    def test_the_root_step_sets_the_requirement(self):
        workflow = (ROOT.parents[2] / ".github/workflows/cowork-guest-boot.yml").read_text()
        self.assertRegex(workflow, r"WG_REQUIRE_REALMOUNT=1 python3 -I -S -B -m unittest discover -s apple/Cowork/WinterCoworkGuest/tests -p 'test_pid1_linux.py' -k realmount")


class LinuxToolSubcommandTests(unittest.TestCase):
    """Runs everywhere, macOS included: every subcommand these Linux-only tests hand tests/linux_init_tool.c is one the tool has, and the CI build of the tool is
    the one these tests make (the workflow runs this module; it compiles nothing itself). A lost subcommand fails here, not only on the Linux runner."""

    def test_every_subcommand_the_tests_use_exists_in_the_tool(self):
        import re
        tests = Path(__file__).read_text()
        tool = (ROOT / "tests/linux_init_tool.c").read_text()
        known = set(re.findall(r'strcmp\(argv\[1\], "([a-z]+)"\) == 0', tool))
        used = set(re.findall(r'(?:run_tool|private)\(\s*"([a-z]+)"', tests)) | set(re.findall(r'str\(self\.tool\), "([a-z]+)"', tests))
        self.assertGreaterEqual(len(used), 12)
        self.assertEqual(sorted(used - known), [])
        self.assertIn('"mountinfo"', tests)
        self.assertIn("mountinfo", used)

    def test_the_workflow_runs_these_tests_and_builds_nothing_itself(self):
        workflow = (ROOT.parents[2] / ".github/workflows/cowork-guest-boot.yml").read_text()
        self.assertIn("-p 'test_pid1_linux.py' -k realmount", workflow)
        self.assertIn("discover -s apple/Cowork/WinterCoworkGuest/tests -p 'test_*.py'", workflow)
        self.assertNotIn("linux_init_tool", workflow)


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
                   INIT / "trusted_config.c", INIT / "dataroots.c", INIT / "shares.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"]
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


@unittest.skipUnless(CC and LINUX, "needs Linux and a C compiler")
class SharesPid1Tests(unittest.TestCase):
    """init_linux.c's share step (SH6) with its real system calls: the sysfs and mount table readers, mount(2) through the checked descriptor and umount2(2).

    As an ordinary process the mount is refused (EPERM), which must undo the step. The tests whose names hold `realmount` need root and run in CI's root step
    (`.github/workflows/cowork-guest-boot.yml`, with WG_REQUIRE_REALMOUNT=1 so they fail rather than skip), each in a private mount namespace: the whole step for real
    on tmpfs (this runner has no virtio-fs device, so virtio-fs itself is reached and refused, and the live virtio-fs mount is G7's), a mount point that already holds
    a mount, and the mountinfo reader and every flag and data-option check on the kernel's own output, including ext4 mounted with dax=never."""
    FOLDER = "folder:0:src-0:/workspace/folders/notes"
    PHOTOS = "folder:1:src-1:/workspace/folders/photos"
    GUIDANCE = "guidance:1:winter-guidance:/run/winter/shared-instructions"
    MEMORY = "memory:0:winter-memory:/workspace/.winter/memory"
    OUTPUTS = "outputs:0:winter-outputs:/workspace/outputs"

    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-pid1-shares-"))
        os.chmod(cls.folder, 0o755)
        cls.root = cls.folder / "root"
        cls.sys = cls.folder / "sys"
        sources = [ROOT / "tests/linux_init_tool.c", INIT / "boot.c", INIT / "discover.c", INIT / "ext4sb.c", INIT / "mounts.c", INIT / "skeleton.c",
                   INIT / "trusted_config.c", INIT / "dataroots.c", INIT / "shares.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"]
        owner = f"-DSHARES_OWNER={os.getuid()}"        # test build only: the walk then accepts this process's own directories and reaches the real mount(2)
        cls.tool = build(sources, cls.folder / "linux-init-tool", extra=["-DWG_FILE_CHANNEL_V1", f'-DSHARES_ROOT="{cls.root}"', f'-DSHARES_SYS_ROOT="{cls.sys}"', owner])
        cls.real_sys_tool = build(sources, cls.folder / "linux-init-tool-real-sys", extra=["-DWG_FILE_CHANNEL_V1", f'-DSHARES_ROOT="{cls.root}"', owner])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(self.sys, ignore_errors=True)
        for sub in ("run/winter/shared-instructions", "workspace/.winter/memory", "workspace/outputs", "workspace/folders"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        for sub in ("workspace", "workspace/.winter", "workspace/.winter/memory", "workspace/outputs", "workspace/folders"):
            os.chmod(self.root / sub, 0o711)

    def run_tool(self, *args, tool=None):
        result = subprocess.run([str(tool or self.tool), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    def need_root(self):
        """A `realmount` test: root and unshare(1), or (in CI's root step, WG_REQUIRE_REALMOUNT=1) a failure instead of a skip."""
        unshare = shutil.which("unshare")
        if os.geteuid() == 0 and unshare:
            return unshare
        if os.environ.get("WG_REQUIRE_REALMOUNT") == "1":
            self.fail("the real-mount step must run as root with unshare(1)")
        self.skipTest("needs root (CI's root step)")

    def private(self, *args, shell=None):
        """The tool (or a shell line ending in it) as root in a private mount namespace: every mount it makes is gone when it exits."""
        unshare = self.need_root()
        command = [unshare, "-m", "--propagation", "private"] + (["/bin/sh", "-c", shell, "sh", str(self.tool), *map(str, args)] if shell else [str(self.tool), *map(str, args)])
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout

    def fake_sysfs(self, tags):
        (self.sys / "fs/virtiofs").mkdir(parents=True)
        (self.sys / "bus/virtio/devices").mkdir(parents=True)
        for n, tag in enumerate(tags):
            (self.sys / f"fs/virtiofs/{n}").mkdir()
            (self.sys / f"fs/virtiofs/{n}/tag").write_text(tag + "\n")
            (self.sys / f"bus/virtio/devices/virtio{n}").mkdir()
            (self.sys / f"bus/virtio/devices/virtio{n}/device").write_text("0x001a\n")

    def modes(self):
        return {str(p.relative_to(self.root)): stat.S_IMODE(p.lstat().st_mode) for p in self.root.rglob("*")}

    @staticmethod
    def fields(text):
        return dict(line.split("=", 1) for line in text.splitlines() if "=" in line and " " not in line.split("=", 1)[0])

    @staticmethod
    def tag_of(spec):
        return spec.split(":")[2]

    # ---- as an ordinary process

    def test_an_inventory_that_does_not_match_fails_the_real_step_before_anything_is_made(self):
        self.fake_sysfs(["src-0"])
        before = self.modes()
        self.assertTrue(self.run_tool("shares", self.FOLDER, self.MEMORY).startswith("rc=1 mounted=0 "))
        self.assertEqual(self.modes(), before)

    def test_on_this_machine_the_real_sysfs_has_none_of_the_declared_devices(self):
        self.assertTrue(self.run_tool("shares", self.FOLDER, tool=self.real_sys_tool).startswith("rc=1 mounted=0 "))

    def test_a_refused_real_mount_undoes_the_step_and_changes_no_mode(self):
        if os.geteuid() == 0:
            self.skipTest("root may mount: the refusal under test is the ordinary user's EPERM")
        self.fake_sysfs(["src-0", "winter-memory"])
        before = self.modes()
        # the walk accepts the test's own directories (SHARES_OWNER, test build only), makes the folder's mount point, and reaches mount(2), which refuses
        self.assertEqual(self.run_tool("shares", self.FOLDER, self.MEMORY).strip(), f"rc=2 mounted=0 errno={errno.EPERM}")
        after = self.modes()
        self.assertEqual(after.pop("workspace/folders/notes"), 0o700)                    # the one directory the step made: the folder's mount point, root-only
        self.assertEqual(after, before)
        for path in ("/workspace/folders/notes", "/workspace/.winter/memory"):
            self.assertEqual(self.fields(self.run_tool("mountinfo", str(self.root) + path))["count"], "0")   # nothing is left mounted
        self.assertEqual(self.run_tool("umountshare", "/workspace/outputs").strip(), "rc=-1")   # nothing is mounted there

    def test_the_real_mount_table_is_read_whole_and_parsed(self):
        out = self.fields(self.run_tool("mountinfo", "/proc"))
        self.assertGreaterEqual(int(out["count"]), 1)
        self.assertEqual((out["fstype"], out["root"], out["mount_point"]), ("proc", "/", "/proc"))
        self.assertEqual(self.fields(self.run_tool("mountinfo", str(self.root / "nowhere")))["count"], "0")

    # ---- as root, in a private mount namespace (CI's root step)

    def test_realmount_the_whole_share_step_runs_for_real_through_the_checked_descriptors(self):
        specs = [self.FOLDER, self.PHOTOS, self.GUIDANCE, self.MEMORY, self.OUTPUTS]
        self.need_root()
        self.fake_sysfs([self.tag_of(s) for s in specs])
        out = self.private("realstep", "tmpfs", "nr_inodes=4096", *specs)
        lines = out.splitlines()
        self.assertEqual(lines[0], "rc=0 mounted=31 mounts=5", out)
        for spec, line in zip(specs, lines[1:6]):
            kind, ro, tag, _ = spec.split(":", 3)
            fields = dict(part.split("=", 1) for part in line.split(" "))
            options = fields["options"].split(",")
            self.assertEqual((fields["share"], fields["count"], fields["fstype"], fields["source"]), (tag, "1", "tmpfs", tag), out)
            self.assertEqual(("ro" in options, "rw" in options), (ro == "1", ro != "1"), out)
            self.assertIn("nosuid", options)
            self.assertIn("nodev", options)
            self.assertEqual("noexec" in options, kind != "folder", out)
            self.assertIn("nr_inodes=4096", fields["super"].split(","), out)
        self.assertIn("alias=/run/winter/shared-instructions/WINTER.md", lines)
        self.assertEqual([line for line in lines if line.startswith("umount=")], [f"umount={self.tag_of(s)}:0" for s in reversed(specs)])
        self.assertEqual(lines[-1], "left=0")

    def test_realmount_a_mount_point_that_already_holds_a_mount_is_refused_before_anything_is_mounted(self):
        self.need_root()
        self.fake_sysfs([self.tag_of(self.FOLDER), self.tag_of(self.OUTPUTS)])
        out = self.private("realstep", "tmpfs", "nr_inodes=4096", self.FOLDER, self.OUTPUTS,
                           shell=f'mount -t tmpfs stray "{self.root}/workspace/outputs" && exec "$@"')
        lines = out.splitlines()
        # refused by the walk (the mount point is not on its parent's filesystem) before any mount(2): not mounted and rolled back, never mounted at all
        self.assertEqual(lines[0], "rc=2 mounted=0 mounts=0", out)
        self.assertTrue(lines[1].startswith("share=src-0 count=0 "), out)

    def test_realmount_an_alias_that_is_the_right_link_but_not_pid_1s_is_refused(self):
        """The alias owner check needs a link owned by someone else, which only root can make (lchown)."""
        self.need_root()
        alias = self.root / "workspace/.winter/WINTER.md"
        alias.symlink_to("/run/winter/shared-instructions/WINTER.md")
        os.lchown(alias, 12345, 12345)
        self.assertEqual(self.run_tool("alias").strip(), "rc=-1")
        self.assertEqual(alias.lstat().st_uid, 12345)                                    # refused, and left as it is
        os.lchown(alias, 0, 0)
        self.assertEqual(self.run_tool("alias").strip(), "rc=0")

    def test_realmount_virtiofs_itself_is_reached_and_refused_for_the_missing_device(self):
        """The production call, mount(tag, /proc/self/fd/<n>, "virtiofs", flags, "dax=never"), as root on a machine with no virtio-fs device: the kernel refuses it
        (EINVAL, `tag not found`; ENODEV where the driver is absent) and the step is undone. The live virtio-fs mount is G7's."""
        self.need_root()
        self.fake_sysfs([self.tag_of(self.FOLDER), self.tag_of(self.MEMORY)])
        out = self.private("shares", self.FOLDER, self.MEMORY).strip()
        rc, mounted, err = (part.split("=")[1] for part in out.split(" "))
        self.assertEqual((rc, mounted), ("2", "0"), out)
        self.assertIn(int(err), (errno.EINVAL, errno.ENODEV), out)

    def test_realmount_the_mountinfo_reader_and_every_flag_check_hold_on_the_kernels_own_output(self):
        self.need_root()
        same = ("tmpfs", "winter-memory", "nr_inodes=4096", self.MEMORY)
        cases = {
            "as mounted": (same, same, "0"),
            "read-only expected": (same, ("tmpfs", "winter-memory", "nr_inodes=4096", "guidance:1:winter-memory:/workspace/.winter/memory"), "-1"),
            "exec mounted, noexec expected": (("tmpfs", "winter-memory", "nr_inodes=4096", "folder:0:winter-memory:/workspace/.winter/memory"), same, "-1"),
            "another data option": (same, ("tmpfs", "winter-memory", "nr_inodes=8192", self.MEMORY), "-1"),
            "another source": (same, ("tmpfs", "winter-outputs", "nr_inodes=4096", self.MEMORY), "-1"),
            "another fstype": (same, ("virtiofs", "winter-memory", "nr_inodes=4096", self.MEMORY), "-1"),
        }
        for name, (mounted, checked, expected) in cases.items():
            with self.subTest(name):
                out = self.private("realcheck", *mounted, *checked)
                fields = self.fields(out)
                self.assertEqual((fields["count"].split()[0], out.split("check=")[1].split()[0], fields["umount"]), ("1", expected, "0"), out)

    def test_realmount_ext4_mounted_with_dax_never_reads_back_as_the_dax_rule_expects(self):
        """A real `dax=never` line from this kernel: ext4 (which prints its DAX mode the way the fuse client does) on a loop device, checked by the same rule."""
        self.need_root()
        losetup, mke2fs = shutil.which("losetup"), shutil.which("mke2fs")
        if not (losetup and mke2fs):
            self.fail("losetup and mke2fs are part of the runner")
        image = self.folder / "dax.img"
        with open(image, "wb") as handle:
            handle.truncate(32 * 1024 * 1024)
        subprocess.run([mke2fs, "-q", "-F", "-t", "ext4", str(image)], check=True, capture_output=True)
        device = subprocess.run([losetup, "-f", "--show", str(image)], check=True, capture_output=True, text=True).stdout.strip()
        self.addCleanup(subprocess.run, [losetup, "-d", device], capture_output=True)
        out = self.private("realcheck", "ext4", device, "dax=never", self.MEMORY, "ext4", device, "dax=never", self.MEMORY)
        self.assertIn("check=0", out)
        self.assertIn("dax=never", self.fields(out)["super"].split(","), out)
        out = self.private("realcheck", "ext4", device, "dax=never", self.MEMORY, "ext4", device, "dax=always", self.MEMORY)
        self.assertIn("check=-1", out)

    def test_realmount_a_tmpfs_with_a_shares_flags_reads_back_in_a_namespace_of_its_own(self):
        """The same probe as an ordinary user, where the runner allows an unprivileged user namespace; as root, in a private mount namespace."""
        unshare = shutil.which("unshare")
        if os.geteuid() == 0 and unshare:
            command = [unshare, "-m", "--propagation", "private"]
        elif unshare and subprocess.run([unshare, "-Urm", "true"], capture_output=True).returncode == 0:
            command = [unshare, "-Urm"]
        else:
            self.need_root()
            return
        target = self.root / "workspace/outputs"
        result = subprocess.run(command + [str(self.tool), "realmount", str(target)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = self.fields(result.stdout)
        self.assertEqual(out["count"], "1", result.stdout)
        self.assertEqual((out["fstype"], out["source"], out["root"], out["mount_point"], out["umount"]), ("tmpfs", "winter-probe", "/", str(target), "0"))
        options = out["options"].split(",")
        for option in ("ro", "nosuid", "nodev", "noexec"):
            self.assertIn(option, options)
        self.assertNotIn("rw", options)
        self.assertIn("size=1024k", out["super"].split(","))

if __name__ == "__main__":
    unittest.main()
