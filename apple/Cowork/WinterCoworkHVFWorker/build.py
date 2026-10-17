"""Offline build, test and static inspection of the production Cowork worker (N2 slice S3).

Run as `python3 -I build.py <command> --out <dir> [...]`. It never runs the worker, never applies the sandbox, never starts a
VM and never touches Hypervisor.framework. It only compiles, links, runs the VM-free unit tests, ad-hoc signs the result inside
--out and inspects it statically.

  test       generate the golden-vector header from the pinned S1 fixtures, build and run every strict-C unit test
  worker     build winter-cowork-worker against S4's stripped production archive (needs --libkrun-include and --libkrun-archive)
  contract   link-check the worker against a STUB archive that has the contract's names (never run; proves the one-file rename)
  inspect    ad-hoc sign the built worker inside --out, then codesign -dvv --entitlements -, otool -L, nm, strings
  guards     the Python source guards (order, forbidden APIs, anti-wiring, entitlements, fixtures)
  all        test, guards, worker, contract, inspect

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
SOURCE_LIST = ["Envelope", "Mux", "OwnedStop", "ConsoleRing", "AdmittedVolumes", "Sandbox", "Relay", "WorkspaceWorker"]

# The exact list of unit tests. Nothing else is ever executed by this script. Each is VM-free, sandbox-free and HVF-free.
TESTS_TO_RUN = [
    ("test_envelope", ["Envelope"], []),
    ("test_mux", ["Mux", "Envelope"], []),
    ("test_stop", ["OwnedStop"], []),
    ("test_ring", ["ConsoleRing"], []),
    ("test_intake", ["AdmittedVolumes", "Envelope"], []),
    ("test_handoff_256", ["AdmittedVolumes", "Envelope", "Mux"], ["-DCW_FD_CAPACITY=256"]),
    ("test_handoff_16", ["AdmittedVolumes", "Envelope", "Mux"], ["-DCW_FD_CAPACITY=16"]),
    ("test_relay", ["Relay", "OwnedStop", "Mux", "Envelope"], []),
    ("test_relay_16", ["Relay", "OwnedStop", "Mux", "Envelope"], ["-DCW_FD_CAPACITY=16"]),
    ("test_sandbox_profile", ["Sandbox"], []),
]
TEST_SOURCE = {"test_handoff_256": "test_handoff", "test_handoff_16": "test_handoff", "test_relay_16": "test_relay"}

# The only libkrun entry points the worker may reference (the contract's names, the generic setters, and nothing else).
ALLOWED_KRUN = {
    "krun_init_log", "krun_create_ctx", "krun_set_vm_config", "krun_disable_implicit_vsock", "krun_set_env", "krun_disable_implicit_console",
    "krun_add_serial_console_default", "krun_set_kernel", "krun_start_enter",
    # S4's implemented names, which CoworkAbi.h maps the contract's names to:
    "krun_cowork_enable_production_profile", "krun_cowork_set_workspace_disks", "krun_cowork_create_runtime_port", "krun_cowork_validate_production_profile",
    # the contract's names, for the configuration where the library has them:
    "krun_cowork_enable_profile_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_create_mux_stream_v1", "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1",
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

    def run(self, command, check=True, timeout=300, cwd=None, capture=True):
        result = subprocess.run([str(part) for part in command], env=self.env, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=capture, text=True, timeout=timeout)
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


# ------------------------------------------------------------------------------------------------------------------ tests

def generate_vectors(ctx: Context) -> Path:
    gen = ctx.out / "gen"
    gen.mkdir(exist_ok=True)
    header = gen / "vectors.h"
    ctx.run([sys.executable, "-I", TESTS / "gen_vectors.py", TESTS / "fixtures", header])
    return header


def cmd_test(ctx: Context, only=()) -> None:
    header = generate_vectors(ctx)
    bin_dir = ctx.out / "tests"
    bin_dir.mkdir(exist_ok=True)
    selected = [t for t in TESTS_TO_RUN if not only or t[0] in only]
    if only and len(selected) != len(set(only)):
        die(f"unknown test name in --only: {sorted(set(only) - {t[0] for t in TESTS_TO_RUN})}")
    for name, sources, extra in selected:
        source = TESTS / f"{TEST_SOURCE.get(name, name)}.c"
        binary = bin_dir / name
        ctx.run([CLANG, *STRICT, *ctx.prefix, *extra, "-I", SOURCES, "-I", TESTS, "-I", header.parent, source, *[SOURCES / f"{s}.c" for s in sources], "-o", binary], timeout=600)
        result = ctx.run([binary], check=False, timeout=180)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode != 0:
            die(f"{name} failed with exit code {result.returncode}")
    print(f"unit tests: {len(selected)} binaries passed (no VM, no sandbox, no HVF)")


# ----------------------------------------------------------------------------------------------------------------- worker

def check_libkrun_inputs(include: Path, archive: Path) -> None:
    if not (include / "libkrun.h").is_file() or not archive.is_file():
        die("--libkrun-include and --libkrun-archive must exist")
    for label, path, key in (("archive", archive, "archiveSha256"), ("header", include / "libkrun.h", "headerSha256")):
        actual = sha256(path)
        if actual != PINS["libkrun"][key]:
            die(f"libkrun {label} sha256 {actual} does not match the pin {PINS['libkrun'][key]} (pins.json)")


def defined_symbols(ctx: Context, path: Path) -> set:
    result = ctx.run(["/usr/bin/nm", "-g", path], check=False)
    return {line.split()[-1].lstrip("_") for line in result.stdout.splitlines() if re.search(r"\s[TtSsDdBbCc]\s", line)}


def undefined_krun(ctx: Context, objects) -> set:
    found = set()
    for obj in objects:
        result = ctx.run(["/usr/bin/nm", "-u", obj], check=False)
        found |= {line.strip().lstrip("_") for line in result.stdout.splitlines() if line.strip().lstrip("_").startswith("krun_")}
    return found


def compile_worker_objects(ctx: Context, include: Path, objdir: Path, defines):
    objdir.mkdir(parents=True, exist_ok=True)
    objects = []
    for name in SOURCE_LIST:
        obj = objdir / f"{name}.o"
        # libkrun.h is a system header here: it still contains a K&R declaration (`krun_create_ctx()`) that -Wstrict-prototypes rejects.
        ctx.run([CLANG, *STRICT, *ctx.prefix, *defines, "-I", SOURCES, "-isystem", include, "-c", SOURCES / f"{name}.c", "-o", obj])
        objects.append(obj)
    return objects


def link_worker(ctx: Context, objects, archive: Path, destination: Path) -> None:
    # -dead_strip drops every libkrun entry point the worker does not reference: the upstream C API this build never calls (krun_add_vsock,
    # krun_add_virtiofs, krun_set_gpu_options, krun_get_shutdown_eventfd ...) is then not even present as dead code in the binary.
    ctx.run([CLANG, "-O2", *ctx.prefix, "-Wl,-dead_strip", *objects, archive, *PINS["linkLibraries"], "-o", destination])


def cmd_worker(ctx: Context, include: Path, archive: Path) -> None:
    check_libkrun_inputs(include, archive)
    exported = defined_symbols(ctx, archive)
    contract_names = "krun_cowork_enable_profile_v1" in exported
    flush_evidence = "krun_cowork_get_flush_counters_v1" in exported and "krun_cowork_set_exit_hook_v1" in exported
    defines = [f"-DCW_ABI_NAMES_CONTRACT={int(contract_names)}", f"-DCW_ABI_FLUSH_EVIDENCE={int(flush_evidence)}"]
    out = ctx.out / "worker"
    out.mkdir(exist_ok=True)
    objects = compile_worker_objects(ctx, include, out / "obj", defines)
    referenced = undefined_krun(ctx, objects)
    extra = referenced - ALLOWED_KRUN
    if extra:
        die(f"the worker references libkrun entry points outside the allowed list: {sorted(extra)}")
    unstripped = out / "winter-cowork-worker.unstripped"
    link_worker(ctx, objects, archive, unstripped)
    stripped = out / "winter-cowork-worker"
    ctx.run(["/usr/bin/strip", "-x", "-o", stripped, unstripped])
    report = {
        "archiveSha256": sha256(archive), "headerSha256": sha256(include / "libkrun.h"), "abiNamesContract": contract_names, "flushEvidenceInLibrary": flush_evidence,
        "libkrunReferences": sorted(referenced), "workerSha256": sha256(stripped), "vmStarted": False, "workerExecuted": False,
    }
    (out / "build-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    if not flush_evidence:
        print("NOTE: the linked archive exports neither krun_cowork_get_flush_counters_v1 nor krun_cowork_set_exit_hook_v1; the worker "
              "built here REFUSES to start a VM (CoworkAbi.h returns -ENOSYS). S4 must add them or the contract must change.")


def cmd_contract(ctx: Context, include: Path) -> None:
    """Link-check the worker against a stub archive that carries the CONTRACT's names. The stub returns -ENOSYS everywhere and is never run."""
    out = ctx.out / "contract"
    out.mkdir(exist_ok=True)
    stub_obj = out / "krun_contract_stub.o"
    ctx.run([CLANG, *STRICT, "-Wno-missing-prototypes", *ctx.prefix, "-isystem", include, "-I", SOURCES, "-c", TESTS / "stubs" / "krun_contract_stub.c", "-o", stub_obj])
    archive = out / "libkrun_contract_stub.a"
    if archive.exists():
        archive.unlink()
    ctx.run(["/usr/bin/ar", "rcs", archive, stub_obj])
    defines = ["-DCW_ABI_NAMES_CONTRACT=1", "-DCW_ABI_FLUSH_EVIDENCE=1"]
    objects = compile_worker_objects(ctx, include, out / "obj", defines)
    referenced = undefined_krun(ctx, objects)
    if referenced - ALLOWED_KRUN:
        die(f"unexpected libkrun references: {sorted(referenced - ALLOWED_KRUN)}")
    for required in ("krun_cowork_enable_profile_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_create_mux_stream_v1", "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1"):
        if required not in referenced:
            die(f"the contract-name configuration does not reference {required}")
    binary = out / "winter-cowork-worker.contract-stub"
    ctx.run([CLANG, "-O2", *ctx.prefix, "-Wl,-dead_strip", *objects, archive, "-framework", "Hypervisor", "-liconv", "-lSystem", "-lc", "-lm", "-o", binary])
    print(f"contract-name configuration links against the stub archive ({binary.name}); it is a link check only and must never be run")


