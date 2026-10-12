"""Deterministic readonly guest root/cpio. No mount, chown, install, init or guest execution."""
import argparse, hashlib, io, json, os, posixpath, shutil, stat, struct, subprocess, tarfile
from pathlib import Path, PurePosixPath
from packages import sha
HERE=Path(__file__).resolve().parent

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

def add_deb(tree,entry,path):
    data=path.read_bytes()
    if sha(data)!=entry['SHA256'] or len(data)!=int(entry['Size']): raise ValueError('deb digest')
    members=ar_members(data)
    if members.get('debian-binary')!=b'2.0\n': raise ValueError('deb format')
    control=next(value for name,value in members.items() if name.startswith('control.tar.'))
    with tarfile.open(fileobj=io.BytesIO(control),mode='r:*') as archive:
        text=archive.extractfile(next(m for m in archive.getmembers() if m.name.lstrip('./')=='control')).read().decode()
        from packages import paragraphs
        fields=next(paragraphs(text))
        for key in ['Package','Version','Architecture']:
            if fields[key]!=entry[key]: raise ValueError('control/index identity')
    payload=next(value for name,value in members.items() if name.startswith('data.tar.'))
    expanded=0; hardlinks=0
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:*') as archive:
        for member in archive:
            name=member.name.removeprefix('./').rstrip('/')
            if name in ['','.']: continue
            expanded+=member.size
            if member.size>128*1024*1024 or expanded>1024*1024*1024: raise ValueError('package expansion bound')
            origin='deb:'+entry['Package']+'='+entry['Version']
            if member.isdir(): tree.add(name,'directory',origin=origin)
            elif member.isfile(): tree.add(name,'file',archive.extractfile(member).read(),bool(member.mode&0o111),origin)
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

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);parser.add_argument('--sdk',type=Path,required=True);parser.add_argument('--builder',type=Path,required=True);parser.add_argument('--zig-archive',type=Path,required=True);parser.add_argument('--bun-base',type=Path,required=True);args=parser.parse_args()
    pins=json.loads((HERE/'pins.json').read_text());out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()): raise ValueError('fresh build output required')
    sdk=args.sdk.resolve();builder=args.builder.resolve()
    if subprocess.check_output(['git','-C',str(builder),'rev-parse','HEAD'],text=True).strip()!=pins['builderCommit']: raise ValueError('builder commit')
    subprocess.run(['git','-C',str(builder),'diff','--quiet','HEAD','--','scripts/build-runtime.ts','scripts/linux-runtime-base.json'],check=True)
    sdkcopy=out/'sdk-source';source_snapshot(sdk,pins['sdkCommit'],sdkcopy)
    zig_bytes=args.zig_archive.read_bytes()
    if sha(zig_bytes)!=pins['zig']['archiveSha256']: raise ValueError('Zig archive')
    tools=out/'tools';tools.mkdir()
    with tarfile.open(fileobj=io.BytesIO(zig_bytes),mode='r:xz') as archive: archive.extractall(tools,filter='data')
    zig=next(tools.glob('*/zig'))
    if subprocess.check_output([str(zig),'version'],text=True).strip()!=pins['zig']['version']: raise ValueError('Zig version')
    if sha(args.bun_base.read_bytes())!=pins['bun']['executableSha256']: raise ValueError('Bun base')
    tree=Tree();lock_bytes=(out.parent/'packages.lock.json').read_bytes()
    if sha(lock_bytes)!=pins['packageLockSha256']:raise ValueError('unpinned package lock')
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
    runtime=out/'winter';env=os.environ.copy();env['BUN_MAX_THREADS']='2'
    result=subprocess.run(['bun',str(HERE/'build-sdk.ts'),str(sdkcopy),str(builder),str(runtime),str(args.bun_base.resolve())],capture_output=True,text=True,check=True,env=env)
    (out/'runtime-build.log').write_text(result.stdout+result.stderr)
    tree.add('opt/winter/runtime/winter','file',runtime.read_bytes(),True,'sdk:'+pins['sdkCommit'])
    helper_dir=sdkcopy/'packages/runtime/src/guest'; helper_receipts={}
    for source in ['file-worker.c','process-worker.c','linux-tool-compartment.c']:
        binary=out/source.removesuffix('.c');native_env=env|{'ZIG_GLOBAL_CACHE_DIR':str(out/'zig-global-cache'),'ZIG_LOCAL_CACHE_DIR':str(out/'zig-local-cache')}
        command=[str(zig),'cc','-target','aarch64-linux-musl','-static','-std=c11','-O2','-Wall','-Wextra','-Werror','-pthread','-s','-Wl,--build-id=none','-ffile-prefix-map='+str(sdkcopy)+'=/winter-sdk',str(helper_dir/source),'-o',str(binary)]
        subprocess.run(command,capture_output=True,check=True,env=native_env)
        data=binary.read_bytes();info=elf(data)
        if not info['static']: raise ValueError('native helper must be static')
        helper_receipts[source]={'sourceSha256':sha((helper_dir/source).read_bytes()),'binarySha256':sha(data),'compileFlags':[flag.replace(str(sdkcopy),'<SDK_SOURCE>') for flag in command[2:-3]]}
        tree.add('opt/winter/helpers/'+binary.name,'file',data,True,'sdk:'+pins['sdkCommit'])
    supervisor=helper_dir/'linux-supervisor.py';tree.add('opt/winter/libexec/linux-supervisor.py','file',supervisor.read_bytes(),False,'sdk:'+pins['sdkCommit'])
    certificates=[n['data'].rstrip()+b'\n' for name,n in sorted(tree.nodes.items()) if name.startswith(base+'/usr/share/ca-certificates/mozilla/') and name.endswith('.crt') and n['kind']=='file']
    if not certificates: raise ValueError('CA provenance missing')
    tree.add(base+'/etc/ssl/certs/ca-certificates.crt','file',b''.join(certificates),origin='derived:verified-mozilla-package-certificates')
    if base+'/bin/sh' not in tree.nodes:tree.add(base+'/bin/sh','symlink',b'dash',origin='derived:explicit-dash-shell')
    for path in ['opt/winter','workspace','proc','dev','sys','run','tmp']:tree.add(path,'directory')
    if 'init' in tree.nodes or 'sbin/init' in tree.nodes:raise ValueError('startup must remain absent')
    records=verify_elfs(tree)
    required=['/opt/winter/runtime/winter','/usr/bin/python3.11','/bin/bash','/usr/bin/git','/sbin/mke2fs','/sbin/e2fsck']
    for path in required:
        target,node=tree.resolve(path)
        if '/'+target not in records or node['mode']!=0o555:raise ValueError('required program missing')
    for name,node in tree.nodes.items():
        if node['kind']=='file' and any(value in node['data'] for value in [str(args.sdk.resolve()).encode(),str(args.builder.resolve()).encode(),str(out).encode(),str(Path.home()).encode(),b'winter-build-runtime-']):raise ValueError('private/random build path in payload '+name)
    tree.materialize(out/'root');tree.cpio(out/'immutable-root.cpio')
    manifest=tree.manifest();(out/'root.manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n');(out/'elf-dependencies.json').write_text(json.dumps(records,sort_keys=True,indent=2)+'\n')
    receipt={'formatVersion':1,'sdkSourceCommit':pins['sdkCommit'],'builderCommit':pins['builderCommit'],'builderSha256':sha((builder/'scripts/build-runtime.ts').read_bytes()),'sourceHelpers':helper_receipts,'sharedCompartmentHeaderSha256':sha((helper_dir/'linux-compartment.h').read_bytes()),'supervisorSourceSha256':sha(supervisor.read_bytes()),'runtimeSha256':sha(runtime.read_bytes()),'rootManifestSha256':sha((out/'root.manifest.json').read_bytes()),'cpioSha256':sha((out/'immutable-root.cpio').read_bytes()),'cpioBytes':(out/'immutable-root.cpio').stat().st_size,'inputHardlinksMaterializedAsIndependentFiles':hardlinks,'elfCount':len(records),'toolEnvironmentRoot':'/'+base,'isolatedPythonInvocation':['/usr/bin/python3','-I','-S','/opt/winter/libexec/linux-supervisor.py'],'packageLockSha256':sha((out.parent/'packages.lock.json').read_bytes()),'guestExecutionVerified':False,'initPresent':False,'vmAdmitted':False}
    expected=pins['expectedArtifact']
    for key in ['runtimeSha256','cpioSha256','rootManifestSha256']:
        if receipt[key]!=expected[key]:raise ValueError('artifact reproducibility mismatch: '+key)
    for source,digest in expected['helperBinarySha256'].items():
        if receipt['sourceHelpers'][source]['binarySha256']!=digest:raise ValueError('native helper reproducibility mismatch')
    (out/'receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    from metrics import finish
    finish(out)
    print((out/'receipt.json').read_text(),flush=True)
if __name__=='__main__':main()
