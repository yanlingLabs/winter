"""Explicit offline Linux builder entry point. No builder/container launch, package install or keys."""
import argparse,json,os,platform,shutil,subprocess,tarfile
from pathlib import Path
from prepare_crypto import HERE,OUT,PINS,digest,verify,verify_source,verify_config

def main():
    p=argparse.ArgumentParser();p.add_argument('--builder-receipt',type=Path,required=True);args=p.parse_args()
    if platform.system()!='Linux' or platform.machine() not in ('aarch64','arm64'):raise RuntimeError('Run inside a separately pinned isolated Linux arm64 builder; no builder is auto-launched')
    if any(c in str(OUT.resolve()) for c in (' ',':')):raise RuntimeError('Linux kernel build requires a source/output namespace without spaces or colons')
    builder=json.loads(args.builder_receipt.read_text())
    if not builder.get('imageDigest','').startswith('sha256:') or len(builder['imageDigest'])!=71:raise RuntimeError('Pinned builder image digest required')
    required=['make','bison','flex','bc','perl','openssl','sh','awk','sed','find','pahole']
    tools=builder.get('tools',{})
    for name in required:
        if name not in tools:raise RuntimeError('Missing pinned builder tool: '+name)
        verify(Path(tools[name]['path']),tools[name]['sha256'])
    archive=verify_source();llvm=PINS['toolchainCandidate'];toolchain_archive=OUT/'LLVM-20.1.8-Linux-ARM64.tar.xz';verify(toolchain_archive,llvm['sha256'])
    source=OUT/'build-source';output=OUT/'build-output';toolchain=OUT/'build-llvm'
    if any(path.exists() for path in [source,output,toolchain]):raise RuntimeError('Refusing to overwrite an existing source/build/toolchain; preserve its receipt first')
    source.mkdir();toolchain.mkdir();output.mkdir()
    with tarfile.open(archive,'r:xz') as tar:tar.extractall(source,filter='data')
    with tarfile.open(toolchain_archive,'r:xz') as tar:tar.extractall(toolchain,filter='data')
    sources=list(source.iterdir());llvm_bins=list(toolchain.glob('*/bin/clang'))
    if len(sources)!=1 or len(llvm_bins)!=1:raise RuntimeError('Unexpected pinned archive layout')
    source=sources[0];llvm_bin=llvm_bins[0].parent
    base=(HERE/PINS['baseConfig']['file']).read_text().splitlines();changes={}
    for line in (HERE/PINS['fragment']['file']).read_text().splitlines():
        if line.startswith('CONFIG_'):key,_=line.split('=',1);changes[key]=line
    lines=[]
    for line in base:
        key=line.split('=',1)[0] if line.startswith('CONFIG_') else (line[2:-11] if line.startswith('# CONFIG_') and line.endswith(' is not set') else None)
        if key in changes:lines.append(changes.pop(key))
        else:lines.append(line)
    (output/'.config').write_text('\n'.join([*lines,*changes.values()])+'\n')
    # PATH contains only the caller's pinned builder tools and exact pinned LLVM archive.
    tool_dirs=list(dict.fromkeys(str(Path(tools[name]['path']).parent) for name in required))
    env={'PATH':os.pathsep.join([str(llvm_bin),*tool_dirs]),'HOME':str(OUT/'builder-home'),'TMPDIR':str(OUT/'builder-tmp'),'LC_ALL':'C','TZ':'UTC','SOURCE_DATE_EPOCH':'1781001093','KBUILD_BUILD_USER':'cowork-fixture','KBUILD_BUILD_HOST':'isolated','KBUILD_BUILD_TIMESTAMP':'Tue Jun 9 10:31:33 UTC 2026','KCONFIG_NOTIMESTAMP':'1'}
    Path(env['HOME']).mkdir();Path(env['TMPDIR']).mkdir()
    make=[tools['make']['path'],'-C',str(source),'O='+str(output),'ARCH=arm64','LLVM='+str(llvm_bin)+'/', 'LLVM_IAS=1','-j2']
    commands=[[*make,'olddefconfig'],[*make,'Image','vmlinux']]
    with (OUT/'build.log').open('w') as log:
        subprocess.run(commands[0],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
        symbols=verify_config(output/'.config')
        subprocess.run(commands[1],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
    artifacts={name:digest(output/name) for name in ['.config','vmlinux','arch/arm64/boot/Image']}
    receipt={'kernelBuilt':True,'initramfsBuilt':False,'productionReady':False,'sourceSha256':PINS['kernel']['sha256'],'toolchainArchiveSha256':llvm['sha256'],'builderReceiptSha256':digest(args.builder_receipt),'builder':builder,'commands':commands,'requiredSymbols':symbols,'artifacts':artifacts,'patches':[],'remaining':'Independently review builder dependency receipt, regular serial binding and trusted immutable userspace/key bootstrap; boot and remeasure crypto profile. No crypto/unlock claim follows from compilation.'}
    (OUT/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
