"""Pure-Python checks of the production-profile scripts and pins. No cargo, no VM, no network.

Run: python3 -I -B spikes/cowork-hvf/test_production_profile_scripts.py
These cover the guards that live in Python (the path scan that mirrors the release name scan, the
patch scope pin, the no-VM test audit, the release recipe, the candidate and its documentation); the
Rust guards are covered by the libkrun tests and mutation-checked separately.
"""
import json, os, re, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))

from build import ROOT, OUT  # noqa: E402
import prepare_production_profile as prep  # noqa: E402
import production_profile_lib as lib  # noqa: E402


class PathScan(unittest.TestCase):
    def test_builder_paths_are_found(self):
        for planted in [b'/Users/someone/work/libkrun/src/lib.rs', b'/private/tmp/build-1/target', b'/var/folders/ab/cd/T/x', b'/Volumes/Data/src', b'/home/builder/.cargo', b'/Applications/Xcode_15.4.app/Contents/Developer']:
            with self.subTest(planted=planted):
                self.assertTrue(lib.path_findings(b'\x00\x01noise ' + planted + b' more\x00'))

    def test_virtual_and_system_paths_are_allowed(self):
        clean = b'/libkrun/src/vmm/src/lib.rs\x00/cargo-home/registry/src/index.crates.io-1949cf8c6b5b557f/x-1.0.0/src/lib.rs\x00/rustc/1159e78c4747b02ef996e55082b704c09b970588/library/core/src/lib.rs\x00/System/Library/Frameworks/Hypervisor.framework/Versions/A/Hypervisor\x00/usr/lib/libSystem.B.dylib\x00'
        self.assertEqual(lib.path_findings(clean), [])

    def test_trace_row_scan(self):
        self.assertEqual(lib.trace_rows_in(b'xx block_request_capture yy'), ['block_request_capture'])
        self.assertEqual(lib.trace_rows_in(b'nothing here'), [])


class ScopePin(unittest.TestCase):
    PATCH = 'diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1,2 @@\n x\n+{}\n'

    def test_declared_scope_passes(self):
        self.assertEqual(prep.scope_findings('p', self.PATCH.format('let y = 1;'), ['src/a.rs'], ['register_mmio_gpio(']), [])

    def test_file_outside_scope_is_found(self):
        self.assertTrue(prep.scope_findings('p', self.PATCH.format('let y = 1;'), ['src/b.rs'], []))

    def test_gpio_and_device_attach_are_found(self):
        self.assertTrue(prep.scope_findings('p', self.PATCH.format('vmm.register_mmio_gpio(vm, intc, em, efd);'), ['src/a.rs'], ['register_mmio_gpio(']))
        self.assertTrue(prep.scope_findings('p', self.PATCH.format('attach_mmio_device(&mut vmm, id, intc, dev);'), ['src/a.rs'], ['attach_mmio_device(&mut ']))

    def test_comment_mentioning_the_gpio_is_not_code(self):
        pin = json.loads((ROOT / 'production-profile-candidate.json').read_text())
        self.assertNotIn('GPIO', ' '.join(pin['forbiddenAddedText']))


class VmReachAudit(unittest.TestCase):
    def tree(self, body):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / 'src/x/tests.rs'
        path.parent.mkdir(parents=True)
        path.write_text(body)
        return Path(directory.name)

    def test_unignored_start_and_vm_creation_are_found(self):
        source = self.tree('#[test]\nfn a() {\n    krun_start_enter(1);\n}\n#[test]\nfn b() {\n    let vm = Vm::new(&mut m, false);\n}\n')
        self.assertEqual(len(prep.unignored_vm_reaching_tests(source)), 2)

    def test_ignored_tests_comments_and_production_code_are_not_flagged(self):
        source = self.tree('#[test]\n#[ignore = "creates a Hypervisor.framework VM (hv_vm_create)"]\nfn a() {\n    krun_start_enter(1);\n}\n// krun_start_enter(2);\nfn production() {\n    krun_start_enter(3);\n}\n')
        self.assertEqual(prep.unignored_vm_reaching_tests(source), [])

    def test_one_line_test_style_is_understood(self):
        source = self.tree(' #[test]fn a(){ assert_eq!(krun_start_enter(id),1); }\n #[test]#[ignore = "x"]fn b(){ assert_eq!(krun_start_enter(id),1); }\n')
        self.assertEqual(len(prep.unignored_vm_reaching_tests(source)), 1)


