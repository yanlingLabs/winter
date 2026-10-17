"""Shared offline helpers for the N2 libkrun production-profile scripts.

Nothing in here starts a VM, calls Hypervisor.framework, runs a worker or downloads anything. The
scripts that import it only compose pinned source, compile, link C probes that never call
krun_start_enter, and inspect the results.
"""
import getpass, hashlib, io, json, os, re, shutil, subprocess, tarfile, tempfile
from pathlib import Path
from build import ROOT, OUT, PINS, checked, digest, verify

CANDIDATE = ROOT / 'production-profile-candidate.json'
# Fixed so that every git diff the scripts compare against a committed patch abbreviates object ids
# the same way the patches were written (repositories this small default to 7).
GIT = ['git', '-c', 'core.abbrev=7']
# Strings a shipped Mach-O must not carry: builder home, volume and temp paths. The builder's own user and
# home directory names are added at run time (builder_tokens) so no personal name is written into the repository.
FORBIDDEN_PATH = re.compile(rb'(/Users/|/private/|/var/folders/|/Volumes/|/home/|/Applications/|/opt/homebrew|/tmp/)')
# The fixture-only block trace and reclaim rows. Present in the oracle archive, absent from production.
TRACE_ROWS = [b'block_request_capture', b'block_owned_io_begin', b'block_owned_io_end', b'block_owned_completion_hold', b'block_used_ack', b'block_ring_pin', b'block_freeze_pin', b'block_trace_overflow',
              b'reclaim_failure', b'reclaim_parked', b'reclaim_disposition', b'reclaim_resumed', b'reclaim_unmap', b'reclaim_replace', b'reclaim_map', b'reclaim_exclusion', b'reclaim_used_ack']
PRODUCTION_EXPORTS = ['_krun_cowork_create_runtime_port_v1', '_krun_cowork_enable_profile_v1', '_krun_cowork_get_flush_counters_v1', '_krun_cowork_get_pin_counters_v1',
                      '_krun_cowork_set_exit_hook_v1', '_krun_cowork_set_workspace_disks_v1', '_krun_cowork_validate_profile_v1']
FIXTURE_EXPORTS = ['_krun_create_cowork_bootstrap_stream', '_krun_create_cowork_runtime_stream', '_krun_enable_cowork_block_fixture_reclaim', '_krun_enable_cowork_fixture_reclaim', '_krun_enable_cowork_runtime_port_fixture_trace', '_krun_set_cowork_bootstrap_stream', '_krun_set_cowork_workspace_disks']


def load_candidate():
    return json.loads(CANDIDATE.read_text())


def git(source, *args, env=None, text=True, check=True):
    result = subprocess.run([*GIT, '-C', str(source), *map(str, args)], env=env, capture_output=True, check=check)
    return result.stdout.decode() if text else result.stdout


# ---- toolchain and dependency pins -------------------------------------------------------------

def toolchain_env(root=OUT, extra=None):
    env = os.environ.copy()
    env.update(PATH=f"{root / 'rust/bin'}:{env['PATH']}", CARGO_HOME=str(root / 'cargo-home'), CARGO_NET_OFFLINE='true')
    env.update(extra or {})
    return env


def check_toolchain(root=OUT):
    """The installed compiler must be exactly the pinned rustc/cargo; no other toolchain is used."""
    pin = load_candidate()['toolchain']
    env = toolchain_env(root)
    verbose = subprocess.check_output([str(root / 'rust/bin/rustc'), '-vV'], env=env, text=True)
    fields = dict(line.split(': ', 1) for line in verbose.splitlines() if ': ' in line)
    if fields.get('release') != pin['release'] or fields.get('commit-hash') != pin['commitHash'] or fields.get('host') != pin['host']:
        raise RuntimeError('Unexpected rustc: ' + verbose)
    cargo = subprocess.check_output([str(root / 'rust/bin/cargo'), '--version'], env=env, text=True).strip()
    if not cargo.startswith('cargo ' + pin['release'] + ' '):
        raise RuntimeError('Unexpected cargo: ' + cargo)
    return {'rustc': fields['release'] + ' ' + fields['commit-hash'], 'host': fields['host'], 'cargo': cargo}


def verify_toolchain_against_archive(archive, root=OUT):
    """Prove the installed rustc, cargo and rust-std are byte-identical to the checksum-pinned archive."""
    archive = Path(archive)
    verify(archive, PINS['rust']['sha256'])
    compared = 0
    with tempfile.TemporaryDirectory(prefix='rust-pin-', dir=root) as directory:
        with tarfile.open(archive) as tar:
            tar.extractall(directory, filter='data')
        extracted = Path(directory) / 'rust-1.90.0-aarch64-apple-darwin'
        for component in ['rustc', 'cargo', 'rust-std-aarch64-apple-darwin']:
            for line in (extracted / component / 'manifest.in').read_text().splitlines():
                kind, relative = line.split(':', 1)
                if kind != 'file':
                    continue
                if digest(extracted / component / relative) != digest(root / 'rust' / relative):
                    raise RuntimeError('Installed toolchain differs from the pinned archive: ' + relative)
                compared += 1
    return {'archiveSha256': PINS['rust']['sha256'], 'filesCompared': compared}


