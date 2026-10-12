"""Closed two-disk fixture layout/FD transfer/oracle; not production authority."""
import array,fcntl,json,os,socket,stat,struct
from build import digest
from generic_fixture_oracle import receive_peer
from generic_fixture_receipts import audit as generic_audit

ARTIFACT_DIRECTORY='workspace-fixture-v2'
RUN_PREFIX='workspace-fixture-v2-'
SERIALS=('winter-data','winter-environment')
CAPACITIES=(64*1024*1024,80*1024*1024)
MAGIC=0x57464431
RECORD=struct.Struct('=IIQQQIIQQQII')
assert RECORD.size==72

def volume_identity(fd):
    value=os.fstat(fd);flags=fcntl.fcntl(fd,fcntl.F_GETFL)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink!=1 or value.st_uid!=os.geteuid() or stat.S_IMODE(value.st_mode)!=0o600 or flags&os.O_ACCMODE!=os.O_RDWR or flags&os.O_APPEND:raise RuntimeError('Fixture volume identity')
    return (value.st_dev,value.st_ino,value.st_size,value.st_uid,stat.S_IMODE(value.st_mode))

def handoff_pair(control,descriptors):
    if control.family!=socket.AF_UNIX or control.type!=socket.SOCK_DGRAM or control.getsockname() or control.getpeername():raise RuntimeError('Unnamed connected fixture datagram required')
    if len(descriptors)!=2:raise RuntimeError('Exact two-disk fixture pair required')
    identities=[volume_identity(fd) for fd in descriptors]
    if tuple(value[2] for value in identities)!=CAPACITIES or identities[0][:2]==identities[1][:2]:raise RuntimeError('Distinct fixed-capacity volumes required')
    record=RECORD.pack(MAGIC,1,*identities[0],*identities[1]);control.settimeout(3)
    if control.sendmsg([record],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',descriptors))])!=len(record):raise RuntimeError('Incomplete fixture pair transfer')
    return identities

def transfer_then_receive(descriptors):
    def receive(control):
        handoff_pair(control,descriptors)
        return receive_peer(control)
    return receive

def disk_integrity(path,index,rows):
    complete=[row for row in rows if row.get('kind')=='guest_workspace_disk_complete' and row.get('index')==index]
    if len(complete)!=1:return {'passed':False,'reason':'exact per-disk completion absent'}
    row=complete[0];count=row.get('iterations')
    if type(count)!=int or not 1<=count<=1400 or row.get('serial')!=SERIALS[index] or row.get('reads')!=count or row.get('writes')!=count or row.get('flushes')!=(count+15)//16 or row.get('finalSync') is not True or row.get('closed') is not True:return {'passed':False,'reason':'invalid per-disk completion'}
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        value=os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_size!=CAPACITIES[index]:return {'passed':False,'reason':'fixed disk geometry'}
        start=index*4*1024*1024;end=start+4*1024*1024
        for offset in range(0,value.st_size,256*1024):
            data=os.pread(fd,256*1024,offset)
            if len(data)!=256*1024:return {'passed':False,'reason':'short audit read'}
            if start<=offset<end:
                slot=(offset-start)//(256*1024);last=count-1-((count-1-slot)%16) if count>slot else None
                for word,(actual,) in enumerate(struct.iter_unpack('<Q',data)):
                    expected=0x6a39000000000000 ^ (index<<48) ^ (last<<24) ^ word if last is not None else 0
                    if actual!=expected:return {'passed':False,'reason':'every-word mismatch','offset':offset+word*8}
            elif any(data):return {'passed':False,'reason':'unrelated disk extent changed','offset':offset}
        return {'passed':True,'index':index,'serial':SERIALS[index],'iterations':count,'capacityBytes':value.st_size,'untouchedExtentsVerified':True}
    finally:os.close(fd)

def workspace_audit(rows,oracle):
    errors=[]
    pair=[r for r in rows if r.get('kind')=='workspace_pair']
    if len(pair)!=1 or pair[0].get('runtimeAccessDevice')!=2 or pair[0].get('callerVolumeFDsClosed') is not True or pair[0].get('dataSerial')!=SERIALS[0] or pair[0].get('environmentSerial')!=SERIALS[1] or pair[0].get('dataCapacityBytes')!=CAPACITIES[0] or pair[0].get('environmentCapacityBytes')!=CAPACITIES[1]:errors.append('exact native two-disk pair receipt absent')
    disks=[r for r in rows if r.get('kind')=='guest_workspace_disk']
    for index in range(2):
        found=[r for r in disks if r.get('index')==index]
        if len(found)!=1 or found[0].get('serial')!=SERIALS[index] or found[0].get('capacityBytes')!=CAPACITIES[index] or found[0].get('node')!='/dev/vd'+chr(ord('a')+index):errors.append('guest serial/capacity binding absent '+str(index))
    if len(disks)!=2:errors.append('exact guest disk count absent')
    # The frozen generic audit uses device1 for its single-disk runtime stream.
    # Feed ONLY native runtime device2 freeze pins through that classification;
    # disk1 pins must never masquerade as stream coverage. Original rows persist.
    stream_rows=[{**r,'device':1} if r.get('kind')=='block_freeze_pin' else r for r in rows if r.get('kind')!='block_freeze_pin' or r.get('device')==2]
    inherited=generic_audit(stream_rows,oracle)
    if not inherited['genericChecksPassed']:errors.extend(inherited['errors'])
    for device in (0,1):
        if not any(r.get('kind')=='block_freeze_pin' and r.get('device')==device and r.get('ranges') for r in rows):errors.append('disk frozen pin absent '+str(device))
    return {'passed':not errors,'errors':errors,'runtimeAccessDevice':2,'generic':inherited,'twoDiskActiveReturnVerified':False,'productionReady':False}
