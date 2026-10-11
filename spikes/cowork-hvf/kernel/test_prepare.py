"""Config dependency gate tests; no compiler, VM, disk or keys."""
import io,tarfile,tempfile,unittest
from pathlib import Path
from prepare_crypto import HERE,verify_config
from build_crypto import verify_extracted_archive
class ConfigGate(unittest.TestCase):
    def check(self,text):
        with tempfile.TemporaryDirectory(prefix='config-gate-',dir=HERE.parent/'out') as directory:
            path=Path(directory)/'.config';path.write_text(text);return verify_config(path)
    def test_all_requested_builtin_symbols(self):
        self.assertEqual(self.check((HERE/'crypto-candidate.fragment').read_text())['CONFIG_DM_CRYPT'],'y')
    def test_disabled_dm_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'CONFIG_MD'):
            self.check((HERE/'crypto-candidate.fragment').read_text().replace('CONFIG_MD=y','# CONFIG_MD is not set'))
    def test_modules_cannot_substitute_builtin_unlock(self):
        with self.assertRaisesRegex(RuntimeError,'CONFIG_DM_INTEGRITY'):
            self.check((HERE/'crypto-candidate.fragment').read_text().replace('CONFIG_DM_INTEGRITY=y','CONFIG_DM_INTEGRITY=m'))
    def test_actual_baseline_is_not_crypto_capable(self):
        with self.assertRaisesRegex(RuntimeError,'CONFIG_BLK_DEV_DM'):
            verify_config(HERE/'base-apple-6.18.35.config')
    def test_free_page_initialization_is_pinned(self):
        with self.assertRaisesRegex(RuntimeError,'CONFIG_INIT_ON_FREE_DEFAULT_ON'):
            self.check((HERE/'crypto-candidate.fragment').read_text().replace('CONFIG_INIT_ON_FREE_DEFAULT_ON=n','CONFIG_INIT_ON_FREE_DEFAULT_ON=y'))
    def test_page_poisoning_is_pinned(self):
        with self.assertRaisesRegex(RuntimeError,'CONFIG_PAGE_POISONING'):
            self.check((HERE/'crypto-candidate.fragment').read_text().replace('CONFIG_PAGE_POISONING=n','CONFIG_PAGE_POISONING=y'))
class ResumeInputs(unittest.TestCase):
    def fixture(self,directory):
        root=Path(directory)/'extracted';root.mkdir();archive=Path(directory)/'source.tar.xz'
        with tarfile.open(archive,'w:xz') as tar:
            directory_info=tarfile.TarInfo('src');directory_info.type=tarfile.DIRTYPE;tar.addfile(directory_info)
            file=tarfile.TarInfo('src/value');file.size=4;tar.addfile(file,io.BytesIO(b'good'))
            link=tarfile.TarInfo('src/link');link.type=tarfile.SYMTYPE;link.linkname='./value';tar.addfile(link)
            hardlink=tarfile.TarInfo('src/hardlink');hardlink.type=tarfile.LNKTYPE;hardlink.linkname='src/value';tar.addfile(hardlink)
        with tarfile.open(archive,'r:xz') as tar:tar.extractall(root,filter='data')
        return archive,root
    def test_data_filter_symlinks_and_hardlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,root=self.fixture(directory);verify_extracted_archive(archive,root)
    def test_modified_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,root=self.fixture(directory);(root/'src/value').write_bytes(b'evil')
            with self.assertRaisesRegex(RuntimeError,'checksum mismatch'):verify_extracted_archive(archive,root)
    def test_unexpected_input_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            archive,root=self.fixture(directory);(root/'src/injected').write_bytes(b'evil')
            with self.assertRaisesRegex(RuntimeError,'Unexpected extracted'):verify_extracted_archive(archive,root)
if __name__=='__main__':unittest.main()
