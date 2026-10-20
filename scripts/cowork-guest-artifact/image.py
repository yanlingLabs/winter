"""Deterministic readonly guest root/cpio. No mount, chown, install or guest execution.

The only startup program is the pinned `/init` built from apple/Cowork/WinterCoworkGuest (N2 slice S5); every other startup
path is still refused. Nothing here runs it."""
import argparse, hashlib, io, json, os, posixpath, re, shutil, stat, struct, subprocess, sys, tarfile, zlib
from pathlib import Path, PurePosixPath
# Under `python3 -I` the script's own directory is NOT on sys.path (that is the point of -I), so the sibling modules are found by an explicit insert of this file's directory
# and nothing else: the interpreter still ignores PYTHON* variables, the user site and the current directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packages import sha, bounded_file, bounded_read, xz_chunks
import verify
HERE=Path(__file__).resolve().parent
GUEST=HERE.parents[1]/'apple/Cowork/WinterCoworkGuest'
SDK_GUEST_RELAY_NOTE='the in-guest relay presents FIFOs to a supervisor that accepts them only after the agent-SDK relay change merges'

class Tree:
    def __init__(self): self.nodes={}
    def add(self,name,kind,data=b'',executable=False,origin='derived'):
        path=PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or not path.parts or name=='TRAILER!!!' or '\0' in name: raise ValueError('unsafe image member')
        name=str(path)
        for parent in list(path.parents)[:-1]: self.add(str(parent),'directory',origin='derived')
        mode=0o555 if kind=='directory' or executable else 0o444
        if kind=='symlink':
            target=data.decode()
            if '\0' in target: raise ValueError('symlink NUL')
            # Guest-rooted resolution; NEVER follow an absolute guest link on the host.
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname('/'+name),target))
            if not resolved.startswith('/'): raise ValueError('symlink escape')
            mode=0o777
        node={'kind':kind,'mode':mode,'data':data,'origins':[origin]}
        if name in self.nodes:
            old=self.nodes[name]
            if (old['kind'],old['mode'],old['data'])!=(kind,mode,data): raise ValueError('conflicting image member '+name)
            if origin not in old['origins']: old['origins'].append(origin)
        else: self.nodes[name]=node
    def resolve(self,name):
        path=posixpath.normpath('/'+name.lstrip('/')); seen=set()
        for _ in range(64):
            if path in seen: raise ValueError('image link cycle')
            seen.add(path); parts=path.lstrip('/').split('/'); changed=False
            for i in range(len(parts)):
                key='/'.join(parts[:i+1]); node=self.nodes.get(key)
                if not node: raise ValueError('missing image target '+key)
                if node['kind']=='symlink':
                    path=posixpath.normpath(posixpath.join('/'+posixpath.dirname(key),node['data'].decode(),*parts[i+1:])); changed=True;break
            if not changed: return path.lstrip('/'),self.nodes[path.lstrip('/')]
        raise ValueError('image link depth')
    def manifest(self):
        return [{'path':'/'+name,'type':n['kind'],'mode':oct(n['mode']),'uid':0,'gid':0,'mtime':0,'nlink':1,'size':len(n['data']),'sha256':sha(n['data']),'origins':sorted(n['origins'])} for name,n in sorted(self.nodes.items())]
    def materialize(self,root):
        root.mkdir(mode=0o700)
        # Host files remain owned by the unprivileged builder; cpio/manifest encode guest root ownership.
        for name,n in sorted(self.nodes.items(),key=lambda item:(item[0].count('/'),item[0])):
            path=root/name
            if n['kind']=='directory': path.mkdir(exist_ok=True)
            elif n['kind']=='file': path.write_bytes(n['data'])
            else: path.symlink_to(n['data'].decode())
        for name,n in self.nodes.items():
            path=root/name
            if n['kind']!='symlink': os.chmod(path,n['mode']);os.utime(path,(0,0))
            elif hasattr(os,'lchmod'): os.lchmod(path,n['mode'])
            st=path.lstat()
            if stat.S_IMODE(st.st_mode)!=n['mode']: raise ValueError('materialized mode mismatch')
            if n['kind']=='file' and sha(path.read_bytes())!=sha(n['data']): raise ValueError('materialized bytes mismatch')
    def cpio(self,path):
        with path.open('wb') as output:
            def emit(name,mode,data,index):
                encoded=name.encode()+b'\0'
                fields=[index,mode,0,0,1,0,len(data),0,0,0,0,len(encoded),0]
                header=b'070701'+b''.join(f'{v:08x}'.encode() for v in fields)
                output.write(header+encoded);output.write(b'\0'*((-len(header)-len(encoded))%4));output.write(data);output.write(b'\0'*((-len(data))%4))
            for index,(name,n) in enumerate(sorted(self.nodes.items()),1):
                typebits={'file':stat.S_IFREG,'directory':stat.S_IFDIR,'symlink':stat.S_IFLNK}[n['kind']]
                emit(name,typebits|n['mode'],n['data'],index)
            emit('TRAILER!!!',0,b'',len(self.nodes)+1)
            output.write(b'\0'*((-output.tell())%512))

