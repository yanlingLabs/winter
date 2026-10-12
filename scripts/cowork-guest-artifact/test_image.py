import io, json, struct, tempfile, unittest
from pathlib import Path
from image import Tree, elf, ar_members, add_deb
from packages import version_compare, closure, verify_release, HERE

class ImageTests(unittest.TestCase):
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
if __name__=='__main__':unittest.main()
