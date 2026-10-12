"""No VM: actual oracle pause/recovery and generic receipt boundary/fault checks."""
import json,socket,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from generic_fixture_oracle import GenericOracle,OracleLimits,pattern
from generic_fixture_receipts import audit,EXPECTED_ACKS
from build import ROOT,OUT,digest
from generic_fixture_paths import ARTIFACT_DIRECTORY,RUN_PREFIX

class FixtureTests(unittest.TestCase):
    def test_actual_raw_pause_with_owned_worker_alive_and_recovery(self):
        host,guest=socket.socketpair();host.setblocking(False)
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(3)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            with tempfile.TemporaryDirectory() as name:
                oracle=GenericOracle(host,Path(name),time.monotonic(),OracleLimits(bytes_per_direction=65536,initial_read_pause_seconds=.15,seconds=2),child=child);oracle.begin()
                guest.settimeout(2);guest.sendall(pattern(0,65536,0xa7))
                deadline=time.monotonic()+2
                while not oracle.pause_done and time.monotonic()<deadline:time.sleep(.01)
                guest.shutdown(socket.SHUT_WR);oracle.thread.join(1);result=oracle.finish()
                self.assertTrue(oracle.pause_done);self.assertIsNone(result['error']);self.assertTrue(result['threadJoined']);self.assertEqual(result['receivedBytes'],65536)
                self.assertTrue(any(row['kind']=='host_sink_stall_begin' and row['workerAlive'] for row in oracle.events))
                self.assertTrue(any(row['kind']=='host_sink_stall_end' and row['workerAlive'] for row in oracle.events))
                self.assertEqual((Path(name)/'stream-guest-to-host.bin').read_bytes(),pattern(0,65536,0xa7))
        finally:guest.close();child.kill();child.wait(timeout=1)
    def test_normal_owner_exit_during_stall_drains_pending_bytes_to_eof_without_tx(self):
        class Owner:
            returncode=None
            def poll(self):return self.returncode
        owner=Owner();host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);oracle=GenericOracle(host,directory,time.monotonic(),OracleLimits(bytes_per_direction=65536,initial_read_pause_seconds=1,seconds=2),child=owner);oracle.begin()
            guest.sendall(pattern(0,4096,0xa7));deadline=time.monotonic()+1
            while oracle.pause_start is None and time.monotonic()<deadline:time.sleep(.005)
            self.assertIsNotNone(oracle.pause_start)
            guest.sendall(pattern(4096,4096,0xa7));guest.shutdown(socket.SHUT_WR);owner.returncode=0;guest.shutdown(socket.SHUT_RD)
            oracle.thread.join(1);result=oracle.finish();guest.close()
            self.assertTrue(result['threadJoined']);self.assertTrue(result['peerEOF']);self.assertIsNone(result['error']);self.assertEqual(result['receivedBytes'],8192)
            self.assertEqual((directory/'stream-guest-to-host.bin').read_bytes(),pattern(0,8192,0xa7))
            self.assertTrue(any(r['kind']=='host_normal_exit_drain_begin' for r in oracle.events))
    def test_terminal_owner_exit_during_stall_keeps_partial_capture_explicit(self):
        class Owner:
            returncode=None
            def poll(self):return self.returncode
        owner=Owner();host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            oracle=GenericOracle(host,Path(name),time.monotonic(),OracleLimits(bytes_per_direction=65536,initial_read_pause_seconds=1,seconds=2),child=owner,scenario='terminal-close');oracle.begin()
            guest.sendall(pattern(0,4096,0xa7));deadline=time.monotonic()+1
            while oracle.pause_start is None and time.monotonic()<deadline:time.sleep(.005)
            guest.sendall(pattern(4096,4096,0xa7));owner.returncode=77;oracle.thread.join(1);result=oracle.finish();guest.close()
            self.assertTrue(result['threadJoined']);self.assertFalse(result['peerEOF']);self.assertEqual(result['receivedBytes'],4096);self.assertEqual(result['ownerExitCode'],77)
    def test_actual_normal_runner_aggregates_generic_audit_key(self):
        import run_generic_fixture as runner
        from unittest.mock import patch
        build={'hostSamplerTransport':'dedicated-inherited-pipe-v1','artifactDirectory':ARTIFACT_DIRECTORY,'candidate':{},'artifacts':{},'fixtureSources':{name:'pin' for name in runner.LAUNCH_DEPENDENCIES}}
        rows=[{'kind':'virtio_device','device':device} for device in ['0x0002','0x0003','0x0004','0x0005']]+[{'kind':'linux_boot'},{'kind':'guest_complete','cycles':3},{'kind':'sandbox'},{'kind':'stream_sandbox'}]
        for cycle in range(1,4):rows.extend([{'kind':'guest_reuse','anonymousZeroFill':True,'writtenIntegrity':True},{'kind':'guest_integrity','retained':True,'progress':True}])
        capture={'exitCode':0,'exitVerified':True,'ownersQuiescent':True,'timedOut':False,'captureComplete':True}
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);(out/ARTIFACT_DIRECTORY).mkdir();(out/ARTIFACT_DIRECTORY/'build.json').write_text(json.dumps(build));root=out/'source';root.mkdir();(root/'runtime-port-trace-candidate.json').write_text('{}')
            review=out/'review.json';review.write_text(json.dumps({'accepted':True,'buildSha256':'pin','heavyCompileQuiescent':True,'scenario':'normal'}))
            def supervised(command,directory,mode,parent,worker,**kwargs):parent.close();worker.close();return rows,capture,None,None
            with patch.multiple(runner,ROOT=root,OUT=out,digest=lambda p:'pin',processes=lambda:[],verify_signed_worker=lambda p:{},supervise=supervised,summary=lambda rows:{'blockReceiptsPassed':True,'reclaim':{'receiptOrderingPassed':True,'afterGuestFree':[{'heartbeatsDuringWindow':10}]}},disk_integrity=lambda p,rows:{'passed':True},stream_audit=lambda rows,oracle:{'genericChecksPassed':True}),patch.object(runner.subprocess,'check_output',return_value='System-wide memory free percentage: 50%'),patch.object(sys,'argv',['fixture','--run-runtime-port-fixture','--review-receipt',str(review)]):
                runner.main()
            result=json.loads(next(out.glob(RUN_PREFIX+'*/result.json')).read_text());self.assertTrue(result['fixtureChecksPassed']);self.assertTrue(result['streamAudit']['genericChecksPassed'])
    def rows(self):
        rows=[{'kind':'runtime_control_used_ack','channel':'stderr','row':i,'queue':q,'id':identity,'event':event,'value':value,'usedAck':True,'hostElapsedSeconds':.1+i*.1} for i,(q,identity,event,value) in enumerate(EXPECTED_ACKS)]
        rows.append({'kind':'guest_generic_ready','generic':True,'tty':False,'nonblocking':True,'exclusiveOwner':True,'openControlAckReturned':True,'portId':0,'queues':[0,1,2,3],'multiport':True,'hostElapsedSeconds':.5})
        rows.extend([{'kind':'host_sink_stall_begin','workerAlive':True,'durationSeconds':6,'hostElapsedSeconds':1},{'kind':'guest_generic_tx_backpressure','bytes':1048576,'eagain':1,'hostElapsedSeconds':1.2}])
        for tick in [2,3]:rows.extend([{'kind':'guest_heartbeat','hostElapsedSeconds':tick},{'kind':'host_sink_worker_alive','workerAlive':True,'hostElapsedSeconds':tick}])
        for thread in [0,1]:rows.append({'kind':'guest_block_progress','thread':thread,'hostElapsedSeconds':2})
        rows.extend([{'kind':'guest_terminal_close_requested','streamThreadsJoined':True,'hostElapsedSeconds':3.1},{'kind':'runtime_control_used_ack','channel':'stderr','row':5,'queue':3,'id':0,'event':6,'value':0,'usedAck':True,'hostElapsedSeconds':3.2},{'kind':'host_sink_owner_exited','stallActive':True,'exitCode':77,'hostElapsedSeconds':3.3}])
        return rows
    def test_terminal_close_ack_and_effect_uncertainty_are_distinct(self):
        result=audit(self.rows(),{'threadJoined':True,'error':None,'receiveOraclePassed':True},True)
        self.assertTrue(result['genericChecksPassed']);self.assertEqual(result['effectOutcome'],'UNCERTAIN');self.assertFalse(result['activeReturnVerified']);self.assertFalse(result['guestCloseReturnedObserved'])
    def test_missing_control_ack_wrong_channel_or_ended_stall_fails(self):
        for change in ['missing','channel','ended']:
            rows=self.rows()
            if change=='missing':rows=[r for r in rows if not(r['kind']=='runtime_control_used_ack' and r['row']==5)]
            elif change=='channel':next(r for r in rows if r['kind']=='runtime_control_used_ack' and r['row']==5)['channel']='stdout'
            else:rows[-1]['stallActive']=False
            self.assertFalse(audit(rows,{'threadJoined':True,'error':None,'receiveOraclePassed':True},True)['genericChecksPassed'])
    def test_missing_concurrent_disk_heartbeat_or_worker_liveness_fails(self):
        for kind in ['guest_heartbeat','guest_block_progress','host_sink_worker_alive']:
            self.assertFalse(audit([r for r in self.rows() if r['kind']!=kind],{'threadJoined':True,'error':None,'receiveOraclePassed':True},True)['genericChecksPassed'])
    def test_exact_build_binds_all_launch_sources_and_artifacts(self):
        from run_generic_fixture import LAUNCH_DEPENDENCIES
        build=json.loads((OUT/ARTIFACT_DIRECTORY/'build.json').read_text());self.assertTrue(LAUNCH_DEPENDENCIES.issubset(build['fixtureSources']))
        for name,sha in build['fixtureSources'].items():self.assertEqual(digest(ROOT/name),sha,name)
        for name,sha in build['artifacts'].items():self.assertEqual(digest(OUT/ARTIFACT_DIRECTORY/name),sha,name)

if __name__=='__main__':unittest.main()
