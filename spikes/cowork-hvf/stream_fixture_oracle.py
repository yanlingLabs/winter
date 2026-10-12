"""Fixture-only raw peer oracle. No packet parser, keys, TTY, credentials or network addresses."""
import array,fcntl,json,os,select,socket,threading,time
from dataclasses import dataclass

FRAME=65536
CAP=256*FRAME

def pattern(offset,size,salt):
    # Every aligned 256-byte span is a permutation of all bytes, including NUL/CR/LF/DEL.
    return bytes(((i+37*(i>>8)+13*(i>>16))&255)^salt for i in range(offset,offset+size))

def receive_peer(control):
    control.settimeout(10)
    message,ancillary,flags,_=control.recvmsg(1,socket.CMSG_SPACE(4))
    descriptors=[]
    for level,kind,data in ancillary:
        if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
            values=array.array('i');values.frombytes(data[:len(data)-(len(data)%values.itemsize)]);descriptors.extend(values)
    if message!=b'P' or flags&(socket.MSG_CTRUNC|socket.MSG_TRUNC) or len(descriptors)!=1:
        for fd in descriptors:os.close(fd)
        raise RuntimeError('Exactly one opposite stream peer required')
    fd=descriptors[0];peer=None
    try:
        fcntl.fcntl(fd,fcntl.F_SETFD,fcntl.fcntl(fd,fcntl.F_GETFD)|fcntl.FD_CLOEXEC)
        peer=socket.socket(fileno=fd)
        if peer.family!=socket.AF_UNIX or peer.type!=socket.SOCK_STREAM or peer.getsockname() or peer.getpeername():raise RuntimeError('Only unnamed connected stream peer permitted')
        peer.setblocking(False)
        # Public peer may change independently; private library endpoint never leaves the library.
        peer.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,4096)
        return peer
    except BaseException:
        if peer is not None:peer.close()
        else:os.close(fd)
        raise

@dataclass(frozen=True)
class OracleLimits:
    bytes_per_direction:int=CAP
    read_chunk:int=16384
    write_chunk:int=16384
    event_rows:int=8192
    seconds:float=125
    join_seconds:float=1
    initial_read_pause_seconds:float=3

class PeerOracle:
    def __init__(self,peer,directory,start,limits=OracleLimits()):
        self.peer=peer;self.directory=directory;self.start=start;self.limits=limits;self.stop=threading.Event();self.events=[]
        self.result={'receivedBytes':0,'sentBytes':0,'receiveOraclePassed':True,'wouldBlockWrites':0,'shortWrites':0,'readPauseSeconds':limits.initial_read_pause_seconds,'peerEOF':False,'error':None,'rawBinaryCaptured':True,'blockedSyscallVerified':False}
        self.thread=threading.Thread(target=self._run,daemon=True)
    def begin(self):self.thread.start()
    def _event(self,kind,**fields):
        if len(self.events)>=self.limits.event_rows:raise RuntimeError('raw event row cap')
        self.events.append({'kind':kind,'hostElapsedSeconds':time.monotonic()-self.start,**fields})
    def _run(self):
        tx=b'';position=0;next_progress=FRAME;pending_attempt=True
        try:
            with (self.directory/'stream-host-to-guest.bin').open('wb') as sent,(self.directory/'stream-guest-to-host.bin').open('wb') as received:
                while not self.stop.is_set():
                    elapsed=time.monotonic()-self.start
                    if elapsed>self.limits.seconds:raise RuntimeError('raw oracle deadline')
                    sent_bytes=self.result['sentBytes'];received_bytes=self.result['receivedBytes']
                    if not tx and received_bytes>0 and sent_bytes<self.limits.bytes_per_direction:
                        tx=pattern(sent_bytes,min(self.limits.write_chunk,self.limits.bytes_per_direction-sent_bytes),0x5c);position=0;pending_attempt=True
                    # One real nonblocking attempt probes capacity; readiness prevents busy looping afterward.
                    if tx and pending_attempt:
                        try:
                            n=self.peer.send(tx[position:]);
                            if not n:raise RuntimeError('zero peer write')
                            if n<len(tx)-position:self.result['shortWrites']+=1
                            sent.write(tx[position:position+n]);position+=n;self.result['sentBytes']+=n
                            if position==len(tx):tx=b''
                        except BlockingIOError:self.result['wouldBlockWrites']+=1;pending_attempt=False
                    can_read=elapsed>=self.limits.initial_read_pause_seconds
                    readable,writable,_=select.select([self.peer] if can_read else [],[self.peer] if tx and not pending_attempt else [],[],.02)
                    if writable:pending_attempt=True
                    if readable:
                        data=self.peer.recv(self.limits.read_chunk)
                        if not data:self.result['peerEOF']=True;break
                        offset=self.result['receivedBytes']
                        if offset+len(data)>self.limits.bytes_per_direction:raise RuntimeError('raw receive byte cap')
                        received.write(data)
                        if data!=pattern(offset,len(data),0xa7):self.result['receiveOraclePassed']=False;raise RuntimeError('every-byte guest to host oracle')
                        self.result['receivedBytes']+=len(data)
                    if min(self.result['receivedBytes'],self.result['sentBytes'])>=next_progress:
                        self._event('host_stream_progress',sentBytes=self.result['sentBytes'],receivedBytes=self.result['receivedBytes'],integrity=True)
                        next_progress+=FRAME
        except (OSError,ValueError,RuntimeError) as error:self.result['error']=str(error)
        finally:self.peer.close()
    def finish(self,cancel=False):
        started=self.thread.ident is not None
        if started:
            if not cancel:
                try:self.thread.join(self.limits.join_seconds)
                except BaseException as error:self.result['error']=type(error).__name__
            self.stop.set()
            # Wakes select/recv on failure or interruption; no payload is inspected here.
            if self.thread.is_alive():
                try:self.peer.shutdown(socket.SHUT_RDWR)
                except OSError:pass
            try:self.thread.join(self.limits.join_seconds)
            except BaseException as error:self.result['error']=type(error).__name__
        else:
            self.stop.set();self.peer.close()
        joined=not started or not self.thread.is_alive()
        self.result.update(threadStarted=started,threadJoined=joined,limits=vars(self.limits),eventRows=len(self.events) if joined else None)
        # Never inspect/hash raw captures or mutable events while a writer is uncertain.
        return dict(self.result)

