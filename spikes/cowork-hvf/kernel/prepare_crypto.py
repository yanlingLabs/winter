"""Offline pinned crypto-kernel input verifier/extractor. Does not launch a VM or build/unlock disks."""
import argparse,hashlib,json,lzma,os,shutil,subprocess,tarfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
OUT=Path(os.environ.get('COWORK_KERNEL_OUT',HERE.parent/'out/kernel-crypto'))
PINS=json.loads((HERE/'crypto-inputs.json').read_text())
def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def verify(path,expected):
    if digest(path)!=expected:raise RuntimeError('Pinned checksum mismatch: '+str(path))
def verify_config(path):
    actual={}
    for line in path.read_text().splitlines():
        if line.startswith('CONFIG_') and '=' in line:
            key,value=line.split('=',1);actual[key]=value
        elif line.startswith('# CONFIG_') and line.endswith(' is not set'):actual[line[2:-11]]='n'
    requested={line.split('=',1)[0]:line.split('=',1)[1] for line in (HERE/PINS['fragment']['file']).read_text().splitlines() if line.startswith('CONFIG_')}
    missing={name:(want,actual.get(name)) for name,want in requested.items() if actual.get(name)!=want}
    if missing:raise RuntimeError('Unresolved required kernel symbols: '+json.dumps(missing))
    return requested

def verify_source():
    OUT.mkdir(parents=True,exist_ok=True)
    archive=OUT/f"linux-{PINS['kernel']['version']}.tar.xz"
    verify(archive,PINS['kernel']['sha256'])
    verify(HERE/'linux-6.18.35.tar.sign',PINS['kernel']['signatureSha256'])
    verify(HERE/'gregkh-public.key',PINS['kernel']['publicKeySha256'])
    for name in ['baseConfig','fragment']:verify(HERE/PINS[name]['file'],PINS[name]['sha256'])
    home=OUT/'verify-gnupg';home.mkdir(mode=0o700,exist_ok=True);os.chmod(home,0o700)
    # gpgv accepts the downloaded public packet keyring directly. No gpg/dirmngr or user keyring.
    command=['gpgv','--homedir',str(home),'--keyring',str(HERE/'gregkh-public.key'),'--status-fd','1',str(HERE/'linux-6.18.35.tar.sign'),'-']
    with (OUT/'source-verification.log').open('wb') as log:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT)
        try:
            with lzma.open(archive,'rb') as data:shutil.copyfileobj(data,process.stdin,1024*1024)
            process.stdin.close();result=process.wait(timeout=60)
        except BaseException:
            process.kill();process.wait();raise
    output=(OUT/'source-verification.log').read_text()
    if result!=0 or '[GNUPG:] VALIDSIG '+PINS['kernel']['signerFingerprint']+' ' not in output:raise RuntimeError('Kernel developer signature invalid')
    return archive

def verify_toolchain():
    pin=PINS['toolchainCandidate'];archive=OUT/pin['archive']
    verify(archive,pin['sha256'])
    verify(HERE/pin['signatureFile'],pin['signatureSha256'])
    verify(HERE/pin['publicKeyFile'],pin['publicKeySha256'])
    verify(HERE/pin['licenseFile'],pin['licenseSha256'])
    home=OUT/'verify-gnupg';home.mkdir(mode=0o700,exist_ok=True)
    command=['gpgv','--homedir',str(home),'--keyring',str(HERE/pin['publicKeyFile']),'--status-fd','1',str(HERE/pin['signatureFile']),'-']
    with (OUT/'toolchain-verification.log').open('wb') as log:
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=log,stderr=subprocess.STDOUT)
        try:
            with lzma.open(archive,'rb') as data:shutil.copyfileobj(data,process.stdin,1024*1024)
            process.stdin.close();result=process.wait(timeout=60)
        except BaseException:
            process.kill();process.wait();raise
    text=(OUT/'toolchain-verification.log').read_text()
    if result!=0 or '[GNUPG:] VALIDSIG '+pin['signerFingerprint']+' ' not in text:raise RuntimeError('LLVM release signature invalid')
    return archive

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--extract',action='store_true');parser.add_argument('--verify-config',type=Path);args=parser.parse_args()
    if args.verify_config:
        print(json.dumps({'requiredSymbols':verify_config(args.verify_config),'configSha256':digest(args.verify_config),'kernelBuilt':False}));return
    archive=verify_source()
    if args.extract:
        source=OUT/f"linux-{PINS['kernel']['version']}"
        if source.exists():raise RuntimeError('Source already exists; refusing to overwrite a possible build')
        with tarfile.open(archive,'r:xz') as tar:
            members=tar.getmembers();prefix=source.name+'/'
            if any(not (member.name==source.name or member.name.startswith(prefix)) for member in members):raise RuntimeError('Unexpected archive roots')
            tar.extractall(OUT,filter='data')
        shutil.copyfile(HERE/PINS['baseConfig']['file'],source/'.config')
    receipt={'sourceVerified':True,'sourceSha256':PINS['kernel']['sha256'],'signerFingerprint':PINS['kernel']['signerFingerprint'],'sourceExtracted':args.extract,'kernelBuilt':False,'initramfsBuilt':False,'productionReady':False,'builderReady':False,'remaining':PINS['builder']['required']}
    (OUT/'prepared-inputs.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
