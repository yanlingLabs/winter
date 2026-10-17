"""Native tests of the PID 1 modules: discovery, superblock check, skeleton, trusted config, and the boot / drain state machine.
Run as:  python3 -I -S -B -m unittest discover -s apple/Cowork/WinterCoworkGuest/tests -p 'test_*.py'

The C code is built with the host compiler (sanitizers when available). Fake sysfs/dev trees are made in a temp directory; the
device-node examination is a table because an unprivileged process cannot create a block or character device.
"""
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
from superblock_fixture import make_sb  # noqa: E402

UUID_A = "11111111-2222-4333-8444-555555555555"
MIB = 1024 * 1024
EXTRA = ["-D_DEFAULT_SOURCE"]


@unittest.skipUnless(CC, "no C compiler")
class InitModuleCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = Path(tempfile.mkdtemp(prefix="guest-init-"))
        init = ROOT / "init"
        cls.tool = build([ROOT / "tests/init_tool.c", init / "discover.c", init / "ext4sb.c", init / "skeleton.c", init / "trusted_config.c"],
                         cls.folder / "init_tool", extra=EXTRA)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-init-case-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def run_tool(self, *args):
        result = subprocess.run([str(self.tool), *map(str, args)], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return result.stdout.rstrip("\n")


# ---------------------------------------------------------------------------------------------------- discovery

class FakeSysfs:
    def __init__(self, root):
        self.sys = Path(root) / "sys"
        self.dev = Path(root) / "dev"
        self.stats = []
        self.sys.mkdir()
        self.dev.mkdir()
        (self.sys / "block").mkdir()

    def disk(self, name, serial, major, minor, subsystem="virtio", node=True, node_kind="b", node_major=None, node_minor=None, write_serial=True):
        base = self.sys / "block" / name
        (base / "device").mkdir(parents=True)
        os.symlink(f"../../../../../bus/{subsystem}", base / "device/subsystem")
        if write_serial:
            (base / "serial").write_text(serial + "\n")
        (base / "dev").write_text(f"{major}:{minor}\n")
        if node:
            self.stats.append(f"{self.dev / name} {node_kind} {major if node_major is None else node_major} {minor if node_minor is None else node_minor}")

    def loop(self, name="loop0"):
        (self.sys / "block" / name).mkdir()
        (self.sys / "block" / name / "dev").write_text("7:0\n")

    def console(self, index=1, device="0x0003", features=None, driver="virtio_console"):
        features = features if features is not None else "".join("1" if bit in (1, 32) else "0" for bit in range(128))
        base = self.sys / "bus/virtio/devices" / f"virtio{index}"
        base.mkdir(parents=True)
        (base / "device").write_text(device + "\n")
        (base / "features").write_text(features + "\n")
        if driver:
            os.symlink(f"../../../../bus/virtio/drivers/{driver}", base / "driver")

    def port(self, index=1, name=None, major=249, minor=0, parent=None, node=True, node_kind="c", node_major=None, node_minor=None):
        name = name or f"vport{index}p0"
        base = self.sys / "class/virtio-ports" / name
        base.mkdir(parents=True)
        os.symlink(f"../../../bus/virtio/devices/{parent or f'virtio{index}'}", base / "device")
        (base / "dev").write_text(f"{major}:{minor}\n")
        if node:
            self.stats.append(f"{self.dev / name} {node_kind} {major if node_major is None else node_major} {minor if node_minor is None else node_minor}")

    def stat_file(self):
        path = self.sys.parent / "stats.txt"
        path.write_text("\n".join(self.stats) + "\n")
        return path


class DiscoveryTests(InitModuleCase):
    def fake(self):
        return FakeSysfs(self.dir)

    def disks(self, fake):
        return self.run_tool("disks", fake.sys, fake.dev, fake.stat_file())

    def good_disks(self, fake):
        fake.disk("vda", "winter-data", 254, 0)
        fake.disk("vdb", "winter-environment", 254, 16)

    def test_the_two_disks_are_found_by_serial_in_either_probe_order(self):
        for swap in (False, True):
            root = Path(tempfile.mkdtemp(dir=self.dir))
            fake = FakeSysfs(root)
            fake.disk("vda", "winter-environment" if swap else "winter-data", 254, 0)
            fake.disk("vdb", "winter-data" if swap else "winter-environment", 254, 16)
            out = self.disks(fake).split("|")
            self.assertEqual(out[0], "ok")
            data_part, environment_part = out[2], out[3]
            if swap:
                self.assertEqual(data_part, f"{fake.dev}/vdb 254:16 winter-data")
                self.assertEqual(environment_part, f"{fake.dev}/vda 254:0 winter-environment")
            else:
                self.assertEqual(data_part, f"{fake.dev}/vda 254:0 winter-data")

    def test_loop_and_ram_devices_are_not_ours(self):
        fake = self.fake()
        self.good_disks(fake)
        fake.loop("loop0")
        fake.loop("loop1")
        self.assertTrue(self.disks(fake).startswith("ok|"))

    def test_a_non_virtio_disk_with_one_of_our_serials_is_ignored_not_adopted(self):
        fake = self.fake()
        fake.disk("sda", "winter-data", 8, 0, subsystem="scsi")
        fake.disk("vdb", "winter-environment", 254, 16)
        self.assertEqual(self.disks(fake), "not-yet|disk-missing")

    def test_an_unexpected_virtio_disk_is_refused(self):
        fake = self.fake()
        self.good_disks(fake)
        fake.disk("vdc", "something-else", 254, 32)
        out = self.disks(fake)
        self.assertTrue(out.startswith("refused|"), out)

    def test_a_wrong_serial_is_refused(self):
        fake = self.fake()
        fake.disk("vda", "winter-data", 254, 0)
        fake.disk("vdb", "winter-datb", 254, 16)
        self.assertEqual(self.disks(fake), "refused|unexpected-virtio-disk")

    def test_the_same_serial_twice_is_refused(self):
        fake = self.fake()
        fake.disk("vda", "winter-data", 254, 0)
        fake.disk("vdb", "winter-data", 254, 16)
        self.assertEqual(self.disks(fake), "refused|duplicate-serial")

    def test_a_missing_disk_is_not_yet(self):
        fake = self.fake()
        fake.disk("vda", "winter-data", 254, 0)
        self.assertEqual(self.disks(fake), "not-yet|disk-missing")
        self.assertEqual(self.run_tool("disks", fake.sys / "nowhere", fake.dev, fake.stat_file()), "not-yet|no-block-class")

    def test_a_third_virtio_disk_is_refused_even_with_a_good_serial(self):
        fake = self.fake()
        self.good_disks(fake)
        fake.disk("vdc", "winter-data", 254, 32)
        out = self.disks(fake)
        self.assertTrue(out.startswith("refused|"), out)

    def test_the_node_must_exist_and_be_that_exact_block_device(self):
        fake = self.fake()
        fake.disk("vda", "winter-data", 254, 0, node=False)
        fake.disk("vdb", "winter-environment", 254, 16)
        self.assertEqual(self.disks(fake), "not-yet|node-missing")
        for kwargs in ({"node_kind": "c"}, {"node_major": 253}, {"node_minor": 1}, {"node_kind": "f"}):
            with self.subTest(kwargs):
                root = Path(tempfile.mkdtemp(dir=self.dir))
                fake = FakeSysfs(root)
                fake.disk("vda", "winter-data", 254, 0, **kwargs)
                fake.disk("vdb", "winter-environment", 254, 16)
                self.assertEqual(self.disks(fake), "refused|node-identity")

    def test_a_disk_without_a_serial_yet_is_not_yet(self):
        fake = self.fake()
        fake.disk("vda", "winter-data", 254, 0, write_serial=False)
        self.assertEqual(self.disks(fake), "not-yet|no-serial")

    def test_an_odd_name_on_a_virtio_disk_is_refused_and_on_anything_else_ignored(self):
        fake = self.fake()
        self.good_disks(fake)
        fake.disk("dm-0", "whatever", 253, 0, subsystem="block")        # a device-mapper node: not ours, not an error
        fake.loop("loop-control")
        self.assertTrue(self.disks(fake).startswith("ok|"))
        fake.disk("VDX", "winter-data", 254, 48)                        # but a virtio disk with a name we cannot trust is
        self.assertEqual(self.disks(fake), "refused|block-name")

    # ---- the port

    def port(self, fake):
        return self.run_tool("port", fake.sys, fake.dev, fake.stat_file())

    def test_the_single_generic_port_is_found(self):
        fake = self.fake()
        fake.console(1)
        fake.port(1)
        self.assertEqual(self.port(fake), f"ok||{fake.dev}/vport1p0 249:0")

    def test_the_console_index_decides_the_port_name(self):
        fake = self.fake()
        fake.console(3)
        fake.port(3)
        self.assertEqual(self.port(fake), f"ok||{fake.dev}/vport3p0 249:0")

    def test_two_consoles_are_refused(self):
        fake = self.fake()
        fake.console(1)
        fake.console(2)
        fake.port(1)
        self.assertEqual(self.port(fake), "refused|second-console")

    def test_a_non_console_virtio_device_is_ignored(self):
        fake = self.fake()
        fake.console(1)
        fake.console(2, device="0x0002")
        fake.port(1)
        self.assertTrue(self.port(fake).startswith("ok|"))

    def test_the_feature_bits_are_exact(self):
        for features in ("0" * 128, "".join("1" if bit in (1, 32, 5) else "0" for bit in range(128)), "1" * 127, ""):
            with self.subTest(len(features)):
                root = Path(tempfile.mkdtemp(dir=self.dir))
                fake = FakeSysfs(root)
                fake.console(1, features=features)
                fake.port(1)
                self.assertEqual(self.port(fake), "refused|console-features")

    def test_the_driver_must_be_virtio_console(self):
        fake = self.fake()
        fake.console(1, driver="virtio_other")
        fake.port(1)
        self.assertEqual(self.port(fake), "refused|console-driver")
        root = Path(tempfile.mkdtemp(dir=self.dir))
        fake = FakeSysfs(root)
        fake.console(1, driver=None)
        fake.port(1)
        self.assertEqual(self.port(fake), "not-yet|console-not-bound")

    def test_exactly_one_port_with_the_right_name_parent_and_numbers(self):
        cases = (("extra port", lambda f: (f.port(1), f.port(1, name="vport1p1", minor=1)), "refused|port-inventory"),
                 ("wrong name", lambda f: f.port(1, name="vport9p0"), "refused|port-inventory"),
                 ("wrong parent", lambda f: (f.console(2, device="0x0002"), f.port(1, parent="virtio2")), "refused|port-parent"),
                 ("minor not zero", lambda f: f.port(1, minor=3), "refused|port-dev"),
                 ("major zero", lambda f: f.port(1, major=0), "refused|port-dev"))
        for label, setup, expected in cases:
            with self.subTest(label):
                root = Path(tempfile.mkdtemp(dir=self.dir))
                fake = FakeSysfs(root)
                fake.console(1)
                setup(fake)
                self.assertEqual(self.port(fake), expected)

    def test_a_missing_port_or_node_is_not_yet_and_a_wrong_node_is_refused(self):
        fake = self.fake()
        fake.console(1)
        (fake.sys / "class/virtio-ports").mkdir(parents=True)
        self.assertEqual(self.port(fake), "not-yet|no-port")
        root = Path(tempfile.mkdtemp(dir=self.dir))
        fake = FakeSysfs(root)
        fake.console(1)
        fake.port(1, node=False)
        self.assertEqual(self.port(fake), "not-yet|node-missing")
        for kwargs in ({"node_kind": "b"}, {"node_major": 1}, {"node_minor": 2}):
            root = Path(tempfile.mkdtemp(dir=self.dir))
            fake = FakeSysfs(root)
            fake.console(1)
            fake.port(1, **kwargs)
            self.assertEqual(self.port(fake), "refused|node-identity")

    def test_no_virtio_bus_is_not_yet(self):
        fake = self.fake()
        self.assertEqual(self.port(fake), "not-yet|no-virtio-bus")
        (fake.sys / "bus/virtio/devices").mkdir(parents=True)
        self.assertEqual(self.port(fake), "not-yet|no-console")


# ---------------------------------------------------------------------------------------------------- superblock check

class Ext4CheckTests(InitModuleCase):
    def node(self, sb, name="v.img"):
        path = self.dir / name
        with open(path, "wb") as handle:
            handle.truncate(16 * MIB)
            handle.seek(1024)
            handle.write(sb)
        return path

    def check(self, sb, uuid=UUID_A):
        return self.run_tool("ext4", self.node(sb), uuid)

    def test_a_clean_matching_superblock_passes(self):
        self.assertEqual(self.check(make_sb()), "ok")

    def test_each_defect_has_its_own_refusal(self):
        self.assertEqual(self.check(make_sb(magic=0xEF54)), "magic")
        self.assertEqual(self.check(make_sb(log_block_size=0)), "geometry")
        self.assertEqual(self.check(make_sb(rev=0)), "geometry")
        self.assertEqual(self.check(make_sb(break_checksum=True)), "checksum")
        self.assertEqual(self.check(make_sb(checksum_type=0)), "checksum")
        self.assertEqual(self.check(make_sb(), "99999999-2222-4333-8444-555555555555"), "uuid")
        self.assertEqual(self.check(make_sb(incompat=0x4)), "recovery")
        self.assertEqual(self.check(make_sb(state=0)), "not-clean")
        self.assertEqual(self.check(make_sb(state=3)), "not-clean")

    def test_a_short_or_missing_node_is_an_io_error(self):
        path = self.dir / "short"
        path.write_bytes(b"\0" * 1500)
        self.assertEqual(self.run_tool("ext4", path, UUID_A), "io")
        self.assertEqual(self.run_tool("ext4", self.dir / "absent", UUID_A), "io")

    def test_the_uuid_must_be_well_formed(self):
        self.assertEqual(self.run_tool("ext4", self.node(make_sb()), "NOT-A-UUID"), "bad-uuid")

    def test_uuid_parsing(self):
        self.assertEqual(self.run_tool("uuid", UUID_A), "11111111222243338444555555555555")
        for bad in ("11111111-2222-4333-8444-55555555555", "11111111_2222-4333-8444-555555555555", "1111111G-2222-4333-8444-555555555555",
                    "11111111-2222-4333-8444-5555555555555", "11111111-2222-4333-8444-55555555555A"):
            self.assertEqual(self.run_tool("uuid", bad), "bad", bad)

    def test_the_crc_matches_the_python_implementation_and_the_standard_vector(self):
        self.assertEqual(self.run_tool("crc", "123456789"), "1cf96d7c")
        self.assertEqual(int(self.run_tool("crc", "123456789"), 16), gb.crc32c_raw(b"123456789"))

    def test_a_real_mke2fs_image_passes_when_a_formatter_exists(self):
        mke2fs = shutil.which("mke2fs") or (os.path.expanduser("~/Library/Android/sdk/platform-tools/mke2fs") if sys.platform == "darwin" else None)
        if not mke2fs or not os.path.exists(mke2fs):
            self.skipTest("no mke2fs on this machine")
        path = self.dir / "real.img"
        with open(path, "wb") as handle:
            handle.truncate(16 * MIB)
        subprocess.run([mke2fs, *gb.mke2fs_args(UUID_A, True), str(path)], env=dict(gb.TOOL_ENV), check=True, capture_output=True)
        self.assertEqual(self.run_tool("ext4", path, UUID_A), "ok")


# ---------------------------------------------------------------------------------------------------- skeleton

class SkeletonTests(InitModuleCase):
    WORKSPACE = [".winter", ".winter/conversations", ".winter/scratch", ".winter/memory", "repos", "folders", "outputs"]
    RUN = ["winter", "winter/control", "winter/conversations", "winter/shared-instructions", "winter/trusted"]

    def mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def test_the_workspace_skeleton_is_created_with_the_documented_modes_and_ownership_calls(self):
        root = self.dir / "ws"
        root.mkdir()
        out = self.run_tool("skeleton", root, "ws")
        self.assertEqual(out, "rc=0 chown=8 last=0:0 max=0:0")   # eight entries (root plus seven), every one chowned to root:root
        self.assertEqual(self.mode(root), 0o711)
        for rel in self.WORKSPACE:
            self.assertTrue((root / rel).is_dir(), rel)
            self.assertEqual(self.mode(root / rel), 0o711, rel)

    def test_the_run_skeleton_modes(self):
        root = self.dir / "run"
        root.mkdir()
        self.assertEqual(self.run_tool("skeleton", root, "run"), "rc=0 chown=5 last=0:0 max=0:0")
        self.assertEqual(self.mode(root / "winter/trusted"), 0o700)
        self.assertEqual(self.mode(root / "winter/control"), 0o711)
        self.assertEqual(self.mode(root / "winter/shared-instructions"), 0o755)

    def test_it_is_idempotent_and_repairs_modes(self):
        root = self.dir / "ws"
        root.mkdir()
        self.run_tool("skeleton", root, "ws")
        os.chmod(root / ".winter", 0o777)
        (root / "repos/keep.txt").write_text("user data")
        self.assertEqual(self.run_tool("skeleton", root, "ws"), "rc=0 chown=8 last=0:0 max=0:0")
        self.assertEqual(self.mode(root / ".winter"), 0o711)
        self.assertEqual((root / "repos/keep.txt").read_text(), "user data")

    def test_a_symlink_where_a_directory_belongs_is_refused_without_following_it(self):
        root = self.dir / "ws"
        root.mkdir()
        outside = self.dir / "outside"
        outside.mkdir()
        os.symlink(outside, root / ".winter")
        out = self.run_tool("skeleton", root, "ws")
        self.assertEqual(out.split()[0], "rc=2")           # entry 1 is the root itself; entry 2 is .winter
        self.assertEqual(list(outside.iterdir()), [])

    def test_a_file_where_a_directory_belongs_is_refused(self):
        root = self.dir / "ws"
        root.mkdir()
        (root / "repos").write_text("file")
        os.chmod(root / "repos", 0o640)
        out = self.run_tool("skeleton", root, "ws")
        self.assertEqual(out.split()[0], "rc=6")
        self.assertEqual(stat.S_IMODE(os.stat(root / "repos").st_mode), 0o640)   # refused before anything was changed on it

    def test_a_symlinked_parent_is_refused_for_a_child(self):
        root = self.dir / "ws"
        root.mkdir()
        outside = self.dir / "outside"
        outside.mkdir()
        os.symlink(outside, root / ".winter")
        self.assertNotEqual(self.run_tool("skeleton-custom", root, ".winter/conversations", "711"), "rc=0")
        self.assertEqual(list(outside.iterdir()), [])

    def test_a_child_listed_before_its_parent_is_an_error_not_a_tree(self):
        root = self.dir / "ws"
        root.mkdir()
        self.assertEqual(self.run_tool("skeleton-custom", root, "a/b", "755"), "rc=1")
        self.assertFalse((root / "a").exists())

    def test_bad_path_components_are_refused(self):
        root = self.dir / "ws"
        (root / "a").mkdir(parents=True)
        for path in ("../x", "a/../b", "a//b", "/abs", "a/./b", "a/b c", "a/" + "x" * 65, ""):
            with self.subTest(path):
                self.assertEqual(self.run_tool("skeleton-custom", root, path, "755"), "rc=1")

    def test_an_ownership_failure_stops_at_that_entry(self):
        root = self.dir / "ws"
        root.mkdir()
        out = self.run_tool("skeleton", root, "ws", "3")
        self.assertEqual(out.split()[0], "rc=3")
        self.assertTrue((root / ".winter").exists())
        self.assertFalse((root / ".winter/scratch").exists())


# ---------------------------------------------------------------------------------------------------- trusted config

class TrustedConfigTests(InitModuleCase):
    BOOT = "66666666-6666-4666-8666-666666666666"

    def build_config(self, base, conversations, boot=None, capacity=None):
        base_path, conv_path = self.dir / "base.json", self.dir / "conv.json"
        base_path.write_text(base)
        conv_path.write_text(conversations)
        extra = [] if capacity is None else [str(capacity)]
        code, _, text = self.run_tool("config", self.BOOT if boot is None else boot, base_path, conv_path, *extra).partition("|")
        return int(code), text

    def test_the_boot_id_and_conversations_are_spliced_into_the_static_part(self):
        base = json.dumps({"artifacts": {"launcher": {"path": "/opt/x", "sha256": "0" * 64}}, "controlDirectory": "/run/winter/control", "environment": "/e"}, separators=(",", ":"), sort_keys=True)
        code, text = self.build_config(base, '[{"logicalSessionId":"s1"}]')
        self.assertEqual(code, 0)
        parsed = json.loads(text)
        self.assertEqual(parsed["guestBootId"], self.BOOT)
        self.assertEqual(parsed["conversations"], [{"logicalSessionId": "s1"}])
        self.assertEqual(parsed["artifacts"], json.loads(base)["artifacts"])
        self.assertEqual(set(parsed), {"guestBootId", "conversations", "artifacts", "controlDirectory", "environment"})
        self.assertEqual(text.count('"guestBootId"'), 1)

    def test_an_empty_static_part_gives_no_stray_comma(self):
        code, text = self.build_config("{}", "[]")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(text), {"guestBootId": self.BOOT, "conversations": []})

    def test_the_static_part_cannot_name_the_keys_pid_1_supplies(self):
        for base in ('{"guestBootId":"x"}', '{"conversations":[]}', '{"a":1,"guestBootId":2}', '{"a":1,"conversations":[]}', '{"conversations" :1}',
                     '{"guest\\u0042ootId":"x"}', '{"conv\\u0065rsations":[]}', '{"b":[1],"conversations":{}}'):
            with self.subTest(base):
                self.assertEqual(self.build_config(base, "[]")[0], 3)

    def test_the_words_are_fine_as_values_and_in_nested_objects(self):
        base = '{"protectedStoreDirectories":["/workspace/.winter/conversations","/run/winter/conversations"],"nested":{"conversations":1,"guestBootId":2},"note":"guestBootId"}'
        code, text = self.build_config(base, "[]")
        self.assertEqual(code, 0)
        parsed = json.loads(text)
        self.assertEqual(parsed["guestBootId"], self.BOOT)
        self.assertEqual(parsed["conversations"], [])
        self.assertEqual(parsed["nested"], {"conversations": 1, "guestBootId": 2})
        self.assertEqual(parsed["protectedStoreDirectories"][0], "/workspace/.winter/conversations")

    def test_shape_errors_are_refused(self):
        bad_base = ("", "{", "[]", '{"a":1}x', 'x{"a":1}', '{"a":1}{"b":2}', '{}{}', '{"a":1}\n{"b":2}', '{"a":"\xe9"}', '{"a":1}}', '{"a":"unterminated}', "{" * 40 + "}" * 40)
        for base in bad_base:
            with self.subTest(base[:20]):
                self.assertEqual(self.build_config(base, "[]")[0], 2)
        for conversations in ("", "[", "{}", "[1]x", "[\"a\"]\n", "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]"):
            with self.subTest(conversations[:20]):
                self.assertEqual(self.build_config("{}", conversations)[0], 4)

    def test_braces_inside_strings_do_not_count(self):
        code, text = self.build_config('{"a":"}{"}', '["]["]')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(text)["a"], "}{")

    def test_the_boot_id_must_be_a_lowercase_uuid(self):
        for bad in ("", "66666666-6666-4666-8666-66666666666", "66666666-6666-4666-8666-66666666666G", "66666666-6666-4666-8666-66666666666A", "x" * 36):
            self.assertEqual(self.build_config("{}", "[]", bad)[0], 1)

    def test_size_limits(self):
        big = '{"k":"' + "a" * 8200 + '"}'
        self.assertEqual(self.build_config(big, "[]")[0], 2)
        many = "[" + ",".join(['"' + "b" * 90 + '"'] * 540) + "]"   # about 50 KiB: above the 48 KiB conversation-set ceiling
        self.assertEqual(self.build_config("{}", many)[0], 4)
        within = "[" + ",".join(['"' + "b" * 90 + '"'] * 500) + "]"
        self.assertEqual(self.build_config("{}", within)[0], 0)

    def test_a_buffer_too_small_for_the_whole_config_is_refused_before_anything_is_copied(self):
        whole = len('{"guestBootId":"' + self.BOOT + '","conversations":[]}')
        self.assertEqual(self.build_config("{}", "[]", capacity=whole + 1)[0], 0)
        # long enough for the opening text that snprintf writes first, too short for the rest: only the up-front size check stops the copy
        for capacity in (whole, whole - 1, len('{"guestBootId":"' + self.BOOT + '","conversations":') + 1):
            with self.subTest(capacity=capacity):
                self.assertEqual(self.build_config("{}", "[]", capacity=capacity)[0], 5)

    def test_the_written_file_is_root_readable_only_and_returned_as_a_fresh_read_only_descriptor(self):
        text = self.dir / "text.json"
        text.write_text('{"guestBootId":"x"}')
        out = self.run_tool("writecfg", self.dir, "config.json", text)
        self.assertEqual(out, "fd=1 mode=400 size=19 first={\"guestB cloexec=1")
        self.assertEqual(stat.S_IMODE(os.stat(self.dir / "config.json").st_mode), 0o400)

    def test_the_file_is_owner_read_only_whatever_the_umask(self):
        text = self.dir / "text.json"
        text.write_text("{}")
        for number, umask in enumerate(("0", "022", "077", "0577")):
            out = self.run_tool("writecfg", self.dir, f"umask{number}.json", text, umask)
            self.assertTrue(out.startswith("fd=1 mode=400 "), (umask, out))
            self.assertEqual(stat.S_IMODE(os.stat(self.dir / f"umask{number}.json").st_mode), 0o400)

    def test_an_existing_file_or_symlink_is_never_overwritten(self):
        text = self.dir / "text.json"
        text.write_text("{}")
        (self.dir / "taken.json").write_text("keep")
        self.assertEqual(self.run_tool("writecfg", self.dir, "taken.json", text), "fail")
        self.assertEqual((self.dir / "taken.json").read_text(), "keep")
        os.symlink(self.dir / "taken.json", self.dir / "link.json")
        self.assertEqual(self.run_tool("writecfg", self.dir, "link.json", text), "fail")

    def test_small_file_reads_demand_a_safe_regular_file(self):
        path = self.dir / "small"
        path.write_text('{"a":1}\n')
        os.chmod(path, 0o444)
        self.assertEqual(self.run_tool("readsmall", path, 1), '7|{"a":1}')
        self.assertTrue(self.run_tool("readsmall", path, 0).startswith("-1"))          # not owned by root
        os.chmod(path, 0o666)
        self.assertTrue(self.run_tool("readsmall", path, 1).startswith("-1"))          # group/other writable
        os.chmod(path, 0o444)
        link = self.dir / "link"
        os.symlink(path, link)
        self.assertTrue(self.run_tool("readsmall", link, 1).startswith("-1"))          # symlink
        big = self.dir / "big"
        big.write_bytes(b"x" * 500)
        os.chmod(big, 0o444)
        self.assertTrue(self.run_tool("readsmall", big, 1).startswith("-1"))           # larger than the buffer
        self.assertTrue(self.run_tool("readsmall", self.dir, 1).startswith("-1"))      # a directory
        fifo = self.dir / "fifo"
        os.mkfifo(fifo, 0o644)
        self.assertTrue(self.run_tool("readsmall", fifo, 1).startswith("-1"))          # a FIFO is refused, not waited on
        hard = self.dir / "hard"
        os.link(path, hard)
        self.assertTrue(self.run_tool("readsmall", path, 1).startswith("-1"))          # nlink != 1


# ---------------------------------------------------------------------------------------------------- state machine

@unittest.skipUnless(CC, "no C compiler")
class BootStateMachineTests(unittest.TestCase):
    def test_every_native_case_passes(self):
        folder = Path(tempfile.mkdtemp(prefix="guest-boot-"))
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        init = ROOT / "init"
        binary = build([ROOT / "tests/test_boot.c", init / "boot.c", init / "mounts.c", init / "ext4sb.c", init / "trusted_config.c",
                        ROOT / "common/wmx.c", ROOT / "common/ctl.c"], folder / "test_boot", extra=EXTRA)
        result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=120)
        failed = [line for line in result.stdout.splitlines() if line.startswith("FAIL") or line.startswith("      ")]
        self.assertEqual(failed, [], result.stdout + result.stderr)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        passes = re.findall(r"^PASS ", result.stdout, flags=re.M)
        self.assertGreaterEqual(len(passes), 34)


if __name__ == "__main__":
    unittest.main()
