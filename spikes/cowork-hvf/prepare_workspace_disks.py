"""Prepare/hash-check isolated admitted-FD source. Offline; never compiles or launches a VM."""
import argparse, hashlib, json, os, subprocess, tempfile
from pathlib import Path
from build import ROOT, OUT, PINS, checked, verify, digest

def prepare(pristine_cache=None):
    OUT.mkdir(parents=True, exist_ok=True)
    pin=json.loads((ROOT/'workspace-disks-candidate.json').read_text())
    for patch in pin['basePatches']+[{'patchFile':pin['patchFile'],'patchSha256':pin['patchSha256']}]:
        verify(ROOT/patch['patchFile'],patch['patchSha256'])
    source=ROOT/pin['source']
    if not source.exists():
        cache=Path(pristine_cache) if pristine_cache else OUT/'libkrun'
        if not cache.exists():raise RuntimeError('Exact local pristine cache required; no downloads')
        checked(['git','clone','--no-hardlinks',cache,source])
    if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=pin['baseRevision']:
        raise RuntimeError('Wrong source revision')
    verify(source/'Cargo.lock',PINS['libkrun']['lockSha256'])
    if not subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():
        for base in pin['basePatches']:checked(['git','-C',source,'apply',ROOT/base['patchFile']])
        checked(['git','-C',source,'apply',ROOT/pin['patchFile']])
    checked(['git','-C',source,'add','-N',*pin['allAddedFiles']])
    if subprocess.check_output(['git','-C',str(source),'ls-files','--others','--exclude-standard'],text=True).strip():
        raise RuntimeError('Unexpected untracked native source')
    full=subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'])
    if hashlib.sha256(full).hexdigest()!=pin['fullSourceDiffSha256']:raise RuntimeError('Composed workspace source mismatch')
    with tempfile.TemporaryDirectory(prefix='workspace-delta-',dir=OUT) as directory:
        env=os.environ.copy();env['GIT_INDEX_FILE']=str(Path(directory)/'index')
        checked(['git','-C',source,'read-tree','HEAD'],env=env)
        for base in pin['basePatches']:checked(['git','-C',source,'apply','--cached',ROOT/base['patchFile']],env=env)
        checked(['git','-C',source,'add','-N',*pin['incrementalAddedFiles']],env=env)
        if subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'],env=env)!=(ROOT/pin['patchFile']).read_bytes():
            raise RuntimeError('Incremental workspace delta mismatch')
    for local,native in pin['moduleCorrespondence'].items():
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Actual/shared module mismatch: '+local)
    for local,native in [('block_bounce.rs','src/devices/src/block_bounce.rs'),('block_trace.rs','src/devices/src/block_trace.rs'),('block_reclaim_control.rs','src/vmm/src/cowork_control.rs'),*[(f'reclaim_{name}.rs',f'src/vmm/src/cowork_{name}.rs') for name in ['ranges','barrier','ops','coordinator']]]:
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Inherited core changed: '+local)
    print(json.dumps({'source':str(source),'patchSha256':digest(ROOT/pin['patchFile']),'vmStarted':False}))
    return source

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--pristine-cache');args=parser.parse_args();prepare(args.pristine_cache)
