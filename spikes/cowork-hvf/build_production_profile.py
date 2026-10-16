"""Reproducible offline build and static checks of the production-profile libkrun archive.

Builds the static archive twice (the production features, and the fixture-oracle features), from the
hash-checked composed source with the pinned offline toolchain and the locked offline crate cache, with
fixed profile settings and --remap-path-prefix. Then it rebuilds the production archive from a second
copy of the source, toolchain and crate cache at a different absolute location and requires the two to
be bit-identical. It strips the archive, checks the exports (no fixture symbol in production), checks
that no builder path survives in the archive or in a linked and stripped Mach-O, links the C ABI probes
and runs them. The probes never call krun_start_enter, create no VM and call no Hypervisor.framework
function. No worker, launcher, signing identity or VM is involved; probes are signed only by the linker
(ad hoc).
"""
import argparse, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
from build import ROOT, OUT, digest
from prepare_production_profile import prepare
from production_profile_lib import (FIXTURE_EXPORTS, builder_tokens, PRODUCTION_EXPORTS, RELEASE_PROFILE, build_staticlib, check_toolchain, exports,
                                    git, load_candidate, normalizer, path_findings, release_env, strings_of, trace_rows_in,
                                    verify_registry, verify_toolchain_against_archive)

PRODUCTION_DIR = OUT / 'production-profile'
LINK = ['-framework', 'Hypervisor', '-liconv', '-lSystem', '-lc', '-lm']


def strip_copy(raw, destination):
    """Apple strip rewrites the archive table of contents with the current time unless ZERO_AR_DATE is set."""
    shutil.copy2(raw, destination)
    subprocess.run(['/usr/bin/strip', '-S', str(destination)], check=True, env={**os.environ, 'ZERO_AR_DATE': '1'})
    return destination


def native_static_libs(source, root):
    """The system libraries rustc says a staticlib consumer must link (recorded, and used to link the probes)."""
    target = PRODUCTION_DIR / 'target-native-libs'
    env = release_env(source, root, target)
    command = [str(root / 'rust/bin/cargo'), 'rustc', '--manifest-path', str(source / 'Cargo.toml'), '-p', 'libkrun', '--release', '--locked', '--offline', '--no-default-features', '--features', 'blk', '--jobs', '4', '--crate-type', 'staticlib', '--', '--print', 'native-static-libs']
    result = subprocess.run(command, env=env, cwd=source, capture_output=True, text=True, check=True)
    line = [l for l in result.stderr.splitlines() if 'native-static-libs:' in l]
    return line[0].split('native-static-libs:', 1)[1].strip() if line else ''


def link_probe(source, archive, c_file, destination, defines=()):
    command = ['/usr/bin/clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', *defines, '-I', str(source / 'include'), str(c_file), str(archive), *LINK, '-o', str(destination)]
    subprocess.run(command, check=True)
    return destination


def run_probe(binary):
    """Run a probe that never calls krun_start_enter. Its stdout is one JSON receipt."""
    result = subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=30)
    receipt = json.loads(result.stdout)
    if receipt.get('vmStarted') is not False or receipt.get('krunStartEnterCalled', False) is not False:
        raise RuntimeError('Invalid no-VM probe receipt')
    return receipt


def header_checks(source, scratch):
    """Header contract: C++ double include and layout, production names always visible, fixture names only with the oracle macro."""
    cpp = Path(scratch) / 'header.cpp'
    cpp.write_text('#include "libkrun.h"\n#include "libkrun.h"\n#include <cstddef>\nstatic_assert(sizeof(krun_cowork_volume_identity)==32);\nstatic_assert(offsetof(krun_cowork_volume_identity,uid)==24);\nstatic_assert(KRUN_COWORK_PRODUCTION_VCPUS==2);\nauto a=&krun_cowork_enable_production_profile;\nauto b=&krun_cowork_create_runtime_port;\nauto c=&krun_cowork_set_workspace_disks;\nauto d=&krun_cowork_validate_production_profile;\n')
    subprocess.run(['/usr/bin/clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', '-I', str(source / 'include'), str(cpp)], check=True)
    hidden = Path(scratch) / 'hidden.c'
    hidden.write_text('#include "libkrun.h"\nint f(void){return krun_enable_cowork_block_fixture_reclaim(0)+krun_create_cowork_runtime_stream(0)+krun_enable_cowork_runtime_port_fixture_trace(0);}\n')
    plain = subprocess.run(['/usr/bin/clang', '-std=c11', '-Werror=implicit-function-declaration', '-fsyntax-only', '-I', str(source / 'include'), str(hidden)], capture_output=True, text=True)
    oracle = subprocess.run(['/usr/bin/clang', '-std=c11', '-Werror=implicit-function-declaration', '-DKRUN_COWORK_FIXTURE_ORACLE', '-fsyntax-only', '-I', str(source / 'include'), str(hidden)], capture_output=True, text=True)
    if plain.returncode == 0 or oracle.returncode != 0:
        raise RuntimeError('Fixture entry points must be hidden from the header unless KRUN_COWORK_FIXTURE_ORACLE is defined')
    return {'cppDoubleIncludeAndLayout': True, 'fixtureNamesHiddenWithoutOracleMacro': True, 'fixtureNamesDeclaredWithOracleMacro': True}


