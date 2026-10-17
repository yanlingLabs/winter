"""Prepare and hash-check the isolated libkrun production-profile source. Offline; never builds or launches a VM.

Composes pristine libkrun v1.19.6 + patches 0004..0013 (the admitted two-disk fixture) + the new
0014 (krun-vmm unit harness), 0015 (production profile gate, names, limits) and 0016 (production
silences the fixture block trace), then proves:
  * every patch hash and the composed full-diff hash are the pinned ones;
  * each new patch is exactly the git diff between two successive composed states;
  * the mirrored modules at the spike root are byte-identical to the composed source;
  * the new patches stay inside their declared file scope and add no device or GPIO attach;
  * no test reaches Hypervisor.framework or krun_start_enter without an #[ignore].
"""
import argparse, hashlib, json, os, re, subprocess, tempfile
from pathlib import Path
from build import ROOT, OUT, PINS, checked, verify, digest
from production_profile_lib import git, load_candidate

# Calls that start a VM or reach Hypervisor.framework. In a test function they need an #[ignore].
VM_REACHING = re.compile(r'(krun_start_enter\(|[^_a-z]Vm::new\(|HvfVm::new\(|HvfGicV3::new\(|HvfVcpu::|\bhv_[a-z_0-9]+|krun_get_max_vcpus\(|krun_check_nested_virt\(|[^_a-z]check_nested_virt\(|[^_a-z]get_max_vcpus\(|build_microvm\()')


def tree_after(source, patches, scratch):
    """Tree object of pristine HEAD with the given patches applied to a private index."""
    env = os.environ.copy()
    env['GIT_INDEX_FILE'] = str(Path(scratch) / f'index-{len(patches)}')
    git(source, 'read-tree', 'HEAD', env=env)
    for patch in patches:
        git(source, 'apply', '--cached', ROOT / patch, env=env)
    return git(source, 'write-tree', env=env).strip()


def unignored_vm_reaching_tests(source):
    """Test functions that contain a VM-starting or HVF call but carry no #[ignore]."""
    offenders = []
    for path in sorted(Path(source).glob('src/**/*.rs')):
        # Linux-only modules (KVM) are cfg(target_os = "linux") and are never compiled on this host.
        if '/linux/' in '/' + path.relative_to(source).as_posix():
            continue
        lines = path.read_text().splitlines()
        for number, line in enumerate(lines):
            stripped = line.strip()
            # Comments and attribute-only lines (an #[ignore] reason may name hv_vm_create) are not calls.
            # String literals are text, not calls (a test may search the builder source for "build_microvm(").
            code = re.sub(r'"(?:\\.|[^"\\])*"', '""', line)
            if stripped.startswith('//') or re.fullmatch(r'#\[[^\]]*\]', stripped) or not VM_REACHING.search(code):
                continue
            function = next((i for i in range(number, -1, -1) if re.search(r'\bfn [a-z_0-9]+', lines[i])), None)
            if function is None:
                continue
            attributes = ' '.join(lines[max(0, function - 4):function + 1])
            if '#[test]' in attributes and '#[ignore' not in attributes:
                offenders.append(f'{path.relative_to(source)}:{number + 1}')
    return offenders


def added_lines_by_file(text):
    """Added lines of a git patch, keyed by the file they are added to."""
    current, added = None, {}
    for line in text.splitlines():
        if line.startswith('diff --git '):
            current = line.split(' b/', 1)[1]
            added.setdefault(current, [])
        elif current and line.startswith('+') and not line.startswith('+++'):
            added[current].append(line[1:])
    return added


def scope_findings(name, text, allowed, forbidden, device_forbidden=(), device_exempt=()):
    """Problems with one patch: files outside its declared scope, or added lines that attach a device or the GPIO.
    `forbidden` applies to every added line; `device_forbidden` (device attach, subscriber and MMIO registration
    calls) applies to every file except the exempt test files."""
    touched = sorted(set(re.findall(r'^diff --git a/(\S+) b/', text, re.M)))
    findings = []
    if touched != sorted(allowed):
        findings.append(f'{name} touches {touched}, not its declared scope {sorted(allowed)}')
    by_file = added_lines_by_file(text)
    for needle in forbidden:
        if any(needle in line for lines in by_file.values() for line in lines):
            findings.append(f'{name} adds forbidden text {needle!r}')
    for file, lines in by_file.items():
        if any(re.fullmatch(pattern, file) for pattern in device_exempt):
            continue
        for needle in device_forbidden:
            if any(needle in line for line in lines):
                findings.append(f'{name} adds {needle!r} in {file}')
    return findings


