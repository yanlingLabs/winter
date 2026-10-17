"""Offline build, test and static inspection of the production Cowork worker (N2 slice S3).

Run as `python3 -I build.py <command> --out <dir> [...]`. It never runs the worker, never applies the sandbox, never starts a
VM and never touches Hypervisor.framework. It only compiles, links, runs the VM-free unit tests, ad-hoc signs the result inside
--out and inspects it statically.

  test           generate the golden-vector header from the pinned S1 fixtures, build and run every strict-C unit test
                 (with --libkrun-include also the ABI tests and the exit-hook signature compile checks)
  asan           the same tests under AddressSanitizer and UndefinedBehaviorSanitizer (the 16-slot builds included)
  verify-header  derive libkrun.h from S4's committed patch queue and require pins.json's header hash
  worker         build winter-cowork-worker against S4's stripped production archive
  inspect        ad-hoc sign the built worker inside --out, then codesign -dvv --entitlements -, otool -L, nm, strings
  guards         the Python source guards (order, forbidden APIs, anti-wiring, entitlements, fixtures)
  all            test, asan, guards, worker, inspect

--out must be an absolute directory OUTSIDE the repository. Nothing is downloaded. The environment is cleaned for every child.
"""
import argparse
import getpass
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
SOURCES = ROOT / "Sources" / "WorkerNative"
TESTS = ROOT / "Tests"
PINS = json.loads((ROOT / "pins.json").read_text())

CLANG = "/usr/bin/clang"
IDENTIFIER = "com.winter.cowork.worker"
STRICT = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Wpedantic", "-Wshadow", "-Wformat=2", "-Wstrict-prototypes", "-Wmissing-prototypes",
          "-Wundef", "-Wcast-qual", "-Werror", "-Wno-deprecated-declarations"]
SANITIZE = ["-O1", "-g", "-fno-omit-frame-pointer", "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined"]
SOURCE_LIST = ["Envelope", "Mux", "Rights", "OwnedStop", "ConsoleRing", "AdmittedVolumes", "RuntimeImage", "Sandbox", "Relay", "WorkspaceWorker"]

# The exact list of unit tests. Nothing else is ever executed by this script. Each is VM-free, sandbox-free and HVF-free.
CODEC = ["Envelope", "Rights"]
RELAY = ["Relay", "OwnedStop", "Mux", "Envelope", "Rights"]
TESTS_TO_RUN = [
    ("test_envelope", CODEC, []),
    ("test_mux", ["Mux"] + CODEC, []),
    ("test_stop", ["OwnedStop"], []),
    ("test_ring", ["ConsoleRing"], []),
    ("test_rights", ["Rights"], []),
    ("test_runtime_image", ["RuntimeImage"], []),
    ("test_intake", ["AdmittedVolumes"] + CODEC, []),
    ("test_handoff_256", ["AdmittedVolumes", "Mux"] + CODEC, ["-DCW_FD_CAPACITY=256"]),
    ("test_handoff_16", ["AdmittedVolumes", "Mux"] + CODEC, ["-DCW_FD_CAPACITY=16"]),
    ("test_relay", RELAY, []),
    ("test_relay_16", RELAY, ["-DCW_FD_CAPACITY=16"]),
    ("test_sandbox_profile", ["Sandbox"], []),
]
# These include the library's header (CoworkAbi.h) but link no archive; they need --libkrun-include.
ABI_TESTS = [("test_abi", RELAY, [])]
TEST_SOURCE = {"test_handoff_256": "test_handoff", "test_handoff_16": "test_handoff", "test_relay_16": "test_relay"}
# Compiled with -fsyntax-only: the first must succeed, the others must be refused because the exit hook's signature is not the library's.
HOOK_OK = "hook_ok.c"
HOOK_REFUSED = ["hook_bad_reason_type.c", "hook_bad_arity.c", "hook_bad_return.c"]

# The only libkrun entry points the worker may reference: the generic setters and the canonical _v1 set (get_pin_counters_v1 exists in the library;
# the worker does not call it).
ALLOWED_KRUN = {
    "krun_init_log", "krun_create_ctx", "krun_set_vm_config", "krun_disable_implicit_vsock", "krun_set_env", "krun_disable_implicit_console",
    "krun_add_serial_console_default", "krun_set_kernel", "krun_start_enter",
    "krun_cowork_enable_profile_v1", "krun_cowork_create_runtime_port_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_validate_profile_v1",
    "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1",
}


