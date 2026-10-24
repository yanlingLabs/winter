"""Native tests of the guest side of host-backed shares (SH6; an image that declares `file-channel-v1`, everything compiled with WG_FILE_CHANNEL_V1). No VM, no root, no mount:
the share step (init/shares.c) runs against a temporary tree, a fake sysfs and a written mount table through recording operations (tests/shares_tool.c), and PID 1's
decisions about 'S' run against a recording fake (tests/test_boot_shares.c). The Linux-only half (the real system calls in init_linux.c, a real mount table, and a real
mount in a user namespace where the runner allows one) is test_pid1_linux.py's SharesPid1Tests.

What the design asks of the guest (docs/research/2026-10-18-n2-extensions-design.md section 2.5, R6, R8): the virtio-fs inventory equals the declared tags exactly,
each tag is mounted nosuid,nodev [,ro] [,noexec on the Winter shares] with dax=never, every mount is checked in mountinfo, the guidance alias exists, nothing on a share
or a mount point is ever chowned or chmodded, and the drain unmounts the shares before the ext4 volumes."""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_native import CC, ROOT, build

sys.path.insert(0, str(ROOT / "bootstrap"))
import guest_bootstrap as gb  # noqa: E402

HERE = Path(__file__).resolve().parent
INIT = ROOT / "init"
FLAG = ["-DWG_FILE_CHANNEL_V1"]
FOLDER = "folder:0:src-0:/workspace/folders/notes"
PHOTOS = "folder:1:src-1:/workspace/folders/photos"
GUIDANCE = "guidance:1:winter-guidance:/run/winter/shared-instructions"
MEMORY = "memory:0:winter-memory:/workspace/.winter/memory"
OUTPUTS = "outputs:0:winter-outputs:/workspace/outputs"
ALL = [FOLDER, PHOTOS, GUIDANCE, MEMORY, OUTPUTS]
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8


def share_fields(spec):
    kind, ro, tag, path = spec.split(":", 3)
    return kind, ro == "1", tag, path


def mountinfo_line(number, spec, prefix="@ROOT@", **changes):
    """One mountinfo line for a share as the kernel prints a virtio-fs mount made by PID 1; `changes` replaces any field."""
    kind, ro, tag, path = share_fields(spec)
    options = ",".join(filter(None, ["ro" if ro else "rw", "nosuid", "nodev", "noexec" if kind != "folder" else "", "relatime"]))
    fields = {"id": str(40 + number), "parent": "30", "dev": f"0:{50 + number}", "root": "/", "mount_point": prefix + path, "options": options,
              "optional": "", "fstype": "virtiofs", "source": tag, "super": ("ro" if ro else "rw") + ",dax=never"}
    fields.update(changes)
    head = [fields["id"], fields["parent"], fields["dev"], fields["root"], fields["mount_point"], fields["options"]] + ([fields["optional"]] if fields["optional"] else [])
    return " ".join(head + ["-", fields["fstype"], fields["source"], fields["super"]]) + "\n"


BASE_TABLE = ("1 0 0:2 / / rw - rootfs rootfs rw\n"
              "22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw\n"
              "30 1 254:0 / @ROOT@/workspace rw,nosuid,nodev,noatime - ext4 /dev/vda rw,noinit_itable,errors=remount-ro\n")