def ar_members(data):
    if not data.startswith(b'!<arch>\n'): raise ValueError('deb ar header')
    offset=8; members={}
    while offset<len(data):
        header=data[offset:offset+60]
        if len(header)!=60 or header[58:]!=b'`\n': raise ValueError('deb ar member')
        name=header[:16].decode().strip().rstrip('/');size=int(header[48:58]);offset+=60
        if size<0 or offset+size>len(data) or name in members: raise ValueError('deb ar size/duplicate')
        members[name]=data[offset:offset+size];offset+=size+(size%2)
    return members

class ChunkReader:
    def __init__(self,chunks):self.chunks=iter(chunks);self.pending=b''
    def read(self,size):
        if size<0:raise ValueError('unbounded metadata read')
        while len(self.pending)<size:
            try:self.pending+=next(self.chunks)
            except StopIteration:break
        result,self.pending=self.pending[:size],self.pending[size:]
        return result

def metadata_chunks(name,data,maximum):
    if name.endswith('.xz'):yield from xz_chunks(data,maximum);return
    if name.endswith('.gz'):
        decoder=zlib.decompressobj(16+zlib.MAX_WBITS);at=0;expanded=0
        while not decoder.eof:
            incoming=decoder.unconsumed_tail
            if not incoming:
                incoming=data[at:at+64*1024];at+=len(incoming)
                if not incoming:raise ValueError('truncated gzip metadata')
            block=decoder.decompress(incoming,min(64*1024,maximum-expanded+1))
            if expanded+len(block)>maximum:raise ValueError('metadata expansion bound')
            expanded+=len(block)
            if block:yield block
        if decoder.unused_data or at!=len(data):raise ValueError('gzip metadata trailing data')
        return
    if name.endswith('.tar'):
        if len(data)>maximum:raise ValueError('metadata expansion bound')
        for at in range(0,len(data),64*1024):yield data[at:at+64*1024]
        return
    raise ValueError('unsupported metadata compression')

def control_fields(name,data,maximum=2*1024*1024,field_limit=64*1024):
    # Cap decompression before tar/PAX processing and iterate headers without getmembers().
    reader=ChunkReader(metadata_chunks(name,data,maximum))
    with tarfile.open(fileobj=reader,mode='r|') as archive:
        for count,member in enumerate(archive,1):
            if count>128:raise ValueError('control entry count bound')
            if member.name.removeprefix('./')!='control':continue
            if not member.isfile() or member.size>field_limit:raise ValueError('control file bound')
            stream=archive.extractfile(member)
            if stream is None:raise ValueError('control file missing')
            text=bounded_read(stream,min(field_limit,member.size)).decode()
            if len(text.encode())!=member.size:raise ValueError('control file size')
            from packages import paragraphs
            return next(paragraphs(text))
    raise ValueError('control file missing')

def add_deb(tree,entry,path):
    data=bounded_file(path,64*1024*1024,int(entry['Size']))
    if sha(data)!=entry['SHA256'] or len(data)!=int(entry['Size']): raise ValueError('deb digest')
    members=ar_members(data)
    if members.get('debian-binary')!=b'2.0\n': raise ValueError('deb format')
    control_name,control=next((name,value) for name,value in members.items() if name.startswith('control.tar'))
    fields=control_fields(control_name,control)
    for key in ['Package','Version','Architecture']:
        if fields[key]!=entry[key]:raise ValueError('control/index identity')
    payload_name,payload=next((name,value) for name,value in members.items() if name.startswith('data.tar'))
    expanded=0; hardlinks=0
    with tarfile.open(fileobj=ChunkReader(metadata_chunks(payload_name,payload,1024*1024*1024)),mode='r|') as archive:
        for count,member in enumerate(archive,1):
            if count>32768:raise ValueError('payload entry count bound')
            name=member.name.removeprefix('./').rstrip('/')
            if name in ['','.']: continue
            expanded+=member.size
            if member.size>128*1024*1024 or expanded>1024*1024*1024: raise ValueError('package expansion bound')
            origin='deb:'+entry['Package']+'='+entry['Version']
            if member.isdir(): tree.add(name,'directory',origin=origin)
            elif member.isfile(): tree.add(name,'file',bounded_read(archive.extractfile(member),member.size),bool(member.mode&0o111),origin)
            elif member.issym(): tree.add(name,'symlink',member.linkname.encode(),origin=origin)
            elif member.islnk():
                hardlinks+=1
                # Resolve archive hardlinks as independent readonly bytes; never alias host inodes.
                target=member.linkname.removeprefix('./')
                _,node=tree.resolve(target)
                if node['kind']!='file': raise ValueError('non-file hardlink')
                tree.add(name,'file',node['data'],bool(node['mode']&0o111),origin)
            else: raise ValueError('device/FIFO/unsupported package member')
    return hardlinks

