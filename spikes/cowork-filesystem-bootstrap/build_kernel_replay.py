"""No-launch Linux native build; exact source/artifact receipt precedes Root fixture use."""
import argparse,hashlib,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).parent.resolve()
SOURCES=['kernel-journal-replay.c','fixture-loop-replay.c','kernel_replay.py','bootstrap.py','test_kernel_replay.py','build_kernel_replay.py']
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def validate(receipt,artifacts):
    if set(receipt)!= {'formatVersion','sources','artifacts','compiler'} or receipt['formatVersion']!=1 or set(receipt['sources'])!=set(SOURCES) or set(receipt['artifacts'])!={'kernel-journal-replay','fixture-loop-replay'}:raise ValueError('closed reviewed receipt')
    for name,expected in receipt['sources'].items():
        if (ROOT/name).is_symlink() or digest(ROOT/name)!=expected:raise ValueError('reviewed source changed')
    for name,expected in receipt['artifacts'].items():
        if (artifacts/name).is_symlink() or digest(artifacts/name)!=expected:raise ValueError('reviewed artifact changed')
    return receipt
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
    if sys.platform!='linux' or args.out.exists():raise SystemExit('Linux no-launch build into new directory only')
    sources={name:digest(ROOT/name) for name in SOURCES};args.out.mkdir(parents=True,mode=0o700)
    for name in ['kernel-journal-replay','fixture-loop-replay']:
        subprocess.run(['cc','-std=c11','-O2','-static','-Wall','-Wextra','-Werror',str(ROOT/(name+'.c')),'-o',str(args.out/name)],check=True,timeout=60);(args.out/name).chmod(0o555)
    if sources!={name:digest(ROOT/name) for name in SOURCES}:raise SystemExit('source changed during build')
    receipt={'formatVersion':1,'sources':sources,'artifacts':{name:digest(args.out/name) for name in ['kernel-journal-replay','fixture-loop-replay']},'compiler':subprocess.run(['cc','--version'],capture_output=True,text=True,check=True).stdout.splitlines()[0]}
    (args.out/'build.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n');(args.out/'build.json').chmod(0o444)
    print(json.dumps({'built':True,'privilegedExecutionVerified':False,'vmExecutionVerified':False}))