@unittest.skipUnless(CC, "no C compiler")
class ShareModuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-shares-"))
        cls.tool = build([HERE / "shares_tool.c", INIT / "shares.c", INIT / "boot.c", INIT / "mounts.c", INIT / "ext4sb.c", INIT / "trusted_config.c",
                          ROOT / "common/wmx.c", ROOT / "common/ctl.c"], cls.folder / "shares-tool", extra=FLAG)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-shares-case-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.root = self.dir / "root"
        for sub, mode in (("run", 0o755), ("run/winter", 0o711), ("run/winter/shared-instructions", 0o755), ("workspace", 0o711), ("workspace/.winter", 0o711),
                          ("workspace/.winter/memory", 0o711), ("workspace/outputs", 0o711), ("workspace/folders", 0o711), ("workspace/repos", 0o711)):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
            os.chmod(self.root / sub, mode)
        self.sys = self.dir / "sys"

    def run_tool(self, *args, env=None):
        result = subprocess.run([str(self.tool), *map(str, args)], capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def fake_sysfs(self, tags, bus_devices=None, extra=()):
        """<sys>/fs/virtiofs/<n>/tag for every tag, and as many virtio-fs devices (type 26) on the bus as `bus_devices` (default: one per tag), beside a console and two disks."""
        shutil.rmtree(self.sys, ignore_errors=True)
        (self.sys / "fs/virtiofs").mkdir(parents=True)
        for n, tag in enumerate(tags):
            (self.sys / f"fs/virtiofs/{n}").mkdir()
            (self.sys / f"fs/virtiofs/{n}/tag").write_bytes(tag if isinstance(tag, bytes) else (tag + "\n").encode())
        for name in extra:
            (self.sys / f"fs/virtiofs/{name}").mkdir()
        devices = self.sys / "bus/virtio/devices"
        devices.mkdir(parents=True)
        for n, kind in enumerate(["0x0003", "0x0002", "0x0002"] + ["0x001a"] * (len(tags) if bus_devices is None else bus_devices)):
            (devices / f"virtio{n}").mkdir()
            (devices / f"virtio{n}/device").write_text(kind + "\n")

    def tags(self, specs):
        return [share_fields(spec)[2] for spec in specs]

    def table(self, specs, **changes):
        path = self.dir / "mountinfo"
        path.write_text(BASE_TABLE + "".join(mountinfo_line(n, spec, **changes) for n, spec in enumerate(specs)))
        return path

    def modes(self):
        return {str(p.relative_to(self.root)): (stat.S_IMODE(p.lstat().st_mode), p.lstat().st_uid) for p in [self.root, *self.root.rglob("*")]}

    # ---------------------------------------------------------------------------------------------- flags

    def test_each_kind_is_mounted_nosuid_nodev_read_only_as_declared_and_noexec_only_on_the_winter_shares(self):
        expect = {FOLDER: MS_NOSUID | MS_NODEV, PHOTOS: MS_RDONLY | MS_NOSUID | MS_NODEV, GUIDANCE: MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC,
                  MEMORY: MS_NOSUID | MS_NODEV | MS_NOEXEC, OUTPUTS: MS_NOSUID | MS_NODEV | MS_NOEXEC}
        for spec, flags in expect.items():
            with self.subTest(spec):
                self.assertEqual(int(self.run_tool("flags", spec).splitlines()[1]), flags)

    # ---------------------------------------------------------------------------------------------- inventory

    def test_the_inventory_must_equal_the_declared_tags(self):
        self.fake_sysfs(self.tags(ALL))
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "0")
        self.fake_sysfs(list(reversed(self.tags(ALL))))
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "0")          # order is the kernel's, not the host's

    def test_an_extra_device_is_refused_even_when_the_bus_count_agrees(self):
        self.fake_sysfs(self.tags(ALL) + ["src-9"])
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")
        self.fake_sysfs(self.tags(ALL[:-1]) + ["src-9"], bus_devices=len(ALL))            # one tag swapped for another
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")

    def test_a_missing_device_is_refused_even_when_the_bus_count_agrees(self):
        self.fake_sysfs(self.tags(ALL[:-1]), bus_devices=len(ALL))
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")
        self.fake_sysfs(self.tags(ALL[:-1]))
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")

    def test_a_tag_published_twice_is_refused_even_when_the_bus_count_agrees(self):
        self.fake_sysfs(self.tags(ALL) + [self.tags(ALL)[0]], bus_devices=len(ALL))
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")

    def test_a_virtio_fs_device_that_published_no_tag_is_an_extra_device(self):
        self.fake_sysfs(self.tags(ALL), bus_devices=len(ALL) + 1)
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")
        self.fake_sysfs(self.tags(ALL), bus_devices=len(ALL) - 1)
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")

    def test_what_this_kernel_does_not_publish_is_refused(self):
        self.fake_sysfs(self.tags(ALL), extra=["stray"])
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")          # a non-index entry under the kset
        for raw in (b"src-0", b"src-0\n\n", b"src-0 \n", b"SRC-0\n", b"\n", b"src-0\nx"):
            with self.subTest(raw):
                self.fake_sysfs([raw] + self.tags(ALL)[1:])
                self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")
        shutil.rmtree(self.sys)
        self.assertEqual(self.run_tool("inventory", self.sys, *ALL).strip(), "-1")          # no virtio-fs driver at all

    # ---------------------------------------------------------------------------------------------- mountinfo

    def test_the_mount_table_is_parsed_as_the_kernel_prints_it(self):
        path = self.dir / "mi"
        path.write_text(BASE_TABLE + mountinfo_line(0, FOLDER, optional="shared:7 master:3"))
        out = self.run_tool("find", path, f"@ROOT@/workspace/folders/notes").splitlines()
        self.assertEqual(out[0], "1")
        fields = dict(line.split("=", 1) for line in out[1:])
        self.assertEqual(fields, {"root": "/", "mount_point": "@ROOT@/workspace/folders/notes", "options": "rw,nosuid,nodev,relatime", "fstype": "virtiofs", "source": "src-0", "super": "rw,dax=never"})
        self.assertEqual(self.run_tool("find", path, "/proc").splitlines()[0], "1")
        for broken in ("1 0 0:2 / / rw rootfs rootfs rw\n", "1 0 0:2 / / rw - rootfs rootfs\n", "1 0 0:2 / /  rw - rootfs rootfs rw\n", "1 0 0:2 / / rw - rootfs rootfs rw"):
            with self.subTest(broken):
                path.write_text(broken)
                self.assertEqual(self.run_tool("find", path, "/").splitlines()[0], "-1")

    def test_every_share_mounted_as_required_passes_the_check(self):
        path = self.table(ALL)
        for spec in ALL:
            with self.subTest(spec):
                self.assertEqual(self.run_tool("check", path, "@ROOT@" + share_fields(spec)[3], spec).strip(), "0")

    def test_every_departure_in_the_mount_table_fails_the_check(self):
        cases = {
            "fstype": (MEMORY, {"fstype": "tmpfs"}), "source": (MEMORY, {"source": "winter-outputs"}), "root": (MEMORY, {"root": "/sub"}),
            "rw-for-ro": (GUIDANCE, {"options": "rw,nosuid,nodev,noexec,relatime"}), "ro-for-rw": (MEMORY, {"options": "ro,nosuid,nodev,noexec,relatime"}),
            "no-nosuid": (MEMORY, {"options": "rw,nodev,noexec,relatime"}), "no-nodev": (MEMORY, {"options": "rw,nosuid,noexec,relatime"}),
            "exec-winter": (MEMORY, {"options": "rw,nosuid,nodev,relatime"}), "noexec-folder": (FOLDER, {"options": "rw,nosuid,nodev,noexec,relatime"}),
            "ro-folder-as-rw": (PHOTOS, {"options": "rw,nosuid,nodev,relatime"}),
            "dax-always": (MEMORY, {"super": "rw,dax=always"}), "dax-inode": (MEMORY, {"super": "rw,dax=inode"}), "no-dax": (MEMORY, {"super": "rw"}),
            "two-dax": (MEMORY, {"super": "rw,dax=never,dax=always"}), "bare-dax": (MEMORY, {"super": "rw,dax=never,dax"}),
        }
        for name, (spec, changes) in cases.items():
            with self.subTest(name):
                path = self.dir / "mi"
                path.write_text(BASE_TABLE + mountinfo_line(0, spec, **changes))
                self.assertEqual(self.run_tool("check", path, "@ROOT@" + share_fields(spec)[3], spec).strip(), "-1")

    def test_a_mount_over_or_a_second_mount_of_the_tag_fails_the_check(self):
        path = self.dir / "mi"
        path.write_text(BASE_TABLE + mountinfo_line(0, MEMORY) + "60 41 0:70 / @ROOT@/workspace/.winter/memory rw,nosuid,nodev - tmpfs tmpfs rw\n")
        self.assertEqual(self.run_tool("check", path, "@ROOT@/workspace/.winter/memory", MEMORY).strip(), "-1")     # something mounted over the share
        path.write_text(BASE_TABLE + mountinfo_line(0, MEMORY) + mountinfo_line(1, MEMORY, mount_point="@ROOT@/workspace/repos"))
        self.assertEqual(self.run_tool("check", path, "@ROOT@/workspace/.winter/memory", MEMORY).strip(), "-1")     # the tag mounted a second time elsewhere
        path.write_text(BASE_TABLE)
        self.assertEqual(self.run_tool("check", path, "@ROOT@/workspace/.winter/memory", MEMORY).strip(), "-1")     # nothing there
        path.write_text(BASE_TABLE + "60 30 0:70 / @ROOT@/workspace/.winter/memory rw,nosuid,nodev - tmpfs tmpfs rw\n" + mountinfo_line(0, MEMORY))
        self.assertEqual(self.run_tool("check", path, "@ROOT@/workspace/.winter/memory", MEMORY).strip(), "-1")     # a well-formed share over something already there

    def test_another_tag_or_filesystem_at_the_path_fails_even_when_the_tag_is_mounted_once_elsewhere(self):
        elsewhere = mountinfo_line(1, MEMORY, mount_point="@ROOT@/workspace/repos")
        for name, changes in (("source", {"source": "winter-outputs"}), ("fstype", {"fstype": "tmpfs"})):
            with self.subTest(name):
                path = self.dir / "mi"
                path.write_text(BASE_TABLE + mountinfo_line(0, MEMORY, **changes) + elsewhere)
                self.assertEqual(self.run_tool("check", path, "@ROOT@/workspace/.winter/memory", MEMORY).strip(), "-1")

    # ---------------------------------------------------------------------------------------------- mount points

    def test_the_winter_mount_points_are_the_skeletons_and_are_never_made_here(self):
        for spec in (GUIDANCE, MEMORY, OUTPUTS):
            with self.subTest(spec):
                self.assertEqual(self.run_tool("point", self.root, spec).strip(), "0")
        shutil.rmtree(self.root / "workspace/outputs")
        self.assertEqual(self.run_tool("point", self.root, OUTPUTS).strip(), "-1")
        self.assertFalse((self.root / "workspace/outputs").exists())

    def test_a_folder_mount_point_is_made_once_root_only_below_workspace_folders_and_an_existing_one_is_left_as_it_is(self):
        before = self.modes()
        self.assertEqual(self.run_tool("point", self.root, FOLDER).strip(), "0")
        self.assertEqual(stat.S_IMODE((self.root / "workspace/folders/notes").stat().st_mode), 0o700)
        os.chmod(self.root / "workspace/folders/notes", 0o755)                         # a past boot's, whatever its mode: adopted, never chmodded
        self.assertEqual(self.run_tool("point", self.root, FOLDER).strip(), "0")
        self.assertEqual(stat.S_IMODE((self.root / "workspace/folders/notes").stat().st_mode), 0o755)
        after = self.modes()
        del after["workspace/folders/notes"]
        self.assertEqual(after, before)
        self.assertEqual(self.run_tool("point", self.root, "folder:0:src-0:/workspace/folders/a/b").strip(), "-1")
        self.assertFalse((self.root / "workspace/folders/a").exists())

    def test_a_link_or_a_file_on_the_way_is_refused_and_nothing_is_made_behind_it(self):
        outside = self.dir / "outside"
        outside.mkdir()
        os.chmod(outside, 0o755)
        (self.root / "workspace/folders/notes").symlink_to(outside)
        self.assertEqual(self.run_tool("point", self.root, FOLDER).strip(), "-1")
        (self.root / "workspace/folders/notes").unlink()
        (self.root / "workspace/folders/notes").write_text("x")
        self.assertEqual(self.run_tool("point", self.root, FOLDER).strip(), "-1")
        (self.root / "workspace/folders/notes").unlink()
        shutil.rmtree(self.root / "workspace/folders")
        (self.root / "workspace/folders").symlink_to(outside)
        self.assertEqual(self.run_tool("point", self.root, FOLDER).strip(), "-1")
        self.assertEqual((list(outside.iterdir()), stat.S_IMODE(outside.stat().st_mode)), ([], 0o755))

    def test_a_directory_on_the_way_that_is_not_pid_1s_is_refused(self):
        env = dict(os.environ, SHARES_OWNER=str(os.getuid() + 1))
        self.assertEqual(self.run_tool("point", self.root, MEMORY, env=env).strip(), "-1")
        self.assertEqual(self.run_tool("point", self.root, FOLDER, env=env).strip(), "-1")
        self.assertFalse((self.root / "workspace/folders/notes").exists())

    # ---------------------------------------------------------------------------------------------- the alias

    def test_the_guidance_alias_is_exactly_the_link_and_is_kept_across_boots(self):
        self.assertEqual(self.run_tool("alias", self.root).strip(), "0")
        alias = self.root / "workspace/.winter/WINTER.md"
        self.assertTrue(alias.is_symlink())
        self.assertEqual(os.readlink(alias), "/run/winter/shared-instructions/WINTER.md")
        self.assertEqual(self.run_tool("alias", self.root).strip(), "0")                # the next boot finds it and keeps it
        self.assertEqual(os.readlink(alias), "/run/winter/shared-instructions/WINTER.md")

    def test_anything_else_at_the_alias_is_refused_and_left_alone(self):
        alias = self.root / "workspace/.winter/WINTER.md"
        for make in (lambda: alias.symlink_to("/workspace/.winter/memory/WINTER.md"), lambda: alias.symlink_to("/run/winter/shared-instructions/WINTER.mdx"),
                     lambda: alias.write_text("guidance"), lambda: alias.mkdir()):
            with self.subTest(make):
                make()
                self.assertEqual(self.run_tool("alias", self.root).strip(), "-1")
                self.assertTrue(alias.is_symlink() or alias.exists())
                alias.rmdir() if alias.is_dir() and not alias.is_symlink() else alias.unlink()
        shutil.rmtree(self.root / "workspace/.winter")
        outside = self.dir / "elsewhere"
        outside.mkdir()
        (self.root / "workspace/.winter").symlink_to(outside)
        self.assertEqual(self.run_tool("alias", self.root).strip(), "-1")
        self.assertEqual(list(outside.iterdir()), [])

    # ---------------------------------------------------------------------------------------------- the whole step

    def step(self, specs, fail="-", table=None):
        out = self.run_tool("step", self.root, self.sys, table or self.table(specs), fail, *specs).splitlines()
        result = dict(part.split("=") for part in out[-1].split())
        return out[:-1], int(result["rc"]), int(result["mounted"])

    def test_the_whole_step_mounts_every_share_checks_the_table_and_makes_the_alias_in_that_order(self):
        self.fake_sysfs(self.tags(ALL))
        before = self.modes()
        events, rc, mounted = self.step(ALL)
        self.assertEqual((rc, mounted), (0, 0b11111))
        expected = []
        for spec in ALL:
            kind, ro, tag, path = share_fields(spec)
            flags = MS_NOSUID | MS_NODEV | (MS_RDONLY if ro else 0) | (MS_NOEXEC if kind != "folder" else 0)
            expected.append((tag, "virtiofs", str(flags), "dax=never", (self.root / path.lstrip("/")).stat().st_ino))
        mounts = [event.split(" ") for event in events if event.startswith("mount ")]
        self.assertEqual([(m[1], m[3], m[4], m[5], int(m[6].split("=")[1])) for m in mounts], expected)
        # each target is the descriptor of the mount point the walk checked, never a path resolved again
        self.assertTrue(all(re.fullmatch(r"/proc/self/fd/\d+", m[2]) for m in mounts), events)
        self.assertEqual(events[-1], "mountinfo")
        self.assertEqual(os.readlink(self.root / "workspace/.winter/WINTER.md"), "/run/winter/shared-instructions/WINTER.md")
        after = self.modes()
        for made in ("workspace/folders/notes", "workspace/folders/photos", "workspace/.winter/WINTER.md"):
            del after[made]
        self.assertEqual(after, before)                                                 # nothing that was there changed owner or mode

    def test_an_inventory_that_does_not_match_mounts_nothing_and_makes_nothing(self):
        self.fake_sysfs(self.tags(ALL[:-1]))
        before = self.modes()
        events, rc, mounted = self.step(ALL)
        self.assertEqual((events, rc, mounted), ([], 1, 0))
        self.assertEqual(self.modes(), before)

    def test_a_mount_that_fails_unmounts_what_was_mounted_last_first(self):
        self.fake_sysfs(self.tags(ALL))
        events, rc, mounted = self.step(ALL, fail="mount:3")
        self.assertEqual((rc, mounted), (2, 0))
        self.assertEqual([e for e in events if e.startswith("umount")], [f"umount {self.root}/workspace/folders/photos", f"umount {self.root}/workspace/folders/notes"])
        self.assertNotIn("mountinfo", events)
        self.assertFalse((self.root / "workspace/.winter/WINTER.md").exists())

    def test_what_the_rollback_could_not_unmount_is_reported_mounted(self):
        self.fake_sysfs(self.tags(ALL))
        events, rc, mounted = self.step(ALL, fail="umount", table=self.table(ALL[:-1]))   # the table lacks the last share
        self.assertEqual((rc, mounted), (2, 0b11111))

    def test_a_table_that_does_not_show_every_share_as_required_undoes_the_step(self):
        self.fake_sysfs(self.tags(ALL))
        for name, table in (("missing", self.table(ALL[:-1])), ("dax", self.table(ALL, super="rw,dax=always")), ("unreadable", None)):
            with self.subTest(name):
                events, rc, mounted = self.step(ALL, fail="mountinfo" if table is None else "-", table=table or self.table(ALL))
                self.assertEqual((rc, mounted), (2, 0))
                self.assertEqual(len([e for e in events if e.startswith("umount")]), len(ALL))
                self.assertFalse((self.root / "workspace/.winter/WINTER.md").is_symlink())

    def test_a_mount_point_that_is_not_in_place_mounts_nothing(self):
        self.fake_sysfs(self.tags(ALL))
        shutil.rmtree(self.root / "workspace/outputs")
        events, rc, mounted = self.step(ALL)
        self.assertEqual((events, rc, mounted), ([], 2, 0))

    def test_an_alias_that_cannot_be_made_undoes_the_step(self):
        self.fake_sysfs(self.tags(ALL))
        (self.root / "workspace/.winter/WINTER.md").write_text("not the alias")
        events, rc, mounted = self.step(ALL)
        self.assertEqual((rc, mounted), (2, 0))
        self.assertEqual(len([e for e in events if e.startswith("umount")]), len(ALL))

    def test_a_mount_point_swapped_after_the_walk_is_not_what_gets_mounted(self):
        """The descriptor pins the directory the walk checked: what a path would name at mount time does not matter."""
        self.fake_sysfs(self.tags([FOLDER]))
        point = self.root / "workspace/folders/notes"
        point.mkdir()
        checked = point.stat().st_ino
        env = dict(os.environ, SHARES_SWAP=str(point))
        out = self.run_tool("step", self.root, self.sys, self.table([FOLDER]), "-", FOLDER, env=env).splitlines()
        mount = next(event for event in out if event.startswith("mount "))
        self.assertNotEqual(point.stat().st_ino, checked)                                # the path now names another directory
        self.assertEqual(int(mount.split(" ")[6].split("=")[1]), checked)                 # and the mount still landed on the checked one
        self.assertNotIn(str(self.root), mount)

    def test_without_the_guidance_share_no_alias_is_made(self):
        specs = [FOLDER, MEMORY]
        self.fake_sysfs(self.tags(specs))
        events, rc, mounted = self.step(specs)
        self.assertEqual((rc, mounted), (0, 0b11))
        self.assertFalse((self.root / "workspace/.winter/WINTER.md").exists())

    # ---------------------------------------------------------------------------------------------- the source itself

    def test_nothing_in_the_share_step_changes_an_owner_a_mode_or_an_attribute(self):
        code = re.sub(r"/\*.*?\*/", "", (INIT / "shares.c").read_text(), flags=re.S)
        for needle in ("chown", "chmod", "setxattr", "utime", "truncate", "unlink", "rename", "umask(", "O_CREAT", "O_WRONLY", "O_RDWR"):
            self.assertNotIn(needle, code, needle)
        # the one directory it may make is a folder's mount point, and only through mkdirat in the descriptor walk
        self.assertEqual(len(re.findall(r"\bmkdirat\(", code)), 1)
        self.assertEqual(len(re.findall(r"\bsymlinkat\(", code)), 1)

    def test_the_derived_virtio_fs_table_passes_and_its_dax_line_is_what_the_check_needs(self):
        """tests/virtiofs-mountinfo-v6.18.json: the table PID 1 should read, assembled from the v6.18 source of the functions that print it (NOT captured: G7 checks
        the live table). Every share passes as it is, and fails once its DAX option is anything but `never`."""
        fixture = json.loads((HERE / "virtiofs-mountinfo-v6.18.json").read_text())
        self.assertIs(fixture["captured"], False)
        self.assertEqual({entry["file"] for entry in fixture["derivedFrom"]}, {"fs/proc_namespace.c", "fs/fuse/inode.c", "fs/fuse/virtio_fs.c", "fs/fuse/dax.c"})
        path = self.dir / "fixture"
        path.write_text("".join(line + "\n" for line in fixture["lines"]))
        for spec in ALL:
            with self.subTest(spec):
                self.assertEqual(self.run_tool("check", path, share_fields(spec)[3], spec).strip(), "0")
        for replacement in ("dax=always", "dax=inode", "dax"):
            path.write_text("".join(line.replace("dax=never", replacement) + "\n" for line in fixture["lines"]))
            for spec in ALL:
                self.assertEqual(self.run_tool("check", path, share_fields(spec)[3], spec).strip(), "-1", (replacement, spec))

    def test_the_check_for_any_filesystem_holds_its_data_option_to_one_value(self):
        path = self.dir / "mi"
        path.write_text(BASE_TABLE + mountinfo_line(0, MEMORY, fstype="tmpfs", super="rw,nr_inodes=4096,inode64"))
        where = "@ROOT@/workspace/.winter/memory"
        self.assertEqual(self.run_tool("checkas", path, where, MEMORY, "tmpfs", "winter-memory", "nr_inodes=4096").strip(), "0")
        for fstype, source, data in (("tmpfs", "winter-memory", "nr_inodes=8192"), ("virtiofs", "winter-memory", "nr_inodes=4096"), ("tmpfs", "winter-outputs", "nr_inodes=4096"),
                                     ("tmpfs", "winter-memory", "=4096")):
            self.assertEqual(self.run_tool("checkas", path, where, MEMORY, fstype, source, data).strip(), "-1", (fstype, source, data))
        path.write_text(BASE_TABLE + mountinfo_line(0, MEMORY, fstype="tmpfs", super="rw,nr_inodes=4096,nr_inodes=8192"))
        self.assertEqual(self.run_tool("checkas", path, where, MEMORY, "tmpfs", "winter-memory", "nr_inodes=4096").strip(), "-1")

    def test_the_helper_and_pid_1_read_the_same_share_set(self):
        vectors = {v["name"]: bytes.fromhex(v["hex"]) for v in json.loads((ROOT / "vectors/mux-frames.json").read_text())["positive"]}
        previous = gb.set_revision_three(True)
        self.addCleanup(gb.set_revision_three, previous)
        message = gb.parse_bootstrap_message(vectors["bootstrap-down-shares"][16:], "down")
        out = self.run_tool("parse", gb.shares_payload(message).hex()).splitlines()
        self.assertEqual(int(out[0]), len(message["shares"]))
        self.assertEqual(out[1:], ["%s:%d:%s:%s" % (s["kind"], s["readOnly"], s["tag"], s["guestPath"]) for s in message["shares"]])
        self.assertEqual(self.run_tool("parse", "").strip(), "refused")


