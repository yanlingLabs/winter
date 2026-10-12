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
    initial_read_pause_seconds:float=6

class GenericOracle:
    def __init__(self,peer,directory,start,limits=OracleLimits(),child=None,scenario="normal"):
        self.scenario=scenario;self.child=child;self.pause_start=None;self.pause_done=False;self.next_alive=0;self.peer=peer;self.directory=directory;self.start=start;self.limits=limits;self.stop=threading.Event();self.events=[]
        self.result={'receivedBytes':0,'sentBytes':0,'receiveOraclePassed':True,'wouldBlockWrites':0,'shortWrites':0,'readPauseSeconds':limits.initial_read_pause_seconds,'peerEOF':False,'error':None,'rawBinaryCaptured':True,'blockedSyscallVerified':False}
        self.thread=threading.Thread(target=self._run,daemon=True)
    def begin(self):self.thread.start()
    def _event(self,kind,**fields):
        if len(self.events)>=self.limits.event_rows:raise RuntimeError('raw event row cap')
        self.events.append({'kind':kind,'hostElapsedSeconds':time.monotonic()-self.start,**fields})
    def _run(self):
        tx=b'';position=0;next_progress=FRAME;pending_attempt=True;owner_exited=False
        try:
            with (self.directory/'stream-host-to-guest.bin').open('wb') as sent,(self.directory/'stream-guest-to-host.bin').open('wb') as received:
                while not self.stop.is_set():
                    elapsed=time.monotonic()-self.start
                    if elapsed>self.limits.seconds:raise RuntimeError('raw oracle deadline')
                    if not owner_exited and self.child is not None and self.child.poll() is not None:
                        owner_exited=True;self.result['ownerExitCode']=self.child.returncode
                        self._event('host_sink_owner_exited',exitCode=self.child.returncode,stallActive=self.pause_start is not None and not self.pause_done)
                        if self.scenario=='terminal-close':break
                        # Normal poweroff can leave queued RX bytes. Stop TX, drain/verify through EOF.
                        tx=b'';position=0;self._event('host_normal_exit_drain_begin')
                    if self.pause_start is not None and not self.pause_done and elapsed>=self.next_alive:
                        self._event('host_sink_worker_alive',workerAlive=self.child is not None and self.child.poll() is None)
                        self.next_alive=elapsed+1
                    sent_bytes=self.result['sentBytes'];received_bytes=self.result['receivedBytes']
                    if not owner_exited and not tx and received_bytes>0 and sent_bytes<self.limits.bytes_per_direction:
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
                    can_read=owner_exited or self.pause_start is None or elapsed>=self.pause_start+self.limits.initial_read_pause_seconds
                    if not owner_exited and self.pause_start is not None and can_read and not self.pause_done:
                        self.pause_done=True;self._event('host_sink_stall_end',workerAlive=self.child is not None and self.child.poll() is None,receivedBytes=self.result['receivedBytes'])
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
                        if self.pause_start is None and not owner_exited:
                            self.pause_start=time.monotonic()-self.start;self.next_alive=self.pause_start
                            self._event('host_sink_stall_begin',workerAlive=self.child is not None and self.child.poll() is None,receivedBytes=self.result['receivedBytes'],durationSeconds=self.limits.initial_read_pause_seconds)
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
