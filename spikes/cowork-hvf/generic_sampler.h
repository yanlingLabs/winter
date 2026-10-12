/* Fixture-only host sampler channel. No path open or libkrun/guest descriptor injection. */
#ifndef COWORK_GENERIC_SAMPLER_H
#define COWORK_GENERIC_SAMPLER_H
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static int generic_sampler_admit(const char *argument, int control_fd) {
    if (!argument || !*argument) { errno=EINVAL; return -1; }
    if (argument[0]=='0') { errno=EINVAL; return -1; }
    for (const char *p=argument;*p;p++) if (*p<'0' || *p>'9') { errno=EINVAL; return -1; }
    char *end=NULL; errno=0; long number=strtol(argument,&end,10);
    if (errno || !end || *end || number<3 || number>=1024 || number==control_fd) { errno=EINVAL; return -1; }
    int fd=(int)number,flags=fcntl(fd,F_GETFL),descriptor=fcntl(fd,F_GETFD);
    struct stat st,out,err;
    if (flags<0 || descriptor<0 || descriptor!=0 || (flags&O_ACCMODE)!=O_WRONLY ||
        fstat(fd,&st)!=0 || !S_ISFIFO(st.st_mode) || st.st_nlink!=0 || st.st_uid!=getuid() ||
        fstat(STDOUT_FILENO,&out)!=0 || fstat(STDERR_FILENO,&err)!=0 ||
        (st.st_dev==out.st_dev && st.st_ino==out.st_ino) ||
        (st.st_dev==err.st_dev && st.st_ino==err.st_ino)) { errno=EINVAL; return -1; }
    /* Popen clears CLOEXEC only for the two explicit inherited descriptors. Restore it here,
     * before sandbox/library entry; nonblocking logging can never stall a guest/device thread. */
    if (fcntl(fd,F_SETFD,FD_CLOEXEC)!=0 || fcntl(fd,F_SETFL,flags|O_NONBLOCK)!=0) return -1;
    return fd;
}
static int generic_sampler_emit(int fd, pid_t pid, uint64_t footprint, uint64_t resident) {
    char line[512];
    int count=snprintf(line,sizeof line,"{\"kind\":\"host_memory\",\"pid\":%d,\"footprintBytes\":%llu,\"residentBytes\":%llu}\n",
                       (int)pid,(unsigned long long)footprint,(unsigned long long)resident);
    if (count<0 || (size_t)count>=sizeof line) { errno=EOVERFLOW; return -1; }
    ssize_t written;
    do { written=write(fd,line,(size_t)count); } while (written<0 && errno==EINTR);
    if (written!=count) { if (written>=0) errno=EIO; return -1; }
    return 0;
}
#endif
