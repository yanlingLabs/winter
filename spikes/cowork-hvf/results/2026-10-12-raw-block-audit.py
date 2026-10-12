from pathlib import Path
from collections import Counter,defaultdict
import hashlib,json,struct
# Reproduce the fixed 2026-10-12 root audit; this is not a general VM validator.
# Read-only: no launch, remap, disk mutation or receipt overwrite.
import sys
if not __debug__:
    raise SystemExit("Assertions must be enabled for this evidence audit")
if len(sys.argv) != 2:
    raise SystemExit("usage: 2026-10-12-raw-block-audit.py RETAINED_FIXTURE_DIRECTORY")
p=Path(sys.argv[1])
rows=[json.loads(line) for line in (p/'events.jsonl').read_text().splitlines()]
for index,row in enumerate(rows):row['_index']=index
stage=json.loads((p/'result.json').read_text())
assert stage['exitCode']==0 and stage['exitVerified'] and stage['ownedChildReaped']
assert not stage['terminationUncertain'] and not stage['captureOverflow'] and stage['captureComplete'] and stage['readerThreadsJoined']
assert stage['buildSha256']=='99162c0f198d128f80cf5c6a0a57af964df924c60e162e050cf0a523320adf55'
bykind=defaultdict(list)
for row in rows:bykind[row['kind']].append(row)
assert len(bykind['linux_boot'])==1 and len(bykind['worker'])==1 and len(bykind['guest_complete'])==1
worker=bykind['worker'][0]
assert worker['pid']==68876 and worker['vcpus']==2 and worker['ramMiB']==768 and worker['networkDevices']==0 and worker['hostShares']==0 and worker['vsock'] is False
assert bykind['guest_complete'][0]['cycles']==3
assert sorted(row['device'] for row in bykind['virtio_device'])==['0x0002','0x0004','0x0005']
assert not any(bykind[k] for k in ['guest_failure','reclaim_failure','block_trace_overflow'])
assert all(row['pid']==worker['pid'] for row in bykind['host_memory'])
ram_start,ram_end=0x80000000,0x80000000+768*1024*1024
mapping_count=0
for epoch in range(1,18):
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
assert mapping_count==297
requests={r['request']:r for r in bykind['block_request_capture']}
assert len(requests)==len(bykind['block_request_capture'])==1486
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
assert len(holds)==1486 and all(r['millis']==25 and r['osSyscallBlocked'] is False for r in holds.values())
overlaps=[]
for frozen in bykind['block_freeze_pin']:
    exclusion=[r for r in bykind['reclaim_exclusion'] if r['epoch']==frozen['epoch']]
    for span in frozen['ranges']:
        assert any(r['gpa']<=span['gpa'] and span['gpa']+span['len']<=r['gpa']+r['len'] for r in exclusion)
    if frozen['pin'] in rings:
        assert frozen['ranges']==rings[frozen['pin']]['ranges'];continue
    capture=pins[frozen['pin']];ack=ack_by[capture['request']]
    assert capture['ranges']==frozen['ranges'] and capture['generation']==frozen['generation']
    assert capture['clockMicros']<=frozen['clockMicros']<ack['clockMicros']
    assert holds[capture['request']]['clockMicros']<=frozen['clockMicros']
    overlaps.append({'epoch':frozen['epoch'],'request':capture['request'],'pin':frozen['pin']})
assert len(overlaps)==17 and {r['epoch'] for r in overlaps}==set(range(1,18))
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
        assert len(completion)==1 and completion[0]['iterations']==92
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
report={'scope':'Bounded Linux/HVF RAW block fixture with controlled post-I/O completion holds','buildSha256':stage['buildSha256'],'guestBootId':bykind['linux_boot'][0]['bootId'],'singleRunningVm':True,'exitVerified':True,'traceAndSourcesFrozen':True,'epochsAudited':17,'replacementSequencesAudited':mapping_count,'completedBlockRequests':len(requests),'commands':dict(Counter(r['command'] for r in requests.values())),'frozenOutstandingRequestPins':overlaps,'hostDiskWordsIndependentlyChecked':words,'cycles':cycles,'rawSha256':hashes,'activeReturnVerified':True,'ownedIoIntervalOverlapObserved':False,'blockedSyscallOverlapVerified':False,'completionHoldMillis':25,'fullResourceGatePassed':False,'encryption':False,'newCryptoKernelTested':False,'productionReady':False,'limitations':['All frozen outstanding-request observations occurred during deliberate post-I/O completion holds, not proven blocked OS syscalls.','No fs/network/vsock/GPU devices, encrypted data or production guest/runtime integration tested.','No latency or automatic resource-management guarantee established.']}
print(json.dumps(report,indent=2))
