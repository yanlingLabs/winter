"""Derives vectors/sdk-guided-config.json from the agent SDK's supervisor at the pinned commit, by importing it (non-root, nothing started) and running the
pure shape checks it applies to the trusted config's guided members. Not part of the guest image.

    python3 -I derive_guided_config_fixture.py PATH_TO_linux-supervisor.py [OUT.json]

What it records, for every case: the verdict of the SUPERVISOR's own code, so the guest's writer (PID 1's validator and the bootstrap helper) is held to the file
and not to a reading of it. Two kinds of verdict:
  * "executed": the real function ran. `ToolService._open_reader` (the `reader` block: key set, uid, dependencies, guest path grammar, overlap), `pinned_artifact`
    (the shape of every {path, sha256} pin; its file-system half runs against a stand-in file) and the key checks at the top of `_configure_runtime`.
  * "predicate": one inline condition in `ToolService.__init__` (which needs root to run) is restated here, and the SOURCE LINE it restates is recorded and
    must still be in the supervisor, so a change to it fails the drift check.
"""
import hashlib
import importlib.util
import json
import stat
import sys
import types
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import runtime_blocks as rb  # noqa: E402

RUNTIME_UIDS = {"runtimeUid": 20001, "toolUid": 20002, "workspaceGid": 20003}

SOURCE_LINES = {
    "topLevelKeys": "if set(config[runtime_key])!=({'artifacts','reader'} if self.runtime_profile==GUIDED_PROFILE else {'artifacts'}) or set(config[runtime_key]['artifacts'])!={'launcher','executable','ownerLibrary'}:raise Refusal('runtime_artifacts')",
    "guidanceRequiredAtConstruction": "if 'guidanceDirectory' not in entry[runtime_key]:raise Refusal('guided_guidance_required')",
    "perItemKeysGuided": "if profile==GUIDED_PROFILE:allowed.update(('requiredRuntimeContext','generation','guidanceDirectory'))",
    "perItemKeysBase": "allowed={'storeDirectory','runhomeDirectory','provider','model','timeoutMs'}",
    "perItemKeysToolClasses": "if profile in ('host-query-v1',GUIDED_PROFILE):allowed.add('toolClasses')",
    "perItemRequired": "or not {'storeDirectory','runhomeDirectory','provider','model'}<=set(value):raise Refusal('runtime_config')",
    "guidanceRequiredPerItem": "if profile==GUIDED_PROFILE and 'guidanceDirectory' not in value:raise Refusal('guided_guidance_required')",
    "readerKeys": "set(value)!={'artifacts','dependencies','uid'}",
    "readerUid": "if type(uid) is not int or not 1000<=uid<=65535 or uid in reserved:raise Refusal('guided_reader_identity')",
    "readerDependencyKeys": "set(dependency)!={'path','sha256','guestPath'}",
    "runtimeKeys": "RUNTIME_KEYS=(('fresh','freshRuntime'),('host-query-v1','hostQueryRuntime'),(GUIDED_PROFILE,'hostQueryGuidedRuntime'))",
}


def load_supervisor(path):
    spec = importlib.util.spec_from_file_location("sdk_supervisor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StandInFiles:
    """Lets the real `pinned_artifact` run its pin-shape checks and its identity checks on a root-owned 0555 file whose digest is whatever the pin says."""

    def __init__(self, service):
        self.service = service
        self.pin = None
        outer = self

        class Digest:
            def update(self, data):
                pass

            def hexdigest(self):
                return outer.pin

        self.hashlib = types.SimpleNamespace(sha256=lambda: Digest())
        self.stat = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o555, st_uid=0, st_nlink=1, st_size=10)

    def __enter__(self):
        service = self.service
        real = service.pinned_artifact

        def wrapped(value):
            self.pin = value.get("sha256") if isinstance(value, dict) else None
            return real(value)

        self.patches = [mock.patch.object(service, "hashlib", self.hashlib), mock.patch.object(service.os, "open", lambda *a, **k: 900), mock.patch.object(service.os, "fstat", lambda fd: self.stat),
                        mock.patch.object(service.os, "read", lambda fd, n: b""), mock.patch.object(service.os, "lseek", lambda *a: 0), mock.patch.object(service.os, "close", lambda fd: None),
                        mock.patch.object(service, "pinned_artifact", wrapped)]
        for patch in self.patches:
            patch.start()
        return self

    def __exit__(self, *exc):
        for patch in reversed(self.patches):
            patch.stop()


def block_verdict(service, profile, block):
    """The supervisor's verdict on the object under hostQueryRuntime (profile 1) / hostQueryGuidedRuntime (profile 2): ('accepted'|reason, how)."""
    guided = profile == 2
    # predicate (restates SOURCE_LINES["topLevelKeys"]; __init__ itself needs root)
    if not isinstance(block, dict) or set(block) != ({"artifacts", "reader"} if guided else {"artifacts"}) or not isinstance(block["artifacts"], dict) or set(block["artifacts"]) != {"launcher", "executable", "ownerLibrary"}:
        return "runtime_artifacts", "predicate"
    service = SERVICE
    with StandInFiles(service):
        try:
            for value in block["artifacts"].values():
                service.pinned_artifact(value)
            if guided:
                stub = types.SimpleNamespace(owned=[], _reader_views_root=lambda: None)
                service.ToolService._open_reader(stub, block["reader"], [dict(RUNTIME_UIDS)])
        except service.Refusal as error:
            return str(error), "executed"
        except (TypeError, KeyError, AttributeError) as error:   # a shape the supervisor's own code trips over: it refuses the config
            return "malformed:" + type(error).__name__, "executed"
    return "accepted", "executed"


