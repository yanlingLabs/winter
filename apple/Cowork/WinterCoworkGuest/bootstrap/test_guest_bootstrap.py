"""Unit tests of the guest bootstrap. Run as:  python3 -I -S -B -m unittest discover -s <this directory> -p 'test_*.py'

Everything here runs without root, without a mount and without a VM. Regular-file images stand in for the block devices
(the production admission is exercised against a fake sysfs tree), and the e2fsprogs oracle class runs only where mke2fs,
dumpe2fs and e2fsck exist on Linux (the CI job); on a Mac those tests are skipped, not passed.
"""
import copy
import hashlib
import json
import os
import contextlib
import shutil
import signal
import stat
import struct
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import guest_bootstrap as gb

HERE = Path(__file__).resolve().parent
VECTORS = HERE.parent / "vectors"
REPO = HERE.parents[3]


@contextlib.contextmanager
def deadline(seconds):
    """A guard that is removed must fail the test, not hang the suite: the code under test loops or blocks forever without it."""
    def expired(_signal, _frame):
        raise AssertionError(f"still running after {seconds} s: the guard under test did not stop the loop")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def load_vectors():
    raw = (VECTORS / "mux-frames.json").read_bytes()
    pins = json.loads((VECTORS / "PINS.json").read_text())
    return json.loads(raw), raw, pins


VECTOR_DATA, VECTOR_BYTES, VECTOR_PINS = load_vectors()
POSITIVE = {v["name"]: bytes.fromhex(v["hex"]) for v in VECTOR_DATA["positive"]}
NEGATIVE = {v["name"]: v for v in VECTOR_DATA["negative"]}
UUID_A = "11111111-2222-4333-8444-555555555555"
UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa"
MIB = 1024 * 1024


def payload_of(frame):
    return frame[16:]


def vector_plan_message():
    return json.loads(payload_of(POSITIVE["bootstrap-down-plan"]))


def small_plan(first="format-new", second="format-new", capacities=(16 * MIB, 16 * MIB), check="normal", prior=None):
    """The vector plan, shrunk to test-sized volumes (16 MiB is the minimum the contract allows)."""
    plan = copy.deepcopy(vector_plan_message()["plan"])
    plan["checkMode"] = check
    plan["priorReplay"] = prior
    for target, action, capacity in zip(plan["volumes"], (first, second), capacities):
        target["action"] = action
        target["capacityBytes"] = capacity
        target["readyOperationId"] = None if action == "format-new" else "filesystem_previous"
    return gb.sorted_canonical(plan)


# ---------------------------------------------------------------------------------------------------- superblock builder

from superblock_fixture import REQUIRED_COMPAT, REQUIRED_INCOMPAT, REQUIRED_RO, make_sb, write_image  # noqa: E402


