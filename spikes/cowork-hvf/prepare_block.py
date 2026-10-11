"""Exact guarded-block candidate. No compilation, downloads or VM launch."""
import json, subprocess
from build import ROOT, OUT, PINS, checked, digest, verify

def prepare():
    pin=json.loads((ROOT/'block-candidate.json').read_text())
    patch=ROOT/'patches/0003-proposed-guarded-block.patch'
    verify(patch,pin['patchSha256'])
    verify(ROOT/'patches/0002-proposed-active-reclaim.patch',pin['preservedA6PatchSha256'])
    source=OUT/'libkrun-block-reclaim'
    if not source.exists():
        base=OUT/'libkrun'
        if not base.exists():raise RuntimeError('Prepare the pinned baseline cache first; this command never downloads')
        checked(['git','clone','--no-hardlinks',base,source])
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if revision!=pin['baseRevision']:raise RuntimeError('Wrong source base')
    verify(source/'Cargo.lock',PINS['libkrun']['lockSha256'])
    if not subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():
        checked(['git','-C',source,'apply','--check',patch]);checked(['git','-C',source,'apply',patch])
    additions=['src/devices/src/reclaim_access.rs','src/devices/src/block_bounce.rs','src/devices/src/virtio/block/cowork.rs',*[f'src/vmm/src/cowork_{name}.rs' for name in ['fixture','ranges','barrier','ops','control','coordinator']]]
    checked(['git','-C',source,'add','-N',*additions])
    if subprocess.check_output(['git','-C',str(source),'ls-files','--others','--exclude-standard'],text=True).strip():raise RuntimeError('Unexpected source files')
    if subprocess.check_output(['git','-C',str(source),'diff','--binary'])!=patch.read_bytes():raise RuntimeError('Source differs from frozen candidate')
    for local,native in pin['moduleCorrespondence'].items():
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Actual/shared module differs: '+local)
    # Unchanged reviewed core remains identical, not a parallel control model.
    for name in ['ranges','barrier','ops','control','coordinator']:
        if (ROOT/f'reclaim_{name}.rs').read_bytes()!=(source/f'src/vmm/src/cowork_{name}.rs').read_bytes():raise RuntimeError('Reviewed core differs: '+name)
    print(json.dumps({'source':str(source),'patchSha256':digest(patch),'vmStarted':False}))
    return source

if __name__=='__main__':prepare()
