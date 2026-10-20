#!/usr/bin/env python3
"""Fail-closed Mach-O closure verification, without executing the libraries."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def output(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def dependencies(text):
    return [line.strip().split(" (compatibility version", 1)[0]
            for line in text.splitlines() if " (compatibility version" in line]


def runpaths(text):
    return re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.*?) \(offset", text)


def is_system(path):
    return path.startswith(("/usr/lib/", "/System/Library/")) and ".." not in Path(path).parts


def resolve_reference(reference, binary, root):
    if is_system(reference):
        return None
    if not reference.startswith("@loader_path/"):
        raise ValueError(f"unresolved/non-relative dependency: {binary.name}: {reference}")
    target = (binary.parent / reference.removeprefix("@loader_path/")).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        raise ValueError(f"dependency escapes/missing: {binary.name}: {reference}")
    return target


def validate(root):
    root = Path(root).resolve()
    records = {}
    for alias in root.iterdir():
        if alias.is_symlink():
            resolved = alias.resolve()
            if not resolved.is_relative_to(root) or not resolved.is_file():
                raise ValueError(f"alias escapes/missing: {alias.name}")
    binaries = sorted(p for p in root.iterdir() if p.suffix in (".dylib", ".node") and not p.is_symlink())
    if not binaries:
        raise ValueError("empty native closure")
    for binary in binaries:
        architectures = output("lipo", "-archs", str(binary)).split()
        slices = {}
        for architecture in architectures:
            refs = dependencies(output("otool", "-arch", architecture, "-L", str(binary)))
            for ref in refs:
                target = resolve_reference(ref, binary, root)
                if target and architecture not in output("lipo", "-archs", str(target)).split():
                    raise ValueError(f"missing {architecture} slice: {target}")
            paths = runpaths(output("otool", "-arch", architecture, "-l", str(binary)))
            for path in paths:
                if path != "@loader_path" and not is_system(path):
                    raise ValueError(f"unsafe rpath: {binary.name}: {path}")
            slices[architecture] = {"dependencies": refs, "rpaths": paths}
        records[binary.name] = {"sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "slices": slices}
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2))