@unittest.skipUnless(CC, "no C compiler")
class BootShareTests(unittest.TestCase):
    def test_every_native_case_passes(self):
        folder = Path(tempfile.mkdtemp(prefix="guest-boot-shares-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        binary = build([HERE / "test_boot_shares.c", INIT / "boot.c", INIT / "mounts.c", INIT / "ext4sb.c", INIT / "trusted_config.c", ROOT / "common/wmx.c", ROOT / "common/ctl.c"],
                       folder / "test_boot_shares", extra=FLAG)
        result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=120)
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAIL") or line.startswith("      ")]
        self.assertEqual(failed, [], result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(re.findall(r"^PASS ", result.stdout, flags=re.M)), 11)


class ProductionHasNoShareStepTests(unittest.TestCase):
    """The share step is revision 3, which only an image that declares `file-channel-v1` speaks: every share name in a production source sits inside the gate, and the
    production build lists neither shares.c nor shares.h."""
    NAMES = ("CTL_HELPER_SHARES", "CTL_SHARES_RESULT", "wg_share", "WG_SHARE", "WG_SHARES", "mount_shares", "umount_share", "shares_mounted", "shares_state", "shares.h",
             "BQMECS", "SHARES_ROOT", "SHARES_SYS_ROOT", "MOUNTINFO_PATH", "virtiofs")
    SOURCES = ("init/init_linux.c", "init/boot.c", "init/boot.h", "init/trusted_config.c", "init/trusted_config.h", "common/ctl.h", "common/wmx.c", "common/wmx.h", "relay/relay.c")

    def test_every_share_name_in_a_production_source_is_inside_the_gate(self):
        from test_filechannel import ProductionHasNoFileChannelTests
        scanner = ProductionHasNoFileChannelTests()
        for relative in self.SOURCES:
            for number, line in scanner.ungated_lines(relative):
                for name in self.NAMES:
                    self.assertNotIn(name, line, f"{relative}:{number} names {name} outside WG_FILE_CHANNEL_V1")

    def test_the_share_paths_and_owner_are_the_real_ones_unless_the_native_test_build_overrides_them(self):
        """SHARES_OWNER (and the three paths) exist for tests/linux_init_tool.c only: PID 1's walk accepts root's directories and nothing else, and the image build
        passes no override (build.py, whose flags are the only ones the image's programs are compiled with)."""
        init = (ROOT / "init/init_linux.c").read_text()
        for name, value in (("SHARES_ROOT", ""), ("SHARES_SYS_ROOT", "/sys"), ("MOUNTINFO_PATH", "/proc/self/mountinfo")):
            self.assertIn(f'#ifndef {name}\n#define {name} "{value}"\n#endif', init)
        self.assertIn("#ifndef SHARES_OWNER\n#define SHARES_OWNER 0\n#endif", init)
        self.assertEqual(len(re.findall(r"#define SHARES_OWNER\b", init)), 1)
        self.assertIn("sop_read_mountinfo, (uid_t)SHARES_OWNER };", init)
        build_py = (ROOT / "build.py").read_text()
        self.assertNotRegex(build_py, r"SHARES_ROOT|SHARES_SYS_ROOT|MOUNTINFO_PATH|SHARES_OWNER")
        self.assertNotIn("-D", re.search(r"COMMON_FLAGS = \[(.*?)\]", build_py).group(1))
        self.assertEqual(re.search(r'FILE_CHANNEL_FLAG = "(.*?)"', build_py).group(1), "-DWG_FILE_CHANNEL_V1")

    def test_pid_1_mounts_shares_only_as_virtio_fs_with_dax_never(self):
        """wg_mount_shares_as (another filesystem type and data option) exists for the root-only CI test; PID 1 calls wg_mount_shares, which is virtiofs and dax=never."""
        init = re.sub(r"/\*.*?\*/", "", (ROOT / "init/init_linux.c").read_text(), flags=re.S)
        self.assertNotIn("wg_mount_shares_as", init)
        self.assertEqual(len(re.findall(r"\bwg_mount_shares\(", init)), 1)
        shares = (INIT / "shares.c").read_text()
        self.assertIn("return wg_mount_shares_as(ops, set, mounted, WG_SHARE_FSTYPE, WG_SHARE_MOUNT_DATA);", shares)
        self.assertIn("return wg_mountinfo_entry_ok(text, length, where, share, WG_SHARE_FSTYPE, share->tag, WG_SHARE_MOUNT_DATA);", shares)
        header = (INIT / "shares.h").read_text()
        self.assertIn('#define WG_SHARE_FSTYPE "virtiofs"', header)
        self.assertIn('#define WG_SHARE_MOUNT_DATA "dax=never"', header)

    def test_the_share_step_is_under_the_no_network_scan(self):
        """test_hygiene.py's scan for any network bring-up (no socket, no AF_VSOCK, no interface) covers the new module too: shares are virtio-fs, never a NIC or vsock."""
        from test_hygiene import C_FILES
        self.assertIn(INIT / "shares.c", C_FILES)
        self.assertIn(INIT / "shares.h", C_FILES)

    def test_the_production_build_lists_neither_file(self):
        build_py = (ROOT / "build.py").read_text()
        programs = re.search(r"PROGRAMS = \{(.*?)\n\}", build_py, re.S).group(1)
        headers = re.search(r"\nHEADERS = \[(.*?)\]", build_py, re.S).group(1)
        self.assertNotIn("shares", programs + headers)
        self.assertIn('"init/shares.c"', re.search(r"FILE_CHANNEL_PROGRAMS = \{(.*?)\n\}", build_py, re.S).group(1))
        self.assertIn('"init/shares.h"', re.search(r"FILE_CHANNEL_HEADERS = \[(.*?)\]", build_py, re.S).group(1))


if __name__ == "__main__":
    unittest.main()
