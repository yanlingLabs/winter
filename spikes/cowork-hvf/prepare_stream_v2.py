"""Prepare exact guarded stream checkout only; no network, compilation, keys or VM."""
import hashlib,json,os,subprocess,tempfile
from pathlib import Path
from build import ROOT,OUT,PINS,checked,verify,digest

def prepare():
    OUT.mkdir(parents=True,exist_ok=True)
    pin=json.loads((ROOT/'stream-candidate-v2.json').read_text());patch=ROOT/pin['patchFile'];verify(patch,pin['patchSha256'])
    for base in pin['basePatches']:verify(ROOT/base['patchFile'],base['patchSha256'])
    source=ROOT/pin['source']
    if not source.exists():
        if not (OUT/'libkrun').exists():raise RuntimeError('Pinned pristine source cache required; no downloads')
        checked(['git','clone','--no-hardlinks',OUT/'libkrun',source])
    if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=pin['baseRevision']:raise RuntimeError('Wrong source revision')
    verify(source/'Cargo.lock',PINS['libkrun']['lockSha256'])
    if not subprocess.check_output(['git','-C',str(source),'status','--porcelain'],text=True).strip():
        for base in pin['basePatches']:checked(['git','-C',source,'apply',ROOT/base['patchFile']])
        checked(['git','-C',source,'apply',patch])
    added=['src/devices/src/reclaim_access.rs','src/devices/src/block_bounce.rs','src/devices/src/block_trace.rs','src/devices/src/stream_io.rs','src/devices/src/virtio/block/cowork.rs','src/devices/src/virtio/console/cowork_stream.rs',*[f'src/vmm/src/cowork_{name}.rs' for name in ['fixture','ranges','barrier','ops','control','coordinator']]]
    checked(['git','-C',source,'add','-N',*added])
    if subprocess.check_output(['git','-C',str(source),'ls-files','--others','--exclude-standard'],text=True).strip():raise RuntimeError('Unexpected untracked source')
    full=subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'])
    if hashlib.sha256(full).hexdigest()!=pin['fullSourceDiffSha256']:raise RuntimeError('Composed stream source mismatch')
    with tempfile.TemporaryDirectory(prefix='stream-delta-',dir=OUT) as directory:
        env=os.environ.copy();env['GIT_INDEX_FILE']=str(Path(directory)/'index');checked(['git','-C',source,'read-tree','HEAD'],env=env)
        for base in pin['basePatches']:checked(['git','-C',source,'apply','--cached',ROOT/base['patchFile']],env=env)
        if subprocess.check_output(['git','-C',str(source),'diff','--binary','--no-ext-diff'],env=env)!=patch.read_bytes():raise RuntimeError('Incremental stream delta mismatch')
    for local,native in pin['moduleCorrespondence'].items():
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Actual/shared stream module mismatch: '+local)
    for local,native in [('block_bounce.rs','src/devices/src/block_bounce.rs'),('block_trace.rs','src/devices/src/block_trace.rs'),('block_reclaim_control.rs','src/vmm/src/cowork_control.rs'),*[('reclaim_'+name+'.rs','src/vmm/src/cowork_'+name+'.rs') for name in ['ranges','barrier','ops','coordinator']]]:
        if (ROOT/local).read_bytes()!=(source/native).read_bytes():raise RuntimeError('Accepted inherited core mismatch: '+local)
    print(json.dumps({'source':str(source),'patchSha256':digest(patch),'vmStarted':False,'payloadLogging':False}))
    return source
if __name__=='__main__':prepare()
