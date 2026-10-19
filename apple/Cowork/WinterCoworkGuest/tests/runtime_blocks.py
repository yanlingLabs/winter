"""The runtime object the image carries for the supervisor's `hostQueryRuntime` / `hostQueryGuidedRuntime` key, as canonical compact JSON, for tests.

The digests are placeholders; the paths are the ones image.py gives the host-query runtime. The reader entries are what a guided image would carry (none is
built or shipped in the first session: decision D10). 65534 is the reader uid: inside the supervisor's 1000 to 65535, outside the 1000 to 65533 the contract
lets the host assign, so no runtime uid, tool uid or workspace gid can collide with it.
"""
import copy
import json

READER_UID = 65534
GUIDANCE_DIRECTORY = "/run/winter/shared-instructions"


def pin(path, digit):
    return {"path": path, "sha256": digit * 64}


def v1_block():
    return {"artifacts": {"launcher": pin("/opt/winter/helpers/linux-runtime-compartment", "a"), "ownerLibrary": pin("/opt/winter/helpers/linux-session-owner.so", "b"),
                          "executable": pin("/opt/winter/runtime/winter-host-query", "c")}}


def guided_block(dependencies=None, uid=READER_UID):
    block = v1_block()
    block["reader"] = {"artifacts": {"launcher": pin("/opt/winter/helpers/linux-instruction-reader-compartment", "e"), "executable": pin("/opt/winter/reader/instruction-reader", "d")},
                       "dependencies": [] if dependencies is None else dependencies, "uid": uid}
    return block


def dependency(guest, digit="f", path=None):
    return {"guestPath": guest, "path": path or "/opt/winter/reader/deps" + guest, "sha256": digit * 64}


