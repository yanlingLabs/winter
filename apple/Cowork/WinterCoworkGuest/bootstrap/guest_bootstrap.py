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
import array
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
import termios
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
MAX_CONVERSATIONS_BYTES = 20_480      # the `conversations` message; the relay refuses anything above it before it reaches this process
MAX_CONVERSATIONS = 16
GUIDANCE_DIRECTORY = "/run/winter/shared-instructions"   # the guided conversation's `guidanceDirectory` (WG_GUIDANCE_DIRECTORY in trusted_config.h); empty in the first session
UNIX_ID_MIN, UNIX_ID_MAX = 1000, 65533   # 65534 is `nobody` and 65535 the invalid id (contract section 6.1)
MAX_ROOTS = 16
MAX_PROVIDER_BYTES = 4096
MAX_SAFE_INTEGER = 2**53 - 1
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
FAULT_CODES = ("bad_plan", "probe_failed", "format_failed", "replay_failed", "mount_failed", "internal", "bad_conversations", "supervisor_failed", "second_conversations")
# Contract revision 3 (bootstrap `v` 2) adds four: the share inventory, a share that would not mount, a resume with no store, a fresh start on a store that has content.
FAULT_CODES_V3 = FAULT_CODES + ("share_inventory", "share_mount_failed", "resume_store_missing", "fresh_store_not_empty")
MAX_ENDED_BOOTS = 4
MAX_RUNTIME_TIMEOUT_MS_V3 = 86_400_000
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
    raise ValueError("non-finite number")


def _js_key_order(value):
    """JavaScript lists the keys that are array indexes ("0", "17", up to 2**32-2) first, in numeric order, and the rest in insertion order, so
    `JSON.stringify(JSON.parse(text))` differs from a text that spells such a key anywhere else (protocol.ts strictLine then says `malformed`)."""
    if isinstance(value, list):
        return [_js_key_order(item) for item in value]
    if isinstance(value, dict):
        indexes = sorted((k for k in value if k.isascii() and k.isdigit() and (k == "0" or not k.startswith("0")) and int(k) < 2**32 - 1), key=int)
        rest = [k for k in value if k not in set(indexes)]
        return {k: _js_key_order(value[k]) for k in indexes + rest}
    return value


def _json_number(text):
    """A fraction or exponent spelling, as JavaScript's JSON.parse sees it: an integral value IS that integer (so the canonical re-serialisation
    differs from the text and the message is `malformed`), anything else stays a float that no field accepts (`bad_field`)."""
    value = float(text)
    if value == value and abs(value) < 2**53 and value == int(value):
        return int(value)
    return value


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
    if not all(0x20 <= ord(ch) <= 0x7E for ch in text):
        raise ProtocolError("malformed")  # printable ASCII only, as protocol.ts jsonPayload demands (0x7f is outside it)
    if not nests_within(text, MAX_NESTING):
        raise ProtocolError("malformed")
    try:
        parsed = json.loads(text, object_pairs_hook=_reject_pairs, parse_float=_json_number, parse_constant=_reject_number)
        _clean_data(parsed)
    except (ValueError, RecursionError):
        raise ProtocolError("malformed") from None
    try:
        round_trips = isinstance(parsed, dict) and canonical_text(_js_key_order(parsed)) == text
    except ValueError:   # an infinity (1e999) has no spelling
        round_trips = False
    if not round_trips:
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


# ---------------------------------------------------------------------------------------------------- conversation set
# Port of protocol.ts (round 3) conversationsOf / checkConversationsMessage. The helper is the judge of this message: PID 1 only
# receives the finished result (boot.h wg_conversation_set).

# ---- the revision of the bootstrap-class JSON this helper speaks.
# Revision 2 (`v` 1) is the production guest. Revision 3 (`v` 2: browseUid, cold-resume fields, shares, `continuations`) is spoken only by an image that declares the runtime
# capability `file-channel-v1`: PID 1 starts the helper with `--file-channel-v1` there and nowhere else. The mode is process-wide on purpose (one helper, one host).
REVISION_THREE = False
BOOTSTRAP_VERSION = 1


def set_revision_three(on):
    """Switches the helper's bootstrap vocabulary; returns the previous setting (the tests restore it)."""
    global REVISION_THREE, BOOTSTRAP_VERSION
    previous = REVISION_THREE
    REVISION_THREE = bool(on)
    BOOTSTRAP_VERSION = 2 if on else 1
    return previous


