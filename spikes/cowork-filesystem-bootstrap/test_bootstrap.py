"""No-effect protocol regressions on every OS; actual ext4 only explicit Linux opt-in."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location("fixture_bootstrap", Path(__file__).with_name("bootstrap.py"))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)

class Pair:
    def __enter__(self):
        self.root = tempfile.TemporaryDirectory(prefix="winter-filesystem-bootstrap-")
        self.fds = []
        self.plan = {"protocolVersion": 1, "operationId": "filesystem_" + str(uuid.uuid4()), "homeId": "fixture-home", "workspaceId": "fixture-workspace", "owner": {"controllerInstanceId": "fixture-controller", "workerInstanceId": "fixture-worker", "incarnationId": "fixture-incarnation", "leaseEpoch": 1, "runtimeImageDigest": "b" * 64}, "volumes": []}
        for purpose in ("data", "environment"):
            fd = os.open(Path(self.root.name) / (purpose + ".ext4"), os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_CLOEXEC, 0o600)
            self.fds.append(fd); os.ftruncate(fd, bootstrap.MIN_BYTES); os.fsync(fd); st = os.fstat(fd)
            self.plan["volumes"].append({"volumeId": "volume_" + str(uuid.uuid4()), "creationId": "creation_" + str(uuid.uuid4()), "purpose": purpose, "identity": {"device": str(st.st_dev), "inode": str(st.st_ino), "uid": st.st_uid, "mode": stat.S_IMODE(st.st_mode)}, "capacityBytes": st.st_size, "sectorBytes": 512, "filesystemBlockBytes": 4096, "expectedFilesystemUUID": str(uuid.uuid4()), "action": "format-new"})
        return self
    def __exit__(self, *_):
        for fd in self.fds: os.close(fd)
        self.root.cleanup()
    def digests(self):
        return [hashlib.sha256(os.pread(fd, bootstrap.MIN_BYTES, 0)).hexdigest() for fd in self.fds]

class ProtocolTests(unittest.TestCase):
    def test_closed_plan_and_independent_volume_uuid(self):
        with Pair() as pair:
            self.assertEqual(bootstrap.validate_plan(pair.plan), pair.plan)
            for mutation in ("version", "extra", "owner", "order", "uuid", "capacity", "shared", "extension"):
                bad = copy.deepcopy(pair.plan)
                if mutation == "version": bad["protocolVersion"] = True
                elif mutation == "extra": bad["payload"] = "forbidden"
                elif mutation == "owner": bad["owner"]["leaseEpoch"] = 0
                elif mutation == "order": bad["volumes"].reverse()
                elif mutation == "uuid": bad["volumes"][0]["expectedFilesystemUUID"] = "not-a-uuid"
                elif mutation == "capacity": bad["volumes"][0]["capacityBytes"] += 1
                elif mutation == "shared": bad["volumes"][1]["volumeId"] = bad["volumes"][0]["volumeId"]
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
            self.assertTrue(all(v["flushConfirmed"] and v["checked"] for v in observed["volumes"]))
            before = pair.digests()
            with self.assertRaisesRegex(bootstrap.Refused, "one_shot_consumed"): receiver.execute(pair.plan, pair.fds, proof)
            probe = copy.deepcopy(pair.plan); probe["operationId"] = "filesystem_" + str(uuid.uuid4())
            for target in probe["volumes"]: target["action"] = "probe-existing"
            cold, cold_proof = self.receiver(probe); second = cold.execute(probe, pair.fds, cold_proof)
            self.assertEqual([v["filesystemUUID"] for v in second["volumes"]], [v["filesystemUUID"] for v in observed["volumes"]]); self.assertEqual(pair.digests(), before)
            # Even a fresh receiver/new nonce cannot reformat an already formatted image.
            retry = copy.deepcopy(pair.plan); retry["operationId"] = "filesystem_" + str(uuid.uuid4())
            fresh, new_proof = self.receiver(retry)
            with self.assertRaisesRegex(bootstrap.Refused, "not_virgin"): fresh.execute(retry, pair.fds, new_proof)
            self.assertEqual(pair.digests(), before)
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
            for target in wrong["volumes"]: target["action"] = "probe-existing"
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