def die(message: str) -> None:
    print(f"build.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Context:
    def __init__(self, out: Path):
        self.out = out
        self.env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "TZ": "UTC", "SOURCE_DATE_EPOCH": "0", "ZERO_AR_DATE": "1", "TMPDIR": str(out / "tmp")}
        self.prefix = [f"-ffile-prefix-map={REPO}=.", f"-fdebug-prefix-map={REPO}=.", f"-ffile-prefix-map={out}=/out", f"-fdebug-prefix-map={out}=/out",
                       f"-ffile-prefix-map={Path.home()}=~"]

    def run(self, command, check=True, timeout=300, cwd=None, capture=True, extra_env=None):
        env = dict(self.env)
        env.update(extra_env or {})
        result = subprocess.run([str(part) for part in command], env=env, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=capture, text=True, timeout=timeout)
        if check and result.returncode != 0:
            sys.stderr.write(f"$ {' '.join(str(p) for p in command)}\n{result.stdout}{result.stderr}")
            die(f"command failed with {result.returncode}")
        return result


def prepare_out(raw: str) -> Context:
    out = Path(raw)
    if not out.is_absolute():
        die("--out must be an absolute path")
    out = out.resolve()
    if out == REPO or REPO in out.parents:
        die("--out must be outside the repository")
    (out / "tmp").mkdir(parents=True, exist_ok=True)
    return Context(out)


def normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text)


# ------------------------------------------------------------------------------------------------------------------ tests

def generate_vectors(ctx: Context) -> Path:
    gen = ctx.out / "gen"
    gen.mkdir(exist_ok=True)
    header = gen / "vectors.h"
    ctx.run([sys.executable, "-I", TESTS / "gen_vectors.py", TESTS / "fixtures", header])
    return header


def run_tests(ctx: Context, only, include, sanitize: bool) -> None:
    header = generate_vectors(ctx)
    bin_dir = ctx.out / ("tests-sanitized" if sanitize else "tests")
    bin_dir.mkdir(exist_ok=True)
    everything = list(TESTS_TO_RUN) + (list(ABI_TESTS) if include is not None else [])
    selected = [t for t in everything if not only or t[0] in only]
    if only and len(selected) != len(set(only)):
        die(f"unknown test name in --only (the ABI tests need --libkrun-include): {sorted(set(only) - {t[0] for t in selected})}")
    flags = [f for f in STRICT if f != "-O2"] + SANITIZE if sanitize else STRICT
    env = {"ASAN_OPTIONS": "detect_leaks=0:abort_on_error=0", "UBSAN_OPTIONS": "print_stacktrace=1:halt_on_error=1"} if sanitize else {}
    for name, sources, extra in selected:
        source = TESTS / f"{TEST_SOURCE.get(name, name)}.c"
        binary = bin_dir / name
        library = ["-isystem", include] if include is not None else []
        ctx.run([CLANG, *flags, *ctx.prefix, *extra, "-I", SOURCES, "-I", TESTS, "-I", header.parent, *library, source, *[SOURCES / f"{s}.c" for s in sources], "-o", binary], timeout=900)
        result = ctx.run([binary], check=False, timeout=300, extra_env=env)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            die(f"{name} failed with exit code {result.returncode}" + (" (sanitizer)" if sanitize else ""))
    label = "under AddressSanitizer + UndefinedBehaviorSanitizer " if sanitize else ""
    print(f"unit tests {label}: {len(selected)} binaries passed (no VM, no sandbox, no HVF)")


def hook_signature_checks(ctx: Context, include: Path) -> None:
    """The exit hook must have EXACTLY the library's type; a hook with another signature must not compile (C has no link-time type)."""
    flags = [f for f in STRICT if f != "-O2"] + ["-fsyntax-only", "-I", SOURCES, "-isystem", include]
    good = ctx.run([CLANG, *flags, TESTS / "abi" / HOOK_OK], check=False)
    if good.returncode != 0:
        sys.stderr.write(good.stderr)
        die(f"{HOOK_OK}: a hook with the library's signature must compile")
    for name in HOOK_REFUSED:
        bad = ctx.run([CLANG, *flags, TESTS / "abi" / name], check=False)
        if bad.returncode == 0 or "exit hook's signature differs" not in bad.stderr:
            die(f"{name}: a hook with another signature must be refused by CW_ASSERT_EXIT_HOOK_SIGNATURE")
    print(f"exit hook signature: the library's type compiles, {len(HOOK_REFUSED)} other signatures are refused")