class FakeTools:
    """Stands in for mke2fs / dumpe2fs / e2fsck on regular files. `mke2fs` writes a valid superblock; `dumpe2fs` reports
    what is in the file's superblock (or what the test forces)."""

    def __init__(self):
        self.calls = []
        self.dumpe2fs_override = {}
        self.write_on_format = True

    def run(self, name, args, fd, deadline, accepted=(0,), phase=None, timeout=20):
        self.calls.append((name, list(args)))
        self.timeouts = getattr(self, 'timeouts', []) + [(name, timeout)]
        size = os.fstat(fd).st_size
        if name == "mke2fs":
            uuid_text = args[args.index("-U") + 1]
            if self.write_on_format:
                os.pwrite(fd, make_sb(uuid_text, size // 4096), 1024)
            return 0, ""
        if name == "dumpe2fs":
            sb = gb.parse_superblock(os.pread(fd, 1024, 1024))
            features = sorted(sb["features"] + sb["transient"])
            fields = {"Filesystem UUID": sb["uuid"], "Block size": "4096", "Block count": str(sb["blocks"]),
                      "Filesystem features": " ".join(features), "Filesystem state": "clean" if sb["clean"] else "not clean"}
            fields.update(self.dumpe2fs_override)
            return 0, "dumpe2fs 1.47.0\n" + "".join(f"{k}:{' ' * 6}{v}\n" for k, v in fields.items())
        if name == "e2fsck":
            return 0, ""
        raise AssertionError(name)


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="guest-bootstrap-test-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.fds = []
        self.addCleanup(self.close_all)

    def close_all(self):
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass

    def image(self, name, capacity, sb=None):
        path = self.dir / name
        write_image(path, capacity, sb)
        fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
        self.fds.append(fd)
        return path, gb.Disk(fd, "data", regular_file=True)

    def engine(self, tools=None, replay=None, clock=None):
        kwargs = {"tools": tools or FakeTools(), "replay": replay, "reopen": os.dup}
        if clock:
            kwargs["clock"] = clock
        return gb.Bootstrap(**kwargs)


# ---------------------------------------------------------------------------------------------------- vectors + framing

class VectorTests(unittest.TestCase):
    def test_the_vector_copy_is_pinned_by_sha256(self):
        pin = VECTOR_PINS["files"]["mux-frames.json"]
        self.assertEqual(hashlib.sha256(VECTOR_BYTES).hexdigest(), pin["sha256"])
        self.assertEqual(pin["sourceBranch"], "cowork/n2-host-adapter")
        self.assertRegex(pin["sourceCommit"], r"^[0-9a-f]{40}$")

    def test_every_bootstrap_positive_vector_parses_and_reencodes_to_the_same_bytes(self):
        for name, direction, kind in (("bootstrap-up-hello", "up", "hello"), ("bootstrap-down-plan", "down", "plan"),
                                      ("bootstrap-up-receipt", "up", "receipt"), ("bootstrap-up-fault", "up", "fault"),
                                      ("bootstrap-down-ready", "down", "ready"), ("bootstrap-up-mounted", "up", "mounted")):
            with self.subTest(name):
                payload = payload_of(POSITIVE[name])
                message = gb.parse_bootstrap_message(payload, direction)
                self.assertEqual(message["t"], kind)
                if direction == "up":
                    body = {k: v for k, v in message.items() if k != "v"}
                    self.assertEqual(gb.encode_bootstrap_message(body), payload)
                else:
                    self.assertEqual(gb.canonical_text(message).encode(), payload)

    def test_bootstrap_negative_vectors_are_refused_with_the_contract_category(self):
        for name in ("plan-travelling-up", "plan-protocol-2", "plan-unsorted-nested-keys", "hello-wrong-serial", "bootstrap-invalid-utf8", "bom-mux-bootstrap"):
            with self.subTest(name):
                vector = NEGATIVE[name]
                frame = bytes.fromhex(vector["hex"])
                with self.assertRaises(gb.ProtocolError) as caught:
                    gb.parse_bootstrap_message(payload_of(frame), vector["direction"])
                self.assertEqual(caught.exception.code, vector["error"])

    def test_the_receipt_vector_is_rebuilt_byte_for_byte_from_the_plan_and_the_observations(self):
        plan_message = vector_plan_message()
        plan = gb.sorted_canonical(plan_message["plan"])
        observed = [gb.observation(plan, target, False, list(plan["ext4Features"]), []) for target in plan["volumes"]]
        receipt = {**plan, "volumes": observed}
        self.assertTrue(gb.matches_filesystem_receipt(plan, receipt))
        rebuilt = gb.encode_bootstrap_message({"t": "receipt", "operationId": plan_message["operationId"], "nonce": plan_message["nonce"], "receipt": receipt})
        self.assertEqual(rebuilt, payload_of(POSITIVE["bootstrap-up-receipt"]))

    def test_hello_fault_and_mounted_are_rebuilt_byte_for_byte(self):
        self.assertEqual(gb.encode_bootstrap_message({"t": "hello", "guestBootId": "66666666-6666-4666-8666-666666666666",
                                                       "dataSerial": "winter-data", "environmentSerial": "winter-environment"}),
                         payload_of(POSITIVE["bootstrap-up-hello"]))
        base = {"operationId": "filesystem_55555555-5555-4555-8555-555555555555", "nonce": "0f" * 16}
        self.assertEqual(gb.encode_bootstrap_message({"t": "fault", "code": "probe_failed", **base}), payload_of(POSITIVE["bootstrap-up-fault"]))
        self.assertEqual(gb.encode_bootstrap_message({"t": "mounted", **base}), payload_of(POSITIVE["bootstrap-up-mounted"]))

    def test_the_contract_vocabulary_matches_the_pinned_typescript_sources_when_present(self):
        source = REPO / "packages/core/src/cowork/volume-filesystem.ts"
        if not source.exists():
            self.skipTest("TypeScript contract source not in this checkout")
        text = source.read_text()
        import re
        features = re.search(r"COWORK_EXT4_FEATURES = Object\.freeze\(\[([^\]]*)\]", text).group(1)
        self.assertEqual(re.findall(r'"([^"]+)"', features), gb.EXT4_FEATURES)
        options = re.search(r"COWORK_EXT4_MOUNT_OPTIONS = Object\.freeze\(\[([^\]]*)\]", text).group(1)
        self.assertEqual(re.findall(r'"([^"]+)"', options), gb.REQUIRED_MOUNT_OPTIONS)
        transient = re.search(r"COWORK_EXT4_TRANSIENT_FEATURES = Object\.freeze\(\[([^\]]*)\]", text).group(1)
        self.assertEqual(re.findall(r'"([^"]+)"', transient), gb.TRANSIENT_FEATURES)
        protocol = REPO / "packages/core/src/cowork/native/protocol.ts"
        if protocol.exists():
            faults = re.search(r"COWORK_NATIVE_BOOTSTRAP_FAULTS = Object\.freeze\(\[([^\]]*)\]", protocol.read_text()).group(1)
            self.assertEqual(tuple(re.findall(r'"([^"]+)"', faults)), gb.FAULT_CODES)


class MessageParserTests(unittest.TestCase):
    def ready(self):
        return json.loads(payload_of(POSITIVE["bootstrap-down-ready"]))

    def parse(self, value, direction="down"):
        text = value if isinstance(value, (bytes, bytearray)) else gb.canonical_text(value).encode()
        return gb.parse_bootstrap_message(text, direction)

    def refused(self, payload, code, direction="down"):
        with self.assertRaises(gb.ProtocolError) as caught:
            gb.parse_bootstrap_message(payload, direction)
        self.assertEqual(caught.exception.code, code)

    def test_a_canonical_ready_parses(self):
        self.assertEqual(self.parse(self.ready())["t"], "ready")

    def test_duplicate_keys_are_malformed(self):
        text = payload_of(POSITIVE["bootstrap-down-ready"]).decode()
        self.refused(text.replace('"v":1,', '"v":1,"v":1,').encode(), "malformed")

    def test_float_and_exponent_spellings_are_malformed(self):
        text = payload_of(POSITIVE["bootstrap-down-ready"]).decode()
        self.refused(text.replace('"v":1', '"v":1.0').encode(), "malformed")
        self.refused(text.replace('"v":1', '"v":1e0').encode(), "malformed")

    def test_whitespace_and_alternate_escapes_are_malformed(self):
        text = payload_of(POSITIVE["bootstrap-down-ready"]).decode()
        self.refused(text.replace(",", ", ", 1).encode(), "malformed")
        self.refused(text.replace('"ready"', '"\\u0072eady"').encode(), "malformed")

    def test_reordered_keys_are_malformed_even_though_the_key_set_is_right(self):
        ready = self.ready()
        reordered = {"v": 1, "t": "ready", "nonce": ready["nonce"], "operationId": ready["operationId"]}
        self.refused(gb.canonical_text(reordered).encode(), "malformed")

    def test_non_ascii_is_refused(self):
        self.refused('{"v":1,"t":"ready","operationId":"é","nonce":"' + "0" * 32 + '"}'.encode() if False else
                     ('{"v":1,"t":"ready","operationId":"é","nonce":"' + "0" * 32 + '"}').encode(), "malformed")

    def test_nesting_beyond_eight_levels_is_malformed(self):
        deep = '{"v":1,"t":"ready","operationId":"a","nonce":"' + "0" * 32 + '","x":' + "[" * 9 + "]" * 9 + "}"
        self.refused(deep.encode(), "malformed")

    def test_dangerous_keys_are_malformed(self):
        self.refused(b'{"v":1,"t":"ready","__proto__":1}', "malformed")

    def test_unknown_type_extra_key_and_bad_nonce(self):
        self.refused(b'{"v":1,"t":"explode"}', "unknown_type")
        ready = self.ready()
        self.refused(gb.canonical_text({**ready, "extra": 1}).encode(), "bad_field")
        self.refused(gb.canonical_text({**ready, "nonce": "0F" * 16}).encode(), "bad_field")
        self.refused(gb.canonical_text({**ready, "nonce": "0" * 31}).encode(), "bad_field")
        self.refused(gb.canonical_text({**ready, "v": 2}).encode(), "bad_field")

    def test_direction_decides_which_types_exist(self):
        self.refused(payload_of(POSITIVE["bootstrap-up-mounted"]), "unknown_type", "down")
        self.refused(payload_of(POSITIVE["bootstrap-down-ready"]), "unknown_type", "up")

    def test_oversize_payload_is_refused_before_decoding(self):
        self.refused(b" " * (gb.MAX_BOOTSTRAP_PAYLOAD + 1), "oversize")

    def test_a_non_object_is_malformed(self):
        self.refused(b"[]", "malformed")
        self.refused(b"nope", "malformed")

    def test_encode_refuses_a_bad_field_or_a_down_message(self):
        with self.assertRaises(ValueError):
            gb.encode_bootstrap_message({"t": "ready", "operationId": "a", "nonce": "0" * 32})
        with self.assertRaises(ValueError):
            gb.encode_bootstrap_message({"t": "mounted", "operationId": "a", "nonce": "short"})
        with self.assertRaises(ValueError):
            gb.encode_bootstrap_message({"t": "mounted", "operationId": "a", "nonce": "0" * 32, "extra": 1})


# ---------------------------------------------------------------------------------------------------- plan validation

class PlanValidationTests(unittest.TestCase):
    def plan(self):
        return copy.deepcopy(vector_plan_message()["plan"])

    def assertInvalid(self, mutate):
        plan = self.plan()
        mutate(plan)
        self.assertFalse(gb.valid_filesystem_plan(plan))

    def test_the_vector_plan_is_valid(self):
        self.assertTrue(gb.valid_filesystem_plan(self.plan()))

    def test_only_protocol_3_exists(self):
        self.assertInvalid(lambda p: p.update(protocolVersion=2))
        self.assertInvalid(lambda p: p.update(protocolVersion=True))

    def test_the_shape_is_closed(self):
        self.assertInvalid(lambda p: p.update(extra=1))
        self.assertInvalid(lambda p: p.pop("priorReplay"))
        self.assertInvalid(lambda p: p["volumes"][0].update(extra=1))
        self.assertInvalid(lambda p: p["volumes"][0]["identity"].update(extra=1))

    def test_the_filesystem_contract_is_exact(self):
        self.assertInvalid(lambda p: p["ext4Features"].pop())
        self.assertInvalid(lambda p: p["ext4Features"].append("ext_attr"))
        self.assertInvalid(lambda p: p.update(requiredMountOptions=[]))
        self.assertInvalid(lambda p: p.update(virginZeroProvenance="imported"))
        self.assertInvalid(lambda p: p.update(checkMode="repair"))

    def test_geometry_and_capacity_bounds(self):
        self.assertInvalid(lambda p: p["volumes"][0].update(capacityBytes=16 * MIB - 4096))
        self.assertInvalid(lambda p: p["volumes"][0].update(capacityBytes=256 * 1024**3 + 4096))
        self.assertInvalid(lambda p: p["volumes"][0].update(capacityBytes=16 * MIB + 512))
        self.assertInvalid(lambda p: p["volumes"][0].update(sectorBytes=4096))
        self.assertInvalid(lambda p: p["volumes"][0].update(filesystemBlockBytes=1024))
        self.assertInvalid(lambda p: p["volumes"][0].update(expectedFilesystemUUID="NOT-A-UUID"))

    def test_the_two_volumes_are_fixed_in_order_and_distinct(self):
        self.assertInvalid(lambda p: p["volumes"].reverse())
        self.assertInvalid(lambda p: p["volumes"][1].update(volumeId=p["volumes"][0]["volumeId"]))
        self.assertInvalid(lambda p: p["volumes"][1].update(creationId=p["volumes"][0]["creationId"]))
        self.assertInvalid(lambda p: p["volumes"][1].update(expectedFilesystemUUID=p["volumes"][0]["expectedFilesystemUUID"]))
        self.assertInvalid(lambda p: p["volumes"][1].update(identity=dict(p["volumes"][0]["identity"])))
        self.assertInvalid(lambda p: p["volumes"].pop())

    def test_host_file_identity_is_decimal_strings_with_mode_0600(self):
        self.assertInvalid(lambda p: p["volumes"][0]["identity"].update(mode=0o644))
        self.assertInvalid(lambda p: p["volumes"][0]["identity"].update(inode=12))
        self.assertInvalid(lambda p: p["volumes"][0]["identity"].update(device="0x10"))
        self.assertInvalid(lambda p: p["volumes"][0]["identity"].update(uid=-1))

    def test_ready_operation_ids_follow_the_action(self):
        def probe_without_ready(p):
            p["volumes"][0]["action"] = "probe-existing"
        self.assertInvalid(probe_without_ready)

        def format_with_ready(p):
            p["volumes"][0]["readyOperationId"] = "filesystem_x"
        self.assertInvalid(format_with_ready)
        ok = self.plan()
        ok["volumes"][0].update(action="probe-existing", readyOperationId="filesystem_prev")
        self.assertTrue(gb.valid_filesystem_plan(ok))

    def test_replay_needs_normal_check_mode(self):
        plan = self.plan()
        plan["volumes"][0].update(action="replay-journal-then-probe", readyOperationId="filesystem_prev")
        plan["volumes"][1].update(action="probe-existing", readyOperationId="filesystem_prev2")
        self.assertTrue(gb.valid_filesystem_plan(plan))
        plan["checkMode"] = "full-read-only"
        self.assertFalse(gb.valid_filesystem_plan(plan))

    def test_a_prior_replay_debt_cannot_coexist_with_a_format(self):
        plan = self.plan()
        plan["priorReplay"] = {"operationId": "filesystem_old", "owner": dict(plan["owner"], incarnationId="inc-33333333")}
        self.assertFalse(gb.valid_filesystem_plan(plan))  # both volumes are format-new
        plan["volumes"][0].update(action="probe-existing", readyOperationId="filesystem_a")
        self.assertFalse(gb.valid_filesystem_plan(plan))  # one still formats
        plan["volumes"][1].update(action="probe-existing", readyOperationId="filesystem_b")
        self.assertTrue(gb.valid_filesystem_plan(plan))

    def test_a_prior_replay_must_be_a_different_operation_and_owner(self):
        plan = self.plan()
        for target, ready in zip(plan["volumes"], ("a", "b")):
            target.update(action="probe-existing", readyOperationId=f"filesystem_{ready}")
        plan["priorReplay"] = {"operationId": plan["operationId"], "owner": dict(plan["owner"], incarnationId="inc-9")}
        self.assertFalse(gb.valid_filesystem_plan(plan))
        plan["priorReplay"] = {"operationId": "filesystem_old", "owner": dict(plan["owner"])}
        self.assertFalse(gb.valid_filesystem_plan(plan))

    def test_an_unknown_action_is_invalid_whatever_its_ready_id(self):
        for action in ("reformat", "", "FORMAT-NEW", None):
            with self.subTest(action=action):
                self.assertInvalid(lambda p, a=action: p["volumes"][0].update(action=a, readyOperationId="filesystem_x"))

    def test_the_largest_valid_plan_fits_the_size_bound_with_room_to_spare(self):
        # Every identifier is capped at 160 characters by its own validator, so the 16 KiB bound cannot be reached by a valid plan: it is a
        # backstop, and this pins that it stays one.
        big = "a" * 160
        plan = self.plan()
        plan.update(operationId=big, homeId=big, workspaceId=big)
        plan["owner"].update(controllerInstanceId=big, workerInstanceId=big, incarnationId=big)
        for index, target in enumerate(plan["volumes"]):
            target.update(volumeId=big[:-1] + str(index), creationId=big[:-1] + str(index), action="probe-existing", readyOperationId=big)
            target["identity"].update(device="9" * 30, inode="9" * (30 - index))
        plan["priorReplay"] = {"operationId": big[:-1] + "p", "owner": {"controllerInstanceId": big, "workerInstanceId": big, "incarnationId": big[:-1] + "q", "leaseEpoch": 2**53 - 1, "runtimeImageDigest": "f" * 64}}
        self.assertTrue(gb.valid_filesystem_plan(plan))
        self.assertLess(len(gb.canonical_text(plan)), gb.MAX_PLAN_BYTES // 2)

    def test_the_plan_size_is_bounded(self):
        plan = self.plan()
        plan["volumes"][0]["identity"]["device"] = "9" * 30
        self.assertTrue(gb.valid_filesystem_plan(plan))
        padded = copy.deepcopy(plan)
        padded["owner"]["controllerInstanceId"] = "c" * (gb.MAX_PLAN_BYTES)
        self.assertFalse(gb.valid_filesystem_plan(padded))

    def test_a_non_dict_plan_never_raises(self):
        for value in (None, [], "x", 3, {"protocolVersion": 3}):
            self.assertFalse(gb.valid_filesystem_plan(value))


# ---------------------------------------------------------------------------------------------------- ext4 superblock

class Crc32cTests(unittest.TestCase):
    def test_the_standard_check_value(self):
        # Standard CRC-32C("123456789") = 0xE3069283; ext4 uses the same register without the final inversion.
        self.assertEqual(gb.crc32c_raw(b"123456789") ^ 0xFFFFFFFF, 0xE3069283)

    def test_the_seed_is_all_ones(self):
        self.assertEqual(gb.crc32c_raw(b""), 0xFFFFFFFF)


class SuperblockTests(unittest.TestCase):
    def test_a_conforming_superblock(self):
        sb = gb.parse_superblock(make_sb())
        self.assertEqual(sb["features"], gb.EXT4_FEATURES)
        self.assertEqual((sb["uuid"], sb["blockBytes"], sb["blocks"], sb["transient"], sb["clean"]), (UUID_A, 4096, 4096, [], True))

    def refused(self, raw, reason):
        with self.assertRaises(gb.Refused) as caught:
            gb.parse_superblock(raw)
        self.assertEqual(caught.exception.reason, reason)

    def test_magic_length_and_checksum(self):
        self.refused(make_sb(magic=0xEF54), "superblock")
        self.refused(make_sb()[:1000], "superblock")
        self.refused(make_sb(break_checksum=True), "superblock_checksum")
        self.refused(make_sb(checksum_type=0), "superblock_checksum")

    def test_geometry(self):
        self.refused(make_sb(log_block_size=0), "filesystem_geometry")
        self.refused(make_sb(rev=0), "filesystem_geometry")
        self.refused(make_sb(inode_size=128), "filesystem_geometry")

    def test_an_unknown_feature_bit_in_any_group_refuses(self):
        self.refused(make_sb(compat=0x8), "filesystem_features")      # ext_attr
        self.refused(make_sb(compat=0x10), "filesystem_features")     # resize_inode
        self.refused(make_sb(incompat=0x8000), "filesystem_features")  # inline_data
        self.refused(make_sb(ro=0x10), "filesystem_features")         # uninit_bg

    def test_pending_recovery_is_reported_as_the_transient_feature(self):
        sb = gb.parse_superblock(make_sb(incompat=0x4))
        self.assertEqual(sb["transient"], ["needs_recovery"])
        self.assertEqual(sb["features"], gb.EXT4_FEATURES)

    def test_a_missing_required_feature_is_visible_to_the_probe(self):
        raw = bytearray(make_sb())
        struct.pack_into("<I", raw, 0x64, REQUIRED_RO & ~0x400)
        # (checksum no longer matches: that is refused first)
        self.assertRaises(gb.Refused, gb.parse_superblock, bytes(raw))

    def test_state_bits(self):
        self.assertFalse(gb.parse_superblock(make_sb(state=0))["clean"])
        self.assertFalse(gb.parse_superblock(make_sb(state=3))["clean"])
        self.assertTrue(gb.parse_superblock(make_sb(state=5))["clean"])

    def test_blocks_use_the_high_word(self):
        self.assertEqual(gb.parse_superblock(make_sb(blocks=(3 << 32) | 7))["blocks"], (3 << 32) | 7)

    def test_a_real_mke2fs_image_parses_when_a_formatter_exists(self):
        mke2fs = shutil.which("mke2fs") or (os.path.expanduser("~/Library/Android/sdk/platform-tools/mke2fs") if sys.platform == "darwin" else None)
        if not mke2fs or not os.path.exists(mke2fs):
            self.skipTest("no mke2fs on this machine")
        import subprocess
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "real.img"
            write_image(path, 16 * MIB)
            subprocess.run([mke2fs, *gb.mke2fs_args(UUID_A, True), str(path)], env={**gb.TOOL_ENV}, check=True, capture_output=True)
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(1024), bytes(1024))
                handle.seek(1024)
                sb = gb.parse_superblock(handle.read(1024))
            self.assertEqual((sb["uuid"], sb["features"], sb["blocks"], sb["clean"]), (UUID_A, gb.EXT4_FEATURES, 4096, True))


class Dumpe2fsParserTests(unittest.TestCase):
    def test_header_lines(self):
        text = "dumpe2fs 1.47.0 (5-Feb-2023)\nFilesystem UUID:          " + UUID_A + "\nFilesystem features:      has_journal extent\nBlock count:              4096\n"
        properties = gb.parse_dumpe2fs_header(text)
        self.assertEqual(properties["Filesystem UUID"], UUID_A)
        self.assertEqual(properties["Filesystem features"], "has_journal extent")
        self.assertEqual(properties["Block count"], "4096")


# ---------------------------------------------------------------------------------------------------- probe

class ProbeTests(TempDirTest):
    def setup_volume(self, **sb_kwargs):
        plan = small_plan("probe-existing", "probe-existing")
        target = plan["volumes"][0]
        path, disk = self.image("v.img", target["capacityBytes"], make_sb(UUID_A, target["capacityBytes"] // 4096, **sb_kwargs))
        return plan, target, disk, path

    def probe(self, plan, target, disk, tools):
        return gb.probe(disk.fd, target, 10**12, plan, tools, os.dup)

    def test_a_conforming_volume_passes_and_runs_dumpe2fs_but_not_e2fsck(self):
        plan, target, disk, _ = self.setup_volume()
        tools = FakeTools()
        self.assertEqual(self.probe(plan, target, disk, tools), (gb.EXT4_FEATURES, []))
        self.assertEqual([c[0] for c in tools.calls], ["dumpe2fs"])
        self.assertEqual(tools.calls[0][1], ["-h"])

    def test_full_read_only_adds_e2fsck_dash_f_dash_n(self):
        plan = small_plan("probe-existing", "probe-existing", check="full-read-only")
        target = plan["volumes"][0]
        _, disk = self.image("v.img", target["capacityBytes"], make_sb(UUID_A, target["capacityBytes"] // 4096))
        tools = FakeTools()
        self.probe(plan, target, disk, tools)
        self.assertEqual([c[0] for c in tools.calls], ["dumpe2fs", "e2fsck"])
        self.assertEqual(tools.calls[1][1], ["-f", "-n"])

    def refused(self, reason, tools=None, **sb_kwargs):
        plan, target, disk, _ = self.setup_volume(**sb_kwargs)
        with self.assertRaises(gb.Refused) as caught:
            self.probe(plan, target, disk, tools or FakeTools())
        self.assertEqual(caught.exception.reason, reason)

    def test_refusals_from_the_direct_read(self):
        plan, target, disk, path = self.setup_volume()
        os.pwrite(disk.fd, make_sb("99999999-2222-4333-8444-555555555555", target["capacityBytes"] // 4096), 1024)
        with self.assertRaises(gb.Refused) as caught:
            self.probe(plan, target, disk, FakeTools())
        self.assertEqual(caught.exception.reason, "filesystem_mismatch")
        os.pwrite(disk.fd, make_sb(UUID_A, target["capacityBytes"] // 4096 + 1), 1024)
        with self.assertRaises(gb.Refused) as caught:
            self.probe(plan, target, disk, FakeTools())
        self.assertEqual(caught.exception.reason, "filesystem_geometry")
        os.pwrite(disk.fd, make_sb(UUID_A, target["capacityBytes"] // 4096, incompat=0x8000), 1024)
        with self.assertRaises(gb.Refused) as caught:
            self.probe(plan, target, disk, FakeTools())
        self.assertEqual(caught.exception.reason, "filesystem_features")

    def test_a_foreign_signature_in_the_first_sector_refuses(self):
        plan, target, disk, _ = self.setup_volume()
        os.pwrite(disk.fd, b"\x55\xaa", 510)
        with self.assertRaises(gb.Refused) as caught:
            self.probe(plan, target, disk, FakeTools())
        self.assertEqual(caught.exception.reason, "foreign_signature")

    def test_dumpe2fs_must_agree_with_the_direct_read(self):
        for override, reason in (({"Filesystem UUID": "99999999-2222-4333-8444-555555555555"}, "header_geometry"),
                                 ({"Block size": "1024"}, "header_geometry"),
                                 ({"Block count": "1"}, "header_geometry"),
                                 ({"Filesystem features": " ".join(gb.EXT4_FEATURES[:-1])}, "filesystem_features"),
                                 ({"Filesystem features": " ".join(gb.EXT4_FEATURES + ["ext_attr"])}, "filesystem_features"),
                                 ({"Filesystem features": " ".join(gb.EXT4_FEATURES + ["needs_recovery"])}, "probe_disagreement"),
                                 ({"Filesystem state": "not clean"}, "explicit_full_check_required")):
            with self.subTest(override):
                tools = FakeTools()
                tools.dumpe2fs_override = override
                self.refused(reason, tools)

    def test_not_clean_state_needs_the_explicit_full_check(self):
        self.refused("explicit_full_check_required", state=0)

    def test_the_direct_read_alone_can_refuse_an_unclean_volume(self):
        tools = FakeTools()
        tools.dumpe2fs_override = {"Filesystem state": "clean"}   # dumpe2fs claims clean; the superblock itself says it is not
        self.refused("explicit_full_check_required", tools, state=0)

    def test_the_probe_helpers_get_a_separately_read_only_descriptor(self):
        seen = []

        def fake_open(path, flags, *args, **kwargs):
            seen.append((path, flags))
            return os.dup(0)

        with unittest.mock.patch.object(gb.os, "open", fake_open):
            fd = gb.reopen_readonly(7)
        os.close(fd)
        self.assertEqual(seen, [("/proc/self/fd/7", os.O_RDONLY | os.O_CLOEXEC)])

    def test_pending_recovery_is_returned_as_transient_not_refused(self):
        plan, target, disk, _ = self.setup_volume(incompat=0x4)
        features, transient = self.probe(plan, target, disk, FakeTools())
        self.assertEqual((features, transient), (gb.EXT4_FEATURES, ["needs_recovery"]))

    def test_duplicate_features_in_dumpe2fs_output_refuse(self):
        tools = FakeTools()
        tools.dumpe2fs_override = {"Filesystem features": " ".join(gb.EXT4_FEATURES + [gb.EXT4_FEATURES[0]])}
        self.refused("filesystem_features", tools)


# ---------------------------------------------------------------------------------------------------- the engine

class VirginScanTests(TempDirTest):
    def test_a_zero_volume_passes_and_a_late_byte_refuses(self):
        path, disk = self.image("v.img", 4 * MIB + 4096)
        gb.all_zero(disk.fd, 4 * MIB + 4096, 10**12)
        os.pwrite(disk.fd, b"\x01", 4 * MIB + 4095)
        with deadline(30), self.assertRaises(gb.Refused) as caught:
            gb.all_zero(disk.fd, 4 * MIB + 4096, 10**12)
        self.assertEqual(caught.exception.reason, "not_virgin")

    def test_the_deadline_is_checked_between_chunks(self):
        _, disk = self.image("v.img", 4 * MIB)
        ticks = iter([0, 0, 100, 100, 100])
        with self.assertRaises(gb.Refused) as caught:
            gb.all_zero(disk.fd, 4 * MIB, 50, clock=lambda: next(ticks))
        self.assertEqual(caught.exception.reason, "virgin_scan_deadline")

    def test_a_short_read_is_not_a_clean_scan(self):
        _, disk = self.image("v.img", 4 * MIB)
        with deadline(30), self.assertRaises(gb.Refused) as caught:
            gb.all_zero(disk.fd, 8 * MIB, 10**12)  # the file is shorter than the claimed capacity
        self.assertEqual(caught.exception.reason, "not_virgin")

    def test_the_allowance_grows_with_the_capacity(self):
        self.assertEqual(gb.virgin_scan_seconds(16 * MIB), gb.VIRGIN_SCAN_BASE_SECONDS + 1)
        self.assertGreater(gb.virgin_scan_seconds(256 * 1024**3), 1000)


class MkfsArgumentTests(unittest.TestCase):
    def test_force_only_for_regular_files(self):
        self.assertIn("-F", gb.mke2fs_args(UUID_A, True))
        self.assertNotIn("-F", gb.mke2fs_args(UUID_A, False))

    def test_fixed_argv(self):
        args = gb.mke2fs_args(UUID_A, False)
        self.assertEqual(args[:8], ["-q", "-t", "ext4", "-b", "4096", "-I", "256", "-O"])
        self.assertEqual(args[8], "none," + ",".join(gb.EXT4_FEATURES))
        self.assertEqual(args[args.index("-U") + 1], UUID_A)
        self.assertEqual(args[args.index("-E") + 1], "lazy_itable_init=1,lazy_journal_init=0,nodiscard")


class EngineTests(TempDirTest):
    def pair(self, plan, preformatted=()):
        disks = []
        for index, target in enumerate(plan["volumes"]):
            sb = make_sb(target["expectedFilesystemUUID"], target["capacityBytes"] // 4096, incompat=0x4 if index in preformatted else 0) if target["action"] != "format-new" else None
            _, disk = self.image(f"v{index}.img", target["capacityBytes"], sb)
            disk.purpose = ("data", "environment")[index]
            disks.append(disk)
        return disks

    def test_two_new_volumes_are_formatted_probed_and_receipted(self):
        plan = small_plan()
        disks = self.pair(plan)
        tools = FakeTools()
        receipt = self.engine(tools).execute(plan, disks)
        self.assertTrue(gb.matches_filesystem_receipt(plan, receipt))
        self.assertEqual([c[0] for c in tools.calls], ["mke2fs", "dumpe2fs", "mke2fs", "dumpe2fs"])
        for call in tools.calls:
            if call[0] == "mke2fs":
                self.assertIn("-F", call[1])  # regular files in this test only
        self.assertEqual([v["journalReplay"] for v in receipt["volumes"]], ["none", "none"])

    def test_existing_volumes_are_probed_and_never_formatted(self):
        plan = small_plan("probe-existing", "probe-existing")
        tools = FakeTools()
        self.engine(tools).execute(plan, self.pair(plan))
        self.assertEqual([c[0] for c in tools.calls], ["dumpe2fs", "dumpe2fs", "dumpe2fs", "dumpe2fs"])
        # (each volume is observed twice: once in the preflight and once after the effect step)

    def test_a_non_virgin_new_volume_is_refused_and_nothing_is_written_to_either(self):
        plan = small_plan()
        disks = self.pair(plan)
        os.pwrite(disks[1].fd, b"x", 1000)
        tools = FakeTools()
        with self.assertRaises(gb.Refused) as caught:
            self.engine(tools).execute(plan, disks)
        self.assertEqual(caught.exception.reason, "not_virgin")
        self.assertEqual(tools.calls, [])  # the first volume was NOT formatted although only the second is dirty

    def test_both_volumes_preflight_before_the_first_write(self):
        plan = small_plan("format-new", "probe-existing")
        disks = self.pair(plan)
        os.pwrite(disks[1].fd, bytes(1024), 1024)  # destroy the second volume's superblock
        tools = FakeTools()
        with self.assertRaises(gb.Refused):
            self.engine(tools).execute(plan, disks)
        self.assertFalse(any(call[0] == "mke2fs" for call in tools.calls))

    def test_a_single_shot_operation_cannot_run_twice(self):
        plan = small_plan("probe-existing", "probe-existing")
        engine = self.engine()
        engine.execute(plan, self.pair(plan))
        with self.assertRaises(gb.Refused) as caught:
            engine.execute(plan, self.pair(plan))
        self.assertEqual(caught.exception.reason, "one_shot_consumed")

    def test_the_operation_is_consumed_before_any_effect_even_when_it_fails(self):
        plan = small_plan()
        disks = self.pair(plan)
        os.pwrite(disks[0].fd, b"x", 5)
        engine = self.engine()
        with self.assertRaises(gb.Refused):
            engine.execute(plan, disks)
        self.assertIn(plan["operationId"], engine.consumed)

    def test_the_same_descriptor_twice_is_refused(self):
        plan = small_plan()
        disks = self.pair(plan)
        with self.assertRaises(gb.Refused) as caught:
            self.engine().execute(plan, [disks[0], disks[0]])
        self.assertEqual(caught.exception.reason, "fd_pair")

    def test_an_invalid_plan_is_refused_before_anything(self):
        plan = small_plan()
        plan["protocolVersion"] = 2
        tools = FakeTools()
        with self.assertRaises(gb.Refused) as caught:
            self.engine(tools).execute(plan, self.pair(small_plan()))
        self.assertEqual(caught.exception.reason, "closed_shape")
        self.assertEqual(tools.calls, [])

    def replay_plan(self):
        return small_plan("replay-journal-then-probe", "probe-existing")

    def test_replay_is_requested_after_both_preflights_and_clears_the_transient_bit(self):
        plan = self.replay_plan()
        disks = self.pair(plan, preformatted=(0,))
        requested = []

        def replay(purpose):
            requested.append(purpose)
            os.pwrite(disks[0].fd, make_sb(plan["volumes"][0]["expectedFilesystemUUID"], plan["volumes"][0]["capacityBytes"] // 4096), 1024)
            return True

        tools = FakeTools()
        receipt = self.engine(tools, replay=replay).execute(plan, disks)
        self.assertEqual(requested, ["data"])
        self.assertEqual([v["journalReplayed"] for v in receipt["volumes"]], [True, False])
        self.assertEqual([v["journalReplay"] for v in receipt["volumes"]], ["kernel-mount", "none"])
        self.assertEqual(receipt["volumes"][0]["transientFilesystemFeatures"], [])
        self.assertEqual([c[0] for c in tools.calls[:2]], ["dumpe2fs", "dumpe2fs"])  # both preflights came first

    def test_without_a_replay_route_nothing_is_written_to_the_other_volume(self):
        plan = small_plan("replay-journal-then-probe", "format-new")
        plan["volumes"][1]["readyOperationId"] = None
        disks = self.pair(plan, preformatted=(0,))
        tools = FakeTools()
        with self.assertRaises(gb.Refused) as caught:
            self.engine(tools, replay=None).execute(plan, disks)
        self.assertEqual(caught.exception.reason, "kernel_replay_adapter_required")
        self.assertEqual(caught.exception.phase, "replay")
        self.assertFalse(any(c[0] == "mke2fs" for c in tools.calls))

    def test_a_replay_that_did_not_succeed_refuses(self):
        plan = self.replay_plan()
        disks = self.pair(plan, preformatted=(0,))
        with self.assertRaises(gb.Refused) as caught:
            self.engine(replay=lambda purpose: False).execute(plan, disks)
        self.assertEqual(caught.exception.reason, "kernel_replay_receipt")

    def test_a_replay_that_leaves_recovery_pending_refuses(self):
        plan = self.replay_plan()
        disks = self.pair(plan, preformatted=(0,))
        with self.assertRaises(gb.Refused) as caught:
            self.engine(replay=lambda purpose: True).execute(plan, disks)  # the superblock still says needs_recovery
        self.assertEqual(caught.exception.reason, "journal_recovery_incomplete")

    def test_a_clean_replay_volume_needs_no_replay(self):
        plan = self.replay_plan()
        disks = self.pair(plan)
        called = []
        receipt = self.engine(replay=lambda purpose: called.append(purpose) or True).execute(plan, disks)
        self.assertEqual(called, [])
        self.assertEqual(receipt["volumes"][0]["journalReplayed"], False)

    def test_pending_recovery_on_a_plain_probe_is_reported_not_replayed(self):
        plan = small_plan("probe-existing", "probe-existing")
        disks = self.pair(plan, preformatted=(1,))
        called = []
        receipt = self.engine(replay=lambda purpose: called.append(purpose) or True).execute(plan, disks)
        self.assertEqual(called, [])
        self.assertEqual(receipt["volumes"][1]["transientFilesystemFeatures"], ["needs_recovery"])

    def test_the_effect_step_flushes_before_the_probe(self):
        plan = small_plan()
        disks = self.pair(plan)
        order = []
        real_fsync = os.fsync
        tools = FakeTools()
        original = tools.run

        def run(name, *args, **kwargs):
            order.append(name)
            return original(name, *args, **kwargs)

        tools.run = run
        try:
            os.fsync = lambda fd: (order.append("fsync"), real_fsync(fd))[1]
            self.engine(tools).execute(plan, disks)
        finally:
            os.fsync = real_fsync
        self.assertEqual(order, ["mke2fs", "fsync", "dumpe2fs", "mke2fs", "fsync", "dumpe2fs"])

    def test_full_read_only_is_recorded_in_the_receipt(self):
        plan = small_plan("probe-existing", "probe-existing", check="full-read-only")
        receipt = self.engine().execute(plan, self.pair(plan))
        self.assertTrue(all(v["fullReadOnlyCheck"] for v in receipt["volumes"]))

    def test_a_forged_receipt_shape_never_leaves_the_engine(self):
        plan = small_plan("probe-existing", "probe-existing")
        original = gb.observation
        gb.observation = lambda *a, **k: {**original(*a, **k), "flushConfirmed": False}
        try:
            with self.assertRaises(gb.Refused) as caught:
                self.engine().execute(plan, self.pair(plan))
        finally:
            gb.observation = original
        self.assertEqual(caught.exception.reason, "receipt_self_check")


class ReviewFixTests(TempDirTest):
    def test_an_unreadable_sysfs_attribute_is_a_probe_refusal_not_a_crash(self):
        fake = FakeSysfs(self.dir)
        (fake.base / "serial").unlink()
        admission = gb.BlockDeviceAdmission(sys_root=str(self.dir), mountinfo=fake.mountinfo(), dev_root=str(self.dir))
        path = self.dir / "image"
        write_image(path, 16 * MIB)
        fd = os.open(path, os.O_RDWR)
        self.fds.append(fd)
        with self.assertRaises(gb.Refused) as caught:
            admission.check_sysfs(fd, 254, 0, gb.DATA_SERIAL, {"capacityBytes": 16 * MIB, "sectorBytes": 512})
        self.assertEqual((caught.exception.reason, caught.exception.phase), ("device_unreadable", "probe"))
        (fake.base / "serial").write_text(gb.DATA_SERIAL + "\n")
        (fake.base / "size").write_text("not a number\n")
        with self.assertRaises(gb.Refused) as caught:
            admission.check_sysfs(fd, 254, 0, gb.DATA_SERIAL, {"capacityBytes": 16 * MIB, "sectorBytes": 512})
        self.assertEqual(caught.exception.reason, "device_unreadable")

    def test_a_node_that_cannot_be_opened_is_a_probe_refusal(self):
        admission = gb.BlockDeviceAdmission(sys_root=str(self.dir), dev_root=str(self.dir))
        with self.assertRaises(gb.Refused) as caught:
            admission.admit("data", str(self.dir / "absent"), 254, 0, gb.DATA_SERIAL, {"capacityBytes": 16 * MIB, "sectorBytes": 512})
        self.assertEqual((caught.exception.reason, caught.exception.phase), ("device_unopenable", "probe"))

    def test_a_missing_tool_names_the_phase(self):
        with unittest.mock.patch.object(gb.os.path, "isfile", return_value=False):
            with self.assertRaises(gb.Refused) as caught:
                gb.tool_path("mke2fs", "format")
        self.assertEqual((caught.exception.reason, caught.exception.phase), ("required_linux_tool_missing", "format"))
        self.assertEqual(gb.fault_code(caught.exception), "format_failed")

    def test_the_receipt_self_check_is_an_internal_fault_not_a_bad_plan(self):
        plan = small_plan("probe-existing", "probe-existing")
        original = gb.observation
        gb.observation = lambda *a, **k: {**original(*a, **k), "checked": False}
        try:
            disks = []
            for index, target in enumerate(plan["volumes"]):
                _, disk = self.image(f"v{index}.img", target["capacityBytes"], make_sb(target["expectedFilesystemUUID"], target["capacityBytes"] // 4096))
                disks.append(disk)
            with self.assertRaises(gb.Refused) as caught:
                gb.Bootstrap(tools=FakeTools(), reopen=os.dup).execute(plan, disks)
        finally:
            gb.observation = original
        self.assertEqual(gb.fault_code(caught.exception), "internal")

    def test_a_flush_that_fails_is_a_refusal_with_the_phase_of_the_step(self):
        for first, phase in (("format-new", "format"), ("probe-existing", "probe")):
            plan = small_plan(first, "probe-existing") if first != "format-new" else small_plan("format-new", "format-new")
            disks = []
            for index, target in enumerate(plan["volumes"]):
                sb = None if target["action"] == "format-new" else make_sb(target["expectedFilesystemUUID"], target["capacityBytes"] // 4096)
                _, disk = self.image(f"{first}{index}.img", target["capacityBytes"], sb)
                disks.append(disk)
            real = os.fsync
            os.fsync = lambda fd: (_ for _ in ()).throw(OSError(5, "io"))
            try:
                with self.assertRaises(gb.Refused) as caught:
                    gb.Bootstrap(tools=FakeTools(), reopen=os.dup).execute(plan, disks)
            finally:
                os.fsync = real
            self.assertEqual((caught.exception.reason, caught.exception.phase), ("flush_failed", phase))

    def test_the_heavy_tools_get_a_budget_that_grows_with_the_volume(self):
        self.assertEqual(gb.tool_seconds(16 * MIB), gb.TOOL_BUDGET_SECONDS + 1)
        self.assertGreater(gb.tool_seconds(256 * 1024 ** 3), 1000)
        plan = small_plan()
        disks = []
        for index, target in enumerate(plan["volumes"]):
            _, disk = self.image(f"w{index}.img", target["capacityBytes"])
            disks.append(disk)
        tools = FakeTools()
        gb.Bootstrap(tools=tools, reopen=os.dup).execute(plan, disks)
        by_name = dict(tools.timeouts)
        self.assertEqual(by_name["mke2fs"], gb.tool_seconds(16 * MIB))
        self.assertEqual(by_name["dumpe2fs"], gb.TOOL_BUDGET_SECONDS)
        plan = small_plan("probe-existing", "probe-existing", check="full-read-only")
        plan["operationId"] = "filesystem_full"
        tools = FakeTools()
        gb.Bootstrap(tools=tools, reopen=os.dup).execute(gb.sorted_canonical(plan), disks)
        self.assertEqual(dict(tools.timeouts)["e2fsck"], gb.tool_seconds(16 * MIB))

    def test_the_service_deadline_covers_scans_and_heavy_tools(self):
        plan = small_plan()
        ticks = []

        class Clock:
            def __call__(self):
                ticks.append(1)
                return 1000.0

        seen = {}

        class Spy(FakeTools):
            def run(self, name, args, fd, deadline, accepted=(0,), phase=None, timeout=20):
                seen.setdefault("deadline", deadline)
                return super().run(name, args, fd, deadline, accepted, phase, timeout)

        disks = []
        for index, target in enumerate(plan["volumes"]):
            _, disk = self.image(f"d{index}.img", target["capacityBytes"])
            disks.append(disk)
        gb.Bootstrap(tools=Spy(), clock=Clock(), reopen=os.dup).execute(plan, disks)
        expected = 1000.0 + gb.SERVICE_BUDGET_SECONDS + 2 * gb.virgin_scan_seconds(16 * MIB) + 2 * gb.tool_seconds(16 * MIB)
        self.assertEqual(seen["deadline"], expected)


class DescriptorChecksTests(TempDirTest):
    def test_block_identity(self):
        gb.check_block_identity(stat.S_IFBLK | 0o600, os.makedev(100, 16), 100, 16)
        for mode, rdev in ((stat.S_IFREG | 0o600, os.makedev(100, 16)), (stat.S_IFCHR | 0o600, os.makedev(100, 16)), (stat.S_IFDIR | 0o700, 0),
                           (stat.S_IFBLK | 0o600, os.makedev(100, 17)), (stat.S_IFBLK | 0o600, os.makedev(99, 16))):
            with self.subTest(mode=oct(mode), rdev=rdev):
                with self.assertRaises(gb.Refused) as caught:
                    gb.check_block_identity(mode, rdev, 254, 16)
                self.assertIn(caught.exception.reason, ("not_block_device", "device_identity"))

    def test_descriptor_flags(self):
        gb.check_open_flags(os.O_RDWR | os.O_NONBLOCK)
        for flags in (os.O_RDONLY, os.O_WRONLY, os.O_RDWR | os.O_APPEND):
            with self.subTest(flags=flags):
                with self.assertRaises(gb.Refused) as caught:
                    gb.check_open_flags(flags)
                self.assertEqual(caught.exception.reason, "descriptor_mode")

    def test_a_disk_closed_twice_never_closes_a_reused_descriptor(self):
        path = self.dir / "x"
        path.write_bytes(b"x")
        fd = os.open(path, os.O_RDONLY)
        disk = gb.Disk(fd, "data")
        disk.close()
        reused = os.open(path, os.O_RDONLY)          # the kernel hands out the lowest free number: the one just closed
        self.fds.append(reused)
        disk.close()                                   # a second close must be a no-op
        os.fstat(reused)                               # still open
        self.assertEqual(disk.fd, -1)



class ReceiptMatchTests(unittest.TestCase):
    def good(self):
        plan = gb.sorted_canonical(vector_plan_message()["plan"])
        receipt = copy.deepcopy({**plan, "volumes": [gb.observation(plan, t, False, list(plan["ext4Features"]), []) for t in plan["volumes"]]})
        return plan, receipt

    def test_the_good_receipt_matches(self):
        self.assertTrue(gb.matches_filesystem_receipt(*self.good()))

    def test_each_deviation_is_a_mismatch(self):
        def mutate(change):
            plan, receipt = self.good()
            change(receipt)
            return gb.matches_filesystem_receipt(plan, receipt)

        self.assertFalse(mutate(lambda r: r.update(operationId="filesystem_other")))
        self.assertFalse(mutate(lambda r: r["owner"].update(leaseEpoch=9)))
        self.assertFalse(mutate(lambda r: r.update(extra=1)))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(filesystemUUID=UUID_B)))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(checked=False)))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(flushConfirmed=False)))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(filesystemFeatures=[])))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(fullReadOnlyCheck=True)))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(transientFilesystemFeatures=["other"])))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(journalReplayed=True, journalReplay="kernel-mount")))  # action was format-new
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(journalReplayed=False, journalReplay="kernel-mount")))
        self.assertFalse(mutate(lambda r: r["volumes"][0].update(capacityBytes=1)))
        self.assertFalse(mutate(lambda r: r["volumes"].pop()))
        self.assertFalse(mutate(lambda r: r["volumes"][1].pop("checked")))


# ---------------------------------------------------------------------------------------------------- admission

class FakeSysfs:
    """A sysfs tree for one disk under a temp dir: <root>/dev/block/<maj>:<min>/{serial,ro,size,queue/...,holders}."""

    def __init__(self, root, major=254, minor=0, serial=gb.DATA_SERIAL, capacity=16 * MIB, ro="0", sector="512"):
        self.root = Path(root)
        base = self.root / "dev/block" / f"{major}:{minor}"
        (base / "queue").mkdir(parents=True)
        (base / "holders").mkdir()
        (base / "serial").write_text(serial + "\n")
        (base / "ro").write_text(ro + "\n")
        (base / "size").write_text(f"{capacity // 512}\n")
        (base / "queue/logical_block_size").write_text(sector + "\n")
        self.base = base
        (self.root / "mountinfo").write_text("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n")

    def mountinfo(self):
        return str(self.root / "mountinfo")


class AdmissionTests(TempDirTest):
    """The sysfs half of the production admission, against a fake tree; S_ISBLK cannot be faked without root, so the
    block-device test hands in a regular file and expects the refusal."""

    def target(self, capacity=16 * MIB):
        return {"capacityBytes": capacity, "sectorBytes": 512}

    def test_a_regular_file_is_not_a_block_device(self):
        path = self.dir / "node"
        write_image(path, 16 * MIB)
        admission = gb.BlockDeviceAdmission(sys_root=str(self.dir), mountinfo=str(self.dir / "mi"), dev_root=str(self.dir))
        with self.assertRaises(gb.Refused) as caught:
            admission.admit("data", str(path), 254, 0, gb.DATA_SERIAL, self.target())
        self.assertEqual(caught.exception.reason, "not_block_device")

    def test_the_node_must_live_under_the_device_root(self):
        admission = gb.BlockDeviceAdmission(sys_root=str(self.dir), dev_root=str(self.dir))
        for node in ("/etc/passwd", str(self.dir / ".." / "x"), "relative"):
            with self.subTest(node):
                with self.assertRaises(gb.Refused) as caught:
                    admission.admit("data", node, 254, 0, gb.DATA_SERIAL, self.target())
                self.assertEqual(caught.exception.reason, "device_node")

    def check(self, **fake):
        sysfs = FakeSysfs(self.dir, **{k: v for k, v in fake.items() if k in ("serial", "capacity", "ro", "sector")})
        admission = gb.BlockDeviceAdmission(sys_root=str(self.dir), mountinfo=sysfs.mountinfo(), dev_root=str(self.dir))
        return admission, sysfs

    def sysfs_check(self, admission, sysfs, serial=gb.DATA_SERIAL, major=254, minor=0, target=None, size=16 * MIB):
        path = self.dir / "image"
        write_image(path, size)
        fd = os.open(path, os.O_RDWR)
        self.fds.append(fd)
        return admission.check_sysfs(fd, major, minor, serial, target or self.target())

    def test_a_conforming_disk_passes_the_sysfs_checks(self):
        admission, sysfs = self.check()
        self.sysfs_check(admission, sysfs)

    def refused(self, reason, admission, sysfs, **kwargs):
        with self.assertRaises(gb.Refused) as caught:
            self.sysfs_check(admission, sysfs, **kwargs)
        self.assertEqual(caught.exception.reason, reason)

    def test_wrong_serial(self):
        admission, sysfs = self.check(serial="winter-environment")
        self.refused("device_serial", admission, sysfs)

    def test_read_only_device(self):
        admission, sysfs = self.check(ro="1")
        self.refused("device_readonly", admission, sysfs)

    def test_wrong_capacity_in_sysfs_or_on_the_descriptor(self):
        admission, sysfs = self.check(capacity=32 * MIB)
        self.refused("device_capacity", admission, sysfs)

    def test_descriptor_size_must_match_too(self):
        admission, sysfs = self.check()
        self.refused("device_capacity", admission, sysfs, size=32 * MIB)

    def test_wrong_sector_size(self):
        admission, sysfs = self.check(sector="4096")
        self.refused("device_sector", admission, sysfs)

    def test_partitions_refuse(self):
        admission, sysfs = self.check()
        (sysfs.base / "vda1").mkdir()
        (sysfs.base / "vda1/partition").write_text("1\n")
        self.refused("device_partitioned", admission, sysfs)

    def test_holders_refuse(self):
        admission, sysfs = self.check()
        (sysfs.base / "holders/dm-0").mkdir()
        self.refused("device_held", admission, sysfs)

    def test_an_already_mounted_device_refuses(self):
        admission, sysfs = self.check()
        (self.dir / "mountinfo").write_text("22 1 254:0 / /mnt rw - ext4 /dev/vda rw\n")
        self.refused("device_mounted", admission, sysfs)

    def test_mountinfo_parser(self):
        self.assertEqual(gb.parse_mountinfo_devices("22 1 8:1 / / rw - ext4 /dev/sda1 rw\n36 22 254:16 / /x rw - ext4 /dev/vdb rw\n"), {"8:1", "254:16"})


# ---------------------------------------------------------------------------------------------------- session + channel

class FakeChannel:
    def __init__(self, incoming):
        self.incoming = list(incoming)
        self.sent = []

    def receive(self):
        return self.incoming.pop(0) if self.incoming else None

    def send(self, tag, payload=b""):
        self.sent.append((tag, payload))


class FakeEngine:
    def __init__(self, error=None):
        self.replay = None
        self.error = error
        self.calls = 0

    def execute(self, plan, disks):
        self.calls += 1
        if self.error:
            raise self.error
        return {**plan, "volumes": [gb.observation(plan, t, False, list(plan["ext4Features"]), []) for t in plan["volumes"]]}


def down(name):
    return (gb.TAG_DOWN, payload_of(POSITIVE[name]))


class SessionTests(unittest.TestCase):
    BOOT = "66666666-6666-4666-8666-666666666666"

    def make(self, incoming, engine=None, verify=None, admit_error=None):
        closed = []

        class D:
            def __init__(self):
                self.fd = -1

            def close(self):
                closed.append(1)

        def admit(plan):
            if admit_error:
                raise admit_error
            return [D(), D()]

        channel = FakeChannel(incoming)
        engine = engine or FakeEngine()
        session = gb.Session(channel, engine, admit, self.BOOT, verify=verify or (lambda disks, plan: [UUID_A, UUID_B]))
        return session, channel, engine, closed

    def sent_messages(self, channel):
        return [(tag, gb.parse_bootstrap_message(body, "up") if tag == gb.TAG_UP else body) for tag, body in channel.sent]

    def test_the_whole_exchange(self):
        session, channel, engine, closed = self.make([down("bootstrap-down-plan"), down("bootstrap-down-ready"), (gb.TAG_MOUNT_RESULT, b"\x01")])
        self.assertEqual(session.run(), 0)
        kinds = [m[1]["t"] if m[0] == gb.TAG_UP else chr(m[0]) for m in self.sent_messages(channel)]
        self.assertEqual(kinds, ["hello", "receipt", "M", "mounted", "E"])
        self.assertEqual(channel.sent[0][1], payload_of(POSITIVE["bootstrap-up-hello"]))
        self.assertEqual(channel.sent[2][1], f"{UUID_A} {UUID_B}".encode())
        self.assertEqual(len(closed), 2)

    def test_the_disks_are_closed_before_the_mount_is_requested(self):
        order = []
        session, channel, engine, closed = self.make([down("bootstrap-down-plan"), down("bootstrap-down-ready"), (gb.TAG_MOUNT_RESULT, b"\x01")])
        original = channel.send

        def send(tag, payload=b""):
            if tag == gb.TAG_MOUNT:
                order.append(("mount-request", len(closed)))
            original(tag, payload)

        channel.send = send
        session.run()
        self.assertEqual(order, [("mount-request", 2)])

    def test_the_hello_is_the_first_thing_sent_and_nothing_else_is_sent_without_a_plan(self):
        session, channel, _, _ = self.make([])
        self.assertEqual(session.run(), 2)
        self.assertEqual(len(channel.sent), 1)
        self.assertEqual(self.sent_messages(channel)[0][1]["t"], "hello")

    def test_a_first_message_that_is_not_a_plan_is_answered_with_a_bad_plan_fault_and_never_executed(self):
        session, channel, engine, _ = self.make([down("bootstrap-down-ready")])
        self.assertEqual(session.run(), 1)
        self.assertEqual(engine.calls, 0)
        fault = self.sent_messages(channel)[-1][1]
        self.assertEqual((fault["t"], fault["code"], fault["operationId"], fault["nonce"]), ("fault", "bad_plan", "filesystem_55555555-5555-4555-8555-555555555555", "0f" * 16))

    def test_a_plan_whose_embedded_operation_id_differs_from_the_message_is_refused_with_a_fault_naming_the_message_ids(self):
        message = vector_plan_message()
        message["plan"]["operationId"] = "filesystem_other"
        session, channel, engine, _ = self.make([(gb.TAG_DOWN, gb.canonical_text({**message, "plan": gb.sorted_canonical(message["plan"])}).encode())])
        self.assertEqual(session.run(), 1)
        self.assertEqual(engine.calls, 0)
        fault = self.sent_messages(channel)[-1][1]
        self.assertEqual((fault["code"], fault["operationId"]), ("bad_plan", message["operationId"]))

    def test_a_plan_the_validators_refuse_is_answered_with_a_bad_plan_fault_not_silence(self):
        refused = bytes.fromhex(NEGATIVE["plan-protocol-2"]["hex"])[16:]
        session, channel, engine, _ = self.make([(gb.TAG_DOWN, refused)])
        self.assertEqual(session.run(), 1)
        self.assertEqual(engine.calls, 0)
        fault = self.sent_messages(channel)[-1][1]
        self.assertEqual((fault["code"], fault["operationId"], fault["nonce"]), ("bad_plan", "filesystem_55555555-5555-4555-8555-555555555555", "0f" * 16))

    def test_unsorted_nested_keys_also_get_a_fault(self):
        unsorted = bytes.fromhex(NEGATIVE["plan-unsorted-nested-keys"]["hex"])[16:]
        session, channel, engine, _ = self.make([(gb.TAG_DOWN, unsorted)])
        self.assertEqual(session.run(), 1)
        self.assertEqual(self.sent_messages(channel)[-1][1]["code"], "bad_plan")

    def test_a_message_that_names_no_valid_operation_gets_no_answer(self):
        for body in (b"{}", b"nope", b'{"operationId":"a b","nonce":"' + b"0" * 32 + b'"}', b'{"operationId":"ok","nonce":"' + b"0" * 31 + b'"}', b"\xff\xfe", b" " * (gb.MAX_BOOTSTRAP_PAYLOAD + 1)):
            with self.subTest(body[:20]):
                session, channel, engine, _ = self.make([(gb.TAG_DOWN, body)])
                self.assertEqual(session.run(), 2)
                self.assertEqual((len(channel.sent), engine.calls), (1, 0))   # only the hello

    def test_ids_in_an_oversize_message_are_not_salvaged(self):
        body = b'"operationId":"op_1","nonce":"' + b"a" * 32 + b'"' + b" " * gb.MAX_BOOTSTRAP_PAYLOAD
        self.assertIsNone(gb.salvage_ids(body))
        session, channel, engine, _ = self.make([(gb.TAG_DOWN, body)])
        self.assertEqual(session.run(), 2)

    def test_ids_are_salvaged_only_in_the_one_valid_spelling(self):
        self.assertEqual(gb.salvage_ids(b'garbage"operationId":"op_1","nonce":"' + b"a" * 32 + b'"garbage'), ("op_1", "a" * 32))
        self.assertIsNone(gb.salvage_ids(b'"operationId":"op_1"'))
        self.assertIsNone(gb.salvage_ids(b'"nonce":"' + b"a" * 32 + b'"'))
        self.assertIsNone(gb.salvage_ids(b'"operationId":"op_1","nonce":"' + b"A" * 32 + b'"'))
        self.assertIsNone(gb.salvage_ids("text"))

    def test_a_wrong_channel_tag_ends_the_session(self):
        session, channel, engine, _ = self.make([(gb.TAG_MOUNT_RESULT, b"\x01")])
        self.assertEqual(session.run(), 2)

    def fault_code_sent(self, error=None, admit_error=None):
        session, channel, engine, closed = self.make([down("bootstrap-down-plan")], FakeEngine(error), admit_error=admit_error)
        self.assertEqual(session.run(), 1)
        sent = self.sent_messages(channel)
        self.assertEqual(sent[-1][1]["t"], "fault")
        self.assertEqual((sent[-1][1]["operationId"], sent[-1][1]["nonce"]), ("filesystem_55555555-5555-4555-8555-555555555555", "0f" * 16))
        return sent[-1][1]["code"]

    def test_fault_codes_follow_the_phase_of_the_refusal(self):
        self.assertEqual(self.fault_code_sent(gb.Refused("x", "plan")), "bad_plan")
        self.assertEqual(self.fault_code_sent(gb.Refused("x", "probe")), "probe_failed")
        self.assertEqual(self.fault_code_sent(gb.Refused("x", "format")), "format_failed")
        self.assertEqual(self.fault_code_sent(gb.Refused("x", "replay")), "replay_failed")
        self.assertEqual(self.fault_code_sent(gb.Refused("x", "mount")), "mount_failed")
        self.assertEqual(self.fault_code_sent(gb.Refused("x")), "internal")
        self.assertEqual(self.fault_code_sent(RuntimeError("boom")), "internal")
        self.assertEqual(self.fault_code_sent(admit_error=gb.Refused("device_serial", "probe")), "probe_failed")

    def test_a_fault_never_carries_free_text(self):
        session, channel, engine, _ = self.make([down("bootstrap-down-plan")], FakeEngine(gb.Refused("secret-path-abc", "probe")))
        session.run()
        self.assertNotIn(b"secret", b"".join(body for _, body in channel.sent))

    def test_a_ready_for_another_operation_or_nonce_is_refused_with_a_fault_and_mounts_nothing(self):
        other = json.loads(payload_of(POSITIVE["bootstrap-down-ready"]))
        for patch in ({"nonce": "ab" * 16}, {"operationId": "filesystem_other"}):
            with self.subTest(patch):
                bad = (gb.TAG_DOWN, gb.canonical_text({**other, **patch}).encode())
                session, channel, engine, closed = self.make([down("bootstrap-down-plan"), bad, (gb.TAG_MOUNT_RESULT, b"\x01")])
                self.assertEqual(session.run(), 1)
                self.assertFalse(any(tag == gb.TAG_MOUNT for tag, _ in channel.sent))
                fault = self.sent_messages(channel)[-1][1]
                self.assertEqual((fault["t"], fault["code"], fault["operationId"], fault["nonce"]), ("fault", "internal", "filesystem_55555555-5555-4555-8555-555555555555", "0f" * 16))
                self.assertEqual(len(closed), 2)       # the disks were released

    def test_a_plan_where_ready_is_expected_is_refused_with_a_fault_and_mounts_nothing(self):
        session, channel, _, _ = self.make([down("bootstrap-down-plan"), down("bootstrap-down-plan")])
        self.assertEqual(session.run(), 1)
        self.assertFalse(any(tag == gb.TAG_MOUNT for tag, _ in channel.sent))

    def test_a_malformed_ready_is_refused_with_a_fault(self):
        session, channel, _, _ = self.make([down("bootstrap-down-plan"), (gb.TAG_DOWN, b'{"v":1,"t":"ready"}')])
        self.assertEqual(session.run(), 1)
        self.assertEqual(self.sent_messages(channel)[-1][1]["t"], "fault")

    def test_a_closed_channel_while_waiting_for_ready_ends_the_session_and_releases_the_disks(self):
        session, channel, _, closed = self.make([down("bootstrap-down-plan")])
        self.assertEqual(session.run(), 2)
        self.assertEqual(len(closed), 2)

    def test_mounted_is_sent_only_after_pid_1_reports_success(self):
        for result in (b"\x00", b"\x02", b""):
            with self.subTest(result):
                session, channel, _, _ = self.make([down("bootstrap-down-plan"), down("bootstrap-down-ready"), (gb.TAG_MOUNT_RESULT, result)])
                self.assertEqual(session.run(), 1)
                kinds = [m[1]["t"] for m in self.sent_messages(channel) if m[0] == gb.TAG_UP]
                self.assertEqual(kinds[-1], "fault")
                self.assertNotIn("mounted", kinds)
                self.assertEqual(self.sent_messages(channel)[-1][1]["code"], "mount_failed")

    def test_a_failed_last_look_blocks_the_mount_request(self):
        def verify(disks, plan):
            raise gb.Refused("journal_recovery_required", "mount")

        session, channel, _, _ = self.make([down("bootstrap-down-plan"), down("bootstrap-down-ready")], verify=verify)
        self.assertEqual(session.run(), 1)
        self.assertFalse(any(tag == gb.TAG_MOUNT for tag, _ in channel.sent))
        self.assertEqual(self.sent_messages(channel)[-1][1]["code"], "mount_failed")

    def test_the_replay_request_round_trips_through_the_channel(self):
        session, channel, _, _ = self.make([(gb.TAG_REPLAY_RESULT, b"\x01")])
        self.assertTrue(session.replay("data"))
        self.assertEqual(channel.sent, [(gb.TAG_REPLAY, b"data")])
        session, channel, _, _ = self.make([(gb.TAG_REPLAY_RESULT, b"\x00")])
        self.assertFalse(session.replay("environment"))
        session, channel, _, _ = self.make([(gb.TAG_MOUNT_RESULT, b"\x01")])
        with self.assertRaises(gb.Refused):
            session.replay("data")

    def test_the_engine_gets_the_session_replay_route_unless_it_has_its_own(self):
        session, channel, engine, _ = self.make([down("bootstrap-down-plan")])
        session.run()
        self.assertEqual(engine.replay, session.replay)


class VerifyBeforeMountTests(TempDirTest):
    def test_the_last_look(self):
        plan = small_plan("probe-existing", "probe-existing")
        disks = []
        for index, target in enumerate(plan["volumes"]):
            _, disk = self.image(f"v{index}.img", target["capacityBytes"], make_sb(target["expectedFilesystemUUID"], target["capacityBytes"] // 4096))
            disks.append(disk)
        self.assertEqual(gb.verify_before_mount(disks, plan), [plan["volumes"][0]["expectedFilesystemUUID"], plan["volumes"][1]["expectedFilesystemUUID"]])

        def refused(sb, reason, index=0):
            os.pwrite(disks[index].fd, sb, 1024)
            with self.assertRaises(gb.Refused) as caught:
                gb.verify_before_mount(disks, plan)
            self.assertEqual((caught.exception.reason, caught.exception.phase), (reason, "mount"))
            os.pwrite(disks[index].fd, make_sb(plan["volumes"][index]["expectedFilesystemUUID"], plan["volumes"][index]["capacityBytes"] // 4096), 1024)

        refused(make_sb(UUID_B, 4096), "filesystem_changed")
        refused(make_sb(plan["volumes"][0]["expectedFilesystemUUID"], 8192), "filesystem_changed")
        refused(make_sb(plan["volumes"][0]["expectedFilesystemUUID"], 4096, incompat=0x4), "journal_recovery_required")
        refused(make_sb(plan["volumes"][1]["expectedFilesystemUUID"], 4096, state=0), "filesystem_not_clean", index=1)


class ChannelTests(unittest.TestCase):
    def test_golden_framing(self):
        self.assertEqual(gb.ctl_encode(ord("B"), b"hi").hex(), "4200000002000000" + "6869")
        self.assertEqual(gb.ctl_encode(ord("E")).hex(), "4500000000000000")

    def test_round_trip_over_pipes(self):
        read_fd, write_fd = os.pipe()
        try:
            channel = gb.PipeChannel(read_fd, write_fd)
            channel.send(gb.TAG_UP, b"payload")
            channel.send(gb.TAG_DONE)
            self.assertEqual(channel.receive(), (gb.TAG_UP, b"payload"))
            self.assertEqual(channel.receive(), (gb.TAG_DONE, b""))
            os.close(write_fd)
            write_fd = -1
            self.assertIsNone(channel.receive())
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def test_truncated_and_oversize_messages_are_refused(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"B\x00\x00\x00\x09\x00\x00\x00abc")
            os.close(write_fd)
            with self.assertRaises(gb.Refused):
                gb.PipeChannel(read_fd, -1).receive()
        finally:
            os.close(read_fd)
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"B\x00\x00\x00" + struct.pack("<I", gb.CTL_MAX_PAYLOAD + 1))
            with deadline(30), self.assertRaises(gb.Refused):  # the write end stays open: a missing ceiling would wait for the bytes
                gb.PipeChannel(read_fd, -1).receive()
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_a_header_cut_short_is_refused_not_mistaken_for_a_clean_end(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"B\x00\x00")
            os.close(write_fd)
            write_fd = -1
            with self.assertRaises(gb.Refused):
                gb.PipeChannel(read_fd, -1).receive()
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def test_reserved_bytes_must_be_zero(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, b"B\x01\x00\x00\x00\x00\x00\x00")
            with self.assertRaises(gb.Refused):
                gb.PipeChannel(read_fd, -1).receive()
        finally:
            os.close(read_fd)
            os.close(write_fd)


class EntryPointTests(unittest.TestCase):
    def test_arguments(self):
        read_fd, write_fd, devices = gb.parse_arguments(["--channel-fds", "3,4", "--data", "/dev/vda:254:0", "--environment", "/dev/vdb:254:16"])
        self.assertEqual((read_fd, write_fd), (3, 4))
        self.assertEqual(devices, {"data": ("/dev/vda", 254, 0), "environment": ("/dev/vdb", 254, 16)})

    def test_bad_arguments_are_refused(self):
        for argv in ([], ["--data", "/dev/vda:1:2"], ["--channel-fds", "3", "--data", "/dev/vda:1:2", "--environment", "/dev/vdb:1:2"], ["--channel-fds", "a,b", "--data", "/dev/vda:1:2", "--environment", "/dev/vdb:1:2"],
                     ["--channel-fds", "3,4", "--data", "/dev/vda:1", "--environment", "/dev/vdb:1:2"],
                     ["--channel-fds", "3,4", "--data", "/dev/vda:a:2", "--environment", "/dev/vdb:1:2"],
                     ["--channel-fds", "3,4", "--data", "/dev/vda:1:2", "--data", "/dev/vda:1:2", "--environment", "/dev/vdb:1:2"],
                     ["--other", "x", "--channel-fds", "3,4", "--data", "/dev/vda:1:2", "--environment", "/dev/vdb:1:2"]):
            with self.subTest(argv):
                with self.assertRaises(gb.Refused):
                    gb.parse_arguments(argv)

    def test_main_returns_64_for_bad_arguments(self):
        self.assertEqual(gb.main([]), 64)

    def test_the_module_never_imports_ctypes_or_sockets(self):
        import subprocess
        code = "import sys; sys.path.insert(0, %r); import guest_bootstrap; print('ctypes' in sys.modules, 'socket' in sys.modules)" % str(HERE)
        out = subprocess.run([sys.executable, "-I", "-S", "-B", "-c", code], capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(out, ["False", "False"])

    def test_boot_id_format_is_enforced(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "boot_id"
            path.write_text("66666666-6666-4666-8666-666666666666\n")
            self.assertEqual(gb.read_boot_id(str(path)), "66666666-6666-4666-8666-666666666666")
            path.write_text("NOT A BOOT ID\n")
            with self.assertRaises(gb.Refused):
                gb.read_boot_id(str(path))


# ---------------------------------------------------------------------------------------------------- real e2fsprogs oracle

REAL_TOOLS = sys.platform == "linux" and all(shutil.which(name) for name in ("mke2fs", "dumpe2fs", "e2fsck"))


@unittest.skipUnless(REAL_TOOLS and os.environ.get("WINTER_GUEST_BOOTSTRAP_E2FSPROGS", "1") == "1",
                     "needs Linux with mke2fs, dumpe2fs and e2fsck (the CI job); skipped, not passed, elsewhere")
class RealE2fsprogsOracle(TempDirTest):
    """The actual Debian/Ubuntu e2fsprogs against regular-file images: the engine formats two volumes, the direct superblock
    read and `dumpe2fs -h` agree, a full read-only check passes, and an unclean image is reported as needs_recovery.
    Unprivileged: no mount, no loop device."""

    def test_format_then_probe_then_full_check_then_reprobe(self):
        plan = small_plan()
        disks = []
        for index, target in enumerate(plan["volumes"]):
            _, disk = self.image(f"v{index}.img", target["capacityBytes"])
            disks.append(disk)
        engine = gb.Bootstrap(tools=gb.Tools(), replay=None)
        receipt = engine.execute(plan, disks)
        self.assertTrue(gb.matches_filesystem_receipt(plan, receipt))
        again = small_plan("probe-existing", "probe-existing")
        again["operationId"] = "filesystem_second"
        again = gb.sorted_canonical(again)
        self.assertTrue(gb.matches_filesystem_receipt(again, gb.Bootstrap(tools=gb.Tools()).execute(again, disks)))
        full = gb.sorted_canonical({**again, "operationId": "filesystem_third", "checkMode": "full-read-only"})
        self.assertTrue(gb.matches_filesystem_receipt(full, gb.Bootstrap(tools=gb.Tools()).execute(full, disks)))

    def test_the_first_sector_of_a_real_new_volume_is_untouched_by_mke2fs(self):
        plan = small_plan()
        path, disk = self.image("v.img", 16 * MIB)
        gb.Tools().run("mke2fs", gb.mke2fs_args(UUID_A, True), disk.fd, 10**12, phase="format")
        self.assertEqual(os.pread(disk.fd, 1024, 0), bytes(1024))
        sb = gb.parse_superblock(os.pread(disk.fd, 1024, 1024))
        self.assertEqual(sb["features"], gb.EXT4_FEATURES)

    def test_a_real_debugfs_recovery_flag_is_seen_as_transient_by_both_observers(self):
        if not shutil.which("debugfs"):
            self.skipTest("no debugfs")
        import subprocess
        plan = small_plan("probe-existing", "probe-existing")
        target = plan["volumes"][0]
        path, disk = self.image("v.img", 16 * MIB)
        gb.Tools().run("mke2fs", gb.mke2fs_args(target["expectedFilesystemUUID"], True), disk.fd, 10**12, phase="format")
        subprocess.run(["debugfs", "-w", "-R", "feature needs_recovery", str(path)], check=True, capture_output=True)
        features, transient = gb.probe(disk.fd, target, time_now() + 60, plan, gb.Tools())
        self.assertEqual((features, transient), (gb.EXT4_FEATURES, ["needs_recovery"]))


def time_now():
    import time
    return time.monotonic()


if __name__ == "__main__":
    unittest.main()