# --------------------------------------------------------------------------------------------------------------- inspect

FORBIDDEN_SYMBOL_PATTERNS = [r"fixture", r"shutdown_eventfd", r"krun_add_vsock", r"krun_add_virtiofs", r"krun_set_port_map", r"krun_set_gpu_options", r"krun_add_display",
                             r"krun_add_input_device", r"krun_create_cowork_", r"krun_enable_cowork_", r"krun_set_cowork_"]


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
    for label, unstripped in (("worker (S4 archive)", ctx.out / "worker" / "winter-cowork-worker.unstripped"), ("contract-name stub configuration", ctx.out / "contract" / "winter-cowork-worker.contract-stub")):
        if not unstripped.exists():
            continue
        symbols = ctx.run(["/usr/bin/nm", "-g", unstripped]).stdout
        bad = [line for line in symbols.splitlines() if any(re.search(p, line) for p in FORBIDDEN_SYMBOL_PATTERNS) and re.search(r"\s[TtSsDdBbCc]\s", line)]
        if bad:
            die(f"{label}: the linked binary defines symbols of devices the profile never enables: {bad}")
        krun_defined = sorted(line.split()[-1].lstrip("_") for line in symbols.splitlines() if re.search(r"\s[Tt]\s_krun_", line))
        print(f"{label}: {len(krun_defined)} libkrun entry points survive -dead_strip (all referenced by the worker): {krun_defined}")
        if set(krun_defined) - ALLOWED_KRUN:
            die(f"{label}: unexpected libkrun entry points in the binary: {sorted(set(krun_defined) - ALLOWED_KRUN)}")
    for label, path in (("worker (S4 archive)", ctx.out / "worker" / "winter-cowork-worker"), ("contract-name stub configuration", ctx.out / "contract" / "winter-cowork-worker.contract-stub")):
        if path.exists():
            results.append(inspect_binary(ctx, path, label))
    if not results:
        die("nothing to inspect: build the worker first")
    (ctx.out / "inspect-report.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


def cmd_guards(ctx: Context) -> None:
    ctx.run([sys.executable, "-I", TESTS / "test_guards.py", REPO], capture=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["test", "worker", "contract", "inspect", "guards", "all"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", action="append", default=[], help="with `test`: run only the named test binaries (used by the mutation driver)")
    parser.add_argument("--libkrun-include")
    parser.add_argument("--libkrun-archive")
    args = parser.parse_args()
    ctx = prepare_out(args.out)
    include = Path(args.libkrun_include).resolve() if args.libkrun_include else None
    archive = Path(args.libkrun_archive).resolve() if args.libkrun_archive else None
    needs_libkrun = args.command in ("worker", "contract", "all")
    if needs_libkrun and (include is None or archive is None):
        die("this command needs --libkrun-include and --libkrun-archive (S4's header directory and stripped production archive)")
    if args.command in ("test", "all"):
        cmd_test(ctx, args.only)
    if args.command in ("guards", "all"):
        cmd_guards(ctx)
    if args.command in ("worker", "all"):
        cmd_worker(ctx, include, archive)
    if args.command in ("contract", "all"):
        cmd_contract(ctx, include)
    if args.command in ("inspect", "all"):
        cmd_inspect(ctx)


if __name__ == "__main__":
    main()
