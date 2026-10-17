import hashlib, importlib.util, io, json, lzma, os, struct, subprocess, sys, tarfile, tempfile, unittest
from unittest.mock import patch
from pathlib import Path
import image
from image import Tree, elf, ar_members, add_deb, control_fields
from packages import version_compare, closure, verify_release, HERE, bounded_file, download, xz_chunks, index_paragraphs, sha
import verify as cpio_verify
GUEST=HERE.parents[1]/'apple/Cowork/WinterCoworkGuest'
PINS=json.loads((HERE/'pins.json').read_text())

class ImageTests(unittest.TestCase):
    def test_cached_size_refuses_before_read_or_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'cache';path.write_bytes(b'123456789')
            with patch.object(Path,'read_bytes',side_effect=AssertionError('unbounded read forbidden')):
                with self.assertRaises(ValueError):download('https://invalid.test',path,'0'*64,maximum=8)
                with self.assertRaises(ValueError):bounded_file(path,32,expected_size=8)
    def test_cached_small_file_and_index_stream_preserve_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'cache';path.write_bytes(b'small')
            self.assertEqual(download('https://invalid.test',path,sha(b'small'),size=5),b'small')
        index=b'Package: test\nVersion: 1\nArchitecture: arm64\n\n'
        self.assertEqual(list(index_paragraphs(lzma.compress(index,preset=0))),[{'Package':'test','Version':'1','Architecture':'arm64'}])
    def test_xz_output_and_dictionary_limits_refuse_without_large_output(self):
        packed=lzma.compress(b'x'*1024,preset=0)
        with self.assertRaises(ValueError):list(xz_chunks(packed,128))
        with self.assertRaises(lzma.LZMAError):list(xz_chunks(packed,2048,memory_limit=1))
    def test_index_lines_and_records_refuse_with_small_configured_bounds(self):
        packed=lzma.compress(b'Package: '+b'x'*65+b'\nVersion: 1\n\n',preset=0)
        with self.assertRaises(ValueError):list(index_paragraphs(packed,line_limit=64))
        with self.assertRaises(ValueError):list(index_paragraphs(packed,paragraph_limit=64))
    def test_control_field_and_total_metadata_are_capped(self):
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w') as archive:
            entry=tarfile.TarInfo('control');entry.size=65;archive.addfile(entry,io.BytesIO(b'x'*65))
        packed=lzma.compress(buffer.getvalue(),preset=0)
        with self.assertRaises(ValueError):control_fields('control.tar.xz',packed,field_limit=64)
        with self.assertRaises(ValueError):control_fields('control.tar.xz',packed,maximum=128)
    def test_control_stream_reads_small_regular_identity(self):
        data=b'Package: fixture\nVersion: 1\nArchitecture: arm64\n'
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w') as archive:
            entry=tarfile.TarInfo('./control');entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
        self.assertEqual(control_fields('control.tar.xz',lzma.compress(buffer.getvalue(),preset=0))['Package'],'fixture')
    def test_traversal_and_non_directory_ancestors_refuse(self):
        tree=Tree()
        for name in ['../escape','/absolute','safe/../../escape','zero\0byte']:
            with self.assertRaises(ValueError):tree.add(name,'file',b'x')
        tree.add('alias','symlink',b'/outside')
        with self.assertRaises(ValueError):tree.add('alias/child','file',b'x')
    def test_guest_absolute_links_never_follow_host_paths(self):
        tree=Tree();tree.add('etc/value','file',b'guest');tree.add('alias','symlink',b'/etc/value')
        self.assertEqual(tree.resolve('/alias')[1]['data'],b'guest')
        tree.add('cycle','symlink',b'cycle')
        with self.assertRaises(ValueError):tree.resolve('cycle')
    def test_conflicting_package_bytes_refuse(self):
        tree=Tree();tree.add('a','file',b'x',origin='package-a');tree.add('a','file',b'x',origin='package-b')
        self.assertEqual(tree.manifest()[0]['origins'],['package-a','package-b'])
        with self.assertRaises(ValueError):tree.add('a','file',b'y')
    def test_cpio_repeat_has_normalized_root_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            tree=Tree();tree.add('bin/tool','file',b'bytes',True);tree.add('bin/link','symlink',b'tool')
            a=Path(root)/'a';b=Path(root)/'b';tree.cpio(a);tree.cpio(b);self.assertEqual(a.read_bytes(),b.read_bytes())
            data=a.read_bytes();at=0;seen=[]
            while data[at:at+6]==b'070701':
                values=[int(data[at+6+i*8:at+14+i*8],16) for i in range(13)]
                self.assertEqual(values[2:6],[0,0,1,0]);size=values[6];namesize=values[11]
                name=data[at+110:at+110+namesize-1].decode();at=(at+110+namesize+3)&~3;at=(at+size+3)&~3
                seen.append(name)
                if name=='TRAILER!!!':break
            self.assertEqual(seen,['bin','bin/link','bin/tool','TRAILER!!!'])
    def test_wrong_architecture_and_elf_bounds_refuse(self):
        data=bytearray(64);data[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',data,16,2,62)
        with self.assertRaises(ValueError):elf(data)
        struct.pack_into('<H',data,18,183);struct.pack_into('<Q',data,32,100);struct.pack_into('<HH',data,54,56,1)
        with self.assertRaises(ValueError):elf(data)
    def test_deb_cache_bytes_do_not_override_the_pinned_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'bad.deb';path.write_bytes(b'not-a-deb')
            with self.assertRaises(ValueError):add_deb(Tree(),{'SHA256':'0'*64,'Size':9},path)
    def test_release_tamper_fails_signature_before_any_package(self):
        fixture=HERE.parent.parent/'out/cowork-guest-artifact/downloads/bookworm-InRelease'
        if not fixture.exists():self.skipTest('signed snapshot evidence not provisioned')
        pins=json.loads((HERE/'pins.json').read_text())
        with tempfile.TemporaryDirectory() as folder:
            modified=fixture.read_bytes().replace(b'Origin: Debian',b'Origin: DebiaX',1)
            with self.assertRaises(ValueError):verify_release(modified,pins,Path(folder))
    def test_ar_bounds_refuse(self):
        with self.assertRaises(ValueError):ar_members(b'!<arch>\nshort')
    def test_dependency_versions_and_unavailable_alternatives(self):
        self.assertLess(version_compare('1.0~rc1','1.0'),0);self.assertGreater(version_compare('2:1.0','1:99'),0)
        self.assertGreater(version_compare('1.0-10','1.0-2'),0)
        index={'root':{'Package':'root','Version':'1','Depends':'absent | lib (>= 2)'},'lib':{'Package':'lib','Version':'2'}}
        self.assertEqual([e['Package'] for e in closure(index,['root'])],['lib','root'])
        index['lib']['Version']='1'
        with self.assertRaises(ValueError):closure(index,['root'])


TOOL_SOURCE_GOOD="""
struct tool_device { const char *name; unsigned int minor; };
static const struct tool_device tool_devices[]={
    {"/dev/null",3},{"/dev/zero",5},{"/dev/full",7},{"/dev/random",8},{"/dev/urandom",9}
};
#define TOOL_DEVICE_COUNT (sizeof tool_devices/sizeof tool_devices[0])
"""

def load_guest_build():
    spec=importlib.util.spec_from_file_location('guest_build',GUEST/'build.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class GuestStartupTests(unittest.TestCase):
    INIT=b'\x7fELF-init-bytes'
    def tree(self,**changes):
        tree=Tree();tree.add('init','file',changes.get('init',self.INIT),True,'winter-guest:init')
        tree.add('opt/winter/libexec/linux-supervisor.py','file',b'x',False)
        return tree
    def test_exactly_the_pinned_init_is_accepted(self):
        image.check_startup(self.tree(),sha(self.INIT))
    def test_a_missing_or_different_init_is_refused(self):
        with self.assertRaises(ValueError):image.check_startup(Tree(),sha(self.INIT))
        with self.assertRaises(ValueError):image.check_startup(self.tree(init=b'other'),sha(self.INIT))
    def test_init_must_be_a_regular_0555_file(self):
        tree=Tree();tree.add('init','file',self.INIT,False)
        with self.assertRaises(ValueError):image.check_startup(tree,sha(self.INIT))
        tree=Tree();tree.add('init','symlink',b'opt/winter/x')
        with self.assertRaises(ValueError):image.check_startup(tree,sha(self.INIT))
        # a symlink whose target bytes happen to hash to the pinned digest is still not a regular file
        with self.assertRaises(ValueError):image.check_startup(tree,sha(b'opt/winter/x'))
        # a directory is 0555 too, and empty bytes hash to whatever digest is pinned for them: only the kind check refuses it
        tree=Tree();tree.add('init','directory')
        with self.assertRaises(ValueError):image.check_startup(tree,sha(b''))
    def test_every_other_startup_path_is_still_refused(self):
        for name in image.STARTUP_PATHS:
            for kind,data in (('file',b'#!/bin/sh'),('symlink',b'nowhere'),('directory',b'')):
                with self.subTest(name=name,kind=kind):
                    tree=self.tree();tree.add(name,kind,data,kind=='file')
                    with self.assertRaises(ValueError):image.check_startup(tree,sha(self.INIT))
    def test_a_startup_program_behind_a_root_alias_is_refused(self):
        tree=self.tree();tree.add('opt/winter/environment/base/sbin/init','file',b'x',True);tree.add('sbin','symlink',b'opt/winter/environment/base/sbin')
        with self.assertRaises(ValueError):image.check_startup(tree,sha(self.INIT))

class ToolDeviceTests(unittest.TestCase):
    def test_the_five_devices(self):
        self.assertEqual(image.check_tool_devices(TOOL_SOURCE_GOOD),image.TOOL_DEVICES_EXPECTED)
    def test_a_virtio_port_block_device_or_kmsg_is_refused(self):
        for extra in ('{"/dev/vport0p0",0}','{"/dev/vport1p0",0}','{"/dev/vda",0}','{"/dev/kmsg",11}','{"/dev/hvc0",0}'):
            with self.subTest(extra):
                with self.assertRaises(ValueError):image.check_tool_devices(TOOL_SOURCE_GOOD.replace('{"/dev/urandom",9}','{"/dev/urandom",9},'+extra))
    def test_a_replaced_or_missing_entry_or_unfindable_inventory_is_refused(self):
        with self.assertRaises(ValueError):image.check_tool_devices(TOOL_SOURCE_GOOD.replace('"/dev/full"','"/dev/vport0p1"'))
        with self.assertRaises(ValueError):image.check_tool_devices(TOOL_SOURCE_GOOD.replace('{"/dev/full",7},',''))
        with self.assertRaises(ValueError):image.check_tool_devices('int main(void){return 0;}')

class BaseConfigTests(unittest.TestCase):
    DIGESTS={'file-worker':'a'*64,'process-worker':'b'*64,'linux-tool-compartment':'c'*64}
    def test_the_static_part_is_canonical_one_line_and_names_the_image_paths(self):
        data=image.supervisor_base_config(self.DIGESTS)
        config=json.loads(data)
        self.assertEqual(data,json.dumps(config,sort_keys=True,separators=(',',':')).encode())
        self.assertNotIn(b'\n',data)
        self.assertEqual(config['artifacts']['launcher'],{'path':'/opt/winter/helpers/linux-tool-compartment','sha256':'c'*64})
        self.assertEqual(config['artifacts']['fileWorker']['path'],'/opt/winter/helpers/file-worker')
        self.assertEqual(config['artifacts']['processWorker']['sha256'],'b'*64)
        self.assertEqual((config['environment'],config['controlDirectory'],config['protectedStoreDirectories']),('/opt/winter/environment/base','/run/winter/control',[]))
    def test_it_does_not_carry_what_pid_1_supplies(self):
        data=image.supervisor_base_config(self.DIGESTS)
        self.assertNotIn(b'guestBootId',data);self.assertNotIn(b'conversations',data)
    def test_it_fits_pid_1s_static_ceiling(self):
        self.assertLess(len(image.supervisor_base_config(self.DIGESTS)),8192)

class ExpectedArtifactTests(unittest.TestCase):
    RECEIPT={'runtimeSha256':'1','cpioSha256':'2','rootManifestSha256':'3','sourceHelpers':{'file-worker.c':{'binarySha256':'4'}}}
    EXPECTED={'runtimeSha256':'1','cpioSha256':'2','rootManifestSha256':'3','helperBinarySha256':{'file-worker.c':'4'}}
    def test_unpinned_is_reported_never_silently_accepted(self):
        self.assertEqual(image.check_expected(self.RECEIPT,None),['expectedArtifact is not pinned'])
    def test_a_match_is_clean_and_each_mismatch_is_named(self):
        self.assertEqual(image.check_expected(self.RECEIPT,self.EXPECTED),[])
        for key in ('runtimeSha256','cpioSha256','rootManifestSha256'):
            changed=dict(self.EXPECTED,**{key:'x'})
            self.assertIn(key,image.check_expected(self.RECEIPT,changed)[0])
        changed=dict(self.EXPECTED,helperBinarySha256={'file-worker.c':'x'})
        self.assertIn('file-worker.c',image.check_expected(self.RECEIPT,changed)[0])

class PinTests(unittest.TestCase):
    def test_the_sdk_pin_is_a_full_commit_and_records_what_it_replaced(self):
        self.assertRegex(PINS['sdkCommit'],r'^[0-9a-f]{40}$')
        self.assertRegex(PINS['sdkPin']['previousCommit'],r'^[0-9a-f]{40}$')
        self.assertNotEqual(PINS['sdkCommit'],PINS['sdkPin']['previousCommit'])
        self.assertEqual(PINS['sdkCommit'],PINS['sdkPin']['mainAt'])
    def test_the_re_pin_left_the_expected_artifact_honestly_unpinned_and_kept_the_old_one(self):
        self.assertIsNone(PINS['expectedArtifact'])
        self.assertEqual(PINS['previousExpectedArtifact']['sdkCommit'],PINS['sdkPin']['previousCommit'])
        self.assertEqual(set(PINS['previousExpectedArtifact']['expectedArtifact']),{'runtimeSha256','cpioSha256','rootManifestSha256','helperBinarySha256'})
    def test_no_util_linux_and_no_blkid_dependency(self):
        lock=json.loads((HERE/'packages.lock.json').read_text())
        names={entry['Package'] for entry in lock['packages']}
        self.assertNotIn('util-linux',PINS['packages']);self.assertNotIn('util-linux',names)
        self.assertNotIn('util-linux-extra',names);self.assertNotIn('mount',names)
        self.assertTrue({'e2fsprogs','libext2fs2'}<=names)
        self.assertNotIn('blkid',image.__doc__ or '')
    def test_every_guest_pin_is_a_real_digest_of_the_current_sources(self):
        build=load_guest_build()
        for name,entry in PINS['guest']['programs'].items():
            self.assertRegex(entry['binarySha256'],r'^[0-9a-f]{64}$');self.assertNotEqual(entry['binarySha256'],'0'*64)
            self.assertEqual(entry['sourceSha256'],build.source_digest(build.PROGRAMS[name]+build.HEADERS),name+' source changed: rebuild and re-pin')
        for name,entry in PINS['guest']['scripts'].items():
            path=GUEST/PINS['guest']['scriptPaths'][name]
            self.assertEqual(entry['sha256'],hashlib.sha256(path.read_bytes()).hexdigest(),name+' changed: re-pin')
    def test_the_pinned_zig_is_the_one_the_guest_build_demands(self):
        build=load_guest_build()
        self.assertEqual(PINS['zig']['version'],build.ZIG_VERSION);self.assertEqual(PINS['guest']['zig'],build.ZIG_VERSION)
    def test_build_digests_are_checked_against_a_real_build_when_zig_is_provided(self):
        zig=os.environ.get('WINTER_PINNED_ZIG')
        if not zig:self.skipTest('set WINTER_PINNED_ZIG to the pinned Zig 0.14.1 to rebuild and compare')
        with tempfile.TemporaryDirectory() as folder:
            programs,scripts,receipt=image.build_guest(Path(zig),Path(folder)/'guest',PINS)
        self.assertEqual(sha(programs['init']),PINS['guest']['programs']['init']['binarySha256'])

class GuestBuildCheckTests(unittest.TestCase):
    def fake_build(self,receipt):
        def run(command,**kwargs):
            out=Path(command[command.index('--out')+1]);out.mkdir(parents=True)
            for name in receipt['programs']:(out/name).write_bytes(name.encode())
            (out/'receipt.json').write_text(json.dumps(receipt));return subprocess.CompletedProcess(command,0,'','')
        return run
    def receipt(self,**changes):
        pins=PINS['guest'];base={'programs':{n:dict(e) for n,e in pins['programs'].items()},'scripts':{n:dict(e) for n,e in pins['scripts'].items()},'zig':'0.14.1'}
        for key,value in changes.items():base[key]=value
        return base
    def build(self,receipt):
        with tempfile.TemporaryDirectory() as folder,patch.object(image.subprocess,'run',self.fake_build(receipt)):
            return image.build_guest(Path('zig'),Path(folder)/'guest',PINS)
    def test_a_matching_build_is_accepted(self):
        programs,scripts,_=self.build(self.receipt())
        self.assertEqual(set(programs),set(PINS['guest']['programs']));self.assertEqual(set(scripts),set(PINS['guest']['scripts']))
    def test_a_different_binary_or_drifted_source_or_script_is_refused(self):
        receipt=self.receipt();receipt['programs']['init']['binarySha256']='f'*64
        with self.assertRaises(ValueError):self.build(receipt)
        receipt=self.receipt();receipt['programs']['winter-guest-relay']['sourceSha256']='f'*64
        with self.assertRaises(ValueError):self.build(receipt)
        receipt=self.receipt();receipt['scripts']['guest_bootstrap.py']['sha256']='f'*64
        with self.assertRaises(ValueError):self.build(receipt)
    def test_a_failed_build_is_an_error(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(image.subprocess,'run',lambda *a,**k:subprocess.CompletedProcess(a,1,'','boom')):
            with self.assertRaises(ValueError):image.build_guest(Path('zig'),Path(folder)/'guest',PINS)

class GuestFilesTests(unittest.TestCase):
    PROGRAMS={'init':b'\x7fELF-init','winter-guest-relay':b'\x7fELF-relay'}
    SCRIPTS={'guest_bootstrap.py':b'print(1)\n'}
    DIGESTS={'file-worker':'a'*64,'process-worker':'b'*64,'linux-tool-compartment':'c'*64}
    def tree(self):
        tree=Tree();image.add_guest_files(tree,self.PROGRAMS,self.SCRIPTS,self.DIGESTS);return tree
    def test_the_guest_files_land_where_pid_1_looks_for_them(self):
        tree=self.tree()
        self.assertEqual((tree.nodes['init']['mode'],tree.nodes['init']['kind']),(0o555,'file'))
        self.assertEqual(tree.nodes['opt/winter/libexec/winter-guest-relay']['mode'],0o555)
        self.assertEqual(tree.nodes['opt/winter/libexec/guest_bootstrap.py']['mode'],0o444)
        self.assertEqual(tree.nodes['opt/winter/etc/supervisor-base.json']['mode'],0o444)
        self.assertEqual(tree.nodes['opt/winter/environment/disk']['kind'],'directory')
        for path in ('winter-guest-relay','guest_bootstrap.py'):self.assertIn('opt/winter/libexec/'+path,tree.nodes)
    def test_the_added_init_passes_exactly_the_pinned_check(self):
        image.check_startup(self.tree(),sha(self.PROGRAMS['init']))
        with self.assertRaises(ValueError):image.check_startup(self.tree(),sha(b'other'))
    def test_the_static_config_is_written_with_a_trailing_newline_that_pid_1_strips(self):
        data=self.tree().nodes['opt/winter/etc/supervisor-base.json']['data']
        self.assertTrue(data.endswith(b'}\n'));self.assertEqual(data.count(b'\n'),1)
    def test_the_required_programs_include_the_probe_tool_and_not_blkid(self):
        self.assertIn('/sbin/dumpe2fs',image.REQUIRED_PROGRAMS);self.assertIn('/sbin/mke2fs',image.REQUIRED_PROGRAMS);self.assertIn('/sbin/e2fsck',image.REQUIRED_PROGRAMS)
        self.assertFalse(any('blkid' in path for path in image.REQUIRED_PROGRAMS))
    def test_a_blkid_in_the_image_is_refused(self):
        for path in ('sbin/blkid','opt/winter/environment/base/sbin/blkid','blkid'):
            with self.subTest(path):
                tree=Tree();tree.add(path,'file',b'x',True)
                with self.assertRaises(ValueError):image.refuse_blkid(tree)
        image.refuse_blkid(Tree())

class CpioReadbackTests(unittest.TestCase):
    """A tiny root through the real emitter and the independent reader (verify.py)."""
    INIT=b'\x7fELF-pinned-init'
    def write(self,folder,tree,init_digest=None,present=True,pinned=True):
        folder.mkdir(exist_ok=True)
        tree.cpio(folder/'immutable-root.cpio');(folder/'root.manifest.json').write_text(json.dumps(tree.manifest()))
        (folder/'receipt.json').write_text(json.dumps({'cpioSha256':sha((folder/'immutable-root.cpio').read_bytes()),'initSha256':init_digest or sha(self.INIT),'initPresent':present,'reproducibilityPinned':pinned}))
    def tree(self,init=None):
        tree=Tree();tree.add('bin/tool','file',b'tool-content-0123456789',True);tree.add('proc','directory')
        if init is not None:tree.add('init','file',init,True)
        return tree
    def test_a_root_with_exactly_the_pinned_init_verifies(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.write(root,self.tree(self.INIT))
            result=cpio_verify.verify(root,pinned_init=sha(self.INIT))
            self.assertTrue(result['startupPresent']);self.assertEqual(result['startupEntries'],['init'])
    def test_an_unpinned_receipt_is_refused_unless_the_flag_names_it(self):
        with tempfile.TemporaryDirectory() as folder:
            for value in (False, None, 'true', 1):
                root=Path(folder)/str(value);self.write(root,self.tree(self.INIT),pinned=value)
                with self.assertRaisesRegex(ValueError,'reproducibility'):cpio_verify.verify(root,pinned_init=sha(self.INIT))
                self.assertTrue(cpio_verify.verify(root,pinned_init=sha(self.INIT),allow_unpinned=True)['startupPresent'])
            root=Path(folder)/'missing';self.write(root,self.tree(self.INIT));receipt=json.loads((root/'receipt.json').read_text());del receipt['reproducibilityPinned'];(root/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError,'reproducibility'):cpio_verify.verify(root,pinned_init=sha(self.INIT))
            root=Path(folder)/'ok';self.write(root,self.tree(self.INIT))
            self.assertTrue(cpio_verify.verify(root,pinned_init=sha(self.INIT))['startupPresent'])
    def test_the_command_line_needs_the_named_flag_for_an_unpinned_receipt(self):
        script=Path(cpio_verify.__file__)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'unpinned';self.write(root,self.tree(self.INIT),pinned=False)
            refused=subprocess.run([sys.executable,'-I','-S','-B',str(script),str(root),'--no-init'],capture_output=True,text=True)
            self.assertNotEqual(refused.returncode,0);self.assertIn('ValueError: receipt is not reproducibility-pinned',refused.stderr)
            # --no-init only changes the startup rule; the flag is what accepts the unpinned receipt (this root has an init, so it still fails there)
            named=subprocess.run([sys.executable,'-I','-S','-B',str(script),str(root),'--allow-unpinned','--no-init'],capture_output=True,text=True)
            self.assertIn('cpio carries a startup program',named.stderr)
            self.assertNotIn('ValueError: receipt is not reproducibility-pinned',named.stderr)
    def test_a_different_init_missing_init_or_extra_startup_entry_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'a';self.write(root,self.tree(b'other'))
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
            root=Path(folder)/'b';self.write(root,self.tree())
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
            tree=self.tree(self.INIT);tree.add('linuxrc','file',b'#!/bin/sh',True);root=Path(folder)/'c';self.write(root,tree)
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
    def test_a_receipt_that_does_not_describe_the_init_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'a';self.write(root,self.tree(self.INIT),init_digest='0'*64)
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
            root=Path(folder)/'b';self.write(root,self.tree(self.INIT),present=False)
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
    def test_the_no_init_mode_still_demands_that_there_is_none(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'a';self.write(root,self.tree())
            self.assertFalse(cpio_verify.verify(root,require_init=False)['startupPresent'])
            root=Path(folder)/'b';self.write(root,self.tree(self.INIT))
            with self.assertRaises(ValueError):cpio_verify.verify(root,require_init=False)
    def test_an_init_that_is_not_executable_is_refused_even_with_the_pinned_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            tree=self.tree();tree.add('init','file',self.INIT,False)   # same bytes, mode 0444
            root=Path(folder);self.write(root,tree)
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
    def test_a_member_whose_bytes_changed_is_caught_even_when_the_whole_file_digest_was_updated(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.write(root,self.tree(self.INIT))
            data=bytearray((root/'immutable-root.cpio').read_bytes());data[data.index(self.INIT)]^=1;(root/'immutable-root.cpio').write_bytes(bytes(data))
            receipt=json.loads((root/'receipt.json').read_text());receipt['cpioSha256']=sha(bytes(data));(root/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
    def test_a_changed_member_other_than_init_is_caught_by_its_own_digest(self):
        # init is also held to the pinned digest by the startup rule, so only a member the rule does not cover shows that each member is read back
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.write(root,self.tree(self.INIT))
            data=bytearray((root/'immutable-root.cpio').read_bytes());data[data.index(b'tool-content')]^=1;(root/'immutable-root.cpio').write_bytes(bytes(data))
            receipt=json.loads((root/'receipt.json').read_text());receipt['cpioSha256']=sha(bytes(data));(root/'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))
    def test_a_tampered_cpio_byte_is_caught(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.write(root,self.tree(self.INIT))
            data=bytearray((root/'immutable-root.cpio').read_bytes());data[data.index(self.INIT)]^=1;(root/'immutable-root.cpio').write_bytes(bytes(data))
            with self.assertRaises(ValueError):cpio_verify.verify(root,pinned_init=sha(self.INIT))

if __name__=='__main__':unittest.main()
