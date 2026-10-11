#!/usr/bin/env python3
"""Record upstream Git identity, exact vendored hashes and a reconstruction patch."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import re

COMMIT = "390848f47391f412451b2d259d8527fabb51e5e3"
TREE = "0509386ab50c032b58f5af4576f8ee5f79157c51"
URL = "https://gitlab.freedesktop.org/slirp/libslirp.git"
HERE = Path(__file__).resolve().parent
VENDOR_PATH = "apple/Cowork/WinterCoworkNetwork/vendor/libslirp"
PIN_PATH = "apple/Cowork/packaging/libslirp-vendor-pin.json"


def verify_committed_vendor(repository, built_commit, vendor, pin_path):
    """Pin authority comes from Git objects, not whatever JSON is in the tree."""
    if not re.fullmatch(r"[a-f0-9]{40}", built_commit):
        raise ValueError("full built Git commit required")
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0", GIT_NO_REPLACE_OBJECTS="1")
    def git(*args):
        return subprocess.check_output(["git", "--no-optional-locks", "-C", repository,
            "-c", "core.fsmonitor=false", *args], env=env)
    if git("status", "--porcelain", "--untracked-files=all", "--", VENDOR_PATH, "apple/Cowork/packaging"):
        raise ValueError("dirty vendor/packaging cannot authorize a protected package")
    committed = git("show", f"{built_commit}:{PIN_PATH}")
    if pin_path.read_bytes() != committed:
        raise ValueError("vendor pin differs from the built commit")
    pin = json.loads(committed)
    reviewed = pin.get("reviewedVendorCommit", "")
    if not re.fullmatch(r"[a-f0-9]{40}", reviewed):
        raise ValueError("full reviewed vendor Git commit required")
    # A shared worktree object database can contain a matching, unpublished
    # commit that a clean clone of this build cannot resolve. Pin only history
    # reachable from the built revision, in addition to checking its bytes.
    try:
        git("merge-base", "--is-ancestor", reviewed, built_commit)
    except subprocess.CalledProcessError as error:
        raise ValueError("reviewed vendor Git commit must be an ancestor of the built commit") from error
    hashes = {}
    total = 0
    for entry in git("ls-tree", "-r", "-z", reviewed, "--", VENDOR_PATH).split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        path = name.decode()
        if kind != "blob" or mode not in ("100644", "100755") or not path.startswith(VENDOR_PATH + "/"):
            raise ValueError("reviewed vendor contains an unsupported Git object/alias")
        size = int(git("cat-file", "-s", oid))
        total += size
        if size > 2 * 1024 * 1024 or total > 16 * 1024 * 1024 or len(hashes) >= 256:
            raise ValueError("reviewed vendor Git object inventory exceeds its bound")
        hashes[path[len(VENDOR_PATH) + 1:]] = hashlib.sha256(git("cat-file", "blob", oid)).hexdigest()
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if digest != pin.get("vendoredTreeSha256") or len(hashes) != pin.get("vendoredFileCount"):
        raise ValueError("reviewedVendorCommit contents do not match the committed pin")
    return verify_vendor(vendor, pin_path)


def tree_hashes(root):
    if root.is_symlink() or any(p.is_symlink() for p in root.rglob("*")):
        raise ValueError("vendored source symlinks are refused")
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def verify_vendor(vendor, pin_path=HERE / "libslirp-vendor-pin.json"):
    pin = json.loads(pin_path.read_text())
    if pin.get("format") != 1 or pin.get("upstreamCommit") != COMMIT or pin.get("upstreamGitTree") != TREE:
        raise ValueError("committed vendor pin format/upstream mismatch")
    files = tree_hashes(vendor)
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if digest != pin.get("vendoredTreeSha256") or len(files) != pin.get("vendoredFileCount"):
        raise ValueError("vendored source differs from the committed reviewed hash")
    return pin


def generate(vendor, destination, upstream=None, pin_path=HERE / "libslirp-vendor-pin.json"):
    pin = verify_vendor(vendor, pin_path)
    destination.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
    if upstream is None:
        upstream = destination / "upstream-checkout"
        subprocess.run(["git", "init", "-q", upstream], env=env, check=True)
        subprocess.run(["git", "-C", upstream, "-c", "credential.helper=", "fetch", "--depth=1", URL, COMMIT], env=env, check=True)
        subprocess.run(["git", "-C", upstream, "checkout", "-q", "--detach", "FETCH_HEAD"], env=env, check=True)
    identity = subprocess.check_output(["git", "-C", upstream, "rev-parse", "HEAD"], env=env, text=True).strip()
    tree = subprocess.check_output(["git", "-C", upstream, "rev-parse", "HEAD^{tree}"], env=env, text=True).strip()
    if identity != COMMIT or tree != pin["upstreamGitTree"] or subprocess.check_output(["git", "-C", upstream, "status", "--porcelain"], env=env):
        raise ValueError("upstream must be the exact clean pinned commit")
    with (destination / "libslirp-upstream.tar").open("wb") as stream:
        subprocess.run(["git", "-C", upstream, "archive", "--format=tar", COMMIT], env=env, check=True, stdout=stream)
    with tempfile.TemporaryDirectory(prefix="patch-", dir=destination) as tmp:
        work = Path(tmp)
        base, modified = work / "a", work / "b"
        base.mkdir()
        for name in ("src", "LICENSE", "COPYRIGHT"):
            source = upstream / name
            if source.is_dir():
                shutil.copytree(source, base / name)
            else:
                shutil.copyfile(source, base / name)
        shutil.copytree(vendor, modified)
        original = tree_hashes(base)
        expected = tree_hashes(modified)
        result = subprocess.run(["git", "diff", "--no-index", "--binary", "--src-prefix=", "--dst-prefix=", "a", "b"],
                                cwd=work, env=env, stdout=subprocess.PIPE)
        if result.returncode not in (0, 1):
            raise ValueError("upstream comparison failed")
        patch = destination / "winter-libslirp.patch"
        patch.write_bytes(result.stdout)
        verify = work / "verify"
        shutil.copytree(base, verify)
        # Prevent git apply from silently filtering paths against the enclosing
        # Winter repository's subdirectory prefix.
        subprocess.run(["git", "init", "-q", work], env=env, check=True)
        if result.stdout:
            subprocess.run(["git", "apply", "--directory=verify", patch.resolve()], cwd=work, env=env, check=True)
        actual = tree_hashes(verify)
        if actual != expected:
            mismatched = [name for name in sorted(set(actual) | set(expected)) if actual.get(name) != expected.get(name)]
            raise ValueError(f"patch failed to reconstruct the exact vendored tree: {mismatched}")
        subprocess.run(["git", "add", "-f", "--", "b", "verify"], cwd=work, env=env, check=True)
        vendor_git_tree = subprocess.check_output(["git", "write-tree", "--prefix=b/"], cwd=work, env=env, text=True).strip()
        rebuilt_git_tree = subprocess.check_output(["git", "write-tree", "--prefix=verify/"], cwd=work, env=env, text=True).strip()
        if vendor_git_tree != rebuilt_git_tree:
            raise ValueError("patch tree modes/symlinks differ from the vendored Git tree")
    manifest = {"format": 1, "upstreamVersion": "4.9.5", "upstreamURL": URL,
        "upstreamCommit": COMMIT, "upstreamGitTree": tree,
        "archiveSha256": hashlib.sha256((destination / "libslirp-upstream.tar").read_bytes()).hexdigest(),
        "archiveHashAuthority": "locally computed git archive hash; Git commit/tree identity verified, publisher signature not verified",
        "patchSha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
        "baseProjection": "upstream src/, LICENSE, COPYRIGHT; patch also contains generated/local files",
        "upstreamProjectionHashes": original, "vendoredHashes": expected,
        "vendoredGitTree": vendor_git_tree,
        "vendoredTreeSha256": hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "committedVendorPin": pin,
        "patchReconstructionVerified": True}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if (destination / "upstream-checkout").exists():
        shutil.rmtree(destination / "upstream-checkout")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--vendor", type=Path, default=HERE.parent / "WinterCoworkNetwork/vendor/libslirp")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--upstream-checkout", type=Path)
    args = parser.parse_args()
    repository = HERE.parents[2]
    built_commit = subprocess.check_output(["git", "-C", repository, "rev-parse", "HEAD"], text=True).strip()
    verify_committed_vendor(repository, built_commit, args.vendor.resolve(), HERE / "libslirp-vendor-pin.json")
    manifest = generate(args.vendor.resolve(), args.destination.resolve(), args.upstream_checkout.resolve() if args.upstream_checkout else None)
    print(json.dumps({"upstreamGitTree": manifest["upstreamGitTree"], "vendoredGitTree": manifest["vendoredGitTree"], "vendoredTreeSha256": manifest["vendoredTreeSha256"],
                      "patchSha256": manifest["patchSha256"], "patchReconstructionVerified": True}, indent=2))
