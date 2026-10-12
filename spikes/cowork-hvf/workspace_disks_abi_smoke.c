/* No-VM C ABI probe: disposable files and unstarted libkrun contexts only. */
#include "libkrun.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CAPACITY (16ULL * 1024ULL * 1024ULL)
#define REQUIRE(condition) do { if (!(condition)) { fprintf(stderr,"abi_probe_failed:%d\n",__LINE__); goto cleanup; } } while (0)
static int descriptor_count(void) {
    DIR *directory=opendir("/dev/fd"); if (!directory) return -1;
    int own=dirfd(directory), count=0; struct dirent *entry;
    while ((entry=readdir(directory))) {char *end;long fd=strtol(entry->d_name,&end,10);if (*end=='\0'&&fd>=3&&fd!=own&&fcntl((int)fd,F_GETFD)>=0)count++;}
    closedir(directory);return count;
}
static bool identity(int fd,struct krun_cowork_volume_identity *value) {
    struct stat st;if(fstat(fd,&st)!=0)return false;
    *value=(struct krun_cowork_volume_identity){.device=(uint64_t)st.st_dev,.inode=(uint64_t)st.st_ino,.capacity_bytes=(uint64_t)st.st_size,.uid=st.st_uid,.mode=st.st_mode&07777};return true;
}
int main(void) {
    char root[]="/tmp/winter-workspace-abi-XXXXXX",data_path[256]={0},env_path[256]={0};
    int data=-1,environment=-1,status=1;uint32_t context=0;bool live=false;
    REQUIRE(mkdtemp(root)!=NULL);REQUIRE(snprintf(data_path,sizeof(data_path),"%s/data",root)>0);REQUIRE(snprintf(env_path,sizeof(env_path),"%s/environment",root)>0);
    data=open(data_path,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);environment=open(env_path,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);
    REQUIRE(data>=3&&environment>=3);REQUIRE(ftruncate(data,CAPACITY)==0&&ftruncate(environment,CAPACITY)==0);
    struct krun_cowork_volume_identity di,ei;REQUIRE(identity(data,&di)&&identity(environment,&ei));
    int32_t made=krun_create_ctx();REQUIRE(made>=0);context=(uint32_t)made;live=true;REQUIRE(krun_enable_cowork_block_fixture_reclaim(context)==0);
    int before=descriptor_count();REQUIRE(before>=2);
    struct krun_cowork_volume_identity bad=ei;bad.inode^=1;
    REQUIRE(krun_set_cowork_workspace_disks(context,data,&di,environment,&bad)<0);REQUIRE(descriptor_count()==before);
    REQUIRE(krun_set_cowork_workspace_disks(context,data,&di,data,&di)<0);REQUIRE(descriptor_count()==before);
    REQUIRE(krun_set_cowork_workspace_disks(context,data,&di,environment,&ei)==0);REQUIRE(descriptor_count()==before+2);
    REQUIRE(krun_free_ctx(context)==0);live=false;REQUIRE(descriptor_count()==before);
    REQUIRE(fcntl(data,F_GETFD)>=0&&fcntl(environment,F_GETFD)>=0);
    puts("{\"cAbiIntakeVerified\":true,\"ownedFdCleanupVerified\":true,\"callerFdsRetained\":true,\"vmStarted\":false,\"workerStarted\":false,\"productionReady\":false}");status=0;
cleanup:
    if(live)(void)krun_free_ctx(context);
    if(data>=0)close(data);if(environment>=0)close(environment);
    if(data_path[0])unlink(data_path);if(env_path[0])unlink(env_path);(void)rmdir(root);
    return status;
}
