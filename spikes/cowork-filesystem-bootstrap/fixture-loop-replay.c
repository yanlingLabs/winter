#define WINTER_REPLAY_LIBRARY
/* Fixture ONLY. No existing loop may be reused or detached. The exact O_EXCL
 * regular image was created by the isolated reviewed test, never selected by guest. */
#include "kernel-journal-replay.c"
#include <linux/loop.h>
#include <sys/file.h>
#include <sys/sysmacros.h>
#include <time.h>
static void retain(void){fprintf(stderr,"{\"retainedStage\":%d,\"errno\":%d}\n",replay_stage,replay_errno);fputs("{\"ownership\":\"retained\",\"metadataMayHaveChanged\":true}\n",stderr);fflush(stderr);for(;;)pause();}
/* Observation only. CLR_FD/replay is never repeated. Time is only a bound,
 * never cleanup evidence; only actual status ENXIO authorizes return. */
static uint64_t monotonic_ms(void){struct timespec now;if(clock_gettime(CLOCK_MONOTONIC,&now))return 0;return (uint64_t)now.tv_sec*1000+(uint64_t)now.tv_nsec/1000000;}
static int observe_detached(const char *device,const struct stat *expected_block,const struct stat *source,uint64_t bytes){
    uint64_t started=monotonic_ms();if(!started)return -1;int pending_reported=0,last_error=0;
    for(unsigned attempts=0;attempts<64;attempts++){
        int fd=open(device,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
        if(fd<0){last_error=errno;if(errno!=ENXIO)return -1;}
        else{
            struct stat current;if(fstat(fd,&current)||!S_ISBLK(current.st_mode)||current.st_rdev!=expected_block->st_rdev){close(fd);errno=ESTALE;return -1;}
            struct loop_info64 status={0};errno=0;int result=ioctl(fd,LOOP_GET_STATUS64,&status),error=errno;close(fd);
            if(result==-1&&error==ENXIO){replay_diagnostic(41,ENXIO);return 0;}
            if(result==-1){errno=error;return -1;}
            /* A different backing association is never ours to touch or wait out. */
            if(status.lo_device!=(uint64_t)source->st_dev||status.lo_inode!=(uint64_t)source->st_ino||status.lo_offset||status.lo_sizelimit!=bytes){errno=ESTALE;return -1;}
            last_error=0;
        }
        if(!pending_reported){replay_diagnostic(41,last_error);pending_reported=1;}
        uint64_t now=monotonic_ms();if(!now||now-started>=3000){errno=ETIMEDOUT;return -1;}
        struct timespec pause_time={0,50000000};if(nanosleep(&pause_time,NULL)&&errno!=EINTR)return -1;
    }
    errno=ETIMEDOUT;return -1;
}
static int uuid_value(const char *text,unsigned char out[16]){
    if(strlen(text)!=36)return -1;
    int at=0;for(int i=0;i<36;){if(i==8||i==13||i==18||i==23){if(text[i++]!='-')return -1;continue;}char byte[3]={text[i],text[i+1],0};for(int j=0;j<2;j++)if(!strchr("0123456789abcdef",byte[j]))return -1;out[at++]=(unsigned char)strtoul(byte,NULL,16);i+=2;}return at==16?0:-1;
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
    replay_diagnostic(32,0);
    struct stat source;int flags=fcntl((int)file,F_GETFL);if(fstat((int)file,&source)||!S_ISREG(source.st_mode)||source.st_uid!=0||source.st_nlink!=1||(source.st_mode&0777)!=0600||(uint64_t)source.st_size!=bytes||(flags&O_ACCMODE)!=O_RDWR||(flags&O_APPEND)||flock((int)file,LOCK_EX|LOCK_NB))return 64;
    replay_diagnostic(33,0);int ctl=open("/dev/loop-control",O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(ctl<0)return 77;
    struct stat control;if(fstat(ctl,&control)||!S_ISCHR(control.st_mode)||major(control.st_rdev)!=10||minor(control.st_rdev)!=237){close(ctl);return 77;}
    replay_diagnostic(34,0);int number=ioctl(ctl,LOOP_CTL_GET_FREE);close(ctl);if(number<0||number>65535)return 77;
    replay_diagnostic(35,0);char device[64];snprintf(device,sizeof device,"/dev/loop%d",number);int loop=open(device,O_RDWR|O_CLOEXEC|O_NOFOLLOW);if(loop<0)return 77;
    struct stat block;if(fstat(loop,&block)||!S_ISBLK(block.st_mode)||major(block.st_rdev)!=7||minor(block.st_rdev)!=(unsigned)number){close(loop);return 77;}
    struct loop_config config={0};config.fd=(uint32_t)file;config.block_size=512;config.info.lo_sizelimit=bytes;config.info.lo_flags=LO_FLAGS_AUTOCLEAR;memcpy(config.info.lo_file_name,"winter-owned-journal-fixture",28);
    /* Atomic unused-device configure; an EBUSY race refuses, never adopts another loop. */
    replay_diagnostic(36,0);if(ioctl(loop,LOOP_CONFIGURE,&config)){close(loop);return 77;}
    replay_diagnostic(37,0);struct loop_info64 association={0};int association_result=ioctl(loop,LOOP_GET_STATUS64,&association),association_error=errno;
    if(association_result||association.lo_device!=(uint64_t)source.st_dev||association.lo_inode!=(uint64_t)source.st_ino||association.lo_offset||association.lo_sizelimit!=bytes||association.lo_flags&LO_FLAGS_READ_ONLY){
        fprintf(stderr,"{\"associationDevice\":%llu,\"expectedDevice\":%llu,\"associationInode\":%llu,\"expectedInode\":%llu,\"associationOffset\":%llu,\"associationCapacity\":%llu,\"expectedCapacity\":%llu,\"associationFlags\":%u}\n",(unsigned long long)association.lo_device,(unsigned long long)source.st_dev,(unsigned long long)association.lo_inode,(unsigned long long)source.st_ino,(unsigned long long)association.lo_offset,(unsigned long long)association.lo_sizelimit,(unsigned long long)bytes,association.lo_flags);
        replay_diagnostic(37,association_result?association_error:ESTALE);retain();
    }
    printf("{\"loopMinor\":%d,\"backingDevice\":\"%llu\",\"backingInode\":\"%llu\"}\n",number,(unsigned long long)source.st_dev,(unsigned long long)source.st_ino);fflush(stdout);
    int result=winter_kernel_journal_replay(loop,uuid,bytes);if(result==-3)retain();
    /* CLR_FD is only a detach request. Close our last opener, then fresh status;
     * the Python owner repeats ENXIO AFTER actual helper reap before file deletion. */
    replay_diagnostic(39,0);if(ioctl(loop,LOOP_CLR_FD)){replay_diagnostic(39,errno);retain();}
    replay_diagnostic(40,0);if(close(loop)){replay_diagnostic(40,errno);retain();}
    replay_diagnostic(41,0);if(observe_detached(device,&block,&source,bytes)){replay_diagnostic(41,errno);retain();}
    replay_diagnostic(42,0);if(fsync((int)file)){replay_diagnostic(42,errno);retain();}
    replay_diagnostic(43,0);
    printf("{\"journalReplay\":\"kernel-mount\",\"mountReleased\":%s,\"loopDetached\":true,\"loopMinor\":%d}\n",result==0?"true":"false",number);fflush(stdout);return result==0?0:77;
}