def check_scope(pin, source):
    """Each new patch touches only its declared files and adds no device or GPIO attach."""
    findings = []
    for entry in pin['newPatches']:
        findings += scope_findings(entry['patchFile'], (ROOT / entry['patchFile']).read_text(), entry['allowedFiles'], pin['forbiddenAddedText'], pin['deviceForbiddenAddedText'], pin['deviceForbiddenExemptFiles'])
    if findings:
        raise RuntimeError('; '.join(findings))


def prepare(pristine_cache=None, source_dir=None):
    OUT.mkdir(parents=True, exist_ok=True)
    pin = load_candidate()
    patches = pin['basePatches'] + pin['newPatches']
    for patch in patches:
        verify(ROOT / patch['patchFile'], patch['patchSha256'])
    source = Path(source_dir) if source_dir else ROOT / pin['source']
    if not source.exists():
        cache = Path(pristine_cache) if pristine_cache else OUT / 'libkrun'
        if not cache.exists():
            raise RuntimeError('Exact local pristine cache required; no downloads')
        checked(['git', 'clone', '--no-hardlinks', '-q', cache, source])
    if git(source, 'rev-parse', 'HEAD').strip() != pin['baseRevision']:
        raise RuntimeError('Wrong source revision')
    verify(source / 'Cargo.lock', PINS['libkrun']['lockSha256'])
    if not git(source, 'status', '--porcelain').strip():
        for patch in patches:
            checked([*['git', '-c', 'core.abbrev=7'], '-C', source, 'apply', ROOT / patch['patchFile']])
    git(source, 'add', '-N', *pin['allAddedFiles'])
    if git(source, 'ls-files', '--others', '--exclude-standard').strip():
        raise RuntimeError('Unexpected untracked native source')
    full = git(source, 'diff', '--binary', '--no-ext-diff', text=False)
    if hashlib.sha256(full).hexdigest() != pin['fullSourceDiffSha256']:
        raise RuntimeError('Composed production-profile source mismatch')
    with tempfile.TemporaryDirectory(prefix='production-delta-', dir=OUT) as scratch:
        # Each new patch must equal the git diff between the composed state before and after it.
        names = [patch['patchFile'] for patch in patches]
        trees = [tree_after(source, names[:count], scratch) for count in range(len(pin['basePatches']), len(names) + 1)]
        for index, patch in enumerate(pin['newPatches']):
            delta = git(source, 'diff', '--binary', '--no-ext-diff', trees[index], trees[index + 1], text=False)
            if delta != (ROOT / patch['patchFile']).read_bytes():
                raise RuntimeError('Incremental delta mismatch: ' + patch['patchFile'])
        # The last tree is the composed working tree.
        if git(source, 'diff', '--binary', '--no-ext-diff', trees[-1], text=False) != b'':
            raise RuntimeError('Working tree differs from the composed patch queue')
    for local, native in {**pin['moduleCorrespondence'], **pin['inheritedCore']}.items():
        if (ROOT / local).read_bytes() != (source / native).read_bytes():
            raise RuntimeError('Mirrored module mismatch: ' + local)
    check_scope(pin, source)
    offenders = unignored_vm_reaching_tests(source)
    if offenders:
        raise RuntimeError('Test reaches a VM or Hypervisor.framework without #[ignore]: ' + ', '.join(offenders))
    print(json.dumps({'source': str(source), 'newPatches': {patch['patchFile']: digest(ROOT / patch['patchFile']) for patch in pin['newPatches']}, 'fullSourceDiffSha256': pin['fullSourceDiffSha256'], 'vmStarted': False}))
    return source


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pristine-cache')
    parser.add_argument('--source-dir')
    args = parser.parse_args()
    prepare(args.pristine_cache, args.source_dir)