def verify_registry(source, root=OUT):
    """Every cached crate must match Cargo.lock's checksum and its unpacked source must be byte-identical."""
    lock = (Path(source) / 'Cargo.lock').read_text()
    expected = {}
    for block in lock.split('[[package]]')[1:]:
        name = re.search(r'name = "([^"]+)"', block).group(1)
        version = re.search(r'version = "([^"]+)"', block).group(1)
        checksum = re.search(r'checksum = "([0-9a-f]{64})"', block)
        if checksum:
            expected[f'{name}-{version}'] = checksum.group(1)
    cache_dirs = sorted((root / 'cargo-home/registry/cache').iterdir())
    src_dirs = sorted((root / 'cargo-home/registry/src').iterdir())
    if len(cache_dirs) != 1 or len(src_dirs) != 1:
        raise RuntimeError('Exactly one offline registry is expected')
    verified = 0
    for crate in sorted(cache_dirs[0].glob('*.crate')):
        stem = crate.name[:-len('.crate')]
        if stem not in expected:
            raise RuntimeError('Cached crate absent from Cargo.lock: ' + stem)
        if hashlib.sha256(crate.read_bytes()).hexdigest() != expected[stem]:
            raise RuntimeError('Crate checksum differs from Cargo.lock: ' + stem)
        unpacked = src_dirs[0] / stem
        with tarfile.open(crate) as tar:
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                relative = member.name.split('/', 1)[1]
                if (unpacked / relative).read_bytes() != tar.extractfile(member).read():
                    raise RuntimeError(f'Unpacked crate source differs from its archive: {stem}/{relative}')
        verified += 1
    if verified == 0:
        raise RuntimeError('No cached crates verified')
    return {'cargoLockSha256': digest(Path(source) / 'Cargo.lock'), 'cachedCratesVerified': verified, 'lockedChecksums': len(expected)}


# ---- release recipe -----------------------------------------------------------------------------

RELEASE_PROFILE = {
    'CARGO_INCREMENTAL': '0',
    'CARGO_PROFILE_RELEASE_DEBUG': '0',
    'CARGO_PROFILE_RELEASE_STRIP': 'none',
    'CARGO_PROFILE_RELEASE_LTO': 'true',
    'CARGO_PROFILE_RELEASE_CODEGEN_UNITS': '1',
    'CARGO_PROFILE_RELEASE_PANIC': 'unwind',
    'CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS': 'true',
    'CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS': 'false',
    'SOURCE_DATE_EPOCH': '1760000000',
    'LC_ALL': 'C',
    'TZ': 'UTC',
}


def release_env(source, root, target):
    """Environment of the reproducible release build. Path prefixes are remapped to fixed virtual roots."""
    unit_separator = '\x1f'  # CARGO_ENCODED_RUSTFLAGS, because the real paths may contain spaces
    flags = [f'--remap-path-prefix={source}=/libkrun', f'--remap-path-prefix={root}/cargo-home=/cargo-home', f'--remap-path-prefix={root}/rust=/rust-toolchain']
    env = toolchain_env(root, RELEASE_PROFILE)
    env.update(CARGO_TARGET_DIR=str(target), CARGO_ENCODED_RUSTFLAGS=unit_separator.join(flags))
    env.pop('RUSTFLAGS', None)
    return env


def build_staticlib(source, root, target, features):
    command = [str(root / 'rust/bin/cargo'), 'rustc', '--manifest-path', str(Path(source) / 'Cargo.toml'), '-p', 'libkrun', '--release', '--locked', '--offline', '--no-default-features', '--features', features, '--jobs', '4', '--crate-type', 'staticlib']
    subprocess.run(command, check=True, env=release_env(source, root, target), cwd=source)
    return Path(target) / 'release/libkrun.a'


# ---- inspections ----------------------------------------------------------------------------------

def exports(archive):
    output = subprocess.check_output(['/usr/bin/nm', '-g', str(archive)], text=True, stderr=subprocess.DEVNULL)
    return sorted({line.split()[-1] for line in output.splitlines() if ' T _krun_' in line})


def strings_of(path):
    return subprocess.check_output(['/usr/bin/strings', '-a', str(path)])


def builder_tokens():
    """The builder's login and home-directory names, found at run time."""
    names = {getpass.getuser(), os.path.basename(os.path.expanduser('~'))}
    return sorted(name.encode() for name in names if len(name) >= 4)


def path_findings(blob, extra=()):
    """Distinct absolute-path tokens (and any extra builder-name token) in a strings dump that the release name scan would object to."""
    found = set()
    pattern = re.compile(b'|'.join([FORBIDDEN_PATH.pattern, *[re.escape(token) for token in extra]]), re.I if extra else 0)
    for token in re.findall(rb'[ -~]{4,}', blob):
        for match in pattern.finditer(token):
            start = max(0, match.start() - 8)
            found.add(token[start:match.end() + 24].decode('ascii', 'replace'))
    return sorted(found)


def trace_rows_in(blob):
    return sorted(row.decode() for row in TRACE_ROWS if row in blob)


def normalizer(*pairs):
    """Replace builder-specific absolute prefixes with placeholders; longest prefix first."""
    ordered = sorted(pairs, key=lambda pair: -len(pair[0]))

    def apply(text):
        for real, placeholder in ordered:
            text = text.replace(real, placeholder)
        return text
    return apply