def text(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def mutated(block, edit):
    value = copy.deepcopy(block)
    edit(value)
    return value


def rename(path, old, new):
    def edit(value):
        for step in path:
            value = value[step]
        value[new] = value.pop(old)
    return edit


def drop(*path):
    def edit(value):
        for key in path[:-1]:
            value = value[key]
        del value[path[-1]]
    return edit


def put(path, key, new):
    def edit(value):
        for step in path:
            value = value[step]
        value[key] = new
    return edit


def guided_refused_cases():
    """Guided objects that differ from the valid one in one way each and that the supervisor (and PID 1) must refuse. {label: object}."""
    two = [dependency("/lib/a"), dependency("/lib/b")]
    cases = {
        "no reader": drop("reader"), "reader without dependencies (absent, not empty)": drop("reader", "dependencies"), "reader without uid": drop("reader", "uid"),
        "reader without artifacts": drop("reader", "artifacts"), "reader without launcher": drop("reader", "artifacts", "launcher"), "reader without executable": drop("reader", "artifacts", "executable"),
        "reader with an owner library": put(("reader", "artifacts"), "ownerLibrary", pin("/x/y", "a")), "reader with an extra key": put(("reader",), "extra", 1),
        "an extra top-level key": put((), "extra", {}), "no artifacts": drop("artifacts"), "no owner library": drop("artifacts", "ownerLibrary"),
        "no launcher": drop("artifacts", "launcher"), "no executable": drop("artifacts", "executable"), "a provider worker among the artifacts": put(("artifacts",), "providerWorker", pin("/opt/winter/runtime/p", "a")),
        "a pin without its path": drop("artifacts", "launcher", "path"), "a pin without its digest": drop("artifacts", "launcher", "sha256"), "a pin with an extra member": put(("artifacts", "launcher"), "mode", "0555"),
        "dependencies null": put(("reader",), "dependencies", None), "dependencies an object": put(("reader",), "dependencies", {}), "dependencies a string": put(("reader",), "dependencies", ""),
        "a dependency that is not an object": put(("reader",), "dependencies", ["/lib/a"]), "a dependency without guestPath": put(("reader",), "dependencies", [{"path": "/x/y", "sha256": "f" * 64}]),
        "a dependency with an extra member": put(("reader",), "dependencies", [dict(dependency("/lib/a"), extra=1)]),
        "uid in the host range": put(("reader",), "uid", 65533), "uid at the bottom of the supervisor's range": put(("reader",), "uid", 1000), "uid above 65535": put(("reader",), "uid", 65536),
        "uid zero": put(("reader",), "uid", 0), "uid a string": put(("reader",), "uid", "65534"), "uid negative": put(("reader",), "uid", -1), "uid a float": put(("reader",), "uid", 65534.0), "uid null": put(("reader",), "uid", None),
        "uid true": put(("reader",), "uid", True),
        "relative artifact path": put(("artifacts", "launcher"), "path", "opt/x"), "artifact path with ..": put(("artifacts", "launcher"), "path", "/opt/../x"),
        "artifact path with an empty component": put(("artifacts", "launcher"), "path", "/opt//x"), "artifact path with a trailing slash": put(("artifacts", "launcher"), "path", "/opt/x/"),
        "artifact path with a dot": put(("artifacts", "launcher"), "path", "/opt/./x"), "artifact path with a space": put(("artifacts", "launcher"), "path", "/opt/a b"),
        "artifact path just a slash": put(("artifacts", "launcher"), "path", "/"), "artifact path too long": put(("artifacts", "launcher"), "path", "/" + "a" * 1024),
        "upper case digest": put(("artifacts", "launcher"), "sha256", "A" * 64), "short digest": put(("artifacts", "launcher"), "sha256", "a" * 63), "long digest": put(("artifacts", "launcher"), "sha256", "a" * 65),
        "non hex digest": put(("artifacts", "launcher"), "sha256", "g" * 64), "digest a number": put(("artifacts", "launcher"), "sha256", 7),
        "guest path outside the library directories": put(("reader",), "dependencies", [dependency("/etc/passwd")]),
        "guest path /lib itself": put(("reader",), "dependencies", [dependency("/lib")]), "guest path /lib/": put(("reader",), "dependencies", [dependency("/lib/")]),
        "guest path with ..": put(("reader",), "dependencies", [dependency("/lib/../etc/x")]), "guest path with an empty component": put(("reader",), "dependencies", [dependency("/lib//x")]),
        "guest path with a dot component": put(("reader",), "dependencies", [dependency("/lib/./x")]), "guest path with a trailing slash": put(("reader",), "dependencies", [dependency("/lib/a/")]),
        "guest path /libx/": put(("reader",), "dependencies", [dependency("/libx/a")]), "guest path /usr/libexec": put(("reader",), "dependencies", [dependency("/usr/libexec/a")]),
        "guest path /lib64x": put(("reader",), "dependencies", [dependency("/lib64x/a")]),
        "duplicate guest paths": put(("reader",), "dependencies", [dependency("/lib/a"), dependency("/lib/a", path="/other/path")]),
        "a guest path inside an earlier one": put(("reader",), "dependencies", [dependency("/lib/a"), dependency("/lib/a/b")]),
        "a guest path containing an earlier one": put(("reader",), "dependencies", [dependency("/lib/a/b"), dependency("/lib/a")]),
        "33 dependencies": put(("reader",), "dependencies", [dependency("/lib/d%02d" % k) for k in range(33)]),
        "guest path too long": put(("reader",), "dependencies", [dependency("/lib/" + "a" * 1020, path="/x/y")]),
    }
    cases.update({
        "top-level artifacts renamed": rename((), "artifacts", "artifact"), "reader renamed": rename((), "reader", "readers"), "reader artifacts renamed": rename(("reader",), "artifacts", "pins"),
        "dependencies renamed": rename(("reader",), "dependencies", "dependency"), "uid renamed": rename(("reader",), "uid", "id"), "launcher renamed": rename(("artifacts",), "launcher", "loader"),
        "owner library renamed": rename(("artifacts",), "ownerLibrary", "ownerlibrary"), "reader executable renamed": rename(("reader", "artifacts"), "executable", "exe"),
        "pin path renamed": rename(("artifacts", "launcher"), "path", "file"), "pin digest renamed": rename(("artifacts", "launcher"), "sha256", "sha"),
        "dependency path with ..": put(("reader",), "dependencies", [dependency("/lib/a", path="/opt/../x")]),
        "dependency path with an empty component": put(("reader",), "dependencies", [dependency("/lib/a", path="/opt//x")]),
        "dependency path with a trailing slash": put(("reader",), "dependencies", [dependency("/lib/a", path="/opt/x/")]),
        "dependency path relative": put(("reader",), "dependencies", [dependency("/lib/a", path="opt/x")]),
        "dependency path too long": put(("reader",), "dependencies", [dependency("/lib/a", path="/" + "a" * 1024)]),
        "dependency guestPath renamed": lambda value: value["reader"]["dependencies"][0].__setitem__("guest", value["reader"]["dependencies"][0].pop("guestPath")),
    })
    return {label: mutated(guided_block(two), edit) for label, edit in cases.items()}


def guided_accepted_cases():
    """Neighbours of the refused spellings that are valid: a guard cannot be satisfied by refusing everything. {label: object}."""
    two = [dependency("/lib/a"), dependency("/lib/b")]
    accepted = {"guest path /usr/lib/x": put(("reader",), "dependencies", [dependency("/usr/lib/x")]), "guest path /lib64/x": put(("reader",), "dependencies", [dependency("/lib64/x")]),
                        "siblings sharing a prefix": put(("reader",), "dependencies", [dependency("/lib/ab"), dependency("/lib/a")]),
                        "uid 65535": put(("reader",), "uid", 65535), "uid 65534": put(("reader",), "uid", 65534), "path of 1024 bytes": put(("artifacts", "launcher"), "path", "/" + "a" * 1023),
                        "guest path of 1024 bytes": put(("reader",), "dependencies", [dependency("/lib/" + "a" * 1019, path="/x/y")])}
    return {label: mutated(guided_block(two), edit) for label, edit in accepted.items()}
