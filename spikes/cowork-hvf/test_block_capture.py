"""No-VM bounded output/termination tests against actual capture/runner functions."""
import hashlib,io,json,subprocess,sys,tempfile,time,unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
from build import OUT
from block_capture import Limits,capture_owned_child,finish_owned_child
import run_block

class Unreapable:
    pid=987654321
    stdout=io.BytesIO(b'');stderr=io.BytesIO(b'')
    def __init__(self):self.waits=[];self.kills=0
    def wait(self,timeout=None):
        if timeout is None:raise AssertionError('unbounded wait')
        self.waits.append(timeout);raise subprocess.TimeoutExpired('fake-owned-child',timeout)
    def kill(self):self.kills+=1

class Capture(unittest.TestCase):
    def run_child(self,program,limits):
        with tempfile.TemporaryDirectory(prefix='capture-test-',dir=OUT) as directory:
            child=subprocess.Popen([sys.executable,'-c',program],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
            try:
                rows,result=capture_owned_child(child,Path(directory),limits)
                sizes={name:(Path(directory)/(name+'.log')).stat().st_size for name in ['stdout','stderr']}
                self.assertIsNotNone(child.poll());self.assertTrue(result['exitVerified']);return rows,result,sizes
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=2)
                child.stdout.close();child.stderr.close()
    def limits(self,**changes):
        return Limits(**{'channel_bytes':4096,'total_bytes':6144,'line_bytes':256,'parsed_rows':100,'queue_items':2,'chunk_bytes':128,'run_seconds':2,'normal_wait_seconds':.1,'kill_wait_seconds':1,'reader_join_seconds':.1,**changes})
    def test_success_uses_bounded_queue_and_parsed_rows(self):
        rows,result,_=self.run_child('print(\'{"kind":"ok"}\')',self.limits());self.assertTrue(result['captureComplete']);self.assertEqual(rows[0]['kind'],'ok');self.assertEqual(result['limits']['queue_items'],2)
    def test_flood_hits_channel_and_total_caps(self):
        for channel,total in [(512,4096),(4096,512)]:
            _,result,sizes=self.run_child('import os\nfor n in range(10000): os.write(1,b"x\\n"*64)',self.limits(channel_bytes=channel,total_bytes=total))
            self.assertTrue(result['captureOverflow']);self.assertTrue(result['killIssued']);self.assertLessEqual(sizes['stdout'],channel);self.assertLessEqual(sum(sizes.values()),total)
    def test_newline_free_oversized_line_is_bounded(self):
        _,result,sizes=self.run_child('import os;os.write(1,b"x"*1048576)',self.limits(line_bytes=64,chunk_bytes=32));self.assertTrue(result['captureOverflow']);self.assertEqual(result['captureError'],'newline-free line byte cap');self.assertLessEqual(sizes['stdout'],96)
    def test_newline_terminated_oversized_line_rejected(self):
        _,result,_=self.run_child('print("x"*1000)',self.limits(line_bytes=64,chunk_bytes=128));self.assertTrue(result['captureOverflow'])
    def test_parsed_row_cap(self):
        rows,result,_=self.run_child('import os\nfor n in range(100):os.write(1,b\'{"kind":"row"}\\n\')',self.limits(parsed_rows=3));self.assertTrue(result['captureOverflow']);self.assertEqual(len(rows),3)
    def test_unreapable_child_has_only_finite_waits_and_uncertain_exit(self):
        child=Unreapable();start=time.monotonic();result=finish_owned_child(child,self.limits());self.assertLess(time.monotonic()-start,.1);self.assertTrue(result['terminationUncertain']);self.assertFalse(result['ownedChildReaped']);self.assertEqual(child.kills,1);self.assertEqual(child.waits,[.1,1])
    def test_launch_audit_dependencies_cannot_be_omitted_or_changed(self):
        for omitted in [False,True]:
            with tempfile.TemporaryDirectory(prefix='dependency-test-',dir=OUT) as directory:
                base=Path(directory);artifacts=base/'raw-block';artifacts.mkdir();sources=base/'sources';sources.mkdir();candidate={'testOnly':True};(sources/'block-candidate.json').write_text(json.dumps(candidate));h=hashlib.sha256(b'fixture').hexdigest()
                names=['cowork-hvf-block-worker','kernel','initramfs.cpio']
                for name in names:(artifacts/name).write_bytes(b'fixture')
                dependencies={name:h for name in run_block.LAUNCH_DEPENDENCIES}
                for name in dependencies:(sources/name).write_bytes(b'fixture')
                if omitted:del dependencies['reclaim_receipts.py']
                else:(sources/'reclaim_receipts.py').write_bytes(b'changed')
                (artifacts/'build.json').write_text(json.dumps({'candidate':candidate,'artifacts':{name:h for name in names},'fixtureSources':dependencies}))
                with patch.object(run_block,'OUT',base),patch.object(run_block,'ROOT',sources),patch.object(run_block.subprocess,'Popen') as popen,patch.object(sys,'argv',['run_block.py','--sandbox-check']):
                    with self.assertRaises(RuntimeError):run_block.main()
                    popen.assert_not_called()
    def test_actual_runner_skips_disk_reads_and_audit_on_unverified_exit(self):
        with tempfile.TemporaryDirectory(prefix='runner-uncertain-',dir=OUT) as directory:
            base=Path(directory);artifacts=base/'raw-block';artifacts.mkdir();sources=base/'sources';sources.mkdir();candidate={'testOnly':True};(sources/'block-candidate.json').write_text(json.dumps(candidate));h=hashlib.sha256(b'fixture').hexdigest()
            names=['cowork-hvf-block-worker','kernel','initramfs.cpio']
            for name in names:(artifacts/name).write_bytes(b'fixture')
            for name in run_block.LAUNCH_DEPENDENCIES:(sources/name).write_bytes(b'fixture')
            (artifacts/'build.json').write_text(json.dumps({'candidate':candidate,'artifacts':{name:h for name in names},'fixtureSources':{name:h for name in run_block.LAUNCH_DEPENDENCIES}}))
            original=run_block.digest
            def digest(path):
                if path.name=='fixture.raw':raise AssertionError('disk read after uncertain exit')
                return original(path)
            child=Unreapable()
            with patch.object(run_block,'OUT',base),patch.object(run_block,'ROOT',sources),patch.object(run_block,'processes',return_value=[]),patch.object(run_block,'digest',side_effect=digest),patch.object(run_block.subprocess,'run'),patch.object(run_block.subprocess,'Popen',return_value=child),patch.object(run_block,'disk_integrity',side_effect=AssertionError('disk audit after uncertain exit')),patch.object(run_block,'summary',side_effect=AssertionError('audit after uncertain exit')),patch.object(sys,'argv',['run_block.py','--sandbox-check']),redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit):run_block.main()
            receipt=json.loads(next(base.glob('raw-block-fixture-*/result.json')).read_text());self.assertTrue(receipt['terminationUncertain']);self.assertTrue(receipt['diskAuditSkipped']);self.assertIsNone(receipt['diskSha256']);self.assertFalse(receipt['ownedChildReaped']);self.assertEqual(child.waits,[2,3])
if __name__=='__main__':unittest.main()
