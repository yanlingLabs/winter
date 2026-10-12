from pathlib import Path
import collections,gzip,hashlib,json,struct,sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from block_receipts import summary as original_block_summary
D=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
BUILD='477d204b4f0e2f8cebfb20e55ef69d85b78e6f34d62bff3a29c2030a6c5eebbd'
assert D(ROOT/'out/generic-fixture-sampler/build.json')==BUILD
build=json.loads((ROOT/'out/generic-fixture-sampler/build.json').read_text())
ACK=[(3,4294967295,0,1),(2,0,1,0),(3,0,3,1),(2,0,6,1),(3,0,6,1)]

def stream_verify(path,salt):
    size=0
    with path.open('rb') as f:
        while chunk:=f.read(65536):
            expected=bytes((((i&255)+37*(i>>8)+13*(i>>16))&255)^salt for i in range(size,size+len(chunk)))
            assert chunk==expected,(path.name,size)
            size+=len(chunk)
    return {'bytes':size,'sha256':D(path),'everyBytePassed':True}

def base(name,terminal):
    path=ROOT/'out'/name;j=json.loads((path/'result.json').read_text());rows=[json.loads(l) for l in (path/'events.jsonl').read_text().splitlines()]
    files=['result.json','stdout.log','stderr.log','sampler.log','events.jsonl','stream-host-to-guest.bin','stream-guest-to-host.bin','cowork-hvf-generic-worker','initramfs.cpio','kernel']
    hashes={f:D(path/f) for f in files}
    assert j['buildSha256']==BUILD
    for f in ['cowork-hvf-generic-worker','initramfs.cpio','kernel']:assert hashes[f]==build['artifacts'][f],f
    assert j['exitCode']==(77 if terminal else 0)
    assert all(j[k] for k in ['exitVerified','ownedChildReaped','captureComplete','readerThreadsJoined','ownersQuiescent'])
    assert not any(j[k] for k in ['timedOut','captureOverflow','killIssued','terminationUncertain'])
    malformed=[];parsed={}
    for channel in ['stdout','stderr','sampler']:
        parsed[channel]=[]
        for no,line in enumerate((path/(channel+'.log')).read_text().splitlines(),1):
            payload=line[line.index('{'):] if line.startswith('[') and '{' in line else line
            try:r=json.loads(payload)
            except ValueError:
                if '{' in line or 'block_used_ack' in line:malformed.append({'channel':channel,'line':no,'text':line})
                continue
            if isinstance(r,dict):parsed[channel].append(r)
        strip=lambda r:{k:v for k,v in r.items() if k not in ['channel','hostElapsedSeconds']}
        assert collections.Counter(json.dumps(r,sort_keys=True) for r in parsed[channel])==collections.Counter(json.dumps(strip(r),sort_keys=True) for r in rows if r.get('channel')==channel)
    acks=[r for r in rows if r['kind']=='runtime_control_used_ack'];expected=ACK+([(3,0,6,0)] if terminal else [])
    assert [(r['queue'],r['id'],r['event'],r['value']) for r in acks]==expected
    assert all(r['channel']=='stderr' and r['usedAck'] and r['row']==i for i,r in enumerate(acks))
    begin=next(r for r in rows if r['kind']=='host_sink_stall_begin');end=next(r for r in rows if r['kind']==('host_sink_owner_exited' if terminal else 'host_sink_stall_end'))
    within=[r for r in rows if begin['hostElapsedSeconds']<=r['hostElapsedSeconds']<=end['hostElapsedSeconds']]
    assert begin['workerAlive'] and (end['stallActive'] if terminal else end['workerAlive'])
    back=[r for r in within if r['kind']=='guest_generic_tx_backpressure'];assert back and back[0]['eagain']>0 and back[0]['bytes']>=1048576
    heart=[r for r in within if r['kind']=='guest_heartbeat'];disk={r['thread'] for r in within if r['kind']=='guest_block_progress'};alive=[r for r in within if r['kind']=='host_sink_worker_alive' and r['workerAlive']]
    assert len(heart)>=2 and disk=={0,1} and len(alive)>=2
    assert not any(r['kind'] in ['guest_failure','reclaim_failure','block_trace_overflow'] for r in rows)
    raw={direction:stream_verify(path/file,salt) for direction,file,salt in [('hostToGuest','stream-host-to-guest.bin',0x5c),('guestToHost','stream-guest-to-host.bin',0xa7)]}
    assert raw['hostToGuest']['bytes']==j['streamOracle']['sentBytes'] and raw['guestToHost']['bytes']==j['streamOracle']['receivedBytes']
    for file,sha in j['rawCaptureHashes'].items():assert hashes[file]==sha
    out={'fixture':name,'originalResultSha256':hashes['result.json'],'originalAggregatePassed':j.get('fixtureChecksPassed',j.get('terminalRecoveryChecksPassed')),'exitCode':j['exitCode'],'originalArtifactHashes':hashes,'rawParsingMatchesEvents':True,'malformedTelemetry':malformed,'controlAcks':acks,'stallSecondsObserved':end['hostElapsedSeconds']-begin['hostElapsedSeconds'],'stallHeartbeats':len(heart),'stallDiskThreads':sorted(disk),'stallAliveReceipts':len(alive),'guestBackpressure':back,'rawStreams':raw,'originalsUnchanged':None}
    return path,j,rows,parsed,out,hashes