class ReleaseRecipe(unittest.TestCase):
    def test_remaps_are_fixed_virtual_roots_and_survive_spaces(self):
        env = lib.release_env(Path('/a b/src'), Path('/a b/out'), Path('/a b/t'))
        flags = env['CARGO_ENCODED_RUSTFLAGS'].split('\x1f')
        self.assertEqual(flags, ['--remap-path-prefix=/a b/src=/libkrun', '--remap-path-prefix=/a b/out/cargo-home=/cargo-home', '--remap-path-prefix=/a b/out/rust=/rust-toolchain'])
        self.assertNotIn('RUSTFLAGS', env)
        self.assertEqual(env['CARGO_NET_OFFLINE'], 'true')
        self.assertEqual(env['CARGO_PROFILE_RELEASE_DEBUG'], '0')
        self.assertEqual(env['CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS'], 'true')

    def test_normalizer_replaces_longest_prefix_first(self):
        norm = lib.normalizer(('/home/u', '<HOME>'), ('/home/u/work/tree', '<WORKTREE>'))
        self.assertEqual(norm('/home/u/work/tree/x and /home/u/y'), '<WORKTREE>/x and <HOME>/y')


class Candidate(unittest.TestCase):
    def setUp(self):
        self.pin = json.loads((ROOT / 'production-profile-candidate.json').read_text())

    def test_every_pinned_patch_hash_matches_its_file(self):
        import hashlib
        for patch in self.pin['basePatches'] + self.pin['newPatches']:
            self.assertEqual(hashlib.sha256((ROOT / patch['patchFile']).read_bytes()).hexdigest(), patch['patchSha256'], patch['patchFile'])

    def test_queue_is_contiguous_and_the_new_patches_are_14_to_16(self):
        numbers = [int(Path(p['patchFile']).name[:4]) for p in self.pin['basePatches'] + self.pin['newPatches']]
        self.assertEqual(numbers, list(range(4, 17)))
        self.assertEqual([int(Path(p['patchFile']).name[:4]) for p in self.pin['newPatches']], [14, 15, 16])

    def test_declared_scope_equals_the_files_each_patch_touches(self):
        for entry in self.pin['newPatches']:
            text = (ROOT / entry['patchFile']).read_text()
            self.assertEqual(sorted(set(re.findall(r'^diff --git a/(\S+) b/', text, re.M))), sorted(entry['allowedFiles']), entry['patchFile'])

    def test_no_new_patch_touches_the_device_set(self):
        for entry in self.pin['newPatches']:
            for name in entry['allowedFiles']:
                self.assertFalse(name.startswith(('src/vmm/src/builder.rs', 'src/vmm/src/device_manager/', 'src/hvf/', 'src/arch/')) or ('src/devices/src/' in name and name != 'src/devices/src/block_trace.rs'), name)

    def test_limits_match_the_header_the_patch_adds(self):
        text = (ROOT / 'patches/0015-proposed-cowork-production-profile.patch').read_text()
        for name, key in [('KRUN_COWORK_PRODUCTION_VCPUS', 'vcpus'), ('KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB', 'minMemoryMiB'), ('KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB', 'maxMemoryMiB')]:
            self.assertEqual(int(re.search(rf'^\+#define {name} (\d+)$', text, re.M).group(1)), self.pin['limits'][key])

    def test_admitted_inventory_is_recorded_unchanged(self):
        self.assertEqual(self.pin['deviceInventory'], {'virtioIds': [2, 2, 3, 4, 5], 'maxDevices': 3, 'maxPins': 48, 'maxPinnedBytes': 8388608, 'shutdownGpio': False})

    def test_honest_status_flags(self):
        for flag in ['productionReady', 'vmStarted', 'workerBuilt', 'fullResourceGatePassed']:
            self.assertIs(self.pin[flag], False)

    def test_mirrors_exist_and_are_not_the_stale_trace_copy(self):
        for local in list(self.pin['moduleCorrespondence']) + list(self.pin['inheritedCore']):
            self.assertTrue((ROOT / local).exists(), local)
        self.assertNotIn('block_trace.rs', self.pin['inheritedCore'])

    def test_api_inventory_records_the_production_exports(self):
        inventory = json.loads((ROOT / 'api-inventory.json').read_text())
        block = inventory['productionProfile']
        self.assertEqual(block['productionExports'], [n[1:] for n in lib.PRODUCTION_EXPORTS])
        self.assertEqual(block['fixtureSymbolsExportedByProduction'], [])
        self.assertEqual(block['blockTraceRowStringsInProduction'], [])
        self.assertEqual(sorted(block['fixtureOracleOnlyExports']), sorted(n[1:] for n in lib.FIXTURE_EXPORTS))
        self.assertIs(inventory['runtimeReclaimControlExport'], False)

    def test_scripts_never_call_the_start_path(self):
        for name in ['prepare_production_profile.py', 'test_production_profile.py', 'build_production_profile.py', 'record_production_evidence.py', 'production_profile_lib.py']:
            text = (HERE / name).read_text()
            self.assertNotIn('run_fixture', text)
            self.assertNotIn('--sandbox-check', text)
            self.assertNotIn('krun_start_enter(', text.replace('never calls krun_start_enter', ''), name)
        probe = (HERE / 'workspace_disks_production_abi_smoke.c').read_text()
        self.assertEqual([l for l in probe.splitlines() if 'krun_start_enter(' in l], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
