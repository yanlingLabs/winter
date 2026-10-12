"""Exact C observation algorithm with injected syscalls; no loop/helper/mount launch.
This verifies evidence predicates/bounds, not actual Linux cleanup or admission.
"""
import shutil,subprocess,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).parent
class DetachObservationTests(unittest.TestCase):
    def test_c_observation_requires_actual_enxio_and_never_repeats_effects(self):
        compiler=shutil.which('cc')
        if not compiler:self.skipTest('existing local C compiler unavailable')
        source=(ROOT/'fixture-loop-replay.c').read_text();start=source.index('static int observe_detached(');end=source.index('static int uuid_value(',start);function=source[start:end]
        prelude=r'''
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdarg.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <fcntl.h>
#define LOOP_GET_STATUS64 0x4c05
struct loop_info64 { uint64_t lo_device,lo_inode,lo_offset,lo_sizelimit; };
static int scenario,opens,reads,sleeps;static uint64_t now;
static uint64_t monotonic_ms(void){return now;}
static void replay_diagnostic(int stage,int error){assert(stage==41);(void)error;}
static int mock_open(const char *path,int flags,...){assert(!strcmp(path,"owned-device"));assert(flags&O_NOFOLLOW);opens++;if(scenario==5||(scenario==4&&opens==1)){errno=ENXIO;return -1;}return 7;}
static int mock_close(int fd){assert(fd==7);return 0;}
static int mock_fstat(int fd,struct stat *out){assert(fd==7);memset(out,0,sizeof *out);out->st_mode=S_IFBLK;out->st_rdev=scenario==6?2:1;return 0;}
static int mock_ioctl(int fd,int operation,struct loop_info64 *out){assert(fd==7&&operation==LOOP_GET_STATUS64);reads++;if(scenario==0||scenario==4||(scenario==1&&reads==3)){errno=ENXIO;return -1;}if(scenario==7){errno=EIO;return -1;}*out=(struct loop_info64){9,10,0,16777216};if(scenario==3)out->lo_inode++;return 0;}
static int mock_sleep(const struct timespec *delay,struct timespec *left){assert(delay->tv_sec==0&&delay->tv_nsec==50000000);(void)left;sleeps++;now+=50;return 0;}
#define open mock_open
#define close mock_close
#define fstat mock_fstat
#define ioctl mock_ioctl
#define nanosleep mock_sleep
'''
        main=r'''
int main(void){struct stat block={0},source={0};block.st_rdev=1;source.st_dev=9;source.st_ino=10;
for(scenario=0;scenario<8;scenario++){opens=reads=sleeps=0;now=1;errno=0;int result=observe_detached("owned-device",&block,&source,16777216);
if(scenario==0){assert(result==0&&reads==1&&sleeps==0);}
if(scenario==1){assert(result==0&&reads==3&&sleeps==2);}
if(scenario==2||scenario==5){assert(result==-1&&errno==ETIMEDOUT&&sleeps==60&&reads==(scenario==2?61:0));}
if(scenario==3||scenario==6){assert(result==-1&&errno==ESTALE&&sleeps==0);}
if(scenario==4){assert(result==0&&opens==2&&reads==1&&sleeps==1);}
if(scenario==7){assert(result==-1&&errno==EIO&&sleeps==0);}}
return 0;}
'''
        with tempfile.TemporaryDirectory(prefix='winter-detach-noeffect-') as directory:
            code=Path(directory)/'observation.c';executable=Path(directory)/'observation';code.write_text(prelude+function+main)
            result=subprocess.run([compiler,'-std=c11','-D_DEFAULT_SOURCE','-O2','-Wall','-Wextra','-Werror',str(code),'-o',str(executable)],capture_output=True,text=True,timeout=30);self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(executable)],capture_output=True,text=True,timeout=5);self.assertEqual(result.returncode,0,result.stderr)
if __name__=='__main__':unittest.main(verbosity=2)
