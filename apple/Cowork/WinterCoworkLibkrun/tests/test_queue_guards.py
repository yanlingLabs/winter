"""Pure-Python guards of the libkrun production-profile queue and its scripts. No network, no cargo, no VM.

Run: python3 -I -B apple/Cowork/WinterCoworkLibkrun/tests/test_queue_guards.py
They cover the pins and their structure, every hash the README states, the patch scope and the no-device rule, the
no-VM test audit, the release recipe, the --repro-root guard, the export list and the exit-reason values, public
hygiene (no home or builder paths in anything committed here), and that nothing in the repository wires this
directory in. One test composes the queue onto the pristine tree and compares the full-diff hash when a pristine
checkout exists (out/libkrun from fetch_inputs.py, or LIBKRUN_PRISTINE); otherwise it is skipped.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'scripts'))

from libkrun_common import OUT  # noqa: E402
import prepare_queue as prep  # noqa: E402
import libkrun_common as lib  # noqa: E402


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
        pin = json.loads((ROOT / 'patch-queue.json').read_text())
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
        import build_archive as build
        self.build = build
        self.source = OUT / 'source'

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



def patch_files():
    return {p.name: p for p in sorted((ROOT / 'patches').glob('*.patch'))}


def added_text(*numbers):
    """Concatenated added lines of the patches with these numbers."""
    out = []
    for name, path in patch_files().items():
        if int(name[:4]) in numbers:
            out += [l[1:] for l in path.read_text().splitlines() if l.startswith('+') and not l.startswith('+++')]
    return '\n'.join(out)


SHA = re.compile(r'[0-9a-f]{64}')


class Pins(unittest.TestCase):
    def setUp(self):
        self.up = json.loads((ROOT / 'upstream-pin.json').read_text())
        self.queue = json.loads((ROOT / 'patch-queue.json').read_text())
        self.expected = json.loads((ROOT / 'expected-hashes.json').read_text())

    def test_the_upstream_pin_is_exact(self):
        k, r = self.up['libkrun'], self.up['rust']
        self.assertEqual(k['version'], '1.19.6')
        self.assertRegex(k['revision'], r'^[0-9a-f]{40}$')
        self.assertRegex(k['treeSha1'], r'^[0-9a-f]{40}$')
        self.assertTrue(k['archiveUrl'].endswith(k['revision']))
        self.assertRegex(k['archiveSha256'], SHA.pattern)
        self.assertRegex(k['lockSha256'], SHA.pattern)
        self.assertIs(k['defaultFeatures'], False)
        self.assertRegex(r['commitHash'], r'^[0-9a-f]{40}$')
        self.assertRegex(r['sha256'], SHA.pattern)
        self.assertIn(r['version'], r['url'])
        self.assertEqual(r['host'], 'aarch64-apple-darwin')

    def test_the_queue_is_contiguous_and_every_hash_matches_its_file(self):
        entries = self.queue['basePatches'] + self.queue['newPatches']
        numbers = [int(Path(p['patchFile']).name[:4]) for p in entries]
        self.assertEqual(numbers, list(range(4, 26)))
        self.assertEqual([int(Path(p['patchFile']).name[:4]) for p in self.queue['newPatches']], list(range(14, 26)))
        for entry in entries:
            path = ROOT / entry['patchFile']
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry['patchSha256'], entry['patchFile'])
            self.assertTrue(path.read_text().startswith('diff --git '), entry['patchFile'])
        self.assertEqual(sorted(p.name for p in (ROOT / 'patches').glob('*')), sorted(Path(p['patchFile']).name for p in entries), 'no stray or missing patch file')

    def test_declared_scope_equals_the_files_each_production_patch_touches(self):
        for entry in self.queue['newPatches']:
            text = (ROOT / entry['patchFile']).read_text()
            self.assertEqual(sorted(set(re.findall(r'^diff --git a/(\S+) b/', text, re.M))), sorted(entry['allowedFiles']), entry['patchFile'])

    def test_production_patches_add_no_device_and_touch_the_attach_sequence_only_where_declared(self):
        only_exit_path = {'src/vmm/src/builder.rs', 'src/hvf/src/lib.rs', 'src/devices/src/virtio/block/device.rs'}
        for entry in self.queue['newPatches']:
            number = int(Path(entry['patchFile']).name[:4])
            for name in entry['allowedFiles']:
                self.assertFalse(name.startswith(('src/vmm/src/device_manager/', 'src/arch/')), name)
                if name in only_exit_path:
                    # 0025 (the share devices) sizes the reclaim budget and builds a share's fs device in the
                    # builder; it adds no attach call (the device-forbidden scan below).
                    self.assertIn(number, (22, 23, 25) if name == 'src/vmm/src/builder.rs' else (22, 23), name)
            text = (ROOT / entry['patchFile']).read_text()
            self.assertEqual(prep.scope_findings(entry['patchFile'], text, entry['allowedFiles'], self.queue['forbiddenAddedText'], self.queue['deviceForbiddenAddedText'], self.queue['deviceForbiddenExemptFiles']), [])

    def test_the_allowlisted_added_files_are_real_new_files_of_the_queue(self):
        created = set()
        for entry in self.queue['basePatches'] + self.queue['newPatches']:
            created |= set(re.findall(r'^diff --git a/\S+ b/(\S+)\nnew file mode', (ROOT / entry['patchFile']).read_text(), re.M))
        self.assertEqual(sorted(created), sorted(self.queue['allAddedFiles']))

    def test_limits_inventory_and_honest_status_flags(self):
        text = (ROOT / 'patches/0015-proposed-cowork-production-profile.patch').read_text()
        for name, key in [('KRUN_COWORK_PRODUCTION_VCPUS', 'vcpus'), ('KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB', 'minMemoryMiB'), ('KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB', 'maxMemoryMiB')]:
            self.assertEqual(int(re.search(rf'^\+#define {name} (\d+)$', text, re.M).group(1)), self.queue['limits'][key])
        self.assertEqual(self.queue['deviceInventory'], {'virtioIds': [2, 2, 3, 4, 5], 'maxDevices': 3, 'maxPins': 48, 'maxPinnedBytes': 8388608, 'shutdownGpio': False,
                                                         'maxShares': 12, 'shareVirtioId': 26, 'maxDevicesPerShare': 1, 'pinsPerShare': 4, 'pinnedBytesPerShare': 1114136})
        for flag in ['productionReady', 'vmStarted', 'workerBuilt', 'fullResourceGatePassed']:
            self.assertIs(self.queue[flag], False)
        self.assertEqual(self.queue['features'], {'production': 'blk,cowork-production-only', 'oracle': 'blk,cowork-fixture-oracle'})
        self.assertEqual(self.expected['productionArchive']['features'], self.queue['features']['production'])


class Exports(unittest.TestCase):
    def setUp(self):
        self.expected = json.loads((ROOT / 'expected-hashes.json').read_text())

    def test_hashes_are_well_formed_and_distinct(self):
        a = self.expected['productionArchive']
        values = [self.expected['composedSourceDiffSha256'], a['rawSha256'], a['strippedSha256']]
        for value in values:
            self.assertRegex(value, SHA.pattern)
        self.assertEqual(len(set(values)), 3)

    def test_62_upstream_and_10_canonical_v1_exports_and_no_fixture_symbol(self):
        e = self.expected['exports']
        self.assertEqual((len(e['upstream']), len(e['cowork']), e['totalCount']), (62, 10, 72))
        self.assertEqual((e['upstreamCount'], e['coworkCount']), (62, 10))
        for names in (e['upstream'], e['cowork']):
            self.assertEqual(names, sorted(set(names)))
            self.assertTrue(all(n.startswith('krun_') for n in names))
        self.assertFalse(any('cowork' in n or 'fixture' in n for n in e['upstream']))
        self.assertTrue(all(n.startswith('krun_cowork_') and n.endswith('_v1') for n in e['cowork']))
        self.assertEqual(e['cowork'], sorted(n[1:] for n in lib.PRODUCTION_EXPORTS))
        self.assertFalse(set(e['cowork'] + e['upstream']) & {n[1:] for n in lib.FIXTURE_EXPORTS})

    def test_each_production_export_is_declared_by_the_queue_header(self):
        header = added_text(15, 17, 19, 21, 22, 25)
        declared = set(re.findall(r'\b(krun_cowork_\w+_v1)\(', header))
        self.assertEqual(declared, set(self.expected['exports']['cowork']))

    def test_exit_reasons_flush_counter_struct_and_hook_type_are_the_agreed_abi(self):
        header = added_text(22, 21)
        for name, value in [('NONE', 0), ('OFF', 1), ('RESET', 2), ('VCPU_ERROR', 3), ('TERMINAL_FAULT', 4)]:
            self.assertRegex(header, rf'#define KRUN_COWORK_EXIT_{name} {value}\b')
        self.assertIn('typedef void (*krun_cowork_exit_hook_v1)(void *user_data, uint32_t reason);', header)
        self.assertIn('int32_t krun_cowork_get_flush_counters_v1(struct krun_cowork_flush_counters_v1 *out);', header)
        for field in ['uint32_t size;', 'uint32_t device_count;', 'struct krun_cowork_flush_device_v1 device[2];', 'uint64_t requested;', 'uint64_t completed;', 'uint64_t final_sync_attempted;', 'uint64_t final_sync_completed;']:
            self.assertIn(field, header)


class Readme(unittest.TestCase):
    """Every hash and ABI value the README states is the pinned one."""

    def setUp(self):
        self.text = (ROOT / 'README.md').read_text()
        self.queue = json.loads((ROOT / 'patch-queue.json').read_text())
        self.expected = json.loads((ROOT / 'expected-hashes.json').read_text())
        self.up = json.loads((ROOT / 'upstream-pin.json').read_text())

    def test_upstream_and_archive_hashes_in_the_pin_table(self):
        a = self.expected['productionArchive']
        for value in [self.expected['composedSourceDiffSha256'], a['rawSha256'], a['strippedSha256'], self.up['libkrun']['archiveSha256'], self.up['libkrun']['lockSha256'], self.up['libkrun']['treeSha1'], self.up['libkrun']['revision'], self.up['rust']['sha256'], self.up['rust']['commitHash']]:
            self.assertEqual(self.text.count(value) >= 1, True, value)

    def test_every_sha256_in_the_readme_is_a_pinned_value(self):
        known = {p['patchSha256'] for p in self.queue['basePatches'] + self.queue['newPatches']}
        a = self.expected['productionArchive']
        known |= {self.expected['composedSourceDiffSha256'], a['rawSha256'], a['strippedSha256'], self.up['libkrun']['archiveSha256'], self.up['libkrun']['lockSha256'], self.up['rust']['sha256']}
        for value in set(SHA.findall(self.text)):
            self.assertIn(value, known)

    def test_every_patch_row_carries_its_pinned_hash(self):
        for entry in self.queue['basePatches'] + self.queue['newPatches']:
            name = Path(entry['patchFile']).name
            rows = [l for l in self.text.splitlines() if l.startswith(f'| `{name}`')]
            self.assertEqual(len(rows), 1, name)
            self.assertIn(entry['patchSha256'], rows[0], name)

    def test_the_readme_names_the_abi_exactly(self):
        for name in self.expected['exports']['cowork']:
            self.assertIn(f'`{name}(', self.text)
        for line in ['`KRUN_COWORK_EXIT_NONE` 0', '`OFF` 1', '`RESET` 2', '`VCPU_ERROR` 3', '`TERMINAL_FAULT` 4', 'void (*krun_cowork_exit_hook_v1)(void *user_data, uint32_t reason)',
                     'int32_t krun_cowork_get_flush_counters_v1(struct krun_cowork_flush_counters_v1 *out)', '(`uint32_t`)']:
            self.assertIn(line, self.text)
        self.assertIn('exit 0 with no hook observed', self.text)
        self.assertIn('no signal handler is installed', self.text)

    def test_the_stated_counts_match(self):
        self.assertIn('22 patches, 0004-0025', self.text)
        self.assertIn('72 `krun_*` symbols', self.text)


class ConfinedServer(unittest.TestCase):
    """Patch 0024: the confined virtio-fs server core. It touches only the fs server, wires no device, export or
    gate, defines the SDK constants the pinned libc crate lacks with their header lines, and its suite runs."""
    PATCH = ROOT / 'patches/0024-proposed-confined-virtiofs-server-core.patch'
    FILES = ['src/devices/src/virtio/fs/macos/confined/mod.rs', 'src/devices/src/virtio/fs/macos/confined/names.rs', 'src/devices/src/virtio/fs/macos/confined/sys.rs',
             'src/devices/src/virtio/fs/macos/confined/tests.rs', 'src/devices/src/virtio/fs/macos/mod.rs', 'src/devices/src/virtio/fs/server.rs']

    def setUp(self):
        self.text = self.PATCH.read_text()
        self.added = added_text(24)

    def test_it_touches_only_the_fs_server(self):
        self.assertEqual(sorted(set(re.findall(r'^diff --git a/(\S+) b/', self.text, re.M))), self.FILES)
        queue = json.loads((ROOT / 'patch-queue.json').read_text())
        entry = next(p for p in queue['newPatches'] if p['patchFile'] == 'patches/' + self.PATCH.name)
        self.assertEqual(sorted(entry['allowedFiles']), self.FILES)
        self.assertTrue(set(self.FILES[:4]) <= set(queue['allAddedFiles']))

    def test_it_wires_no_device_export_or_gate(self):
        by_file = prep.added_lines_by_file(self.text)
        code = '\n'.join(l for f, lines in by_file.items() if not f.endswith('/tests.rs') for l in lines)
        for needle in ['#[no_mangle]', 'extern "C"', 'fn krun_', 'krun_cowork_add_share_v1(', ' Fs::new(', 'device::Fs', 'FsServer', 'attach_', 'register_mmio', 'shm_region', 'VirtioShmRegion', 'map_sender', 'umask(']:
            self.assertNotIn(needle, code, needle)

    def test_the_sdk_constants_carry_their_header_line_and_value(self):
        cited = re.findall(r'/// `(sys/(?:fcntl|stdio|errno)\.h):(\d+)`: `#define (\w+) (0x[0-9a-fA-F]+|\d+)`[^\n]*\n\+pub const (\w+): c_u?int = (0x[0-9a-fA-F_]+|\d+);', self.text)
        self.assertEqual(sorted(c[2] for c in cited), sorted(['O_RESOLVE_BENEATH', 'O_UNIQUE', 'AT_SYMLINK_NOFOLLOW_ANY', 'AT_RESOLVE_BENEATH', 'AT_UNIQUE', 'RENAME_NOFOLLOW_ANY', 'RENAME_RESOLVE_BENEATH', 'ENOTCAPABLE']))
        expected = {'O_RESOLVE_BENEATH': ('sys/fcntl.h', 128, 0x1000), 'O_UNIQUE': ('sys/fcntl.h', 129, 0x2000), 'AT_SYMLINK_NOFOLLOW_ANY': ('sys/fcntl.h', 184, 0x0800),
                    'AT_RESOLVE_BENEATH': ('sys/fcntl.h', 185, 0x2000), 'AT_UNIQUE': ('sys/fcntl.h', 187, 0x8000), 'RENAME_NOFOLLOW_ANY': ('sys/stdio.h', 39, 0x10),
                    'RENAME_RESOLVE_BENEATH': ('sys/stdio.h', 40, 0x20), 'ENOTCAPABLE': ('sys/errno.h', 265, 107)}
        for header, line, macro, cited_value, name, value in cited:
            self.assertEqual(macro, name)
            self.assertEqual((header, int(line), int(cited_value, 0)), expected[name], name)
            self.assertEqual(int(value.replace('_', ''), 0), expected[name][2], name)

    def test_the_limits_are_the_designs(self):
        for line in ['pub const MAX_HANDLES: usize = 4096;', 'pub const DIR_LRU: usize = 1024;', 'pub const TIMEOUT: Duration = Duration::from_secs(1);',
                     'pub const MODE_MASK: u32 = 0o777 & !0o022;', 'pub const CONFINED_MAX_PAGES: u16 = 256;', 'pub const NAME_MAX: usize = 255;']:
            self.assertIn(line, self.added)

    def test_its_suite_is_run(self):
        import run_cargo_tests
        self.assertIn(('krun-devices', 'blk', 'fs::macos::confined'), run_cargo_tests.RUNS)


class GuardedFsDevice(unittest.TestCase):
    """Patch 0025: the guarded fs device of the shares, the R14 budget, the share ABI and the gate clause. It
    leaves the confined server's module alone, builds no shared-memory region, sizes the budget as the design
    computes it, declares the ABI exactly as the design's block, admits r.fs only from krun_cowork_add_share_v1,
    and its suites are run."""
    PATCH = ROOT / 'patches/0025-proposed-guarded-fs-device-shares-abi-gate.patch'
    ADDED = ['src/devices/src/virtio/fs/cowork.rs', 'src/devices/src/virtio/fs/cowork_tests.rs', 'src/libkrun/src/cowork_production_shares_tests.rs']

    def setUp(self):
        self.text = self.PATCH.read_text()
        self.by_file = prep.added_lines_by_file(self.text)
        self.queue = json.loads((ROOT / 'patch-queue.json').read_text())

    def test_its_scope_and_new_files(self):
        touched = sorted(set(re.findall(r'^diff --git a/(\S+) b/', self.text, re.M)))
        entry = next(p for p in self.queue['newPatches'] if p['patchFile'] == 'patches/' + self.PATCH.name)
        self.assertEqual(touched, sorted(entry['allowedFiles']))
        self.assertFalse([f for f in touched if '/fs/macos/' in f or f.endswith('/fs/server.rs')], 'the confined server is left to its own patches')
        self.assertTrue(set(self.ADDED) <= set(self.queue['allAddedFiles']))
        self.assertTrue(set(self.ADDED) <= set(re.findall(r'^diff --git a/\S+ b/(\S+)\nnew file mode', self.text, re.M)))

    def test_the_bounds_and_the_budget_are_the_designs(self):
        device = '\n'.join(self.by_file['src/devices/src/virtio/fs/cowork.rs'])
        for line in ['pub const MAX_SHARES: usize = 12;', 'pub const TAG_MAX: usize = 32;', 'pub const MAX_CHAIN_DESCRIPTORS: usize = CONFINED_MAX_PAGES as usize + 4;',
                     'pub const MAX_CHAIN_BYTES: u64 = CONFINED_MAX_PAGES as u64 * 4096 + 8192;', 'pub const MAX_HPQ_BYTES: u64 = 4096;', 'pub const PINS_PER_SHARE: usize = 4;',
                     'pub const PINNED_BYTES_PER_SHARE: u64 = MAX_CHAIN_BYTES + MAX_HPQ_BYTES + 2 * RING_BYTES;']:
            self.assertIn(line, device)
        ring = 16 * 1024 + (6 + 2 * 1024) + (6 + 8 * 1024)
        per_share = 256 * 4096 + 8192 + 4096 + 2 * ring
        self.assertEqual((ring, per_share), (26636, 1114136))
        self.assertEqual((48 + 4 * 12, 8 * 1024 * 1024 + per_share * 12, 3 + 12), (96, 21758240, 15))
        disks = '\n'.join(self.by_file['src/devices/src/workspace_disks.rs'])
        self.assertIn('MAX_DEVICES + shares,', disks)
        self.assertIn('MAX_PINS + PINS_PER_SHARE * shares,', disks)
        self.assertIn('MAX_PINNED_BYTES + PINNED_BYTES_PER_SHARE * shares as u64,', disks)
        self.assertIn('devices::workspace_disks::budget(shares)', '\n'.join(self.by_file['src/vmm/src/builder.rs']))

    def test_no_shared_memory_region_and_no_attach_call(self):
        code = '\n'.join(l for f, lines in self.by_file.items() if not f.endswith('_tests.rs') for l in lines)
        for needle in ['set_shm_region(', 'VirtioShmRegion {', 'create_fs_region(', 'attach_', 'register_mmio', 'add_subscriber(']:
            self.assertNotIn(needle, code, needle)
        self.assertIn('self.shm_region = None;', '\n'.join(self.by_file['src/devices/src/virtio/fs/device.rs']))

    def test_the_abi_is_the_designs_block(self):
        header = '\n'.join(self.by_file['include/libkrun.h'])
        self.assertIn('int32_t krun_cowork_add_share_v1(uint32_t ctx_id, const char *tag, int32_t root_fd, uint32_t flags, const char *guest_path);', header)
        self.assertIn('/* flags: bit 0 = read-only, bit 1 = Winter share (R5 O_UNIQUE), bit 2 = folder rules (R15); every other bit zero.', header)
        self.assertIn('tag: [a-z0-9-]{1,32}, distinct. root_fd: a directory, borrowed. guest_path: the canonical guest mount path (R15 gitfiles only). */', header)
        for name in ['krun_cowork_add_share_v1', 'krun_cowork_revoke_share_v1', 'krun_cowork_next_share_event_v1']:
            self.assertIn('_' + name, lib.PRODUCTION_EXPORTS)

    def test_the_gate_admits_r_fs_only_from_add_share(self):
        lib_rs = self.by_file['src/libkrun/src/lib.rs']
        removed = [l[1:] for l in self.text.splitlines() if l.startswith('-') and not l.startswith('---')]
        self.assertTrue(any('!r.fs.is_empty()' in l for l in removed))
        self.assertTrue(any('!cowork_shares_admitted(cfg)' in l for l in lib_rs))
        self.assertEqual(sum('cowork_share: Some(' in l for l in lib_rs), 1, 'only krun_cowork_add_share_v1 builds a share entry')
        self.assertEqual(sum('cowork_share: None,' in l for l in lib_rs), 3, 'krun_set_root, krun_add_virtiofs4 and the block root add none')

    def test_its_suites_are_run(self):
        import run_cargo_tests
        self.assertIn(('krun-devices', 'blk', 'fs::cowork'), run_cargo_tests.RUNS)
        self.assertIn(('krun-devices', 'blk', 'fs::cowork'), run_cargo_tests.RELEASE_RUNS)


class Composition(unittest.TestCase):
    def pristine(self):
        for candidate in [os.environ.get('LIBKRUN_PRISTINE'), str(OUT / 'libkrun')]:
            if candidate and Path(candidate, '.git').exists():
                return Path(candidate)
        self.skipTest('no pristine libkrun checkout (run scripts/fetch_inputs.py, or set LIBKRUN_PRISTINE)')

    def test_the_queue_composes_to_the_pinned_diff_without_building(self):
        pristine = self.pristine()
        up = json.loads((ROOT / 'upstream-pin.json').read_text())['libkrun']
        queue = json.loads((ROOT / 'patch-queue.json').read_text())
        expected = json.loads((ROOT / 'expected-hashes.json').read_text())
        self.assertEqual(lib.git(pristine, 'rev-parse', 'HEAD^{tree}').strip(), up['treeSha1'])
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'tree'
            subprocess.run(['git', 'clone', '-q', '--no-hardlinks', str(pristine), str(work)], check=True, capture_output=True)
            for entry in queue['basePatches'] + queue['newPatches']:
                subprocess.run([*lib.GIT, '-C', str(work), 'apply', str(ROOT / entry['patchFile'])], check=True)
            lib.git(work, 'add', '-N', *queue['allAddedFiles'])
            full = lib.git(work, 'diff', '--binary', '--no-ext-diff', text=False)
        self.assertEqual(hashlib.sha256(full).hexdigest(), expected['composedSourceDiffSha256'])


class Hygiene(unittest.TestCase):
    FORBIDDEN = re.compile(r'(/Users/|/private/|/var/folders/|/Volumes/|/home/[a-z]|/opt/homebrew)')

    def files(self):
        for path in sorted(ROOT.rglob('*')):
            relative = path.relative_to(ROOT).parts
            if path.is_file() and 'out' not in relative[:1] and '__pycache__' not in relative:
                yield path

    def test_no_home_or_builder_path_or_name_in_anything_committed_here(self):
        # A CI account ("runner") is a generic word that legitimately appears in code; the check is for a person's name.
        tokens = [t.decode() for t in lib.builder_tokens() if t.decode().lower() not in {'runner', 'runneradmin', 'ubuntu', 'github', 'root', 'admin'}]
        scanned = 0
        for path in self.files():
            text = path.read_bytes().decode('utf-8', 'replace')
            scanned += 1
            if path.name not in ('test_queue_guards.py', 'libkrun_common.py'):  # these two define the path patterns
                self.assertIsNone(self.FORBIDDEN.search(text), path.name)
            for token in tokens:
                self.assertNotIn(token, text, f'{path.name}: builder name')
        self.assertGreater(scanned, 20)

    def test_no_evidence_logs_kernel_or_fixture_only_scripts_are_carried(self):
        names = {p.name for p in self.files()}
        self.assertFalse({n for n in names if n.endswith(('.log', '.diff'))})
        self.assertFalse({n for n in names if n.startswith(('run_fixture', 'build_stream', 'build_block', 'generic_fixture', 'init.', 'worker.'))})
        self.assertFalse((ROOT / 'results').exists() or (ROOT / 'kernel').exists())


class AntiWiring(unittest.TestCase):
    def test_nothing_in_the_repository_references_this_directory(self):
        repo = ROOT.parents[2]
        skip = {'.git', 'node_modules', '.build', 'out', 'dist', '__pycache__'}
        referrers = []
        for current, dirs, names in os.walk(repo):
            dirs[:] = [d for d in dirs if d not in skip]
            if Path(current) == ROOT:
                dirs[:] = []
                continue
            for name in names:
                path = Path(current) / name
                if path.stat().st_size > 2_000_000:
                    continue
                try:
                    if 'WinterCoworkLibkrun' in path.read_text(errors='ignore'):
                        referrers.append(str(path.relative_to(repo)))
                except OSError:
                    pass
        # The only referrer is the CI job that runs these guards; nothing imports or builds the directory.
        self.assertEqual(referrers, ['.github/workflows/ci.yml'] if (repo / '.github/workflows/ci.yml').exists() else [])


class Scripts(unittest.TestCase):
    def test_scripts_never_call_the_start_path_and_only_fetch_inputs_uses_the_network(self):
        for path in sorted((ROOT / 'scripts').glob('*.py')):
            text = path.read_text()
            self.assertNotIn('run_fixture', text)
            self.assertNotIn('--sandbox-check', text)
            self.assertNotIn('krun_start_enter(', text.replace('never calls krun_start_enter', ''), path.name)
            if path.name != 'fetch_inputs.py':
                self.assertNotIn('urllib', text, path.name)
                self.assertNotIn('urlretrieve', text, path.name)
        probe = (ROOT / 'scripts/abi_smoke.c').read_text()
        self.assertEqual([l for l in probe.splitlines() if 'krun_start_enter(' in l], [])

    def test_the_build_reuses_a_matching_archive_and_keys_on_the_queue(self):
        import build_archive
        queue = json.loads((ROOT / 'patch-queue.json').read_text())
        expected = json.loads((ROOT / 'expected-hashes.json').read_text())
        key = build_archive.build_key(queue, expected)
        self.assertRegex(key, SHA.pattern)
        changed = json.loads(json.dumps(queue))
        changed['newPatches'][0]['patchSha256'] = '0' * 64
        self.assertNotEqual(build_archive.build_key(changed, expected), key)
        other = dict(expected, composedSourceDiffSha256='1' * 64)
        self.assertNotEqual(build_archive.build_key(queue, other), key)


class SupplyChainGuards(unittest.TestCase):
    def test_download_refuses_a_wrong_hash_without_any_network(self):
        import fetch_inputs
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive.bin'
            path.write_bytes(b'not the pinned archive')
            good = hashlib.sha256(b'not the pinned archive').hexdigest()
            self.assertEqual(fetch_inputs.download('http://invalid.invalid/never-fetched', path, good), path)
            with self.assertRaises(RuntimeError):
                fetch_inputs.download('http://invalid.invalid/never-fetched', path, '0' * 64)

    def test_every_tar_extraction_carries_a_filter(self):
        import ast
        found = 0
        for path in sorted((ROOT / 'scripts').glob('*.py')):
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('extractall', 'extract'):
                    found += 1
                    self.assertIn('filter', [k.arg for k in node.keywords], f'{path.name}:{node.lineno}')
                    self.assertEqual([k.value.value for k in node.keywords if k.arg == 'filter'], ['data'], f'{path.name}:{node.lineno}')
        self.assertGreaterEqual(found, 3)

    def test_the_archive_is_reused_only_with_the_key_and_both_pinned_hashes(self):
        import build_archive
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            raw, stripped, key_file = d / 'raw.a', d / 'stripped.a', d / 'key.json'
            raw.write_bytes(b'raw')
            stripped.write_bytes(b'stripped')
            pinned = {'rawSha256': hashlib.sha256(b'raw').hexdigest(), 'strippedSha256': hashlib.sha256(b'stripped').hexdigest()}
            key_file.write_text(json.dumps({'key': 'k'}))
            self.assertTrue(build_archive.can_reuse('k', key_file, raw, stripped, pinned))
            self.assertFalse(build_archive.can_reuse('other', key_file, raw, stripped, pinned))
            self.assertFalse(build_archive.can_reuse('k', key_file, raw, stripped, pinned, force=True))
            self.assertFalse(build_archive.can_reuse('k', key_file, raw, stripped, dict(pinned, rawSha256='0' * 64)))
            self.assertFalse(build_archive.can_reuse('k', key_file, raw, stripped, dict(pinned, strippedSha256='0' * 64)))
            self.assertFalse(build_archive.can_reuse('k', d / 'missing.json', raw, stripped, pinned))
            raw.write_bytes(b'tampered')
            self.assertFalse(build_archive.can_reuse('k', key_file, raw, stripped, pinned))


class CiJob(unittest.TestCase):
    def setUp(self):
        text = (ROOT.parents[2] / '.github/workflows/ci.yml').read_text()
        self.job = text[text.index('\n  libkrun-queue:'):]

    def test_the_scope_step_does_not_follow_renames(self):
        step = self.job[self.job.index('name: Is this change in scope?'):self.job.index('name: Fetch the pinned upstream source')]
        self.assertIn('git diff --no-renames --name-only "$from" HEAD', step)
        self.assertNotIn('git diff --name-only', step)

    def test_least_privilege_pinned_actions_and_a_timeout(self):
        self.assertRegex(self.job, r'permissions:\n\s+contents: read\n')
        self.assertEqual(len(re.findall(r'persist-credentials: false', self.job)), len(re.findall(r'uses: actions/checkout', self.job)))
        self.assertGreaterEqual(len(re.findall(r'uses: ', self.job)), 1)
        for ref in re.findall(r'uses: (\S+)', self.job):
            self.assertRegex(ref, r'@[0-9a-f]{40}$')
        self.assertLessEqual(int(re.search(r'timeout-minutes: (\d+)', self.job).group(1)), 10)
        self.assertNotIn('secrets.', self.job)
        for forbidden in ['cargo', 'rustup', 'build_archive', 'run_cargo_tests']:
            self.assertNotIn(forbidden, self.job.replace('No cargo', ''))


if __name__ == '__main__':
    unittest.main(verbosity=2)
