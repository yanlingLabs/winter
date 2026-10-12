"""No-VM FD bridge, disk oracle and exact-launch receipt regressions."""
import array,json,os,socket,struct,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from build import ROOT,digest
from workspace_fixture import ARTIFACT_DIRECTORY,CAPACITIES,SERIALS,RECORD,MAGIC,handoff_pair,disk_integrity,workspace_audit
from run_workspace_fixture import verify_build,verify_review
from build_workspace_fixture import SOURCES,IDENTITY
from generic_fixture_lifecycle import supervise
from generic_capture import Limits
from workspace_fixture import transfer_then_receive

class FixtureTests(unittest.TestCase):
    def disks(self,directory):
        paths=[];fds=[]
        for index,size in enumerate(CAPACITIES):
            path=directory/('disk'+str(index));fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);os.ftruncate(fd,size);paths.append(path);fds.append(fd)
        return paths,fds
    def test_actual_fixed_pair_frame_and_sender_fd_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,fds=self.disks(Path(tmp));left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);received=[]
            try:
                identities=handoff_pair(left,fds);body,ancillary,flags,_=right.recvmsg(73,socket.CMSG_SPACE(8))
                self.assertEqual(flags,0);self.assertEqual(RECORD.unpack(body),(MAGIC,1,*identities[0],*identities[1]));self.assertEqual(len(body),72)
                for level,kind,data in ancillary:
                    self.assertEqual((level,kind),(socket.SOL_SOCKET,socket.SCM_RIGHTS));received.extend(array.array('i',data))
                self.assertEqual(len(received),2)
                for index,fd in enumerate(received):self.assertEqual(os.fstat(fd).st_ino,os.fstat(fds[index]).st_ino)
            finally:
                for fd in received+fds:os.close(fd)
                left.close();right.close()
    def test_alias_reversed_capacity_and_readonly_handles_refuse_before_send(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,fds=self.disks(Path(tmp));left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);readonly=os.open(paths[0],os.O_RDONLY)
            try:
                for invalid in ([fds[0],fds[0]],list(reversed(fds)),[readonly,fds[1]],[fds[0]]):
                    with self.assertRaises(RuntimeError):handoff_pair(left,invalid)
                right.setblocking(False)
                with self.assertRaises(BlockingIOError):right.recv(1)
            finally:
                for fd in fds+[readonly]:os.close(fd)
                left.close();right.close()
    def complete_rows(self,count=17):return [{'kind':'guest_workspace_disk_complete','index':index,'serial':serial,'iterations':count,'reads':count,'writes':count,'flushes':(count+15)//16,'finalSync':True,'closed':True} for index,serial in enumerate(SERIALS)]
    def write_pattern(self,fd,index,count=17):
        for slot in range(16):
            last=count-1-((count-1-slot)%16)
            data=b''.join(struct.pack('<Q',0x6a39000000000000^(index<<48)^(last<<24)^word) for word in range(256*1024//8))
            os.pwrite(fd,data,index*4*1024*1024+slot*256*1024)
    def test_exact_per_disk_oracle_detects_data_corruption_and_cross_disk_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,fds=self.disks(Path(tmp));rows=self.complete_rows()
            try:
                for index,fd in enumerate(fds):self.write_pattern(fd,index);self.assertTrue(disk_integrity(paths[index],index,rows)['passed'])
                os.pwrite(fds[1],b'bad',4*1024*1024);self.assertFalse(disk_integrity(paths[1],1,rows)['passed'])
                os.pwrite(fds[0],b'bad',4*1024*1024);self.assertEqual(disk_integrity(paths[0],0,rows)['reason'],'unrelated disk extent changed')
                self.assertFalse(disk_integrity(paths[0],1,rows)['passed'])
            finally:
                for fd in fds:os.close(fd)
    def test_missing_duplicate_or_false_completion_never_audits_as_success(self):
        for rows in ([],self.complete_rows(0),self.complete_rows()+self.complete_rows(),[{**r,'finalSync':False} for r in self.complete_rows()]):self.assertFalse(disk_integrity(Path('/never-opened'),0,rows)['passed'])
    def test_environment_freeze_pin_never_satisfies_stream_device2_coverage(self):
        rows=[{'kind':'block_freeze_pin','device':1,'epoch':1,'ranges':[{'gpa':0,'len':4096}]}]
        result=workspace_audit(rows,{})
        self.assertIn('actual stream-device frozen pins absent',result['errors'])
        self.assertFalse(result['passed'])
        rows.extend([{'kind':'block_freeze_pin','device':2,'epoch':1,'ranges':[{'gpa':0,'len':4096}]},{'kind':'reclaim_exclusion','epoch':1,'gpa':0,'len':4096}])
        self.assertNotIn('actual stream-device frozen pins absent',workspace_audit(rows,{})['errors'])
    def test_unnamed_channel_required_before_descriptor_send(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths,fds=self.disks(Path(tmp));left=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);right=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
            try:
                left.bind(str(Path(tmp)/'left'));right.bind(str(Path(tmp)/'right'));left.connect(str(Path(tmp)/'right'));right.connect(str(Path(tmp)/'left'))
                with self.assertRaisesRegex(RuntimeError,'Unnamed'):handoff_pair(left,fds)
            finally:
                left.close();right.close()
                for fd in fds:os.close(fd)
    def test_exact_source_and_artifact_build_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);artifacts={}
            for name in ['libkrun.a','cowork-hvf-workspace-worker','init','initramfs.cpio','kernel']:
                (directory/name).write_bytes(name.encode());artifacts[name]=digest(directory/name)
            receipt={'schemaVersion':1,'artifactDirectory':ARTIFACT_DIRECTORY,'volumeHandoff':'unnamed-datagram-after-sandbox-v1','hostSamplerTransport':'dedicated-inherited-pipe-v1','runtimeAccessDevice':2,'volumeCapacities':list(CAPACITIES),'identity':IDENTITY,'candidate':json.loads((ROOT/'workspace-disks-candidate-v2.json').read_text()),'fixtureSources':{name:digest(ROOT/name) for name in SOURCES},'artifacts':artifacts,'nativeArchiveSha256':artifacts['libkrun.a']}
            (directory/'build.json').write_text(json.dumps(receipt));self.assertEqual(verify_build(directory),receipt)
            (directory/'kernel').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'Artifact changed'):verify_build(directory)
            receipt['fixtureSources']['workspace_fixture_worker.c']='0'*64;(directory/'build.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(RuntimeError,'Source changed'):verify_build(directory)
    def test_independent_admission_is_mode_build_and_quiescence_bound(self):
        for invalid in ({},{'accepted':True,'buildSha256':'other','scenario':'two-disk-normal','heavyCompileQuiescent':True},{'accepted':True,'buildSha256':'hash','scenario':'two-disk-normal'},{'accepted':True,'buildSha256':'hash','scenario':'two-disk-sandbox','heavyCompileQuiescent':True}):
            with self.assertRaises(RuntimeError):verify_review(invalid,'hash',True)
        verify_review({'accepted':True,'buildSha256':'hash','scenario':'two-disk-normal','heavyCompileQuiescent':True},'hash',True)
        verify_review({'accepted':True,'buildSha256':'hash','scenario':'two-disk-sandbox'},'hash',False)
    def test_handoff_failure_reaps_only_owned_nonvm_child_and_never_inherits_disk_fds(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory=Path(tmp);paths,fds=self.disks(directory);parent,worker=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);children=[]
            def spawn(*args,**kwargs):
                self.assertTrue(kwargs['close_fds']);self.assertFalse(set(fds)&set(kwargs['pass_fds']))
                child=subprocess.Popen(*args,**kwargs);children.append(child);return child
            try:
                _,capture,raw,_=supervise([sys.executable,'-c','import time;time.sleep(30)'],directory,False,parent,worker,popen_factory=spawn,receive_fn=transfer_then_receive((fds[0],fds[0])),limits=Limits(normal_wait_seconds=.1,kill_wait_seconds=.5,reader_join_seconds=.2))
                self.assertEqual(len(children),1);self.assertIsNotNone(children[0].poll());self.assertTrue(capture['killIssued']);self.assertTrue(capture['ownedChildReaped']);self.assertTrue(capture['samplerClosed']);self.assertIn('Distinct',capture['lifecycleError']);self.assertIsNone(raw)
                self.assertEqual(parent.fileno(),-1);self.assertEqual(worker.fileno(),-1)
                for fd in fds:os.fstat(fd) # Sender ownership survives refusal.
            finally:
                for fd in fds:os.close(fd)
    def test_runner_never_audits_disk_or_raw_bytes_with_uncertain_owners(self):
        import run_workspace_fixture as runner
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp);artifacts=out/runner.ARTIFACT_DIRECTORY;artifacts.mkdir()
            for name in ['cowork-hvf-workspace-worker','kernel','initramfs.cpio']:(artifacts/name).write_bytes(b'fixture')
            review=out/'review.json';review.write_text('{}')
            capture={'ownersQuiescent':False,'exitVerified':False,'captureComplete':False,'lifecycleError':'injected','exitCode':None,'timedOut':False}
            def lifecycle(command,directory,run,parent,worker,**kwargs):parent.close();worker.close();return [],capture,None,None
            def digest(path):
                if path.suffix in ('.raw','.bin'):raise AssertionError('uncertain disk/raw inspection')
                return 'hash'
            signature=type('Signature',(),{'stderr':'Identifier='+IDENTITY+'\n'})()
            with patch.multiple(runner,OUT=out,verify_build=lambda p:{'candidate':{}},verify_review=lambda *a:None,verify_signed_worker=lambda p:{},processes=lambda:[],supervise=lifecycle,digest=digest),patch.object(runner.subprocess,'run',return_value=signature),patch.object(sys,'argv',['fixture','--sandbox-check','--review-receipt',str(review)]):
                with self.assertRaises(SystemExit) as failure:runner.main()
            self.assertEqual(failure.exception.code,1);result=json.loads(next(out.glob(runner.RUN_PREFIX+'*/result.json')).read_text());self.assertTrue(result['diskAuditSkipped']);self.assertNotIn('diskSha256',result);self.assertFalse(result['passed'])
if __name__=='__main__':unittest.main()
