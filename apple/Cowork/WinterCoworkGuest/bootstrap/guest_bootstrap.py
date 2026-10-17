"""Guest filesystem bootstrap for the production Mac Cowork VM (N2 slice S5). Python stdlib only.

Started by PID 1 as `python3 -I -S -B guest_bootstrap.py ...`. It speaks the bootstrap class of the WMX1 contract through PID 1
and the relay (pipes, see common/ctl.h): hello, receive the plan, bootstrap the two virtio block devices, return the
nonce-bound receipt, wait for the host's `ready`, ask PID 1 to mount, answer `mounted`. It never mounts, never imports ctypes
and never opens a path it was not handed: PID 1 discovers the disks by virtio serial and passes node, major:minor and serial.

It is the production successor of spikes/cowork-filesystem-bootstrap/bootstrap.py, which only ever handled regular files.
The behaviour differences are listed in docs/research/2026-10-17-cowork-n2-guest-boot.md; the short version:
  * block devices (S_ISBLK, serial, sysfs size/ro/partitions, not mounted) replace the fixture's regular-file identity checks;
  * `blkid -p` is gone (decision D9): a direct ext4 superblock read (magic, UUID, geometry, exact feature bits, state and
    metadata checksum) plus `dumpe2fs -h` that must AGREE with it;
  * mke2fs gets no `-F` on a block device (the single -F stays for the regular files of the unit tests only);
  * the journal replay of protocol 3 is a kernel mount done by PID 1 on request, not a loop device;
  * authentication is the channel (one virtio port, host peer) plus a nonce-bound, single-shot operation; there is no
    `authenticate` callable and no proof object, because the guest cannot hold a host-side proof.
"""
import errno
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

PROTOCOL_VERSION = 3
EXT4_FEATURES = sorted("64bit dir_index dir_nlink extent extra_isize filetype flex_bg has_journal huge_file large_file metadata_csum sparse_super".split())
TRANSIENT_FEATURES = ["needs_recovery"]
REQUIRED_MOUNT_OPTIONS = ["noinit_itable"]
MAX_PLAN_BYTES = 16_384
MIN_BYTES = 16 * 1024 * 1024
MAX_BYTES = 256 * 1024**3
DATA_SERIAL = "winter-data"
ENVIRONMENT_SERIAL = "winter-environment"
MAX_BOOTSTRAP_PAYLOAD = 262_144
MAX_NESTING = 8
SERVICE_BUDGET_SECONDS = 60
TOOL_BUDGET_SECONDS = 20
# mke2fs zeroes the journal (up to 1 GiB) and a full read-only check walks the metadata, so those two get a budget that grows with
# the volume instead of the flat 20 seconds the regular-file fixture used. Measured at gate G1, not before.
TOOL_FLOOR_BYTES_PER_SECOND = 256 * 1024 * 1024
# Virgin scans read every byte of a new volume. The fixture allowed 5 seconds, which cannot hold at production capacities;
# the allowance grows with the capacity at a deliberately pessimistic floor rate. Measured at gate G1, not before.
VIRGIN_SCAN_BASE_SECONDS = 5
VIRGIN_SCAN_FLOOR_BYTES_PER_SECOND = 128 * 1024 * 1024
SCAN_CHUNK = 1024 * 1024
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z")
NONCE = re.compile(r"[a-f0-9]{32}\Z")
MESSAGE_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}\Z")
FAULT_CODES = ("bad_plan", "probe_failed", "format_failed", "replay_failed", "mount_failed", "internal")
DANGEROUS_KEYS = ("__proto__", "constructor", "prototype")

# ext4 superblock feature bits that the pinned contract allows (compat, incompat, ro_compat) and the one transient bit.
REQUIRED_FEATURE_BITS = {
    "has_journal": ("compat", 0x4), "dir_index": ("compat", 0x20),
    "filetype": ("incompat", 0x2), "extent": ("incompat", 0x40), "64bit": ("incompat", 0x80), "flex_bg": ("incompat", 0x200),
    "sparse_super": ("ro_compat", 0x1), "large_file": ("ro_compat", 0x2), "huge_file": ("ro_compat", 0x8),
    "dir_nlink": ("ro_compat", 0x20), "extra_isize": ("ro_compat", 0x40), "metadata_csum": ("ro_compat", 0x400),
}
INCOMPAT_NEEDS_RECOVERY = 0x4


class Refused(Exception):
    """A closed refusal. `phase` picks the fault code the host sees (see fault_code)."""

    def __init__(self, reason, phase=None):
        super().__init__(reason)
        self.reason = reason
        self.phase = phase


def require(ok, reason, phase=None):
    if not ok:
        raise Refused(reason, phase)


# ---------------------------------------------------------------------------------------------------- canonical JSON

def sort_key(text):
    return text.encode("utf-16-be")


def sorted_canonical(value):
    """Nested free-form objects are spelled with recursively sorted keys (UTF-16 code unit order), as protocol.ts does."""
    if isinstance(value, list):
        return [sorted_canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: sorted_canonical(value[key]) for key in sorted(value, key=sort_key)}
    return value