def elf(data):
    if not data.startswith(b'\x7fELF'): return None
    if data[4:7]!=b'\x02\x01\x01': raise ValueError('non ELF64 little-endian')
    kind,machine=struct.unpack_from('<HH',data,16)
    if machine!=183: raise ValueError('non ARM64 ELF')
    phoff=struct.unpack_from('<Q',data,32)[0];phsize,phnum=struct.unpack_from('<HH',data,54)
    if phsize!=56 or phnum>4096 or phoff+phsize*phnum>len(data): raise ValueError('ELF program headers')
    programs=[struct.unpack_from('<IIQQQQQQ',data,phoff+i*phsize) for i in range(phnum)]
    for p in programs:
        if p[2]+p[5]>len(data): raise ValueError('ELF segment bounds')
        if p[0]==1 and p[1]&3==3: raise ValueError('writable executable segment')
        if p[0]==0x6474e551 and p[1]&1: raise ValueError('executable stack')
    interpreter=next((data[p[2]:p[2]+p[5]].rstrip(b'\0').decode() for p in programs if p[0]==3),None)
    dynamic=[]
    for p in programs:
        if p[0]==2:
            for at in range(p[2],p[2]+p[5],16):
                tag,value=struct.unpack_from('<qQ',data,at)
                if tag==0: break
                dynamic.append((tag,value))
    def offset(address):
        for p in programs:
            if p[0]==1 and p[3]<=address<p[3]+p[5]: return p[2]+address-p[3]
        raise ValueError('ELF virtual string address')
    strings=next((offset(value) for tag,value in dynamic if tag==5),None)
    def string(at):
        begin=strings+at; end=data.find(b'\0',begin)
        if end<begin: raise ValueError('ELF string bound')
        return data[begin:end].decode()
    needed=[string(value) for tag,value in dynamic if tag==1]
    search=[string(value) for tag,value in dynamic if tag in [15,29]]
    version_needs={}; definitions=[]
    pointer=next((value for tag,value in dynamic if tag==0x6ffffffe),None)
    count=next((value for tag,value in dynamic if tag==0x6fffffff),0)
    if count>4096: raise ValueError('ELF version need bound')
    if pointer is not None:
        at=offset(pointer)
        for _ in range(count):
            _,n,file,aux,next_entry=struct.unpack_from('<HHIII',data,at)
            if n>4096:raise ValueError('ELF version auxiliary bound')
            wanted=[];item=at+aux
            for _ in range(n):
                _,_,_,name,next_aux=struct.unpack_from('<IHHII',data,item);wanted.append(string(name));item+=next_aux
            version_needs[string(file)]=wanted;at+=next_entry
    pointer=next((value for tag,value in dynamic if tag==0x6ffffffc),None)
    count=next((value for tag,value in dynamic if tag==0x6ffffffd),0)
    if count>4096:raise ValueError('ELF version definition bound')
    if pointer is not None:
        at=offset(pointer)
        for _ in range(count):
            _,_,_,_,_,aux,next_entry=struct.unpack_from('<HHHHIII',data,at)
            name,_=struct.unpack_from('<II',data,at+aux);definitions.append(string(name));at+=next_entry
    return {'machine':'AArch64','type':kind,'interpreter':interpreter,'needed':needed,'search':search,'static':not dynamic and interpreter is None,'versionNeeds':version_needs,'versionsDefined':definitions}

def verify_elfs(tree):
    records={}; directories=['/lib/aarch64-linux-gnu','/usr/lib/aarch64-linux-gnu','/lib','/usr/lib']
    for name,node in sorted(tree.nodes.items()):
        if node['kind']!='file': continue
        info=elf(node['data'])
        if info is None: continue
        if info['interpreter']:
            _,loader=tree.resolve(info['interpreter'])
            if loader['kind']!='file' or elf(loader['data']) is None: raise ValueError('ELF loader missing')
        resolved=[]
        for dependency in info['needed']:
            if '/' in dependency: raise ValueError('absolute DT_NEEDED')
            paths=[]
            for value in info['search']:
                for item in value.split(':'):
                    item=item.replace('${ORIGIN}',posixpath.dirname('/'+name)).replace('$ORIGIN',posixpath.dirname('/'+name))
                    if not item.startswith('/') or '$' in item: raise ValueError('unresolved ELF search path')
                    paths.append(item)
            for directory in paths+directories:
                try: target,n=tree.resolve(directory+'/'+dependency)
                except ValueError: continue
                if n['kind']=='file':
                    provider=elf(n['data'])
                    if provider is not None:
                        missing=set(info['versionNeeds'].get(dependency,[]))-set(provider['versionsDefined'])
                        if missing:raise ValueError('ELF ABI version missing '+dependency+': '+','.join(sorted(missing)))
                        resolved.append('/'+target);break
            else: raise ValueError('missing ELF dependency '+name+': '+dependency)
        records['/'+name]=info|{'resolvedDependencies':resolved,'sha256':sha(node['data'])}
    return records


