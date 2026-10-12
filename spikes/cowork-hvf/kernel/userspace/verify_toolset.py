"""Verify relocated neutral toolset hashes and observed dynamic-loader closure."""
import argparse,hashlib,json,re,subprocess
from pathlib import Path

BASE_IMAGE='sha256:8143f5c8e71574a89a9dc0cfbfa43cc4c491f02f6a08b3f0f8910329de137de8'
def verify_files(bundle,manifest):
    for name,entry in manifest.items():
        path=bundle/name
        with path.open('rb') as stream:actual=hashlib.file_digest(stream,'sha256').hexdigest()
        if actual!=entry['sha256'] or path.stat().st_size!=entry['bytes']:raise RuntimeError('Immutable bundle file mismatch: '+name)
        if format(path.stat().st_mode & 0o777,'04o')!=entry['mode']:raise RuntimeError('Immutable bundle mode mismatch: '+name)

def verify_relocation(bundle,out):
    base=['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--memory-swap','256m','--cpus','1','--user','501:20','--mount','type=bind,src='+str(bundle.resolve())+',dst=/bundle,readonly','--env','LD_DEBUG=libs','--env','LC_ALL=C','--env','OPENSSL_MODULES=/bundle/usr/lib/aarch64-linux-gnu/ossl-modules',BASE_IMAGE,'/bundle/lib/ld-linux-aarch64.so.1','--library-path','/bundle/lib:/bundle/lib/aarch64-linux-gnu:/bundle/usr/lib/aarch64-linux-gnu']
    report={}
    for program,args in [('cowork-crypto-capability',[]),('cryptsetup',['--version']),('integritysetup',['--version'])]:
        result=subprocess.run([*base,'/bundle/sbin/'+program,*args],capture_output=True,text=True)
        (out/(program+'-relocated.stdout')).write_text(result.stdout);(out/(program+'-relocated.ld-debug')).write_text(result.stderr)
        loaded=re.findall(r'calling init:\s+(/\S+)',result.stderr);unexpected=[path for path in loaded if not path.startswith('/bundle/')]
        if result.returncode or unexpected or '2.8.8' not in result.stdout:raise RuntimeError('Relocated verification failed: '+program)
        report[program]={'exitCode':result.returncode,'stdout':result.stdout.strip(),'initializedLibraries':loaded,'builderLibraryFallback':unexpected}
    report['scope']='Version and no-key/no-device API settings only; not all possible cryptsetup operations or a guest cipher/unlock/boot test.'
    (out/'relocated-verification.json').write_text(json.dumps(report,indent=2)+'\n');return report

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    verify_files(args.output/'toolset',json.loads((args.output/'toolset-files.json').read_text()))
    print(json.dumps(verify_relocation(args.output/'toolset',args.output)))
if __name__=='__main__':main()