p,j,rows,parsed,normal,before=base('generic-fixture-sampler-rnklq4m2',False)
assert j['fixtureChecksPassed'] is True and j['audit']['blockReceiptsPassed'] is True and not j['audit']['errors']
assert j['samplerClosed'] is True and j['malformedJsonLines']=={'stdout':0,'stderr':0,'sampler':0} and not normal['malformedTelemetry']
assert len(parsed['sampler'])==42 and all(r['kind']=='host_memory' for r in parsed['sampler'])
assert not any(r['kind']=='host_memory' for c in ['stdout','stderr'] for r in parsed[c])
worker=next(r for r in rows if r['kind']=='worker');assert all(r['pid']==worker['pid'] for r in parsed['sampler'])
trace=[r for r in parsed['stderr'] if r['kind'].startswith('block_') and 'row' in r]
indices=collections.Counter(r['row'] for r in trace);assert sorted(indices)==list(range(max(indices)+1)) and set(indices.values())=={1}
requests=collections.defaultdict(list)
for r in trace:
    if r['kind'] in ['block_request_capture','block_owned_io_begin','block_owned_io_end','block_used_ack']:requests[r['request']].append(r)
for identity,sequence in requests.items():
    assert [r['kind'] for r in sequence]==['block_request_capture','block_owned_io_begin','block_owned_io_end','block_used_ack'],identity
    capture,begin,end,ack=sequence
    assert ack['head']==capture['head'] and ack['success'] is True and end['success'] is True and capture['leaseReleased'] is True
    assert [r['clockMicros'] for r in sequence]==sorted(r['clockMicros'] for r in sequence)
normal['blockAudit']={'completeRequests':len(requests),'contiguousNativeTraceRows':len(trace),'lastNativeTraceRow':max(indices),'everyRequestCaptureIoAckOrdered':True,'reconstructedRows':0}
normal['samplerAudit']={'records':len(parsed['sampler']),'separateChannel':True,'allSamplesMatchWorkerPid':True,'malformedRows':0}
# Independently check final disk words against completed iteration counters; untouched tail must be zero.
disk=p/'fixture.raw';normal['diskSha256']=D(disk);assert normal['diskSha256']==j['diskSha256'];assert disk.stat().st_size==64*1024*1024
normal['diskThreads']=[]
with disk.open('rb') as f:
    for t in [0,1]:
        count=next(r['iterations'] for r in rows if r['kind']=='guest_block_thread_complete' and r['thread']==t)
        assert count>0
        for slot in range(16):
            f.seek(t*4194304+slot*262144);data=f.read(262144);assert len(data)==262144
            last=count-1-((count-1-slot)%16)
            for word,(value,) in enumerate(struct.iter_unpack('<Q',data)):assert value==(0x6a39000000000000^(t<<48)^(last<<24)^word),(t,slot,word)
        normal['diskThreads'].append({'thread':t,'iterations':count,'wordsChecked':524288,'everyWordPassed':True})
    f.seek(8388608);assert not any(f.read())
