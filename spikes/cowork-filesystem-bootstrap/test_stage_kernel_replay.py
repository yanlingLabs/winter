"""No privilege/mount/process execution: trusted parent rejects bytes before imports."""
import hashlib,importlib.util,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('stage_noeffect',ROOT/'stage_kernel_replay.py');stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.source=self.root/'source';self.source.mkdir();self.artifacts=self.root/'artifacts';self.artifacts.mkdir()
        for name in stage.SOURCES:(self.source/name).write_bytes(b'raise AssertionError("MUST NEVER EXECUTE DURING ADMISSION")\n')
        for name in stage.ARTIFACTS:(self.artifacts/name).write_bytes(b'not executed')
        self.receipt={'formatVersion':1,'sources':{name:self.digest(self.source/name) for name in stage.SOURCES},'artifacts':{name:self.digest(self.artifacts/name) for name in stage.ARTIFACTS},'compiler':'fixture'};self.path=self.artifacts/'build.json';self.save()
    def digest(self,path):return hashlib.sha256(path.read_bytes()).hexdigest()
    def save(self):self.path.write_text(json.dumps(self.receipt));self.approved=self.digest(self.path)
    def tearDown(self):self.temp.cleanup()
    def test_capture_validates_entire_closure_without_executing_any_bytes(self):
        captured=stage.capture(self.source,self.artifacts,self.path,self.approved);self.assertEqual(set(captured),set((*stage.SOURCES,*stage.ARTIFACTS,'build.json')))
    def test_dynamic_test_bootstrap_is_mandatory_and_changed_bytes_refuse(self):
        del self.receipt['sources']['test_bootstrap.py'];self.save()
        with self.assertRaisesRegex(ValueError,'closed executable closure'):stage.capture(self.source,self.artifacts,self.path,self.approved)
    def test_each_covered_input_mutation_refuses_before_runner(self):
        for name in stage.SOURCES:
            target=self.source/name;original=target.read_bytes();target.write_bytes(b'changed malicious source')
            with self.assertRaisesRegex(ValueError,'review input changed'):stage.capture(self.source,self.artifacts,self.path,self.approved)
            target.write_bytes(original)
    def test_source_symlink_and_unapproved_receipt_refuse(self):
        target=self.source/'bootstrap.py';target.unlink();target.symlink_to(self.source/'kernel_replay.py')
        with self.assertRaises(OSError):stage.capture(self.source,self.artifacts,self.path,self.approved)
        with self.assertRaisesRegex(ValueError,'review input changed'):stage.capture(self.source,self.artifacts,self.path,'0'*64)
    def test_direct_privileged_mode_refuses_before_dynamic_repository_import(self):
        runner=self.source/'test_kernel_replay.py';runner.write_bytes((ROOT/'test_kernel_replay.py').read_bytes())
        marker=self.root/'executed-marker';(self.source/'test_bootstrap.py').write_text(f'from pathlib import Path\nPath({str(marker)!r}).write_text("executed")\n')
        result=subprocess.run([sys.executable,'-I','-S','-B',str(runner)],env={'PATH':os.environ.get('PATH',''),'WINTER_RUN_KERNEL_REPLAY_FIXTURE':'1'},capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0);self.assertIn('admitted immutable staged runner required before imports',result.stderr);self.assertFalse(marker.exists())
    def test_runner_not_started_when_staged_validation_refuses(self):
        with patch.object(stage,'verify_staged',side_effect=ValueError('stage changed')),patch.object(stage.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'stage changed'):stage.run_staged(self.source,self.approved)
        run.assert_not_called()
if __name__=='__main__':unittest.main(verbosity=2)
