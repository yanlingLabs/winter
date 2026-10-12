"""Closed bootstrap protocol preparation. Production device admission remains disabled.

The fixture adapter only accepts O_EXCL-created Linux regular files. It cannot open
arbitrary paths or block devices. Native FD/envelope authentication and immutable
image integration must replace this fixture adapter before production activation.
"""
import fcntl
import json
import os
import re
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

EXT4_FEATURES = sorted("64bit dir_index dir_nlink extent extra_isize filetype flex_bg has_journal huge_file large_file metadata_csum sparse_super".split())
TRANSIENT_FEATURES = ["needs_recovery"]
REQUIRED_MOUNT_OPTIONS = ["noinit_itable"]
MAX_PLAN_BYTES = 16_384
MIN_BYTES = 16 * 1024 * 1024
MAX_BYTES = 256 * 1024**3
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z")

class Refused(Exception):
    pass

def require(ok, reason):
    if not ok:
        raise Refused(reason)

def keys(obj, expected):
    require(type(obj) is dict and set(obj) == set(expected.split()), "closed_shape")

def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum

def validate_plan(plan):
    keys(plan, "protocolVersion operationId homeId workspaceId owner volumes virginZeroProvenance ext4Features requiredMountOptions checkMode priorReplay")
    require(type(plan["protocolVersion"]) is int and plan["protocolVersion"] == 3, "version")
    for field in ("operationId", "homeId", "workspaceId"):
        require(type(plan[field]) is str and TOKEN.fullmatch(plan[field]), "scope")
    require(plan["virginZeroProvenance"] == "new-sparse-creation", "zero_provenance")
    require(plan["ext4Features"] == EXT4_FEATURES and plan["requiredMountOptions"] == REQUIRED_MOUNT_OPTIONS, "filesystem_contract")
    require(plan["checkMode"] in ("normal", "full-read-only"), "check_mode")
    owner = plan["owner"]
    keys(owner, "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest")
    for field in ("controllerInstanceId", "workerInstanceId", "incarnationId"):
        require(type(owner[field]) is str and TOKEN.fullmatch(owner[field]), "owner")
    require(integer(owner["leaseEpoch"], 1, 2**53 - 1), "lease")
    require(type(owner["runtimeImageDigest"]) is str and re.fullmatch(r"[a-f0-9]{64}", owner["runtimeImageDigest"]), "image")
    prior = plan["priorReplay"]
    if prior is not None:
        keys(prior, "operationId owner")
        require(type(prior["operationId"]) is str and TOKEN.fullmatch(prior["operationId"]) and prior["operationId"] != plan["operationId"], "prior_replay")
        keys(prior["owner"], "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest")
        require(all(type(prior["owner"][k]) is str and TOKEN.fullmatch(prior["owner"][k]) for k in ("controllerInstanceId", "workerInstanceId", "incarnationId")) and integer(prior["owner"]["leaseEpoch"], 1, 2**53 - 1) and type(prior["owner"]["runtimeImageDigest"]) is str and re.fullmatch(r"[a-f0-9]{64}", prior["owner"]["runtimeImageDigest"]), "prior_replay_owner")
        require(prior["owner"] != owner, "new_replay_owner_required")
    require(type(plan["volumes"]) is list and len(plan["volumes"]) == 2, "pair")
    for index, target in enumerate(plan["volumes"]):
        keys(target, "volumeId creationId purpose identity capacityBytes sectorBytes filesystemBlockBytes expectedFilesystemUUID action readyOperationId")
        for field in ("volumeId", "creationId"):
            require(type(target[field]) is str and TOKEN.fullmatch(target[field]), "volume_identity")
        require(target["purpose"] == ("data", "environment")[index], "fixed_disk_order")
        require(target["action"] in ("format-new", "probe-existing", "replay-journal-then-probe"), "action")
        require(target["readyOperationId"] is None if target["action"] == "format-new" else type(target["readyOperationId"]) is str and TOKEN.fullmatch(target["readyOperationId"]), "previous_ready")
        require(target["action"] != "replay-journal-then-probe" or plan["checkMode"] == "normal", "readonly_replay_denied")
        require(integer(target["capacityBytes"], MIN_BYTES, MAX_BYTES) and target["capacityBytes"] % 4096 == 0, "capacity")
        require(type(target["sectorBytes"]) is int and target["sectorBytes"] == 512 and type(target["filesystemBlockBytes"]) is int and target["filesystemBlockBytes"] == 4096, "geometry")
        require(type(target["expectedFilesystemUUID"]) is str and UUID.fullmatch(target["expectedFilesystemUUID"]), "uuid")
        identity = target["identity"]
        keys(identity, "device inode uid mode")
        require(all(type(identity[k]) is str and re.fullmatch(r"[0-9]{1,30}", identity[k]) for k in ("device", "inode")), "file_identity")
        require(integer(identity["uid"], 0, 2**32 - 1) and identity["mode"] == 0o600, "file_mode")
    for field in ("volumeId", "creationId", "expectedFilesystemUUID"):
        require(plan["volumes"][0][field] != plan["volumes"][1][field], "distinct_volumes")
    require(plan["volumes"][0]["identity"] != plan["volumes"][1]["identity"], "distinct_files")
    # Only after the closed, bounded scalar fields are validated do we serialize a copy.
    encoded = json.dumps(plan, separators=(",", ":"))
    require(len(encoded.encode()) <= MAX_PLAN_BYTES, "plan_bound")
    return json.loads(encoded)