def inspect_archive(label, raw, stripped, expect_oracle):
    found = exports(stripped)
    fixture_present = sorted(name for name in found if 'fixture' in name or name in FIXTURE_EXPORTS)
    if exports(raw) != found:
        raise RuntimeError('strip -S changed the exported symbols')
    if sorted(name for name in found if 'cowork' in name and name not in FIXTURE_EXPORTS) != PRODUCTION_EXPORTS:
        raise RuntimeError(f'{label}: production exports are not exactly {PRODUCTION_EXPORTS}')
    if expect_oracle and not set(FIXTURE_EXPORTS) <= set(found):
        raise RuntimeError('Oracle archive lacks fixture entry points')
    if not expect_oracle and fixture_present:
        raise RuntimeError(f'Production archive exports fixture symbols: {fixture_present}')
    blob_raw, blob_stripped = strings_of(raw), strings_of(stripped)
    rows = trace_rows_in(blob_stripped)
    if expect_oracle and not rows:
        raise RuntimeError('Oracle archive must carry the fixture block trace rows')
    if not expect_oracle and rows:
        raise RuntimeError(f'Production archive carries fixture block trace rows: {rows}')
    findings_stripped = path_findings(blob_stripped, builder_tokens())
    if findings_stripped:
        raise RuntimeError(f'{label}: builder paths survive in the stripped archive: {findings_stripped}')
    return {'rawArchiveSha256': digest(raw), 'strippedArchiveSha256': digest(stripped), 'strippedSizeBytes': stripped.stat().st_size,
            'cowork': [name for name in found if 'cowork' in name], 'fixtureSymbolsExported': fixture_present, 'blockTraceRowStrings': rows,
            'rawArchivePathFindings': path_findings(blob_raw, builder_tokens()), 'strippedArchivePathFindings': findings_stripped, 'exportCount': len(found)}


