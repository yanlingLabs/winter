"""Read back actual newc metadata and contents independently of the encoder."""
import argparse, hashlib, json, re, stat
from pathlib import Path, PurePosixPath

HERE=Path(__file__).resolve().parent
# Every other way a kernel or a package could start something in an initramfs root. Only `init` is allowed, and only the pinned one.
STARTUP_NAMES={'sbin/init','usr/sbin/init','linuxrc','etc/inittab','init.sh','rdinit'}

# ---- the supervisor's host-query runtime artifacts (N2) ---------------------------------------------------------------------------------------
RUNTIME_ARTIFACT_PATHS={'launcher':'/opt/winter/helpers/linux-runtime-compartment','executable':'/opt/winter/runtime/winter-host-query','ownerLibrary':'/opt/winter/helpers/linux-session-owner.so'}
RUNTIME_ARTIFACTS_PATH='opt/winter/etc/supervisor-runtime-artifacts.json'
MAX_RUNTIME_ARTIFACT_BYTES=128*1024*1024     # the supervisor's `pinned_artifact` bound
MAX_RUNTIME_ARTIFACTS_JSON_BYTES=4096        # the image's host-query object is held to this; the guest's own bound is WG_CONFIG_RUNTIME_MAX (16384, trusted_config.h)

def _no_duplicates(pairs):
    keys=[key for key,_ in pairs]
    if len(set(keys))!=len(keys):raise ValueError('duplicate key in the runtime artifacts file')
    return dict(pairs)

def check_runtime_artifacts(files,config_bytes):
    """The runtime artifacts as the supervisor and PID 1 will meet them. `files` maps an absolute image path to what the cpio (or the tree about to be encoded)
    says of it: kind, mode, uid, gid, nlink, size, sha256. The JSON must be exactly `{"artifacts":{launcher,executable,ownerLibrary}}`, each member
    `{path,sha256}` at the image's fixed path; every artifact must be a regular file owned by root, mode 0555, one link, at most 128 MiB, and its bytes
    must hash to the pin. Returns the pins on success."""
    try:config=json.loads(config_bytes.decode('ascii'),object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError,json.JSONDecodeError) as error:raise ValueError('runtime artifacts file is not JSON') from error
    if not isinstance(config,dict) or set(config)!={'artifacts'} or not isinstance(config['artifacts'],dict) or set(config['artifacts'])!=set(RUNTIME_ARTIFACT_PATHS):
        raise ValueError('runtime artifacts must be exactly launcher, executable and ownerLibrary')
    if config_bytes!=json.dumps(config,sort_keys=True,separators=(',',':')).encode()+b'\n':raise ValueError('runtime artifacts file is not canonical')
    own=files.get('/'+RUNTIME_ARTIFACTS_PATH)
    if own is None or own['kind']!='file' or own['uid'] or own['gid'] or own['nlink']!=1 or own['mode']&0o222:raise ValueError('runtime artifacts file is not a root-owned read-only regular file')
    pins={}
    for key,expected_path in RUNTIME_ARTIFACT_PATHS.items():
        entry=config['artifacts'][key]
        if not isinstance(entry,dict) or set(entry)!={'path','sha256'} or entry['path']!=expected_path or not isinstance(entry['sha256'],str):
            raise ValueError('runtime artifact pin malformed: '+key)
        found=files.get(expected_path)
        if found is None or found['kind']!='file':raise ValueError('runtime artifact missing or not a regular file: '+key)
        if found['uid'] or found['gid']:raise ValueError('runtime artifact not owned by root: '+key)
        if found['mode']!=0o555:raise ValueError('runtime artifact mode is not 0555: '+key)
        if found['nlink']!=1:raise ValueError('runtime artifact link count is not 1: '+key)
        if not 0<found['size']<=MAX_RUNTIME_ARTIFACT_BYTES:raise ValueError('runtime artifact size out of bounds: '+key)
        if found['sha256']!=entry['sha256']:raise ValueError('runtime artifact bytes do not match their pin: '+key)
        pins[key]=entry['sha256']
    if len(set(RUNTIME_ARTIFACT_PATHS.values()))!=3:raise ValueError('runtime artifact paths must be distinct')
    return pins

