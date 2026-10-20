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
#include <pthread.h>

static int flags(int fd) { return fcntl(fd,F_SETFD,FD_CLOEXEC)==0?0:-1; }
int kb_pipe(int fds[2]) { if(pipe(fds))return -1;if(flags(fds[0])||flags(fds[1])){close(fds[0]);close(fds[1]);return -1;}return 0; }
int kb_channel(int fds[2]) { if(socketpair(AF_UNIX,SOCK_DGRAM,0,fds))return -1;if(flags(fds[0])||flags(fds[1])){close(fds[0]);close(fds[1]);return -1;}return 0; }
static int spawn_suspended(const char *path,const char *mode,int input,int output,pid_t *pid) {
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
/* Sole-reaper fixture contract: no SIGCHLD handler/auto-reap and no other
 * wait()/waitpid() consumer. A non-reaped child reserves its PID even on exit.
 * This is not atomic pidfd-style signaling against a hostile external reaper. */
struct kb_owned_child { pid_t pid; pthread_mutex_t lock; kb_wait_result result; };
typedef struct {
    void *context;
    int64_t (*clock)(void *);
    pid_t (*wait)(void *,pid_t,int *);
    int (*signal)(void *,pid_t,int);
    void (*tick)(void *);
    int (*exclusive)(void *);
} wait_ops;
static int64_t wait_clock(void *unused) { (void)unused;struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))return -1;return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000; }
static pid_t wait_probe(void *unused,pid_t pid,int *status) { (void)unused;return waitpid(pid,status,WNOHANG); }
static int wait_signal(void *unused,pid_t pid,int signal) { (void)unused;return kill(pid,signal); }
static void wait_tick(void *unused) { (void)unused;struct timespec tick={0,1000000};(void)nanosleep(&tick,NULL); }
static int exclusive_reaper(void *unused) {
    (void)unused;struct sigaction action;
    return sigaction(SIGCHLD,NULL,&action)==0 && action.sa_handler==SIG_DFL && !(action.sa_flags&SA_NOCLDWAIT);
}
static const wait_ops real_ops={NULL,wait_clock,wait_probe,wait_signal,wait_tick,exclusive_reaper};
static void uncertain(kb_owned_child *child,int error) { child->result.state=KB_TERMINATION_UNCERTAIN;child->result.error=error; }
/* 1 = confirmed exit/error; 0 = still this unreaped child; -1 = EINTR. */
static int probe(kb_owned_child *child,const wait_ops *ops) {
    int status=0;pid_t result=ops->wait(ops->context,child->pid,&status);
    if(result==child->pid) {
        if(WIFEXITED(status)||WIFSIGNALED(status)) { child->result.state=KB_CONFIRMED_EXIT;child->result.status=WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);child->result.error=0; }
        else uncertain(child,EPROTO);
        return 1;
    }
    if(result==0)return 0;
    if(result<0 && errno==EINTR)return -1;
    child->result.state=result<0 && errno==ECHILD?KB_LOST_OWNERSHIP:KB_TERMINATION_UNCERTAIN;
    child->result.error=result<0?errno:EPROTO;return 1;
}
static int poll_until(kb_owned_child *child,int milliseconds,const wait_ops *ops) {
    int64_t start=ops->clock(ops->context);if(start<0){uncertain(child,EIO);return 1;}
    int64_t end=start+milliseconds;
    for(;;) {
        if(probe(child,ops)==1)return 1;
        int64_t now=ops->clock(ops->context);
        if(now<start){uncertain(child,EIO);return 1;}
        if(now>=end)return 0;
        ops->tick(ops->context); /* EINTR never restarts either deadline. */
    }
}
static kb_wait_result wait_locked(kb_owned_child *child,int milliseconds,int reap_milliseconds,const wait_ops *ops) {
    if(child->result.state!=KB_OWNED_RUNNING)return child->result;
    if(child->pid<=0){uncertain(child,EINVAL);return child->result;}
    if(milliseconds<0 || milliseconds>10000 || reap_milliseconds<0 || reap_milliseconds>1000){uncertain(child,EINVAL);return child->result;}
    if(!ops->exclusive(ops->context)){uncertain(child,EPERM);return child->result;}
    if(poll_until(child,milliseconds,ops))return child->result;
    child->result.timed_out=1;
    /* Fresh WNOHANG proof under the ownership mutex before any signal. An
     * interrupted/error probe cannot authorize a signal, even at timeout. */
    int check=probe(child,ops);
    if(check!=0){if(check<0)uncertain(child,EINTR);return child->result;}
    if(!ops->exclusive(ops->context)){uncertain(child,EPERM);return child->result;}
    if(ops->signal(ops->context,child->pid,SIGKILL)==0)child->result.kill_sent=1;
    else { int error=errno; /* ESRCH is not proof of reap. */
        if(probe(child,ops)!=1)uncertain(child,error);
        return child->result;
    }
    if(!poll_until(child,reap_milliseconds,ops))uncertain(child,ETIMEDOUT);
    return child->result;
}
int kb_spawn_owned(const char *path,const char *mode,int input,int output,kb_owned_child **output_child) {
    *output_child=NULL;
    if(!exclusive_reaper(NULL))return EPERM;
    kb_owned_child *child=calloc(1,sizeof(*child));if(!child)return ENOMEM;
    int rc=pthread_mutex_init(&child->lock,NULL);if(rc){free(child);return rc;}
    child->result.status=-1;
    rc=spawn_suspended(path,mode,input,output,&child->pid);
    if(rc){pthread_mutex_destroy(&child->lock);free(child);return rc;}
    *output_child=child;return 0;
}
pid_t kb_owned_pid(const kb_owned_child *child) { return child->pid; }
kb_wait_result kb_resume_owned(kb_owned_child *child) {
    if(pthread_mutex_trylock(&child->lock))return (kb_wait_result){KB_TERMINATION_UNCERTAIN,-1,EBUSY,0,0};
    if(child->result.state==KB_OWNED_RUNNING) {
        if(child->pid<=0)uncertain(child,EINVAL);
        else if(!exclusive_reaper(NULL))uncertain(child,EPERM);
        else { int check=probe(child,&real_ops);
            if(check<0)uncertain(child,EINTR);
            else if(check==0) {
                if(!exclusive_reaper(NULL))uncertain(child,EPERM);
                else if(kill(child->pid,SIGCONT)<0)uncertain(child,errno);
            }
        }
    }
    kb_wait_result result=child->result;pthread_mutex_unlock(&child->lock);return result;
}
kb_wait_result kb_wait_owned(kb_owned_child *child,int milliseconds,int reap_milliseconds) {
    if(pthread_mutex_trylock(&child->lock))return (kb_wait_result){KB_TERMINATION_UNCERTAIN,-1,EBUSY,0,0};
    kb_wait_result result=wait_locked(child,milliseconds,reap_milliseconds,&real_ops);
    pthread_mutex_unlock(&child->lock);return result;
}
void kb_owned_destroy(kb_owned_child *child) { pthread_mutex_destroy(&child->lock);free(child); }
/* No process lookup or real signals: fixture tests inject the syscall boundary
 * used above, including EINTR storms and unconfirmed post-kill termination. */