def reproduce(source, root, destination, features):
    """Rebuild from a copy of the source, the toolchain and the crate cache at a different absolute location."""
    destination = Path(destination)
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    second_source, second_root = destination / 'src', destination
    shutil.copytree(source, second_source, ignore=shutil.ignore_patterns('target', '.git'), symlinks=True)
    shutil.copytree(root / 'cargo-home', destination / 'cargo-home', symlinks=True)
    shutil.copytree(root / 'rust', destination / 'rust', symlinks=True)
    archive = build_staticlib(second_source, second_root, destination / 'target', features)
    stripped = strip_copy(archive, destination / 'libkrun-stripped.a')
    return archive, stripped


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--toolchain-archive', help='local rust-1.90.0-aarch64-apple-darwin.tar.xz to prove the installed toolchain against')
    parser.add_argument('--repro-root', default=str(OUT / 'repro-b'), help='second absolute location for the reproduction build')
    parser.add_argument('--keep-repro', action='store_true')
    args = parser.parse_args()
    source = prepare()
    pin = load_candidate()
    toolchain = check_toolchain()
    toolchain_pin = verify_toolchain_against_archive(args.toolchain_archive) if args.toolchain_archive else {'archiveSha256': pin['toolchain']['archiveSha256'], 'installedMatchesArchive': 'not checked: no local archive given'}
    registry = verify_registry(source)
    PRODUCTION_DIR.mkdir(exist_ok=True)
    receipt = {'candidate': {'status': pin['status'], 'fullSourceDiffSha256': pin['fullSourceDiffSha256'], 'patches': {p['patchFile']: p['patchSha256'] for p in pin['basePatches'] + pin['newPatches']}},
               'vmStarted': False, 'workerBuilt': False, 'krunStartEnterCalled': False, 'signedWithDeveloperIdentity': False, 'productionReady': False,
               'toolchain': {**toolchain, **toolchain_pin}, 'registry': registry,
               'recipe': {'command': 'cargo rustc -p libkrun --release --locked --offline --no-default-features --features <features> --jobs 4 --crate-type staticlib', 'features': pin['features'], 'profileEnvironment': RELEASE_PROFILE,
                          'remapPathPrefix': ['<source>=/libkrun', '<cargo-home>=/cargo-home', '<rust>=/rust-toolchain'], 'strip': 'ZERO_AR_DATE=1 /usr/bin/strip -S (archive); /usr/bin/strip -x (linked probe, inspection copy only)'}}
    receipt['recipe']['nativeStaticLibs'] = native_static_libs(source, OUT)
    built = {}
    for label, features in [('production', pin['features']['production']), ('fixtureOracle', pin['features']['oracle'])]:
        archive = build_staticlib(source, OUT, PRODUCTION_DIR / f'target-{label}', features)
        raw = PRODUCTION_DIR / f'libkrun-{label}-raw.a'
        shutil.copy2(archive, raw)
        stripped = strip_copy(raw, PRODUCTION_DIR / f'libkrun-{label}.a')
        built[label] = (raw, stripped)
        receipt[label] = inspect_archive(label, raw, stripped, label == 'fixtureOracle')
    # Reproduction at a second location: bit-identical raw and stripped archives.
    raw_b, stripped_b = reproduce(source, OUT, args.repro_root, pin['features']['production'])
    receipt['reproduction'] = {'firstSourceRoot': 'out/libkrun-production-profile', 'secondLocation': str(Path(args.repro_root)),
                               'rawArchiveSha256': [digest(built['production'][0]), digest(raw_b)], 'strippedArchiveSha256': [digest(built['production'][1]), digest(stripped_b)],
                               'rawIdentical': digest(built['production'][0]) == digest(raw_b), 'strippedIdentical': digest(built['production'][1]) == digest(stripped_b)}
    if not (receipt['reproduction']['rawIdentical'] and receipt['reproduction']['strippedIdentical']):
        raise RuntimeError('Archive is not reproducible across build locations')
    if not args.keep_repro:
        shutil.rmtree(args.repro_root, ignore_errors=True)
    # Header contract and linked probes.
    with tempfile.TemporaryDirectory(prefix='production-probe-', dir=PRODUCTION_DIR) as scratch:
        receipt['header'] = header_checks(source, scratch)
    production_probe = link_probe(source, built['production'][1], ROOT / 'workspace_disks_production_abi_smoke.c', PRODUCTION_DIR / 'production-abi-smoke')
    oracle_probe = link_probe(source, built['fixtureOracle'][1], ROOT / 'workspace_disks_abi_smoke.c', PRODUCTION_DIR / 'fixture-oracle-abi-smoke', ['-DKRUN_COWORK_FIXTURE_ORACLE'])
    # Name-scan stand-in: a Mach-O that only links the archive (no probe strings of its own), unstripped and
    # stripped the way a shipped worker is. It references every production export so the archive is pulled in.
    link_scan_c = PRODUCTION_DIR / 'link-scan.c'
    link_scan_c.write_text('#include "libkrun.h"\nstatic volatile void *keep[]={(void*)krun_cowork_enable_production_profile,(void*)krun_cowork_create_runtime_port,(void*)krun_cowork_set_workspace_disks,(void*)krun_cowork_validate_production_profile};\nint main(void){return keep[0]==0;}\n')
    link_scan = link_probe(source, built['production'][1], link_scan_c, PRODUCTION_DIR / 'link-scan')
    stripped_scan = PRODUCTION_DIR / 'link-scan-stripped'
    shutil.copy2(link_scan, stripped_scan)
    subprocess.run(['/usr/bin/strip', '-x', str(stripped_scan)], check=True)
    linked = {'unstripped': path_findings(strings_of(link_scan), builder_tokens()), 'strippedCopy': path_findings(strings_of(stripped_scan), builder_tokens()), 'unstrippedSizeBytes': link_scan.stat().st_size, 'strippedSizeBytes': stripped_scan.stat().st_size}
    if linked['unstripped'] or linked['strippedCopy']:
        raise RuntimeError(f'Builder paths survive in the linked Mach-O: {linked}')
    if trace_rows_in(strings_of(link_scan)):
        raise RuntimeError('Fixture block trace rows survive in the linked production Mach-O')
    libraries = subprocess.check_output(['/usr/bin/otool', '-L', str(link_scan)], text=True).splitlines()[1:]
    receipt['probes'] = {'production': run_probe(production_probe), 'fixtureOracle': run_probe(oracle_probe),
                         'linkedMachOPathFindings': linked, 'linkedMachOLibraries': [line.strip().split(' (')[0] for line in libraries],
                         'productionProbeSha256': digest(production_probe), 'linkScanSha256': digest(link_scan)}
    if any(not (name.startswith('/usr/lib/') or name.startswith('/System/Library/')) for name in receipt['probes']['linkedMachOLibraries']):
        raise RuntimeError('Probe links a non-platform library')
    (PRODUCTION_DIR / 'build.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
    return receipt


if __name__ == '__main__':
    main()
