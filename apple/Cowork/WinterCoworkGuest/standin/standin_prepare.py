"""Stand-in image only: compose the provider worker's immutable metadata for ONE conversation. Never shipped in the production image.

PID 1 of the stand-in image (init-standin) runs this as root, after the supervisor is ready, with the conversation items it already holds:

    python3 -I -S -B /opt/winter/standin/standin_prepare.py --profile /opt/winter/standin/profile.json --items /run/winter/standin/items.json --sid SID --out /run/winter/standin/SID

It writes ONE file, `metadata.json`, in the exact shape of the runtime-sdk provider worker's `parseMetadata` (keys runtimeUid, script, scriptSha256, version; JSON.stringify
bytes; at most 64 KiB), owned by root, mode 0444, created exclusively. The script is the guided fixture's closed script: two steps, text only, empty marker lists, and the
reserved `winter-standin` selection. It refuses (exit 2, one fixed code, nothing echoed) unless the conversation's selection IS that reserved selection, so a conversation
that names any real provider can never be answered with canned text. Nothing here opens a socket, runs a program or reads anything but its three named inputs.
"""
import argparse, hashlib, json, os, stat, sys

SCOPE_KEYS = ["homeId", "workspaceId", "sessionId", "backendSessionId", "taskId", "incarnationId", "bootId", "leaseEpoch", "grantRevision", "accountRevision", "modelRevision"]
SELECTION_KEYS = {"providerId", "modelKey", "providerModelId", "family", "protocol", "continuationDomain", "capabilities"}
PROFILE_KEYS = {"answers", "profile", "selection", "workerUid"}
WORKER_UID = 65534          # outside the host's 1000..65533 range, so it can never equal a runtime, tool or workspace id
METADATA_MAX = 64 * 1024
INPUT_MAX = 1024 * 1024
TEXT_MAX = 4096
ID_MAX = 256
SAFE_INT = 2**53 - 1


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def refuse(code):
    raise Refused(code)


def canonical(value):
    """The bytes JSON.stringify produces for this value, for the ASCII-only data allowed here (same key order, no spaces, no escapes beyond \\" and \\\\)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def printable(text, limit):
    return isinstance(text, str) and 1 <= len(text) <= limit and all(0x20 <= ord(c) <= 0x7E for c in text)


def no_duplicates(pairs):
    keys = [k for k, _ in pairs]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate key")
    return dict(pairs)


def parse(raw, code):
    try:
        return json.loads(raw.decode("ascii"), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, ValueError, RecursionError):
        refuse(code)


def load_profile(raw):
    profile = parse(raw, "profile")
    if not isinstance(profile, dict) or set(profile) != PROFILE_KEYS or profile["profile"] != "standin-v1" or profile["workerUid"] != WORKER_UID or type(profile["workerUid"]) is not int:
        refuse("profile")
    answers = profile["answers"]
    if not isinstance(answers, list) or len(answers) != 2 or not all(printable(a, TEXT_MAX) for a in answers):
        refuse("profile")
    selection = profile["selection"]
    if not isinstance(selection, dict) or set(selection) != SELECTION_KEYS or selection["providerId"] != "winter-standin" or selection["modelKey"] != "winter-standin/scripted":
        refuse("profile")
    if raw != canonical(profile).encode("ascii") + b"\n":
        refuse("profile")
    return profile


def find_item(items, sid):
    if not isinstance(items, list):
        refuse("items")
    found = [item for item in items if isinstance(item, dict) and item.get("logicalSessionId") == sid]
    if len(found) != 1:
        refuse("item")
    return found[0]


def compose(profile, items, sid):
    """The metadata bytes for the conversation `sid`, or Refused."""
    item = find_item(items, sid)
    uid = item.get("runtimeUid")
    if type(uid) is not int or not 1000 <= uid <= 65533:
        refuse("uid")
    config = item.get("hostQueryRuntime")
    if not isinstance(config, dict) or set(item) & {"hostQueryGuidedRuntime"}:
        refuse("profile_kind")
    provider = config.get("provider")
    if not isinstance(provider, dict) or set(provider) != {"scope", "selection"}:
        refuse("provider")
    if provider["selection"] != profile["selection"] or config.get("model") != profile["selection"]["modelKey"]:
        refuse("selection")
    scope = provider["scope"]
    if not isinstance(scope, dict) or set(scope) != set(SCOPE_KEYS):
        refuse("scope")
    for key in SCOPE_KEYS:
        value = scope[key]
        if key.endswith("Id"):
            if not printable(value, ID_MAX):
                refuse("scope")
        elif type(value) is not int or not 1 <= value <= SAFE_INT:
            refuse("scope")
    script = {"version": 1, "scope": {key: scope[key] for key in SCOPE_KEYS}, "selection": profile["selection"],
              "steps": [{"system": [], "user": [], "absentSystem": [], "absentUser": [], "response": answer} for answer in profile["answers"]]}
    script_text = canonical(script)
    metadata = {"version": 1, "runtimeUid": uid, "script": script, "scriptSha256": hashlib.sha256(script_text.encode("ascii")).hexdigest()}
    raw = canonical(metadata).encode("ascii")
    return raw   # at most about 13 KiB with every field at its bound: always below the worker's 64 KiB limit (tests/test_standin_prepare.py proves the arithmetic)


def write_metadata(directory, raw):
    """`directory/metadata.json`, exclusively created, mode 0444, root-owned when run as root. The directory is created 0755 if absent."""
    os.makedirs(directory, mode=0o755, exist_ok=True)
    # O_CREAT | O_EXCL never follows a link and never reuses a file; the mode is the creation mode (the process umask can only remove bits)
    descriptor = os.open(os.path.join(directory, "metadata.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o444)
    try:
        os.write(descriptor, raw)
        if os.geteuid() == 0:
            os.fchown(descriptor, 0, 0)
    finally:
        os.close(descriptor)


def read_bounded(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)   # NONBLOCK: a FIFO must be refused below, not waited on
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            refuse("input")
        data = os.read(descriptor, INPUT_MAX + 1)
    finally:
        os.close(descriptor)
    if len(data) > INPUT_MAX:
        refuse("input")
    return data


def main(argv):
    parser = argparse.ArgumentParser()
    for name in ("profile", "items", "sid", "out"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args(argv)
    try:
        profile = load_profile(read_bounded(args.profile))
        items = parse(read_bounded(args.items), "items")
        write_metadata(args.out, compose(profile, items, args.sid))
    except Refused as error:
        print("standin-refused " + error.code)
        return 2
    except OSError:
        print("standin-refused io")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
