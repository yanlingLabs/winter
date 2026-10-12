"""Pinned Debian downloads only. Never installs packages or executes maintainer scripts."""
import argparse, codecs, hashlib, json, lzma, os, re, stat, subprocess, tempfile, urllib.request
from pathlib import Path, PurePosixPath
HERE=Path(__file__).resolve().parent

def sha(data): return hashlib.sha256(data).hexdigest()
def bounded_read(stream, maximum):
    result=bytearray()
    while True:
        block=stream.read(min(64*1024, maximum-len(result)+1))
        if not block: return bytes(result)
        if len(result)+len(block)>maximum: raise ValueError('read bound')
        result.extend(block)

def bounded_file(path, maximum, expected_size=None):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>maximum or (expected_size is not None and info.st_size!=expected_size):raise ValueError('cached file size/type bound')
        with os.fdopen(fd,'rb') as stream:
            fd=None;return bounded_read(stream, min(maximum,expected_size) if expected_size is not None else maximum)
    finally:
        if fd is not None:os.close(fd)

def download(url, path, digest, size=None, maximum=64*1024*1024):
    if size is not None and (size<0 or size>maximum):raise ValueError('declared download bound')
    if path.exists(): data=bounded_file(path,maximum,size)
    else:
        if not url.startswith('https://'): raise ValueError('HTTPS required')
        with urllib.request.urlopen(url, timeout=40) as response:data=bounded_read(response,min(maximum,size) if size is not None else maximum)
        if sha(data)!=digest or (size is not None and len(data)!=size): raise ValueError('download integrity')
        path.write_bytes(data)
    if sha(data)!=digest or (size is not None and len(data)!=size): raise ValueError('cache integrity')
    return data

def xz_chunks(data, maximum, memory_limit=64*1024*1024):
    decoder=lzma.LZMADecompressor(memlimit=memory_limit);at=0;expanded=0
    while not decoder.eof:
        incoming=data[at:at+64*1024] if decoder.needs_input else b''
        if decoder.needs_input:
            if not incoming:raise ValueError('truncated XZ')
            at+=len(incoming)
        block=decoder.decompress(incoming,max_length=min(64*1024,maximum-expanded+1))
        if expanded+len(block)>maximum:raise ValueError('XZ expansion bound')
        expanded+=len(block)
        if block:yield block
    if decoder.unused_data or at!=len(data):raise ValueError('XZ trailing data')

def index_paragraphs(compressed, maximum=128*1024*1024, line_limit=128*1024, paragraph_limit=256*1024):
    decoder=codecs.getincrementaldecoder('utf-8')();pending='';lines=[];length=0
    def field_line(line):
        nonlocal lines,length
        if len(line)>line_limit:raise ValueError('index line bound')
        if not line:
            value='\n'.join(lines);lines=[];length=0
            return next(paragraphs(value),None) if value else None
        length+=len(line)+1
        if length>paragraph_limit:raise ValueError('index paragraph bound')
        lines.append(line)
    for block in xz_chunks(compressed,maximum):
        pending+=decoder.decode(block)
        while '\n' in pending:
            line,pending=pending.split('\n',1);entry=field_line(line)
            if entry:yield entry
        if len(pending)>line_limit:raise ValueError('index line bound')
    pending+=decoder.decode(b'',final=True)
    if pending:field_line(pending)
    entry=field_line('')
    if entry:yield entry

def paragraphs(text):
    for chunk in text.strip().split('\n\n'):
        fields={}; key=None
        for line in chunk.splitlines():
            if line.startswith(' ') and key: fields[key]+=' '+line.strip()
            elif ': ' in line: key,value=line.split(': ',1); fields[key]=value
        if fields: yield fields

