"""No VM/libkrun: actual native C sampler writer, fragmented trace flood and bounded pipe capture."""
import dataclasses,json,os,socket,subprocess,sys,tempfile,unittest
from pathlib import Path
from generic_capture import Limits,capture_owned_child
from build import ROOT

HARNESS=r'''
#include "generic_sampler.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#ifdef __APPLE__
#include <sandbox.h>
#endif
#include <string.h>
static int sampler;
static void *samples(void *unused) {
 (void)unused;
 for(unsigned n=0;n<20000;n++) {
  while(generic_sampler_emit(sampler,getpid(),n,n+1)!=0) { assert(errno==EAGAIN);usleep(100); }
 }
 return NULL;
}
static void *traces(void *unused) {
 (void)unused;
 for(unsigned n=0;n<20000;n++) {
  fprintf(stderr,"{\"kind\":\"");sched_yield();
  fprintf(stderr,"block_used_ack\",\"request\":%u",n);sched_yield();
  fprintf(stderr,",\"success\":true}\n");
 }
 return NULL;
}
int main(int argc,char **argv) {
 assert(argc==3);alarm(10);
 if(!strcmp(argv[1],"pre-cloexec"))assert(fcntl(atoi(argv[2]),F_SETFD,FD_CLOEXEC)==0);
 sampler=generic_sampler_admit(argv[2],!strcmp(argv[1],"control")?atoi(argv[2]):-1);
 if(strcmp(argv[1],"flood")) {
  if(sampler<0)return 42;
  assert(fcntl(sampler,F_GETFD)==FD_CLOEXEC);
  assert(fcntl(sampler,F_GETFL)&O_NONBLOCK);
#ifdef __APPLE__
  if(!strcmp(argv[1],"sandbox")){char *error=NULL;assert(sandbox_init("(version 1)(deny default)",0,&error)==0);}
#endif
  assert(generic_sampler_emit(sampler,getpid(),1,2)==0);close(sampler);return 0;
 }
 assert(sampler>=3);pthread_t a,b;
 assert(pthread_create(&a,NULL,samples,NULL)==0);assert(pthread_create(&b,NULL,traces,NULL)==0);
 assert(pthread_join(a,NULL)==0);assert(pthread_join(b,NULL)==0);close(sampler);
 puts("{\"kind\":\"flood_complete\"}");return 0;
}'''
class SamplerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root=tempfile.TemporaryDirectory();base=Path(cls.root.name);source=base/'sampler.c';source.write_text(HARNESS);cls.binary=base/'sampler'
        subprocess.run(['/usr/bin/clang','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations','-pthread','-I',str(ROOT),str(source),'-o',str(cls.binary)],check=True,timeout=15)
    @classmethod
    def tearDownClass(cls):cls.root.cleanup()
    def spawn(self,program=None,limits=Limits(run_seconds=15)):
        with tempfile.TemporaryDirectory() as name:
            directory=Path(name);read,write=os.pipe();sampler=os.fdopen(read,'rb',buffering=0);child=None
            try:
                command=[str(self.binary),'flood',str(write)] if program is None else ['/usr/bin/python3','-c',program,str(write)]
                child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(write,),close_fds=True,bufsize=0)
                os.close(write);write=None
                rows,result=capture_owned_child(child,directory,limits=limits,sampler=sampler)
                raw={channel:(directory/(channel+'.log')).read_bytes() for channel in ['stdout','stderr','sampler']}
                self.assertIsNotNone(child.poll());self.assertTrue(result['readerThreadsJoined']);return rows,result,raw
            finally:
                if child is not None:
                    if child.poll() is None:child.kill();child.wait(timeout=2)
                    child.stdout.close();child.stderr.close()
                sampler.close()
                if write is not None:os.close(write)
    def test_capture_limits_match_frozen_stream_v2_without_raising_any_bound(self):
        from stream_capture_v2 import Limits as FrozenLimits
        self.assertEqual(vars(Limits()),vars(FrozenLimits()))

    def test_concurrent_native_fragmented_trace_and_sampler_flood_remain_exact(self):
        rows,result,raw=self.spawn()
        self.assertEqual(result['exitCode'],0);self.assertTrue(result['captureComplete']);self.assertEqual(result['readerThreadsStarted'],3)
        samples=[row for row in rows if row['channel']=='sampler'];trace=[row for row in rows if row['channel']=='stderr']
        self.assertEqual([row['footprintBytes'] for row in samples],list(range(20000)))
        self.assertEqual([row['request'] for row in trace],list(range(20000)))
        self.assertEqual(result['malformedJsonLines'],{'stdout':0,'stderr':0,'sampler':0});self.assertEqual(len(rows),40001);self.assertNotIn(b'host_memory',raw['stderr']);self.assertNotIn(b'block_used_ack',raw['sampler'])
        for channel in ['stderr','sampler']:
            self.assertEqual(len(raw[channel].splitlines()),20000)
            for line in raw[channel].splitlines():self.assertIsInstance(json.loads(line),dict)
    def test_sampler_overflow_obeys_same_channel_total_line_and_row_bounds(self):
        for changed in [{'channel_bytes':512},{'total_bytes':512},{'line_bytes':32},{'parsed_rows':3}]:
            limits=dataclasses.replace(Limits(),run_seconds=2,normal_wait_seconds=.1,kill_wait_seconds=1,reader_join_seconds=.2,chunk_bytes=128,**changed)
            _,result,raw=self.spawn('import os,sys\nfor n in range(10000):os.write(int(sys.argv[1]),b\'{"kind":"host_memory","footprintBytes":123}\\n\')',limits)
            self.assertTrue(result['captureOverflow']);self.assertTrue(result['killIssued'])
            self.assertLessEqual(len(raw['sampler']),limits.channel_bytes);self.assertLessEqual(sum(map(len,raw.values())),limits.total_bytes)
            self.assertLessEqual(result['parsedRows'],limits.parsed_rows)
    def test_malformed_sampler_json_is_preserved_and_counted_without_repair(self):
        rows,result,raw=self.spawn('import os,sys;os.write(int(sys.argv[1]),b\'{"kind":"broken\\n\')')
        self.assertEqual(rows,[]);self.assertEqual(result['malformedJsonLines']['sampler'],1)
        self.assertEqual(raw['sampler'],b'{"kind":"broken\n');self.assertTrue(result['captureComplete'])

    @unittest.skipUnless(sys.platform=='darwin','Seatbelt fixture admission uses macOS')
    def test_inherited_sampler_pipe_writes_under_deny_default_without_extra_path_rights(self):
        read,write=os.pipe()
        try:
            child=subprocess.run([str(self.binary),'sandbox',str(write)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(write,),timeout=2)
            self.assertEqual((child.returncode,child.stdout,child.stderr),(0,b'',b''));self.assertIn(b'host_memory',os.read(read,512))
        finally:os.close(read);os.close(write)

    def test_descriptor_admits_only_exact_write_pipe_and_restores_cloexec(self):
        read,write=os.pipe()
        try:
            child=subprocess.Popen([str(self.binary),'admit',str(write)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(write,))
            out,err=child.communicate(timeout=2);self.assertEqual((child.returncode,out,err),(0,b'',b''));self.assertIn(b'host_memory',os.read(read,512))
            for argument,fd in [('2',None),(str(read),read),('3extra',None)]:
                child=subprocess.run([str(self.binary),'admit',argument],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(() if fd is None else (fd,)),timeout=2)
                self.assertEqual(child.returncode,42)
            with tempfile.TemporaryFile() as file:
                child=subprocess.run([str(self.binary),'admit',str(file.fileno())],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(file.fileno(),),timeout=2)
                self.assertEqual(child.returncode,42)
            for mode in ['pre-cloexec','control']:
                child=subprocess.run([str(self.binary),mode,str(write)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(write,),timeout=2)
                self.assertEqual(child.returncode,42)
            child=subprocess.run([str(self.binary),'admit',str(write)],stdout=subprocess.PIPE,stderr=write,pass_fds=(write,),timeout=2)
            self.assertEqual(child.returncode,42) # Duplicate stderr alias is not a separate sampler channel.
            a,b=socket.socketpair()
            try:
                child=subprocess.run([str(self.binary),'admit',str(a.fileno())],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(a.fileno(),),timeout=2)
                self.assertEqual(child.returncode,42)
            finally:a.close();b.close()
            with tempfile.TemporaryDirectory() as name:
                path=Path(name)/'named';os.mkfifo(path);r=os.open(path,os.O_RDONLY|os.O_NONBLOCK);w=os.open(path,os.O_WRONLY|os.O_NONBLOCK)
                try:
                    child=subprocess.run([str(self.binary),'admit',str(w)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(w,),timeout=2)
                    self.assertEqual(child.returncode,42)
                finally:os.close(r);os.close(w)
        finally:os.close(read);os.close(write)

if __name__=='__main__':unittest.main()
