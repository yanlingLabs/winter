/* Minimal static PID 1: concurrent Linux work, bounded allocation/free/reuse. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <poll.h>

#include "stream_frame_deadline.h"
#include <time.h>
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
#ifdef COWORK_FIXTURE_SERIAL_LOG
#include <stdarg.h>
#include <sys/sysmacros.h>
static int telemetry_fd=-1;
static int fixture_printf(const char *format,...) {
    char line[4096];memcpy(line,"<0>",3);va_list args;va_start(args,format);
    int n=vsnprintf(line+3,sizeof(line)-3,format,args);va_end(args);
    if(n<0 || (size_t)n>=sizeof(line)-3 || telemetry_fd<0) return -1;
    ssize_t written=write(telemetry_fd,line,(size_t)n+3);return written==n+3?n:-1;
}
#define printf fixture_printf
#endif
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
static atomic_uint io_stop=0,io_cycle=0;
static atomic_ullong io_reads=0,io_writes=0,io_flushes=0;
static int io_disks[2]={-1,-1};
#define IO_BYTES (256UL*1024)
static uint64_t pattern(unsigned id,unsigned loop,size_t word){return 0x6a39000000000000ULL ^ ((uint64_t)id<<48) ^ ((uint64_t)loop<<24) ^ word;}
static void *disk_work(void *argument){
    unsigned id=(unsigned)(uintptr_t)argument;int io_disk=io_disks[id];uint64_t *buffer=NULL;if(posix_memalign((void**)&buffer,16384,IO_BYTES))fail("bounded aligned IO buffer");
    unsigned completed=0;for(unsigned loop=0;loop<1400 && !atomic_load(&io_stop);loop++){
        off_t offset=(off_t)(id*4*MIB+(loop%16)*IO_BYTES);for(size_t word=0;word<IO_BYTES/8;word++)buffer[word]=pattern(id,loop,word);
        if(pwrite(io_disk,buffer,IO_BYTES,offset)!=(ssize_t)IO_BYTES)fail("direct block write");atomic_fetch_add(&io_writes,1);
        memset(buffer,0,IO_BYTES);if(pread(io_disk,buffer,IO_BYTES,offset)!=(ssize_t)IO_BYTES)fail("direct block read");atomic_fetch_add(&io_reads,1);
        for(size_t word=0;word<IO_BYTES/8;word++)if(buffer[word]!=pattern(id,loop,word))fail("every-byte disk integrity");
        if(loop%16==0){if(fsync(io_disk))fail("block full sync");atomic_fetch_add(&io_flushes,1);}
        if(loop%16==0)printf("{\"kind\":\"guest_block_progress\",\"thread\":%u,\"cycle\":%u,\"iteration\":%u,\"reads\":%llu,\"writes\":%llu,\"flushes\":%llu,\"direct\":true,\"integrity\":true}\n",id,atomic_load(&io_cycle),loop,atomic_load(&io_reads),atomic_load(&io_writes),atomic_load(&io_flushes));
        completed=loop+1;usleep(40000);
    }
    printf("{\"kind\":\"guest_block_thread_complete\",\"thread\":%u,\"iterations\":%u}\n",id,completed);free(buffer);return NULL;
}

/* Nonsecret raw oracle: each aligned 256-byte span contains every possible byte. */
#define STREAM_FRAME 65536UL
#define STREAM_FRAMES 256UL
static int stream_fd=-1;
static atomic_uint stream_stop=0,tx_backpressured=0;
static int terminal_close_mode=0;
static unsigned char stream_byte(size_t offset,unsigned char salt){return (unsigned char)((offset+37*(offset>>8)+13*(offset>>16))&255)^salt;}
static void *stream_work(void *argument){
    unsigned tx=(unsigned)(uintptr_t)argument;unsigned char *buffer=malloc(STREAM_FRAME);if(!buffer)fail("stream owned buffer");
    unsigned frames=0;size_t bytes=0;unsigned waits=0,short_ops=0,eagain=0;
    /* Initial RX pacing only: it ends before the host first injects verified raw bytes. */
    if(!tx)sleep(2);
    for(unsigned frame=0;frame<STREAM_FRAMES && !atomic_load(&stream_stop);frame++){
        if(tx)for(size_t i=0;i<STREAM_FRAME;i++)buffer[i]=stream_byte(bytes+i,0xa7);
        size_t done=0;struct timespec deadline;if(clock_gettime(CLOCK_MONOTONIC,&deadline))fail("stream clock");deadline.tv_sec+=10;
        while(done<STREAM_FRAME){
            if(terminal_close_mode && atomic_load(&stream_stop))break;
            struct timespec now;if(clock_gettime(CLOCK_MONOTONIC,&now))fail("stream clock");
            if(stream_frame_expired(now,deadline))fail("bounded frame deadline");
            ssize_t n=tx?write(stream_fd,buffer+done,STREAM_FRAME-done):read(stream_fd,buffer+done,STREAM_FRAME-done);int io_errno=errno;
            if(clock_gettime(CLOCK_MONOTONIC,&now))fail("stream clock");
            if(stream_frame_expired(now,deadline))fail("bounded frame deadline");
            if(n>0){if((size_t)n<STREAM_FRAME-done)short_ops++;done+=(size_t)n;continue;}
            if(n==0)fail("stream unexpected EOF");
            if(io_errno!=EAGAIN && io_errno!=EINTR)fail("stream raw IO");
            if(io_errno==EAGAIN){eagain++;if(tx && bytes+done>=MIB && !atomic_exchange(&tx_backpressured,1))printf("{\"kind\":\"guest_generic_tx_backpressure\",\"bytes\":%zu,\"frameOffset\":%zu,\"eagain\":%u,\"heartbeat\":%u,\"reads\":%llu,\"writes\":%llu}\n",bytes,done,eagain,atomic_load(&heartbeat),atomic_load(&io_reads),atomic_load(&io_writes));}
            struct pollfd ready={.fd=stream_fd,.events=tx?POLLOUT:POLLIN};int rc=poll(&ready,1,100);waits++;
            if(rc<0 && errno!=EINTR)fail("stream poll");
            if(rc>0 && ready.revents&(POLLERR|POLLHUP|POLLNVAL))fail("stream terminal poll");

        }
        if(done!=STREAM_FRAME){printf("{\"kind\":\"guest_terminal_partial_stream\",\"direction\":\"%s\",\"completedBytes\":%zu,\"partialAcceptedBytes\":%zu,\"eagain\":%u}\n",tx?"guest-to-host":"host-to-guest",bytes,done,eagain);break;}
        if(!tx)for(size_t i=0;i<STREAM_FRAME;i++)if(buffer[i]!=stream_byte(bytes+i,0x5c))fail("every-byte host to guest oracle");
        bytes+=done;frames++;
        if(frame%8==0)printf("{\"kind\":\"guest_stream_progress\",\"direction\":\"%s\",\"cycle\":%u,\"bytes\":%zu,\"frames\":%u,\"raw\":true,\"integrity\":true}\n",tx?"guest-to-host":"host-to-guest",atomic_load(&io_cycle),bytes,frames);
        /* Initial4MiB burst fills32 guest TX entries while host deliberately refuses reads. */
        if(!tx || frame>=63)usleep(tx?200000:250000);
    }
    printf("{\"kind\":\"guest_stream_complete\",\"direction\":\"%s\",\"bytes\":%zu,\"frames\":%u,\"waits\":%u,\"shortOperations\":%u,\"eagain\":%u,\"raw\":true,\"integrity\":true}\n",tx?"guest-to-host":"host-to-guest",bytes,frames,waits,short_ops,eagain);
    free(buffer);return NULL;
}
#include "generic_port_discovery.h"
static void stream_open(void){
    struct generic_port_identity identity;int discovered=-ENODEV;
    for(unsigned retry=0;retry<50;retry++){
        discovered=generic_port_discover("/sys/bus/virtio/devices","/sys/class/virtio-ports",&identity);
        if(!discovered)break;if(discovered!=-ENODEV && discovered!=-ENOENT)fail("generic port identity");usleep(100000);
    }
    if(discovered)fail("bounded generic port discovery");
    char path[80];if(snprintf(path,sizeof path,"/dev/%s",identity.port)>=(int)sizeof path)fail("generic port path");
    if(mknod(path,S_IFCHR|0600,makedev(identity.major,identity.minor)) && errno!=EEXIST)fail("generic port node");
    struct stat node;if(lstat(path,&node) || !S_ISCHR(node.st_mode) || node.st_rdev!=makedev(identity.major,identity.minor))fail("generic port node identity");
    /* Open includes synchronous control handshake: independent worker supervisor is its backstop. */
    stream_fd=open(path,O_RDWR|O_NOCTTY|O_NONBLOCK|O_CLOEXEC|O_NOFOLLOW);if(stream_fd<0)fail("generic supervisor open");
    if(fstat(stream_fd,&node) || !S_ISCHR(node.st_mode) || node.st_rdev!=makedev(identity.major,identity.minor) || !(fcntl(stream_fd,F_GETFL)&O_NONBLOCK) || isatty(stream_fd))fail("generic open identity/non-TTY");
    errno=0;int duplicate=open(path,O_RDWR|O_NONBLOCK|O_NOCTTY|O_NOFOLLOW|O_CLOEXEC);if(duplicate>=0 || errno!=EBUSY)fail("generic exclusive owner");
    printf("{\"kind\":\"guest_generic_ready\",\"virtioDevice\":\"%s\",\"port\":\"%s\",\"major\":%u,\"minor\":%u,\"portId\":0,\"generic\":true,\"tty\":false,\"nonblocking\":true,\"exclusiveOwner\":true,\"openControlAckReturned\":true,\"queues\":[0,1,2,3],\"multiport\":true}\n",identity.console,identity.port,identity.major,identity.minor);
}
int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    mkdir("/proc",0755); mkdir("/sys",0755);
    if (mount("proc","/proc","proc",0,NULL) || mount("sysfs","/sys","sysfs",0,NULL)) fail("mount");