# ---- the environment's fixed system gitconfig (agent-sdk SH6b mounts base/etc/gitconfig read-only into the process worker) ---------------------
ENVIRONMENT_GITCONFIG_PATH='/opt/winter/environment/base/etc/gitconfig'
GIT_TEMPLATE_DIRECTORY='/opt/winter/environment/base/usr/share/winter/git-empty-template'   # init.templateDir below: an empty, root-owned directory, so git never makes .git/hooks
MAX_GITCONFIG_BYTES=64*1024                  # the tool launcher's own bound
# The ONLY settings the file may carry, with their only values. Anything else (an include, includeIf, alias, hook path, fsmonitor command, credential helper, url rewrite,
# core.sshCommand, core.pager, ...) is refused: the file is read by every git the tool side runs, so an extra line is an extra way to run something.
GITCONFIG_SETTINGS={('init','templatedir'):'/usr/share/winter/git-empty-template',('core','hookspath'):'/dev/null',('core','fsmonitor'):'false',('credential','helper'):'',('protocol.ext','allow'):'never'}

def check_gitconfig_text(data):
    """The gitconfig text as git will read it: ASCII, bounded, only the settings above with exactly their values, each once. Returns the settings."""
    if len(data)>MAX_GITCONFIG_BYTES:raise ValueError('gitconfig size out of bounds')
    try:text=data.decode('ascii')
    except UnicodeDecodeError as error:raise ValueError('gitconfig is not ASCII') from error
    if not text.endswith('\n') or '\r' in text or '\0' in text or '\\' in text:raise ValueError('gitconfig is not plain LF text without continuations')
    section=None;found={}
    for line in text.split('\n')[:-1]:
        line=line.strip()
        if not line or line.startswith('#'):continue
        if line.startswith('['):
            match=re.fullmatch(r'\[([A-Za-z0-9-]+)(?: "([A-Za-z0-9._-]+)")?\]',line)
            if match is None:raise ValueError('gitconfig section is not plain: '+line)
            section=match.group(1).lower()+('.'+match.group(2) if match.group(2) else '');continue
        match=re.fullmatch(r'([A-Za-z][A-Za-z0-9-]*)[ \t]*=[ \t]*([^#;"]*?)[ \t]*',line)
        if match is None:raise ValueError('gitconfig line is not a plain setting: '+line)
        key=(section,match.group(1).lower())
        if key in found:raise ValueError('gitconfig setting is repeated: '+line)
        found[key]=match.group(2)
    # (an unknown key or a changed value is a difference from the allowed settings)
    if found!=GITCONFIG_SETTINGS:raise ValueError('gitconfig does not carry exactly the allowed settings and values')
    return found

def check_environment_gitconfig(files,expected_sha256):
    """The file as the tool launcher will meet it (regular, single link, root-owned, not group or other writable, at most 64 KiB) with the pinned bytes, and the empty
    template directory it names (root-owned, not writable, with nothing in it). `files` is the same map check_runtime_artifacts reads."""
    found=files.get(ENVIRONMENT_GITCONFIG_PATH)
    if found is None or found['kind']!='file':raise ValueError('environment gitconfig missing or not a regular file')
    if found['uid'] or found['gid'] or found['nlink']!=1 or found['mode']&0o022:raise ValueError('environment gitconfig is not a root-owned single-link file nobody else can write')
    if not 0<found['size']<=MAX_GITCONFIG_BYTES:raise ValueError('environment gitconfig size out of bounds')
    if found['sha256']!=expected_sha256:raise ValueError('environment gitconfig bytes do not match their pin')
    template=files.get(GIT_TEMPLATE_DIRECTORY)
    if template is None or template['kind']!='directory' or template['uid'] or template['gid'] or template['mode']&0o022:raise ValueError('git template directory is missing or not a root-owned read-only directory')
    if any(path.startswith(GIT_TEMPLATE_DIRECTORY+'/') for path in files):raise ValueError('git template directory is not empty')
    return expected_sha256

