"""The only script that uses the network. Fetches and verifies the pinned build inputs into out/ (ignored by git):

  * the libkrun source archive at the pinned commit (SHA-256 checked), committed into a local git repository whose
    tree object must equal the pinned tree, so the preparer can `git apply` and diff;
  * the Rust toolchain archive (SHA-256 checked) installed into out/rust;
  * the crates Cargo.lock names (`cargo fetch --locked`; every crate's checksum is compared with Cargo.lock).

Everything else (prepare_queue.py, build_archive.py, run_cargo_tests.py) is offline. Files already present in
out/ with the right hash are reused, so an air-gapped machine can be seeded by copying them. Starts nothing.
"""
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))  # `python3 -I` drops the script directory
import argparse, os, shutil, subprocess, tarfile, urllib.request
from pathlib import Path
from libkrun_common import OUT, PINS, checked, git, verify, verify_registry

COMMITTER = ['-c', 'user.name=libkrun-pin', '-c', 'user.email=libkrun-pin@invalid', '-c', 'commit.gpgsign=false']


def download(url, destination, sha256):
    destination = Path(destination)
    if not destination.exists():
        urllib.request.urlretrieve(url, destination)
    verify(destination, sha256)
    return destination


def fetch_libkrun():
    pin = PINS['libkrun']
    source = OUT / 'libkrun'
    if source.exists():
        if git(source, 'rev-parse', 'HEAD^{tree}').strip() != pin['treeSha1']:
            raise RuntimeError('out/libkrun is not the pinned tree; remove it and run again')
        return source
    archive = download(pin['archiveUrl'], OUT / f"libkrun-{pin['revision']}.tar.gz", pin['archiveSha256'])
    staging = OUT / 'libkrun-staging'
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(staging, filter='data')
    (root,) = list(staging.iterdir())
    checked(['git', 'init', '-q', root])
    checked(['git', '-C', root, 'add', '-A'])
    checked(['git', *COMMITTER, '-C', root, 'commit', '-q', '-m', f"libkrun {pin['version']} ({pin['revision']})"])
    if git(root, 'rev-parse', 'HEAD^{tree}').strip() != pin['treeSha1']:
        raise RuntimeError('The archive does not contain the pinned tree')
    verify(root / 'Cargo.lock', pin['lockSha256'])
    root.rename(source)
    staging.rmdir()
    return source


def fetch_toolchain():
    pin = PINS['rust']
    name = f"rust-{pin['version']}-{pin['host']}"
    archive = download(pin['url'], OUT / f'{name}.tar.xz', pin['sha256'])
    extracted, rust = OUT / name, OUT / 'rust'
    if not extracted.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(OUT, filter='data')
    # The upstream install.sh mishandles prefixes containing spaces: install the manifest entries directly.
    for component in ['rustc', 'cargo', f"rust-std-{pin['host']}"]:
        for line in (extracted / component / 'manifest.in').read_text().splitlines():
            kind, relative = line.split(':', 1)
            source, destination = extracted / component / relative, rust / relative
            if not destination.exists():
                destination.parent.mkdir(parents=True, exist_ok=True)
                if kind == 'dir':
                    shutil.copytree(source, destination)
                else:
                    shutil.copy2(source, destination)


def fetch_crates(source):
    env = os.environ.copy()
    env.update(PATH=f"{OUT / 'rust/bin'}:{env['PATH']}", CARGO_HOME=str(OUT / 'cargo-home'))
    checked([OUT / 'rust/bin/cargo', 'fetch', '--locked', '--manifest-path', source / 'Cargo.toml'], env=env)
    return verify_registry(source)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--source-only', action='store_true', help='fetch and verify only the pinned libkrun source (any host; no toolchain, no crates)')
    args = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    if args.source_only:
        fetch_libkrun()
        return
    if os.uname().sysname != 'Darwin' or os.uname().machine != 'arm64':
        raise RuntimeError('Apple Silicon macOS required')
    source = fetch_libkrun()
    fetch_toolchain()
    print(fetch_crates(source))


if __name__ == '__main__':
    main()
