"""Slice-local tools only. No package installs; no VM is started by this command."""
import hashlib, json, os, shutil, stat, subprocess, tarfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
PINS = json.loads((ROOT / "pins.json").read_text())

def checked(args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)

def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def verify(path, expected):
    if digest(path) != expected:
        raise RuntimeError(f"Pinned checksum mismatch: {path}")

def cpio(entries):
    data = bytearray()
    for ino, (name, mode, payload, major, minor) in enumerate(entries, 1):
        encoded = name.encode() + b"\0"
        fields = [ino, mode, 0, 0, 1, 0, len(payload), 0, 0, major, minor, len(encoded), 0]
        data += b"070701" + "".join(f"{n:08x}" for n in fields).encode() + encoded
        data += bytes((-len(data)) % 4)
        data += payload
        data += bytes((-len(data)) % 4)
    return bytes(data)

def main():
    if os.uname().sysname != "Darwin" or os.uname().machine != "arm64":
        raise RuntimeError("Apple Silicon macOS required")
    OUT.mkdir(exist_ok=True)
    source = OUT / "libkrun"
    if not source.exists():
        checked(["git", "clone", "--depth", "1", "--branch", PINS["libkrun"]["tag"], PINS["libkrun"]["url"], source])
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != PINS["libkrun"]["revision"]:
        raise RuntimeError("Unexpected libkrun revision")
    verify(source / "Cargo.lock", PINS["libkrun"]["lockSha256"])
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
        raise RuntimeError("libkrun source modified; baseline must be unpatched")
    archive = OUT / "rust-1.90.0-aarch64-apple-darwin.tar.xz"
    if not archive.exists():
        urllib.request.urlretrieve(PINS["rust"]["url"], archive)
    verify(archive, PINS["rust"]["sha256"])
    extracted = OUT / "rust-1.90.0-aarch64-apple-darwin"
    if not extracted.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(OUT, filter="data")
    rust = OUT / "rust"
    # The upstream install.sh mishandles prefixes containing spaces. Install manifest entries locally.
    for component in ["rustc", "cargo", "rust-std-aarch64-apple-darwin"]:
        for line in (extracted / component / "manifest.in").read_text().splitlines():
            kind, rel = line.split(":", 1)
            src, dst = extracted / component / rel, rust / rel
            if not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                if kind == "dir": shutil.copytree(src, dst)
                else: shutil.copy2(src, dst)
    env = os.environ.copy()
    env.update(PATH=str(rust / "bin") + ":" + env["PATH"], CARGO_HOME=str(OUT / "cargo-home"))
    checked([rust / "bin/cargo", "build", "--manifest-path", source / "Cargo.toml", "-p", "libkrun", "--locked", "--no-default-features", "--jobs", "4"], env=env)
    library = OUT / "libkrun.1.dylib"
    shutil.copy2(source / "target/debug/libkrun.dylib", library)
    checked(["/usr/bin/install_name_tool", "-id", "@rpath/libkrun.1.dylib", library])
    checked(["/usr/bin/codesign", "--force", "--sign", "-", library])
    checked(["/usr/bin/clang", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-I", source / "include", ROOT / "worker.c", library, "-Wl,-rpath,@executable_path", "-o", OUT / "cowork-hvf-worker"])
    checked(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "dev.cowork.hvf.fixture-worker", "--entitlements", ROOT / "worker.entitlements", OUT / "cowork-hvf-worker"])
    zig = (ROOT / PINS["zig"]["cachedPath"]).resolve()
    verify(ROOT / "../cowork-vm/out/tools/zig.tar.xz", PINS["zig"]["archiveSha256"])
    if subprocess.check_output([str(zig), "version"], text=True).strip() != PINS["zig"]["version"]:
        raise RuntimeError("Unexpected Zig version")
    zig_env = os.environ.copy()
    zig_env.update(ZIG_GLOBAL_CACHE_DIR=str(OUT/"zig-global-cache"), ZIG_LOCAL_CACHE_DIR=str(OUT/"zig-local-cache"))
    checked([zig, "cc", "-target", "aarch64-linux-musl", "-static", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", ROOT / "init.c", "-o", OUT / "init"], env=zig_env)
    kernel = (ROOT / PINS["kernel"]["cachedPath"]).resolve()
    verify(kernel, PINS["kernel"]["sha256"])
    shutil.copy2(kernel, OUT / "kernel")
    (OUT / "initramfs.cpio").write_bytes(cpio([
        ("dev", stat.S_IFDIR | 0o755, b"", 0, 0),
        ("dev/console", stat.S_IFCHR | 0o600, b"", 5, 1),
        ("init", stat.S_IFREG | 0o755, (OUT / "init").read_bytes(), 0, 0),
        ("TRAILER!!!", 0, b"", 0, 0)]))
    (OUT / "build.json").write_text(json.dumps({"pins":PINS, "librarySha256":digest(library), "workerSha256":digest(OUT/"cowork-hvf-worker"), "initSha256":digest(OUT/"init"), "initramfsSha256":digest(OUT/"initramfs.cpio")}, indent=2) + "\n")

if __name__ == "__main__": main()
