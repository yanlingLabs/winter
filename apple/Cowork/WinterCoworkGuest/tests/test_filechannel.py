"""Native tests of the guest's file-channel pieces that need no VM and no root (everything here is compiled with WG_FILE_CHANNEL_V1, the flag of an image that declares
`file-channel-v1`; the production programs are built without it, and test_hygiene.py / test_mutants.py hold that): PID 1's decisions about the extended 'C' payload, the config's
`fileChannel` member and the relay's go byte (test_boot_filechannel.c), and the data-volume roots PID 1 creates for the supervisor's file service (dataroots.c)."""
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_native import CC, ROOT, build

import sys
sys.path.insert(0, str(ROOT / "bootstrap"))
import guest_bootstrap as gb  # noqa: E402

HERE = Path(__file__).resolve().parent
INIT = ROOT / "init"
FLAG = ["-DWG_FILE_CHANNEL_V1"]


@unittest.skipUnless(CC, "no C compiler")
class BootFileChannelTests(unittest.TestCase):
    def test_every_native_case_passes(self):
        folder = Path(tempfile.mkdtemp(prefix="guest-boot-fc-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        binary = build([HERE / "test_boot_filechannel.c", INIT / "boot.c", INIT / "mounts.c", INIT / "ext4sb.c", INIT / "trusted_config.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"],
                       folder / "test_boot_filechannel", extra=FLAG)
        result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=120)
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAIL") or line.startswith("      ")]
        self.assertEqual(failed, [], result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(re.findall(r"^PASS ", result.stdout, flags=re.M)), 8)

    def test_the_plain_build_does_not_know_the_extension(self):
        """Without the flag the payload parser is the old one: bit 7 of the profile byte is simply an invalid profile."""
        folder = Path(tempfile.mkdtemp(prefix="guest-boot-plain-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        source = folder / "probe.c"
        source.write_text('#include "%s/boot.h"\n#include <stdio.h>\nint main(void){ static struct wg_conversation_set s; const unsigned char p[] = {0x81,1,0xE9,0x4E,0,0,2,\'s\',\'1\',0,0,0,0,0x31,0x75,0,0,1,19,'
                          '\'/\',\'w\',\'o\',\'r\',\'k\',\'s\',\'p\',\'a\',\'c\',\'e\',\'/\',\'r\',\'e\',\'p\',\'o\',\'s\',\'/\',\'r\',\'1\',\'[\',\']\'}; printf("%%d\\n", wg_parse_conversation_payload(p, sizeof p, &s)); return 0; }\n' % INIT)
        binary = build([source, INIT / "boot.c", INIT / "mounts.c", INIT / "ext4sb.c", INIT / "trusted_config.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"], folder / "probe")
        self.assertEqual(subprocess.run([str(binary)], capture_output=True, text=True).stdout.strip(), "-1")


@unittest.skipUnless(CC, "no C compiler")
class HelperToPid1Tests(unittest.TestCase):
    """The helper's extended 'C' payload (Python, revision 3) against the gated `wg_parse_conversation_payload` (C), on the contract's own conversation vectors."""

    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-payload-"))
        cls.tool = build([HERE / "payload_tool.c", INIT / "boot.c", INIT / "mounts.c", INIT / "ext4sb.c", INIT / "trusted_config.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"],
                         cls.folder / "tool", extra=FLAG)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def test_what_the_helper_sends_is_what_pid_1_reads(self):
        vectors = json.loads((ROOT / "vectors/mux-frames.json").read_text())["positive"]
        names = [v["name"] for v in vectors if v["name"].startswith("bootstrap-down-conversations")]
        self.assertGreaterEqual(len(names), 6)
        seen_browse = False
        for name in names:
            with self.subTest(name):
                gb.set_revision_three(True)
                self.addCleanup(gb.set_revision_three, False)
                message = gb.parse_bootstrap_message(next(bytes.fromhex(v["hex"])[16:] for v in vectors if v["name"] == name), "down")
                payload = gb.conversations_payload(message)
                out = subprocess.run([str(self.tool), payload.hex()], capture_output=True, text=True, timeout=60).stdout.strip()
                profile, browse, count, conversations, items = out.split("|", 4)
                self.assertEqual(profile, str({None: 0, "host-query-v1": 1, "host-query-guided-v1": 2}[message["profile"]]))
                self.assertEqual(int(browse), message["browseUid"] or 0)
                seen_browse |= message["browseUid"] is not None
                self.assertEqual(int(count), len(message["conversations"]))
                expected = ";".join("%s:%d:%d:%d:%s" % (c["logicalSessionId"], c["runtimeUid"], c["toolUid"], c["workspaceGid"], ",".join(r["source"] for r in c["roots"])) for c in message["conversations"])
                self.assertEqual(conversations, expected)
                self.assertEqual(json.loads(items), gb.supervisor_items(message))
        self.assertTrue(seen_browse)

    def test_the_roots_sent_are_the_sources_not_the_views(self):
        vectors = json.loads((ROOT / "vectors/mux-frames.json").read_text())["positive"]
        gb.set_revision_three(True)
        self.addCleanup(gb.set_revision_three, False)
        message = gb.parse_bootstrap_message(next(bytes.fromhex(v["hex"])[16:] for v in vectors if v["name"] == "bootstrap-down-conversations-browse-uid"), "down")
        message["conversations"][0]["roots"] = [dict(message["conversations"][0]["roots"][0], source="/workspace/repos/the-source")]
        out = subprocess.run([str(self.tool), gb.conversations_payload(message).hex()], capture_output=True, text=True, timeout=60).stdout.strip()
        self.assertIn(":/workspace/repos/the-source|", out)


@unittest.skipUnless(CC, "no C compiler")
class DataRootTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-dataroots-"))
        cls.tool = build([HERE / "dataroots_tool.c", INIT / "dataroots.c"], cls.folder / "tool", extra=FLAG)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-workspace-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.gid = os.getgid()
        for sub in ("repos", "folders", "outputs", ".winter", ".winter/scratch", ".winter/memory"):
            (self.dir / sub).mkdir(parents=True, exist_ok=True)
            os.chmod(self.dir / sub, 0o711)

    def run_tool(self, *args):
        result = subprocess.run([str(self.tool), "dataroots", str(self.dir), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def mode_of(self, relative):
        return stat.S_IMODE((self.dir / relative).stat().st_mode)

    def test_a_root_is_created_owned_in_the_workspace_group_with_the_setgid_bit(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r1", "/workspace/repos/docs", "/workspace/.winter/scratch/s1"), "0")
        for relative in ("repos/r1", "repos/docs", ".winter/scratch/s1"):
            st = (self.dir / relative).stat()
            self.assertEqual((self.mode_of(relative), st.st_uid, st.st_gid), (0o2770, os.getuid(), self.gid), relative)
        self.assertEqual(self.mode_of("repos"), 0o711)                              # the directories above a root are not touched

    def test_intermediate_directories_are_created_traversable_and_not_listable(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/a/b/c"), "0")
        self.assertEqual((self.mode_of("repos/a"), self.mode_of("repos/a/b"), self.mode_of("repos/a/b/c")), (0o711, 0o711, 0o2770))

    def test_running_it_again_changes_nothing_and_repairs_a_wrong_mode(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r1"), "0")
        os.chmod(self.dir / "repos/r1", 0o755)
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r1"), "0")
        self.assertEqual(self.mode_of("repos/r1"), 0o2770)

    def test_the_share_mount_points_are_not_data_volume_roots(self):
        for source in ("/workspace/outputs", "/workspace/outputs/s1", "/workspace/.winter/memory", "/workspace/.winter/memory/x"):
            self.assertTrue(self.run_tool(self.gid, source) == "0", source)
        self.assertEqual(self.mode_of("outputs"), 0o711)
        self.assertEqual(self.mode_of(".winter/memory"), 0o711)
        self.assertFalse((self.dir / "outputs/s1").exists() or (self.dir / ".winter/memory/x").exists())
        # a sibling whose name merely starts the same way is a data root
        self.assertEqual(self.run_tool(self.gid, "/workspace/outputs-extra", "/workspace/.winter/memory2"), "0")
        self.assertEqual((self.mode_of("outputs-extra"), self.mode_of(".winter/memory2")), (0o2770, 0o2770))

    def test_intermediate_directories_are_0711_even_under_the_umask_pid_1_runs_with(self):
        result = subprocess.run(["/bin/sh", "-c", 'umask 077; exec "$0" dataroots "$1" "$2" /workspace/repos/u/v/w', str(self.tool), str(self.dir), str(self.gid)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.stdout.strip(), "0", result.stderr)
        self.assertEqual((self.mode_of("repos/u"), self.mode_of("repos/u/v"), self.mode_of("repos/u/v/w")), (0o711, 0o711, 0o2770))
        os.chmod(self.dir / "repos/u", 0o700)                                    # a parent a past boot left 0700 is repaired, not trusted
        result = subprocess.run(["/bin/sh", "-c", 'umask 077; exec "$0" dataroots "$1" "$2" /workspace/repos/u/v/w', str(self.tool), str(self.dir), str(self.gid)], capture_output=True, text=True, timeout=60)
        self.assertEqual((result.stdout.strip(), self.mode_of("repos/u")), ("0", 0o711))

    def test_nothing_under_workspace_folders_is_a_data_root_so_a_host_share_mount_is_never_chowned_or_chmodded(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/folders", "/workspace/folders/docs", "/workspace/folders/a/b"), "0")
        self.assertEqual(self.mode_of("folders"), 0o711)
        self.assertFalse((self.dir / "folders/docs").exists() or (self.dir / "folders/a").exists())
        self.assertEqual(self.run_tool(self.gid, "/workspace/folders-x"), "0")             # a sibling that merely starts the same way is a root
        self.assertEqual(self.mode_of("folders-x"), 0o2770)

    def chown_requests(self):
        log = self.dir.parent / (self.dir.name + ".chown-log")
        log.unlink(missing_ok=True)
        self.addCleanup(lambda: log.unlink(missing_ok=True))
        return log

    def run_env(self, *args, **env):
        result = subprocess.run([str(self.tool), "dataroots", str(self.dir), *map(str, args)], capture_output=True, text=True, timeout=60, env=dict(os.environ, **{k: str(v) for k, v in env.items()}))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def foreign_id(self):
        return 1 if os.geteuid() == 0 else 0           # an owner id that is not this user's

    def test_the_plan_view_has_root_parents_and_an_epoch_that_belongs_to_the_conversations_tool_uid_alone(self):
        log = self.chown_requests()
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/5", DATAROOTS_LOG=log), "0")
        # (this user stands for root: what was asked of fchown is in the log, what the file system keeps is the user's own)
        self.assertEqual((self.mode_of("plan"), self.mode_of("plan/conv-0001"), self.mode_of("plan/conv-0001/5")), (0o711, 0o711, 0o700))
        me = "%d:%d" % (os.getuid(), os.getgid())
        self.assertEqual(log.read_text().split(), [me, me, "41001:41001"])                       # /workspace/plan and the folder of the id: root's; the epoch: the tool uid, group = the same id
        self.assertNotIn("41001:%d" % self.gid, log.read_text())                                  # never the workspace group, which other conversations may share
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/5", DATAROOTS_LOG=log), "0")    # idempotent
        self.assertEqual(sorted(p.name for p in (self.dir / "plan/conv-0001").iterdir()), ["5"])
        # the second conversation of a set gets its own folder under its own id, owned by ITS tool uid
        log.unlink()
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/6", "--", self.gid, "/workspace/plan/conv-0002/0", DATAROOTS_LOG=log), "0")
        self.assertTrue((self.dir / "plan/conv-0002/0").is_dir())
        self.assertEqual([line for line in log.read_text().split() if line.startswith("41")], ["41001:41001", "41002:41002"])

    def test_a_sibling_conversations_uid_has_no_access_to_a_plan_view(self):
        """The bits: the epoch is owner-only (no group, no other, no setgid) and the folders above it are 0711 root's, so neither the workspace group nor another conversation's tool uid
        (nor its private group) gets in, and nobody but root can add or remove an epoch. With root (the CI's sudo step) it is tried for real with the tool uids."""
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5", "--", self.gid, "/workspace/plan/conv-0002/3"), "0")
        for relative in ("plan/conv-0001/5", "plan/conv-0002/3"):
            self.assertEqual(self.mode_of(relative) & 0o7077, 0, relative)
        for relative in ("plan", "plan/conv-0001", "plan/conv-0002"):
            self.assertEqual(self.mode_of(relative), 0o711, relative)
        if os.geteuid() != 0:
            if os.environ.get("WG_REQUIRE_ROOT"):
                self.fail("WG_REQUIRE_ROOT is set but this is not root: the identity half would silently not run")
            self.skipTest("the real-identity half needs root (cowork-guest-boot.yml runs it with sudo)")
        shared = 42000                                   # the workspace group both conversations share: not root's group, and not either tool uid's
        # a workspace the tool uids can walk down to (the temporary directory may be under a home they cannot enter)
        self.dir = Path(tempfile.mkdtemp(prefix="guest-ids-", dir="/tmp"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        os.chmod(self.dir, 0o755)
        self.assertEqual(self.run_env(shared, "/workspace/plan/conv-0001/5", "--", shared, "/workspace/plan/conv-0002/3", DATAROOTS_REAL_IDS="1"), "0")
        st = (self.dir / "plan/conv-0001/5").stat()
        self.assertEqual((st.st_uid, st.st_gid), (41001, 41001))
        self.assertEqual(((self.dir / "plan/conv-0001").stat().st_uid, (self.dir / "plan").stat().st_uid), (0, 0))
        (self.dir / "plan/conv-0001/5/secret").write_text("mine")
        def as_tool(uid, action):
            pid = os.fork()
            if pid == 0:
                code = 99
                try:
                    os.setgroups([shared])                           # the workspace group (a real one, not root's 0), as every tool process of the workspace may have
                    os.setresgid(uid, uid, uid)
                    os.setresuid(uid, uid, uid)
                    action()
                    code = 0
                except PermissionError:
                    code = 13
                except BaseException:
                    code = 98
                finally:
                    os._exit(code)
            return os.waitpid(pid, 0)[1] >> 8
        view = str(self.dir / "plan/conv-0001/5")
        self.assertEqual(as_tool(41002, lambda: os.listdir(view)), 13)
        self.assertEqual(as_tool(41002, lambda: open(view + "/secret").read()), 13)
        self.assertEqual(as_tool(41002, lambda: open(view + "/new", "w")), 13)
        self.assertEqual(as_tool(41001, lambda: open(view + "/new", "w").write("x")), 0)               # the owner's own tool uid can
        folder = str(self.dir / "plan/conv-0001")
        self.assertEqual(as_tool(41001, lambda: os.mkdir(folder + "/9")), 13)                           # the past-epoch record is not the tool uid's to edit
        self.assertEqual(as_tool(41002, lambda: os.mkdir(folder + "/9")), 13)
        self.assertEqual(as_tool(41001, lambda: os.rmdir(folder + "/5")), 13)                           # nor an epoch to remove

    def test_an_existing_plan_directory_with_loose_bits_is_reset_and_a_loose_parent_too(self):
        (self.dir / "plan/conv-0001/5").mkdir(parents=True, mode=0o755)
        for relative, mode in (("plan", 0o777), ("plan/conv-0001", 0o777), ("plan/conv-0001/5", 0o755)):
            os.chmod(self.dir / relative, mode)
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")
        self.assertEqual((self.mode_of("plan"), self.mode_of("plan/conv-0001"), self.mode_of("plan/conv-0001/5")), (0o711, 0o711, 0o700))

    def test_an_existing_epoch_directory_of_another_owner_is_refused_before_anything_is_changed_on_it(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")
        os.chmod(self.dir / "plan/conv-0001/5", 0o755)
        log = self.chown_requests()
        # root's is another id and the tool uid is stored as yet another: the directory (this user's) is neither
        foreign = self.foreign_id()
        out = self.run_env(self.gid, "/workspace/plan/conv-0001/5", DATAROOTS_LOG=log, DATAROOTS_PARENT_OWNER=foreign, DATAROOTS_STORED_UID=foreign + 5000)
        self.assertEqual(out, "-1")
        self.assertNotIn("41001", log.read_text())                                                   # no chown was even asked for
        self.assertEqual(self.mode_of("plan/conv-0001/5"), 0o755)                                      # and no chmod
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")                  # the same directory is fine for its own owner

    def test_the_result_of_making_an_epoch_directory_is_checked_not_the_return_values(self):
        log = self.chown_requests()
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/5", DATAROOTS_STORED_UID=self.foreign_id() + 5000, DATAROOTS_LOG=log), "-1")     # the owner is not the one asked for
        self.assertIn("41001:41001", log.read_text())                                                  # (a directory PID 1 made itself is let through to the chown; it is the result that fails)
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/6", DATAROOTS_STORED_GID=os.getgid() + 5000), "-1")          # nor is the group
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/7"), "0")

    def test_a_directory_read_that_fails_or_a_stale_errno_decides_the_epoch_scan_correctly(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/6", DATAROOTS_READDIR_FAIL="1"), "-1")      # a read error is not "no later epoch"
        self.assertFalse((self.dir / "plan/conv-0001/6").exists())
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/6", DATAROOTS_STALE_ERRNO="1"), "0")        # the end of a directory is no error, whatever errno held before

    def test_a_plan_directory_above_the_epoch_that_is_not_roots_is_refused(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")
        foreign = self.foreign_id()
        self.assertEqual(self.run_env(self.gid, "/workspace/plan/conv-0001/6", DATAROOTS_PARENT_OWNER=foreign, DATAROOTS_OWNER=foreign), "-1")    # /workspace/plan looks like somebody else's
        self.assertFalse((self.dir / "plan/conv-0001/6").exists())

    def test_a_plan_path_that_is_not_exactly_the_conversations_own_epoch_view_is_refused_and_nothing_is_made(self):
        for source in ("/workspace/plan", "/workspace/plan/conv-0001", "/workspace/plan/conv-0002/1", "/workspace/plan/conv-0001/01", "/workspace/plan/conv-0001/1234567890",
                       "/workspace/plan/conv-0001/x", "/workspace/plan/conv-0001/1/deeper", "/workspace/plan/conv-00011/1", "/workspace/plan/conv-000112"):
            with self.subTest(source):
                self.assertEqual(self.run_tool(self.gid, source), "-1")
        self.assertFalse((self.dir / "plan").exists())
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/123456789"), "0")     # nine digits is fine
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/0"), "-1")             # ... but 0 is below 123456789 now
        self.assertEqual(self.run_tool(self.gid, "/workspace/planning/x"), "0")                    # a sibling name that merely starts the same way is an ordinary root

    def test_an_earlier_epoch_is_never_made_again_and_is_left_untouched(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/5"), "0")
        (self.dir / "plan/conv-0001/5/note").write_text("kept")
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/6"), "0")
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/4"), "-1")             # below 6: stale
        self.assertFalse((self.dir / "plan/conv-0001/4").exists())
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/6"), "0")              # the same epoch again is fine
        self.assertEqual((self.dir / "plan/conv-0001/5/note").read_text(), "kept")                  # the earlier epoch is not re-created or emptied
        self.assertEqual(self.mode_of("plan/conv-0001/5"), 0o700)

    def test_without_a_browse_uid_only_the_plan_view_is_made(self):
        env = dict(os.environ, DATAROOTS_PLAN_ONLY="1")
        def run(*sources):
            return subprocess.run([str(self.tool), "dataroots", str(self.dir), str(self.gid), *sources], capture_output=True, text=True, env=env, timeout=60).stdout.strip()
        self.assertEqual(run("/workspace/repos/r1", "/workspace/plan/conv-0001/2"), "0")
        self.assertTrue((self.dir / "plan/conv-0001/2").is_dir())
        self.assertFalse((self.dir / "repos/r1").exists())                                          # an ordinary data root is not made without a browse uid
        self.assertEqual(run("/workspace/plan/conv-0001/1"), "-1")                                  # the staleness rule holds on this path too
        self.assertEqual(run("/workspace/plan/conv-0002/1"), "-1")                                  # and the own-conversation rule

    def test_a_plan_parent_that_is_a_symlink_or_not_a_directory_is_refused(self):
        outside = Path(tempfile.mkdtemp(prefix="guest-outside-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        (self.dir / "plan").symlink_to(outside)
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/1"), "-1")
        self.assertEqual(list(outside.iterdir()), [])
        (self.dir / "plan").unlink()
        (self.dir / "plan").mkdir(mode=0o711)
        (self.dir / "plan/conv-0001").symlink_to(outside)
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/1"), "-1")
        self.assertEqual(list(outside.iterdir()), [])
        (self.dir / "plan/conv-0001").unlink()
        (self.dir / "plan/conv-0001").write_text("a file where the parent belongs")
        self.assertEqual(self.run_tool(self.gid, "/workspace/plan/conv-0001/1"), "-1")

    def test_a_symlink_anywhere_on_the_path_is_refused_and_nothing_is_followed(self):
        outside = Path(tempfile.mkdtemp(prefix="guest-outside-"))
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        os.chmod(outside, 0o755)
        (self.dir / "repos/link").symlink_to(outside)
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/link"), "-1")                 # the root itself
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/link/inner"), "-1")           # a parent
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o755)
        self.assertEqual(list(outside.iterdir()), [])

    def test_a_path_with_an_empty_or_overlong_component_is_refused(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos//x"), "-1")
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/" + "a" * 65), "-1")
        self.assertFalse((self.dir / "repos/a").exists())
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/" + "a" * 64), "0")

    def test_a_file_where_a_directory_belongs_is_refused(self):
        (self.dir / "repos/file").write_text("x")
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/file"), "-1")
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/file/inner"), "-1")

    def test_a_parent_owned_by_someone_else_is_refused(self):
        env = dict(os.environ, DATAROOTS_PARENT_OWNER=str(os.getuid() + 1))
        result = subprocess.run([str(self.tool), "dataroots", str(self.dir), str(self.gid), "/workspace/repos/r1"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(result.stdout.strip(), "-1")                                    # `repos` is ours, and the tool was told root is someone else
        self.assertEqual(self.mode_of("repos"), 0o711)
        result = subprocess.run([str(self.tool), "dataroots", str(self.dir), str(self.gid), "/workspace/repos/r1"], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.stdout.strip(), "0")

    def test_a_path_that_is_not_below_workspace_or_is_malformed_is_refused(self):
        for source in ("/etc/passwd", "/workspace", "workspace/repos/a"):
            self.assertEqual(self.run_tool(self.gid, source), "-1", source)

    def test_two_conversations_are_both_served_and_one_root_may_be_named_twice(self):
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r1", "--", self.gid, "/workspace/repos/r1"), "0")
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r3", "--", self.gid, "/workspace/repos/r4"), "0")
        self.assertEqual((self.mode_of("repos/r3"), self.mode_of("repos/r4")), (0o2770, 0o2770))

    def test_a_workspace_that_is_a_symlink_is_not_followed(self):
        link = self.dir.with_name(self.dir.name + "-link")
        link.symlink_to(self.dir)
        self.addCleanup(link.unlink)
        result = subprocess.run([str(self.tool), "dataroots", str(link), str(self.gid), "/workspace/repos/r1"], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.stdout.strip(), "-1")
        self.assertFalse((self.dir / "repos/r1").exists())

    def run_with(self, env, *args):
        result = subprocess.run([str(self.tool), "dataroots", str(self.dir), *map(str, args)], capture_output=True, text=True, env=dict(os.environ, **env), timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_the_result_is_checked_on_the_descriptor_not_taken_from_the_calls(self):
        """A chown that reports success and changes nothing: the owner and the group the directory really has are what count."""
        env = {"DATAROOTS_NOOP_CHOWN": "1"}
        self.assertEqual(self.run_with(env, self.gid, "/workspace/repos/own"), "0")                          # it is already ours, in our group
        self.assertEqual(self.run_with(env, self.gid + 1, "/workspace/repos/other-group"), "-1")             # the group never changed
        self.assertEqual(self.run_with(dict(env, DATAROOTS_OWNER=str(os.getuid() + 1)), self.gid, "/workspace/repos/other-owner"), "-1")   # the owner never changed

    def test_a_path_that_only_starts_like_workspace_is_refused_and_nothing_is_created(self):
        self.assertEqual(self.run_tool(self.gid, "/workspaceX/repos/a"), "-1")
        self.assertEqual(self.run_tool(self.gid, "/workspace-x/repos/a"), "-1")
        self.assertFalse((self.dir / "repos/a").exists())

    def test_a_missing_workspace_is_refused(self):
        shutil.rmtree(self.dir)
        self.assertEqual(self.run_tool(self.gid, "/workspace/repos/r1"), "-1")
        self.dir.mkdir()


class ProductionHasNoFileChannelTests(unittest.TestCase):
    """Everything above is for an image that declares `file-channel-v1`. The production programs are built without WG_FILE_CHANNEL_V1, so none of it may exist in them:
    every use of a file-channel name in a production source sits inside `#ifdef WG_FILE_CHANNEL_V1`, and the production build lists none of the extra sources."""
    # names that exist only for the file channel (the codec's stream enum is shared and harmless, so it is not listed)
    NAMES = ("fileChannel", "file-channel-fds", "file-channel-v1", "protected_hardlinks", "wg_make_data_roots", "wg_add_file_channel", "WG_START_FILE_CHANNEL", "prepare_data_roots",
             "browse_uid", "workspace_gid", "root_source", "fileflow", "wg_fileflow", "dataroots", "--file-in", "--file-out", "file_in_fd", "file_out_fd", "make_file_pipe",
             "fifo_end_ok", "conv_file_channel", "read_data_device", "WG_PAYLOAD_EXTENDED", "finish_file_out", "close_file_in", "pump_file_out")
    SOURCES = ("init/init_linux.c", "init/boot.c", "init/boot.h", "init/trusted_config.c", "init/trusted_config.h", "common/wmx.c", "common/wmx.h", "relay/relay.c")

    @staticmethod
    def strip_comments(text):
        text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
        return re.sub(r"//[^\n]*", "", text)

    def ungated_lines(self, relative):
        """The source lines outside every `#ifdef WG_FILE_CHANNEL_V1` (the #else branch of one counts as outside)."""
        stack = []     # one entry per open conditional: True while inside a WG_FILE_CHANNEL_V1 branch
        out = []
        for number, line in enumerate(self.strip_comments((ROOT / relative).read_text()).splitlines(), 1):
            stripped = line.strip()
            if re.match(r"#\s*ifdef\s+WG_FILE_CHANNEL_V1\b", stripped):
                stack.append(True)
            elif re.match(r"#\s*(if|ifdef|ifndef)\b", stripped):
                stack.append(False)
            elif re.match(r"#\s*else\b", stripped) and stack:
                stack[-1] = False if stack[-1] else stack[-1]
            elif re.match(r"#\s*endif\b", stripped) and stack:
                stack.pop()
            elif not any(stack):
                out.append((number, line))
        return out

    def test_every_file_channel_name_in_a_production_source_is_inside_the_gate(self):
        for relative in self.SOURCES:
            for number, line in self.ungated_lines(relative):
                for name in self.NAMES:
                    self.assertNotIn(name, line, f"{relative}:{number} names {name} outside WG_FILE_CHANNEL_V1")

    def test_the_scanner_sees_a_name_outside_the_gate(self):
        probe = ROOT / "init/__probe_scan.c"
        probe.write_text("int a;\n#ifdef WG_FILE_CHANNEL_V1\nint fileChannel;\n#else\nint wg_make_data_roots;\n#endif\n#ifdef X\nint protected_hardlinks;\n#endif\n")
        try:
            found = [line.strip() for _, line in self.ungated_lines("init/__probe_scan.c")]
        finally:
            probe.unlink()
        self.assertEqual(found, ["int a;", "int wg_make_data_roots;", "int protected_hardlinks;"])

    def test_the_production_build_lists_none_of_the_extra_sources_or_flags(self):
        build_py = (ROOT / "build.py").read_text()
        programs = re.search(r"PROGRAMS = \{(.*?)\n\}", build_py, re.S).group(1)
        for name in ("dataroots", "fileflow", "WG_FILE_CHANNEL_V1"):
            self.assertNotIn(name, programs)
        self.assertNotIn("WG_FILE_CHANNEL_V1", re.search(r"COMMON_FLAGS = \[(.*?)\]", build_py).group(1))
        headers = re.search(r"\nHEADERS = \[(.*?)\]", build_py, re.S).group(1)
        self.assertNotIn("fileflow", headers)
        self.assertNotIn("dataroots", headers)
        self.assertIn('default="production"', build_py)
        self.assertIn("--update-pins is for the production profile only", build_py)


if __name__ == "__main__":
    unittest.main()
