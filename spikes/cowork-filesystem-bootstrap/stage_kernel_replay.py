"""Trusted no-effect parent. Imports ONLY isolated system stdlib before admission.
Never executes repository fixture code until the approved byte closure is copied,
hash-checked, Root-owned and readonly. No mount/loop/tool effect occurs in staging.
The parent itself must be independently hash-admitted by the README inline command.
"""
import argparse,hashlib,json,os,stat,subprocess,sys,tempfile
from pathlib import Path
SOURCES=('kernel-journal-replay.c','fixture-loop-replay.c','kernel_replay.py','bootstrap.py','test_kernel_replay.py','test_bootstrap.py','build_kernel_replay.py','stage_kernel_replay.py')
ARTIFACTS=('kernel-journal-replay','fixture-loop-replay')
LIMIT=4*1024*1024

def checked_bytes(directory,name,expected):
    # Hold a directory and exact no-follow leaf descriptor; never reopen original
    # spelling after checking an alias or trust caller-provided imports/search paths.
    folder=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=folder)
    finally:os.close(folder)
    try:
        identity=os.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink!=1 or identity.st_size>LIMIT:raise ValueError('review input identity')
        data=os.pread(fd,LIMIT+1,0)
        if len(data)!=identity.st_size or len(data)>LIMIT or hashlib.sha256(data).hexdigest()!=expected:raise ValueError('review input changed')
        return data
    finally:os.close(fd)

def capture(source,artifacts,receipt_path,approved_digest):
    wire=checked_bytes(receipt_path.parent,receipt_path.name,approved_digest);receipt=json.loads(wire)
    if type(receipt) is not dict or set(receipt)!= {'formatVersion','sources','artifacts','compiler'} or receipt['formatVersion']!=1 or set(receipt['sources'])!=set(SOURCES) or set(receipt['artifacts'])!=set(ARTIFACTS):raise ValueError('closed executable closure')
    entries={name:checked_bytes(source,name,receipt['sources'][name]) for name in SOURCES}
    entries.update({name:checked_bytes(artifacts,name,receipt['artifacts'][name]) for name in ARTIFACTS});entries['build.json']=wire
    return entries

def trusted_staging_ancestry(directory=None):
    # Linux /tmp is fixed, never TMPDIR or a caller-owned ancestor. Sticky /tmp
    # prevents another uid renaming our Root-owned child; / itself cannot be writable.
    for name in ('/','/tmp'):
        info=os.lstat(name)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0:raise ValueError('untrusted staging ancestry')
        writable=stat.S_IMODE(info.st_mode)&0o022
        if writable and (name=='/' or not info.st_mode&stat.S_ISVTX):raise ValueError('untrusted staging ancestry')
    if directory is not None:
        directory=Path(directory)
        if directory.parent!=Path('/tmp') or not directory.name.startswith('winter-replay-reviewed-'):raise ValueError('untrusted staging ancestry')

def stage(entries):
    if os.geteuid()!=0:raise ValueError('Root-owned staging required')
    trusted_staging_ancestry()
    directory=Path(tempfile.mkdtemp(prefix='winter-replay-reviewed-',dir='/tmp'));directory.chmod(0o700)
    # No input code runs during capture or staging, including failure. A partial
    # staged tree stays for audit; the parent never enters a fixture after refusal.
    for name in (*SOURCES,*ARTIFACTS,'build.json'):
        target=directory/name
        fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_CLOEXEC,0o600)
        try:
            data=entries[name];at=0
            while at<len(data):at+=os.write(fd,data[at:])
            os.fsync(fd)
        finally:os.close(fd)
        target.chmod(0o500 if name in ARTIFACTS else 0o400)
    directory.chmod(0o500);verify_staged(directory,hashlib.sha256(entries['build.json']).hexdigest());return directory

def verify_staged(directory,approved_digest):
    trusted_staging_ancestry(directory)
    directory=Path(directory);root=os.lstat(directory)
    if not stat.S_ISDIR(root.st_mode) or root.st_uid!=0 or stat.S_IMODE(root.st_mode)!=0o500:raise ValueError('immutable staged root required')
    if set(os.listdir(directory))!=set((*SOURCES,*ARTIFACTS,'build.json')):raise ValueError('staged closure inventory')
    wire=checked_bytes(directory,'build.json',approved_digest);receipt=json.loads(wire)
    if set(receipt['sources'])!=set(SOURCES) or set(receipt['artifacts'])!=set(ARTIFACTS):raise ValueError('staged closure receipt')
    for name in (*SOURCES,*ARTIFACTS,'build.json'):
        identity=os.lstat(directory/name)
        if identity.st_uid!=0 or identity.st_mode&0o222:raise ValueError('immutable staged leaf required')
        expected=approved_digest if name=='build.json' else (receipt['sources'].get(name) or receipt['artifacts'][name])
        checked_bytes(directory,name,expected)
    return receipt

def run_staged(directory,approved_digest):
    # Actual source execution boundary: full closure verified before the new interpreter starts.
    verify_staged(directory,approved_digest)
    env={'LANG':'C','LC_ALL':'C','PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/nonexistent','WINTER_RUN_KERNEL_REPLAY_FIXTURE':'1','WINTER_KERNEL_REPLAY_STAGED_ROOT':str(directory),'WINTER_KERNEL_REPLAY_APPROVED_RECEIPT_SHA':approved_digest,'WINTER_KERNEL_REPLAY_RECEIPT':str(directory/'build.json')}
    return subprocess.run([sys.executable,'-I','-S','-B',str(directory/'test_kernel_replay.py')],cwd=directory,env=env,check=False).returncode

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--artifacts',type=Path,required=True);parser.add_argument('--receipt',type=Path,required=True);parser.add_argument('--approved-receipt-sha256',required=True);args=parser.parse_args()
    if not sys.flags.isolated or not sys.flags.no_site:raise SystemExit('isolated system stdlib required')
    entries=capture(args.source,args.artifacts,args.receipt,args.approved_receipt_sha256)
    staged=stage(entries);print(json.dumps({'staged':True,'stagingId':staged.name}),flush=True)
    raise SystemExit(run_staged(staged,args.approved_receipt_sha256))