def item_verdict(service, profile, keys):
    """The key checks at the top of `_configure_runtime` (executed): 'runtime_config', 'guided_guidance_required', or 'keys_ok' when it gets past them."""
    stub = types.SimpleNamespace(runtime_artifacts={"launcher": 1})
    value = {key: ("x" if key != "provider" else {}) for key in keys}
    try:
        service.ToolService._configure_runtime(stub, {}, value, profile=profile)
    except service.Refusal as error:
        if str(error) in ("runtime_config", "guided_guidance_required", "runtime_profile_conflict"):
            return str(error)
    except Exception:   # past the key checks the real code needs a real item; the verdict is only about the keys
        pass
    return "keys_ok"


BASE_KEYS = ["storeDirectory", "runhomeDirectory", "provider", "model", "timeoutMs"]
ITEM_CASES = {
    "guided: every key": (2, BASE_KEYS + ["toolClasses", "requiredRuntimeContext", "generation", "guidanceDirectory"]),
    "guided: no guidanceDirectory": (2, BASE_KEYS + ["toolClasses", "requiredRuntimeContext", "generation"]),
    "guided: an unknown key": (2, BASE_KEYS + ["toolClasses", "requiredRuntimeContext", "generation", "guidanceDirectory", "extra"]),
    "guided: no storeDirectory": (2, [k for k in BASE_KEYS if k != "storeDirectory"] + ["toolClasses", "requiredRuntimeContext", "generation", "guidanceDirectory"]),
    "host-query: its keys": (1, BASE_KEYS + ["toolClasses"]),
    "host-query: with guidanceDirectory": (1, BASE_KEYS + ["toolClasses", "guidanceDirectory"]),
    "host-query: with generation": (1, BASE_KEYS + ["toolClasses", "generation"]),
    "host-query: with requiredRuntimeContext": (1, BASE_KEYS + ["toolClasses", "requiredRuntimeContext"]),
}
PROFILE_NAMES = {1: "host-query-v1", 2: "host-query-guided-v1"}


def cases():
    out = []
    v1, guided = rb.v1_block(), rb.guided_block()
    out.append(("host-query: the image's object", 1, v1))
    out.append(("host-query: with a reader", 1, guided))
    out.append(("host-query: with an empty reader", 1, rb.mutated(v1, lambda v: v.__setitem__("reader", {}))))
    out.append(("host-query: no artifacts", 1, {}))
    out.append(("guided: the image's object", 2, guided))
    out.append(("guided: the host-query object", 2, v1))
    for label, block in rb.guided_refused_cases().items():
        out.append(("guided: " + label, 2, block))
    for label, block in rb.guided_accepted_cases().items():
        out.append(("guided: " + label, 2, block))
    # the reader uid against the host's ids: the supervisor refuses a collision, so the guest keeps it out of the host's range
    for uid in (20001, 20002, 20003, 20004, 1000, 65533, 65534, 65535):
        out.append(("guided: reader uid %d" % uid, 2, rb.mutated(guided, rb.put(("reader",), "uid", uid))))
    return out


def derive(supervisor_path, commit):
    global SERVICE
    SERVICE = load_supervisor(supervisor_path)
    source = Path(supervisor_path).read_text()
    for name, line in SOURCE_LINES.items():
        if line not in source:
            raise SystemExit("supervisor no longer contains the line pinned as " + name)
    result = {
        "note": "Derived from the agent SDK supervisor at the pinned commit by tests/derive_guided_config_fixture.py (the real functions run non-root; see its docstring). "
                "The guest's writer must agree: PID 1's validator never accepts what the supervisor refuses, and refuses what it accepts only where listed in test_guided_config.py.",
        "sdkCommit": commit,
        "supervisorPath": "packages/runtime/src/guest/linux-supervisor.py",
        "supervisorSha256": hashlib.sha256(Path(supervisor_path).read_bytes()).hexdigest(),
        "sourceLines": SOURCE_LINES,
        "guidanceDirectory": rb.GUIDANCE_DIRECTORY,
        "readerDependencyLimit": SERVICE.READER_DEPENDENCY_LIMIT,
        "readerViewsRoot": SERVICE.READER_VIEWS_ROOT,
        "items": [{"label": label, "profile": PROFILE_NAMES[profile], "keys": sorted(keys), "supervisor": item_verdict(SERVICE, PROFILE_NAMES[profile], keys)} for label, (profile, keys) in ITEM_CASES.items()],
        "blocks": [],
    }
    for label, profile, block in cases():
        verdict, how = block_verdict(SERVICE, profile, block)
        result["blocks"].append({"label": label, "profile": profile, "block": rb.text(block), "supervisor": verdict, "how": how})
    return result


if __name__ == "__main__":
    supervisor, commit = sys.argv[1], sys.argv[2]
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else HERE.parent / "vectors/sdk-guided-config.json"
    out.write_text(json.dumps(derive(supervisor, commit), indent=1, sort_keys=True) + "\n")
    print("wrote", out)