normal['untouchedDiskTailZero']=True
# Independent mapping state machine and exclusion checks.
epochs=collections.defaultdict(list)
for r in rows:
    if r['kind'].startswith('reclaim_') and 'epoch' in r:epochs[r['epoch']].append(r)
assert sorted(epochs)==list(range(1,len(epochs)+1));mapped=0
for epoch,ev in epochs.items():
    exclusions=[(r['gpa'],r['gpa']+r['len']) for r in ev if r['kind']=='reclaim_exclusion']
    parked=False;resumed=False;ack=False;pending=None;local=0
    for r in ev:
        k=r['kind']
        if k=='reclaim_parked':assert not parked and r['roster']==[0,1];parked=True
        elif k=='reclaim_unmap':
            assert parked and not resumed and not ack and pending is None and r['return']==0 and r['len']>0
            assert all(r[n]%16384==0 for n in ['gpa','hva','len'])
            assert not any(r['gpa']<end and start<r['gpa']+r['len'] for start,end in exclusions)
            pending=(r['gpa'],'unmapped')
        elif k=='reclaim_replace':assert pending==(r['gpa'],'unmapped') and r['sameHVA'] and r['errnoIfFailed']==0;pending=(r['gpa'],'replaced')
        elif k=='reclaim_map':assert pending==(r['gpa'],'replaced') and r['sameHVA'] and r['return']==0 and r['flags']=='RWX';pending=None;local+=1
        elif k=='reclaim_used_ack':assert pending is None and not ack and not resumed and r['indices'];ack=True
        elif k=='reclaim_resumed':assert parked and ack and not resumed and pending is None and r['roster']==[0,1] and r['spanCount']==local;resumed=True
    assert resumed;mapped+=local
assert mapped>0
pins=[r for r in rows if r['kind']=='block_freeze_pin']
for r in pins:
    exclusions=[x for x in epochs[r['epoch']] if x['kind']=='reclaim_exclusion']
    assert r['ranges'] and all(any(x['gpa']<=s['gpa'] and s['gpa']+s['len']<=x['gpa']+x['len'] for x in exclusions) for s in r['ranges'])
normal['mappingAudit']={'epochs':len(epochs),'replacedSpans':mapped,'mappingOrderAndExclusionsPassed':True,'frozenPinObservations':len(pins),'genericFrozenPinObservations':sum(r['device']==1 for r in pins)}
normal['activeWindows']=[]
for cycle in [1,2,3]:
    touch=next(r for r in rows if r['kind']=='guest_touched' and r['cycle']==cycle)['hostElapsedSeconds'];free=next(r for r in rows if r['kind']=='guest_freed' and r['cycle']==cycle)['hostElapsedSeconds'];end=next(r for r in rows if r['kind']=='guest_integrity' and r['cycle']==cycle)['hostElapsedSeconds']
    before_samples=[r['footprintBytes'] for r in rows if r['kind']=='host_memory' and r.get('channel')=='sampler' and touch<r['hostElapsedSeconds']<free]
    late=[r['footprintBytes'] for r in rows if r['kind']=='host_memory' and r.get('channel')=='sampler' and free+8<r['hostElapsedSeconds']<end]
    peak_drop=max(before_samples)-min(late);conservative=min(before_samples)-max(late)
    heart=[r for r in rows if r['kind']=='guest_heartbeat' and free<r['hostElapsedSeconds']<end]
    directions={r['direction'] for r in rows if r['kind']=='guest_stream_progress' and free+.25<r['hostElapsedSeconds']<end-.25}
    threads={r['thread'] for r in rows if r['kind']=='guest_block_progress' and free<r['hostElapsedSeconds']<end}
    retained=next(r for r in rows if r['kind']=='guest_integrity' and r['cycle']==cycle);reuse=next(r for r in rows if r['kind']=='guest_reuse' and r['cycle']==cycle)
    assert conservative>240*1048576 and len(heart)==10 and directions=={'guest-to-host','host-to-guest'} and threads=={0,1}
    assert retained['retained'] and retained['progress'] and reuse['anonymousZeroFill'] and reuse['writtenIntegrity']
    normal['activeWindows'].append({'cycle':cycle,'touchedSamples':before_samples,'lateFreeSamples':late,'peakDropBytes':peak_drop,'peakDropMiB':peak_drop/1048576,'conservativeDropBytes':conservative,'heartbeats':len(heart),'streamDirections':sorted(directions),'diskThreads':sorted(threads),'retainedAndReuseChecksPassed':True})