SDK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
CONTINUATIONS = ("fresh", "resume", "either")
SHARE_KINDS = ("folder", "guidance", "memory", "outputs")
SHARE_MOUNTS = {"guidance": "/run/winter/shared-instructions", "memory": "/workspace/.winter/memory", "outputs": "/workspace/outputs"}
SHARE_TAG = re.compile(r"[a-z0-9-]{1,32}\Z")
FOLDER_MOUNT = re.compile(r"/workspace/folders/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
MAX_SHARES, MAX_FOLDER_SHARES = 12, 9
POLICIES = ("auto", "plan", "ask", "accept-edits", "dont-ask", "bypass")
RUNTIME_PROFILES = ("host-query-v1", "host-query-guided-v1")
RUNTIME_KEYS = {"host-query-v1": "hostQueryRuntime", "host-query-guided-v1": "hostQueryGuidedRuntime"}
TOOL_CLASSES = ("read", "write", "execute")
PRIVATE_WORDS = ("authref", "url", "header", "secret", "token", "credential")
SCOPE_KEYS = ["accountRevision", "backendSessionId", "bootId", "grantRevision", "homeId", "incarnationId", "leaseEpoch", "modelRevision", "sessionId", "taskId", "workspaceId"]
SELECTION_REQUIRED = {"capabilities", "family", "modelKey", "protocol", "providerId", "providerModelId"}
SELECTION_ALLOWED = SELECTION_REQUIRED | {"continuationDomain"}
AUTHORITY_KEYS = ("workspaceId", "sessionId", "incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision")


def _sdk_id(value):
    return type(value) is str and bool(SDK_ID.match(value))


def _printable(text):
    return all(0x20 <= ord(ch) <= 0x7E for ch in text)


def _uint(value, minimum=0, maximum=MAX_SAFE_INTEGER):
    return type(value) is int and minimum <= value <= maximum


def _exact(value, keys):
    return type(value) is dict and list(value) is not None and set(value) == set(keys)


def _guest_path(value):
    if type(value) is not str or len(value) > 1024 or not _printable(value) or not value.startswith("/"):
        return False
    return not any(part in ("", ".", "..") for part in value[1:].split("/"))


def _workspace_path(value):
    return _guest_path(value) and value.startswith("/workspace/")


ROOT_SOURCE_COMPONENT = re.compile(r"[A-Za-z0-9._-]+")


def _root_source(value):
    """A root `source` as PID 1 will walk it (boot.c root_source_ok): /workspace/ then components of [A-Za-z0-9._-], at most 255 bytes in all. The helper answers bad_conversations for anything else."""
    if not _workspace_path(value) or len(value) > 255 or not value.isascii():
        return False
    return all(ROOT_SOURCE_COMPONENT.fullmatch(part) for part in value[len("/workspace/"):].split("/"))


def _allowed_view(path, session_id):
    parts = path[1:].split("/")
    if parts[0] != "workspace":
        return False
    return ((len(parts) >= 3 and parts[1] in ("folders", "repos"))
            or (len(parts) == 3 and parts[1] == ".winter" and parts[2] == "memory")
            or (len(parts) == 4 and parts[1] == ".winter" and parts[2] == "scratch" and parts[3] == session_id)
            or (len(parts) == 3 and parts[1] == "outputs" and parts[2] == session_id))


def _public_metadata(node, depth):
    if depth > 6:
        return False
    if node is None or type(node) in (str, bool):
        return True
    if type(node) is int:
        return -MAX_SAFE_INTEGER <= node <= MAX_SAFE_INTEGER
    if type(node) is list:
        return all(_public_metadata(child, depth + 1) for child in node)
    if type(node) is not dict:
        return False
    for key, child in node.items():
        if any(word in key.lower() for word in PRIVATE_WORDS) or not _public_metadata(child, depth + 1):
            return False
    return True


def _provider(value):
    if type(value) is not dict:
        return False
    provider = sorted_canonical(value)
    if len(canonical_text(provider).encode("utf-8")) > MAX_PROVIDER_BYTES:
        raise ProtocolError("oversize")
    if not _public_metadata(provider, 0) or list(provider) != ["scope", "selection"] or type(provider["scope"]) is not dict or type(provider["selection"]) is not dict:
        return False
    scope, selection = provider["scope"], provider["selection"]
    if list(scope) != SCOPE_KEYS:
        return False
    if not all(_sdk_id(scope[k]) for k in ("backendSessionId", "homeId", "incarnationId", "sessionId", "taskId", "workspaceId")):
        return False
    if not all(_uint(scope[k]) for k in ("accountRevision", "grantRevision", "leaseEpoch", "modelRevision")) or not _boot_id(scope["bootId"]):
        return False
    return SELECTION_REQUIRED <= set(selection) <= SELECTION_ALLOWED


def _tool_classes(value):
    if type(value) is not list or len(value) > len(TOOL_CLASSES) or not all(type(entry) is str and entry in TOOL_CLASSES for entry in value):
        return False
    indexes = [TOOL_CLASSES.index(entry) for entry in value]
    return all(indexes[i] > indexes[i - 1] for i in range(1, len(indexes)))


def _ended_boots(value):
    return type(value) is list and len(value) <= MAX_ENDED_BOOTS and all(_boot_id(v) for v in value) and len(set(value)) == len(value)


def _runtime(value):
    if value is None:
        return True
    keys = ("model", "timeoutMs", "toolClasses", "provider", "guided", "continuation", "endedGuestBoots") if REVISION_THREE else ("model", "timeoutMs", "toolClasses", "provider", "guided")
    if not _exact(value, keys):
        return False
    model = value["model"]
    if type(model) is not str or not 1 <= len(model) <= 256 or not _printable(model) or not _uint(value["timeoutMs"], 1, MAX_RUNTIME_TIMEOUT_MS_V3 if REVISION_THREE else 600_000):
        return False
    if not _tool_classes(value["toolClasses"]) or not _provider(value["provider"]):
        return False
    guided = value["guided"]
    if not (guided is None or (_exact(guided, ("bindingId", "generation")) and type(guided["bindingId"]) is str and bool(UUID4.match(guided["bindingId"]))
                               and _uint(guided["generation"], 1))):
        return False
    if REVISION_THREE and (type(value["continuation"]) is not str or value["continuation"] not in CONTINUATIONS or not _ended_boots(value["endedGuestBoots"])):
        return False
    return True


def _roots(value, session_id):
    if type(value) is not list or not 1 <= len(value) <= MAX_ROOTS:
        return False
    for root in value:
        if not _exact(root, ("id", "guestPath", "source", "readOnly")) or not _sdk_id(root["id"]) or not _workspace_path(root["guestPath"]) \
                or not _root_source(root["source"]) or type(root["readOnly"]) is not bool:
            return False
    views = [root["guestPath"] for root in value]
    if len({root["id"] for root in value}) != len(value) or len(set(views)) != len(views):
        return False
    if any(a != b and b.startswith(a + "/") for a in views for b in views):
        return False
    return all(_allowed_view(view, session_id) for view in views)


def _conversation(item):
    if not _exact(item, ("logicalSessionId", "authority", "runtimeUid", "toolUid", "workspaceGid", "policy", "roots", "runtime")):
        return False
    session_id, authority = item["logicalSessionId"], item["authority"]
    if not _sdk_id(session_id) or not _exact(authority, AUTHORITY_KEYS):
        return False
    if not (_sdk_id(authority["workspaceId"]) and _sdk_id(authority["sessionId"]) and _sdk_id(authority["incarnationId"]) and _uint(authority["leaseEpoch"], 1, 0xFFFFFFFF)
            and all(_uint(authority[k]) for k in ("configRevision", "grantRevision", "policyRevision"))):
        return False
    if not all(_uint(item[k], UNIX_ID_MIN, UNIX_ID_MAX) for k in ("runtimeUid", "toolUid", "workspaceGid")) or item["policy"] not in POLICIES:
        return False
    # The nested checks run in the order protocol.ts runs them, so that a value with several defects names the same category.
    if not _roots(item["roots"], session_id) or not _runtime(item["runtime"]):
        return False
    runtime = item["runtime"]
    if runtime is not None:
        for root in item["roots"]:
            if root["guestPath"] == "/workspace/.winter" or root["guestPath"].startswith("/workspace/.winter/") or (item["policy"] == "plan" and not root["readOnly"]):
                return False
        scope, selection = runtime["provider"]["scope"], runtime["provider"]["selection"]
        if (scope["workspaceId"] != authority["workspaceId"] or scope["sessionId"] != session_id or scope["backendSessionId"] != authority["sessionId"]
                or scope["incarnationId"] != authority["incarnationId"] or scope["leaseEpoch"] != authority["leaseEpoch"]
                or scope["grantRevision"] != authority["grantRevision"] or selection["modelKey"] != runtime["model"]):
            return False
        # Cold resume (revision 3): a fresh store has no earlier boot to vouch for, and the live boot can never be attested as ended.
        if REVISION_THREE and ((runtime["continuation"] == "fresh" and runtime["endedGuestBoots"]) or scope["bootId"] in runtime["endedGuestBoots"]):
            return False
    return True


def _conversations(value):
    return type(value) is list and 1 <= len(value) <= MAX_CONVERSATIONS and all(_conversation(item) for item in value)


def _profile(value):
    return value is None or (type(value) is str and value in RUNTIME_PROFILES)


def _check_conversations_message(message):
    profile, items = message["profile"], message["conversations"]
    first = items[0]["authority"]
    for item in items:
        authority = item["authority"]
        if authority["workspaceId"] != first["workspaceId"] or authority["leaseEpoch"] != first["leaseEpoch"] or authority["incarnationId"] != message["incarnationId"]:
            return False
        if (profile is None) != (item["runtime"] is None):
            return False
        if item["runtime"] is not None and (item["runtime"]["guided"] is not None) != (profile == "host-query-guided-v1"):
            return False
    if profile is not None and len(items) != 1:
        return False   # N2: ONE host-query conversation per guest
    if len({i["logicalSessionId"] for i in items}) != len(items) or len({i["authority"]["sessionId"] for i in items}) != len(items):
        return False
    uids = [uid for i in items for uid in (i["runtimeUid"], i["toolUid"])]
    if len(set(uids)) != len(uids) or any(a["workspaceGid"] in (b["runtimeUid"], b["toolUid"]) for a in items for b in items):
        return False
    # The file channel's browse uid (one per workspace) is no member's runtime or tool uid and no group id.
    if REVISION_THREE and message["browseUid"] is not None and (message["browseUid"] in uids or any(i["workspaceGid"] == message["browseUid"] for i in items)):
        return False
    return len({i["runtime"]["provider"]["scope"]["bootId"] for i in items if i["runtime"]}) <= 1


def _ordered(value, keys):
    return {key: value[key] for key in keys}


def _normalize_conversations(items):
    """The schema's key order for every nested object (the provider is the one free-form object and stays recursively sorted)."""
    out = []
    for item in items:
        runtime = item["runtime"]
        full = runtime
        if runtime is not None:
            guided = runtime["guided"]
            runtime = {"model": runtime["model"], "timeoutMs": runtime["timeoutMs"], "toolClasses": runtime["toolClasses"],
                       "provider": sorted_canonical(runtime["provider"]),
                       "guided": None if guided is None else _ordered(guided, ("bindingId", "generation"))}
            if REVISION_THREE:
                runtime["continuation"] = full["continuation"]
                runtime["endedGuestBoots"] = full["endedGuestBoots"]
        out.append({"logicalSessionId": item["logicalSessionId"], "authority": _ordered(item["authority"], AUTHORITY_KEYS),
                    "runtimeUid": item["runtimeUid"], "toolUid": item["toolUid"], "workspaceGid": item["workspaceGid"], "policy": item["policy"],
                    "roots": [_ordered(root, ("id", "guestPath", "source", "readOnly")) for root in item["roots"]], "runtime": runtime})
    return out


def _runtime_ready_count(value):
    return _uint(value, 1, MAX_CONVERSATIONS)


def _unix_id_or_null(value):
    return value is None or _uint(value, UNIX_ID_MIN, UNIX_ID_MAX)


def _continuations(value):
    return type(value) is list and len(value) <= MAX_CONVERSATIONS and all(type(v) is str and v in ("fresh", "resume") for v in value)


def _guest_shares(value):
    """protocol.ts guestSharesOf + checkShareSet: 1 to 12 shares, at most 9 folders and one of each Winter kind, distinct tags and guest paths, the right mount and mode for each kind."""
    if type(value) is not list or not 1 <= len(value) <= MAX_SHARES:
        return False
    for share in value:
        if not _exact(share, ("tag", "guestPath", "readOnly", "kind")) or type(share["tag"]) is not str or not SHARE_TAG.match(share["tag"]) \
                or not _guest_path(share["guestPath"]) or type(share["readOnly"]) is not bool or type(share["kind"]) is not str or share["kind"] not in SHARE_KINDS:
            return False
    if len({s["tag"] for s in value}) != len(value) or len({s["guestPath"] for s in value}) != len(value):
        return False
    if sum(1 for s in value if s["kind"] == "folder") > MAX_FOLDER_SHARES or any(sum(1 for s in value if s["kind"] == kind) > 1 for kind in ("guidance", "memory", "outputs")):
        return False
    for share in value:
        mount_ok = bool(FOLDER_MOUNT.match(share["guestPath"])) if share["kind"] == "folder" else share["guestPath"] == SHARE_MOUNTS[share["kind"]]
        mode_ok = share["kind"] == "folder" or share["readOnly"] == (share["kind"] == "guidance")
        if not mount_ok or not mode_ok:
            return False
    return True


def _normalize_shares(items):
    return [_ordered(item, ("tag", "guestPath", "readOnly", "kind")) for item in items]


def _runtime_ready_continuations_ok(message):
    return len(message["continuations"]) <= message["conversations"]


# message type -> ordered (key, validator). Insertion order IS the wire order, exactly as in protocol.ts BOOTSTRAP_SPECS.
BOOTSTRAP_SPECS = {
    "down": {
        "plan": (("operationId", _token), ("nonce", _nonce), ("plan", _plan_object)),
        "ready": (("operationId", _token), ("nonce", _nonce)),
        "conversations": (("operationId", _token), ("nonce", _nonce), ("incarnationId", _token), ("profile", _profile), ("conversations", _conversations)),
    },
    "up": {
        "hello": (("guestBootId", _boot_id), ("dataSerial", lambda v: v == DATA_SERIAL), ("environmentSerial", lambda v: v == ENVIRONMENT_SERIAL)),
        "receipt": (("operationId", _token), ("nonce", _nonce), ("receipt", _plain_object)),
        "fault": (("operationId", _token), ("nonce", _nonce), ("code", lambda v: v in (FAULT_CODES_V3 if REVISION_THREE else FAULT_CODES))),
        "mounted": (("operationId", _token), ("nonce", _nonce)),
        "runtime_ready": (("operationId", _token), ("nonce", _nonce), ("conversations", _runtime_ready_count)),
    },
}
# Per-type cross-field rules (run after every field validated), size caps tighter than the class ceiling, and key normalisers.
MESSAGE_CHECKS = {("down", "conversations"): _check_conversations_message}
MESSAGE_CAPS = {("down", "conversations"): MAX_CONVERSATIONS_BYTES}
NORMALIZERS = {("down", "conversations", "conversations"): _normalize_conversations}

# Revision 3 (`v` 2): the same tables with what changed. Selected by set_revision_three(); nothing else about parsing differs.
BOOTSTRAP_SPECS_V3 = {
    "down": {
        "plan": BOOTSTRAP_SPECS["down"]["plan"],
        "ready": BOOTSTRAP_SPECS["down"]["ready"],
        "shares": (("operationId", _token), ("nonce", _nonce), ("shares", _guest_shares)),
        "conversations": (("operationId", _token), ("nonce", _nonce), ("incarnationId", _token), ("profile", _profile), ("browseUid", _unix_id_or_null), ("conversations", _conversations)),
    },
    "up": {
        **{name: spec for name, spec in BOOTSTRAP_SPECS["up"].items() if name != "runtime_ready"},
        "shares_mounted": (("operationId", _token), ("nonce", _nonce)),
        "runtime_ready": (("operationId", _token), ("nonce", _nonce), ("conversations", _runtime_ready_count), ("continuations", _continuations)),
    },
}
MESSAGE_CHECKS_V3 = {**MESSAGE_CHECKS, ("up", "runtime_ready"): _runtime_ready_continuations_ok}
MESSAGE_CAPS_V3 = {**MESSAGE_CAPS, ("down", "shares"): MAX_CONVERSATIONS_BYTES}
NORMALIZERS_V3 = {**NORMALIZERS, ("down", "shares", "shares"): _normalize_shares}


def _tables():
    if REVISION_THREE:
        return BOOTSTRAP_SPECS_V3, MESSAGE_CHECKS_V3, MESSAGE_CAPS_V3, NORMALIZERS_V3
    return BOOTSTRAP_SPECS, MESSAGE_CHECKS, MESSAGE_CAPS, NORMALIZERS


def parse_bootstrap_message(payload, direction):
    """One bootstrap-class payload (bytes, no newline) -> a dict {t, fields...} or ProtocolError.

    The guest receives direction "down" only; the "up" table lets the tests hold the guest's own output to the same schema.
    """
    parsed, text = strict_object(payload)
    kind = parsed.get("t") if "t" in parsed else None
    all_specs, checks, caps, normalizers = _tables()
    specs = all_specs[direction]
    if not isinstance(kind, str) or kind not in specs:
        raise ProtocolError("unknown_type")
    spec = specs[kind]
    if len(payload) > caps.get((direction, kind), MAX_BOOTSTRAP_PAYLOAD):
        raise ProtocolError("oversize")
    if REVISION_THREE and (type(parsed.get("v")) is not int or parsed["v"] != BOOTSTRAP_VERSION):
        raise ProtocolError("version")   # judged before the schema: a peer one revision behind is told `version`, never `bad_field`
    if set(parsed) != {"v", "t"} | {key for key, _ in spec}:
        raise ProtocolError("bad_field")
    if type(parsed["v"]) is not int or parsed["v"] != BOOTSTRAP_VERSION:
        raise ProtocolError("bad_field")
    typed = {"v": BOOTSTRAP_VERSION, "t": kind}
    for key, check in spec:
        if not check(parsed[key]):
            raise ProtocolError("bad_field")
        normalize = normalizers.get((direction, kind, key))
        typed[key] = normalize(parsed[key]) if normalize else sorted_canonical(parsed[key]) if isinstance(parsed[key], dict) else parsed[key]
    rule = checks.get((direction, kind))
    if rule is not None and not rule(typed):
        raise ProtocolError("bad_field")
    if canonical_text(typed) != text:
        raise ProtocolError("malformed")  # key order, or an unsorted nested object
    return typed


def encode_bootstrap_message(message):
    """The canonical payload (bytes) of an up message; the schema check is the one a received message would pass."""
    kind = message["t"]
    up_specs = _tables()[0]["up"]
    if kind not in up_specs:
        raise ValueError("not an up message")
    typed = {"v": BOOTSTRAP_VERSION, "t": kind}
    for key, check in up_specs[kind]:
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
TAG_CONVERSATIONS = ord("C")
TAG_CONVERSATIONS_RESULT = ord("r")
RESULT_READY, RESULT_BAD_CONVERSATIONS, RESULT_SUPERVISOR_FAILED = 0, 1, 2
# Host-backed shares (revision 3 only): the validated, bound set to PID 1, and its one-byte answer (boot.h WG_SHARES_*).
TAG_SHARES = ord("S")
TAG_SHARES_RESULT = ord("s")
SHARES_MOUNTED, SHARES_INVENTORY, SHARES_MOUNT_FAILED = 0, 1, 2
SHARE_KIND_CODES = {"folder": 0, "guidance": 1, "memory": 2, "outputs": 3}


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

    def has_pending(self):
        """True when bytes from PID 1 are already waiting. Asked right after the host's `ready`: nothing the host may send can be there yet,
        because the host sends its next message only after it has seen `mounted` (contract section 6.1)."""
        waiting = array.array("i", [0])
        fcntl.ioctl(self.read_fd, termios.FIONREAD, waiting, True)
        return waiting[0] > 0

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


def conversations_bound(message, plan_message, boot_id):
    """What a receiver compares against the plan and its own boot id before it starts anything (protocol.ts coworkNativeConversationsAreBound).
    The guest holds the plan of the exchange, so the workspace, the incarnation and the lease epoch are the plan's own."""
    plan = plan_message["plan"]
    owner = plan["owner"]
    if message["operationId"] != plan_message["operationId"] or message["nonce"] != plan_message["nonce"] or message["incarnationId"] != owner["incarnationId"]:
        return False
    for item in message["conversations"]:
        authority = item["authority"]
        if authority["workspaceId"] != plan["workspaceId"] or authority["incarnationId"] != owner["incarnationId"] or authority["leaseEpoch"] != owner["leaseEpoch"]:
            return False
        if item["runtime"] is not None and item["runtime"]["provider"]["scope"]["bootId"] != boot_id:
            return False
    return True


def supervisor_items(message):
    """The supervisor's conversation items for a validated, bound message: the wire's own fields, plus under the profile's key what only the
    guest knows (the two directories PID 1 creates) and the runtime members the supervisor's `_configure_runtime` reads."""
    key = RUNTIME_KEYS.get(message["profile"])
    items = []
    for item in message["conversations"]:
        out = {k: item[k] for k in ("logicalSessionId", "authority", "runtimeUid", "toolUid", "workspaceGid", "policy", "roots")}
        runtime = item["runtime"]
        if runtime is not None:
            sid = item["logicalSessionId"]
            config = {"storeDirectory": "/workspace/.winter/conversations/" + sid, "runhomeDirectory": "/run/winter/conversations/" + sid,
                      "provider": runtime["provider"], "model": runtime["model"], "timeoutMs": runtime["timeoutMs"], "toolClasses": runtime["toolClasses"]}
            if runtime["guided"] is not None:
                config["requiredRuntimeContext"] = {"version": 1, "bindingId": runtime["guided"]["bindingId"]}
                config["generation"] = runtime["guided"]["generation"]
                config["guidanceDirectory"] = GUIDANCE_DIRECTORY   # required by the supervisor for a guided conversation, refused for any other
            out[key] = config
        items.append(out)
    return items


EXTENDED_PAYLOAD = 0x80


def conversations_payload(message):
    """The 'C' message to PID 1 (boot.h wg_conversation_set): profile, count, per conversation uid and id, then the items as JSON."""
    profile = {None: 0, "host-query-v1": 1, "host-query-guided-v1": 2}[message["profile"]]
    out = bytearray([profile | (EXTENDED_PAYLOAD if REVISION_THREE else 0), len(message["conversations"])])
    for item in message["conversations"]:
        sid = item["logicalSessionId"].encode("ascii")
        out += struct.pack("<IB", item["runtimeUid"], len(sid)) + sid
    if REVISION_THREE:
        # The file channel's part (boot.h wg_conversation_set under WG_FILE_CHANNEL_V1): the workspace's browse uid (0 = none), then per conversation its workspace gid and the
        # `source` of every root, which PID 1 makes as root:workspaceGid 02770 directories on the data volume.
        out += struct.pack("<I", message["browseUid"] or 0)
        for item in message["conversations"]:
            out += struct.pack("<IB", item["workspaceGid"], len(item["roots"]))
            for root in item["roots"]:
                source = root["source"].encode("ascii")
                out += struct.pack("<B", len(source)) + source
    out += canonical_text(supervisor_items(message)).encode("ascii")
    return bytes(out)


def shares_bound(message, plan_message):
    """A share set answers the plan of this exchange: its operation and nonce, exactly as a conversation set must (conversations_bound)."""
    return message["operationId"] == plan_message["operationId"] and message["nonce"] == plan_message["nonce"]


def shares_payload(message):
    """The 'S' message to PID 1 (boot.h wg_share_set): count, then per share kind, flags (bit 0 read-only), tag and guest path, each with a length byte."""
    out = bytearray([len(message["shares"])])
    for share in message["shares"]:
        tag, path = share["tag"].encode("ascii"), share["guestPath"].encode("ascii")
        out += bytes([SHARE_KIND_CODES[share["kind"]], 1 if share["readOnly"] else 0, len(tag)]) + tag + bytes([len(path)]) + path
    return bytes(out)


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
        if self.channel.has_pending():   # the host spoke again before it could have seen `mounted`: mount nothing, start nothing
            return fault(Refused("message_before_mounted", "plan"))
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
        return self.serve_conversations(first, operation, nonce)

    def _fault(self, operation, nonce, code):
        self._send_up({"t": "fault", "operationId": operation, "nonce": nonce, "code": code})

    def serve_conversations(self, plan_message, operation, nonce):
        """After `mounted` the helper stays up for the one conversation set of the incarnation (contract section 6.1). A valid, bound set goes
        to PID 1, which makes the directories, writes the trusted config and starts the supervisor; this process answers `runtime_ready` or
        a bootstrap fault. A second set is `second_conversations`. The guest stays up after a fault, waiting for the drain, which shows here
        as the end of the channel. Returns 0 at that end, 2 when the channel breaks.

        Revision 3: before the set the host may send ONE share set (design 2026-10-18 section 2.5). PID 1 mounts it and the helper answers `shares_mounted` or
        a share fault; a set that follows a share step that did not end in `shares_mounted` is `bad_conversations`, so no conversation ever starts over a
        share set that is not mounted and checked."""
        seen = False
        shares = None   # None: no share set yet; "mounted"; "failed"
        self.pending = []
        while True:
            try:
                item = (TAG_DOWN, self.pending.pop(0)) if self.pending else self.channel.receive()
            except Refused:
                return 2
            if item is None:
                return 0
            tag, body = item
            if tag != TAG_DOWN:
                return 2
            try:
                message = parse_bootstrap_message(body, "down")
            except ProtocolError:
                # A broken `conversations` message (and only that) is answered, under the exchange's own ids; anything else unreadable gets no answer.
                if re.search(rb'"t":"conversations"', body[:96]) and len(body) <= MAX_BOOTSTRAP_PAYLOAD:
                    self._fault(operation, nonce, "second_conversations" if seen else "bad_conversations")
                    seen = True
                elif REVISION_THREE and re.search(rb'"t":"shares"', body[:96]) and len(body) <= MAX_BOOTSTRAP_PAYLOAD:
                    # a broken share set is answered too: the host waits for `shares_mounted`, and none will come
                    self._fault(operation, nonce, "share_mount_failed")
                    shares = "failed"
                continue
            if message["t"] == "shares":
                shares = self.serve_shares(message, plan_message, operation, nonce, seen, shares)
                if shares is None:
                    return 2
                continue
            if message["t"] != "conversations":
                continue
            if seen:
                self._fault(operation, nonce, "second_conversations")
                continue
            seen = True
            if shares == "failed":
                # the host sent a share set that is not mounted: no conversation may start without it
                self._fault(operation, nonce, "bad_conversations")
                continue
            if not conversations_bound(message, plan_message, self.boot_id):
                self._fault(operation, nonce, "bad_conversations")
                continue
            if REVISION_THREE and any(item["runtime"] is not None and item["runtime"]["continuation"] == "resume" for item in message["conversations"]):
                # This guest starts fresh conversations only (the supervisor refuses a store that is not empty): a resume has no store to find. `either` means fresh here.
                self._fault(operation, nonce, "resume_store_missing")
                continue
            self.channel.send(TAG_CONVERSATIONS, conversations_payload(message))
            result = self._await_conversations_result()
            if result is None:
                return 2
            status, count = result
            if status == RESULT_READY and count == len(message["conversations"]):
                ready = {"t": "runtime_ready", "operationId": operation, "nonce": nonce, "conversations": count}
                if REVISION_THREE:
                    ready["continuations"] = ["fresh" for item in message["conversations"] if item["runtime"] is not None]
                self._send_up(ready)
            else:
                self._fault(operation, nonce, "supervisor_failed" if status == RESULT_SUPERVISOR_FAILED else "bad_conversations")

    def serve_shares(self, message, plan_message, operation, nonce, seen, state):
        """One `shares` message (revision 3). Returns the share state that follows: "mounted" (PID 1 mounted and checked every share and the helper said
        `shares_mounted`), "failed" (a fault was said; nothing stays mounted that the drain does not unmount), or None when the channel to PID 1 broke.
        The host's order is checked here as the contract's coworkNativeBootstrapOrder states it: a share set only after `mounted` (the helper is past that),
        before any conversation set, at most once, and nothing more from the host until it has seen `shares_mounted`."""
        if seen or state is not None:
            self._fault(operation, nonce, "share_mount_failed")   # after the set, or a second share set: mount nothing
            return "failed"
        if not shares_bound(message, plan_message):
            self._fault(operation, nonce, "share_mount_failed")   # not this plan's: mount nothing
            return "failed"
        if self.channel.has_pending():
            self._fault(operation, nonce, "share_mount_failed")   # the host spoke again before it could have seen `shares_mounted`: mount nothing
            return "failed"
        already = len(self.pending)
        self.channel.send(TAG_SHARES, shares_payload(message))
        result = self._await_result(TAG_SHARES_RESULT, 1)
        if result is None:
            return None
        if len(self.pending) != already:
            # the host spoke while PID 1 was mounting, before it could have seen `shares_mounted`: say no, and no set follows (the drain unmounts what is there)
            self._fault(operation, nonce, "share_mount_failed")
            return "failed"
        if result[0] == SHARES_MOUNTED:
            self._send_up({"t": "shares_mounted", "operationId": operation, "nonce": nonce})
            return "mounted"
        self._fault(operation, nonce, "share_inventory" if result[0] == SHARES_INVENTORY else "share_mount_failed")
        return "failed"

    def _await_result(self, result_tag, length):
        """PID 1's answer to 'C' or 'S'. Host messages that arrive meanwhile are kept, in order, for the loop in serve_conversations."""
        while True:
            try:
                item = self.channel.receive()
            except Refused:
                return None
            if item is None:
                return None
            tag, body = item
            if tag == result_tag and len(body) == length:
                return body
            if tag != TAG_DOWN:
                return None
            self.pending.append(body)

    def _await_conversations_result(self):
        """PID 1's answer to 'C': (status, count)."""
        body = self._await_result(TAG_CONVERSATIONS_RESULT, 2)
        return None if body is None else (body[0], body[1])


# ---------------------------------------------------------------------------------------------------- entry point

def parse_arguments(argv, flags=None):
    """--channel-fds IN,OUT --data NODE:MAJOR:MINOR --environment NODE:MAJOR:MINOR (all produced by PID 1), and for an image that declares `file-channel-v1` the flag
    `--file-channel-v1` (no value): the helper then speaks bootstrap revision 3. `flags`, when given, receives {"file_channel_v1": bool}."""
    values = {}
    items = list(argv)
    file_channel = False
    while items:
        name = items.pop(0)
        if name == "--file-channel-v1" and not file_channel:
            file_channel = True
            continue
        if name not in ("--channel-fds", "--data", "--environment") or not items or name in values:
            raise Refused("arguments")
        values[name] = items.pop(0)
    if flags is not None:
        flags["file_channel_v1"] = file_channel
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


def configure(argv):
    """The arguments PID 1 passed, and the bootstrap vocabulary they select: revision 3 only with `--file-channel-v1`. Raises Refused on a bad command line."""
    flags = {}
    read_fd, write_fd, devices = parse_arguments(argv, flags)
    set_revision_three(flags["file_channel_v1"])
    return read_fd, write_fd, devices


def main(argv):
    try:
        read_fd, write_fd, devices = configure(argv)
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