def cmd_test(ctx: Context, only, include: Path = None, sanitize: bool = False) -> None:
    run_tests(ctx, only, include, sanitize)
    if include is not None and not sanitize and not only:
        hook_signature_checks(ctx, include)


# ----------------------------------------------------------------------------------------------------------- libkrun inputs

def check_libkrun_inputs(include: Path, archive: Path) -> None:
    if not (include / "libkrun.h").is_file() or not archive.is_file():
        die("--libkrun-include and --libkrun-archive must exist")
    for label, path, key in (("archive", archive, "archiveSha256"), ("header", include / "libkrun.h", "headerSha256")):
        actual = sha256(path)
        if actual != PINS["libkrun"][key]:
            die(f"libkrun {label} sha256 {actual} does not match the pin {PINS['libkrun'][key]} (pins.json)")
    header = normalise((include / "libkrun.h").read_text())
    for declaration in PINS["abi"]["headerDeclarations"]:
        if normalise(declaration) not in header:
            die(f"libkrun.h no longer declares: {declaration}")


def defined_symbols(ctx: Context, path: Path) -> set:
    result = ctx.run(["/usr/bin/nm", "-g", path], check=False)
    return {line.split()[-1].lstrip("_") for line in result.stdout.splitlines() if re.search(r"\s[TtSsDdBbCc]\s", line)}


def undefined_krun(ctx: Context, objects) -> set:
    found = set()
    for obj in objects:
        result = ctx.run(["/usr/bin/nm", "-u", obj], check=False)
        found |= {line.strip().lstrip("_") for line in result.stdout.splitlines() if line.strip().lstrip("_").startswith("krun_")}
    return found


def cmd_verify_header(ctx: Context, pristine: Path, patches: Path, include: Path) -> None:
    """S4's committed evidence records the archive hash but no header hash. Derive the header: the pristine upstream header plus the
    include/libkrun.h hunks of S4's committed patch queue, each patch file checked against the hash S4 committed."""
    pins = PINS["libkrun"]
    if sha256(pristine) != pins["pristineHeaderSha256"]:
        die("the pristine header is not the pinned upstream one")
    git = "/usr/bin/git"
    with tempfile.TemporaryDirectory(dir=ctx.out / "tmp") as scratch:
        work = Path(scratch)
        (work / "include").mkdir()
        shutil.copy2(pristine, work / "include" / "libkrun.h")
        ctx.run([git, "init", "-q", "."], cwd=work)
        for name in sorted(pins["patchSha256"]):
            patch = patches / name
            if not patch.is_file() or sha256(patch) != pins["patchSha256"][name]:
                die(f"patch {name} is missing or does not match the hash S4 committed")
            if b"include/libkrun.h" in patch.read_bytes():
                ctx.run([git, "apply", "--include=include/libkrun.h", patch], cwd=work)
        derived = sha256(work / "include" / "libkrun.h")
    if derived != pins["headerSha256"]:
        die(f"the header derived from S4's patch queue is {derived}, not the pinned {pins['headerSha256']}")
    if include is not None and sha256(include / "libkrun.h") != derived:
        die("the header given with --libkrun-include is not the derived one")
    print(f"header derived from {len(pins['patchSha256'])} committed patches on the pristine v1.19.6 header: {derived}")


# ----------------------------------------------------------------------------------------------------------------- worker

def compile_worker_objects(ctx: Context, include: Path, objdir: Path):
    objdir.mkdir(parents=True, exist_ok=True)
    objects = []
    for name in SOURCE_LIST:
        obj = objdir / f"{name}.o"
        # libkrun.h is a system header here: it still contains a K&R declaration (`krun_create_ctx()`) that -Wstrict-prototypes rejects.
        ctx.run([CLANG, *STRICT, *ctx.prefix, "-I", SOURCES, "-isystem", include, "-c", SOURCES / f"{name}.c", "-o", obj])
        objects.append(obj)
    return objects


