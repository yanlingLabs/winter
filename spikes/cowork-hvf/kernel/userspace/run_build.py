"""Explicit isolated toolset build, never a disk/VM/bootstrap launcher."""
import argparse,hashlib,json,os,shutil,subprocess,time,uuid
from pathlib import Path

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'out/kernel-crypto/userspace-build'
ARCHIVES=HERE.parents[1]/'out/kernel-crypto/userspace-inputs'
PINS=json.loads((HERE/'inputs.json').read_text())
GIB=1024**3
def digest(path):
    with path.open('rb') as data:return hashlib.file_digest(data,'sha256').hexdigest()
def call(command,**kwargs):return subprocess.run(command,check=True,**kwargs)
def main():
    global OUT
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT);args=parser.parse_args()
    allowed=(HERE.parents[1]/'out/kernel-crypto').resolve();OUT=args.output.resolve()
    if OUT.parent!=allowed or not OUT.name.startswith('userspace-'):raise RuntimeError('Output must be a private userspace-* directory directly beneath the fixture kernel-crypto output')
    image=PINS['builder']['imageId']
    if not image or not image.startswith('sha256:') or len(image)!=71:raise RuntimeError('Pinned immutable builder image required')
    source=ARCHIVES/'cryptsetup-2.8.8.tar.xz'
    if digest(source)!=PINS['cryptsetup']['sha256']:raise RuntimeError('Source input mismatch')
    OUT.mkdir(exist_ok=True,parents=True)
    if any((OUT/name).exists() for name in ['frozen-inputs','toolset-receipt.json']):raise RuntimeError('Preserve existing build; use a separately reviewed fresh output directory')
    if shutil.disk_usage(OUT).free<10*GIB:raise RuntimeError('Need10 GiB host free to start; floor8 GiB')
    frozen=OUT/'frozen-inputs';shutil.copytree(HERE,frozen,ignore=shutil.ignore_patterns('__pycache__'))
    token='winter-crypto-userspace-'+uuid.uuid4().hex[:12];volume=token+'-scratch'
    call(['docker','volume','create',volume],stdout=subprocess.DEVNULL)
    common=['docker','run','--network','none','--memory','2g','--memory-swap','2g','--cpus','2','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,src='+volume+',dst=/build']
    call([*common,'--rm',image,'chmod','0777','/build'])
    mounts=['--user',str(os.getuid())+':'+str(os.getgid()),'--mount','type=bind,src='+str(frozen)+',dst=/inputs,readonly','--mount','type=bind,src='+str(ARCHIVES)+',dst=/archives,readonly','--mount','type=bind,src='+str(HERE.parent)+',dst=/kernel-inputs,readonly','--mount','type=volume,src=winter-crypto-b65dd2e785b3-scratch,dst=/kernel-build,readonly','--env','COWORK_KERNEL_OUT=/build','--env','PYTHONDONTWRITEBYTECODE=1']
    call([*common,'--rm',*mounts,image,'python3','/kernel-inputs/receipt_builder.py','--image',image,'--memory-gib','2','--output','/build/receipt'])
    command=[*common,'--name',token,*mounts,image,'python3','/inputs/build_toolset.py']
    record={'container':token,'volume':volume,'image':image,'command':command,'status':'running','hostFreeFloorBytes':8*GIB,'scratchAbortBytes':2*GIB,'note':'Sampled abort policy, not disk quota. Kernel/compiler scratch mounted read-only. No home, real data, Docker socket or block device mount.'}
    (OUT/'container-run.json').write_text(json.dumps(record,indent=2)+'\n')
    export_mount=['--mount','type=bind,src='+str(OUT)+',dst=/exports']
    with (OUT/'container.log').open('w') as log:
        process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
        try:
            time.sleep(1)
            initial=subprocess.run(['docker','inspect',token],capture_output=True,text=True)
            if initial.returncode==0:(OUT/'container-inspect.json').write_text(initial.stdout)
            while process.poll() is None:
                usage=subprocess.run(['docker','exec',token,'du','-sk','/build'],capture_output=True,text=True)
                size=int(usage.stdout.split()[0])*1024 if usage.returncode==0 else 0
                if size>2*GIB or shutil.disk_usage(OUT).free<8*GIB:
                    record['status']='disk-aborted';call(['docker','kill',token],stdout=subprocess.DEVNULL);raise RuntimeError('Disk safety floor/ceiling reached')
                time.sleep(5)
            record['status']='built' if process.returncode==0 else 'failed'
            record['exitCode']=process.returncode
        finally:
            if process.poll() is None:subprocess.run(['docker','kill',token],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);process.wait()
            final=subprocess.run(['docker','inspect',token],capture_output=True,text=True)
            if final.returncode==0:(OUT/'container-final-inspect.json').write_text(final.stdout)
            (OUT/'container-run.json').write_text(json.dumps(record,indent=2)+'\n')
            subprocess.run(['docker','rm',token],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    export="""import shutil
from pathlib import Path
for name in ['source-verification.log','build.log','build-resources.json','toolset-receipt.json','toolset-files.json','toolset.tar','capability.json','runtime-dependencies.json','source-licenses.json']:
 path=Path('/build',name)
 if path.exists():shutil.copyfile(path,Path('/exports',name))
if Path('/build/toolset').exists():shutil.copytree('/build/toolset','/exports/toolset',dirs_exist_ok=True)
shutil.copytree('/build/receipt','/exports/receipt',dirs_exist_ok=True)
"""
    call([*common,'--rm',*mounts,*export_mount,image,'python3','-c',export])
    if process.returncode:raise RuntimeError('Build failed; exact logs/resources and owned scratch preserved')
    # Docker Desktop's host export granted owner-write despite Linux copy2
    # mode preservation. The archive preserves its Linux modes; normalize the
    # host mirror explicitly before hash/mode and relocation verification.
    manifest=json.loads((OUT/'toolset-files.json').read_text())
    for name,entry in manifest.items():(OUT/'toolset'/name).chmod(int(entry['mode'],8))
    from verify_toolset import verify_files,verify_relocation
    verify_files(OUT/'toolset',manifest);verify_relocation(OUT/'toolset',OUT)
    print(json.dumps({'toolsetBuilt':True,'archiveSha256':digest(OUT/'toolset.tar'),'receipt':str(OUT/'toolset-receipt.json'),'volume':volume,'bootableInitramfsBuilt':False,'unlockImplemented':False}))
if __name__=='__main__':main()
