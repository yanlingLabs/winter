#include "key_broker_native.h"
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <sandbox.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <poll.h>
#include <errno.h>
#include <string.h>
#include <dirent.h>
#include <time.h>
#include <stdlib.h>

static int flags(int fd) { return fcntl(fd,F_SETFD,FD_CLOEXEC)==0?0:-1; }
int kb_pipe(int fds[2]) { if(pipe(fds))return -1;if(flags(fds[0])||flags(fds[1])){close(fds[0]);close(fds[1]);return -1;}return 0; }
int kb_channel(int fds[2]) { if(socketpair(AF_UNIX,SOCK_DGRAM,0,fds))return -1;if(flags(fds[0])||flags(fds[1])){close(fds[0]);close(fds[1]);return -1;}return 0; }
int kb_spawn_suspended(const char *path,const char *mode,int input,int output,pid_t *pid) {
    posix_spawn_file_actions_t actions;posix_spawnattr_t attributes;
    int rc=posix_spawn_file_actions_init(&actions);if(rc)return rc;
    rc=posix_spawnattr_init(&attributes);if(rc){posix_spawn_file_actions_destroy(&actions);return rc;}
    if(!(rc=posix_spawnattr_setflags(&attributes,POSIX_SPAWN_CLOEXEC_DEFAULT|POSIX_SPAWN_START_SUSPENDED)) &&
       !(rc=posix_spawn_file_actions_addopen(&actions,0,"/dev/null",O_RDONLY,0)) &&
       !(rc=posix_spawn_file_actions_adddup2(&actions,input,3)) &&
       !(rc=posix_spawn_file_actions_adddup2(&actions,output,1)) &&
       !(rc=posix_spawn_file_actions_addopen(&actions,2,"/dev/null",O_WRONLY,0))) {
        char *argv[]={(char *)path,(char *)mode,NULL};
        // No inherited BUN_BE_BUN, DYLD injection, HOME or provider secrets.
        char *env[]={"LC_ALL=C","LANG=C",NULL};
        rc=posix_spawn(pid,path,&actions,&attributes,argv,env);
    }
    posix_spawnattr_destroy(&attributes);posix_spawn_file_actions_destroy(&actions);return rc;
}
int kb_resume(pid_t pid) { return kill(pid,SIGCONT); }
int kb_wait_owned(pid_t pid,int milliseconds) {
    // Caller supplies only an OwnedChild PID, never an RPC PID. Timeout kills
    // and reaps that child, so no unowned suspended/fixture process is abandoned.
    int status=0;struct timespec tick={0,1000000};
    for(int i=0;i<milliseconds;i++){pid_t result=waitpid(pid,&status,WNOHANG);if(result==pid)return WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);if(result<0 && errno!=EINTR)return -1;nanosleep(&tick,NULL);}
    kill(pid,SIGKILL);while(waitpid(pid,&status,0)<0 && errno==EINTR){}return -2;
}
static int ready(int fd,int milliseconds){struct pollfd p={fd,POLLIN,0};int rc;do{rc=poll(&p,1,milliseconds);}while(rc<0 && errno==EINTR);return rc>0?0:-1;}
int kb_recv_packet(int fd,void *bytes,size_t capacity,int milliseconds){if(ready(fd,milliseconds))return -1;ssize_t size=recv(fd,bytes,capacity,MSG_TRUNC);return size>0 && (size_t)size<=capacity?(int)size:-1;}
int kb_send_packet(int fd,const void *bytes,size_t length){return send(fd,bytes,length,0)==(ssize_t)length?0:-1;}
int kb_peer_pid(int fd,pid_t *pid){socklen_t size=sizeof(*pid);return getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,pid,&size)==0 && size==sizeof(*pid)?0:-1;}
int kb_write_all(int fd,const void *bytes,size_t length){const char *p=bytes;while(length){ssize_t n=write(fd,p,length);if(n<0 && errno==EINTR)continue;if(n<=0)return -1;p+=n;length-=(size_t)n;}return 0;}
static int64_t now_ms(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000;}
int kb_read_bounded(int fd,void *bytes,size_t capacity,int milliseconds){size_t total=0;int64_t end=now_ms()+milliseconds;while(total<capacity){int64_t remaining=end-now_ms();if(remaining<=0 || ready(fd,(int)remaining))return -1;ssize_t n=read(fd,(char *)bytes+total,capacity-total);if(n<0 && errno==EINTR)continue;if(n<0)return -1;if(n==0)return (int)total;total+=(size_t)n;}return -1;}
int kb_read_line(int fd,void *bytes,size_t capacity,int milliseconds){size_t total=0;int64_t end=now_ms()+milliseconds;while(total<capacity){int64_t remaining=end-now_ms();if(remaining<=0 || ready(fd,(int)remaining))return -1;char byte;ssize_t n=read(fd,&byte,1);if(n<0 && errno==EINTR)continue;if(n!=1)return -1;if(byte=='\n')return (int)total;((char *)bytes)[total++]=byte;}return -1;}
int kb_fixture_sandbox(void){
    // Deprecated Seatbelt API is a fixture enforcement probe, not a supported
    // production signing/entitlement or complete VMM worker policy.
    const char *profile="(version 1)(deny default)(allow sysctl-read)(allow file-read-metadata)(allow file-read-data (subpath \"/System/Library\") (subpath \"/usr/lib\") (literal \"/dev/fd\"))";
    char *error=NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    int rc=sandbox_init(profile,0,&error);if(error)sandbox_free_error(error);
#pragma clang diagnostic pop
    return rc;
}
int kb_extra_fds(void){DIR *dir=opendir("/dev/fd");if(!dir)return -1;int own=dirfd(dir),count=0;struct dirent *entry;while((entry=readdir(dir))){char *end;long fd=strtol(entry->d_name,&end,10);if(*end==0 && fd>2 && fd!=own && fcntl((int)fd,F_GETFD)>=0)count++;}closedir(dir);return count;}
int kb_file_denied(const char *path){int fd=open(path,O_RDONLY);if(fd>=0){close(fd);return 0;}return errno==EPERM || errno==EACCES;}
int kb_network_denied(void){int fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)return errno==EPERM || errno==EACCES;struct sockaddr_in addr={.sin_len=sizeof(addr),.sin_family=AF_INET,.sin_port=htons(1),.sin_addr={htonl(INADDR_LOOPBACK)}};int rc=connect(fd,(void *)&addr,sizeof(addr)),error=errno;close(fd);return rc<0 && (error==EPERM || error==EACCES);}
int kb_exec_denied(void){pid_t pid;char *args[]={"/usr/bin/true",NULL},*env[]={NULL};int rc=posix_spawn(&pid,args[0],NULL,NULL,args,env);if(!rc){kb_wait_owned(pid,1000);return 0;}return rc==EPERM || rc==EACCES;}
extern int sandbox_check(pid_t,const char *,int,...);
int kb_security_service_denied(void){return sandbox_check(getpid(),"mach-lookup",2,"com.apple.securityd")!=0;}
void kb_wipe(void *bytes,size_t length){volatile unsigned char *p=bytes;while(length--)*p++=0;}
