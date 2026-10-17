"""Read back actual newc metadata and contents independently of the encoder."""
import argparse, hashlib, json, stat
from pathlib import Path, PurePosixPath

HERE=Path(__file__).resolve().parent
# Every other way a kernel or a package could start something in an initramfs root. Only `init` is allowed, and only the pinned one.
STARTUP_NAMES={'sbin/init','usr/sbin/init','linuxrc','etc/inittab','init.sh','rdinit'}

def verify(root,pinned_init=None,require_init=True,allow_unpinned=False):
    """Read the cpio back. With `require_init` the root must carry exactly one startup program: `init`, a regular 0555 file of
    uid/gid 0 whose bytes hash to the digest pinned in pins.json (or `pinned_init`). `require_init=False` is for roots built
    before slice S5, which must still have NO startup program."""
    receipt=json.loads((root/'receipt.json').read_text())
    # image.py writes a full receipt with reproducibilityPinned false (and exits 3) while expectedArtifact is null: such a root is evidence of a build, not an accepted artifact
    if receipt.get('reproducibilityPinned') is not True and not allow_unpinned:raise ValueError('receipt is not reproducibility-pinned')
    manifest=json.loads((root/'root.manifest.json').read_text())
    if pinned_init is None and require_init:pinned_init=json.loads((HERE/'pins.json').read_text())['guest']['programs']['init']['binarySha256']
    startup={}
    expected={entry['path'].lstrip('/'):entry for entry in manifest};seen=set();inodes=set();count=0
    with (root/'immutable-root.cpio').open('rb') as stream:
        while True:
            header=stream.read(110)
            if len(header)!=110 or header[:6]!=b'070701':raise ValueError('cpio header')
            v=[int(header[6+i*8:14+i*8],16) for i in range(13)]
            inode,mode,uid,gid,nlink,mtime,size,devmajor,devminor,rdevmajor,rdevminor,namesize,check=v
            if uid or gid or mtime or nlink!=1 or devmajor or devminor or rdevmajor or rdevminor or check:raise ValueError('cpio authority metadata')
            if namesize<2 or namesize>4096 or size>256*1024*1024:raise ValueError('cpio entry bound')
            encoded=stream.read(namesize)
            if len(encoded)!=namesize or encoded[-1:]!=b'\0':raise ValueError('cpio name')
            name=encoded[:-1].decode();stream.read((-(110+namesize))%4)
            if name=='TRAILER!!!':
                if size or mode or stream.read().strip(b'\0'):raise ValueError('cpio trailer')
                break
            p=PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or str(p)!=name or name in seen or inode in inodes:raise ValueError('cpio namespace')
            seen.add(name);inodes.add(inode);entry=expected.get(name)
            if entry is None:raise ValueError('unexpected cpio member')
            kind={stat.S_IFREG:'file',stat.S_IFDIR:'directory',stat.S_IFLNK:'symlink'}.get(stat.S_IFMT(mode))
            if kind!=entry['type'] or stat.S_IMODE(mode)!=int(entry['mode'],8) or size!=entry['size']:raise ValueError('cpio mode/type/size')
            digest=hashlib.sha256();remaining=size
            while remaining:
                data=stream.read(min(remaining,1024*1024))
                if not data:raise ValueError('cpio truncated content')
                digest.update(data);remaining-=len(data)
            if digest.hexdigest()!=entry['sha256']:raise ValueError('cpio content digest')
            if name=='init' or name in STARTUP_NAMES:startup[name]=(kind,stat.S_IMODE(mode),digest.hexdigest())
            stream.read((-size)%4);count+=1
    if seen!=set(expected):raise ValueError('cpio missing entries')
    digest=hashlib.sha256()
    with (root/'immutable-root.cpio').open('rb') as stream:
        while data:=stream.read(1024*1024):digest.update(data)
    if digest.hexdigest()!=receipt['cpioSha256']:raise ValueError('cpio receipt')
    if require_init:
        if set(startup)!={'init'} or startup['init']!=('file',0o555,pinned_init):raise ValueError('cpio startup program is not exactly the pinned init')
        if receipt.get('initSha256')!=pinned_init or receipt.get('initPresent') is not True:raise ValueError('receipt does not describe the pinned init')
    elif startup:raise ValueError('cpio carries a startup program')
    return {'cpioVerified':True,'entries':count,'uid':0,'gid':0,'regularModes':['0444','0555'],'directoryMode':'0555','deviceNodes':0,'startupPresent':bool(startup),'startupEntries':sorted(startup),'initSha256':pinned_init if require_init else None}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);parser.add_argument('--allow-unpinned',action='store_true',help='accept a receipt with reproducibilityPinned false (a build whose expectedArtifact is still null)');parser.add_argument('--no-init',action='store_true',help='a root built before N2 slice S5: it must have no startup program');args=parser.parse_args();print(json.dumps(verify(args.root,require_init=not args.no_init,allow_unpinned=args.allow_unpinned),sort_keys=True))