# ---- N2 slice S5: the one startup program, the guest-side files, the tool-device inventory ------------------------------

STARTUP_PATHS=['sbin/init','usr/sbin/init','linuxrc','etc/inittab']
TOOL_DEVICES_EXPECTED=['/dev/null','/dev/zero','/dev/full','/dev/random','/dev/urandom']

def check_startup(tree,expected_sha256):
    """Exactly one startup program may exist: the pinned `/init`, a regular 0555 file. No other init, linuxrc or inittab, whether
    spelled directly or reachable through a root alias."""
    node=tree.nodes.get('init')
    if node is None:raise ValueError('pinned init missing')
    if node['kind']!='file' or node['mode']!=0o555 or sha(node['data'])!=expected_sha256:raise ValueError('init is not the pinned program')
    for name in STARTUP_PATHS:
        if name in tree.nodes:raise ValueError('unpinned startup program '+name)
        try:target,found=tree.resolve('/'+name)
        except ValueError:continue
        if found['kind']=='file':raise ValueError('unpinned startup program reachable as /'+name)

def tool_device_inventory(source_text):
    """The `/dev` entries the process-tool compartment mounts, read from its C source: tool_devices[]={{"/dev/null",3},...}."""
    match=re.search(r'tool_devices\[\]\s*=\s*\{(.*?)\};',source_text,re.S)
    if match is None:raise ValueError('tool device inventory not found')
    return re.findall(r'\{\s*"([^"]+)"\s*,\s*\d+\s*\}',match.group(1))

def check_tool_devices(source_text):
    """Tools get five character devices and nothing else: no virtio port, block device, kmsg or whole /dev tree."""
    found=tool_device_inventory(source_text)
    if found!=TOOL_DEVICES_EXPECTED:raise ValueError('tool device inventory changed: '+','.join(found))
    return found

def supervisor_base_config(helper_digests):
    """The static part of the supervisor's trusted config (PID 1 adds guestBootId and the conversation set). Paths are where
    this image puts the helpers; digests are of the exact bytes in the cpio. Canonical, one line."""
    names={'launcher':'linux-tool-compartment','fileWorker':'file-worker','processWorker':'process-worker'}
    config={'artifacts':{key:{'path':'/opt/winter/helpers/'+name,'sha256':helper_digests[name]} for key,name in names.items()},
            'controlDirectory':'/run/winter/control','environment':'/opt/winter/environment/base','protectedStoreDirectories':[]}
    return json.dumps(config,sort_keys=True,separators=(',',':')).encode()

# ---- N2: the host-query runtime the supervisor starts (supervisor `hostQueryRuntime.artifacts`) ---------------------------------------

HOST_QUERY_ENTRY='scripts/guest-host-query/runtime.ts'   # imports packages/runtime/src/guest/linux-host-query-main.ts
# The static launcher and the glibc owner library are built from exact SDK source with the pinned Zig; the executable is the SDK's host-query entry
# compiled by the canonical builder against the pinned Bun base. Nothing here carries a provider: the supervisor takes only public provider
# metadata, and the process that would serve `provider.sock` (the provider bridge) is not part of this image.
NATIVE_STATIC=['file-worker.c','process-worker.c','linux-tool-compartment.c','linux-runtime-compartment.c']
NATIVE_SHARED={'linux-session-owner.c':'aarch64-linux-gnu.2.36'}   # loaded by bun:ffi dlopen inside the glibc Bun executable; Debian 12 ships glibc 2.36

def require_reproducible(first,second,label):
    """Two independent passes of one build must give the same bytes; otherwise nothing built from them is an artifact."""
    if first!=second:raise ValueError(label+' is not reproducible')
    return first

def native_name(source):
    return source.removesuffix('.c')+('.so' if source in NATIVE_SHARED else '')

