from pathlib import Path
from collections import Counter,defaultdict
import hashlib,json,struct
# Reproduce the fixed 2026-10-12 RAW-plus-stream root audit; this is not a general VM validator.
# Read-only: no launch, remap, disk mutation or receipt overwrite.
import sys
if not __debug__:
    raise SystemExit("Assertions must be enabled for this evidence audit")
if len(sys.argv) != 2:
    raise SystemExit("usage: 2026-10-12-stream-root-audit.py RETAINED_FIXTURE_DIRECTORY")
p=Path(sys.argv[1])
rows=[json.loads(line) for line in (p/'events.jsonl').read_text().splitlines()]
for index,row in enumerate(rows):row['_index']=index
stage=json.loads((p/'result.json').read_text())
assert stage['exitCode']==0 and stage['exitVerified'] and stage['ownedChildReaped']
assert not stage['terminationUncertain'] and not stage['captureOverflow'] and stage['captureComplete'] and stage['readerThreadsJoined']
assert stage['buildSha256']=='b4e5b6908ecfa6eb220f478c4d0c27e59e28900c4d697ef9527d30b52e93d139'
bykind=defaultdict(list)
for row in rows:bykind[row['kind']].append(row)
assert len(bykind['linux_boot'])==1 and len(bykind['worker'])==1 and len(bykind['guest_complete'])==1
assert all(r['channel']=='stderr' for r in rows if r['kind'].startswith(('block_', 'reclaim_')))
assert all(r['channel']=='stdout' for r in rows if r['kind'].startswith(('guest_', 'linux_boot', 'virtio_device')))
worker=bykind['worker'][0]
assert worker['pid']==12667 and worker['vcpus']==2 and worker['ramMiB']==768 and worker['networkDevices']==0 and worker['hostShares']==0 and worker['vsock'] is False
assert bykind['guest_complete'][0]['cycles']==3
assert sorted(row['device'] for row in bykind['virtio_device'])==['0x0002','0x0003','0x0004','0x0005']
assert not any(bykind[k] for k in ['guest_failure','reclaim_failure','block_trace_overflow'])
assert all(row['pid']==worker['pid'] for row in bykind['host_memory'])
ram_start,ram_end=0x80000000,0x80000000+768*1024*1024
mapping_count=0
for epoch in range(1,19):
    erows=[r for r in rows if r.get('epoch')==epoch]
    one=lambda kind:next(r for r in erows if r['kind']==kind)
    for kind in ['reclaim_parked','reclaim_resumed','reclaim_used_ack','reclaim_disposition']:
        assert sum(r['kind']==kind for r in erows)==1
    parked,resumed,ack=one('reclaim_parked'),one('reclaim_resumed'),one('reclaim_used_ack')
    assert parked['roster']==[0,1] and resumed['roster']==[0,1]
    assert parked['_index']<ack['_index']<resumed['_index']
    exclusions=[(r['gpa'],r['gpa']+r['len']) for r in erows if r['kind']=='reclaim_exclusion']
    ops=[r for r in erows if r['kind'] in ['reclaim_unmap','reclaim_replace','reclaim_map']]
    assert len(ops)%3==0 and len(ops)//3==resumed['spanCount']
    ranges=[]
    for i in range(0,len(ops),3):
        unmap,replace,maprow=ops[i:i+3]
        assert [r['kind'] for r in [unmap,replace,maprow]]==['reclaim_unmap','reclaim_replace','reclaim_map']
        assert parked['_index']<unmap['_index']<replace['_index']<maprow['_index']<ack['_index']
        start,end=unmap['gpa'],unmap['gpa']+unmap['len']
        assert ram_start<=start<end<=ram_end and start%16384==0 and unmap['hva']%16384==0 and unmap['len']%16384==0
        assert unmap['return']==0 and replace['sameHVA'] and replace['errnoIfFailed']==0 and maprow['sameHVA'] and maprow['flags']=='RWX' and maprow['return']==0
        assert start==replace['gpa']==maprow['gpa']
        assert not any(start<b and a<end for a,b in exclusions)
        assert not any(start<b and a<end for a,b in ranges)
        ranges.append((start,end));mapping_count+=1
    assert sum(b-a for a,b in ranges)==one('reclaim_disposition')['bytes']
assert mapping_count==299
requests={r['request']:r for r in bykind['block_request_capture']}
assert len(requests)==len(bykind['block_request_capture'])==1589
ack_by={}
for req,capture in requests.items():
    stages=[r for r in rows if r.get('request')==req and r['kind'] in ['block_owned_io_begin','block_owned_io_end','block_used_ack']]
    assert [r['kind'] for r in stages]==['block_owned_io_begin','block_owned_io_end','block_used_ack']
    begin,end,ack=stages
    assert capture['_index']<begin['_index']<end['_index']<ack['_index'] and capture['leaseReleased']
    assert capture['length']<=1024*1024 and end['success'] and ack['success'] and ack['head']==capture['head']
    assert capture['clockMicros']<=begin['clockMicros']<=end['clockMicros']<=ack['clockMicros']
    ack_by[req]=ack
