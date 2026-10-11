"""Config dependency gate tests; no compiler, VM, disk or keys."""
import tempfile,unittest
from pathlib import Path
from prepare_crypto import HERE,verify_config
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
if __name__=='__main__':unittest.main()
