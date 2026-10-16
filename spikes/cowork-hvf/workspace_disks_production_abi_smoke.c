/* No-VM C ABI probe of the production profile: disposable files and unstarted libkrun contexts only.
 * It never calls krun_start_enter, never creates a VM and calls no Hypervisor.framework function. */
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
#define REQUIRE(condition) do { if (!(condition)) { fprintf(stderr,"production_abi_probe_failed:%d\n",__LINE__); goto cleanup; } } while (0)
_Static_assert(KRUN_COWORK_PRODUCTION_VCPUS == 2, "production vCPU count");
_Static_assert(KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB == 768, "production memory floor");
_Static_assert(KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB == 1024, "production memory ceiling");
_Static_assert(sizeof(struct krun_cowork_volume_identity) == 32, "identity layout");

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
/* The public non-device setters every Cowork context needs, in the order the header documents. */
static bool configure(uint32_t context,uint8_t vcpus,uint32_t memory) {
    return krun_disable_implicit_vsock(context)==0&&krun_disable_implicit_console(context)==0
        &&krun_add_serial_console_default(context,-1,-1)==0
        &&krun_set_kernel(context,"/nonexistent-kernel-never-opened",KRUN_KERNEL_FORMAT_RAW,NULL,NULL)==0
        &&krun_set_vm_config(context,vcpus,memory)==0;
}
int main(void) {
    char root[]="/tmp/winter-production-abi-XXXXXX",data_path[256]={0},env_path[256]={0};
    int data=-1,environment=-1,peer=-1,status=1;uint32_t context=0;bool live=false;
    REQUIRE(mkdtemp(root)!=NULL);REQUIRE(snprintf(data_path,sizeof(data_path),"%s/data",root)>0);REQUIRE(snprintf(env_path,sizeof(env_path),"%s/environment",root)>0);
    data=open(data_path,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);environment=open(env_path,O_RDWR|O_CREAT|O_EXCL|O_CLOEXEC,0600);
    REQUIRE(data>=3&&environment>=3);REQUIRE(ftruncate(data,CAPACITY)==0&&ftruncate(environment,CAPACITY)==0);
    struct krun_cowork_volume_identity di,ei;REQUIRE(identity(data,&di)&&identity(environment,&ei));
    int32_t made=krun_create_ctx();REQUIRE(made>=0);context=(uint32_t)made;live=true;
    int before=descriptor_count();REQUIRE(before>=2);
    /* The gate is not reachable without the production opt-in. */
    REQUIRE(krun_cowork_validate_production_profile(context)<0);REQUIRE(krun_cowork_create_runtime_port(context)<0);
    REQUIRE(krun_cowork_set_workspace_disks(context,data,&di,environment,&ei)<0);REQUIRE(descriptor_count()==before);
    REQUIRE(krun_cowork_enable_production_profile(UINT32_MAX)<0);
    REQUIRE(configure(context,KRUN_COWORK_PRODUCTION_VCPUS,KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB));
    REQUIRE(krun_cowork_enable_production_profile(context)==0);REQUIRE(krun_cowork_enable_production_profile(context)<0);
    REQUIRE(krun_cowork_validate_production_profile(context)<0); /* no runtime port and no pair yet */
    peer=krun_cowork_create_runtime_port(context);REQUIRE(peer>=3);REQUIRE((fcntl(peer,F_GETFD)&FD_CLOEXEC)!=0);
    REQUIRE(krun_cowork_create_runtime_port(context)<0); /* one port only */
    int with_port=descriptor_count();
    struct krun_cowork_volume_identity bad=ei;bad.inode^=1;
    REQUIRE(krun_cowork_set_workspace_disks(context,data,&di,environment,&bad)<0);REQUIRE(descriptor_count()==with_port);
    REQUIRE(krun_cowork_set_workspace_disks(context,data,&di,data,&di)<0);REQUIRE(descriptor_count()==with_port);
    REQUIRE(krun_cowork_validate_production_profile(context)<0); /* still no pair */
    REQUIRE(krun_cowork_set_workspace_disks(context,data,&di,environment,&ei)==0);REQUIRE(descriptor_count()==with_port+2);
    REQUIRE(krun_cowork_validate_production_profile(context)==0);
    /* Explicit limits through the public setters: exactly two vCPUs, 768..1024 MiB. */
    REQUIRE(krun_set_vm_config(context,2,KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB)==0);REQUIRE(krun_cowork_validate_production_profile(context)==0);
    REQUIRE(krun_set_vm_config(context,2,KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB+1)==0);REQUIRE(krun_cowork_validate_production_profile(context)<0);
    REQUIRE(krun_set_vm_config(context,2,KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB-1)==0);REQUIRE(krun_cowork_validate_production_profile(context)<0);
    REQUIRE(krun_set_vm_config(context,3,KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB)==0);REQUIRE(krun_cowork_validate_production_profile(context)<0);
    REQUIRE(krun_set_vm_config(context,1,KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB)==0);REQUIRE(krun_cowork_validate_production_profile(context)<0);
    REQUIRE(krun_set_vm_config(context,KRUN_COWORK_PRODUCTION_VCPUS,KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB)==0);REQUIRE(krun_cowork_validate_production_profile(context)==0);
#if defined(__aarch64__) && defined(__APPLE__)
    /* The shutdown eventfd attaches the PL061 GPIO device, which is not in the admitted inventory. */
    int shutdown=krun_get_shutdown_eventfd(context);REQUIRE(shutdown>=0);
    REQUIRE(krun_cowork_validate_production_profile(context)<0);REQUIRE(close(shutdown)==0);
#endif
    REQUIRE(krun_free_ctx(context)==0);live=false;
    close(peer);peer=-1;REQUIRE(descriptor_count()==before);
    REQUIRE(fcntl(data,F_GETFD)>=0&&fcntl(environment,F_GETFD)>=0);
    puts("{\"productionAbiVerified\":true,\"limitsVerified\":true,\"shutdownDeviceRefused\":true,\"ownedFdCleanupVerified\":true,\"callerFdsRetained\":true,\"vmStarted\":false,\"krunStartEnterCalled\":false,\"workerStarted\":false,\"productionReady\":false}");status=0;
cleanup:
    if(live)(void)krun_free_ctx(context);
    if(peer>=0)close(peer);
    if(data>=0)close(data);if(environment>=0)close(environment);
    if(data_path[0])unlink(data_path);if(env_path[0])unlink(env_path);(void)rmdir(root);
    return status;
}