assert j['streamOracle']['peerEOF'];completed={r['direction']:r['bytes'] for r in rows if r['kind']=='guest_stream_complete'}
assert completed['guest-to-host']==normal['rawStreams']['guestToHost']['bytes'] and completed['host-to-guest']<=normal['rawStreams']['hostToGuest']['bytes']
normal['guestConsumedStreamBytes']=completed;normal['narrowActiveReturnEvidencePassed']=True;normal['originalsUnchanged']=all(D(p/f)==sha for f,sha in before.items()) and D(disk)==normal['diskSha256'];assert normal['originalsUnchanged']
manifest_path=ROOT/'results/2026-10-12-sampler-live-capture-manifest.json'
manifest=json.loads(manifest_path.read_text())
for name,pin in manifest.items():
    capture=ROOT/'results'/name;assert D(capture)==pin['sha256'],name
    content=gzip.decompress(capture.read_bytes()) if name.endswith('.gz') else capture.read_bytes()
    assert len(content)==pin['originalBytes'] and hashlib.sha256(content).hexdigest()==pin['originalSha256'],name
historical={name:D(ROOT/name) for name in ['out/generic-fixture/build.json','out/generic-fixture-7zmd1ypu/result.json','out/generic-fixture-7zmd1ypu/stderr.log']}
assert historical=={'out/generic-fixture/build.json':'821c5f7341f760bb0e5f1e584115bf5e247438d13f5c7883d0e143e4c164e9d3','out/generic-fixture-7zmd1ypu/result.json':'8bafc3a7c9bc3db1b6c5187864410e4c368dd7f70d8f21771e8832a8fff13664','out/generic-fixture-7zmd1ypu/stderr.log':'3c4be015d07bc26ce3d913b86d6c2b5201b6c40bc03b8c57b3cefc2d2f0c0801'}
result={'buildSha256':BUILD,'reviewerVmLaunches':0,'reviewerWorkerLaunches':0,'normal':normal,'durableCaptureManifest':{'path':str(manifest_path.relative_to(ROOT)),'sha256':D(manifest_path),'filesVerified':len(manifest),'compressedAndUncompressedHashesPassed':True},'historicalFailedRunHashesUnchanged':historical,'auditScriptSha256':D(Path(__file__)),'scopedActiveReturnAndCleanTelemetryPassed':True,'fullResourceGatePassed':False,'productionReady':False,'authenticatedProtocolImplemented':False,'liveResetOrHostDisconnectVerified':False}
(ROOT/'results/2026-10-12-sampler-independent-postrun-audit.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'originalAggregatePassed':normal['originalAggregatePassed'],'block':normal['blockAudit'],'mapping':normal['mappingAudit'],'sampler':normal['samplerAudit'],'activeWindows':normal['activeWindows'],'originalsUnchanged':normal['originalsUnchanged']},indent=2))