def cmd_worker(ctx: Context, include: Path, archive: Path) -> None:
    check_libkrun_inputs(include, archive)
    exported = defined_symbols(ctx, archive)
    missing = [name for name in PINS["requiredExports"] if name not in exported]
    if missing:
        die(f"the archive does not export {missing}: the worker would not link, and without them it must not start a VM")
    out = ctx.out / "worker"
    out.mkdir(exist_ok=True)
    objects = compile_worker_objects(ctx, include, out / "obj")
    referenced = undefined_krun(ctx, objects)
    if referenced - ALLOWED_KRUN:
        die(f"the worker references libkrun entry points outside the allowed list: {sorted(referenced - ALLOWED_KRUN)}")
    unstripped = out / "winter-cowork-worker.unstripped"
    # -dead_strip drops every libkrun entry point the worker does not reference (krun_add_vsock, krun_add_virtiofs, krun_set_gpu_options,
    # krun_get_shutdown_eventfd, krun_cowork_get_pin_counters_v1 ...): they are then not exported by the binary. The device CODE behind
    # krun_start_enter is still in it, unreachable behind S4's production gate; "not exported" is all this proves.
    ctx.run([CLANG, "-O2", *ctx.prefix, "-Wl,-dead_strip", *objects, archive, *PINS["linkLibraries"], "-o", unstripped])
    stripped = out / "winter-cowork-worker"
    ctx.run(["/usr/bin/strip", "-x", "-o", stripped, unstripped])
    report = {
        "archiveSha256": sha256(archive), "headerSha256": sha256(include / "libkrun.h"), "libkrunReferences": sorted(referenced),
        "workerSha256": sha256(stripped), "vmStarted": False, "workerExecuted": False,
        "contractDifferences": PINS["abi"]["differences"],
    }
    (out / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "contractDifferences"}))
    print(f"{len(report['contractDifferences'])} places where the header the worker links differs from S1's contract text (pins.json abi.differences)")


# --------------------------------------------------------------------------------------------------------------- inspect

FORBIDDEN_SYMBOL_PATTERNS = [r"fixture", r"shutdown_eventfd", r"krun_add_vsock", r"krun_add_virtiofs", r"krun_set_port_map", r"krun_set_gpu_options", r"krun_add_display",
                             r"krun_add_input_device", r"krun_create_cowork_", r"krun_enable_cowork_", r"krun_set_cowork_", r"krun_cowork_get_pin_counters"]
# What the linked binary imports but the worker never calls: the libSystem surface the static libkrun and the Rust runtime bring along. Listed, not hidden.
WATCHED_IMPORTS = ["socket", "connect", "bind", "listen", "accept", "fork", "vfork", "execve", "execv", "posix_spawn", "dlopen", "dlsym", "setuid", "setgid", "seteuid", "setreuid",
                   "system", "popen", "getaddrinfo", "gethostbyname", "sendto", "recvfrom", "ptrace", "kill"]


def builder_tokens(ctx: Context):
    user = getpass.getuser()
    tokens = [str(REPO), str(ctx.out), str(Path.home()), "/Us" + "ers/", "/pri" + "vate/", "/var/fol" + "ders/", "/Vol" + "umes/", "/ho" + "me/", "/Applications/Xc" + "ode"]
    if user and user not in ("root", "nobody"):
        tokens.append(user)
    return tokens


def inspect_binary(ctx: Context, binary: Path, label: str) -> dict:
    signed = binary.with_name(binary.name + ".signed")
    shutil.copy2(binary, signed)
    # Ad-hoc only, on a copy inside --out, for static inspection. No identity, no keychain, no notarization.
    ctx.run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", IDENTIFIER, "--entitlements", ROOT / "worker.entitlements", signed])
    ctx.run(["/usr/bin/codesign", "--verify", "--strict", signed])
    described = ctx.run(["/usr/bin/codesign", "-dvv", "--entitlements", "-", signed])
    text = described.stdout + described.stderr
    if f"Identifier={IDENTIFIER}" not in text:
        die(f"{label}: codesign identifier is not {IDENTIFIER}")
    if not re.search(r"flags=0x[0-9a-f]+\(adhoc,runtime\)", text):
        die(f"{label}: expected an ad-hoc signature with the hardened runtime flag")
    raw = subprocess.run(["/usr/bin/codesign", "-d", "--entitlements", "-", "--xml", str(signed)], env=ctx.env, capture_output=True, stdin=subprocess.DEVNULL)
    blob = raw.stdout or raw.stderr
    start = blob.find(b"<?xml")
    if start < 0:
        die(f"{label}: could not read the entitlements as XML")
    entitlements = plistlib.loads(blob[start:])
    if entitlements != {"com.apple.security.hypervisor": True}:
        die(f"{label}: entitlements are not exactly com.apple.security.hypervisor: {entitlements}")
    libs = [line.split()[0] for line in ctx.run(["/usr/bin/otool", "-L", signed]).stdout.splitlines()[1:] if line.strip()]
    for lib in libs:
        if lib not in PINS["allowedDylibs"]:
            die(f"{label}: links a dylib outside the platform allow-list: {lib}")
    strings = ctx.run(["/usr/bin/strings", "-a", signed]).stdout
    leaks = [token for token in builder_tokens(ctx) if token and token in strings]
    if leaks:
        die(f"{label}: the binary contains builder paths or names: {[('<redacted>' if t == getpass.getuser() else t) for t in leaks]}")
    return {"label": label, "identifier": IDENTIFIER, "entitlements": entitlements, "dylibs": libs, "builderStringsFound": 0, "stringsScanned": len(strings.splitlines())}