def native_build(zig,cache,helper_dir,sdkcopy,source,outdir,env=None):
    """One exact-SDK-source native artifact with the pinned Zig: the helpers and the launcher static against musl, the owner library a glibc shared
    object (Debian 12 ships glibc 2.36) that may need nothing but libc. Stripped, no build id, source paths mapped away. Returns (bytes, command)."""
    shared=source in NATIVE_SHARED
    outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True);cache=Path(cache)
    binary=outdir/native_name(source)
    environment=(env or os.environ.copy())|{'ZIG_GLOBAL_CACHE_DIR':str(cache/'global'),'ZIG_LOCAL_CACHE_DIR':str(cache/'local')}
    common=['-std=c11','-O2','-Wall','-Wextra','-Werror','-pthread','-s','-Wl,--build-id=none','-ffile-prefix-map='+str(sdkcopy)+'=/winter-sdk']
    command=[str(zig),'cc','-target',NATIVE_SHARED[source] if shared else 'aarch64-linux-musl',*(['-shared','-fPIC'] if shared else ['-static']),*common,str(Path(helper_dir)/source),'-o',str(binary)]
    subprocess.run(command,capture_output=True,check=True,env=environment)
    data=binary.read_bytes();info=elf(data)
    if shared:
        if info['type']!=3 or info['static'] or info['interpreter'] or info['needed']!=['libc.so.6']:raise ValueError('owner library must be a glibc shared object needing only libc')
        if any(tuple(int(x) for x in v.removeprefix('GLIBC_').split('.'))>(2,36) for v in info['versionNeeds'].get('libc.so.6',[]) if v.startswith('GLIBC_')):raise ValueError('owner library needs a newer glibc than the image carries')
    elif not info['static']:raise ValueError('native helper must be static')
    return data,command

def runtime_artifacts_config(digests):
    """`/opt/winter/etc/supervisor-runtime-artifacts.json`: the value PID 1 splices under `hostQueryRuntime`. Exactly the three members the supervisor
    demands, each a path and a digest of the exact bytes in the cpio. Canonical, one line."""
    config={'artifacts':{key:{'path':path,'sha256':digests[key]} for key,path in verify.RUNTIME_ARTIFACT_PATHS.items()}}
    return json.dumps(config,sort_keys=True,separators=(',',':')).encode()

def refuse_provider_bridge(tree):
    """A NAME-BASED TRIPWIRE, not a proof, for decision D10 (the first Mac worker has no provider bridge). It catches the obvious mistake: a file under
    /opt/winter (the distribution's own files under the environment root are not judged) named like a provider worker, a credential broker or a host client,
    the main-entry runtime coming back, or a fourth runtime artifact. A renamed component passes it. What actually keeps a provider bridge out is the pinned
    root manifest and cpio digest (the image contains exactly the files it lists), the fact that nothing in the image serves `provider.sock`, and the guest
    relay, which refuses the provider class at the frame header."""
    for name in tree.nodes:
        lowered=name.lower()
        if lowered.startswith('opt/winter/') and not lowered.startswith('opt/winter/environment/') and ('provider' in lowered or 'credential' in lowered or lowered.endswith('host-client') or lowered.endswith('hostclient')):raise ValueError('provider bridge component in the image: '+name)
    if 'opt/winter/runtime/winter' in tree.nodes:raise ValueError('the main-entry runtime is not part of the image')
    node=tree.nodes.get(verify.RUNTIME_ARTIFACTS_PATH)
    if node is None or set(json.loads(node['data'])['artifacts'])!={'launcher','executable','ownerLibrary'}:raise ValueError('runtime artifacts are exactly launcher, executable, ownerLibrary')

def tree_files(tree):
    """The facts verify.check_runtime_artifacts reads, taken from the tree as it will be encoded (root uid/gid, one link)."""
    return {'/'+name:{'kind':n['kind'],'mode':n['mode'],'uid':0,'gid':0,'nlink':1,'size':len(n['data']),'sha256':sha(n['data'])} for name,n in tree.nodes.items()}

def check_expected(receipt,expected):
    """None = the expected digests are not pinned yet (the first build after a re-pin); otherwise any mismatch refuses."""
    if expected is None:return ['expectedArtifact is not pinned']
    problems=[]
    for key in ['runtimeSha256','cpioSha256','rootManifestSha256']:
        if receipt[key]!=expected[key]:problems.append('artifact reproducibility mismatch: '+key)
    for source,digest in expected['helperBinarySha256'].items():
        if receipt['sourceHelpers'][source]['binarySha256']!=digest:problems.append('native helper reproducibility mismatch: '+source)
    return problems

REQUIRED_PROGRAMS=['/opt/winter/runtime/winter-host-query','/usr/bin/python3.11','/bin/bash','/usr/bin/git','/sbin/mke2fs','/sbin/e2fsck','/sbin/dumpe2fs']