def check_fixture_fd(fd, target):
    require(type(fd) is int and fd >= 3, "descriptor")
    st = os.fstat(fd)
    observed = {"device": str(st.st_dev), "inode": str(st.st_ino), "uid": st.st_uid, "mode": stat.S_IMODE(st.st_mode)}
    require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid() and observed == target["identity"] and st.st_size == target["capacityBytes"], "fixture_identity")
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    require(flags & os.O_ACCMODE == os.O_RDWR and not flags & os.O_APPEND, "descriptor_mode")

def all_zero(fd, capacity, deadline):
    offset = 0
    while offset < capacity:
        require(time.monotonic() < deadline, "virgin_scan_deadline")
        chunk = os.pread(fd, min(1024 * 1024, capacity - offset), offset)
        require(bool(chunk) and not any(chunk), "not_virgin")
        offset += len(chunk)

def tool_path(name):
    for directory in ("/usr/sbin", "/sbin"):
        path = directory + "/" + name
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise Refused("required_linux_tool_missing")

def run_tool(name, args, fd, deadline, accepted=(0,)):
    require(sys.platform == "linux", "linux_only")
    remaining = min(20, deadline - time.monotonic())
    require(remaining > 0, "operation_deadline")
    # Fixed trusted programs/argv, clean environment, no shell, only the pinned FD inherited.
    # Temporary output files prevent pipe backpressure; retained output is capped at 4096 bytes.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            result = subprocess.run([tool_path(name), *args, f"/proc/self/fd/{fd}"], pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=out, stderr=err, timeout=remaining, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "MKE2FS_CONFIG": "/dev/null", "E2FSCK_CONFIG": "/dev/null", "HOME": "/nonexistent"}, check=False)
        except subprocess.TimeoutExpired:
            # subprocess.run kills/reaps its own helper before this exception escapes.
            raise Refused("owned_helper_timeout") from None
        out.seek(0); err.seek(0)
        output, error = out.read(4097), err.read(4097)
        require(len(output) <= 4096 and len(error) <= 4096, "helper_output_bound")
        require(result.returncode in accepted, "linux_tool_refused")
        return result.returncode, output.decode("ascii", errors="strict")

