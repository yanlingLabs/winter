"""Exact guarded-block candidate. No compilation, downloads or VM launch."""
import json, subprocess, tempfile, os, hashlib
from build import ROOT, OUT, PINS, checked, digest, verify
from pathlib import Path

def prepare():
    pin=json.loads((ROOT/'block-candidate.json').read_text())
    patch=ROOT/pin['patchFile']
    verify(patch,pin['patchSha256'])
    verify(ROOT/'patches/0002-proposed-active-reclaim.patch',pin['preservedA6PatchSha256'])
    bases=pin.get('basePatches',[pin['previousCandidate']])
    for base in bases:verify(ROOT/base['patchFile'],base['patchSha256'])
    source=OUT/'libkrun-block-reclaim'
    if not source.exists():
        base=OUT/'libkrun'
        if not base.exists():raise RuntimeError('Prepare the pinned baseline cache first; this command never downloads')
        checked(['git','clone','--no-hardlinks',base,source])
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if revision!=pin['baseRevision']:raise RuntimeError('Wrong source base')
    verify(source/'Cargo.lock',PINS['libkrun']['lockSha256'])
    if not subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():
        for base in bases:
            base_patch=ROOT/base['patchFile']
            checked(['git','-C',source,'apply','--check',base_patch]);checked(['git','-C',source,'apply',base_patch])
        checked(['git','-C',source,'apply','--check',patch]);checked(['git','-C',source,'apply',patch])
    additions=['src/devices/src/block_trace.rs','src/devices/src/reclaim_access.rs','src/devices/src/block_bounce.rs','src/devices/src/virtio/block/cowork.rs',*[f'src/vmm/src/cowork_{name}.rs' for name in ['fixture','ranges','barrier','ops','control','coordinator']]]
    checked(['git','-C',source,'add','-N',*additions])
    if subprocess.check_output(['git','-C',str(source),'ls-files','--others','--exclude-standard'],text=True).strip():raise RuntimeError('Unexpected source files')
    full=subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'])
    if hashlib.sha256(full).hexdigest()!=pin['fullSourceDiffSha256']:raise RuntimeError('Source differs from frozen composed candidate')
    # Private index constructs the accepted baseline for the differential proof. Main/source index stays intact.
    with tempfile.TemporaryDirectory(prefix='block-delta-',dir=OUT) as directory:
        env=os.environ.copy();env['GIT_INDEX_FILE']=str(Path(directory)/'index')
        checked(['git','-C',source,'read-tree','HEAD'],env=env)
        for base in bases:checked(['git','-C',source,'apply','--cached',ROOT/base['patchFile']],env=env)
        checked(['git','-C',source,'add','-N','src/devices/src/block_trace.rs'],env=env)
        if subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'],env=env)!=patch.read_bytes():raise RuntimeError('Actual delta differs from frozen reviewed-baseline patch')
    for local,native in pin['moduleCorrespondence'].items():
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Actual/shared module differs: '+local)
    # Unchanged reviewed core remains identical, not a parallel control model.
    for name in ['ranges','barrier','ops','coordinator']:
        if (ROOT/f'reclaim_{name}.rs').read_bytes()!=(source/f'src/vmm/src/cowork_{name}.rs').read_bytes():raise RuntimeError('Reviewed core differs: '+name)
    print(json.dumps({'source':str(source),'patchSha256':digest(patch),'vmStarted':False}))
    return source

if __name__=='__main__':prepare()
