// Darwin exposes pipe + fcntl, not a public pipe2. Fork handlers protect the
// unmarked descriptor window; every posix_spawn caller must additionally use
// POSIX_SPAWN_CLOEXEC_DEFAULT (the pinned Bun Mac spawn path does).
#include <errno.h>
#include <mach-o/loader.h>
static pthread_mutex_t native_fd_creation_lock=PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t native_fd_creation_once=PTHREAD_ONCE_INIT;
static int native_fd_creation_ready=0;
static void native_fd_fork_prepare(void){pthread_mutex_lock(&native_fd_creation_lock);}
static void native_fd_fork_parent(void){pthread_mutex_unlock(&native_fd_creation_lock);}
static void native_fd_fork_child(void){pthread_mutex_unlock(&native_fd_creation_lock);}
static void native_fd_creation_initialize(void){
  // pthread_atfork has no unregister API. Its callback code must remain mapped
  // after addon environments/wrappers die. This mapping is process-lifetime.
  Dl_info info;
  if(dladdr((void *)native_fd_fork_prepare,&info)==0 || !info.dli_fname)return;
  if(((const struct mach_header *)info.dli_fbase)->filetype!=MH_EXECUTE &&
     !dlopen(info.dli_fname,RTLD_NOW|RTLD_NODELETE))return;
  if(pthread_atfork(native_fd_fork_prepare,native_fd_fork_parent,native_fd_fork_child)==0)native_fd_creation_ready=1;
}
static int native_pipe_cloexec(int fds[2]){
  pthread_once(&native_fd_creation_once,native_fd_creation_initialize);
  if(!native_fd_creation_ready){errno=ENOTSUP;return -1;}
  pthread_mutex_lock(&native_fd_creation_lock);
  int rc=pipe(fds),error=errno;
  if(rc==0 && (fcntl(fds[0],F_SETFD,FD_CLOEXEC)!=0 || fcntl(fds[1],F_SETFD,FD_CLOEXEC)!=0)){
    error=errno;close(fds[0]);close(fds[1]);fds[0]=fds[1]=-1;rc=-1;
  }
  pthread_mutex_unlock(&native_fd_creation_lock);errno=error;return rc;
}
