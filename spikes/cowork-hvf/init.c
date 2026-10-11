/* Minimal static PID 1: concurrent Linux work, bounded allocation/free/reuse. */
#include <dirent.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/utsname.h>
#include <unistd.h>
#define MIB (1024UL * 1024UL)
static atomic_uint heartbeat = 0;
static void *work(void *unused) {
    (void)unused;
    for (;;) { unsigned n = atomic_fetch_add(&heartbeat, 1) + 1;
        printf("{\"kind\":\"guest_heartbeat\",\"tick\":%u}\n", n); sleep(1); }
}
static void fail(const char *what) {
    printf("{\"kind\":\"guest_failure\",\"operation\":\"%s\"}\n", what); fflush(stdout);
    reboot(RB_POWER_OFF); for (;;) pause();
}
static void text(const char *path, char *buf, size_t size) {
    int fd = open(path, O_RDONLY); if (fd < 0) { snprintf(buf,size,"unavailable"); return; }
    ssize_t n = read(fd,buf,size-1); close(fd); if (n < 0) n=0; buf[n]=0;
    buf[strcspn(buf,"\n")]=0;
}
static void vmstat(unsigned cycle, const char *phase) {
    FILE *file=fopen("/proc/vmstat","r"); if(!file) fail("vmstat");
    char key[100]; unsigned long long value;
    while(fscanf(file,"%99s %llu",key,&value)==2) {
        if(!strcmp(key,"nr_free_pages") || !strcmp(key,"nr_active_anon") || !strcmp(key,"nr_inactive_anon")
           || !strcmp(key,"pgfree") || !strcmp(key,"pgalloc_normal") || !strcmp(key,"pgscan_kswapd")
           || !strcmp(key,"pgsteal_kswapd"))
            printf("{\"kind\":\"guest_vmstat\",\"cycle\":%u,\"phase\":\"%s\",\"metric\":\"%s\",\"value\":%llu}\n",cycle,phase,key,value);
    }
    fclose(file);
}
int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    mkdir("/proc",0755); mkdir("/sys",0755);
    if (mount("proc","/proc","proc",0,NULL) || mount("sysfs","/sys","sysfs",0,NULL)) fail("mount");
    struct utsname u; if (uname(&u)) fail("uname"); char boot[80]; text("/proc/sys/kernel/random/boot_id",boot,sizeof boot);
    printf("{\"kind\":\"linux_boot\",\"release\":\"%s\",\"machine\":\"%s\",\"bootId\":\"%s\"}\n",u.release,u.machine,boot);
    DIR *dir = opendir("/sys/bus/virtio/devices"); if (!dir) fail("virtio inventory"); struct dirent *ent;
    while ((ent = readdir(dir))) { if (ent->d_name[0]=='.') continue; char path[512], device[64], features[200];
        snprintf(path,sizeof path,"/sys/bus/virtio/devices/%s/device",ent->d_name); text(path,device,sizeof device);
        snprintf(path,sizeof path,"/sys/bus/virtio/devices/%s/features",ent->d_name); text(path,features,sizeof features);
        printf("{\"kind\":\"virtio_device\",\"name\":\"%s\",\"device\":\"%s\",\"features\":\"%s\"}\n",ent->d_name,device,features);
    } closedir(dir);
    pthread_t thread; if(pthread_create(&thread,NULL,work,NULL)) fail("heartbeat");
    uint64_t *live = mmap(NULL,32*MIB,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(live==MAP_FAILED) fail("live allocation"); for(size_t i=0;i<32*MIB/8;i++) live[i]=0x5a5a900012345678ULL;
    for(unsigned cycle=1;cycle<=3;cycle++) {
        uint64_t *p=mmap(NULL,256*MIB,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
        if(p==MAP_FAILED) fail("bounded allocation"); const uint64_t value=0x12345678abcdef00ULL+cycle;
        for(size_t i=0;i<256*MIB/8;i++) p[i]=value;
        for(size_t i=0;i<256*MIB/8;i++) if(p[i]!=value) fail("allocated integrity");
        printf("{\"kind\":\"guest_touched\",\"cycle\":%u,\"bytes\":268435456,\"liveBytes\":33554432}\n",cycle);
        vmstat(cycle,"touched");
        sleep(3); if(munmap(p,256*MIB)) fail("free");
        printf("{\"kind\":\"guest_freed\",\"cycle\":%u,\"bytes\":268435456}\n",cycle);
        vmstat(cycle,"freed");
        unsigned before=atomic_load(&heartbeat); sleep(10);
        for(size_t i=0;i<32*MIB/8;i++) if(live[i]!=0x5a5a900012345678ULL) fail("retained integrity");
        if(atomic_load(&heartbeat)<=before) fail("concurrent progress");
        printf("{\"kind\":\"guest_integrity\",\"cycle\":%u,\"retained\":true,\"progress\":true}\n",cycle);
        vmstat(cycle,"after-report-delay");
    }
    printf("{\"kind\":\"guest_complete\",\"cycles\":3,\"activeReturnVerified\":false}\n");
    reboot(RB_POWER_OFF); for (;;) pause();
}
