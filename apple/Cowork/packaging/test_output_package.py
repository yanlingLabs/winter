import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,HERE/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
stager=module("output_stager","stage-output.py")
builder=module("output_builder","build-output.py")

class OutputPackageTests(unittest.TestCase):
    def fixture(self,root):
        source=root/"source";source.mkdir();artifact=source/stager.ARTIFACT;artifact.write_bytes(b"fixture-output")
        record={"schema":1,"protocolVersion":1,"implementationId":"winter-host-output/v1","artifact":stager.ARTIFACT,"artifactSha256":hashlib.sha256(artifact.read_bytes()).hexdigest()}
        (source/"manifest.json").write_text(json.dumps(record));return source
    def test_stager_uses_fixed_app_path_and_preserves_exact_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=self.fixture(root);resources=root/"Fixture.app/Contents/Resources"
            target=stager.stage(source,resources)
            self.assertEqual(target,resources/"native/host-output")
            self.assertEqual((target/stager.ARTIFACT).read_bytes(),b"fixture-output")
            self.assertEqual((target/"manifest.json").read_bytes(),(source/"manifest.json").read_bytes())
            with self.assertRaises(FileExistsError):stager.stage(source,resources)
    def test_tamper_or_nonbundle_destination_never_stages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=self.fixture(root)
            with self.assertRaises(ValueError):stager.stage(source,root/"arbitrary")
            (source/stager.ARTIFACT).write_bytes(b"changed")
            with self.assertRaises(ValueError):stager.stage(source,root/"Fixture.app/Contents/Resources")
    def test_source_identity_changes_if_shared_implementation_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in builder.FILES:(root/name).write_text(name)
            old,_=builder.source_identity(root)
            (root/"output_transport.c").write_text("changed")
            self.assertNotEqual(old,builder.source_identity(root)[0])
    def test_stager_refuses_manifest_and_artifact_aliases_before_creating_target(self):
        for name in (stager.ARTIFACT,"manifest.json"):
            for hardlink in (False,True):
                with tempfile.TemporaryDirectory() as tmp:
                    root=Path(tmp);source=self.fixture(root);outside=root/"outside"
                    (source/name).rename(outside)
                    if hardlink:os.link(outside,source/name)
                    else:(source/name).symlink_to(outside)
                    resources=root/"Fixture.app/Contents/Resources"
                    with self.assertRaises(ValueError):stager.stage(source,resources)
                    self.assertFalse((resources/stager.SUBPATH).exists())

if __name__=="__main__":unittest.main()
