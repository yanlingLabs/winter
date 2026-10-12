"""Integrity/mode validation tests; no Docker, keys, disks or crypto operations."""
import hashlib,tempfile,unittest
from pathlib import Path
from verify_toolset import verify_files

class ImmutableFiles(unittest.TestCase):
    def fixture(self,directory):
        root=Path(directory);path=root/'fixture';path.write_bytes(b'public-fixture');path.chmod(0o444)
        manifest={'fixture':{'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,'mode':'0444'}}
        return root,path,manifest
    def test_expected_file_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root,path,manifest=self.fixture(directory);verify_files(root,manifest)
    def test_modified_content_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root,path,manifest=self.fixture(directory);path.chmod(0o644);path.write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError,'file mismatch'):verify_files(root,manifest)
    def test_mutable_mode_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root,path,manifest=self.fixture(directory);path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError,'mode mismatch'):verify_files(root,manifest)
if __name__=='__main__':unittest.main()
