"""No VM: real raw peer transfer, bounded binary oracle, failure and source/build binding."""
import array,fcntl,json,os,socket,tempfile,threading,time,unittest
from pathlib import Path
from stream_fixture_oracle import FRAME,OracleLimits,PeerOracle,pattern,receive_peer,audit
from build import ROOT,OUT,digest

class FixtureTests(unittest.TestCase):
    def test_every_byte_and_offset_identity(self):
        for salt in (0xa7,0x5c):
            for offset in (0,256,65536,131072):
                self.assertEqual(set(pattern(offset,256,salt)),set(range(256)))
            self.assertEqual(pattern(37,256,salt),pattern(0,293,salt)[37:])
            self.assertNotEqual(pattern(0,FRAME,salt),pattern(FRAME,FRAME,salt))
    def test_only_opposite_peer_transfer(self):
        control,child=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
        private,opposite=socket.socketpair()
        try:
            child.sendmsg([b'P'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[opposite.fileno()]))])
            peer=receive_peer(control);opposite.close()
            self.assertTrue(fcntl.fcntl(peer.fileno(),fcntl.F_GETFD)&fcntl.FD_CLOEXEC)
            peer.send(b'\x00\r\n\xff');self.assertEqual(private.recv(4),b'\x00\r\n\xff')
            peer.close()
        finally:control.close();child.close();private.close();opposite.close()
    def test_reject_multiple_or_missing_peer(self):
        for descriptors in ([],[0,1]):
            control,child=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM)
            try:
                ancillary=[] if not descriptors else [(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',descriptors))]
                child.sendmsg([b'P'],ancillary)
                with self.assertRaises(RuntimeError):receive_peer(control)
            finally:control.close();child.close()
    def test_raw_duplex_byte_captures(self):
        host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);limits=OracleLimits(bytes_per_direction=FRAME,initial_read_pause_seconds=0,seconds=2)
            oracle=PeerOracle(host,directory,time.monotonic(),limits);oracle.begin()
            data=bytearray()
            guest.settimeout(2)
            # Host waits for verified raw guest bytes before injecting any TTY input.
            guest.sendall(pattern(0,FRAME,0xa7))
            while len(data)<FRAME:data.extend(guest.recv(FRAME-len(data)))
            self.assertEqual(bytes(data),pattern(0,FRAME,0x5c))
            guest.shutdown(socket.SHUT_WR)
            oracle.thread.join(2);result=oracle.finish();guest.close()
            self.assertIsNone(result['error']);self.assertTrue(result['peerEOF']);self.assertTrue(result['threadJoined'])
            self.assertEqual((directory/'stream-host-to-guest.bin').read_bytes(),bytes(data))
            self.assertEqual((directory/'stream-guest-to-host.bin').read_bytes(),pattern(0,FRAME,0xa7))
    def test_tamper_fails_with_raw_evidence(self):
        host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);oracle=PeerOracle(host,directory,time.monotonic(),OracleLimits(bytes_per_direction=FRAME,initial_read_pause_seconds=0,seconds=2));oracle.begin()
            guest.sendall(b'not the oracle');oracle.thread.join(2);result=oracle.finish();guest.close()
            self.assertFalse(result['receiveOraclePassed']);self.assertIsNotNone(result['error'])
            self.assertEqual((directory/'stream-guest-to-host.bin').read_bytes(),b'not the oracle')
    def test_receive_overflow_is_bounded(self):
        host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);oracle=PeerOracle(host,directory,time.monotonic(),OracleLimits(bytes_per_direction=16,initial_read_pause_seconds=0,seconds=2));oracle.begin()
            guest.sendall(pattern(0,32,0xa7));oracle.thread.join(2);result=oracle.finish();guest.close()
            self.assertEqual(result['error'],'raw receive byte cap');self.assertLessEqual((directory/'stream-guest-to-host.bin').stat().st_size,16)
    def test_no_peer_progress_has_finite_deadline(self):
        host,guest=socket.socketpair();host.setblocking(False)
        with tempfile.TemporaryDirectory() as name:
            oracle=PeerOracle(host,Path(name),time.monotonic(),OracleLimits(bytes_per_direction=16,seconds=.05,initial_read_pause_seconds=0));oracle.begin();oracle.thread.join(.5);result=oracle.finish();guest.close()
            self.assertTrue(result['threadJoined']);self.assertEqual(result['error'],'raw oracle deadline')
    def test_missing_guest_and_backpressure_fail_audit(self):
        result=audit([],{'threadJoined':True,'error':None,'receiveOraclePassed':True,'peerEOF':True})
        self.assertFalse(result['streamChecksPassed']);self.assertFalse(result['activeReturnVerified'])
    def test_prepared_receipt_binds_every_launch_dependency(self):
        from run_stream_fixture import LAUNCH_DEPENDENCIES
        build=json.loads((OUT/'stream-fixture-v3/build.json').read_text())
        self.assertTrue(LAUNCH_DEPENDENCIES.issubset(build['fixtureSources']))
        for name,sha in build['fixtureSources'].items():self.assertEqual(digest(ROOT/name),sha,name)
        for name,sha in build['artifacts'].items():self.assertEqual(digest(OUT/'stream-fixture-v3'/name),sha,name)

if __name__=='__main__':unittest.main()
