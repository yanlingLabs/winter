"""No VM: execute actual C discovery against synthetic sysfs trees and bounded open probes."""
import json,os,subprocess,tempfile,unittest
from pathlib import Path
from build import ROOT

HARNESS=r'''
#include <assert.h>
#include <sys/stat.h>
#include "stream_hvc_discovery.h"
static unsigned active,diagnostics,unused;static int owned[8],owned_count;
static int probe(const char *name,unsigned index,unsigned major,unsigned minor,void *opaque){
 (void)name;(void)major;(void)minor;(void)opaque;
 if(active==256)return -EACCES;if(!(active&(1U<<index)))return -ENODEV;
 int fd=open("/dev/null",O_RDONLY);assert(fd>=0);owned[owned_count++]=fd;return fd;
}
static void diagnostic(unsigned index,unsigned major,unsigned minor,int outcome,void *opaque){
 (void)index;(void)major;(void)minor;(void)opaque;diagnostics++;if(outcome==-ENODEV)unused++;
}
int main(int argc,char **argv){
 assert(argc==5);active=(unsigned)strtoul(argv[4],NULL,10);struct stream_hvc_identity identity;
 int result=stream_discover_hvc(argv[1],argv[2],argv[3],probe,diagnostic,NULL,&identity);
 if(identity.fd>=0)close(identity.fd);
 for(int i=0;i<owned_count;i++){errno=0;assert(fcntl(owned[i],F_GETFD)==-1 && errno==EBADF);}
 printf("{\"result\":%d,\"slots\":%u,\"connected\":%u,\"diagnostics\":%u,\"unused\":%u,\"console\":\"%s\",\"port\":\"%s\"}\n",result,identity.class_slots,identity.connected_slots,diagnostics,unused,identity.console,identity.port);return 0;
}'''

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
            features=''.join('1' if bit==32 else '0' for bit in range(128));(node/'features').write_text(features+'\n');(node/'driver').symlink_to(driver)
        port=ports/'vport2p0';port.mkdir();(port/'device').symlink_to(virtio/'virtio2')
        for index in range(8):
            slot=tty/f'hvc{index}';slot.mkdir();(slot/'dev').write_text(f'229:{index}\n')
        return virtio,ports,tty
    def run_case(self,mutate=lambda v,p,t:None,active=1):
        with tempfile.TemporaryDirectory() as name:
            roots=self.fixture(Path(name));mutate(*roots)
            result=subprocess.run([str(self.binary),*(str(root) for root in roots),str(active)],capture_output=True,text=True,check=True,timeout=2)
            return json.loads(result.stdout)
    def test_eight_registered_slots_one_connected_port_is_accepted(self):
        result=self.run_case();self.assertEqual(result['result'],0);self.assertEqual(result['slots'],8);self.assertEqual(result['connected'],1);self.assertEqual(result['unused'],7);self.assertEqual(result['port'],'vport2p0')
    def test_two_connected_hvc_instances_are_refused_and_closed(self):self.assertNotEqual(self.run_case(active=3)['result'],0)
    def test_zero_connected_hvc_is_refused(self):self.assertNotEqual(self.run_case(active=0)['result'],0)
    def test_connected_wrong_hvc_index_is_refused(self):self.assertNotEqual(self.run_case(active=2)['result'],0)
    def test_unexpected_open_error_is_refused(self):self.assertNotEqual(self.run_case(active=256)['result'],0)
    def test_second_virtio_console_is_refused(self):
        def mutate(v,p,t):(v/'virtio3/device').write_text('0x0003\n')
        self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_multiport_feature_is_refused(self):
        def mutate(v,p,t):
            value=list((v/'virtio2/features').read_text());value[1]='1';(v/'virtio2/features').write_text(''.join(value))
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
    def test_wrong_hvc_device_numbers_and_extra_class_slot_are_refused(self):
        def wrong_dev(v,p,t):(t/'hvc0/dev').write_text('1:0\n')
        def wrong_minor(v,p,t):(t/'hvc1/dev').write_text('229:0\n')
        def extra(v,p,t):(t/'hvc8').mkdir();(t/'hvc8/dev').write_text('229:8\n')
        for mutate in (wrong_dev,wrong_minor,extra):self.assertNotEqual(self.run_case(mutate)['result'],0)
    def test_incomplete_or_malformed_hvc_class_roster_is_refused(self):
        def missing(v,p,t):(t/'hvc7/dev').unlink();(t/'hvc7').rmdir()
        def malformed(v,p,t):(t/'hvc7').rename(t/'hvc7bad')
        for mutate in (missing,malformed):self.assertNotEqual(self.run_case(mutate)['result'],0)

if __name__=='__main__':unittest.main()