def verify(root,pinned_init=None,require_init=True,allow_unpinned=False):
    """Read the cpio back. With `require_init` the root must carry exactly one startup program: `init`, a regular 0555 file of
    uid/gid 0 whose bytes hash to the digest pinned in pins.json (or `pinned_init`). `require_init=False` is for roots built
    before slice S5, which must still have NO startup program."""
    receipt=json.loads((root/'receipt.json').read_text())
    # image.py writes a full receipt with reproducibilityPinned false (and exits 3) while expectedArtifact is null: such a root is evidence of a build, not an accepted artifact
    if receipt.get('reproducibilityPinned') is not True and not allow_unpinned:raise ValueError('receipt is not reproducibility-pinned')
    manifest=json.loads((root/'root.manifest.json').read_text())
    if pinned_init is None and require_init:pinned_init=json.loads((HERE/'pins.json').read_text())['guest']['programs']['init']['binarySha256']
    startup={};records={};config_bytes=None
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
            digest=hashlib.sha256();remaining=size;kept=bytearray()
            while remaining:
                data=stream.read(min(remaining,1024*1024))
                if not data:raise ValueError('cpio truncated content')
                digest.update(data);remaining-=len(data)
                if name==RUNTIME_ARTIFACTS_PATH and len(kept)<=MAX_RUNTIME_ARTIFACTS_JSON_BYTES:kept.extend(data)
            if name==RUNTIME_ARTIFACTS_PATH:config_bytes=bytes(kept)
            if digest.hexdigest()!=entry['sha256']:raise ValueError('cpio content digest')
            if name=='init' or name in STARTUP_NAMES:startup[name]=(kind,stat.S_IMODE(mode),digest.hexdigest())
            records['/'+name]={'kind':kind,'mode':stat.S_IMODE(mode),'uid':uid,'gid':gid,'nlink':nlink,'size':size,'sha256':digest.hexdigest()}
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
    runtime=None
    if receipt.get('hostQuery') is not None:   # a root built for the host-query runtime must carry exactly the artifacts its receipt describes
        if config_bytes is None:raise ValueError('runtime artifacts file missing from the cpio')
        runtime=check_runtime_artifacts(records,config_bytes)
        if runtime!={key:value['sha256'] for key,value in receipt['hostQuery']['artifacts'].items()}:raise ValueError('receipt does not describe the runtime artifacts')
    environment=None
    if receipt.get('environment') is not None:   # a root built with the environment's gitconfig must carry exactly the pinned one
        pinned=json.loads((HERE/'pins.json').read_text())['environment']['gitconfigSha256']
        if receipt['environment'].get('gitconfigSha256')!=pinned:raise ValueError('receipt does not describe the pinned environment gitconfig')
        environment=check_environment_gitconfig(records,pinned)
    return {'cpioVerified':True,'entries':count,'uid':0,'gid':0,'regularModes':['0444','0555'],'directoryMode':'0555','deviceNodes':0,'startupPresent':bool(startup),'startupEntries':sorted(startup),'initSha256':pinned_init if require_init else None,'runtimeArtifacts':runtime}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);parser.add_argument('--allow-unpinned',action='store_true',help='accept a receipt with reproducibilityPinned false (a build whose expectedArtifact is still null)');parser.add_argument('--no-init',action='store_true',help='a root built before N2 slice S5: it must have no startup program');args=parser.parse_args();print(json.dumps(verify(args.root,require_init=not args.no_init,allow_unpinned=args.allow_unpinned),sort_keys=True))