def probe(fd, target, deadline, plan):
    # Every probe helper gets a separately read-only descriptor. Normal launch is a
    # bounded header/feature check; full e2fsck requires explicit trusted checkMode.
    read_fd = os.open(f"/proc/self/fd/{fd}", os.O_RDONLY | os.O_CLOEXEC)
    try:
        _, text = run_tool("blkid", ["-p", "-o", "export"], read_fd, deadline)
        fields = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
        require(fields.get("TYPE") == "ext4" and fields.get("UUID") == target["expectedFilesystemUUID"] and fields.get("BLOCK_SIZE") == "4096", "filesystem_mismatch")
        sb = os.pread(read_fd, 1024, 1024)
        require(len(sb) == 1024 and struct.unpack_from("<H", sb, 0x38)[0] == 0xEF53, "superblock")
        blocks = struct.unpack_from("<I", sb, 4)[0] | (struct.unpack_from("<I", sb, 0x150)[0] << 32)
        require(struct.unpack_from("<I", sb, 0x18)[0] == 2 and blocks * 4096 == target["capacityBytes"] and str(uuid.UUID(bytes=sb[0x68:0x78])) == target["expectedFilesystemUUID"], "filesystem_geometry")
        _, header = run_tool("dumpe2fs", ["-h"], read_fd, deadline)
        properties = dict(line.split(":", 1) for line in header.splitlines() if ":" in line)
        properties = {key.strip(): value.strip() for key, value in properties.items()}
        live_features = sorted(properties.get("Filesystem features", "").split())
        require(len(live_features) == len(set(live_features)), "filesystem_features")
        transient = [feature for feature in live_features if feature in TRANSIENT_FEATURES]
        features = [feature for feature in live_features if feature not in TRANSIENT_FEATURES]
        require(features == plan["ext4Features"], "filesystem_features")
        require(properties.get("Filesystem UUID") == target["expectedFilesystemUUID"] and properties.get("Block size") == "4096" and properties.get("Block count") == str(target["capacityBytes"] // 4096), "header_geometry")
        if plan["checkMode"] == "full-read-only":
            run_tool("e2fsck", ["-f", "-n"], read_fd, deadline)
        else:
            require(properties.get("Filesystem state") == "clean", "explicit_full_check_required")
        # This is a header observation, not permission to mount or mark ready. Core refuses
        # readiness while recovery is pending; only approved journal replay + a fresh clean
        # observation can clear that debt. A full read-only check cannot silently clear it.
        return features, transient
    finally:
        os.close(read_fd)

class FixtureBootstrap:
    """Preparation oracle only. No production constructor/CLI/device path exists.

    Production must authenticate the exact native envelope and immutable bootstrap
    digest before admitting any descriptor. This fixture cannot supply that evidence.
    """
    def __init__(self, authenticate):
        require(callable(authenticate), "mandatory_authenticator")
        self.authenticate = authenticate
        self.consumed = set()

    def execute(self, incoming, descriptors, proof):
        require(sys.platform == "linux", "linux_only")
        plan = validate_plan(incoming)
        require(self.authenticate(plan, proof) is True, "native_envelope_denied")
        require(type(descriptors) in (tuple, list) and len(descriptors) == 2 and descriptors[0] != descriptors[1], "fd_pair")
        require(plan["operationId"] not in self.consumed, "one_shot_consumed")
        for fd, target in zip(descriptors, plan["volumes"]):
            check_fixture_fd(fd, target)
        # Even a timeout/crash after this boundary may never retry a destructive operation.
        self.consumed.add(plan["operationId"])
        deadline = time.monotonic() + 60
        # Preflight BOTH before any formatting effect. Nonzero foreign bytes never get repaired.
        preflight = []
        for fd, target in zip(descriptors, plan["volumes"]):
            if target["action"] == "format-new":
                all_zero(fd, target["capacityBytes"], min(deadline, time.monotonic() + 5)); preflight.append(([], []))
            else:
                preflight.append(probe(fd, target, deadline, plan))
        observed = []
        for index, (fd, target) in enumerate(zip(descriptors, plan["volumes"])):
            check_fixture_fd(fd, target)
            journal_replayed = False
            if target["action"] == "format-new":
                run_tool("mke2fs", ["-q", "-t", "ext4", "-b", "4096", "-I", "256", "-U", target["expectedFilesystemUUID"], "-O", "none," + ",".join(EXT4_FEATURES), "-E", "lazy_itable_init=1,lazy_journal_init=0,nodiscard", "-F"], fd, deadline)
            elif target["action"] == "replay-journal-then-probe" and preflight[index][1]:
                # Only journal replay, never preen/full repair, and only after BOTH readonly
                # preflights passed exact identity/UUID/geometry/features/clean-state checks.
                run_tool("e2fsck", ["-E", "journal_only"], fd, deadline, accepted=(0, 1))
                journal_replayed = True
            os.fsync(fd)
            check_fixture_fd(fd, target)
            features, transient = probe(fd, target, deadline, plan)
            if journal_replayed:
                require(not transient, "journal_recovery_incomplete")
            observed.append({**target, "journalReplayed": journal_replayed, "filesystemFeatures": features, "transientFilesystemFeatures": transient, "fullReadOnlyCheck": plan["checkMode"] == "full-read-only", "filesystemType": "ext4", "filesystemUUID": target["expectedFilesystemUUID"], "flushConfirmed": True, "checked": True})
        return {**plan, "volumes": observed}