pins={r['pin']:r for r in requests.values()}
rings={r['pin']:r for r in bykind['block_ring_pin']}
holds={r['request']:r for r in bykind['block_owned_completion_hold']}
assert len(holds)==1589 and all(r['millis']==25 and r['osSyscallBlocked'] is False for r in holds.values())
overlaps=[]
for frozen in bykind['block_freeze_pin']:
    exclusion=[r for r in bykind['reclaim_exclusion'] if r['epoch']==frozen['epoch']]
    for span in frozen['ranges']:
        assert any(r['gpa']<=span['gpa'] and span['gpa']+span['len']<=r['gpa']+r['len'] for r in exclusion)
    if frozen['device']==1: continue # stream spans were checked against exclusions above; native stream request stages have no RAW trace
    assert frozen['device']==0
    if frozen['pin'] in rings:
        assert frozen['ranges']==rings[frozen['pin']]['ranges'];continue
    capture=pins[frozen['pin']];ack=ack_by[capture['request']]
    assert capture['ranges']==frozen['ranges'] and capture['generation']==frozen['generation']
    assert capture['clockMicros']<=frozen['clockMicros']<ack['clockMicros']
    assert holds[capture['request']]['clockMicros']<=frozen['clockMicros']
    overlaps.append({'epoch':frozen['epoch'],'request':capture['request'],'pin':frozen['pin']})
assert len(overlaps)==17 and len({r['epoch'] for r in overlaps})==17 and {r['epoch'] for r in overlaps}.issubset(set(range(1,19)))
cycles=[]
for cycle in [1,2,3]:
    pick=lambda kind:next(r for r in bykind[kind] if r['cycle']==cycle)
    touched,free,integrity,reuse=[pick(kind) for kind in ['guest_touched','guest_freed','guest_integrity','guest_reuse']]
    assert touched['bytes']==free['bytes']==reuse['bytes']==256*1024*1024 and touched['liveBytes']==32*1024*1024
    assert integrity['retained'] and integrity['progress'] and reuse['anonymousZeroFill'] and reuse['writtenIntegrity']
    before=[r['footprintBytes'] for r in bykind['host_memory'] if touched['hostElapsedSeconds']<r['hostElapsedSeconds']<free['hostElapsedSeconds']]
    after=[r['footprintBytes'] for r in bykind['host_memory'] if free['hostElapsedSeconds']+8<r['hostElapsedSeconds']<integrity['hostElapsedSeconds']]
    assert before and after
    returned=max(before)-min(after);assert returned>200*1024*1024
    window=lambda r:free['hostElapsedSeconds']<=r['hostElapsedSeconds']<integrity['hostElapsedSeconds']
    beats=sum(window(r) for r in bykind['guest_heartbeat']);assert beats>=8
    commands=Counter(requests[r['request']]['command'] for r in bykind['block_used_ack'] if window(r))
    assert all(commands[k]>0 for k in ['Read','Write','Flush'])
    progress=[r for r in bykind['guest_block_progress'] if window(r)]
    assert {r['thread'] for r in progress}=={0,1} and all(r['direct'] and r['integrity'] for r in progress)
    cycles.append({'cycle':cycle,'touchedBytes':max(before),'postFreeBytes':min(after),'returnedBytes':returned,'returnedMiB':round(returned/1048576,3),'heartbeats':beats,'completedCommandsWhileFree':dict(commands),'bothIoThreadsProgressed':True})
disk=p/'fixture.raw';assert disk.stat().st_size==64*1024*1024 and stage['diskSameIdentity']
words=0
with disk.open('rb') as stream:
    for thread in [0,1]:
        completion=[r for r in bykind['guest_block_thread_complete'] if r['thread']==thread]
        assert len(completion)==1 and completion[0]['iterations']=={0:384,1:385}[thread]
        count=completion[0]['iterations']
        for slot in range(16):
            stream.seek(thread*4*1024*1024+slot*256*1024)
            data=stream.read(256*1024);assert len(data)==256*1024
            last=max(n for n in range(count) if n%16==slot)
            for index,(value,) in enumerate(struct.iter_unpack('<Q',data)):
                assert value==(0x6a39000000000000 ^ (thread<<48) ^ (last<<24) ^ index)
                words+=1
assert words==1048576
hashes={}
for name in ['stdout.log','stderr.log','events.jsonl','result.json','fixture.raw']:
    with (p/name).open('rb') as f:hashes[name]=hashlib.file_digest(f,'sha256').hexdigest()
