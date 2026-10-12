"""No VM: execute actual C discovery against synthetic sysfs trees and bounded open probes."""
import json,os,subprocess,tempfile,unittest
from pathlib import Path
from build import ROOT

HARNESS=r'''
#include <assert.h>
#include "generic_port_discovery.h"
int main(int argc,char **argv){assert(argc==3);struct generic_port_identity identity;int result=generic_port_discover(argv[1],argv[2],&identity);printf("{\"result\":%d,\"major\":%u,\"minor\":%u,\"console\":\"%s\",\"port\":\"%s\"}\n",result,identity.major,identity.minor,identity.console,identity.port);return 0;}
'''

class DiscoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory=tempfile.TemporaryDirectory();root=Path(cls.directory.name);source=root/'discovery.c';source.write_text(HARNESS);cls.binary=root/'discovery'
        subprocess.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-I',str(ROOT),str(source),'-o',str(cls.binary)],check=True)
    @classmethod
    def tearDownClass(cls):cls.directory.cleanup()
    def fixture(self,root):
        virtio=root/'virtio';ports=root/'ports';tty=root/'tty';driver=root/'drivers/virtio_console';driver.mkdir(parents=True)
        virtio.mkdir();ports.mkdir();tty.mkdir()
        for index,device in enumerate(['0x0005','0x0004','0x0003','0x0002']):
            node=virtio/f'virtio{index}';node.mkdir();(node/'device').write_text(device+'\n')
            features=''.join('1' if bit in (1,32) else '0' for bit in range(128));(node/'features').write_text(features+'\n');(node/'driver').symlink_to(driver)
        port=ports/'vport2p0';port.mkdir();(port/'device').symlink_to(virtio/'virtio2');(port/'dev').write_text('245:0\n')
        for index in range(8):
            slot=tty/f'hvc{index}';slot.mkdir();(slot/'dev').write_text(f'229:{index}\n')
        return virtio,ports,tty
    def run_case(self,mutate=lambda v,p,t:None,active=1):
        with tempfile.TemporaryDirectory() as name:
            roots=self.fixture(Path(name));mutate(*roots)
            result=subprocess.run([str(self.binary),str(roots[0]),str(roots[1])],capture_output=True,text=True,check=True,timeout=2)
            return json.loads(result.stdout)
    def test_exact_generic_port_identity(self):
        result=self.run_case();self.assertEqual(result['result'],0);self.assertEqual(result['port'],'vport2p0');self.assertEqual(result['major'],245);self.assertEqual(result['minor'],0)
    def test_missing_multiport_is_refused(self):
        def mutate(v,p,t):
            value=list((v/'virtio2/features').read_text());value[1]='0';(v/'virtio2/features').write_text(''.join(value))
        self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_wrong_generic_device_number_is_refused(self):
        for value in ('0:0','245:1','245:0bad'):
            def mutate(v,p,t):(p/'vport2p0/dev').write_text(value+'\n')
            self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_second_virtio_console_is_refused(self):
        def mutate(v,p,t):(v/'virtio3/device').write_text('0x0003\n')
        self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_missing_version1_and_additional_feature_are_refused(self):
        for bit in (32,63):
            def mutate(v,p,t):
                value=list((v/'virtio2/features').read_text());value[bit]='0' if bit==32 else '1';(v/'virtio2/features').write_text(''.join(value))
            self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_unbound_or_wrong_driver_is_refused(self):
        def mutate(v,p,t):(v/'virtio2/driver').unlink();(v/'virtio2/driver').symlink_to(v/'virtio0')
        self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_extra_port_wrong_port_id_and_wrong_parent_are_refused(self):
        def extra(v,p,t):(p/'vport2p1').mkdir()
        def wrong_id(v,p,t):(p/'vport2p0').rename(p/'vport2p1')
        def parent(v,p,t):(p/'vport2p0/device').unlink();(p/'vport2p0/device').symlink_to(v/'virtio3')
        for mutate in (extra,wrong_id,parent):self.assertNotEqual(self.run_case(mutate)['result'],0)
if __name__=='__main__':unittest.main()
