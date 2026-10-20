#!/usr/bin/env python3
"""Offline cross-build of the guest's two static C programs (N2 slice S5): `init` (PID 1) and `winter-guest-relay`.

    python3 -I -S -B apple/Cowork/WinterCoworkGuest/build.py --zig <path to zig 0.14.1> --out <fresh directory>

Needs only a Zig 0.14.1 executable that is already on the machine (the one pinned in scripts/cowork-guest-artifact/pins.json);
nothing is downloaded or installed, and no cache is written outside --out. It compiles every program twice into separate
directories and refuses unless both builds are byte-identical, so the pinned digests can mean something. The programs are
never executed: this machine cannot run an aarch64-linux binary, and no VM is started.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET = "aarch64-linux-musl"
ZIG_VERSION = "0.14.1"
COMMON_FLAGS = ["-target", TARGET, "-static", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", "-s", "-Wl,--build-id=none"]

PROGRAMS = {
    "init": [
        "init/init_linux.c", "init/boot.c", "init/discover.c", "init/ext4sb.c", "init/mounts.c", "init/skeleton.c",
        "init/trusted_config.c", "common/ctl.c", "common/wmx.c",
    ],
    "winter-guest-relay": ["relay/relay.c", "common/ctl.c", "common/wmx.c"],
}
# The same two programs for an image that declares the runtime capability `file-channel-v1` (guest side of the file channel, FC3). Built only with `--profile file-channel`,
# under their own names, with -DWG_FILE_CHANNEL_V1; the production profile compiles none of it, so the production binaries and the pins.json entries above are unchanged by it.
FILE_CHANNEL_FLAG = "-DWG_FILE_CHANNEL_V1"
FILE_CHANNEL_PROGRAMS = {
    "init-file-channel": PROGRAMS["init"] + ["init/dataroots.c"],
    "winter-guest-relay-file-channel": PROGRAMS["winter-guest-relay"] + ["common/fileflow.c"],
}
FILE_CHANNEL_HEADERS = ["common/fileflow.h", "init/dataroots.h"]
HEADERS = [
    "common/ctl.h", "common/ring.h", "common/wmx.h", "init/boot.h", "init/discover.h", "init/ext4sb.h", "init/mounts.h",
    "init/skeleton.h", "init/trusted_config.h",
]
# The Python half of the guest image: copied byte for byte into the cpio by image.py.
SCRIPTS = {"guest_bootstrap.py": "bootstrap/guest_bootstrap.py"}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_digest(names):
    """One digest over (name, bytes) of every input a program is built from, in a fixed order."""
    digest = hashlib.sha256()
    for name in sorted(names):
        data = (HERE / name).read_bytes()
        digest.update(f"{name}\0{len(data)}\0".encode() + data)
    return digest.hexdigest()


def compile_program(zig, name, out_dir, cache, programs=None, extra=()):
    env = {"PATH": "/usr/bin:/bin", "ZIG_GLOBAL_CACHE_DIR": str(cache / "global"), "ZIG_LOCAL_CACHE_DIR": str(cache / "local"), "HOME": str(cache)}
    sources = [str(HERE / source) for source in (programs or PROGRAMS)[name]]
    command = [str(zig), "cc", *COMMON_FLAGS, *extra, f"-ffile-prefix-map={HERE}=/winter-guest", *sources, "-o", str(out_dir / name)]
    result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=600)
    if result.returncode != 0:
        raise SystemExit(f"{name}: compile failed\n{result.stderr[-4000:]}")
    return out_dir / name


def build(zig, out, profile="production"):
    if profile not in ("production", "file-channel"):
        raise SystemExit("profile must be production or file-channel")
    file_channel = profile == "file-channel"
    programs = FILE_CHANNEL_PROGRAMS if file_channel else PROGRAMS
    headers = HEADERS + FILE_CHANNEL_HEADERS if file_channel else HEADERS
    extra = [FILE_CHANNEL_FLAG] if file_channel else []
    zig = Path(zig).resolve()
    version = subprocess.run([str(zig), "version"], capture_output=True, text=True, check=True).stdout.strip()
    if version != ZIG_VERSION:
        raise SystemExit(f"Zig {ZIG_VERSION} required, found {version}")
    out = Path(out).resolve()
    out.mkdir(parents=True)
    results = {}
    for name in programs:
        first = out / "pass1"
        second = out / "pass2"
        first.mkdir(exist_ok=True)
        second.mkdir(exist_ok=True)
        compile_program(zig, name, first, out / "cache1", programs, extra)
        compile_program(zig, name, second, out / "cache2", programs, extra)
        a, b = sha256(first / name), sha256(second / name)
        if a != b:
            raise SystemExit(f"{name}: two builds differ ({a} vs {b}); the digest could not be pinned")
        data = (first / name).read_bytes()
        if str(HERE).encode() in data or str(Path.home()).encode() in data:
            raise SystemExit(f"{name}: a builder path leaked into the binary")
        (out / name).write_bytes(data)
        os.chmod(out / name, 0o555)
        results[name] = {"binarySha256": a, "bytes": len(data), "sourceSha256": source_digest(programs[name] + headers)}
    receipt = {
        "formatVersion": 1, "profile": profile, "target": TARGET, "zig": version, "flags": COMMON_FLAGS + extra, "programs": results,
        "scripts": {name: {"sha256": sha256(HERE / path)} for name, path in SCRIPTS.items()},
        "executed": False,
    }
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def update_pins(receipt, pins_path):
    """Copies the digests of a finished build into the `guest` section of pins.json. A reviewer still reads the diff; this only
    removes the chance of a transcription error."""
    pins_path = Path(pins_path)
    pins = json.loads(pins_path.read_text())
    guest = pins["guest"]
    for name, built in receipt["programs"].items():
        guest["programs"][name]["binarySha256"] = built["binarySha256"]
        guest["programs"][name]["sourceSha256"] = built["sourceSha256"]
    for name, built in receipt["scripts"].items():
        guest["scripts"][name]["sha256"] = built["sha256"]
    pins_path.write_text(json.dumps(pins, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zig", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--update-pins", type=Path, help="write the resulting digests into this pins.json (the guest section)")
    parser.add_argument("--profile", choices=["production", "file-channel"], default="production", help="file-channel builds the two programs of an image that declares file-channel-v1, under their own names")
    args = parser.parse_args()
    if args.profile != "production" and args.update_pins:
        raise SystemExit("--update-pins is for the production profile only: no pins.json entry is ever written from another profile")
    receipt = build(args.zig, args.out, args.profile)
    if args.update_pins:
        update_pins(receipt, args.update_pins)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    sys.exit(main())
