"""Native regressions for the libkrun production profile. Never invokes a worker or starts a VM.

Runs, with the pinned offline toolchain and one thread:
  * production features (`blk`): the whole krun-vmm unit suite (fixed by patch 0014), the krun-devices
    suites the admitted fixture ran, and the whole libkrun suite including the new production tests;
  * oracle features (`blk,cowork-fixture-oracle`): the whole libkrun suite again, so the fixture
    entry points stay a regression oracle next to the production ones.
Tests that would create a Hypervisor.framework VM or call krun_start_enter are #[ignore] and are
never run: --ignored and --include-ignored are refused here. The receipt lists every ignored test.
"""
import json, os, re, subprocess, sys, tempfile
from build import ROOT, OUT, digest
from prepare_production_profile import prepare
from production_profile_lib import check_toolchain, load_candidate, release_env, toolchain_env

# (package, features, filter) exactly as the admitted fixture ran them, plus the whole-crate suites.
DEVICE_FILTERS = ['workspace_disks', 'runtime_port', 'cowork_stream', 'cowork_rng', 'reclaim_access::tests', 'cowork_frq', 'cowork_block', 'block_bounce::tests']
RUNS = ([('krun-vmm', 'blk', '')]
        + [('krun-devices', 'blk', name) for name in DEVICE_FILTERS]
        + [('libkrun', 'blk', '')]
        + [('libkrun', 'blk,cowork-fixture-oracle', '')])
# The same suites again under the shipped release profile (overflow checks on, debug assertions off, LTO).
RELEASE_RUNS = [('libkrun', 'blk', ''), ('krun-vmm', 'blk', ''), ('krun-devices', 'blk', 'cowork_block'), ('krun-devices', 'blk', 'block_bounce::tests'), ('krun-devices', 'blk', 'workspace_disks')]
FORBIDDEN_FLAGS = ('--ignored', '--include-ignored')
LOG = []  # full cargo output of every run, written next to the receipt


def run_one(cargo, source, env, package, features, name, release=False):
    command = [cargo, 'test', *(['--release'] if release else []), '--manifest-path', str(source / 'Cargo.toml'), '--locked', '--offline', '--no-default-features', '--features', features, '-p', package, '--jobs', '2']
    tail = ['--test-threads=1', '--nocapture']
    if name:
        command.append(name)
    command += ['--', *tail]
    if any(flag in command for flag in FORBIDDEN_FLAGS):
        raise RuntimeError('Ignored tests (VM or krun_start_enter) are never run here')
    result = subprocess.run(command, env=env, capture_output=True, text=True)
    LOG.append('$ ' + ' '.join(['cargo', *command[1:]]) + '\n' + result.stdout + result.stderr)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr[-4000:] if result.returncode else '')
    result.check_returncode()
    passed = sum(int(n) for n in re.findall(r'test result: ok\. (\d+) passed', result.stdout))
    ignored = re.findall(r'^test (\S+) \.\.\. ignored(?:, (.*))?$', result.stdout, re.M)
    if passed == 0:
        raise RuntimeError(f'Missing executed native tests: {package} {features} {name!r}')
    return {'package': package, 'features': features, 'filter': name, 'profile': 'release' if release else 'dev', 'passed': passed, 'ignored': [{'test': t, 'reason': r} for t, r in ignored], 'exitCode': 0}


def main():
    source = prepare()
    pin = load_candidate()
    toolchain = check_toolchain()
    env = toolchain_env()
    cargo = str(OUT / 'rust/bin/cargo')
    receipt = {'vmStarted': False, 'workerBuilt': False, 'krunStartEnterCalled': False, 'ignoredTestsRun': False, 'productionReady': False,
               'fullSourceDiffSha256': pin['fullSourceDiffSha256'], 'patches': {p['patchFile']: p['patchSha256'] for p in pin['newPatches']},
               'toolchain': toolchain, 'runs': [], 'testsPassed': 0}
    # Cargo test binaries bind unix sockets; macOS limits those paths to 104 bytes, so the temp root is
    # a short /tmp directory (the admitted fixture runner does the same).
    with tempfile.TemporaryDirectory(prefix='n2-prod-', dir='/tmp') as directory:
        env['TMPDIR'] = directory
        for package, features, name in RUNS:
            run = run_one(cargo, source, env, package, features, name)
            receipt['runs'].append(run)
            receipt['testsPassed'] += run['passed']
        release = release_env(source, OUT, OUT / 'production-profile' / 'target-release-tests')
        release['TMPDIR'] = directory
        for package, features, name in RELEASE_RUNS:
            run = run_one(cargo, source, release, package, features, name, release=True)
            receipt['runs'].append(run)
            receipt['testsPassed'] += run['passed']
        command = [cargo, 'check', '--manifest-path', str(source / 'Cargo.toml'), '--locked', '--offline', '--no-default-features', '--features', 'blk', '-p', 'libkrun']
        subprocess.run(command, check=True, env=env)
        receipt['runs'].append({'command': 'cargo check -p libkrun --features blk', 'exitCode': 0})
    ignored = sorted({(i['test'], i['reason']) for run in receipt['runs'] for i in run.get('ignored', [])})
    receipt['ignoredTests'] = [{'test': t, 'reason': r} for t, r in ignored]
    receipt['passed'] = True
    (OUT / 'production-profile-native-tests.log').write_text('\n'.join(LOG))
    (OUT / 'production-profile-test-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
    return receipt


if __name__ == '__main__':
    main()