#ifdef COWORK_FIXTURE_SERIAL_LOG
    /* Upstream PL011 earlycon works, but its FDT does not bind the regular console here.
     * Public guest kmsg writes use that same serial path, without virtio-console RAM threads. */
    if(mknod("/dev/kmsg",S_IFCHR|0600,makedev(1,11)) && access("/dev/kmsg",F_OK)) fail("kmsg node");
    telemetry_fd=open("/dev/kmsg",O_WRONLY);if(telemetry_fd<0) fail("kmsg open");
    printf("{\"kind\":\"guest_telemetry\",\"sink\":\"guest-kmsg-via-PL011-earlycon\",\"regularConsoleOpened\":false}\n");
#endif
    char command_line[512];text("/proc/cmdline",command_line,sizeof command_line);terminal_close_mode=strstr(command_line,"cowork_fixture_terminal_close=1")!=NULL;
    struct utsname u; if (uname(&u)) fail("uname"); char boot[80]; text("/proc/sys/kernel/random/boot_id",boot,sizeof boot);
    printf("{\"kind\":\"linux_boot\",\"release\":\"%s\",\"machine\":\"%s\",\"bootId\":\"%s\"}\n",u.release,u.machine,boot);
    DIR *dir = opendir("/sys/bus/virtio/devices"); if (!dir) fail("virtio inventory"); struct dirent *ent;
    while ((ent = readdir(dir))) { if (ent->d_name[0]=='.') continue; char path[512], device[64], features[200];
        snprintf(path,sizeof path,"/sys/bus/virtio/devices/%s/device",ent->d_name); text(path,device,sizeof device);
        snprintf(path,sizeof path,"/sys/bus/virtio/devices/%s/features",ent->d_name); text(path,features,sizeof features);
        printf("{\"kind\":\"virtio_device\",\"name\":\"%s\",\"device\":\"%s\",\"features\":\"%s\"}\n",ent->d_name,device,features);
    } closedir(dir);
    for(unsigned id=0;id<2;id++){
        char sysfs[80],node[80],device[80];snprintf(sysfs,sizeof sysfs,"/sys/block/vd%c/dev",'a'+id);snprintf(node,sizeof node,"/dev/vd%c",'a'+id);
        text(sysfs,device,sizeof device);unsigned major=0,minor=0;if(sscanf(device,"%u:%u",&major,&minor)!=2)fail("guest block sysfs identity");
        if(mknod(node,S_IFBLK|0600,makedev(major,minor)) && access(node,F_OK))fail("guest block node");
        io_disks[id]=open(node,O_RDWR|O_DIRECT);if(io_disks[id]<0)fail("guest direct disk open");
        printf("{\"kind\":\"guest_workspace_disk\",\"index\":%u,\"node\":\"%s\",\"major\":%u,\"minor\":%u}\n",id,node,major,minor);
    }
    pthread_t io_threads[2];for(unsigned id=0;id<2;id++)if(pthread_create(&io_threads[id],NULL,disk_work,(void*)(uintptr_t)id))fail("IO thread");
    stream_open();pthread_t stream_threads[2];for(unsigned direction=0;direction<2;direction++)if(pthread_create(&stream_threads[direction],NULL,stream_work,(void*)(uintptr_t)direction))fail("stream thread");
    pthread_t thread; if(pthread_create(&thread,NULL,work,NULL)) fail("heartbeat");
    if(terminal_close_mode){
        struct timespec deadline;clock_gettime(CLOCK_MONOTONIC,&deadline);deadline.tv_sec+=8;
        while(!atomic_load(&tx_backpressured) || atomic_load(&heartbeat)<4){struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);if(stream_frame_expired(now,deadline))fail("terminal close backpressure deadline");usleep(10000);}
        atomic_store(&stream_stop,1);for(unsigned direction=0;direction<2;direction++)if(pthread_join(stream_threads[direction],NULL))fail("terminal stream join");
        printf("{\"kind\":\"guest_terminal_close_requested\",\"dataBackpressureObserved\":true,\"streamThreadsJoined\":true,\"heartbeat\":%u,\"reads\":%llu,\"writes\":%llu,\"effectOutcome\":\"UNCERTAIN\"}\n",atomic_load(&heartbeat),atomic_load(&io_reads),atomic_load(&io_writes));
        if(close(stream_fd))fail("terminal generic close");printf("{\"kind\":\"guest_terminal_close_returned\",\"effectOutcome\":\"UNCERTAIN\"}\n");for(;;)pause();
    }
    uint64_t *live = mmap(NULL,32*MIB,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(live==MAP_FAILED) fail("live allocation"); for(size_t i=0;i<32*MIB/8;i++) live[i]=0x5a5a900012345678ULL;
    for(unsigned cycle=1;cycle<=3;cycle++) {
        atomic_store(&io_cycle,cycle);
        uint64_t *p=mmap(NULL,256*MIB,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
        if(p==MAP_FAILED) fail("bounded allocation"); const uint64_t value=0x12345678abcdef00ULL+cycle;
        for(size_t i=0;i<256*MIB/8;i++) if(p[i]!=0) fail("anonymous reuse zero fill");
        for(size_t i=0;i<256*MIB/8;i++) p[i]=value;
        for(size_t i=0;i<256*MIB/8;i++) if(p[i]!=value) fail("allocated integrity");
        printf("{\"kind\":\"guest_reuse\",\"cycle\":%u,\"anonymousZeroFill\":true,\"writtenIntegrity\":true,\"bytes\":268435456}\n",cycle);
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
    atomic_store(&stream_stop,1);for(unsigned direction=0;direction<2;direction++)if(pthread_join(stream_threads[direction],NULL))fail("stream join");sleep(2); /* bounded data-drain grace; supervisor fd remains open through poweroff */
    atomic_store(&io_stop,1);for(unsigned id=0;id<2;id++)if(pthread_join(io_threads[id],NULL))fail("IO join");for(unsigned id=0;id<2;id++){if(fsync(io_disks[id]))fail("final sync");close(io_disks[id]);}
    printf("{\"kind\":\"guest_block_complete\",\"reads\":%llu,\"writes\":%llu,\"flushes\":%llu,\"threadsJoined\":true,\"integrity\":true}\n",atomic_load(&io_reads),atomic_load(&io_writes),atomic_load(&io_flushes));
    printf("{\"kind\":\"guest_generic_shutdown\",\"supervisorPortHeldOpen\":true,\"diskFlushed\":true,\"streamThreadsJoined\":true,\"closeControlSent\":false}\n");
    printf("{\"kind\":\"guest_complete\",\"cycles\":3,\"activeReturnVerified\":false}\n");
    reboot(RB_POWER_OFF); for (;;) pause();
}
