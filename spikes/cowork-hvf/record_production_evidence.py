"""Copy the production-profile receipts and logs into results/ with builder paths normalized.

Reads the (git-ignored) outputs of test_production_profile.py and build_production_profile.py under
out/, replaces every builder-specific absolute prefix with a placeholder, refuses to write a file that
still contains a home, volume or temp path, writes the libkrun.h diff against the admitted 0013
composition, and refreshes the productionProfile block of api-inventory.json. Offline; starts nothing.
"""
import json, os, re, sys, tempfile
from pathlib import Path
from build import ROOT, OUT
from prepare_production_profile import prepare, tree_after
from production_profile_lib import FORBIDDEN_PATH, PRODUCTION_EXPORTS, FIXTURE_EXPORTS, builder_tokens, git, load_candidate, normalizer

DATE = '2026-10-17'
RESULTS = ROOT / 'results'
PRODUCTION_DIR = OUT / 'production-profile'


def make_normalizer(extra=()):
    worktree = ROOT.parents[1]
    # The raw archive's prebuilt compiler_builtins members carry the Rust project's own CI Xcode path in
    # their debug stabs; strip -S removes it. Recorded under a placeholder so the receipt stays path-free.
    pairs = [(str(worktree), '<WORKTREE>'), (os.path.expanduser('~'), '<HOME>'), ('/Applications/Xcode_15.4.app', '<RUST-TOOLCHAIN-CI-XCODE>'), *extra]
    pairs += [(str(Path(p).resolve()), placeholder) for p, placeholder in extra]
    return normalizer(*pairs)


def personal():
    """The builder's login and home-directory names (found at run time), plus any e-mail address."""
    return re.compile(b'|'.join([*[re.escape(t) for t in builder_tokens()], rb'[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[a-z]{2,}']), re.I)


def checked_write(path, text):
    """These files are committed to a public repository: no builder path, home path or personal name may survive."""
    leftovers = FORBIDDEN_PATH.findall(text.encode()) + [m.group(0) for m in personal().finditer(text.encode())]
    if leftovers:
        raise RuntimeError(f'{path.name} still carries builder or personal strings: {sorted(set(map(bytes.decode, leftovers)))}')
    path.write_text(text)


def header_diff(source, pin):
    names = [p['patchFile'] for p in pin['basePatches'] + pin['newPatches']]
    with tempfile.TemporaryDirectory(prefix='header-diff-', dir=OUT) as scratch:
        before = tree_after(source, names[:len(pin['basePatches'])], scratch)
        after = tree_after(source, names, scratch)
        return git(source, 'diff', '--no-ext-diff', before, after, '--', 'include/libkrun.h')


def main(extra_prefixes=()):
    source = prepare()
    pin = load_candidate()
    norm = make_normalizer(extra_prefixes)
    RESULTS.mkdir(exist_ok=True)
    build = json.loads((PRODUCTION_DIR / 'build.json').read_text())
    tests = json.loads((OUT / 'production-profile-test-receipt.json').read_text())
    prefix = f'{DATE}-n2-production-profile'
    checked_write(RESULTS / f'{prefix}-build.json', norm(json.dumps(build, indent=2)) + '\n')
    checked_write(RESULTS / f'{prefix}-native-tests.json', norm(json.dumps(tests, indent=2)) + '\n')
    log = (OUT / 'production-profile-native-tests.log').read_text()
    log = '\n'.join(line.rstrip() for line in norm(log).splitlines()) + '\n'
    # Cargo prints the test binary location and compile progress with absolute paths; keep only the tests.
    checked_write(RESULTS / f'{prefix}-native-tests.log', log)
    diff = header_diff(source, pin)
    checked_write(RESULTS / f'{prefix}-libkrun-header.diff', diff)
    inventory = json.loads((ROOT / 'api-inventory.json').read_text())
    production = build['production']
    inventory['productionProfile'] = {
        'candidate': 'production-profile-candidate.json',
        'build': 'cargo rustc -p libkrun --release --locked --offline --no-default-features --features blk --crate-type staticlib, then ZERO_AR_DATE=1 strip -S',
        'strippedArchiveSha256': production['strippedArchiveSha256'],
        'exportCount': production['exportCount'],
        'productionExports': [name[1:] for name in PRODUCTION_EXPORTS],
        'fixtureOracleOnlyExports': [name[1:] for name in FIXTURE_EXPORTS],
        'fixtureSymbolsExportedByProduction': production['fixtureSymbolsExported'],
        'fixtureOracleSymbolsExported': [name[1:] for name in build['fixtureOracle']['fixtureSymbolsExported']],
        'blockTraceRowStringsInProduction': production['blockTraceRowStrings'],
        'headerGuard': 'KRUN_COWORK_FIXTURE_ORACLE',
        'cargoFeature': 'cowork-fixture-oracle',
        'limits': pin['limits'],
        'deviceInventory': pin['deviceInventory'],
        'note': 'exports above the unpatched baseline list: the six upstream blk disk setters (the baseline was built without blk) and the four production entry points',
    }
    checked_write(ROOT / 'api-inventory.json', json.dumps(inventory, indent=2) + '\n')
    mutations = os.environ.get('N2_MUTATIONS_JSON')
    if mutations:
        checked_write(RESULTS / f'{prefix}-mutation-checks.json', norm(Path(mutations).read_text()))
    print(json.dumps({'written': sorted(p.name for p in RESULTS.glob(f'{prefix}-*'))}))


if __name__ == '__main__':
    scratch = os.environ.get('N2_SCRATCH_ROOT')
    main([(scratch, '<SCRATCH>')] if scratch else [])
