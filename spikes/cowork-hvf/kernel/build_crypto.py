"""Explicit offline Linux builder entry point. No builder/container launch, package install or keys."""
import argparse,json,os,platform,shutil,subprocess,tarfile
from pathlib import Path
from prepare_crypto import HERE,OUT,PINS,digest,verify,verify_source,verify_toolchain,verify_config

def verify_extracted_archive(packed,root):
    import hashlib
    expected_paths=set()
    with tarfile.open(packed,'r:xz') as tar:
        for member in tar:
            path=root/member.name
            expected_paths.add(path)
            if member.isfile() or member.islnk():
                with tar.extractfile(member) as data:expected=hashlib.file_digest(data,'sha256').hexdigest()
                verify(path,expected)
            elif member.issym():
                expected_link=tarfile.data_filter(member,str(root)).linkname
                if not path.is_symlink() or os.readlink(path)!=expected_link:raise RuntimeError('Extracted symlink changed: '+str(path))
            elif member.isdir() and (not path.is_dir() or path.is_symlink()):raise RuntimeError('Extracted directory changed: '+str(path))
    unexpected=[str(path) for path in root.rglob('*') if (path.is_file() or path.is_symlink()) and path not in expected_paths]
    if unexpected:raise RuntimeError('Unexpected extracted input files: '+repr(unexpected[:8]))

def main():
    p=argparse.ArgumentParser();p.add_argument('--builder-receipt',type=Path,required=True);p.add_argument('--resume-verified',action='store_true',help='Retry a failed build only after rechecking extracted signed source/toolchain');args=p.parse_args()
    if platform.system()!='Linux' or platform.machine() not in ('aarch64','arm64'):raise RuntimeError('Run inside a separately pinned isolated Linux arm64 builder; no builder is auto-launched')
    if any(c in str(OUT.resolve()) for c in (' ',':')):raise RuntimeError('Linux kernel build requires a source/output namespace without spaces or colons')
    builder=json.loads(args.builder_receipt.read_text())
    if not builder.get('imageDigest','').startswith('sha256:') or len(builder['imageDigest'])!=71:raise RuntimeError('Pinned builder image digest required')
    required=['make','bison','flex','bc','perl','openssl','sh','awk','sed','find','pahole']
    tools=builder.get('tools',{})
    for name in required:
        if name not in tools:raise RuntimeError('Missing pinned builder tool: '+name)
        verify(Path(tools[name]['path']),tools[name]['sha256'])
    archive=verify_source();llvm=PINS['toolchainCandidate'];toolchain_archive=verify_toolchain()
    source=OUT/'src';output=OUT/'output';toolchain=OUT/'llvm'
    if args.resume_verified:
        if (OUT/'build-receipt.json').exists():raise RuntimeError('Refusing to resume a completed build')
        for packed,root in [(archive,source),(toolchain_archive,toolchain)]:
            verify_extracted_archive(packed,root)
    else:
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
    env={'PATH':os.pathsep.join([str(llvm_bin),*tool_dirs]),'HOME':str(OUT/'builder-home'),'TMPDIR':str(OUT/'builder-tmp'),'LC_ALL':'C','TZ':'UTC','SOURCE_DATE_EPOCH':'1781001093','KBUILD_BUILD_USER':'cowork-fixture','KBUILD_BUILD_HOST':'isolated','KBUILD_BUILD_TIMESTAMP':'Tue Jun 9 10:31:33 UTC 2026','KCONFIG_NOTIMESTAMP':'1','KBUILD_BUILD_VERSION':'1'}
    Path(env['HOME']).mkdir(exist_ok=args.resume_verified);Path(env['TMPDIR']).mkdir(exist_ok=args.resume_verified)
    # pahole 1.25's parallel DWARF/BTF encoding exceeded the bounded builder's
    # cap. Preserve BTF but encode it with one job, retaining upstream feature
    # flags from Linux 6.18.35 scripts/Makefile.btf for this pinned version.
    make=[tools['make']['path'],'-C',str(source),'O='+str(output),'ARCH=arm64','LLVM='+str(llvm_bin)+'/', 'LLVM_IAS=1','-j2','PAHOLE_FLAGS=--btf_gen_floats -j1 --skip_encoding_btf_inconsistent_proto --btf_gen_optimized']
    commands=[[*make,'olddefconfig'],[*make,'Image','vmlinux']]
    exit_codes=[]
    try:
        with (OUT/'build.log').open('w') as log:
            for index,command in enumerate(commands):
                result=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT)
                exit_codes.append(result.returncode);result.check_returncode()
                if index==0:
                    symbols=verify_config(output/'.config')
                    (OUT/'resolved-symbols.json').write_text(json.dumps({'kernelBuilt':False,'requiredSymbols':symbols,'configSha256':digest(output/'.config')},indent=2)+'\n')
    finally:
        counters={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.current','memory.peak','memory.events'] if (Path('/sys/fs/cgroup')/name).exists()}
        (OUT/'build-resource-final.json').write_text(json.dumps({'commands':commands,'toolExitCodes':exit_codes,'cgroup':counters,'note':'Captured after make and before container exit; builder counters, not Cowork VM telemetry.'},indent=2)+'\n')
    artifacts={name:digest(output/name) for name in ['.config','vmlinux','arch/arm64/boot/Image']}
    toolchain_files={str(path.relative_to(toolchain)):digest(path) for path in sorted(toolchain.rglob('*')) if path.is_file()}
    (OUT/'toolchain-files.json').write_text(json.dumps(toolchain_files,indent=2)+'\n')
    license_files={str(path.relative_to(source)):digest(path) for path in sorted((source/'LICENSES').rglob('*')) if path.is_file()}
    license_files['COPYING']=digest(source/'COPYING')
    (OUT/'kernel-licenses.json').write_text(json.dumps(license_files,indent=2)+'\n')
    receipt={'kernelBuilt':True,'initramfsBuilt':False,'productionReady':False,'resumedVerifiedBuild':args.resume_verified,'sourceSha256':PINS['kernel']['sha256'],'toolchainArchiveSha256':llvm['sha256'],'toolchainFileManifestSha256':digest(OUT/'toolchain-files.json'),'kernelLicenseManifestSha256':digest(OUT/'kernel-licenses.json'),'builderReceiptSha256':digest(args.builder_receipt),'builder':builder,'commands':commands,'environment':env,'requiredSymbols':symbols,'artifacts':artifacts,'artifactBytes':{name:(output/name).stat().st_size for name in artifacts},'moduleInventory':[],'patches':[],'remaining':'Independently review builder dependency receipt, regular serial binding and trusted immutable userspace/key bootstrap; boot and remeasure crypto profile. No crypto/unlock claim follows from compilation.'}
    (OUT/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