def cmd_inspect(ctx: Context) -> None:
    results = []
    unstripped = ctx.out / "worker" / "winter-cowork-worker.unstripped"
    if unstripped.exists():
        symbols = ctx.run(["/usr/bin/nm", "-g", unstripped]).stdout
        bad = [line for line in symbols.splitlines() if any(re.search(p, line) for p in FORBIDDEN_SYMBOL_PATTERNS) and re.search(r"\s[TtSsDdBbCc]\s", line)]
        if bad:
            die(f"the linked binary defines entry points of devices the profile never enables: {bad}")
        krun_defined = sorted(line.split()[-1].lstrip("_") for line in symbols.splitlines() if re.search(r"\s[Tt]\s_krun_", line))
        print(f"{len(krun_defined)} libkrun entry points are exported by the binary, all referenced by the worker: {krun_defined}")
        if set(krun_defined) - ALLOWED_KRUN:
            die(f"unexpected libkrun entry points in the binary: {sorted(set(krun_defined) - ALLOWED_KRUN)}")
        undefined = [line.strip().lstrip("_") for line in ctx.run(["/usr/bin/nm", "-u", unstripped]).stdout.splitlines() if line.strip()]
        watched = sorted(name for name in undefined if name in WATCHED_IMPORTS)
        (ctx.out / "worker" / "imports.txt").write_text("\n".join(sorted(undefined)) + "\n")
        print(f"{len(undefined)} libSystem imports; imported by the archive's code, not called by the worker's own source except fork and exec in the denial probe ({len(watched)}): {watched}")
        (ctx.out / "worker" / "watched-imports.json").write_text(json.dumps({"imported": watched, "total": len(undefined)}, indent=1) + "\n")
    path = ctx.out / "worker" / "winter-cowork-worker"
    if path.exists():
        results.append(inspect_binary(ctx, path, "worker (S4 archive)"))
    if not results:
        die("nothing to inspect: build the worker first")
    (ctx.out / "inspect-report.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


def cmd_guards(ctx: Context) -> None:
    ctx.run([sys.executable, "-I", TESTS / "test_guards.py", REPO], capture=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["test", "asan", "verify-header", "worker", "inspect", "guards", "all"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", action="append", default=[], help="with `test` or `asan`: run only the named test binaries (used by the mutation driver)")
    parser.add_argument("--libkrun-include")
    parser.add_argument("--libkrun-archive")
    parser.add_argument("--libkrun-pristine-header", help="verify-header: upstream v1.19.6 include/libkrun.h")
    parser.add_argument("--libkrun-patches", help="verify-header: S4's committed patches/ directory")
    args = parser.parse_args()
    ctx = prepare_out(args.out)
    include = Path(args.libkrun_include).resolve() if args.libkrun_include else None
    archive = Path(args.libkrun_archive).resolve() if args.libkrun_archive else None
    if args.command in ("worker", "all") and (include is None or archive is None):
        die("this command needs --libkrun-include and --libkrun-archive (S4's header directory and stripped production archive)")
    if args.command == "verify-header":
        if not args.libkrun_pristine_header or not args.libkrun_patches:
            die("verify-header needs --libkrun-pristine-header and --libkrun-patches")
        cmd_verify_header(ctx, Path(args.libkrun_pristine_header).resolve(), Path(args.libkrun_patches).resolve(), include)
        return
    if args.command in ("test", "all"):
        cmd_test(ctx, args.only, include)
    if args.command in ("asan", "all"):
        run_tests(ctx, args.only, include, True)
    if args.command in ("guards", "all"):
        cmd_guards(ctx)
    if args.command in ("worker", "all"):
        cmd_worker(ctx, include, archive)
    if args.command in ("inspect", "all"):
        cmd_inspect(ctx)


if __name__ == "__main__":
    main()