def verify_release(data, pins, cache):
    with tempfile.TemporaryDirectory(prefix='winter-image-gpg-') as folder:
        home=Path(folder); os.chmod(home,0o700)
        for key in pins['keys']:
            path=HERE/key['file']
            if sha(bounded_file(path,64*1024))!=key['sha256']: raise ValueError('key digest')
            result=subprocess.run(['gpg','--no-options','--batch','--no-autostart','--homedir',str(home),'--with-colons','--show-keys',str(path)],capture_output=True,text=True,check=True)
            primary=result.stdout.split('fpr:::::::::',1)[1].split(':',1)[0]
            if primary!=key['fingerprint']: raise ValueError('key fingerprint')
            subprocess.run(['gpg','--no-options','--batch','--no-autostart','--homedir',str(home),'--import',str(path)],capture_output=True,check=True)
        signed=home/'InRelease'; signed.write_bytes(data)
        result=subprocess.run(['gpgv','--homedir',str(home),'--keyring',str(home/'pubring.kbx'),'--status-fd','1',str(signed)],capture_output=True,text=True)
        (cache/'signature-status.log').write_text(result.stdout+'\n'+result.stderr)
        allowed={k['fingerprint'] for k in pins['keys']}
        valid=[line for line in result.stdout.splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
        # Extra signatures without imported keys do not invalidate a verified allowed signer.
        if not any(line.split()[-1] in allowed or line.split()[2] in allowed for line in valid) or '[GNUPG:] BADSIG ' in result.stdout: raise ValueError('release signature')
        clear=data.decode().split('\n\n',1)[1].split('-----BEGIN PGP SIGNATURE-----',1)[0]
        clear='\n'.join(line[2:] if line.startswith('- ') else line for line in clear.splitlines())+'\n'
        return clear, valid

def order(char):
    if char=='~': return -1
    if not char: return 0
    if char.isalpha(): return ord(char)
    return ord(char)+256

def part_compare(a,b):
    while a or b:
        while (a and not a[0].isdigit()) or (b and not b[0].isdigit()):
            aa=a[0] if a and not a[0].isdigit() else ''; bb=b[0] if b and not b[0].isdigit() else ''
            if order(aa)!=order(bb): return (order(aa)>order(bb))-(order(aa)<order(bb))
            if aa:a=a[1:]
            if bb:b=b[1:]
        ma=re.match(r'\d*',a)[0]; mb=re.match(r'\d*',b)[0]; a=a[len(ma):]; b=b[len(mb):]
        aa=ma.lstrip('0'); bb=mb.lstrip('0')
        if len(aa)!=len(bb): return (len(aa)>len(bb))-(len(aa)<len(bb))
        if aa!=bb: return (aa>bb)-(aa<bb)
    return 0

def version_compare(a,b):
    def split(v):
        epoch,rest=v.split(':',1) if ':' in v else ('0',v)
        upstream,revision=rest.rsplit('-',1) if '-' in rest else (rest,'0')
        return int(epoch),upstream,revision
    aa,bb=split(a),split(b)
    return ((aa[0]>bb[0])-(aa[0]<bb[0])) or part_compare(aa[1],bb[1]) or part_compare(aa[2],bb[2])

def satisfies(actual,op,wanted):
    c=version_compare(actual,wanted)
    return {'=':c==0,'>=':c>=0,'<=':c<=0,'>>':c>0,'<<':c<0}[op]

def closure(index, roots):
    chosen={}; pending=list(roots)
    while pending:
        expression=pending.pop(0)
        found=None
        for alternative in expression.split('|'):
            match=re.fullmatch(r'\s*([a-z0-9+.-]+)(?::(?:any|arm64|native))?(?:\s*\((>=|<=|=|>>|<<)\s*([^ )]+)\))?\s*',alternative)
            if not match: raise ValueError('unsupported dependency '+expression)
            name,op,version=match.groups()
            candidate=index.get(name)
            if candidate and (not op or satisfies(candidate['Version'],op,version)): found=candidate; break
        if not found: raise ValueError('unresolved dependency '+expression)
        if found['Package'] in chosen: continue
        chosen[found['Package']]=found
        for key in ['Pre-Depends','Depends']:
            pending += [s.strip() for s in found.get(key,'').split(',') if s.strip()]
    return [chosen[name] for name in sorted(chosen)]

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--out',type=Path,required=True); args=parser.parse_args()
    pins=json.loads((HERE/'pins.json').read_text()); out=args.out; cache=out/'downloads'; cache.mkdir(parents=True,exist_ok=True)
    index={}; releases=[]
    for archive in pins['archives']:
        data=download(archive['url']+'/dists/'+archive['suite']+'/InRelease',cache/(archive['id']+'-InRelease'),archive['inReleaseSha256'],maximum=1024*1024)
        text,signers=verify_release(data,pins,cache)
        target='main/binary-arm64/Packages.xz'
        records=text.split('\nSHA256:\n',1)[1].split('\n\n',1)[0]
        row=next(line.split() for line in records.splitlines() if line.strip().endswith(' '+target))
        digest,size=row[0],int(row[1])
        compressed=download(archive['url']+'/dists/'+archive['suite']+'/'+target,cache/(archive['id']+'-Packages.xz'),digest,size)
        releases.append({'archive':archive['id'],'url':archive['url'],'inReleaseSha256':sha(data),'indexSha256':sha(compressed),'signers':signers})
        for entry in index_paragraphs(compressed):
            if entry.get('Architecture') not in ['arm64','all']: continue
            entry['archive']=archive['id']; entry['baseUrl']=archive['url']
            prior=index.get(entry['Package'])
            if not prior or version_compare(entry['Version'],prior['Version'])>0: index[entry['Package']]=entry
    providers={}
    for entry in sorted(index.values(),key=lambda e:e['Package']):
        for provided in entry.get('Provides','').split(','):
            name=provided.strip().split(' ',1)[0]
            if name: providers.setdefault(name,entry)
    for name,entry in providers.items(): index.setdefault(name,entry)
    selected=closure(index,pins['packages']); total=sum(int(e['Size']) for e in selected)
    if total>256*1024*1024 or len(selected)>128: raise ValueError('package closure bound')
    print(json.dumps({'packages':len(selected),'downloadBytes':total}),flush=True)
    lock=[]
    for entry in selected:
        path=PurePosixPath(entry['Filename'])
        if path.is_absolute() or '..' in path.parts or not str(path).startswith('pool/'): raise ValueError('archive filename')
        filename=entry['SHA256']+'.deb'
        download(entry['baseUrl']+'/'+str(path),cache/filename,entry['SHA256'],int(entry['Size']))
        lock.append({k:entry[k] for k in ['Package','Version','Architecture','Filename','SHA256','Size','archive','baseUrl'] } | {k:entry[k] for k in ['Source','Depends','Pre-Depends'] if k in entry})
        print(entry['Package']+' '+entry['Version'],flush=True)
    (out/'packages.lock.json').write_text(json.dumps({'formatVersion':1,'releases':releases,'packages':lock},sort_keys=True,indent=2)+'\n')
if __name__=='__main__': main()
