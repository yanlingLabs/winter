"""Explicit isolated offline kernel compile using an already built pinned image.

Only fixture inputs and outputs are bind-mounted. No VM, system installation,
host home/socket mount or encrypted disk operation occurs.
"""
import argparse,json,os,shutil,subprocess,time,uuid
from pathlib import Path
from prepare_crypto import HERE,OUT,PINS,digest,verify

GIB=1024**3
def call(command,**kwargs):return subprocess.run(command,check=True,**kwargs)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);parser.add_argument('--memory-gib',type=int,choices=[2,4],default=2);parser.add_argument('--resume-volume',help='Explicit failed fixture volume; signed extracted inputs are reverified before retry');args=parser.parse_args()
    if not args.image.startswith('sha256:') or len(args.image)!=71:raise RuntimeError('Use immutable local image ID, never a mutable tag')
    if args.image!=PINS['builder'].get('imageId'):raise RuntimeError('Image differs from the selected build input pin')
    OUT.mkdir(exist_ok=True,parents=True)
    if (OUT/'build-receipt.json').exists():raise RuntimeError('Existing completed receipt; use a fresh COWORK_KERNEL_OUT to preserve it')
    if shutil.disk_usage(OUT).free<12*GIB:raise RuntimeError('Need >=12 GiB host free before starting; abort floor is 8 GiB')
    inputs=[OUT/f"linux-{PINS['kernel']['version']}.tar.xz",OUT/PINS['toolchainCandidate']['archive']]
    for path,pin in zip(inputs,[PINS['kernel'],PINS['toolchainCandidate']]):verify(path,pin['sha256'])
    frozen=OUT/('retry-inputs' if args.resume_volume else 'frozen-inputs')
    if frozen.exists():raise RuntimeError('Existing frozen inputs; choose a fresh output directory')
    shutil.copytree(HERE,frozen,ignore=shutil.ignore_patterns('__pycache__'))
    token='winter-crypto-'+uuid.uuid4().hex[:12];volume=args.resume_volume or token+'-scratch'
    if args.resume_volume:
        if not volume.startswith('winter-crypto-') or not volume.endswith('-scratch'):raise RuntimeError('Refusing a non-fixture volume')
        call(['docker','volume','inspect',volume],stdout=subprocess.DEVNULL)
    else:call(['docker','volume','create',volume],stdout=subprocess.DEVNULL)
    cap=str(args.memory_gib)+'g'
    common=['docker','run','--rm','--network','none','--memory',cap,'--memory-swap',cap,'--cpus','2','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--mount','type=volume,src='+volume+',dst=/build']
    # Root can change the mode of its own new volume directory without caps.
    call([*common,args.image,'chmod','0777','/build'])
    mounts=['--user',str(os.getuid())+':'+str(os.getgid()),'--mount','type=bind,src='+str(frozen)+',dst=/inputs,readonly','--mount','type=bind,src='+str(OUT)+',dst=/archives,readonly','--env','COWORK_KERNEL_OUT=/build','--env','PYTHONDONTWRITEBYTECODE=1']
    export_mount=['--mount','type=bind,src='+str(OUT)+',dst=/exports']
    setup="""import os,shutil
from pathlib import Path
for name in %r:
 path=Path('/build',name)
 if path.is_symlink():path.unlink()
 path.symlink_to(Path('/archives',name))
""" % [p.name for p in inputs]
    call([*common,*mounts,args.image,'python3','-c',setup])
    call([*common,*mounts,args.image,'python3','/inputs/receipt_builder.py','--image',args.image,'--output','/build/receipt','--memory-gib',str(args.memory_gib)])
    build_common=[part for part in common if part!='--rm']
    command=[*build_common,'--name',token,*mounts,args.image,'python3','/inputs/build_crypto.py','--builder-receipt','/build/receipt/builder-receipt.json',*(['--resume-verified'] if args.resume_volume else [])]
    record={'container':token,'volume':volume,'image':args.image,'command':command,'monitorIntervalSeconds':10,'diskLimitBytes':8*GIB,'hostFreeFloorBytes':8*GIB,'status':'running','note':'Disk limit is sampled abort policy, not a filesystem quota; no adversarial-code containment claim.'}
    (OUT/'container-run.json').write_text(json.dumps(record,indent=2)+'\n')
    with (OUT/'container.log').open('w') as log:
        process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
        try:
            time.sleep(1)
            inspect=subprocess.run(['docker','inspect',token],capture_output=True,text=True)
            if inspect.returncode==0:(OUT/'container-inspect.json').write_text(inspect.stdout)
            while process.poll() is None:
                free=shutil.disk_usage(OUT).free
                used=subprocess.run(['docker','exec',token,'du','-sk','/build'],capture_output=True,text=True)
                size=int(used.stdout.split()[0])*1024 if used.returncode==0 else 0
                if free<8*GIB or size>8*GIB:
                    subprocess.run(['docker','kill',token],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    raise RuntimeError(f'Disk safety abort: host free={free}, scratch={size}')
                time.sleep(10)
            if process.returncode:
                record['status']='failed'
                diagnostic="""import shutil
from pathlib import Path
for name in ['build.log','source-verification.log','toolchain-verification.log','resolved-symbols.json','build-resource-final.json']:
 path=Path('/build',name)
 if path.exists():shutil.copyfile(path,Path('/exports',name))
shutil.copytree('/build/receipt','/exports/receipt',dirs_exist_ok=True)
"""
                call([*common,*mounts,*export_mount,args.image,'python3','-c',diagnostic])
                raise RuntimeError('Compile failed; preserve volume/log for diagnosis: '+str(process.returncode))
            record['status']='compiled'
        finally:
            if process.poll() is None:
                subprocess.run(['docker','kill',token],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                process.wait()
            record['exitCode']=process.returncode
            (OUT/'container-run.json').write_text(json.dumps(record,indent=2)+'\n')
            final_inspect=subprocess.run(['docker','inspect',token],capture_output=True,text=True)
            if final_inspect.returncode==0:(OUT/'container-final-inspect.json').write_text(final_inspect.stdout)
            subprocess.run(['docker','rm',token],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    export="""import shutil
from pathlib import Path
for name in ['build-receipt.json','build.log','source-verification.log','toolchain-verification.log','toolchain-files.json','kernel-licenses.json','resolved-symbols.json','build-resource-final.json']:
 shutil.copyfile(Path('/build',name),Path('/exports',name))
shutil.copytree('/build/receipt','/exports/receipt',dirs_exist_ok=True)
for source,destination in [('output/.config','resolved.config'),('output/vmlinux','vmlinux'),('output/arch/arm64/boot/Image','Image')]:shutil.copyfile(Path('/build',source),Path('/exports',destination))
"""
    call([*common,*mounts,*export_mount,args.image,'python3','-c',export])
    print(json.dumps({'kernelBuilt':True,'receipt':str(OUT/'build-receipt.json'),'imageSha256':digest(OUT/'Image'),'volume':volume,'scratchPreserved':True,'initramfsBuilt':False,'productionReady':False}))
if __name__=='__main__':main()
