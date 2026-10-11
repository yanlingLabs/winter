"""Inventory the exact isolated Linux image. Not a claim of hermeticity."""
import argparse,json,shutil,subprocess
from pathlib import Path
from prepare_crypto import digest

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--memory-gib',type=int,choices=[2,4],default=2);args=parser.parse_args()
    args.output.mkdir(exist_ok=True)
    tools={}
    for name in ['make','bison','flex','bc','perl','openssl','sh','awk','sed','find','pahole','python3','gpgv','xz','ldd','ld']:
        path=Path(shutil.which(name)).resolve()
        tools[name]={'path':str(path),'sha256':digest(path)}
    packages=[]
    query=subprocess.check_output(['dpkg-query','-W','-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n'],text=True)
    licenses=args.output/'licenses';licenses.mkdir(exist_ok=True)
    for line in query.splitlines():
        name,version,arch,source,source_version=line.split('\t')
        copyright=Path('/usr/share/doc')/name.split(':')[0]/'copyright'
        entry={'name':name,'version':version,'architecture':arch,'sourcePackage':source,'sourceVersion':source_version,'sourceLocator':f'https://launchpad.net/ubuntu/+source/{source}/{source_version}'}
        if copyright.exists():
            destination=licenses/(name.replace(':','_')+'.copyright');shutil.copyfile(copyright,destination);entry['copyrightSha256']=digest(destination)
        else:entry['copyrightSha256']=None
        packages.append(entry)
    (args.output/'packages.json').write_text(json.dumps(packages,indent=2)+'\n')
    debs={str(path):digest(path) for path in sorted(Path('/var/cache/apt/archives').glob('*.deb'))}
    (args.output/'package-archives.json').write_text(json.dumps(debs,indent=2)+'\n')
    sysroot={str(path):digest(path) for root in ['/usr/include','/usr/lib/aarch64-linux-gnu','/usr/lib/gcc'] for path in sorted(Path(root).rglob('*')) if path.is_file()}
    (args.output/'sysroot-files.json').write_text(json.dumps(sysroot,indent=2)+'\n')
    receipt={'imageDigest':args.image,'imageDigestKind':'Docker immutable local image ID; base registry manifest separately pinned','baseImageManifest':'sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7','snapshot':'20261011T000000Z','tools':tools,'packagesSha256':digest(args.output/'packages.json'),'packageArchivesSha256':digest(args.output/'package-archives.json'),'sysrootSha256':digest(args.output/'sysroot-files.json'),'packageCount':len(packages),'downloadedPackageCount':len(debs),'missingCopyright':[p['name'] for p in packages if p['copyrightSha256'] is None],'limits':{'jobs':2,'cpus':2,'memoryBytes':args.memory_gib*1024**3,'swapBytes':0,'diskStopBytes':8589934592,'hostFreeFloorBytes':8589934592},'isolation':'Docker Linux arm64; compile non-root, read-only rootfs, no network, all capabilities dropped, no-new-privileges. Fixture input read-only and private scratch/output only. No Docker socket or home mount. Dependency inventory does not itself establish trusted/accepted production tooling.'}
    (args.output/'builder-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'image':args.image,'packages':len(packages),'downloadedPackages':len(debs),'missingCopyright':receipt['missingCopyright']}))
if __name__=='__main__':main()