def canonical_text(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def nests_within(body, maximum):
    depth = 0
    in_string = False
    skip = False
    for ch in body:
        if skip:
            skip = False
            continue
        if in_string:
            if ch == "\\":
                skip = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            depth += 1
            if depth > maximum:
                return False
        elif ch in "}]":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not in_string


def _reject_pairs(pairs):
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError("duplicate key")
        seen[key] = value
    return seen


def _reject_number(text):
    raise ValueError("non-integer number")


def _clean_data(value):
    if isinstance(value, dict):
        if any(key in DANGEROUS_KEYS for key in value):
            raise ValueError("dangerous key")
        for child in value.values():
            _clean_data(child)
    elif isinstance(value, list):
        for child in value:
            _clean_data(child)


class ProtocolError(Exception):
    """Same vocabulary as protocol.ts: malformed, oversize, unknown_type, bad_field."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def strict_object(payload):
    """Bytes of one bootstrap-class payload -> (parsed object, text). The caller still owns key order and values."""
    if not isinstance(payload, (bytes, bytearray)):
        raise ProtocolError("malformed")
    if len(payload) > MAX_BOOTSTRAP_PAYLOAD:
        raise ProtocolError("oversize")
    try:
        text = bytes(payload).decode("utf-8")
    except UnicodeDecodeError:
        raise ProtocolError("malformed") from None
    if not text.isascii():
        raise ProtocolError("malformed")  # every legal string is a token, a digest or a UUID: ASCII only
    if not nests_within(text, MAX_NESTING):
        raise ProtocolError("malformed")
    try:
        parsed = json.loads(text, object_pairs_hook=_reject_pairs, parse_float=_reject_number, parse_constant=_reject_number)
        _clean_data(parsed)
    except (ValueError, RecursionError):
        raise ProtocolError("malformed") from None
    if not isinstance(parsed, dict) or canonical_text(parsed) != text:
        raise ProtocolError("malformed")
    return parsed, text


def _token(value):
    return isinstance(value, str) and bool(MESSAGE_TOKEN.fullmatch(value))


def _nonce(value):
    return isinstance(value, str) and bool(NONCE.fullmatch(value))


def _boot_id(value):
    return isinstance(value, str) and bool(UUID.fullmatch(value))


def _plan_object(value):
    return isinstance(value, dict) and valid_filesystem_plan(value) and value.get("protocolVersion") == PROTOCOL_VERSION


def _plain_object(value):
    return isinstance(value, dict)


# message type -> ordered (key, validator). Insertion order IS the wire order, exactly as in protocol.ts BOOTSTRAP_SPECS.
BOOTSTRAP_SPECS = {
    "down": {
        "plan": (("operationId", _token), ("nonce", _nonce), ("plan", _plan_object)),
        "ready": (("operationId", _token), ("nonce", _nonce)),
    },
    "up": {
        "hello": (("guestBootId", _boot_id), ("dataSerial", lambda v: v == DATA_SERIAL), ("environmentSerial", lambda v: v == ENVIRONMENT_SERIAL)),
        "receipt": (("operationId", _token), ("nonce", _nonce), ("receipt", _plain_object)),
        "fault": (("operationId", _token), ("nonce", _nonce), ("code", lambda v: v in FAULT_CODES)),
        "mounted": (("operationId", _token), ("nonce", _nonce)),
    },
}


def parse_bootstrap_message(payload, direction):
    """One bootstrap-class payload (bytes, no newline) -> a dict {t, fields...} or ProtocolError.

    The guest receives direction "down" only; the "up" table lets the tests hold the guest's own output to the same schema.
    """
    parsed, text = strict_object(payload)
    kind = parsed.get("t") if "t" in parsed else None
    specs = BOOTSTRAP_SPECS[direction]
    if not isinstance(kind, str) or kind not in specs:
        raise ProtocolError("unknown_type")
    spec = specs[kind]
    if set(parsed) != {"v", "t"} | {key for key, _ in spec}:
        raise ProtocolError("bad_field")
    if type(parsed["v"]) is not int or parsed["v"] != 1:
        raise ProtocolError("bad_field")
    typed = {"v": 1, "t": kind}
    for key, check in spec:
        if not check(parsed[key]):
            raise ProtocolError("bad_field")
        typed[key] = sorted_canonical(parsed[key]) if isinstance(parsed[key], dict) else parsed[key]
    if canonical_text(typed) != text:
        raise ProtocolError("malformed")  # key order, or an unsorted nested object
    return typed


def encode_bootstrap_message(message):
    """The canonical payload (bytes) of an up message; the schema check is the one a received message would pass."""
    kind = message["t"]
    if kind not in BOOTSTRAP_SPECS["up"]:
        raise ValueError("not an up message")
    typed = {"v": 1, "t": kind}
    for key, check in BOOTSTRAP_SPECS["up"][kind]:
        value = message[key]
        if not check(value):
            raise ValueError("bad field " + key)
        typed[key] = sorted_canonical(value) if isinstance(value, dict) else value
    if set(message) - set(typed):
        raise ValueError("extra key")
    payload = canonical_text(typed).encode("ascii")
    if len(payload) > MAX_BOOTSTRAP_PAYLOAD:
        raise ValueError("oversize")
    return payload


# ---------------------------------------------------------------------------------------------------- plan validation

def _closed(value, keys):
    return type(value) is dict and set(value) == set(keys.split())


def _id(value):
    return type(value) is str and bool(TOKEN.fullmatch(value))


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def _owner_ok(owner):
    return (_closed(owner, "controllerInstanceId workerInstanceId incarnationId leaseEpoch runtimeImageDigest")
            and all(_id(owner[k]) for k in ("controllerInstanceId", "workerInstanceId", "incarnationId"))
            and _integer(owner["leaseEpoch"], 1, 2**53 - 1)
            and type(owner["runtimeImageDigest"]) is str and bool(re.fullmatch(r"[a-f0-9]{64}", owner["runtimeImageDigest"])))


def valid_filesystem_plan(plan):
    """Port of volume-filesystem.ts validFilesystemPlan for protocol 3 (the only version a guest accepts), plus the bounds
    the fixture bootstrap added (plan size). Returns a bool and never raises on shape."""
    try:
        return _valid_plan(plan)
    except (TypeError, KeyError, ValueError):
        return False


def _valid_plan(plan):
    if not _closed(plan, "protocolVersion operationId homeId workspaceId owner volumes virginZeroProvenance ext4Features requiredMountOptions checkMode priorReplay"):
        return False
    if type(plan["protocolVersion"]) is not int or plan["protocolVersion"] != PROTOCOL_VERSION:
        return False
    if not all(_id(plan[f]) for f in ("operationId", "homeId", "workspaceId")) or not _owner_ok(plan["owner"]):
        return False
    if plan["virginZeroProvenance"] != "new-sparse-creation" or plan["ext4Features"] != EXT4_FEATURES or plan["requiredMountOptions"] != REQUIRED_MOUNT_OPTIONS:
        return False
    if plan["checkMode"] not in ("normal", "full-read-only"):
        return False
    prior = plan["priorReplay"]
    if prior is not None:
        if not (_closed(prior, "operationId owner") and _id(prior["operationId"]) and _owner_ok(prior["owner"])):
            return False
        if prior["operationId"] == plan["operationId"] or prior["owner"] == plan["owner"]:
            return False
    volumes = plan["volumes"]
    if type(volumes) is not list or len(volumes) != 2:
        return False
    for index, target in enumerate(volumes):
        if not _closed(target, "volumeId creationId purpose identity capacityBytes sectorBytes filesystemBlockBytes expectedFilesystemUUID action readyOperationId"):
            return False
        if not (_id(target["volumeId"]) and _id(target["creationId"])) or target["purpose"] != ("data", "environment")[index]:
            return False
        if target["action"] not in ("format-new", "probe-existing", "replay-journal-then-probe"):
            return False
        ready = target["readyOperationId"]
        if target["action"] == "format-new":
            if ready is not None:
                return False
        elif not _id(ready):
            return False
        if target["action"] == "replay-journal-then-probe" and plan["checkMode"] != "normal":
            return False
        if not _integer(target["capacityBytes"], MIN_BYTES, MAX_BYTES) or target["capacityBytes"] % 4096:
            return False
        if type(target["sectorBytes"]) is not int or target["sectorBytes"] != 512 or type(target["filesystemBlockBytes"]) is not int or target["filesystemBlockBytes"] != 4096:
            return False
        if type(target["expectedFilesystemUUID"]) is not str or not UUID.fullmatch(target["expectedFilesystemUUID"]):
            return False
        identity = target["identity"]
        if not _closed(identity, "device inode uid mode"):
            return False
        if not all(type(identity[k]) is str and re.fullmatch(r"[0-9]{1,30}", identity[k]) for k in ("device", "inode")):
            return False
        if not _integer(identity["uid"], 0, 2**32 - 1) or type(identity["mode"]) is not int or identity["mode"] != 0o600:
            return False
    if prior is not None and any(v["action"] == "format-new" for v in volumes):
        return False
    a, b = volumes
    if a["volumeId"] == b["volumeId"] or a["creationId"] == b["creationId"] or a["expectedFilesystemUUID"] == b["expectedFilesystemUUID"]:
        return False
    if a["identity"] == b["identity"] or (a["identity"]["device"] == b["identity"]["device"] and a["identity"]["inode"] == b["identity"]["inode"]):
        return False
    return len(canonical_text(plan).encode()) <= MAX_PLAN_BYTES


def matches_filesystem_receipt(plan, receipt):
    """Port of volume-filesystem.ts matchesFilesystemReceipt for protocol 3. The guest runs it on its OWN receipt before it
    sends one: a receipt the host would refuse as a mismatch is an internal fault here, not a message on the wire."""
    if not valid_filesystem_plan(plan) or type(receipt) is not dict or set(receipt) != set(plan):
        return False
    for key in ("protocolVersion", "operationId", "homeId", "workspaceId", "owner", "virginZeroProvenance", "ext4Features",
                "requiredMountOptions", "checkMode", "priorReplay"):
        if receipt.get(key) != plan[key]:
            return False
    volumes = receipt.get("volumes")
    if type(volumes) is not list or len(volumes) != 2:
        return False
    extra = {"filesystemType", "filesystemUUID", "flushConfirmed", "checked", "filesystemFeatures", "fullReadOnlyCheck",
             "transientFilesystemFeatures", "journalReplayed", "journalReplay"}
    for expected, actual in zip(plan["volumes"], volumes):
        if type(actual) is not dict or set(actual) != set(expected) | extra:
            return False
        if any(actual[key] != expected[key] for key in expected):
            return False
        if actual["filesystemType"] != "ext4" or actual["filesystemUUID"] != expected["expectedFilesystemUUID"]:
            return False
        if actual["flushConfirmed"] is not True or actual["checked"] is not True:
            return False
        if actual["filesystemFeatures"] != plan["ext4Features"] or actual["fullReadOnlyCheck"] is not (plan["checkMode"] == "full-read-only"):
            return False
        if actual["transientFilesystemFeatures"] not in ([], TRANSIENT_FEATURES):
            return False
        replayed = actual["journalReplayed"]
        if type(replayed) is not bool or actual["journalReplay"] != ("kernel-mount" if replayed else "none"):
            return False
        if replayed and expected["action"] != "replay-journal-then-probe":
            return False
    return True


# ---------------------------------------------------------------------------------------------------- ext4 superblock

def _crc32c_table():
    table = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (c >> 1) ^ 0x82F63B78 if c & 1 else c >> 1
        table.append(c)
    return table


_CRC32C = _crc32c_table()


def crc32c_raw(data, seed=0xFFFFFFFF):
    """CRC-32C (Castagnoli) with the caller's seed and NO final inversion: the convention of the ext4 superblock checksum
    (`ext4_chksum(~0, sb, offsetof(s_checksum))`)."""
    crc = seed
    for byte in data:
        crc = _CRC32C[(crc ^ byte) & 0xFF] ^ (crc >> 8)
    return crc


def format_uuid(raw):
    h = raw.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def parse_superblock(raw):
    """1024 bytes at disk offset 1024 -> the facts the probe needs. Raises Refused('superblock...') for anything that is not
    a self-consistent ext4 superblock with a valid metadata checksum."""
    require(len(raw) == 1024, "superblock", "probe")
    require(struct.unpack_from("<H", raw, 0x38)[0] == 0xEF53, "superblock", "probe")
    log_block_size = struct.unpack_from("<I", raw, 0x18)[0]
    require(log_block_size == 2, "filesystem_geometry", "probe")
    compat, incompat, ro_compat = struct.unpack_from("<III", raw, 0x5C)
    require(struct.unpack_from("<I", raw, 0x4C)[0] == 1, "filesystem_geometry", "probe")  # dynamic revision
    require(struct.unpack_from("<H", raw, 0x58)[0] == 256, "filesystem_geometry", "probe")  # 256 byte inodes, as formatted
    blocks = struct.unpack_from("<I", raw, 4)[0] | (struct.unpack_from("<I", raw, 0x150)[0] << 32)
    fields = {"compat": compat, "incompat": incompat, "ro_compat": ro_compat}
    features, known = [], {"compat": 0, "incompat": INCOMPAT_NEEDS_RECOVERY, "ro_compat": 0}
    for name, (group, bit) in REQUIRED_FEATURE_BITS.items():
        known[group] |= bit
        if fields[group] & bit:
            features.append(name)
    # Every set bit must be a required feature or the one transient bit; anything else is a feature this contract never created.
    require(all(fields[g] & ~known[g] == 0 for g in fields), "filesystem_features", "probe")
    # metadata_csum: the superblock carries its own CRC32C (type 1) over the preceding 1020 bytes.
    require(raw[0x175] == 1 and struct.unpack_from("<I", raw, 0x3FC)[0] == crc32c_raw(raw[:0x3FC]), "superblock_checksum", "probe")
    state = struct.unpack_from("<H", raw, 0x3A)[0]
    return {
        "uuid": format_uuid(raw[0x68:0x78]),
        "blockBytes": 1024 << log_block_size,
        "blocks": blocks,
        "features": sorted(features),
        "transient": ["needs_recovery"] if incompat & INCOMPAT_NEEDS_RECOVERY else [],
        "clean": (state & 0x3) == 1,  # VALID_FS set and ERROR_FS clear: dumpe2fs prints exactly "clean"
    }


def parse_dumpe2fs_header(text):
    properties = {}
    for line in text.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            properties[key.strip()] = value.strip()
    return properties


# ---------------------------------------------------------------------------------------------------- tools

def tool_path(name, phase=None):
    for directory in ("/usr/sbin", "/sbin"):
        path = directory + "/" + name
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise Refused("required_linux_tool_missing", phase)


def tool_seconds(capacity):
    return TOOL_BUDGET_SECONDS + -(-capacity // TOOL_FLOOR_BYTES_PER_SECOND)


TOOL_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "MKE2FS_CONFIG": "/dev/null",
            "E2FSCK_CONFIG": "/dev/null", "HOME": "/nonexistent"}


class Tools:
    """Fixed trusted programs, fixed argv, clean environment, no shell, only the one pinned descriptor inherited."""

    def run(self, name, args, fd, deadline, accepted=(0,), phase=None, timeout=TOOL_BUDGET_SECONDS):
        require(sys.platform == "linux", "linux_only", phase)
        remaining = min(timeout, deadline - time.monotonic())
        require(remaining > 0, "operation_deadline", phase)
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            try:
                result = subprocess.run([tool_path(name, phase), *args, f"/proc/self/fd/{fd}"], pass_fds=(fd,), stdin=subprocess.DEVNULL,
                                        stdout=out, stderr=err, timeout=remaining, env=TOOL_ENV, check=False)
            except subprocess.TimeoutExpired:
                raise Refused("owned_helper_timeout", phase) from None
            out.seek(0)
            err.seek(0)
            output, error = out.read(4097), err.read(4097)
        require(len(output) <= 4096 and len(error) <= 4096, "helper_output_bound", phase)
        require(result.returncode in accepted, "linux_tool_refused", phase)
        return result.returncode, output.decode("ascii", errors="strict")


MKE2FS_FIXED = ["-q", "-t", "ext4", "-b", "4096", "-I", "256", "-O"]


def mke2fs_args(uuid_text, regular_file):
    """Fixed argv. `-F` exists ONLY for the regular-file images of the unit tests; a block device never gets it, so
    mke2fs keeps its own plausibility questions (stdin is /dev/null, so a question is a refusal)."""
    args = [*MKE2FS_FIXED, "none," + ",".join(EXT4_FEATURES), "-U", uuid_text, "-E", "lazy_itable_init=1,lazy_journal_init=0,nodiscard"]
    if regular_file:
        args.append("-F")
    return args


# ---------------------------------------------------------------------------------------------------- disks

class Disk:
    """One admitted volume: the open descriptor and what was checked about it."""

    def __init__(self, fd, purpose, regular_file=False):
        self.fd = fd
        self.purpose = purpose
        self.regular_file = regular_file

    def close(self):
        """Idempotent: a second close must never close a descriptor number that has since been reused."""
        fd, self.fd = self.fd, -1
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def parse_mountinfo_devices(text):
    """major:minor of every mount in /proc/self/mountinfo (field 3)."""
    devices = set()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) > 2:
            devices.add(fields[2])
    return devices


def check_block_identity(st_mode, st_rdev, major, minor):
    """The opened node is a block device and is exactly the one PID 1 named."""
    require(stat.S_ISBLK(st_mode), "not_block_device", "probe")
    require(os.major(st_rdev) == major and os.minor(st_rdev) == minor, "device_identity", "probe")


def check_open_flags(flags):
    """Read-write, not append: the descriptor the formatter and the probes are about to use."""
    require(flags & os.O_ACCMODE == os.O_RDWR and not flags & os.O_APPEND, "descriptor_mode", "probe")


class BlockDeviceAdmission:
    """Production admission of one virtio block device. PID 1 chose the node by virtio serial; this re-checks everything it can
    from the descriptor it actually holds: a block device, the exact major:minor, the sysfs serial, read-write, geometry,
    no partitions or holders, and not mounted."""

    def __init__(self, sys_root="/sys", mountinfo="/proc/self/mountinfo", dev_root="/dev"):
        self.sys_root = sys_root
        self.mountinfo = mountinfo
        self.dev_root = dev_root

    @staticmethod
    def _read(path, limit=256):
        with open(path, "r", encoding="ascii", errors="replace") as handle:
            return handle.read(limit).strip()

    def check_sysfs(self, fd, major, minor, serial, target):
        """The facts the kernel publishes about the device the descriptor names. An unreadable attribute is a refusal, not a crash."""
        try:
            self._check_sysfs(fd, major, minor, serial, target)
        except (OSError, ValueError):
            raise Refused("device_unreadable", "probe") from None

    def _check_sysfs(self, fd, major, minor, serial, target):
        base = f"{self.sys_root}/dev/block/{major}:{minor}"
        capacity = target["capacityBytes"]
        require(self._read(base + "/serial") == serial, "device_serial", "probe")
        require(self._read(base + "/ro") == "0", "device_readonly", "probe")
        require(int(self._read(base + "/size")) * 512 == capacity, "device_capacity", "probe")
        require(int(self._read(base + "/queue/logical_block_size")) == target["sectorBytes"], "device_sector", "probe")
        require(os.lseek(fd, 0, os.SEEK_END) == capacity, "device_capacity", "probe")
        os.lseek(fd, 0, os.SEEK_SET)
        require(not any(os.path.exists(f"{base}/{name}/partition") for name in os.listdir(base)), "device_partitioned", "probe")
        require(not os.listdir(base + "/holders"), "device_held", "probe")
        require(f"{major}:{minor}" not in parse_mountinfo_devices(self._read(self.mountinfo, 1 << 20)), "device_mounted", "probe")

    def admit(self, purpose, node, major, minor, serial, target):
        require(isinstance(node, str) and os.path.dirname(node) == self.dev_root and os.path.basename(node) not in ("", ".", ".."),
                "device_node", "probe")
        try:
            fd = os.open(node, os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW)
        except OSError:
            raise Refused("device_unopenable", "probe") from None
        try:
            st = os.fstat(fd)
            check_block_identity(st.st_mode, st.st_rdev, major, minor)
            self.check_sysfs(fd, major, minor, serial, target)
            check_open_flags(fcntl.fcntl(fd, fcntl.F_GETFL))
            return Disk(fd, purpose)
        except BaseException:
            os.close(fd)
            raise


# ---------------------------------------------------------------------------------------------------- the engine

def virgin_scan_seconds(capacity):
    return VIRGIN_SCAN_BASE_SECONDS + -(-capacity // VIRGIN_SCAN_FLOOR_BYTES_PER_SECOND)


def all_zero(fd, capacity, deadline, clock=time.monotonic):
    """Every byte of a new volume must read zero (foreign data or an old filesystem refuses, even near the end).
    Compares against a zero buffer (memcmp speed) and tells the kernel to drop what it read."""
    zero = bytes(SCAN_CHUNK)
    offset = 0
    while offset < capacity:
        require(clock() < deadline, "virgin_scan_deadline", "probe")
        chunk = os.pread(fd, min(SCAN_CHUNK, capacity - offset), offset)
        require(bool(chunk) and chunk == zero[:len(chunk)], "not_virgin", "probe")
        if hasattr(os, "posix_fadvise"):
            try:
                os.posix_fadvise(fd, offset, len(chunk), os.POSIX_FADV_DONTNEED)
            except OSError:
                pass
        offset += len(chunk)


def read_superblock(fd):
    return os.pread(fd, 1024, 1024)


def reopen_readonly(fd):
    """A separately read-only descriptor of the same object, for the probe helpers (Linux: through /proc/self/fd)."""
    return os.open(f"/proc/self/fd/{fd}", os.O_RDONLY | os.O_CLOEXEC)


def probe(fd, target, deadline, plan, tools, reopen=reopen_readonly):
    """Read-only observation of one volume (decision D9). Direct superblock read AND `dumpe2fs -h`, which must agree with it.

    Returns (features, transient). Never mounts, never repairs; `full-read-only` additionally runs `e2fsck -f -n`.
    """
    read_fd = reopen(fd)
    try:
        # 1. The first sector holds no foreign signature: ext4 never writes there and mke2fs leaves a new volume zero.
        require(os.pread(read_fd, 1024, 0) == bytes(1024), "foreign_signature", "probe")
        sb = parse_superblock(read_superblock(read_fd))
        require(sb["uuid"] == target["expectedFilesystemUUID"], "filesystem_mismatch", "probe")
        require(sb["blockBytes"] == 4096 and sb["blocks"] * 4096 == target["capacityBytes"], "filesystem_geometry", "probe")
        require(sb["features"] == plan["ext4Features"], "filesystem_features", "probe")
        _, header = tools.run("dumpe2fs", ["-h"], read_fd, deadline, phase="probe")
        properties = parse_dumpe2fs_header(header)
        live_features = sorted(properties.get("Filesystem features", "").split())
        require(len(live_features) == len(set(live_features)), "filesystem_features", "probe")
        transient = [f for f in live_features if f in TRANSIENT_FEATURES]
        features = [f for f in live_features if f not in TRANSIENT_FEATURES]
        require(features == plan["ext4Features"], "filesystem_features", "probe")
        # dumpe2fs and the direct read are independent observations of the same bytes: they must agree on every fact.
        require(transient == sb["transient"] and features == sb["features"], "probe_disagreement", "probe")
        require(properties.get("Filesystem UUID") == target["expectedFilesystemUUID"] and properties.get("Block size") == "4096" and
                properties.get("Block count") == str(target["capacityBytes"] // 4096), "header_geometry", "probe")
        if plan["checkMode"] == "full-read-only":
            tools.run("e2fsck", ["-f", "-n"], read_fd, deadline, phase="probe", timeout=tool_seconds(target["capacityBytes"]))
        else:
            require(properties.get("Filesystem state") == "clean" and sb["clean"], "explicit_full_check_required", "probe")
        # A header observation, not permission to mount or to mark ready: the host refuses readiness while
        # needs_recovery is present, and only an approved journal replay plus a fresh clean observation clears it.
        return features, transient
    finally:
        os.close(read_fd)


def observation(plan, target, replayed, features, transient):
    """One receipt volume: the planned target plus exactly what was observed (the shape matchesFilesystemReceipt demands)."""
    return {**target, "journalReplayed": replayed, "journalReplay": "kernel-mount" if replayed else "none",
            "filesystemFeatures": features, "transientFilesystemFeatures": transient,
            "fullReadOnlyCheck": plan["checkMode"] == "full-read-only", "filesystemType": "ext4",
            "filesystemUUID": target["expectedFilesystemUUID"], "flushConfirmed": True, "checked": True}


class Bootstrap:
    """Single-shot execution of one plan against two admitted disks. The order is the fixture's: both volumes preflight before
    the first write, the whole replay route set is admitted before any format or replay, then per volume
    format / replay, fsync, re-check, probe."""

    def __init__(self, tools=None, replay=None, clock=time.monotonic, reopen=None):
        self.tools = tools or Tools()
        self.reopen = reopen or reopen_readonly
        self.replay = replay  # callable(purpose) -> True once PID 1 replayed by a kernel mount; None when unavailable
        self.clock = clock
        self.consumed = set()

    def execute(self, plan, disks):
        require(valid_filesystem_plan(plan), "closed_shape", "plan")
        require(len(disks) == 2 and disks[0] is not disks[1] and disks[0].fd != disks[1].fd, "fd_pair", "plan")
        require(plan["operationId"] not in self.consumed, "one_shot_consumed", "plan")
        # Even a timeout or crash after this line may never retry a destructive operation.
        self.consumed.add(plan["operationId"])
        scans = sum(virgin_scan_seconds(t["capacityBytes"]) for t in plan["volumes"] if t["action"] == "format-new")
        heavy = sum(tool_seconds(t["capacityBytes"]) for t in plan["volumes"] if t["action"] == "format-new" or plan["checkMode"] == "full-read-only")
        deadline = self.clock() + SERVICE_BUDGET_SECONDS + scans + heavy
        preflight = []
        for disk, target in zip(disks, plan["volumes"]):
            if target["action"] == "format-new":
                all_zero(disk.fd, target["capacityBytes"], min(deadline, self.clock() + virgin_scan_seconds(target["capacityBytes"])), self.clock)
                preflight.append(([], []))
            else:
                preflight.append(probe(disk.fd, target, deadline, plan, self.tools, self.reopen))
        replay_targets = [target for index, target in enumerate(plan["volumes"])
                          if target["action"] == "replay-journal-then-probe" and preflight[index][1]]
        if replay_targets:
            require(callable(self.replay), "kernel_replay_adapter_required", "replay")
        observed = []
        for index, (disk, target) in enumerate(zip(disks, plan["volumes"])):
            replayed = False
            if target["action"] == "format-new":
                self.tools.run("mke2fs", mke2fs_args(target["expectedFilesystemUUID"], disk.regular_file), disk.fd, deadline, phase="format",
                               timeout=tool_seconds(target["capacityBytes"]))
            elif target["action"] == "replay-journal-then-probe" and preflight[index][1]:
                # A kernel mount, flush and unmount done by PID 1, after BOTH read-only preflights. It may change metadata
                # even when it fails; the operation stays consumed and the host keeps its replay debt.
                require(self.replay(target["purpose"]) is True, "kernel_replay_receipt", "replay")
                replayed = True
            try:
                os.fsync(disk.fd)
            except OSError:
                raise Refused("flush_failed", "format" if target["action"] == "format-new" else "replay" if replayed else "probe") from None
            features, transient = probe(disk.fd, target, deadline, plan, self.tools, self.reopen)
            if replayed:
                require(not transient, "journal_recovery_incomplete", "replay")
            observed.append(observation(plan, target, replayed, features, transient))
        receipt = {**plan, "volumes": observed}
        require(matches_filesystem_receipt(plan, receipt), "receipt_self_check")
        return receipt


def verify_before_mount(disks, plan):
    """The last look after the host's `ready` and before PID 1 mounts: both superblocks still say what the receipt said, and
    neither carries pending recovery (a mount would replay the journal unrecorded)."""
    uuids = []
    for disk, target in zip(disks, plan["volumes"]):
        sb = parse_superblock(read_superblock(disk.fd))
        require(sb["uuid"] == target["expectedFilesystemUUID"] and sb["features"] == plan["ext4Features"] and
                sb["blocks"] * 4096 == target["capacityBytes"], "filesystem_changed", "mount")
        require(not sb["transient"], "journal_recovery_required", "mount")
        require(sb["clean"], "filesystem_not_clean", "mount")
        uuids.append(sb["uuid"])
    return uuids


def fault_code(error):
    """Refusal phase -> the closed fault vocabulary of the contract."""
    if isinstance(error, Refused):
        return {"plan": "bad_plan", "probe": "probe_failed", "format": "format_failed", "replay": "replay_failed", "mount": "mount_failed"}.get(error.phase, "internal")
    return "internal"


# ---------------------------------------------------------------------------------------------------- the channel to PID 1

CTL_HEADER = struct.Struct("<B3xI")
CTL_MAX_PAYLOAD = 65536
TAG_UP = ord("B")
TAG_REPLAY = ord("Q")
TAG_MOUNT = ord("M")
TAG_DONE = ord("E")
TAG_DOWN = ord("b")
TAG_REPLAY_RESULT = ord("q")
TAG_MOUNT_RESULT = ord("m")


def ctl_encode(tag, payload=b""):
    if len(payload) > CTL_MAX_PAYLOAD:
        raise ValueError("ctl payload")
    return CTL_HEADER.pack(tag, len(payload)) + payload


class PipeChannel:
    """Length-prefixed messages over two pipe descriptors (no sockets: nothing can carry SCM_RIGHTS)."""

    def __init__(self, read_fd, write_fd):
        self.read_fd = read_fd
        self.write_fd = write_fd

    def _read_exact(self, count):
        """Exactly `count` bytes, or None at a clean end of stream before the first byte. A short message is a refusal."""
        data = bytearray()
        while len(data) < count:
            chunk = os.read(self.read_fd, count - len(data))
            if not chunk:
                require(not data, "channel_truncated")
                return None
            data.extend(chunk)
        return bytes(data)

    def receive(self):
        header = self._read_exact(CTL_HEADER.size)
        if header is None:
            return None
        tag, length = CTL_HEADER.unpack(header)
        require(length <= CTL_MAX_PAYLOAD and header[1:4] == b"\0\0\0", "channel_frame")
        body = self._read_exact(length) if length else b""
        require(body is not None, "channel_truncated")
        return tag, body

    def send(self, tag, payload=b""):
        data = ctl_encode(tag, payload)
        view = memoryview(data)
        while view:
            written = os.write(self.write_fd, view)
            view = view[written:]


SALVAGE_OPERATION = re.compile(rb'"operationId":"([A-Za-z0-9][A-Za-z0-9_-]{0,62})"')
SALVAGE_NONCE = re.compile(rb'"nonce":"([a-f0-9]{32})"')


def salvage_ids(payload):
    """The operation id and nonce a refused message names, if it names both in the one valid spelling. A fault must say which
    operation it answers, so a message too broken to name one gets no answer at all. This is not a parse: nothing else is read."""
    if not isinstance(payload, (bytes, bytearray)) or len(payload) > MAX_BOOTSTRAP_PAYLOAD:
        return None
    operation, nonce = SALVAGE_OPERATION.search(payload), SALVAGE_NONCE.search(payload)
    return (operation.group(1).decode("ascii"), nonce.group(1).decode("ascii")) if operation and nonce else None


class Session:
    """The bootstrap-class conversation, driven from main() and, with fakes, from the tests."""

    def __init__(self, channel, engine, admit, boot_id, verify=None):
        self.channel = channel
        self.engine = engine
        self.admit = admit  # callable(plan) -> [Disk, Disk]
        self.boot_id = boot_id
        self.verify = verify or verify_before_mount

    def _send_up(self, message):
        self.channel.send(TAG_UP, encode_bootstrap_message(message))

    def _receive_body(self):
        item = self.channel.receive()
        if item is None:
            raise Refused("channel_closed")
        tag, body = item
        require(tag == TAG_DOWN, "channel_tag")
        return body

    def _refuse(self, ids, code):
        """Answers a message that cannot start or continue the operation. Without ids there is nothing to answer."""
        if ids is None:
            return 2
        self._send_up({"t": "fault", "operationId": ids[0], "nonce": ids[1], "code": code})
        return 1

    def replay(self, purpose):
        self.channel.send(TAG_REPLAY, purpose.encode("ascii"))
        item = self.channel.receive()
        require(item is not None and item[0] == TAG_REPLAY_RESULT and len(item[1]) == 1, "replay_channel", "replay")
        return item[1] == b"\x01"

    def run(self):
        """Returns 0 after `mounted`, 1 after a `fault` was sent, 2 when nothing could be said (PID 1 only logs that the bootstrap
        ended; the guest stays up and the host's own timeout and `drain` end the boot)."""
        self._send_up({"t": "hello", "guestBootId": self.boot_id, "dataSerial": DATA_SERIAL, "environmentSerial": ENVIRONMENT_SERIAL})
        try:
            body = self._receive_body()
        except Refused:
            return 2
        try:
            first = parse_bootstrap_message(body, "down")
        except ProtocolError:
            return self._refuse(salvage_ids(body), "bad_plan")
        if first["t"] != "plan" or first["operationId"] != first["plan"]["operationId"]:
            return self._refuse((first["operationId"], first["nonce"]), "bad_plan")
        operation, nonce = first["operationId"], first["nonce"]
        disks = []

        def fault(error):
            code = fault_code(error)
            try:
                self._send_up({"t": "fault", "operationId": operation, "nonce": nonce, "code": code})
            finally:
                for disk in disks:
                    disk.close()
            return 1

        try:
            disks.extend(self.admit(first["plan"]))
            self.engine.replay = self.replay if self.engine.replay is None else self.engine.replay
            receipt = self.engine.execute(first["plan"], disks)
            self._send_up({"t": "receipt", "operationId": operation, "nonce": nonce, "receipt": receipt})
        except Exception as error:  # a Refused, or anything unexpected: the host only ever learns a closed code
            return fault(error)
        try:
            ready = parse_bootstrap_message(self._receive_body(), "down")
            if ready["t"] != "ready" or ready["operationId"] != operation or ready["nonce"] != nonce:
                raise Refused("ready_refused")   # not this plan's `ready`: say so, mount nothing
        except (ProtocolError, Refused) as error:
            if isinstance(error, Refused) and error.reason in ("channel_closed", "channel_tag"):
                for disk in disks:
                    disk.close()
                return 2
            return fault(error if isinstance(error, Refused) else Refused("ready_refused"))
        try:
            uuids = self.verify(disks, first["plan"])
            for disk in disks:  # the mount claims the devices; this process holds no descriptor while PID 1 mounts
                disk.close()
            self.channel.send(TAG_MOUNT, " ".join(uuids).encode("ascii"))
            item = self.channel.receive()
            require(item is not None and item[0] == TAG_MOUNT_RESULT and item[1] == b"\x01", "mount_refused", "mount")
            self._send_up({"t": "mounted", "operationId": operation, "nonce": nonce})
        except Exception as error:
            return fault(error)
        self.channel.send(TAG_DONE)
        return 0


# ---------------------------------------------------------------------------------------------------- entry point

def parse_arguments(argv):
    """--channel-fds IN,OUT --data NODE:MAJOR:MINOR --environment NODE:MAJOR:MINOR (all produced by PID 1)."""
    values = {}
    items = list(argv)
    while items:
        name = items.pop(0)
        if name not in ("--channel-fds", "--data", "--environment") or not items or name in values:
            raise Refused("arguments")
        values[name] = items.pop(0)
    if set(values) != {"--channel-fds", "--data", "--environment"}:
        raise Refused("arguments")
    fds = values["--channel-fds"].split(",")
    require(len(fds) == 2 and all(f.isdigit() for f in fds), "arguments")
    devices = {}
    for key, name in (("--data", "data"), ("--environment", "environment")):
        parts = values[key].rsplit(":", 2)
        require(len(parts) == 3, "arguments")
        node, major, minor = parts
        require(bool(node) and major.isdigit() and minor.isdigit(), "arguments")
        devices[name] = (node, int(major), int(minor))
    return int(fds[0]), int(fds[1]), devices


def read_boot_id(path="/proc/sys/kernel/random/boot_id"):
    with open(path, "r", encoding="ascii") as handle:
        value = handle.read(64).strip()
    require(bool(UUID.fullmatch(value)), "boot_id")
    return value


def main(argv):
    try:
        read_fd, write_fd, devices = parse_arguments(argv)
    except Refused:
        return 64
    channel = PipeChannel(read_fd, write_fd)
    admission = BlockDeviceAdmission()
    serials = {"data": DATA_SERIAL, "environment": ENVIRONMENT_SERIAL}

    def admit(plan):
        disks = []
        try:
            for purpose, target in zip(("data", "environment"), plan["volumes"]):
                node, major, minor = devices[purpose]
                disks.append(admission.admit(purpose, node, major, minor, serials[purpose], target))
        except BaseException:
            for disk in disks:
                disk.close()
            raise
        return disks

    session = Session(channel, Bootstrap(Tools()), admit, read_boot_id())
    try:
        return session.run()
    except Exception:
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
