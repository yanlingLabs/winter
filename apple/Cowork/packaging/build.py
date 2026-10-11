#!/usr/bin/env python3
"""Isolated macOS native dependency build. No global installs or VM launches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from closure import dependencies, is_system, output, runpaths, validate
from libslirp_provenance import generate as libslirp_provenance, verify_committed_vendor

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NETWORK = HERE.parent / "WinterCoworkNetwork"
NATIVE = HERE.parent / "WinterCoworkVM"
PINS = json.loads((HERE / "dependencies.json").read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_json_receipt(log, expected):
    for line in log.read_text().splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and all(key in value and type(value[key]) is type(wanted)
                and value[key] == wanted for key, wanted in expected.items()):
            return value
    raise ValueError(f"successful exit without required execution receipt: {log.name}")


def clean_environment():
    env = dict(os.environ)
    for key in list(env):
        if key.startswith(("DYLD_", "PKG_CONFIG_")) or key in (
            "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "CPATH", "LIBRARY_PATH",
            "SDKROOT", "CMAKE_PREFIX_PATH", "GI_TYPELIB_PATH", "GIO_EXTRA_MODULES",
            "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "PYTHONPATH", "PYTHONHOME",
            "WINTER_COWORK_NATIVE_PROFILE"):
            env.pop(key, None)
    env.update(MACOSX_DEPLOYMENT_TARGET="26.0", LC_ALL="C", LANG="C")
    env.update(CC=output("xcrun", "--find", "clang").strip(),
               CXX=output("xcrun", "--find", "clang++").strip(),
               SDKROOT=output("xcrun", "--show-sdk-path").strip(),
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
    return env


class Build:
    def __init__(self, directory, jobs):
        self.directory = directory
        self.jobs = jobs
        self.prefix = directory / "prefix"
        self.bundle = directory / "bundle"
        self.env = clean_environment()
        self.env.update(PKG_CONFIG_LIBDIR=str(self.prefix / "lib/pkgconfig"),
                        PKG_CONFIG_PATH=str(self.prefix / "lib/pkgconfig"), CMAKE_PREFIX_PATH=str(self.prefix),
                        CPPFLAGS=f"-I{self.prefix}/include",
                        CFLAGS="-O2 -fPIC", CXXFLAGS="-O2 -fPIC",
                        LDFLAGS=f"-L{self.prefix}/lib -Wl,-headerpad_max_install_names")
        self.env.update(CLANG_MODULE_CACHE_PATH=str(directory / "clang-module-cache"),
                        BUN_RUNTIME_TRANSPILER_CACHE_PATH=str(directory / "bun-transpiler-cache"))
        self.commands = []
        self.execution_receipts = {}
        (directory / "logs").mkdir()
        (directory / "sources").mkdir()
        (self.bundle / "lib").mkdir(parents=True)
        (self.bundle / "source").mkdir()
        (self.bundle / "notices").mkdir()
        self.network = directory / "input/WinterCoworkNetwork"
        self.native = directory / "input/WinterCoworkVM"
        self.recipe = directory / "input/packaging"
        shutil.copytree(HERE, self.recipe, ignore=shutil.ignore_patterns("out", "__pycache__", ".git"))
        self.commit = output("git", "-C", str(ROOT), "rev-parse", "HEAD").strip()

    def snapshot(self):
        for original, snapshot in ((NETWORK, self.network), (NATIVE, self.native)):
            shutil.copytree(original, snapshot, ignore=shutil.ignore_patterns(".build", "out", "__pycache__", ".git"))
        # A generated provenance inventory cannot bless arbitrary vendor edits.
        # Verify the committed reviewed pin before compiling any network source.
        self.vendor_pin = verify_committed_vendor(ROOT, self.commit, self.network / "vendor/libslirp",
                                                  self.recipe / "libslirp-vendor-pin.json")

    def import_dependencies(self, bundle):
        manifest = json.loads((bundle / "manifest.json").read_text())
        if manifest.get("format") != 1 or manifest.get("components") != "dependencies-only" or manifest["sourcePins"] != PINS:
            raise ValueError("dependency cache pin/format mismatch")
        expected_aliases = manifest.get("materialAliases", {f"{directory}/{name}": target
            for directory in ("lib", "dependency-prefix/lib") for name, target in manifest["aliases"].items()})
        actual_aliases = {str(p.relative_to(bundle)): os.readlink(p) for p in bundle.rglob("*") if p.is_symlink()}
        if actual_aliases != expected_aliases:
            raise ValueError("dependency cache alias mismatch")
        actual_files = {str(p.relative_to(bundle)) for p in bundle.rglob("*") if p.is_file() and not p.is_symlink()
                        and p != bundle / "manifest.json"}
        if actual_files != set(manifest["materialHashes"]):
            raise ValueError("dependency cache material inventory mismatch")
        for relative, expected in manifest["materialHashes"].items():
            path = bundle / relative
            if not path.resolve().is_relative_to(bundle.resolve()) or digest(path) != expected:
                raise ValueError(f"dependency cache material mismatch: {relative}")
        validate(bundle / "lib")
        shutil.copytree(bundle / "dependency-prefix", self.prefix, symlinks=True)
        # Cached libraries are distribution-relocated. Build/test executables
        # must resolve this invocation's prefix until their own closure is staged.
        # Edit only the fresh copies; never mutate the verified source bundle.
        for binary in sorted((self.prefix / "lib").glob("*.dylib")):
            if binary.is_symlink():
                continue
            self.run(f"cache-id-{binary.name}", ["install_name_tool", "-id", binary, binary])
            for ref in dependencies(output("otool", "-L", str(binary))):
                if is_system(ref) or ref == str(binary):
                    continue
                if not ref.startswith("@loader_path/") or Path(ref).name != ref.removeprefix("@loader_path/"):
                    raise ValueError(f"unexpected cache build dependency: {ref}")
                self.run(f"cache-load-{binary.name}", ["install_name_tool", "-change", ref,
                    self.prefix / "lib" / Path(ref).name, binary])
            self.run(f"cache-sign-{binary.name}", ["codesign", "--force", "--sign", "-", binary])
        shutil.copytree(bundle, self.bundle / "source/dependency-build", symlinks=True)
        for directory in ("source", "notices", "build-config", "build-logs"):
            shutil.copytree(bundle / directory, self.bundle / directory, dirs_exist_ok=True)
        shutil.copyfile(bundle / "manifest.json", self.bundle / "source/dependency-build-manifest.json")

    def export_dependencies(self):
        for name in ("libglib-2.0.0.dylib", "libintl.8.dylib", "libpcre2-8.0.dylib"):
            shutil.copyfile(self.prefix / "lib" / name, self.bundle / "lib" / name)
        closure = self.relocate()
        target = self.bundle / "dependency-prefix"
        shutil.copytree(self.prefix / "include", target / "include")
        shutil.copytree(self.bundle / "lib", target / "lib", symlinks=True)
        shutil.copytree(self.prefix / "lib/glib-2.0", target / "lib/glib-2.0")
        pc = target / "lib/pkgconfig"
        pc.mkdir()
        for name in ("glib-2.0.pc", "libpcre2-8.pc", "libffi.pc", "zlib.pc"):
            text = (self.prefix / "lib/pkgconfig" / name).read_text()
            text = text.replace(str(self.prefix), "${pcfiledir}/../..")
            text = text.replace(str(self.prefix.resolve()), "${pcfiledir}/../..")
            (pc / name).write_text(text)
        return closure

    def dependency_smoke(self):
        relocated = self.directory / "relocated-dependency-smoke"
        shutil.copytree(self.bundle / "lib", relocated, symlinks=True)
        flags = shlex.split(subprocess.check_output(["pkg-config", "--cflags", "glib-2.0", "libpcre2-8"],
                                                     env=self.env, text=True))
        executable = relocated / "dependency-smoke"
        self.run("dependency-smoke-build", ["xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
            *flags, f"-I{self.prefix}/include", HERE / "dependency-smoke.c", f"-L{relocated}",
            "-lglib-2.0", "-lintl", "-lpcre2-8", "-o", executable])
        self.run("relocated-dependency-smoke", [executable], env=clean_environment(), timeout=30)

    def sdk_metadata(self):
        sdk = Path(output("xcrun", "--show-sdk-path").strip())
        pc = self.prefix / "lib/pkgconfig"
        pc.mkdir(parents=True, exist_ok=True)
        # Apple's libffi tbd ABI version is not an upstream libffi release version.
        # Meson's >=3.0 capability check is satisfied by the SDK ABI and compile checks.
        ffi = (sdk / "usr/lib/libffi.tbd").read_text()
        import re
        ffi_abi = re.search(r"current-version: ([0-9.]+)", ffi).group(1)
        zlib_header = (sdk / "usr/include/zlib.h").read_text()
        zlib_version = re.search(r'#define ZLIB_VERSION "([^"]+)"', zlib_header).group(1)
        for name, version, flags, libs in (("libffi", ffi_abi, f"-I{sdk}/usr/include/ffi", "-lffi"),
                                           ("zlib", zlib_version, "", "-lz")):
            (pc / f"{name}.pc").write_text(f"Name: Apple SDK {name}\nDescription: SDK system library; libffi version is Apple ABI\n"
                                          f"Version: {version}\nCflags: {flags}\nLibs: {libs}\n")
        shutil.copytree(pc, self.bundle / "build-config/apple-sdk-pkgconfig")

    def run(self, label, command, cwd=None, env=None, timeout=900, receipt=None):
        command = [str(v) for v in command]
        self.commands.append({"label": label, "argv": command, "cwd": str(cwd or ROOT)})
        print(f"{label}: {shlex.join(command)}", flush=True)
        log = self.directory / "logs" / f"{len(self.commands):02}-{label}.log"
        with log.open("w") as stream:
            command_env = dict(env or self.env)
            command_env["PWD"] = str(cwd or ROOT)
            subprocess.run(command, cwd=cwd or ROOT, env=command_env,
                           stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=timeout)
        if receipt is not None:
            value = require_json_receipt(log, receipt)
            self.execution_receipts[label] = {"receipt": value, "log": str(log.relative_to(self.directory)),
                                              "sha256": digest(log)}

    def source(self, name, cache):
        pin = PINS[name]
        filename = pin["url"].rsplit("/", 1)[-1]
        archive = self.directory / "sources" / filename
        cached = cache / filename if cache else None
        if cached and cached.is_file():
            shutil.copyfile(cached, archive)
        else:
            with urllib.request.urlopen(pin["url"], timeout=60) as response, archive.open("wb") as stream:
                shutil.copyfileobj(response, stream)
        if digest(archive) != pin["sha256"]:
            raise ValueError(f"source checksum mismatch: {filename}")
        with tarfile.open(archive) as source:
            source.extractall(self.directory / "sources", filter="data")
        shutil.copyfile(archive, self.bundle / "source" / filename)
        return self.directory / "sources" / f"{name}-{pin['version']}"

    def libraries(self, cache):
        self.sdk_metadata()
        sources = {name: self.source(name, cache) for name in PINS}
        gettext = sources["gettext"] / "gettext-runtime"
        gettext_build = self.directory / "gettext-build"
        gettext_build.mkdir()
        self.run("gettext-configure", [gettext / "configure", f"--prefix={self.prefix}",
            "--disable-static", "--enable-shared", "--disable-java", "--disable-csharp",
            "--disable-libasprintf"], gettext_build)
        self.run("gettext-compile", ["make", f"-j{self.jobs}", "-C", "intl"], gettext_build)
        self.run("gettext-install", ["make", "-C", "intl", "install"], gettext_build)
        pcre = self.directory / "pcre2-build"
        pcre.mkdir()
        self.run("pcre2-configure", [sources["pcre2"] / "configure", f"--prefix={self.prefix}",
            "--disable-static", "--enable-shared", "--disable-pcre2-16", "--disable-pcre2-32",
            "--disable-pcre2grep", "--disable-pcre2test", "--enable-jit"], pcre)
        self.run("pcre2-compile", ["make", f"-j{self.jobs}"], pcre)
        self.run("pcre2-install", ["make", "install"], pcre)
        glib = self.directory / "glib-build"
        self.run("glib-configure", ["meson", "setup", glib, sources["glib"],
            f"--prefix={self.prefix}", "--libdir=lib", "--buildtype=release",
            "--default-library=shared", "--wrap-mode=nofallback", "-Dtests=false",
            "-Dinstalled_tests=false", "-Dintrospection=disabled", "-Ddocumentation=false",
            "-Dman-pages=disabled", "-Dnls=enabled", "-Dsysprof=disabled",
            "-Ddtrace=disabled", "-Dsystemtap=disabled", "-Dlibelf=disabled"])
        self.run("glib-compile", ["meson", "compile", "-C", glib, "-j", self.jobs])
        self.run("glib-install", ["meson", "install", "-C", glib, "--no-rebuild"])
        for name, source in sources.items():
            notices = self.bundle / "notices" / name
            notices.mkdir()
            for candidate in source.rglob("*"):
                if candidate.is_file() and (candidate.name.startswith(("COPYING", "LICENSE", "LICENCE"))
                                             or candidate.name in ("AUTHORS", "NOTICE", "COPYRIGHT")):
                    dest = notices / candidate.relative_to(source)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(candidate, dest)

    def prepare_native(self, profile):
        if profile not in ("upstream", "verified-eof"):
            raise ValueError("unknown native source profile")
        self.native_profile = {"name": profile}
        self.env["WINTER_COWORK_NATIVE_PROFILE"] = profile
        if profile == "upstream":
            return
        # This is the snapshot's fixed helper and fixed relative dependency path.
        # An existing archive is merely a cache: the helper verifies it, every
        # patched file and the complete prepared tree against committed pins.
        source = self.native / "out/dependencies"
        source.mkdir(parents=True)
        cached = NATIVE / "out/dependencies/containerization-source.tar.gz"
        if cached.is_file():
            shutil.copyfile(cached, source / cached.name)
        helper = self.native.resolve() / "dependency-patches/prepare-containerization.py"
        self.run("native-source-prepare", ["python3", helper])
        self.run("native-source-verify", ["python3", helper, "--verify-only", "--offline"])
        pins = json.loads((self.native / "dependency-patches/output-completion-provenance.json").read_text())
        self.native_profile.update(revision=pins["revision"], archiveSha256=pins["archiveSha256"],
            patchSha256=pins["patchSha256"], sourceTreeSha256=pins["sourceTreeSha256"])
        retained = self.bundle / "source/containerization-profile"
        shutil.copytree(source, retained, ignore=shutil.ignore_patterns(".build", ".swiftpm", ".git"))
        shutil.copytree(self.native / "dependency-patches", retained / "winter-patches")

    def swift(self, skip_native, node_headers, native_profile):
        self.snapshot()
        isolated = ["--cache-path", self.directory / "swift-cache", "--config-path", self.directory / "swift-config",
                    "--security-path", self.directory / "swift-security", "--manifest-cache", "local",
                    "--disable-netrc", "--disable-keychain", "--disable-experimental-prebuilts"]
        scratch = self.directory / "swift-network"
        self.run("network-build", ["swift", "build", *isolated, "--package-path", self.network,
            "--scratch-path", scratch, "--configuration", "release", "--jobs", self.jobs])
        self.run("network-tests", ["swift", "test", *isolated, "--package-path", self.network,
            "--scratch-path", scratch, "--jobs", self.jobs])
        shutil.copyfile(scratch / "release/libWinterCoworkNetwork.dylib",
                        self.bundle / "lib/libWinterCoworkNetwork.dylib")
        if not skip_native:
            self.prepare_native(native_profile)
            scratch = self.directory / "swift-native"
            # The source manifest rejects aliases. Automake's private symlink
            # remains useful for dependencies, but Swift sees the canonical tree.
            self.run("native-build", ["swift", "build", *isolated, "--package-path", self.native.resolve(),
                "--scratch-path", scratch, "--configuration", "release", "--jobs", self.jobs])
            self.run("native-tests", ["swift", "test", *isolated, "--package-path", self.native.resolve(),
                "--scratch-path", scratch, "--jobs", self.jobs])
            shutil.copyfile(scratch / "release/libWinterCoworkNative.dylib",
                            self.bundle / "lib/libWinterCoworkNative.dylib")
            if not (node_headers / "node_api.h").is_file():
                raise ValueError("existing Node-API headers required; no global installation performed")
            self.run("node-api-build", ["xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fPIC", "-bundle", "-undefined", "dynamic_lookup", f"-I{node_headers}",
                self.native / "node-api/adapter.c", "-o", self.bundle / "lib/winter-cowork-native.node"])
            shutil.copytree(node_headers, self.bundle / "source/node-api-headers")

    def relocate(self):
        lib = self.bundle / "lib"
        # Follow only dependencies built under this invocation's isolated prefix.
        pending = list(lib.glob("*.dylib"))
        visited = set()
        while pending:
            binary = pending.pop()
            if binary.name in visited:
                continue
            visited.add(binary.name)
            for ref in dependencies(output("otool", "-L", str(binary))):
                if is_system(ref) or ref.startswith("@rpath/") and ref.rsplit("/", 1)[-1] == binary.name:
                    continue
                path = self.prefix / "lib" / Path(ref).name if ref.startswith(("@loader_path/", "@rpath/")) else Path(ref)
                if not path.is_absolute() or not path.resolve().is_relative_to(self.prefix.resolve()):
                    raise ValueError(f"unexpected build dependency: {binary}: {ref}")
                target = lib / path.name
                if not target.exists():
                    shutil.copyfile(path, target)
                    pending.append(target)
        # Keep original SONAME aliases (e.g. libglib-2.0.dylib and libintl.dylib).
        for alias in (self.prefix / "lib").glob("*.dylib"):
            if alias.is_file():
                candidates = [p for p in lib.glob("*.dylib")
                              if (self.prefix / "lib" / p.name).exists()
                              and (self.prefix / "lib" / p.name).resolve() == alias.resolve()]
                if candidates and not (lib / alias.name).exists():
                    (lib / alias.name).symlink_to(candidates[0].name)
        for binary in sorted(lib.iterdir()):
            if binary.is_symlink():
                continue
            if binary.suffix == ".dylib":
                self.run(f"id-{binary.name}", ["install_name_tool", "-id", f"@loader_path/{binary.name}", binary])
            for ref in dependencies(output("otool", "-L", str(binary))):
                if is_system(ref) or ref.startswith("@loader_path/"):
                    continue
                self.run(f"load-{binary.name}", ["install_name_tool", "-change", ref,
                    f"@loader_path/{Path(ref).name}", binary])
            for path in set(runpaths(output("otool", "-l", str(binary)))):
                if not is_system(path) and path != "@loader_path":
                    self.run(f"rpath-{binary.name}", ["install_name_tool", "-delete_rpath", path, binary])
            # Tests only. Release signing/replacement policy remains a separate gate.
            self.run(f"adhoc-{binary.name}", ["codesign", "--force", "--sign", "-", binary])
        return validate(lib)

    def material(self):
        # Exact source snapshot for local patched libslirp, wrapper, controller and recipe.
        with tarfile.open(self.bundle / "source/winter-cowork-source.tar.gz", "w:gz") as archive:
            for package in (self.network, self.native, self.recipe):
                if not package.exists():
                    continue
                for path in sorted(package.rglob("*")):
                    rel = path.relative_to(package)
                    if any(v in rel.parts for v in (".build", "out", "__pycache__", ".git")):
                        continue
                    if path.is_file():
                        archive.add(path, arcname=f"{package.name}/{rel}", recursive=False)
            checkouts = self.directory / "swift-native/checkouts"
            if checkouts.exists():
                for path in sorted(checkouts.rglob("*")):
                    rel = path.relative_to(checkouts)
                    if path.is_file() and not any(v in rel.parts for v in (".git", ".build")):
                        archive.add(path, arcname=f"swift-dependencies/{rel}", recursive=False)
        if self.network.exists():
            libslirp_provenance(self.network / "vendor/libslirp", self.bundle / "source/libslirp-provenance",
                               getattr(self, "libslirp_upstream", None), self.recipe / "libslirp-vendor-pin.json")
            shutil.copytree(self.network / "vendor/libslirp", self.bundle / "notices/libslirp",
                            ignore=shutil.ignore_patterns("src", "include", "subprojects", "test", "build-aux"))
        for scratch in self.directory.glob("swift-*"):
            resolved = scratch / "workspace-state.json"
            if resolved.exists():
                shutil.copyfile(resolved, self.bundle / "source" / f"{scratch.name}-workspace-state.json")
        shutil.copytree(self.directory / "logs", self.bundle / "build-logs", dirs_exist_ok=True)
        for name in ("gettext-build", "pcre2-build", "glib-build"):
            for path in (self.directory / name).rglob("*"):
                if path.name in ("config.log", "config.status", "meson-log.txt", "build.ninja", "intro-buildoptions.json"):
                    dest = self.bundle / "build-config" / name / path.relative_to(self.directory / name)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, dest)

    def smoke(self, skip_native):
        relocated = self.directory / "relocated-smoke"
        shutil.copytree(self.bundle / "lib", relocated, symlinks=True)
        executable = relocated / "network-smoke"
        self.run("network-smoke-build", ["xcrun", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
            f"-I{self.network}/Sources/CoworkNetworkC/include", HERE / "network-smoke.c",
            f"-L{relocated}", "-lWinterCoworkNetwork", "-o", executable])
        env = clean_environment()
        # Library loads must work with no injected Homebrew or build-prefix search paths.
        self.run("relocated-network-smoke", [executable], env=env, timeout=30,
            receipt={"relocatedNetwork": True, "syntheticNoOutbound": True, "realVM": False})
        if not skip_native:
            env["WINTER_COWORK_NATIVE_TEST_BUILD"] = str(relocated)
            env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = str(self.directory / "bun-transpiler-cache")
            env["WINTER_COWORK_NATIVE_EXIT_FIXTURE"] = str(self.native / "node-api/output-exit-child.ts")
            config = self.directory / "empty-bunfig.toml"
            config.write_text("")
            self.run("relocated-native-smoke", ["bun", "run", "--no-env-file", f"--config={config}",
                self.native / "node-api/smoke.ts"], env=env, timeout=30,
                receipt={"backend": "fake", "nodeAPI": True, "boundedInputOutput": True, "realVM": False})
            self.run("relocated-client-smoke", ["bun", "run", "--no-env-file", f"--config={config}",
                self.native / "node-api/client-smoke.ts"], env=env, timeout=30,
                receipt={"nativeTypedClient": True, "productionFeatureBlocked": True, "realVM": False})
            output_receipt = {"nativeOutputTransport": True, "pressureBytes": 10 * 1024 * 1024,
                "pauseStopsNativeReads": True, "exactStdoutStderr": True, "sharedReadiness": True,
                "concurrentStreams": 12, "callbackFailureVisible": True, "noChunksAfterDispose": True,
                "pauseInsideCallback": True, "bothEOFRequired": True, "extraInheritedDescriptors": False,
                "descriptorEnumeration": "/dev/fd", "highFixtureDescriptors": 140, "realVM": False}
            output_receipt.update(staleWriterGettersDenied=True, invalidStatisticsThrows=True, exitWithoutDispose=True)
            self.run("relocated-output-smoke", ["bun", "run", "--no-env-file", f"--config={config}",
                self.native / "node-api/output-smoke.ts"], env=env, timeout=30, receipt=output_receipt)
            compiled = relocated / "compiled-output-smoke"
            self.run("output-smoke-compile", ["bun", "build", f"--config={config}",
                "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--compile",
                self.native / "node-api/output-smoke.ts", "--outfile", compiled], env=env)
            self.run("relocated-compiled-output-smoke", [compiled], env=env, timeout=30, receipt=output_receipt)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--source-cache", type=Path)
    parser.add_argument("--dependencies-only", action="store_true")
    parser.add_argument("--dependency-bundle", type=Path)
    parser.add_argument("--libslirp-upstream-checkout", type=Path)
    parser.add_argument("--network-only", action="store_true")
    parser.add_argument("--native-profile", choices=("verified-eof", "upstream"), default="verified-eof")
    parser.add_argument("--node-headers", type=Path, default=Path(os.environ.get(
        "WINTER_NODE_API_HEADERS", "/opt/homebrew/opt/node/include/node")))
    args = parser.parse_args()
    if platform.system() != "Darwin" or not 1 <= args.jobs <= 4:
        parser.error("requires macOS and 1..4 build jobs")
    if shutil.disk_usage(HERE).free < 8 * 1024**3:
        parser.error("at least 8 GiB free space required")
    (HERE / "out").mkdir(exist_ok=True)
    actual_directory = Path(tempfile.mkdtemp(prefix="build-", dir=HERE / "out"))
    # Automake rejects source/build directories containing whitespace. This private
    # alias contains no artifacts: every byte remains under the ignored output.
    alias_parent = Path(tempfile.mkdtemp(prefix="winter-cowork-build-"))
    directory = alias_parent / "work"
    directory.symlink_to(actual_directory, target_is_directory=True)
    print(f"isolated build: {actual_directory}", flush=True)
    build = Build(directory, args.jobs)
    build.libslirp_upstream = args.libslirp_upstream_checkout.resolve() if args.libslirp_upstream_checkout else None
    started = time.time()
    try:
        if args.dependency_bundle:
            build.import_dependencies(args.dependency_bundle.resolve())
        else:
            build.libraries(args.source_cache.resolve() if args.source_cache else None)
        if args.dependencies_only:
            closure = build.export_dependencies()
            build.dependency_smoke()
        else:
            build.swift(args.network_only, args.node_headers.resolve(), args.native_profile)
            closure = build.relocate()
            build.smoke(args.network_only)
        build.material()
        manifest = {"format": 1, "productionReady": False, "signing": "ad-hoc test only",
            "components": "dependencies-only" if args.dependencies_only else "network-only" if args.network_only else "native-and-network",
            "sourcePins": PINS, "closure": closure, "aliases": {p.name: os.readlink(p)
                for p in (build.bundle / "lib").iterdir() if p.is_symlink()},
            "materialAliases": {str(p.relative_to(build.bundle)): os.readlink(p)
                for p in build.bundle.rglob("*") if p.is_symlink()},
            "commands": build.commands, "buildEnvironment": {k: build.env[k] for k in (
                "PKG_CONFIG_LIBDIR", "PKG_CONFIG_PATH", "CPPFLAGS", "CFLAGS", "CXXFLAGS", "LDFLAGS",
                "MACOSX_DEPLOYMENT_TARGET", "CMAKE_PREFIX_PATH", "CC", "CXX", "SDKROOT")},
            "toolchain": {"swift": output("swift", "--version"), "clang": output("xcrun", "clang", "--version"),
                "meson": output("meson", "--version"), "ninja": output("ninja", "--version"),
                "sdk": output("xcrun", "--show-sdk-version"),
                "platform": platform.platform(), "arch": platform.machine()},
            "commit": build.commit,
            "committedVendorPin": getattr(build, "vendor_pin", None),
            "executionReceipts": build.execution_receipts,
            "nativeProfile": getattr(build, "native_profile", None),
            "inputHashes": {str(p.relative_to(directory / "input")): digest(p)
                for p in sorted((directory / "input").rglob("*")) if p.is_file()},
            "elapsedSeconds": round(time.time() - started),
            "materialHashes": {str(p.relative_to(build.bundle)): digest(p)
                for p in sorted(build.bundle.rglob("*")) if p.is_file() and not p.is_symlink()}}
        (build.bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"verified unsigned-production candidate: {actual_directory / 'bundle'}", flush=True)
    finally:
        (directory / "commands.json").write_text(json.dumps(build.commands, indent=2) + "\n")
        directory.unlink()
        alias_parent.rmdir()


if __name__ == "__main__":
    main()
