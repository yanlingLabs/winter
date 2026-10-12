"""No VM: real sleeping owned children, actual socket transfer and injected startup failures."""
import array,io,json,os,socket,subprocess,sys,tempfile,threading,time,unittest
from pathlib import Path
from unittest.mock import patch
from generic_capture import Limits,capture_owned_child
from generic_fixture_oracle import GenericOracle as PeerOracle
from generic_fixture_lifecycle import supervise
from build import ROOT

HELPER=r'''
import array,socket,sys,time
control=socket.socket(fileno=int(sys.argv[1]));private,peer=socket.socketpair()
control.sendmsg([b'P'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[peer.fileno()]))]);peer.close()
assert control.recv(1)==b'A';control.close()
time.sleep(30)
'''
LIMITS=Limits(run_seconds=.2,normal_wait_seconds=.1,kill_wait_seconds=.5,reader_join_seconds=.2)

class LifecycleTests(unittest.TestCase):
    def real_supervision(self,**injection):
        parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);children=[];peers=[]
        def popen(*args,**kwargs):
            child=subprocess.Popen(*args,**kwargs);children.append(child);return child
        from stream_fixture_oracle import receive_peer
        def receive(control):peer=receive_peer(control);peers.append(peer);return peer
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);begin=time.monotonic()
            result=supervise([sys.executable,'-c',HELPER,str(worker.fileno())],directory,True,parent,worker,
                             popen_factory=popen,receive_fn=receive,limits=LIMITS,**injection)
            self.assertLess(time.monotonic()-begin,3)
            self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll())
            self.assertTrue(result[1]['exitVerified']);self.assertTrue(result[1]['ownedChildReaped']);self.assertTrue(result[1]['samplerClosed'])
            self.assertEqual(parent.fileno(),-1);self.assertEqual(worker.fileno(),-1)
            self.assertTrue(all(peer.fileno()==-1 for peer in peers))
            return result
    def test_error_after_ack_before_capture_reaps_direct_child(self):
        def fault():raise RuntimeError('after ACK injected')
        rows,capture,raw,eof=self.real_supervision(after_ack=fault)
        self.assertTrue(capture['killIssued']);self.assertIn('after ACK',capture['lifecycleError']);self.assertIsNone(raw)
    def test_interrupt_after_ack_reaps_direct_child(self):
        def fault():raise KeyboardInterrupt('injected cancellation')
        rows,capture,raw,eof=self.real_supervision(after_ack=fault)
        self.assertTrue(capture['interrupted']);self.assertTrue(capture['killIssued'])
    def test_oracle_thread_start_failure_closes_peer(self):
        class FailedOracle(PeerOracle):
            def begin(self):raise RuntimeError('oracle start injected')
        _,capture,raw,_=self.real_supervision(oracle_factory=FailedOracle)
        self.assertTrue(capture['ownersQuiescent']);self.assertFalse(raw['threadStarted']);self.assertTrue(raw['threadJoined'])
    def test_error_after_actual_oracle_thread_start_joins_writer(self):
        class FailedOracle(PeerOracle):
            def begin(self):super().begin();raise RuntimeError('after oracle start injected')
        _,capture,raw,_=self.real_supervision(oracle_factory=FailedOracle)
        self.assertTrue(raw['threadStarted']);self.assertTrue(raw['threadJoined']);self.assertTrue(capture['ownersQuiescent'])
    def test_partial_capture_reader_start_reaps_and_joins(self):
        threads=[]
        class Reader(threading.Thread):
            def start(self):
                if len(threads)==1:threads.append(self);raise RuntimeError('second reader injected')
                threads.append(self);super().start()
        def capture(child,directory,limits,*,sampler):return capture_owned_child(child,directory,limits,thread_factory=Reader,sampler=sampler)
        _,result,raw,_=self.real_supervision(capture_fn=capture)
        self.assertEqual(result['readerThreadsStarted'],1);self.assertTrue(result['readerThreadsJoined']);self.assertEqual(result['captureError'],'RuntimeError')
        self.assertTrue(all(thread.ident is None or not thread.is_alive() for thread in threads))
    def test_interrupt_capture_supervision_reaps_and_joins_oracle(self):
        def capture(*args,**kwargs):raise KeyboardInterrupt('capture injected')
        _,result,raw,_=self.real_supervision(capture_fn=capture)
        self.assertTrue(result['interrupted']);self.assertTrue(raw['threadJoined'])
    def test_interrupt_inside_capture_reaps_and_joins_partial_readers(self):
        import queue
        class InterruptedQueue(queue.Queue):
            def get(self,*args,**kwargs):raise KeyboardInterrupt('capture queue interruption')
        def capture(child,directory,limits,*,sampler):
            with patch('generic_capture.queue.Queue',InterruptedQueue):
                return capture_owned_child(child,directory,limits,sampler=sampler)
        _,result,raw,_=self.real_supervision(capture_fn=capture)
        self.assertTrue(result['interrupted']);self.assertEqual(result['captureError'],'KeyboardInterrupt')
        self.assertTrue(result['readerThreadsJoined']);self.assertTrue(raw['threadJoined'])
    def test_unreapable_child_is_finite_and_keeps_ownership_uncertain(self):
        class Unreapable:
            pid=123;stdout=io.BytesIO();stderr=io.BytesIO()
            def kill(self):pass
            def wait(self,timeout):
                self.last_timeout=timeout;raise subprocess.TimeoutExpired('fixture',timeout)
        parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);host,peer=socket.socketpair()
        with tempfile.TemporaryDirectory() as name:
            # Isolated fake Popen object; no PID signal is issued by this test.
            child=Unreapable();begin=time.monotonic()
            def fail():raise RuntimeError('uncertain fixture')
            _,capture,raw,_=supervise(['fixture'],Path(name),True,parent,worker,popen_factory=lambda *a,**k:child,
                                      receive_fn=lambda c:host,after_ack=fail,limits=LIMITS)
            self.assertLess(time.monotonic()-begin,.5);self.assertFalse(capture['ownersQuiescent']);self.assertTrue(capture['terminationUncertain'])
            self.assertEqual(child.last_timeout,.5);self.assertEqual(host.fileno(),-1);self.assertTrue(capture['samplerClosed'])
        peer.close()
    def test_runner_skips_disk_and_raw_inspection_when_owners_uncertain(self):
        import run_generic_fixture as runner
        # Uses actual runner, preflight mocked to synthetic receipts. Any disk/hash call after spawn is forbidden.
        build={'hostSamplerTransport':'dedicated-inherited-pipe-v1','candidate':{},'artifacts':{},'fixtureSources':{name:'pin' for name in runner.LAUNCH_DEPENDENCIES}}
        capture={'exitCode':None,'exitVerified':False,'ownersQuiescent':False,'timedOut':False,'lifecycleError':'injected','readerThreadsJoined':False}
        calls=[]
        def digest(path):
            calls.append(Path(path).name)
            if Path(path).name=='fixture.raw' or str(path).endswith('.bin'):raise AssertionError('uncertain owner file inspection')
            return 'pin'
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);(out/'generic-fixture').mkdir();(out/'generic-fixture/build.json').write_text(json.dumps(build))
            root=out/'source';root.mkdir();(root/'runtime-port-trace-candidate.json').write_text('{}')
            def lifecycle(command,directory,mode,parent,worker,**kwargs):parent.close();worker.close();return [],capture,None,None
            with patch.multiple(runner,ROOT=root,OUT=out,digest=digest,processes=lambda:[],verify_signed_worker=lambda p:{},supervise=lifecycle),patch.object(sys,'argv',['fixture','--sandbox-check']):
                with self.assertRaises(SystemExit):runner.main()
            result=json.loads(next(out.glob('generic-fixture-*/result.json')).read_text())
            self.assertTrue(result['diskAuditSkipped']);self.assertIsNone(result['diskSha256']);self.assertNotIn('fixture.raw',calls)
    def test_spawn_failure_closes_both_exact_owned_sampler_descriptors(self):
        descriptors=[];real_pipe=os.pipe
        def pipe():
            pair=real_pipe();descriptors.extend(pair);return pair
        def refusal(*args,**kwargs):
            self.assertEqual(len(kwargs['pass_fds']),2);self.assertEqual(kwargs['pass_fds'][1],descriptors[1])
            self.assertTrue(kwargs['close_fds']);raise OSError('spawn injected')
        parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        with tempfile.TemporaryDirectory() as name,patch('generic_fixture_lifecycle.os.pipe',pipe):
            _,capture,_,_=supervise(['fixture'],Path(name),False,parent,worker,popen_factory=refusal,limits=LIMITS)
        self.assertTrue(capture['samplerClosed']);self.assertIn('spawn injected',capture['lifecycleError'])
        for descriptor in descriptors:
            with self.assertRaises(OSError):os.fstat(descriptor)

    def test_absolute_deadline_nanoseconds_and_positive_progress(self):
        code=r'''
#include <assert.h>
#include "stream_frame_deadline.h"
int main(void){
 struct timespec deadline={17,800000000};
 assert(!stream_frame_expired((struct timespec){17,799999999},deadline));
 assert(stream_frame_expired((struct timespec){17,800000000},deadline));
 assert(stream_frame_expired((struct timespec){17,800000001},deadline));
 assert(stream_frame_expired((struct timespec){18,0},deadline));
 /* Positive short operations cannot refresh the absolute deadline. */
 unsigned positive=0;for(long ns=799999995;ns<800000010;ns++){
  if(stream_frame_expired((struct timespec){17,ns},deadline))break;positive++;
 }assert(positive==5);return 0;
}'''
        with tempfile.TemporaryDirectory() as name:
            source=Path(name)/'deadline.c';source.write_text(code);binary=Path(name)/'deadline'
            subprocess.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-I',str(ROOT),str(source),'-o',str(binary)],check=True)
            subprocess.run([str(binary)],check=True,timeout=2)

if __name__=='__main__':unittest.main()
