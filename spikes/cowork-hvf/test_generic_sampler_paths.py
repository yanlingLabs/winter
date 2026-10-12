"""No builds/workers/VM: sampler namespace routing cannot mutate the frozen artifact cache."""
import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import build_generic_fixture as builder
import run_generic_fixture as runner
from generic_fixture_paths import ARTIFACT_DIRECTORY,RUN_PREFIX

class SamplerPathsTests(unittest.TestCase):
    def test_runner_does_not_fall_back_to_existing_frozen_cache(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);frozen=out/'generic-fixture';frozen.mkdir();sentinel=frozen/'build.json';sentinel.write_bytes(b'frozen-821c-receipt')
            with patch.object(runner,'OUT',out),patch.object(sys,'argv',['fixture','--sandbox-check']),patch.object(runner.subprocess,'Popen') as launch:
                with self.assertRaises(FileNotFoundError):runner.main()
                launch.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'frozen-821c-receipt');self.assertEqual(sorted(p.name for p in out.iterdir()),['generic-fixture'])
    def test_receipt_writer_refuses_frozen_directory_before_reading_sources(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);frozen=out/'generic-fixture';frozen.mkdir();sentinel=frozen/'build.json';sentinel.write_bytes(b'frozen-821c-receipt')
            with patch.object(builder,'OUT',out),patch.object(builder,'digest',side_effect=AssertionError('must not hash old cache')):
                with self.assertRaisesRegex(RuntimeError,'cannot target frozen'):builder.write_receipt(frozen,None,False)
            self.assertEqual(sentinel.read_bytes(),b'frozen-821c-receipt')
    def test_receipt_only_routes_only_to_new_artifact_directory(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);frozen=out/'generic-fixture';frozen.mkdir();sentinel=frozen/'build.json';sentinel.write_bytes(b'frozen-821c-receipt')
            artifacts=out/ARTIFACT_DIRECTORY;artifacts.mkdir();root=out/'source';root.mkdir();(root/'runtime-port-trace-candidate.json').write_text('{}')
            dependencies=['generic_fixture_worker.c','generic_fixture_init.c','stream_frame_deadline.h','generic_port_discovery.h','generic_sampler.h']
            (artifacts/'build.json').write_text(json.dumps({'artifactDirectory':ARTIFACT_DIRECTORY,'hostSamplerTransport':'dedicated-inherited-pipe-v1','candidate':{},'artifacts':{},'fixtureSources':{n:'pin' for n in dependencies}}))
            verified=[];written=[]
            with patch.multiple(builder,OUT=out,ROOT=root,prepare=lambda:root,digest=lambda path:'pin',verify=lambda path,pin:verified.append(Path(path)),write_receipt=lambda path,*args:written.append(path)),patch.object(sys,'argv',['build','--receipt-only']):builder.main()
            self.assertEqual(written,[artifacts]);self.assertEqual(verified,[root/n for n in dependencies]);self.assertEqual(sentinel.read_bytes(),b'frozen-821c-receipt')
    def test_new_receipt_binds_directory_profile_and_shared_paths_dependency(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);artifacts=out/ARTIFACT_DIRECTORY;artifacts.mkdir();root=out/'source';root.mkdir();(root/'runtime-port-trace-candidate.json').write_text('{}')
            with patch.multiple(builder,OUT=out,ROOT=root,digest=lambda path:'synthetic-test-pin'),patch('builtins.print'):builder.write_receipt(artifacts,None,False)
            receipt=json.loads((artifacts/'build.json').read_text())
            self.assertEqual(receipt['artifactDirectory'],ARTIFACT_DIRECTORY);self.assertEqual(receipt['hostSamplerTransport'],'dedicated-inherited-pipe-v1')
            self.assertIn('generic_fixture_paths.py',receipt['fixtureSources']);self.assertIn('generic_fixture_paths.py',runner.LAUNCH_DEPENDENCIES)
            self.assertEqual(RUN_PREFIX,ARTIFACT_DIRECTORY+'-');self.assertFalse((out/'generic-fixture').exists())
    def test_receipt_only_cannot_promote_a_moved_legacy_artifact_receipt(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);artifacts=out/ARTIFACT_DIRECTORY;artifacts.mkdir();sentinel=artifacts/'build.json';sentinel.write_bytes(b'{"candidate":{},"artifacts":{}}')
            with patch.multiple(builder,OUT=out,prepare=lambda:out,digest=lambda path:'pin'),patch.object(sys,'argv',['build','--receipt-only']),patch.object(builder,'write_receipt') as write:
                with self.assertRaisesRegex(RuntimeError,'before receipt-only refresh'):builder.main()
                write.assert_not_called()
            self.assertEqual(sentinel.read_bytes(),b'{"candidate":{},"artifacts":{}}')

    def test_moved_old_directory_marker_is_refused_before_launch(self):
        with tempfile.TemporaryDirectory() as name:
            out=Path(name);artifacts=out/ARTIFACT_DIRECTORY;artifacts.mkdir();root=out/'source';root.mkdir();(root/'runtime-port-trace-candidate.json').write_text('{}')
            (artifacts/'build.json').write_text(json.dumps({'artifactDirectory':'generic-fixture','hostSamplerTransport':'dedicated-inherited-pipe-v1'}))
            with patch.multiple(runner,OUT=out,ROOT=root),patch.object(sys,'argv',['fixture','--sandbox-check']),patch.object(runner.subprocess,'Popen') as launch:
                with self.assertRaisesRegex(RuntimeError,'Dedicated sampler build required'):runner.main()
                launch.assert_not_called()

if __name__=='__main__':unittest.main()
