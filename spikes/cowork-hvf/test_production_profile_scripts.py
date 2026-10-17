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

    def test_device_attach_calls_are_found_in_any_non_test_file(self):
        patch = 'diff --git a/src/vmm/src/builder.rs b/src/vmm/src/builder.rs\n--- a/src/vmm/src/builder.rs\n+++ b/src/vmm/src/builder.rs\n@@ -1 +1,2 @@\n x\n+    attach_gpio_device(&mut vmm, intc.clone())?;\n'
        self.assertTrue(prep.scope_findings('p', patch, ['src/vmm/src/builder.rs'], [], ['attach_'], []))
        self.assertEqual(prep.scope_findings('p', patch, ['src/vmm/src/builder.rs'], [], ['attach_'], [r'src/vmm/src/builder\.rs']), [])

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

    def test_string_literals_are_not_calls(self):
        source = self.tree('#[test]\nfn a() {\n    let at = builder.find("pub fn build_microvm(");\n    let b = \"krun_start_enter(\";\n}\n')
        self.assertEqual(prep.unignored_vm_reaching_tests(source), [])
        source = self.tree('#[test]\nfn a() {\n    HvfGicV3::new(1);\n    let n = krun_get_max_vcpus();\n}\n')
        self.assertEqual(len(prep.unignored_vm_reaching_tests(source)), 2)

    def test_widened_hvf_and_query_calls_are_found(self):
        for call in ['hv_vm_get_max_vcpu_count(&mut n);', 'HvfGicV3::new(2);', 'krun_check_nested_virt();', 'krun_get_max_vcpus();', 'HvfVcpu::create();']:
            with self.subTest(call=call):
                self.assertEqual(len(prep.unignored_vm_reaching_tests(self.tree('#[test]\nfn a() {\n    ' + call + '\n}\n'))), 1)

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


class ReproRoot(unittest.TestCase):
    def setUp(self):
        import build_production_profile as build
        self.build = build
        self.source = ROOT / 'out/libkrun-production-profile'

    def test_a_non_empty_directory_is_refused_and_survives(self):
        with tempfile.TemporaryDirectory() as directory:
            keep = Path(directory) / 'keep.txt'
            keep.write_text('x')
            with self.assertRaises(RuntimeError):
                self.build.check_repro_root(directory, self.source)
            self.assertTrue(keep.exists())

    def test_protected_directories_are_refused(self):
        for path in [Path('/'), Path.home(), ROOT, ROOT.parent, OUT, self.source, self.source / 'src']:
            with self.subTest(path=path):
                with self.assertRaises(RuntimeError):
                    self.build.check_repro_root(path, self.source)

    def test_the_protected_clause_refuses_on_its_own(self):
        """The non-empty clause must not be what stops these: the protected directory is empty, or does not exist
        yet, so only the protected-directory clause can refuse it."""
        with tempfile.TemporaryDirectory() as directory:
            fake_source = Path(directory) / 'source'
            fake_source.mkdir()
            self.assertEqual(list(fake_source.iterdir()), [])
            with self.assertRaises(RuntimeError) as empty:
                self.build.check_repro_root(fake_source, fake_source)
            self.assertIn('protected', str(empty.exception))
            self.assertTrue(fake_source.is_dir())
            # A directory that does not exist yet but lies inside the source, and one that is the source's parent.
            with self.assertRaises(RuntimeError) as inside:
                self.build.check_repro_root(fake_source / 'repro', fake_source)
            self.assertIn('protected', str(inside.exception))
            with self.assertRaises(RuntimeError) as parent:
                self.build.check_repro_root(Path(directory), fake_source)
            self.assertIn('protected', str(parent.exception))
            # The same paths with a different source are accepted, so the refusals above came from the source.
            other = Path(directory) / 'other'
            other.mkdir()
            self.assertEqual(self.build.check_repro_root(fake_source, other), fake_source.absolute())

    def test_a_new_or_empty_directory_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.build.check_repro_root(directory, self.source), Path(directory).absolute())
            self.assertEqual(self.build.check_repro_root(Path(directory) / 'fresh', self.source), (Path(directory) / 'fresh').absolute())

    def test_a_missing_parent_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError):
                self.build.check_repro_root(Path(directory) / 'a' / 'b', self.source)


class Candidate(unittest.TestCase):
    def setUp(self):
        self.pin = json.loads((ROOT / 'production-profile-candidate.json').read_text())

    def test_every_pinned_patch_hash_matches_its_file(self):
        import hashlib
        for patch in self.pin['basePatches'] + self.pin['newPatches']:
            self.assertEqual(hashlib.sha256((ROOT / patch['patchFile']).read_bytes()).hexdigest(), patch['patchSha256'], patch['patchFile'])

    def test_queue_is_contiguous_and_the_new_patches_are_14_to_23(self):
        numbers = [int(Path(p['patchFile']).name[:4]) for p in self.pin['basePatches'] + self.pin['newPatches']]
        self.assertEqual(numbers, list(range(4, 24)))
        self.assertEqual([int(Path(p['patchFile']).name[:4]) for p in self.pin['newPatches']], list(range(14, 24)))

    def test_declared_scope_equals_the_files_each_patch_touches(self):
        for entry in self.pin['newPatches']:
            text = (ROOT / entry['patchFile']).read_text()
            self.assertEqual(sorted(set(re.findall(r'^diff --git a/(\S+) b/', text, re.M))), sorted(entry['allowedFiles']), entry['patchFile'])

    def test_the_device_set_files_change_only_where_declared_and_never_attach_a_device(self):
        # builder.rs (the device attach sequence), hvf and the block device change only in the exit-path patches (22, 23), which
        # registers observers and adds a PSCI reset variant; nothing touches the device manager or the arch layer.
        only_exit_path = {'src/vmm/src/builder.rs', 'src/hvf/src/lib.rs', 'src/devices/src/virtio/block/device.rs'}
        for entry in self.pin['newPatches']:
            number = int(Path(entry['patchFile']).name[:4])
            for name in entry['allowedFiles']:
                self.assertFalse(name.startswith(('src/vmm/src/device_manager/', 'src/arch/')), name)
                if name in only_exit_path:
                    self.assertIn(number, (22, 23), name)
            text = (ROOT / entry['patchFile']).read_text()
            self.assertEqual(prep.scope_findings(entry['patchFile'], text, entry['allowedFiles'], self.pin['forbiddenAddedText'], self.pin['deviceForbiddenAddedText'], self.pin['deviceForbiddenExemptFiles']), [])

    def test_the_canonical_v1_names_are_the_production_surface(self):
        header = (HERE / 'production_profile_tests.rs').read_text()
        for name in ['krun_cowork_enable_profile_v1', 'krun_cowork_set_workspace_disks_v1', 'krun_cowork_create_runtime_port_v1', 'krun_cowork_validate_profile_v1', 'krun_cowork_get_flush_counters_v1', 'krun_cowork_set_exit_hook_v1']:
            self.assertIn(f'"{name}"', header)
        self.assertEqual(sorted(n[1:] for n in lib.PRODUCTION_EXPORTS), sorted(n for n in [
            'krun_cowork_enable_profile_v1', 'krun_cowork_set_workspace_disks_v1', 'krun_cowork_create_runtime_port_v1', 'krun_cowork_validate_profile_v1',
            'krun_cowork_get_flush_counters_v1', 'krun_cowork_set_exit_hook_v1', 'krun_cowork_get_pin_counters_v1']))
        self.assertTrue(all(n.endswith('_v1') for n in lib.PRODUCTION_EXPORTS))
        self.assertEqual(self.pin['features']['production'], 'blk,cowork-production-only')

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
