"""No-effect protocol regressions on every OS; actual ext4 only explicit Linux opt-in."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fixture_bootstrap", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class Pair:
    def __init__(self, data_capacity=16 * 1024 * 1024):
        self.data_capacity = data_capacity
    def __enter__(self):
        self.root = tempfile.TemporaryDirectory(prefix="winter-filesystem-bootstrap-")
        self.fds = []
        self.plan = {"protocolVersion": 3, "priorReplay": None, "virginZeroProvenance": "new-sparse-creation", "ext4Features": list(bootstrap.EXT4_FEATURES), "requiredMountOptions": list(bootstrap.REQUIRED_MOUNT_OPTIONS), "checkMode": "normal", "operationId": "filesystem_" + str(uuid.uuid4()), "homeId": "fixture-home", "workspaceId": "fixture-workspace", "owner": {"controllerInstanceId": "fixture-controller", "workerInstanceId": "fixture-worker", "incarnationId": "fixture-incarnation", "leaseEpoch": 1, "runtimeImageDigest": "b" * 64}, "volumes": []}
        for purpose in ("data", "environment"):
            fd = os.open(Path(self.root.name) / (purpose + ".ext4"), os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC, 0o600)
            self.fds.append(fd); os.ftruncate(fd, self.data_capacity if purpose == "data" else bootstrap.MIN_BYTES); os.fsync(fd); st = os.fstat(fd)
            self.plan["volumes"].append({"volumeId": "volume_" + str(uuid.uuid4()), "creationId": "creation_" + str(uuid.uuid4()), "purpose": purpose, "identity": {"device": str(st.st_dev), "inode": str(st.st_ino), "uid": st.st_uid, "mode": stat.S_IMODE(st.st_mode)}, "capacityBytes": st.st_size, "sectorBytes": 512, "filesystemBlockBytes": 4096, "expectedFilesystemUUID": str(uuid.uuid4()), "action": "format-new", "readyOperationId": None})
        return self
    def __exit__(self, *_):
        for fd in self.fds: os.close(fd)
        self.root.cleanup()
    def digests(self):
        hashes = []
        for fd in self.fds:
            digest = hashlib.sha256()
            for offset in range(0, os.fstat(fd).st_size, 1024 * 1024): digest.update(os.pread(fd, 1024 * 1024, offset))
            hashes.append(digest.hexdigest())
        return hashes

class ProtocolTests(unittest.TestCase):
    def test_closed_plan_and_independent_volume_uuid(self):
        with Pair() as pair:
            self.assertEqual(bootstrap.validate_plan(pair.plan), pair.plan)
            for mutation in ("version", "extra", "owner", "order", "uuid", "capacity", "shared", "extension", "features", "mount", "zero"):
                bad = copy.deepcopy(pair.plan)
                if mutation == "version": bad["protocolVersion"] = True
                elif mutation == "extra": bad["payload"] = "forbidden"
                elif mutation == "owner": bad["owner"]["leaseEpoch"] = 0
                elif mutation == "order": bad["volumes"].reverse()
                elif mutation == "uuid": bad["volumes"][0]["expectedFilesystemUUID"] = "not-a-uuid"
                elif mutation == "capacity": bad["volumes"][0]["capacityBytes"] += 1
                elif mutation == "shared": bad["volumes"][1]["volumeId"] = bad["volumes"][0]["volumeId"]
                elif mutation == "features": bad["ext4Features"] = ["extent"]
                elif mutation == "mount": bad["requiredMountOptions"] = []
                elif mutation == "zero": bad["virginZeroProvenance"] = "unknown-import"
                elif mutation == "extension": bad["volumes"][0]["identity"]["rawPath"] = "/dev/forbidden"
                with self.subTest(mutation=mutation), self.assertRaises(bootstrap.Refused): bootstrap.validate_plan(bad)
    def test_fd_identity_capacity_mode_and_nonzero_refusal(self):
        with Pair() as pair:
            fd, target = pair.fds[0], pair.plan["volumes"][0]
            bootstrap.check_fixture_fd(fd, target)
            bootstrap.all_zero(fd, target["capacityBytes"], time.monotonic() + 5)
            os.pwrite(fd, b"NONSECRET PRESERVE", target["capacityBytes"] - 40)
            before = pair.digests()
            with self.assertRaisesRegex(bootstrap.Refused, "not_virgin"): bootstrap.all_zero(fd, target["capacityBytes"], time.monotonic() + 5)
            self.assertEqual(pair.digests(), before)
            with self.assertRaisesRegex(bootstrap.Refused, "deadline"): bootstrap.all_zero(fd, target["capacityBytes"], time.monotonic() - 1)
            bad = copy.deepcopy(target); bad["identity"]["inode"] = "0"
            with self.assertRaises(bootstrap.Refused): bootstrap.check_fixture_fd(fd, bad)
            read_fd = os.open(Path(pair.root.name) / "data.ext4", os.O_RDONLY | os.O_CLOEXEC)
            try:
                with self.assertRaises(bootstrap.Refused): bootstrap.check_fixture_fd(read_fd, target)
            finally: os.close(read_fd)
    def test_non_linux_refuses_before_authentication_or_helper(self):
        if sys.platform == "linux": self.skipTest("Darwin-only platform refusal")
        with Pair() as pair:
            called = []
            receiver = bootstrap.FixtureBootstrap(lambda *_: called.append(True))
            with self.assertRaisesRegex(bootstrap.Refused, "linux_only"): receiver.execute(pair.plan, pair.fds, object())
            self.assertEqual(called, [])
    def test_authenticator_is_mandatory(self):
        with self.assertRaises(bootstrap.Refused): bootstrap.FixtureBootstrap(None)
    def test_transient_journal_feature_is_reported_not_compared_as_persistent_or_silently_repaired(self):
        # Zero filesystem/helper I/O: drive the actual probe with synthetic superblock/header data.
        expected_uuid = "11111111-1111-4111-8111-111111111111"
        target = {"expectedFilesystemUUID": expected_uuid, "capacityBytes": bootstrap.MIN_BYTES}
        sb = bytearray(1024); struct.pack_into("<H", sb, 0x38, 0xEF53); struct.pack_into("<I", sb, 4, bootstrap.MIN_BYTES // 4096); struct.pack_into("<I", sb, 0x18, 2); sb[0x68:0x78] = uuid.UUID(expected_uuid).bytes
        for mode in ("normal", "full-read-only"):
            called = []
            def tool(name, *_args, **_kwargs):
                called.append(name)
                if name == "blkid": return 0, f"TYPE=ext4\nUUID={expected_uuid}\nBLOCK_SIZE=4096\n"
                if name == "e2fsck": return 0, ""
                return 0, f"Filesystem UUID: {expected_uuid}\nBlock size: 4096\nBlock count: {bootstrap.MIN_BYTES // 4096}\nFilesystem state: clean\nFilesystem features: " + " ".join(bootstrap.EXT4_FEATURES + ["needs_recovery"]) + "\n"
            with patch.object(bootstrap.os, "open", return_value=101), patch.object(bootstrap.os, "close"), patch.object(bootstrap.os, "pread", return_value=bytes(sb)), patch.object(bootstrap, "run_tool", side_effect=tool):
                features, transient = bootstrap.probe(99, target, 1, {"ext4Features": bootstrap.EXT4_FEATURES, "checkMode": mode})
            self.assertEqual(features, bootstrap.EXT4_FEATURES); self.assertEqual(transient, ["needs_recovery"])
            self.assertEqual("e2fsck" in called, mode == "full-read-only")
    def test_replay_preflights_both_then_only_journal_and_fresh_clean_receipt(self):
        with Pair() as pair:
            plan = copy.deepcopy(pair.plan)
            for target in plan["volumes"]: target["action"] = "replay-journal-then-probe"; target["readyOperationId"] = "prior-ready"
            transient = {pair.fds[0]: ["needs_recovery"], pair.fds[1]: []}; events = []
            def probe(fd, *_args):
                events.append(("probe", fd)); return bootstrap.EXT4_FEATURES, list(transient[fd])
            def replay(fd, target, deadline):
                events.append(("kernel-mount", fd)); transient[fd] = []; return "kernel-mount"
            token = object(); receiver = bootstrap.FixtureBootstrap(lambda p, proof: p == plan and proof is token, replay)
            with patch.object(bootstrap.sys, "platform", "linux"), patch.object(bootstrap, "probe", side_effect=probe), patch.object(bootstrap, "run_tool") as tool:
                result = receiver.execute(plan, pair.fds, token)
            self.assertEqual(events[:3], [("probe", pair.fds[0]), ("probe", pair.fds[1]), ("kernel-mount", pair.fds[0])])
            self.assertEqual([v["journalReplayed"] for v in result["volumes"]], [True, False]); self.assertEqual([v["journalReplay"] for v in result["volumes"]], ["kernel-mount", "none"]); self.assertTrue(all(not v["transientFilesystemFeatures"] for v in result["volumes"])); tool.assert_not_called()
    def test_second_preflight_failure_prevents_any_journal_write(self):
        with Pair() as pair:
            plan = copy.deepcopy(pair.plan)
            for target in plan["volumes"]: target["action"] = "replay-journal-then-probe"; target["readyOperationId"] = "prior-ready"
            def probe(fd, *_args):
                if fd == pair.fds[1]: raise bootstrap.Refused("filesystem_mismatch")
                return bootstrap.EXT4_FEATURES, ["needs_recovery"]
            token = object(); receiver = bootstrap.FixtureBootstrap(lambda p, proof: p == plan and proof is token)
            with patch.object(bootstrap.sys, "platform", "linux"), patch.object(bootstrap, "probe", side_effect=probe), patch.object(bootstrap, "run_tool") as tool, self.assertRaisesRegex(bootstrap.Refused, "filesystem_mismatch"):
                receiver.execute(plan, pair.fds, token)
            tool.assert_not_called()
    def test_clean_replay_permission_runs_probe_only_and_reports_no_replay(self):
        with Pair() as pair:
            plan = copy.deepcopy(pair.plan)
            for target in plan["volumes"]: target["action"] = "replay-journal-then-probe"; target["readyOperationId"] = "prior-ready"
            token = object(); receiver = bootstrap.FixtureBootstrap(lambda p, proof: p == plan and proof is token)
            with patch.object(bootstrap.sys, "platform", "linux"), patch.object(bootstrap, "probe", return_value=(bootstrap.EXT4_FEATURES, [])), patch.object(bootstrap, "run_tool") as tool:
                result = receiver.execute(plan, pair.fds, token)
            tool.assert_not_called(); self.assertTrue(all(not v["journalReplayed"] for v in result["volumes"]))
    def test_unknown_features_and_error_state_still_refuse_normal_header_probe(self):
        expected_uuid = "11111111-1111-4111-8111-111111111111"
        target = {"expectedFilesystemUUID": expected_uuid, "capacityBytes": bootstrap.MIN_BYTES}
        sb = bytearray(1024); struct.pack_into("<H", sb, 0x38, 0xEF53); struct.pack_into("<I", sb, 4, bootstrap.MIN_BYTES // 4096); struct.pack_into("<I", sb, 0x18, 2); sb[0x68:0x78] = uuid.UUID(expected_uuid).bytes
        for extra, state, reason in [("unknown-feature", "clean", "filesystem_features"), ("needs_recovery needs_recovery", "clean", "filesystem_features"), ("needs_recovery", "clean with errors", "explicit_full_check_required")]:
            def tool(name, *_args, **_kwargs):
                if name == "blkid": return 0, f"TYPE=ext4\nUUID={expected_uuid}\nBLOCK_SIZE=4096\n"
                return 0, f"Filesystem UUID: {expected_uuid}\nBlock size: 4096\nBlock count: {bootstrap.MIN_BYTES // 4096}\nFilesystem state: {state}\nFilesystem features: " + " ".join(bootstrap.EXT4_FEATURES) + " " + extra + "\n"
            with patch.object(bootstrap.os, "open", return_value=101), patch.object(bootstrap.os, "close"), patch.object(bootstrap.os, "pread", return_value=bytes(sb)), patch.object(bootstrap, "run_tool", side_effect=tool), self.assertRaisesRegex(bootstrap.Refused, reason):
                bootstrap.probe(99, target, 1, {"ext4Features": bootstrap.EXT4_FEATURES, "checkMode": "normal"})

@unittest.skipUnless(sys.platform == "linux" and os.getenv("WINTER_RUN_LINUX_FILESYSTEM_FIXTURE") == "1", "explicit Linux disposable fixture only")
class LinuxFilesystemTests(unittest.TestCase):
    def receiver(self, plan):
        proof = object(); expected = copy.deepcopy(plan)
        return bootstrap.FixtureBootstrap(lambda incoming, passed: passed is proof and incoming == expected), proof
    def test_actual_pair_formats_then_probe_only_preserves_bytes_and_uuid(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan)
            observed = receiver.execute(pair.plan, pair.fds, proof)
            self.assertEqual([v["filesystemType"] for v in observed["volumes"]], ["ext4", "ext4"])
            self.assertTrue(all(v["flushConfirmed"] and v["checked"] and v["filesystemFeatures"] == bootstrap.EXT4_FEATURES and not v["fullReadOnlyCheck"] for v in observed["volumes"]))
            before = pair.digests()
            with self.assertRaisesRegex(bootstrap.Refused, "one_shot_consumed"): receiver.execute(pair.plan, pair.fds, proof)
            probe = copy.deepcopy(pair.plan); probe["operationId"] = "filesystem_" + str(uuid.uuid4())
            for target in probe["volumes"]: target["action"] = "probe-existing"; target["readyOperationId"] = pair.plan["operationId"]
            cold, cold_proof = self.receiver(probe); second = cold.execute(probe, pair.fds, cold_proof)
            self.assertEqual([v["filesystemUUID"] for v in second["volumes"]], [v["filesystemUUID"] for v in observed["volumes"]]); self.assertEqual(pair.digests(), before)
            # Even a fresh receiver/new nonce cannot reformat an already formatted image.
            retry = copy.deepcopy(pair.plan); retry["operationId"] = "filesystem_" + str(uuid.uuid4())
            fresh, new_proof = self.receiver(retry)
            with self.assertRaisesRegex(bootstrap.Refused, "not_virgin"): fresh.execute(retry, pair.fds, new_proof)
            self.assertEqual(pair.digests(), before)
    def test_normal_probe_avoids_fsck_and_explicit_full_check_preserves_bytes(self):
        with Pair() as pair:
            seen = []; original = bootstrap.run_tool
            def traced(name, *args, **kwargs):
                seen.append(name); return original(name, *args, **kwargs)
            bootstrap.run_tool = traced
            try:
                receiver, proof = self.receiver(pair.plan); receiver.execute(pair.plan, pair.fds, proof)
                self.assertIn("dumpe2fs", seen); self.assertNotIn("e2fsck", seen)
                before = pair.digests(); full = copy.deepcopy(pair.plan)
                full["operationId"] = "filesystem_" + str(uuid.uuid4()); full["checkMode"] = "full-read-only"
                for target in full["volumes"]: target["action"] = "probe-existing"; target["readyOperationId"] = pair.plan["operationId"]
                checker, token = self.receiver(full); observed = checker.execute(full, pair.fds, token)
                self.assertIn("e2fsck", seen); self.assertTrue(all(v["fullReadOnlyCheck"] for v in observed["volumes"])); self.assertEqual(pair.digests(), before)
            finally: bootstrap.run_tool = original
    def test_interrupted_read_only_probe_retries_new_nonce_without_format_or_data_change(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan); receiver.execute(pair.plan, pair.fds, proof); before = pair.digests()
            probe = copy.deepcopy(pair.plan); probe["operationId"] = "filesystem_" + str(uuid.uuid4())
            for target in probe["volumes"]: target["action"] = "probe-existing"; target["readyOperationId"] = pair.plan["operationId"]
            interrupted, token = self.receiver(probe); original = bootstrap.run_tool; seen = []
            def fail_header(name, *args, **kwargs):
                seen.append(name)
                if name == "dumpe2fs": raise bootstrap.Refused("injected_read_only_interruption")
                return original(name, *args, **kwargs)
            bootstrap.run_tool = fail_header
            try:
                with self.assertRaisesRegex(bootstrap.Refused, "injected_read_only_interruption"): interrupted.execute(probe, pair.fds, token)
            finally: bootstrap.run_tool = original
            self.assertNotIn("mke2fs", seen); self.assertEqual(pair.digests(), before)
            retry = copy.deepcopy(probe); retry["operationId"] = "filesystem_" + str(uuid.uuid4())
            next_receiver, next_proof = self.receiver(retry); observed = next_receiver.execute(retry, pair.fds, next_proof)
            self.assertTrue(all(v["action"] == "probe-existing" for v in observed["volumes"])); self.assertEqual(pair.digests(), before)
    def test_actual_needs_recovery_normal_probe_reports_state_without_fsck_or_byte_changes(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan); receiver.execute(pair.plan, pair.fds, proof)
            bootstrap.run_tool("debugfs", ["-w", "-R", "feature needs_recovery"], pair.fds[0], time.monotonic() + 20)
            self.assertTrue(struct.unpack_from("<I", os.pread(pair.fds[0], 1024, 1024), 0x60)[0] & 4)
            before = pair.digests(); probe = copy.deepcopy(pair.plan); probe["operationId"] = "filesystem_" + str(uuid.uuid4())
            for target in probe["volumes"]: target["action"] = "probe-existing"; target["readyOperationId"] = pair.plan["operationId"]
            called = []; original = bootstrap.run_tool
            def traced(name, *args, **kwargs): called.append(name); return original(name, *args, **kwargs)
            bootstrap.run_tool = traced
            try:
                checker, token = self.receiver(probe); observed = checker.execute(probe, pair.fds, token)
            finally: bootstrap.run_tool = original
            self.assertEqual(observed["volumes"][0]["transientFilesystemFeatures"], ["needs_recovery"])
            self.assertEqual(observed["volumes"][1]["transientFilesystemFeatures"], [])
            self.assertEqual(observed["volumes"][0]["filesystemFeatures"], bootstrap.EXT4_FEATURES)
            self.assertNotIn("e2fsck", called); self.assertEqual(pair.digests(), before)
    # Historical e2fsck journal_only case failed CI38256511895/job114835873624.
    # Its immutable source/evidence remains in9d6a3a70; do not force interactive/preen.
    # Reviewed privileged kernel replay coverage lives in test_kernel_replay.py.
    def test_sparse_multigroup_image_has_exact_features_and_lazy_zero_inode_table(self):
        # At 4096 bytes/block a block group covers128MiB; use256MiB for an unused
        # second inode table. Environment remains16MiB. No mount or loop device.
        with Pair(data_capacity=256 * 1024 * 1024) as pair:
            receiver, proof = self.receiver(pair.plan); observed = receiver.execute(pair.plan, pair.fds, proof)
            self.assertEqual(observed["volumes"][0]["filesystemFeatures"], bootstrap.EXT4_FEATURES)
            self.assertEqual(observed["requiredMountOptions"], ["noinit_itable"])
            fd = pair.fds[0]; sb = os.pread(fd, 1024, 1024)
            # Feature masks independently verify the actual bytes, not just receipt labels.
            self.assertEqual(struct.unpack_from("<III", sb, 0x5C), (0x24, 0x2C2, 0x46B))
            desc_size = struct.unpack_from("<H", sb, 0xFE)[0]; self.assertEqual(desc_size, 64)
            group1 = os.pread(fd, desc_size, 4096 + desc_size)
            self.assertFalse(struct.unpack_from("<H", group1, 0x12)[0] & 4)  # not INODE_ZEROED
            inode_table = struct.unpack_from("<I", group1, 8)[0] | (struct.unpack_from("<I", group1, 0x28)[0] << 32)
            inode_bytes = struct.unpack_from("<I", sb, 0x28)[0] * struct.unpack_from("<H", sb, 0x58)[0]
            self.assertGreater(inode_table, 0); self.assertGreater(inode_bytes, 0)
            self.assertFalse(any(os.pread(fd, inode_bytes, inode_table * 4096)))
            self.assertLess(os.fstat(fd).st_blocks * 512, os.fstat(fd).st_size // 2)
    def test_unknown_second_disk_preflights_pair_before_first_write(self):
        with Pair() as pair:
            os.pwrite(pair.fds[1], b"UNKNOWN NONSECRET DATA", bootstrap.MIN_BYTES - 40); before = pair.digests()
            receiver, proof = self.receiver(pair.plan)
            with self.assertRaisesRegex(bootstrap.Refused, "not_virgin"): receiver.execute(pair.plan, pair.fds, proof)
            self.assertEqual(pair.digests(), before)
            with self.assertRaisesRegex(bootstrap.Refused, "one_shot_consumed"): receiver.execute(pair.plan, pair.fds, proof)
    def test_wrong_expected_uuid_is_probe_refusal_without_repair(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan); receiver.execute(pair.plan, pair.fds, proof); before = pair.digests()
            wrong = copy.deepcopy(pair.plan); wrong["operationId"] = "filesystem_" + str(uuid.uuid4())
            for target in wrong["volumes"]: target["action"] = "probe-existing"; target["readyOperationId"] = pair.plan["operationId"]
            wrong["volumes"][0]["expectedFilesystemUUID"] = str(uuid.uuid4()); prober, token = self.receiver(wrong)
            with self.assertRaisesRegex(bootstrap.Refused, "filesystem_mismatch"): prober.execute(wrong, pair.fds, token)
            self.assertEqual(pair.digests(), before)
    def test_failed_helper_retains_one_shot_and_partial_bytes_without_retry(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan); original = bootstrap.run_tool
            def injected(name, args, fd, *_args, **_kwargs):
                if name == "mke2fs": os.pwrite(fd, b"SYNTHETIC PARTIAL FORMAT", 4096); raise bootstrap.Refused("injected_helper_failure")
                return original(name, args, fd, *_args, **_kwargs)
            bootstrap.run_tool = injected
            try:
                with self.assertRaisesRegex(bootstrap.Refused, "injected_helper_failure"): receiver.execute(pair.plan, pair.fds, proof)
            finally: bootstrap.run_tool = original
            before = pair.digests()
            with self.assertRaisesRegex(bootstrap.Refused, "one_shot_consumed"): receiver.execute(pair.plan, pair.fds, proof)
            self.assertEqual(pair.digests(), before)
    def test_untrusted_stale_envelope_denied_before_any_disk_effect(self):
        with Pair() as pair:
            receiver, proof = self.receiver(pair.plan); before = pair.digests()
            with self.assertRaisesRegex(bootstrap.Refused, "native_envelope_denied"): receiver.execute(pair.plan, pair.fds, object())
            changed = copy.deepcopy(pair.plan); changed["owner"]["leaseEpoch"] += 1
            with self.assertRaisesRegex(bootstrap.Refused, "native_envelope_denied"): receiver.execute(changed, pair.fds, proof)
            self.assertEqual(pair.digests(), before)

if __name__ == "__main__":
    unittest.main(verbosity=2)