def audit(rows,oracle):
    errors=[];windows=[]
    frozen=[r for r in rows if r.get('kind')=='block_freeze_pin' and r.get('device')==1]
    if not frozen:errors.append('actual stream-device frozen pins absent')
    for pin in frozen:
        exclusions=[r for r in rows if r.get('kind')=='reclaim_exclusion' and r.get('epoch')==pin['epoch']]
        if not pin.get('ranges') or any(not any(e['gpa']<=span['gpa'] and span['gpa']+span['len']<=e['gpa']+e['len'] for e in exclusions) for span in pin.get('ranges',[])):errors.append('stream frozen pin outside reclaim exclusions')
    ready=[r for r in rows if r.get('kind')=='guest_stream_ready']
    if len(ready)!=1 or not ready[0].get('rawReadback') or ready[0].get('connectedHvcCount')!=1 or ready[0].get('virtioConsoleCount')!=1 or ready[0].get('portId')!=0 or ready[0].get('multiport') is not False or ready[0].get('singlePortQueues')!=[0,1] or ready[0].get('registeredClassSlots')!=8:errors.append('single raw Linux hvc not established')
    completion={r['direction']:r for r in rows if r.get('kind')=='guest_stream_complete'}
    if set(completion)!={'guest-to-host','host-to-guest'}:errors.append('both guest streams must finish/join')
    if completion.get('guest-to-host',{}).get('bytes')!=oracle.get('receivedBytes'):errors.append('guest TX and raw host RX counts differ')
    inbound=completion.get('host-to-guest',{}).get('bytes',0)
    if inbound<=0 or inbound>oracle.get('sentBytes',0):errors.append('guest RX count outside captured sent prefix')
    for cycle in range(1,4):
        free=next((r for r in rows if r.get('kind')=='guest_freed' and r.get('cycle')==cycle),None)
        integrity=next((r for r in rows if r.get('kind')=='guest_integrity' and r.get('cycle')==cycle),None)
        progress=[r for r in rows if r.get('kind')=='guest_stream_progress' and free and integrity and free['hostElapsedSeconds']+.25<r['hostElapsedSeconds']<integrity['hostElapsedSeconds']-.25]
        directions=sorted({r['direction'] for r in progress});windows.append({'cycle':cycle,'directions':directions,'progressReceipts':len(progress)})
        if set(directions)!={'guest-to-host','host-to-guest'}:errors.append('both stream directions absent in free window '+str(cycle))
    if not oracle.get('threadJoined') or oracle.get('error') or not oracle.get('receiveOraclePassed') or not oracle.get('peerEOF'):errors.append('raw capture/oracle incomplete')
    if oracle.get('wouldBlockWrites',0)==0:errors.append('actual host nonblocking backpressure absent')
    if not completion.get('guest-to-host',{}).get('waits'):errors.append('guest TX readiness stall absent')
    return {'streamChecksPassed':not errors,'errors':errors,'freedWindows':windows,'guestCompletion':completion,'streamFrozenPinObservations':len(frozen),'activeReturnVerified':False,'blockedSyscallVerified':False,'authenticatedProtocolImplemented':False}