def add_guest_files(tree,programs,scripts,helper_digests,runtime_digests=None):
    """Everything slice S5 puts in the root: the pinned PID 1, the relay, the bootstrap helper, the static part of the supervisor's
    trusted config, and the mount point of the environment volume."""
    tree.add('init','file',programs['init'],True,'winter-guest:init')
    tree.add('opt/winter/libexec/winter-guest-relay','file',programs['winter-guest-relay'],True,'winter-guest:relay')
    for name,data in scripts.items():tree.add('opt/winter/libexec/'+name,'file',data,False,'winter-guest:'+name)
    tree.add('opt/winter/etc/supervisor-base.json','file',supervisor_base_config(helper_digests)+b'\n',False,'derived:supervisor-static-config')
    if runtime_digests is not None:tree.add(verify.RUNTIME_ARTIFACTS_PATH,'file',runtime_artifacts_config(runtime_digests)+b'\n',False,'derived:supervisor-runtime-artifacts')

def refuse_blkid(tree):
    """The probe is `dumpe2fs -h` plus a direct superblock read (decision D9); the image must not grow a blkid for anything to lean on."""
    if any(name.endswith('/blkid') or name=='blkid' for name in tree.nodes):raise ValueError('blkid is not part of the image')

def build_guest(zig,out,pins):
    """Cross-builds init and the relay twice with the pinned Zig (apple/Cowork/WinterCoworkGuest/build.py), then holds the
    result to the digests pinned in pins.json. Returns {name: bytes} plus the receipt."""
    result=subprocess.run([sys.executable,'-I','-S','-B',str(GUEST/'build.py'),'--zig',str(zig),'--out',str(out)],capture_output=True,text=True)
    if result.returncode:raise ValueError('guest build failed: '+result.stderr[-2000:])
    receipt=json.loads((out/'receipt.json').read_text());pinned=pins['guest']
    for name,entry in pinned['programs'].items():
        built=receipt['programs'][name]
        if built['binarySha256']!=entry['binarySha256']:raise ValueError('guest program '+name+' is not the pinned build')
        if built['sourceSha256']!=entry['sourceSha256']:raise ValueError('guest program '+name+' source drifted from the pin')
    for name,entry in pinned['scripts'].items():
        if receipt['scripts'][name]['sha256']!=entry['sha256']:raise ValueError('guest script '+name+' is not the pinned one')
    return {name:(out/name).read_bytes() for name in pinned['programs']},{name:(GUEST/path).read_bytes() for name,path in pinned['scriptPaths'].items()},receipt

def source_snapshot(sdk,commit,destination):
    actual=subprocess.check_output(['git','-C',str(sdk),'rev-parse',commit],text=True).strip()
    if actual!=commit: raise ValueError('SDK commit')
    result=subprocess.run(['git','-C',str(sdk),'archive','--format=tar',commit],capture_output=True,check=True)
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive: archive.extractall(destination,filter='data')
    # Preserve the already-provisioned dependency layout; record its bytes rather than install anything.
    locations=[Path('node_modules')]+[p.relative_to(sdk) for p in (sdk/'packages').glob('*/node_modules')]
    for relative in locations:
        if (sdk/relative).is_dir(): subprocess.run(['rsync','-a',str(sdk/relative)+'/',str(destination/relative)+'/'],check=True)
    return actual