typedef struct { int scenario, probes, signals, killed; int64_t time; } fake_wait;
static int64_t fake_clock(void *context) { fake_wait *f=context;if(f->scenario==9 && f->probes>0)return -1;return f->time; }
static void fake_tick(void *context) { ((fake_wait *)context)->time+=5; }
static int fake_exclusive(void *context) { return ((fake_wait *)context)->scenario!=10; }
static pid_t fake_probe(void *context,pid_t pid,int *status) {
    fake_wait *f=context;f->probes++;
    if(f->scenario==0){*status=0;return pid;}
    if(f->scenario==1 || (f->scenario==8 && f->killed)){errno=ECHILD;return -1;}
    if(f->scenario==2 || (f->scenario==6 && f->signals)){errno=EIO;return -1;}
    if(f->scenario==3 || (f->scenario==5 && f->killed) || (f->scenario==11 && f->time>=10)){errno=EINTR;return -1;}
    if(f->scenario==7 && f->probes==4){*status=0;return pid;}
    if(f->scenario==4 && f->killed){*status=SIGKILL;return pid;}
    return 0;
}
static int fake_signal(void *context,pid_t pid,int signal) {
    (void)pid;fake_wait *f=context;f->signals++;if(signal!=SIGKILL)return -1;
    if(f->scenario==6){errno=ESRCH;return -1;}f->killed=1;return 0;
}
int kb_fixture_wait_scenario(int scenario) {
    if(scenario<0 || scenario>14)return 0;
    fake_wait fake={.scenario=scenario};wait_ops ops={&fake,fake_clock,fake_probe,fake_signal,fake_tick,fake_exclusive};
    kb_owned_child child={.pid=scenario==12?0:scenario==13?-1:4242,.result={KB_OWNED_RUNNING,-1,0,0,0}};
    kb_wait_result result=wait_locked(&child,scenario==14?-1:10,10,&ops);
    int state=scenario==0 || scenario==4 || scenario==7?KB_CONFIRMED_EXIT:scenario==1 || scenario==8?KB_LOST_OWNERSHIP:KB_TERMINATION_UNCERTAIN;
    int signals=scenario==4 || scenario==5 || scenario==6 || scenario==8?1:0;
    if(result.state!=state || fake.signals!=signals || fake.time>20)return 0;
    if(scenario==4 && (result.status!=137 || !result.kill_sent || !result.timed_out))return 0;
    if(scenario==5 && (result.error!=ETIMEDOUT || !result.kill_sent))return 0;
    if(scenario==1 && result.error!=ECHILD)return 0;
    if(scenario==6 && result.kill_sent)return 0;
    int probes=fake.probes;result=wait_locked(&child,10,10,&ops);
    return result.state==state && fake.probes==probes && fake.signals==signals;
}
int kb_fixture_spawn_policy_refused(void) {
    /* Standalone no-key fixture only. Invalid FDs also make an accidental
     * admission unable to spawn; restore this process's exact prior policy. */
    struct sigaction saved,policy;if(sigaction(SIGCHLD,NULL,&saved))return 0;
    int passed=1;
    for(int mode=0;mode<2;mode++) {
        policy=saved;policy.sa_handler=mode==0?SIG_IGN:SIG_DFL;
        policy.sa_flags=mode==0?0:SA_NOCLDWAIT;
        if(sigaction(SIGCHLD,&policy,NULL)){passed=0;break;}
        kb_owned_child *child=NULL;
        int rc=kb_spawn_owned("/bin/sleep","10",-1,-1,&child);
        if(rc!=EPERM || child!=NULL)passed=0;
    }
    if(sigaction(SIGCHLD,&saved,NULL))passed=0;
    return passed;
}
typedef struct {
    void *context;
    int64_t (*clock)(void *);
    int (*poll)(void *,struct pollfd *,int);
} read_wait_ops;
typedef struct { int64_t start,end; } read_deadline;
static int read_poll(void *unused,struct pollfd *p,int milliseconds) { (void)unused;return poll(p,1,milliseconds); }
static const read_wait_ops real_read_ops={NULL,wait_clock,read_poll};
static int read_deadline_start(int milliseconds,read_deadline *deadline,const read_wait_ops *ops) {
    if(milliseconds<=0 || milliseconds>10000){errno=EINVAL;return -1;}
    deadline->start=ops->clock(ops->context);
    if(deadline->start<0){errno=EIO;return -1;}
    deadline->end=deadline->start+milliseconds;return 0;
}
/* One absolute deadline per frame, including every interrupted poll and read.
 * The caller owns the only reader; readiness is not an ownership primitive. */