assert hashes['fixture.raw']==stage['diskSha256']
report={'scope':'Bounded Linux/HVF RAW block plus single-port console fixture; guest TX readiness-stall coverage remains unobserved','buildSha256':stage['buildSha256'],'guestBootId':bykind['linux_boot'][0]['bootId'],'singleFixtureVm':True,'exitVerified':True,'traceAndSourcesFrozen':True,'epochsAudited':18,'replacementSequencesAudited':mapping_count,'completedBlockRequests':len(requests),'commands':dict(Counter(r['command'] for r in requests.values())),'frozenOutstandingRequestPins':overlaps,'hostDiskWordsIndependentlyChecked':words,'cycles':cycles,'rawSha256':hashes,'activeReturnVerified':True,'ownedIoIntervalOverlapObserved':False,'blockedSyscallOverlapVerified':False,'completionHoldMillis':25,'fullResourceGatePassed':False,'encryption':False,'newCryptoKernelTested':False,'productionReady':False,'limitations':['All frozen outstanding-request observations occurred during deliberate post-I/O completion holds, not proven blocked OS syscalls.','No fs/network/vsock/GPU devices, encrypted data or production guest/runtime integration tested.','No latency or automatic resource-management guarantee established.']}
assert stage['ownersQuiescent'] and stage['streamOracle']['threadJoined']
assert stage['fixtureChecksPassed'] is False and stage['streamAudit']['errors']==['guest TX readiness stall absent']
assert len(bykind['guest_hvc_slot'])==8
slots={r['index']:r for r in bykind['guest_hvc_slot']}
assert set(slots)==set(range(8)) and slots[0]['connected'] and slots[0]['openOutcome']==0
assert all(not slots[i]['connected'] and slots[i]['openOutcome']==-19 for i in range(1,8))
assert len(bykind['guest_stream_ready'])==1 and bykind['guest_stream_ready'][0]['rawReadback']
stream_counts={r['direction']:r for r in bykind['guest_stream_complete']}
assert stream_counts['guest-to-host']['bytes']==12451840
assert stream_counts['host-to-guest']['bytes']==10158080
# Independent vectorized pattern construction, not an import of the runtime oracle.
for name,salt,expected in [('stream-guest-to-host.bin',0xa7,12451840),('stream-host-to-guest.bin',0x5c,10948608)]:
    file=p/name;assert file.stat().st_size==expected
    offset=0
    with file.open('rb') as stream:
        while data:=stream.read(65536):
            reference=bytearray()
            for block in range(offset//256,(offset+len(data)+255)//256):
                shift=(37*block+13*(block//256))%256
                reference.extend(((i+shift)%256)^salt for i in range(256))
            assert data==reference[:len(data)], (name,offset)
            offset+=len(data)
    hashes[name]=hashlib.sha256(file.read_bytes()).hexdigest()
    assert hashes[name]==stage['rawCaptureHashes'][name]
for cycle in cycles:
    free=next(r for r in bykind['guest_freed'] if r['cycle']==cycle['cycle'])
    end=next(r for r in bykind['guest_integrity'] if r['cycle']==cycle['cycle'])
    progress=[r for r in bykind['guest_stream_progress'] if free['hostElapsedSeconds']+.25<r['hostElapsedSeconds']<end['hostElapsedSeconds']-.25]
    assert {r['direction'] for r in progress}=={'host-to-guest','guest-to-host'} and all(r['raw'] and r['integrity'] for r in progress)
    cycle['bothStreamDirectionsProgressed']=True
assert stage['streamOracle']['wouldBlockWrites']==115 and stage['streamOracle']['shortWrites']==2005
assert stream_counts['guest-to-host']['waits']==0
report.update(originalFixtureChecksPassed=False,originalFixtureFailure='guest TX readiness stall absent',duplexPayloadVerified=True,streamFrozenPinObservations=sum(r['device']==1 for r in bykind['block_freeze_pin']),guestToHostBytes=12451840,hostToGuestCapturedBytes=10948608,hostToGuestConsumedBytes=10158080,hostToGuestUnconsumedSuffixBytes=790528,hostWriteWouldBlockCount=115,guestTxEagainObserved=False,streamStopVerified=False,authenticatedProtocolImplemented=False)
report['limitations']=['Original aggregate fixture remains failed for unobserved guest-TX EAGAIN; narrow positive data/reclaim observations are separate.','HVC write syscall latency/native TX capacity waits were not directly instrumented.','RAW frozen request observations occur during deliberate post-I/O completion holds; no blocked OS syscall proof.','No fs/network/vsock/GPU, production guest runtime, automatic resource management or live MMIO reset demonstrated.','Private image encryption is deferred from v1; no encryption tested here.']
print(json.dumps(report,indent=2))
