"""Privileged isolated Linux fixture remains independently source/artifact gated.
Nonempty committed JBD2 transaction is constructed offline; not a real crash claim.
"""
import copy,hashlib,importlib.util,json,os,re,shutil,struct,subprocess,sys,tempfile,time,unittest,uuid
from pathlib import Path
from unittest.mock import patch, Mock
from types import SimpleNamespace
ROOT=Path(__file__).parent
def load(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bootstrap=load('bootstrap');replay=load('kernel_replay');build=load('build_kernel_replay')
class NoEffectTests(unittest.TestCase):
    def test_unknown_loop_number_refuses_without_device_open(self):
        for number in [-1,True,'0',65536]:
            with patch.object(replay.os,'open') as opened,self.assertRaises(replay.ReplayUncertain):replay.detached_loop(number)
            opened.assert_not_called()
    def test_detach_ack_requires_enxio_not_clr_success_or_any_other_error(self):
        identity=SimpleNamespace(st_mode=0o60600,st_rdev=os.makedev(7,3))
        for result in [None,OSError(16,'busy'),OSError(5,'io'),OSError(6,'gone')]:
            with patch.object(replay.os,'open',return_value=101),patch.object(replay.os,'close'),patch.object(replay.os,'fstat',return_value=identity),patch.object(replay.fcntl,'ioctl',side_effect=result):
                if isinstance(result,OSError) and result.errno==6:replay.detached_loop(3)
                else:
                    with self.assertRaises(replay.ReplayUncertain):replay.detached_loop(3)
    def test_timeout_keeps_owned_helper_and_descriptors_without_kill_or_detach(self):
        # Injected process only: tests retention, never Linux authority/actual admission.
        with tempfile.TemporaryDirectory() as directory:
            image=os.open(Path(directory)/'image',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
            artifact=os.open(Path(directory)/'artifact',os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600);os.write(artifact,b'fixture')
            port=replay.FixtureKernelReplay.__new__(replay.FixtureKernelReplay);port.artifact_fd=artifact;port.digest=hashlib.sha256(b'fixture').hexdigest()
            child=Mock();child.wait.side_effect=subprocess.TimeoutExpired('fixed-helper',1);before=len(replay.retained)
            try:
                with patch.object(replay.sys,'platform','linux'),patch.object(replay.os,'geteuid',return_value=0),patch.object(replay.subprocess,'Popen',return_value=child):
                    with self.assertRaisesRegex(replay.ReplayUncertain,'lifetime_retained'):port(image,{'expectedFilesystemUUID':str(uuid.uuid4()),'capacityBytes':16777216},time.monotonic()+1)
                self.assertEqual(len(replay.retained),before+1);record=replay.retained[-1];self.assertIs(record[0],child)
                os.fstat(record[1]);os.fstat(record[2]);child.kill.assert_not_called();child.terminate.assert_not_called()
            finally:
                for record in replay.retained[before:]:os.close(record[1]);os.close(record[2]);record[3].close();record[4].close()
                del replay.retained[before:];os.close(image);os.close(artifact)
    def test_dirty_plan_without_kernel_port_refuses_without_writable_helper(self):
        spec=importlib.util.spec_from_file_location('protocol',ROOT/'test_bootstrap.py');protocol=importlib.util.module_from_spec(spec);spec.loader.exec_module(protocol)
        with protocol.Pair() as pair:
            plan=copy.deepcopy(pair.plan)
            for target in plan['volumes']:target.update(action='replay-journal-then-probe',readyOperationId='old-ready')
            token=object();receiver=bootstrap.FixtureBootstrap(lambda p,t:p==plan and t is token)
            with patch.object(bootstrap.sys,'platform','linux'),patch.object(bootstrap,'probe',return_value=(bootstrap.EXT4_FEATURES,['needs_recovery'])),patch.object(bootstrap,'run_tool') as tools:
                with self.assertRaisesRegex(bootstrap.Refused,'kernel_replay_adapter_required'):receiver.execute(plan,pair.fds,token)
                with self.assertRaisesRegex(bootstrap.Refused,'one_shot_consumed'):receiver.execute(plan,pair.fds,token)
            tools.assert_not_called()

@unittest.skipUnless(sys.platform=='linux' and os.getenv('WINTER_RUN_KERNEL_REPLAY_FIXTURE')=='1','reviewed privileged Linux fixture only')
class KernelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:raise RuntimeError('Root python-I-S required')
        path=Path(os.environ['WINTER_KERNEL_REPLAY_RECEIPT']);cls.artifacts=path.parent;cls.receipt=build.validate(json.loads(path.read_text()),cls.artifacts)
    def setUp(self):
        # Manual retention; no TemporaryDirectory destructor can delete an uncertain backing file.
        self.directory=Path(tempfile.mkdtemp(prefix='winter-kernel-replay-'));self.confirmed=False;self.fds=[]
        self.path=self.directory/'data.ext4';self.fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_CLOEXEC,0o600);self.fds.append(self.fd);os.ftruncate(self.fd,64*1024*1024);identity=os.fstat(self.fd)
        self.target={'capacityBytes':identity.st_size,'expectedFilesystemUUID':str(uuid.uuid4())};self.deadline=time.monotonic()+60
        bootstrap.run_tool('mke2fs',['-q','-t','ext4','-b','4096','-I','256','-U',self.target['expectedFilesystemUUID'],'-O','none,'+','.join(bootstrap.EXT4_FEATURES),'-E','lazy_itable_init=1,lazy_journal_init=0,nodiscard','-F'],self.fd,self.deadline)
        staged=self.directory/'fixture-loop-replay';shutil.copyfile(self.artifacts/'fixture-loop-replay',staged);staged.chmod(0o555)
        artifact=os.open(staged,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW);self.port=replay.FixtureKernelReplay(artifact,self.receipt['artifacts']['fixture-loop-replay']);os.close(artifact)
    def tearDown(self):
        if self.confirmed:
            self.port.close()
            for fd in self.fds:os.close(fd)
            shutil.rmtree(self.directory)
        else:print(json.dumps({'fixtureRetained':True,'retentionId':self.directory.name,'cleanupConfirmed':False}),file=sys.stderr)
    def tool(self,args):return bootstrap.run_tool('debugfs',args,self.fd,self.deadline)[1]
    def committed_transaction(self):
        seed=self.directory/'seed';seed.write_bytes(b'original-data'+b'\0'*(4096-13));self.tool(['-w','-R',f'write {seed} /retained'])
        number=int(self.tool(['-R','bmap /retained 0']).strip());self.assertGreater(number,0)
        original=os.pread(self.fd,4096,number*4096);self.assertEqual(original,seed.read_bytes())
        payload=self.directory/'payload';payload.write_bytes(b'replayed-committed-data'+b'\0'*(4096-23))
        script=self.directory/'journal.commands';script.write_text(f'journal_open -c -v 3\njournal_write -b {number} {payload}\njournal_close\n')
        self.tool(['-w','-f',str(script)]);self.tool(['-w','-R','feature needs_recovery'])
        journal=int(self.tool(['-R','bmap <8> 0']).strip());jsb=os.pread(self.fd,4096,journal*4096)
        self.assertEqual(struct.unpack_from('>II',jsb), (0xc03b3998,4));self.assertGreater(struct.unpack_from('>I',jsb,0x1c)[0],0)
        # Require payload genuinely pending in the journal, not already checkpointed data.
        self.assertEqual(os.pread(self.fd,4096,number*4096),original)
        return number,payload.read_bytes(),journal
    def test_nonempty_committed_journal_replays_actual_data_and_fresh_clean_probe(self):
        number,payload,_=self.committed_transaction()
        self.assertEqual(self.port(self.fd,self.target,self.deadline),'kernel-mount');self.confirmed=True
        self.assertEqual(os.pread(self.fd,4096,number*4096),payload)
        features,transient=bootstrap.probe(self.fd,self.target,self.deadline,{'ext4Features':bootstrap.EXT4_FEATURES,'checkMode':'normal'})
        self.assertEqual(features,bootstrap.EXT4_FEATURES);self.assertEqual(transient,[])
    def test_corrupt_journal_refuses_without_claiming_unchanged_metadata(self):
        _,_,journal=self.committed_transaction();os.pwrite(self.fd,b'BAD!',journal*4096);os.fsync(self.fd)
        with self.assertRaises(replay.ReplayUncertain):self.port(self.fd,self.target,self.deadline)
        # No automatic retry/deletion. This keeps the failed fixture for recovery/audit,
        # even if the helper independently detached its loop before reporting failure.
if __name__=='__main__':unittest.main(verbosity=2)