static int ready_until(int fd,const read_deadline *deadline,const read_wait_ops *ops) {
    for(;;) {
        int64_t now=ops->clock(ops->context);
        if(now<deadline->start){errno=EIO;return -1;}
        if(now>=deadline->end){errno=ETIMEDOUT;return -1;}
        struct pollfd p={fd,POLLIN,0};
        int rc=ops->poll(ops->context,&p,(int)(deadline->end-now));
        if(rc<0){if(errno==EINTR)continue;return -1;}
        if(rc==0){errno=ETIMEDOUT;return -1;}
        if(p.revents&POLLNVAL){errno=EBADF;return -1;}
        if(p.revents&POLLERR){errno=EIO;return -1;}
        if(p.revents&(POLLIN|POLLHUP))return 0;
        errno=EIO;return -1;
    }
}
int kb_recv_packet(int fd,void *bytes,size_t capacity,int milliseconds){
    read_deadline deadline;if(!capacity || capacity>4096 || read_deadline_start(milliseconds,&deadline,&real_read_ops))return -1;
    for(;;){if(ready_until(fd,&deadline,&real_read_ops))return -1;
        struct iovec part={bytes,capacity};struct msghdr message={0};message.msg_iov=&part;message.msg_iovlen=1;
        ssize_t size=recvmsg(fd,&message,0);
        if(size<0 && (errno==EINTR || errno==EAGAIN))continue;
        if(size>=0 && (message.msg_flags&(MSG_TRUNC|MSG_CTRUNC))){errno=EMSGSIZE;return -1;}
        return size>0 && (size_t)size<=capacity?(int)size:-1;}
}
int kb_send_packet(int fd,const void *bytes,size_t length){return send(fd,bytes,length,0)==(ssize_t)length?0:-1;}
int kb_peer_pid(int fd,pid_t *pid){socklen_t size=sizeof(*pid);return getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,pid,&size)==0 && size==sizeof(*pid)?0:-1;}
int kb_write_all(int fd,const void *bytes,size_t length){const char *p=bytes;while(length){ssize_t n=write(fd,p,length);if(n<0 && errno==EINTR)continue;if(n<=0)return -1;p+=n;length-=(size_t)n;}return 0;}
int kb_read_bounded(int fd,void *bytes,size_t capacity,int milliseconds){
    read_deadline deadline;if(!capacity || capacity>4096 || read_deadline_start(milliseconds,&deadline,&real_read_ops))return -1;
    size_t total=0;while(total<capacity){if(ready_until(fd,&deadline,&real_read_ops))return -1;
        ssize_t n=read(fd,(char *)bytes+total,capacity-total);if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
        if(n<0)return -1;if(n==0)return (int)total;total+=(size_t)n;}
    errno=EMSGSIZE;return -1;
}
int kb_read_line(int fd,void *bytes,size_t capacity,int milliseconds){
    read_deadline deadline;if(!capacity || capacity>4096 || read_deadline_start(milliseconds,&deadline,&real_read_ops))return -1;
    size_t total=0;while(total<capacity){if(ready_until(fd,&deadline,&real_read_ops))return -1;
        char byte;ssize_t n=read(fd,&byte,1);if(n<0 && (errno==EINTR || errno==EAGAIN))continue;
        if(n!=1)return -1;if(byte=='\n')return (int)total;((char *)bytes)[total++]=byte;}
    errno=EMSGSIZE;return -1;
}
typedef struct { int scenario,calls,timeouts[4];int64_t time; } fake_read_wait;
static int64_t fake_read_clock(void *context){fake_read_wait *f=context;return f->scenario==2 && f->calls ? -1:f->time;}
static int fake_read_poll(void *context,struct pollfd *p,int milliseconds){
    fake_read_wait *f=context;if(f->calls>=4){errno=EIO;return -1;}f->timeouts[f->calls++]=milliseconds;f->time+=4;
    if(f->scenario==0 || f->calls<3){errno=EINTR;return -1;}
    p->revents=f->scenario==3?POLLNVAL:f->scenario==4?POLLERR:POLLIN;return 1;
}
int kb_fixture_read_deadline_scenario(int scenario){
    if(scenario<0 || scenario>4)return 0;
    fake_read_wait f={.scenario=scenario};read_wait_ops ops={&f,fake_read_clock,fake_read_poll};read_deadline deadline;
    if(read_deadline_start(10,&deadline,&ops))return 0;
    int rc=ready_until(-1,&deadline,&ops),error=errno;
    if(f.timeouts[0]!=10 || (f.calls>1 && f.timeouts[1]!=6) || (f.calls>2 && f.timeouts[2]!=2))return 0;
    if(scenario==0)return rc==-1 && error==ETIMEDOUT && f.calls==3;
    if(scenario==1)return rc==0 && f.calls==3;
    if(scenario==2)return rc==-1 && error==EIO && f.calls==1;
    return rc==-1 && error==(scenario==3?EBADF:EIO) && f.calls==3;
}
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
int kb_exec_denied(void){pid_t pid;char *args[]={"/usr/bin/true",NULL},*env[]={NULL};int rc=posix_spawn(&pid,args[0],NULL,NULL,args,env);if(!rc){kb_owned_child child={.pid=pid,.result={KB_OWNED_RUNNING,-1,0,0,0}};(void)wait_locked(&child,1000,250,&real_ops);return 0;}return rc==EPERM || rc==EACCES;}
extern int sandbox_check(pid_t,const char *,int,...);
int kb_security_service_denied(void){return sandbox_check(getpid(),"mach-lookup",2,"com.apple.securityd")!=0;}
void kb_wipe(void *bytes,size_t length){volatile unsigned char *p=bytes;while(length--)*p++=0;}
