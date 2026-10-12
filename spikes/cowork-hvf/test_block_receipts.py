"""Receipt rejection and post-exit synthetic disk verification; no VM."""
import tempfile,unittest,struct
from pathlib import Path
from build import OUT
from block_receipts import summary
from run_block import disk_integrity
class Receipts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True, exist_ok=True)
    def test_missing_trace_and_progress_cannot_pass(self):
        result=summary([]);self.assertFalse(result['blockReceiptsPassed']);self.assertFalse(result['activeReturnVerified']);self.assertFalse(result['productionReady'])
    def test_trace_overflow_rejects(self):
        self.assertIn('bounded trace overflow',summary([{'kind':'block_trace_overflow'}])['errors'])
    def test_stage_without_capture_rejects(self):
        self.assertIn('stage without capture',summary([{'kind':'block_used_ack','request':1}])['errors'])
    def test_owned_interval_is_not_labeled_as_blocked_syscall(self):
        ranges=[{'gpa':4096,'len':16}]
        rows=[{'kind':'block_request_capture','request':1,'pin':1,'head':0,'command':'Read','length':512,'leaseReleased':True,'ranges':ranges,'clockMicros':0},
              {'kind':'block_owned_io_begin','request':1,'clockMicros':1},
              {'kind':'block_owned_io_end','request':1,'clockMicros':10,'success':True},
              {'kind':'block_used_ack','request':1,'clockMicros':12,'head':0,'success':True},
              {'kind':'block_freeze_pin','pin':1,'epoch':1,'ranges':ranges,'clockMicros':5},
              {'kind':'reclaim_exclusion','epoch':1,'gpa':4096,'len':16}]
        result=summary(rows);overlap=result['outstandingRequestOverlap'][0];self.assertTrue(overlap['ownedIoIntervalOverlap']);self.assertNotIn('osSyscallOverlap',overlap);self.assertFalse(result['blockedSyscallOverlapVerified']);self.assertFalse(result['activeReturnVerified'])
    def test_whole_synthetic_disk_pattern_and_tamper(self):
        with tempfile.TemporaryDirectory(prefix='block-receipt-',dir=OUT) as directory:
            disk=Path(directory)/'fixture.raw'
            with disk.open('wb') as stream:
                stream.truncate(64*1024*1024)
                for thread in [0,1]:
                    for slot in range(16):
                        stream.seek(thread*4*1024*1024+slot*256*1024)
                        stream.write(b''.join(struct.pack('<Q',0x6a39000000000000^(thread<<48)^(slot<<24)^word) for word in range(256*1024//8)))
            rows=[{'kind':'guest_block_thread_complete','thread':t,'iterations':16} for t in [0,1]]
            self.assertTrue(disk_integrity(disk,rows)['passed'])
            with disk.open('r+b') as stream:stream.seek(7*256*1024+8184);stream.write(b'\xaa')
            self.assertFalse(disk_integrity(disk,rows)['passed'])
if __name__=='__main__':unittest.main()
