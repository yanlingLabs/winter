"""Offline source build and immutable dependency bundle. Never opens a disk or handles keys."""
import hashlib,json,lzma,os,re,shutil,subprocess,tarfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
OUT=Path('/build')
PINS=json.loads((HERE/'inputs.json').read_text())
def digest(path):
    with path.open('rb') as data:return hashlib.file_digest(data,'sha256').hexdigest()
def verify(path,sha):
    if digest(path)!=sha:raise RuntimeError('Pinned checksum mismatch: '+str(path))
def invoke(command,environment,log):
    result=subprocess.run(command,env=environment,stdout=log,stderr=subprocess.STDOUT)
    result.check_returncode()

def main():
    source_pin=PINS['cryptsetup'];archive=Path('/archives')/'cryptsetup-2.8.8.tar.xz'
    verify(archive,source_pin['sha256'])
    for name,sha in [(source_pin['keyFile'],source_pin['keySha256']),(source_pin['signatureFile'],source_pin['signatureSha256'])]:verify(HERE/name,sha)
    home=OUT/'home';temporary=OUT/'tmp';home.mkdir();temporary.mkdir()
    environment={'PATH':'/kernel-build/llvm/llvm-20.1.8-aarch64/bin:/usr/bin:/bin','HOME':str(home),'TMPDIR':str(temporary),'LC_ALL':'C','TZ':'UTC','SOURCE_DATE_EPOCH':'1788779410','CC':'/kernel-build/llvm/llvm-20.1.8-aarch64/bin/clang','AR':'/kernel-build/llvm/llvm-20.1.8-aarch64/bin/llvm-ar','RANLIB':'/kernel-build/llvm/llvm-20.1.8-aarch64/bin/llvm-ranlib','CFLAGS':'-O2 -g0 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -ffile-prefix-map=/build=.', 'LDFLAGS':'-Wl,-z,relro,-z,now'}
    verify(Path(environment['CC']),PINS['compiler']['clangSha256'])
    verification_home=OUT/'gnupg';verification_home.mkdir(mode=0o700)
    with (OUT/'source-verification.log').open('wb') as log:
        process=subprocess.Popen(['gpgv','--homedir',str(verification_home),'--keyring',str(HERE/source_pin['keyFile']),'--status-fd','1',str(HERE/source_pin['signatureFile']),'-'],env=environment,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT)
        try:
            with lzma.open(archive,'rb') as data:shutil.copyfileobj(data,process.stdin)
            process.stdin.close();status=process.wait(timeout=30)
        except BaseException:
            process.kill();process.wait();raise
    signature=(OUT/'source-verification.log').read_text()
    if status or '[GNUPG:] VALIDSIG '+source_pin['signerFingerprint']+' ' not in signature or any(word in signature for word in ['BADSIG','EXPKEYSIG','EXPSIG','KEYEXPIRED','REVKEYSIG']):raise RuntimeError('Source signature is invalid, expired or revoked')
    source=OUT/'source';source.mkdir()
    with tarfile.open(archive,'r:xz') as tar:tar.extractall(source,filter='data')
    source=source/'cryptsetup-2.8.8';output=OUT/'objects';output.mkdir();stage=OUT/'stage';stage.mkdir()
    commands=[[str(source/'configure'),*PINS['configureFlags']],['make','-j2'],['make','-j2','DESTDIR='+str(stage),'install']]
    statuses=[]
    try:
        with (OUT/'build.log').open('w') as log:
            for command in commands:
                result=subprocess.run(command,cwd=output,env=environment,stdout=log,stderr=subprocess.STDOUT);statuses.append(result.returncode);result.check_returncode()
            capability=[environment['CC'],*environment['CFLAGS'].split(),'-I'+str(stage/'usr/include'),str(HERE/'capability.c'),'-L'+str(stage/'lib'),'-lcryptsetup','-o',str(stage/'sbin/cowork-crypto-capability'),*environment['LDFLAGS'].split()]
            invoke(capability,environment,log);commands.append(capability)
    finally:
        counters={name:(Path('/sys/fs/cgroup')/name).read_text().strip() for name in ['memory.current','memory.peak','memory.events']}
        (OUT/'build-resources.json').write_text(json.dumps({'toolExitCodes':statuses,'cgroup':counters},indent=2)+'\n')
    bundle=OUT/'toolset';bundle.mkdir();(bundle/'sbin').mkdir();(bundle/'lib').mkdir()
    binaries=[stage/'sbin/cryptsetup',stage/'sbin/integritysetup',stage/'sbin/cowork-crypto-capability']
    # The pinned OpenSSL backend explicitly loads this provider through dlopen;
    # it is not in the tools' initial DT_NEEDED/ldd closure.
    provider=Path('/usr/lib/aarch64-linux-gnu/ossl-modules/legacy.so')
    provider_destination=bundle/str(provider).lstrip('/')
    provider_destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(provider,provider_destination)
    environment['LD_LIBRARY_PATH']=str(stage/'lib')
    dependencies={}
    for binary in [*binaries,provider]:
        if binary!=provider:shutil.copy2(binary,bundle/'sbin'/binary.name)
        linked=subprocess.check_output(['ldd',str(binary)],env=environment,text=True)
        if 'not found' in linked:raise RuntimeError('Unresolved runtime dependency: '+linked)
        for path in re.findall(r'(?:=>\s+)?(/[^\s]+)',linked):
            dependencies[path]=digest(Path(path));destination=bundle/path.lstrip('/')
            # A staged library should live at its configured /lib guest path.
            if path.startswith(str(stage)+'/'):destination=bundle/Path(path).relative_to(stage)
            destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,destination)
    environment['OPENSSL_MODULES']=str(provider_destination.parent)
    capability_output=subprocess.check_output([str(bundle/'lib/aarch64-linux-gnu/ld-linux-aarch64.so.1') if (bundle/'lib/aarch64-linux-gnu/ld-linux-aarch64.so.1').exists() else str(bundle/'lib/ld-linux-aarch64.so.1'),'--library-path',':'.join(str(bundle/path) for path in ['lib','lib/aarch64-linux-gnu','usr/lib/aarch64-linux-gnu']),str(bundle/'sbin/cowork-crypto-capability')],env=environment,text=True)
    report=json.loads(capability_output)
    if report.get('boundedPbkdf2SettingsAccepted') is not True:raise RuntimeError('Bounded capability settings rejected')
    (OUT/'capability.json').write_text(json.dumps(report,indent=2)+'\n')
    (OUT/'runtime-dependencies.json').write_text(json.dumps(dependencies,indent=2)+'\n')
    licenses={str(path.relative_to(source)):digest(path) for path in sorted((source/'docs/licenses').rglob('*')) if path.is_file()};licenses['COPYING']=digest(source/'COPYING')
    (OUT/'source-licenses.json').write_text(json.dumps(licenses,indent=2)+'\n')
    manifest={str(path.relative_to(bundle)):{'sha256':digest(path),'bytes':path.stat().st_size,'mode':'0555' if ('/sbin/' in str(path) or path.name.startswith('ld-linux')) else '0444'} for path in sorted(bundle.rglob('*')) if path.is_file()}
    for path in bundle.rglob('*'):
        if path.is_file():path.chmod(0o555 if ('/sbin/' in str(path) or path.name.startswith('ld-linux')) else 0o444)
    (OUT/'toolset-files.json').write_text(json.dumps(manifest,indent=2)+'\n')
    packed=OUT/'toolset.tar'
    with tarfile.open(packed,'w',format=tarfile.USTAR_FORMAT) as tar:
        for path in sorted(bundle.rglob('*')):
            entry=tar.gettarinfo(str(path),arcname=str(path.relative_to(bundle)));entry.uid=entry.gid=0;entry.uname=entry.gname='';entry.mtime=1788779410
            if path.is_file():
                with path.open('rb') as data:tar.addfile(entry,data)
            else:tar.addfile(entry)
    receipt={'toolsetBuilt':True,'bootableInitramfsBuilt':False,'unlockImplemented':False,'productionReady':False,'source':source_pin,'commands':commands,'environment':environment,'runtimeFiles':manifest,'sourceLicenseHashes':licenses,'capability':report,'archiveSha256':digest(packed),'archiveBytes':packed.stat().st_size,'remaining':'Independent candidate/header-binding review; trusted PID1/scoped inherited key transport and immutable bootstrap, no disk or VM run, no format/unlock implementation.'}
    (OUT/'toolset-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'toolsetBuilt':True,'archiveSha256':receipt['archiveSha256'],'bytes':receipt['archiveBytes']}))
if __name__=='__main__':main()
