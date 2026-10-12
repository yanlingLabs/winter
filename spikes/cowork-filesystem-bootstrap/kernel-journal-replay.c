#define _GNU_SOURCE
/* Immutable protected-bootstrap helper: one admitted block FD, never a pathname.
 * Scope/old-writer/one-shot admission remains the controller's obligation. */
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

/* -1: refused before mount; -2: failed mount may have changed metadata;
 * -3: mounted lifetime retained; caller MUST stay alive/hold namespace+FDs. */
static uint16_t le16(const unsigned char *p){return (uint16_t)p[0]|(uint16_t)p[1]<<8;}
static uint32_t le32(const unsigned char *p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
/* Fixed scalar stages only: never paths, volume bytes or credentials. */
static int replay_stage,replay_errno;
static void replay_diagnostic(int stage,int error){replay_stage=stage;replay_errno=error;fprintf(stderr,"{\"replayStage\":%d,\"errno\":%d}\n",stage,error);fflush(stderr);}
static int replay_failure(int result){int error=errno;replay_diagnostic(replay_stage,error);return result;}
int winter_kernel_journal_replay(int fd,const unsigned char uuid[16],uint64_t capacity){
    struct stat identity;uint64_t bytes;int sector,flags;unsigned char sb[1024];
    replay_diagnostic(1,0);
    if(geteuid()!=0||fd<3||fstat(fd,&identity)||!S_ISBLK(identity.st_mode)||(flags=fcntl(fd,F_GETFL))<0||(flags&O_ACCMODE)!=O_RDWR||(flags&O_APPEND)||ioctl(fd,BLKGETSIZE64,&bytes)||ioctl(fd,BLKSSZGET,&sector)||sector!=512||bytes!=capacity||capacity<16777216||capacity>274877906944ULL||capacity%4096||pread(fd,sb,sizeof sb,1024)!=sizeof sb)return replay_failure(-1);
    replay_diagnostic(2,0);uint64_t blocks=(uint64_t)le32(sb+4)|((uint64_t)le32(sb+0x150)<<32);
    if(le16(sb+0x38)!=0xef53||le16(sb+0x3a)!=1||le32(sb+0x18)!=2||blocks!=capacity/4096||memcmp(sb+0x68,uuid,16)||le32(sb+0x5c)!=0x24||le32(sb+0x60)!=0x2c6||le32(sb+0x64)!=0x46b||le32(sb+0xe0)==0||le32(sb+0xe4)!=0){errno=EINVAL;return replay_failure(-1);}
    replay_diagnostic(3,0);if(unshare(CLONE_NEWNS))return replay_failure(-1);
    replay_diagnostic(4,0);if(mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL))return replay_failure(-1);
    char mountpoint[]="/run/winter-journal-replay-XXXXXX",source[64];
    replay_diagnostic(5,0);if(!mkdtemp(mountpoint))return replay_failure(-1);
    snprintf(source,sizeof source,"/proc/self/fd/%d",fd);
    replay_diagnostic(6,0);if(mount(source,mountpoint,"ext4",MS_NOSUID|MS_NODEV|MS_NOEXEC|MS_NOATIME,"errors=remount-ro,noinit_itable")){int error=errno;rmdir(mountpoint);errno=error;return replay_failure(-2);}
    replay_diagnostic(7,0);int mounted=open(mountpoint,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(mounted<0)return replay_failure(-3);
    replay_diagnostic(8,0);int synced=syncfs(mounted),sync_error=errno;close(mounted);if(synced){errno=sync_error;return replay_failure(-3);}
    /* No lazy/forced unmount. Failure retains the exact namespace and mount. */
    replay_diagnostic(9,0);if(umount2(mountpoint,0))return replay_failure(-3);
    replay_diagnostic(10,0);if(fsync(fd))return replay_failure(-2);
    replay_diagnostic(11,0);if(rmdir(mountpoint))return replay_failure(-2);
    replay_diagnostic(12,0);return 0;
}
#ifndef WINTER_REPLAY_LIBRARY
static int parse_uuid(const char *text,unsigned char uuid[16]){
    if(strlen(text)!=36)return -1;
    int at=0;
    for(int i=0;i<36;){if(i==8||i==13||i==18||i==23){if(text[i++]!='-')return -1;continue;}char byte[3]={text[i],text[i+1],0},*end;for(int j=0;j<2;j++)if(!strchr("0123456789abcdef",byte[j]))return -1;uuid[at++]=(unsigned char)strtoul(byte,&end,16);if(*end)return -1;i+=2;}return at==16?0:-1;
}
int main(int argc,char **argv){
    if(argc!=7||strcmp(argv[1],"--device-fd")||strcmp(argv[3],"--uuid")||strcmp(argv[5],"--capacity"))return 64;
    char *end;long fd=strtol(argv[2],&end,10);if(*end||fd<3||fd>65535)return 64;
    uint64_t bytes=strtoull(argv[6],&end,10);if(*end)return 64;unsigned char uuid[16];if(parse_uuid(argv[4],uuid))return 64;
    int result=winter_kernel_journal_replay((int)fd,uuid,bytes);
    if(result==-3){fprintf(stderr,"{\"retainedStage\":%d,\"errno\":%d}\n",replay_stage,replay_errno);fputs("{\"journalReplay\":\"kernel-mount\",\"ownership\":\"retained\",\"metadataMayHaveChanged\":true}\n",stderr);fflush(stderr);for(;;)pause();}
    if(result){fputs("{\"journalReplay\":\"kernel-mount\",\"outcome\":\"failed\",\"metadataMayHaveChanged\":true}\n",stderr);return 77;}
    puts("{\"journalReplay\":\"kernel-mount\",\"mountReleased\":true}");return 0;
}
#endif
