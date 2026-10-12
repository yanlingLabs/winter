#define WINTER_REPLAY_LIBRARY
/* Fixture ONLY. No existing loop may be reused or detached. The exact O_EXCL
 * regular image was created by the isolated reviewed test, never selected by guest. */
#include "kernel-journal-replay.c"
#include <linux/loop.h>
#include <sys/file.h>
#include <sys/sysmacros.h>
static void retain(void){fputs("{\"ownership\":\"retained\",\"metadataMayHaveChanged\":true}\n",stderr);fflush(stderr);for(;;)pause();}
static int uuid_value(const char *text,unsigned char out[16]){
    if(strlen(text)!=36)return -1;int at=0;for(int i=0;i<36;){if(i==8||i==13||i==18||i==23){if(text[i++]!='-')return -1;continue;}char byte[3]={text[i],text[i+1],0};for(int j=0;j<2;j++)if(!strchr("0123456789abcdef",byte[j]))return -1;out[at++]=(unsigned char)strtoul(byte,NULL,16);i+=2;}return at==16?0:-1;
}
int main(int argc,char **argv){
    if(geteuid()!=0||argc!=7||strcmp(argv[1],"--image-fd")||strcmp(argv[3],"--uuid")||strcmp(argv[5],"--capacity"))return 64;
    char *end;long file=strtol(argv[2],&end,10);if(*end||file<3||file>65535)return 64;uint64_t bytes=strtoull(argv[6],&end,10);unsigned char uuid[16];if(*end||uuid_value(argv[4],uuid))return 64;
    /* Independent open description is essential: flock on an inherited dup would
     * share the caller's lock and incorrectly admit concurrent fixture helpers. */
    char pinned[64];snprintf(pinned,sizeof pinned,"/proc/self/fd/%ld",file);struct stat original,reopened;
    if(fstat((int)file,&original))return 64;
    int own=open(pinned,O_RDWR|O_CLOEXEC);if(own<0||fstat(own,&reopened)||original.st_dev!=reopened.st_dev||original.st_ino!=reopened.st_ino)return 64;
    close((int)file);file=own;
    struct stat source;int flags=fcntl((int)file,F_GETFL);if(fstat((int)file,&source)||!S_ISREG(source.st_mode)||source.st_uid!=0||source.st_nlink!=1||(source.st_mode&0777)!=0600||(uint64_t)source.st_size!=bytes||(flags&O_ACCMODE)!=O_RDWR||(flags&O_APPEND)||flock((int)file,LOCK_EX|LOCK_NB))return 64;
    int ctl=open("/dev/loop-control",O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(ctl<0)return 77;
    struct stat control;if(fstat(ctl,&control)||!S_ISCHR(control.st_mode)||major(control.st_rdev)!=10||minor(control.st_rdev)!=237){close(ctl);return 77;}
    int number=ioctl(ctl,LOOP_CTL_GET_FREE);close(ctl);if(number<0||number>65535)return 77;
    char device[64];snprintf(device,sizeof device,"/dev/loop%d",number);int loop=open(device,O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(loop<0)return 77;
    struct stat block;if(fstat(loop,&block)||!S_ISBLK(block.st_mode)||major(block.st_rdev)!=7||minor(block.st_rdev)!=(unsigned)number){close(loop);return 77;}
    struct loop_config config={0};config.fd=(uint32_t)file;config.block_size=512;config.info.lo_sizelimit=bytes;config.info.lo_flags=LO_FLAGS_AUTOCLEAR;memcpy(config.info.lo_file_name,"winter-owned-journal-fixture",28);
    /* Atomic unused-device configure; an EBUSY race refuses, never adopts another loop. */
    if(ioctl(loop,LOOP_CONFIGURE,&config)){close(loop);return 77;}
    struct loop_info64 association={0};if(ioctl(loop,LOOP_GET_STATUS64,&association)||association.lo_device!=(uint64_t)source.st_dev||association.lo_inode!=(uint64_t)source.st_ino||association.lo_offset||association.lo_sizelimit!=bytes||association.lo_flags&LO_FLAGS_READ_ONLY)retain();
    printf("{\"loopMinor\":%d,\"backingDevice\":\"%llu\",\"backingInode\":\"%llu\"}\n",number,(unsigned long long)source.st_dev,(unsigned long long)source.st_ino);fflush(stdout);
    int result=winter_kernel_journal_replay(loop,uuid,bytes);if(result==-3)retain();
    /* CLR_FD is only a detach request. Close our last opener, then fresh status;
     * the Python owner repeats ENXIO AFTER actual helper reap before file deletion. */
    if(ioctl(loop,LOOP_CLR_FD)||close(loop))retain();
    loop=open(device,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(loop<0)retain();
    errno=0;int status=ioctl(loop,LOOP_GET_STATUS64,&association),saved=errno;close(loop);if(status!=-1||saved!=ENXIO)retain();
    if(fsync((int)file))retain();
    printf("{\"journalReplay\":\"kernel-mount\",\"mountReleased\":%s,\"loopDetached\":true,\"loopMinor\":%d}\n",result==0?"true":"false",number);fflush(stdout);return result==0?0:77;
}
