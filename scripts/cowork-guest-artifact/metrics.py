import collections, gzip, hashlib, json, zlib
from pathlib import Path

def finish(root):
    manifest=json.loads((root/'root.manifest.json').read_text());files=[e for e in manifest if e['type']=='file']
    groups=collections.defaultdict(list)
    for e in files:groups[e['sha256']].append(e)
    duplicates=[]
    for digest,entries in groups.items():
        if len(entries)>1 and entries[0]['size']:
            duplicates.append({'sha256':digest,'size':entries[0]['size'],'copies':len(entries),'duplicateBytes':entries[0]['size']*(len(entries)-1),'paths':[e['path'] for e in entries][:8]})
    duplicates.sort(key=lambda e:e['duplicateBytes'],reverse=True)
    categories=collections.Counter()
    for e in files:
        path=e['path'];size=e['size']
        if path.startswith('/opt/winter/runtime/'): category='winter-runtime'
        elif path.startswith('/opt/winter/helpers/'):category='native-helpers'
        elif path.startswith('/opt/winter/libexec/'):category='supervisor-source'
        elif '/usr/share/doc/' in path or '/usr/share/man/' in path or '/usr/share/info/' in path:category='docs/man/info-including-licenses'
        elif '/locale/' in path or '/locales/' in path:category='locales'
        elif '/python3.11/' in path:category='python-stdlib'
        elif '/perl/' in path or '/perl5/' in path:category='perl-libraries'
        else:category='other-distro-payload'
        categories[category]+=size
    metrics={'filePayloadBytes':sum(e['size'] for e in files),'cpioBytes':(root/'immutable-root.cpio').stat().st_size,'categories':dict(sorted(categories.items())),'topFiles':[{'path':e['path'],'bytes':e['size']} for e in sorted(files,key=lambda e:e['size'],reverse=True)[:12]],'duplicateBytes':sum(e['duplicateBytes'] for e in duplicates),'topDuplicates':duplicates[:12],'docsLocalesPolicy':'retain all verified package payload; no ad-hoc deletion','hardlinkPolicy':'input hardlinks become independent bytes; newc nlink=1 for all records'}
    (root/'size-breakdown.json').write_text(json.dumps(metrics,sort_keys=True,indent=2)+'\n')
    with (root/'immutable-root.cpio').open('rb') as source,(root/'immutable-root.cpio.gz').open('wb') as destination:
        with gzip.GzipFile(fileobj=destination,filename='',mode='wb',mtime=0,compresslevel=9) as compressed:
            while block:=source.read(1024*1024):compressed.write(block)
    digest=hashlib.sha256();decoded=0
    with gzip.open(root/'immutable-root.cpio.gz','rb') as stream:
        while block:=stream.read(1024*1024):digest.update(block);decoded+=len(block)
    receipt=json.loads((root/'receipt.json').read_text())
    if digest.hexdigest()!=receipt['cpioSha256'] or decoded!=receipt['cpioBytes']:raise ValueError('gzip roundtrip')
    receipt['gzipCompanion']={'sha256':hashlib.sha256((root/'immutable-root.cpio.gz').read_bytes()).hexdigest(),'bytes':(root/'immutable-root.cpio.gz').stat().st_size,'mtime':0,'filename':'','level':9,'zlibVersion':zlib.ZLIB_RUNTIME_VERSION,'decompressedSha256':digest.hexdigest(),'kernelExecutionVerified':False}
    (root/'receipt.json').write_text(json.dumps(receipt,sort_keys=True,indent=2)+'\n')
    return metrics