def zig_archive_ok(data,pins):
    """The pinned official archive for either host: the macOS one the local pins were made with, or the Linux one the one-run image build uses."""
    return sha(data) in (pins['zig']['archiveSha256'],pins['zig']['linuxArchiveSha256'])

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);parser.add_argument('--sdk',type=Path,required=True);parser.add_argument('--builder',type=Path,required=True);parser.add_argument('--zig-archive',type=Path,required=True);parser.add_argument('--bun-base',type=Path,required=True);args=parser.parse_args()
    pins=json.loads((HERE/'pins.json').read_text());out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()): raise ValueError('fresh build output required')
    sdk=args.sdk.resolve();builder=args.builder.resolve()
    if subprocess.check_output(['git','-C',str(builder),'rev-parse','HEAD'],text=True).strip()!=pins['builderCommit']: raise ValueError('builder commit')
    subprocess.run(['git','-C',str(builder),'diff','--quiet','HEAD','--','scripts/build-runtime.ts','scripts/linux-runtime-base.json'],check=True)
    sdkcopy=out/'sdk-source';source_snapshot(sdk,pins['sdkCommit'],sdkcopy)
    zig_bytes=args.zig_archive.read_bytes()
    if not zig_archive_ok(zig_bytes,pins): raise ValueError('Zig archive')
    tools=out/'tools';tools.mkdir()
    with tarfile.open(fileobj=io.BytesIO(zig_bytes),mode='r:xz') as archive: archive.extractall(tools,filter='data')
    zig=next(tools.glob('*/zig'))
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=pins['zig']['version']: raise ValueError('Zig version')
    if sha(args.bun_base.read_bytes())!=pins['bun']['executableSha256']: raise ValueError('Bun base')
    tree=Tree();lock_bytes=(out.parent/'packages.lock.json').read_bytes()
    lock_sha=sha(lock_bytes)
    # A package lock that is not the pinned one does not stop the build: the build finishes, publishes the lock and its digest, and exits 3 UNPINNED below, so ONE run reports every stale pin.
    # Every package is still checked against its own SHA-256 from the lock, and an unpinned result is never accepted (verify.py needs --allow-unpinned, the workflow's assert step stays red).
    lock_problems=[] if lock_sha==pins['packageLockSha256'] else ['packageLockSha256 is '+lock_sha+', not the pinned '+str(pins['packageLockSha256'])]
    lock=json.loads(lock_bytes)
    hardlinks=sum(add_deb(tree,entry,out.parent/'downloads'/(entry['SHA256']+'.deb')) for entry in lock['packages'])
    # The reviewed supervisor treats its environment root as protected. Using '/' would reject
    # every workspace source. Keep package bytes once in a disjoint immutable subtree; root
    # aliases preserve the ARM64 loader and isolated Python's conventional absolute prefixes.
    package_tree=tree;tree=Tree();base='opt/winter/environment/base'
    for name,node in sorted(package_tree.nodes.items()):
        for origin in node['origins']:tree.add(base+'/'+name,node['kind'],node['data'],node['mode']==0o555 and node['kind']=='file',origin)
    for name in ['bin','lib','lib64','sbin','usr','etc']:
        if base+'/'+name in tree.nodes:tree.add(name,'symlink',(base+'/'+name).encode(),origin='derived:immutable-environment-root-alias')
    env=os.environ.copy();env['BUN_MAX_THREADS']='2'
    # The host-query executable: the SDK's own entry compiled by the canonical builder, twice, byte-identical or refuse.
    runtime=out/'winter-host-query'
    second=out/'runtime-pass2'/'winter-host-query'   # the output's file name is embedded in the bundle (/$bunfs/root/<name>), so both passes use the same name
    second.parent.mkdir()
    for attempt,target in enumerate([runtime,second]):
        result=subprocess.run(['bun',str(HERE/'build-sdk.ts'),str(sdkcopy),str(builder),str(target),str(args.bun_base.resolve()),HOST_QUERY_ENTRY],capture_output=True,text=True,check=True,env=env)
        if attempt==0:(out/'runtime-build.log').write_text(result.stdout+result.stderr)
    require_reproducible(runtime.read_bytes(),second.read_bytes(),'host-query executable')
    shutil.rmtree(second.parent)
    runtime_data=runtime.read_bytes()
    tree.add(verify.RUNTIME_ARTIFACT_PATHS['executable'].lstrip('/'),'file',runtime_data,True,'sdk:'+pins['sdkCommit']+':'+HOST_QUERY_ENTRY)
    helper_dir=sdkcopy/'packages/runtime/src/guest'; helper_receipts={}
    tool_devices=check_tool_devices((helper_dir/'linux-tool-compartment.c').read_text())
    # Native artifacts: exact SDK source, pinned Zig, two passes with separate caches and outputs, byte-identical or refuse.
    native={}
    for attempt in (1,2):
        for source in [*NATIVE_STATIC,*NATIVE_SHARED]:
            data,command=native_build(zig,out/f'zig-cache{attempt}',helper_dir,sdkcopy,source,out/f'native-pass{attempt}',env)
            if attempt==2:
                require_reproducible(native[source],data,'native artifact '+source)
                continue
            native[source]=data
            helper_receipts[source]={'sourceSha256':sha((helper_dir/source).read_bytes()),'binarySha256':sha(data),'compileFlags':[flag.replace(str(sdkcopy),'<SDK_SOURCE>') for flag in command[2:-3]],'reproducedInSecondPass':True}
    for source,data in native.items():tree.add('opt/winter/helpers/'+native_name(source),'file',data,True,'sdk:'+pins['sdkCommit'])
    shutil.rmtree(out/'native-pass1');shutil.rmtree(out/'native-pass2')
    supervisor=helper_dir/'linux-supervisor.py'
    if sha(supervisor.read_bytes())!=pins['sdkPin']['supervisorSha256']: raise ValueError('supervisor source does not match the pinned sdkPin.supervisorSha256')
    tree.add('opt/winter/libexec/linux-supervisor.py','file',supervisor.read_bytes(),False,'sdk:'+pins['sdkCommit'])
    # N2 slice S5: the pinned PID 1, the relay, the bootstrap helper and the static part of the supervisor's trusted config.
    helper_digests={source.removesuffix('.c'):record['binarySha256'] for source,record in helper_receipts.items()}
    programs,scripts,guest_receipt=build_guest(zig,out/'guest',pins)
    runtime_digests={'launcher':helper_receipts['linux-runtime-compartment.c']['binarySha256'],'executable':sha(runtime_data),'ownerLibrary':helper_receipts['linux-session-owner.c']['binarySha256']}
    add_guest_files(tree,programs,scripts,helper_digests,runtime_digests)
    certificates=[n['data'].rstrip()+b'\n' for name,n in sorted(tree.nodes.items()) if name.startswith(base+'/usr/share/ca-certificates/mozilla/') and name.endswith('.crt') and n['kind']=='file']
    if not certificates: raise ValueError('CA provenance missing')
    tree.add(base+'/etc/ssl/certs/ca-certificates.crt','file',b''.join(certificates),origin='derived:verified-mozilla-package-certificates')
    if base+'/bin/sh' not in tree.nodes:tree.add(base+'/bin/sh','symlink',b'dash',origin='derived:explicit-dash-shell')
    for path in ['opt/winter','workspace','proc','dev','sys','run','tmp']:tree.add(path,'directory')
    check_startup(tree,pins['guest']['programs']['init']['binarySha256'])
    records=verify_elfs(tree)
    refuse_blkid(tree)
    refuse_provider_bridge(tree)
    verify.check_runtime_artifacts(tree_files(tree),tree.nodes[verify.RUNTIME_ARTIFACTS_PATH]['data'])
    required=REQUIRED_PROGRAMS
    for path in required:
        target,node=tree.resolve(path)
        if '/'+target not in records or node['mode']!=0o555:raise ValueError('required program missing')
    for name,node in tree.nodes.items():
        if node['kind']=='file' and any(value in node['data'] for value in [str(args.sdk.resolve()).encode(),str(args.builder.resolve()).encode(),str(out).encode(),str(Path.home()).encode(),b'winter-build-runtime-']):raise ValueError('private/random build path in payload '+name)
    tree.materialize(out/'root');tree.cpio(out/'immutable-root.cpio')
    manifest=tree.manifest();(out/'root.manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n');(out/'elf-dependencies.json').write_text(json.dumps(records,sort_keys=True,indent=2)+'\n')
    receipt={'formatVersion':1,'sdkSourceCommit':pins['sdkCommit'],'builderCommit':pins['builderCommit'],'builderSha256':sha((builder/'scripts/build-runtime.ts').read_bytes()),'sourceHelpers':helper_receipts,'sharedCompartmentHeaderSha256':sha((helper_dir/'linux-compartment.h').read_bytes()),'supervisorSourceSha256':sha(supervisor.read_bytes()),'runtimeSha256':sha(runtime.read_bytes()),'rootManifestSha256':sha((out/'root.manifest.json').read_bytes()),'cpioSha256':sha((out/'immutable-root.cpio').read_bytes()),'cpioBytes':(out/'immutable-root.cpio').stat().st_size,'inputHardlinksMaterializedAsIndependentFiles':hardlinks,'elfCount':len(records),'toolEnvironmentRoot':'/'+base,'isolatedPythonInvocation':['/usr/bin/python3','-I','-S','-B','/opt/winter/libexec/linux-supervisor.py'],'packageLockSha256':sha((out.parent/'packages.lock.json').read_bytes()),'guestExecutionVerified':False,'initPresent':True,'initSha256':sha(programs['init']),'relaySha256':sha(programs['winter-guest-relay']),'guest':{'programs':guest_receipt['programs'],'scripts':guest_receipt['scripts'],'zig':guest_receipt['zig']},'toolDevices':tool_devices,'supervisorBaseSha256':sha(supervisor_base_config(helper_digests)+b'\n'),'hostQuery':{'entry':HOST_QUERY_ENTRY,'executablePath':verify.RUNTIME_ARTIFACT_PATHS['executable'],'artifacts':{key:{'path':verify.RUNTIME_ARTIFACT_PATHS[key],'sha256':digest} for key,digest in runtime_digests.items()},'runtimeArtifactsSha256':sha(tree.nodes[verify.RUNTIME_ARTIFACTS_PATH]['data']),'secondPassIdentical':True,'providerBridge':False,'guidedProfile':False},'vmAdmitted':False}
    problems=check_expected(receipt,pins['expectedArtifact'])+lock_problems
    receipt['packageLockSha256']=lock_sha
    (out/'packages.lock.json').write_bytes(lock_bytes)
    receipt['reproducibilityPinned']=not problems
    (out/'receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    from metrics import finish
    finish(out)
    print((out/'receipt.json').read_text(),flush=True)
    if problems:
        # A pin is stale (a re-pin changed the SDK source, or the package lock or a digest differs). Every output is written, stale or reproducibility-mismatched digests included; the build still ends
        # non-zero (3) until a reviewer copies the receipt values into pins.json, so an unpinned artifact is never mistaken for a pinned one.
        print('UNPINNED: '+'; '.join(problems),file=sys.stderr);raise SystemExit(3)
if __name__=='__main__':main()
