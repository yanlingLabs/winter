// Fixture only: concurrent descriptor creation and real fork/exec, no daemon/VM.
#include <pthread.h>
#include <stdatomic.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <dirent.h>
#include <stdio.h>
#include "fd_creation.c"
static atomic_bool running=true;
static void *creator(void *unused){(void)unused;while(atomic_load(&running)){int fds[2];if(native_pipe_cloexec(fds)){atomic_store(&running,false);return (void *)1;}close(fds[0]);close(fds[1]);}return NULL;}
static int extras(void){DIR *dir=opendir("/dev/fd");if(!dir)return -1;int own=dirfd(dir),count=0;struct dirent *entry;while((entry=readdir(dir))){char *end;long fd=strtol(entry->d_name,&end,10);if(*end==0 && fd>2 && fd!=own && fcntl((int)fd,F_GETFD)>=0)count++;}closedir(dir);return count;}
static int child(const char *self){pid_t pid=fork();if(pid==0){char *argv[]={(char *)self,"--child",NULL},*env[]={"LC_ALL=C",NULL};execve(self,argv,env);_exit(99);}if(pid<0)return -1;int status;while(waitpid(pid,&status,0)<0){if(errno!=EINTR)return -1;}return WIFEXITED(status)?WEXITSTATUS(status):-1;}
int main(int argc,char **argv){
 if(argc==2)return extras()==0?0:1;
 int raw[2];if(pipe(raw))return 2;if(child(argv[0])!=1)return 3;close(raw[0]);close(raw[1]);
 int warm[2];if(native_pipe_cloexec(warm))return 4;close(warm[0]);close(warm[1]);
 pthread_t thread;if(pthread_create(&thread,NULL,creator,NULL))return 5;
 bool passed=true;for(int i=0;i<32;i++)if(child(argv[0])!=0)passed=false;
 atomic_store(&running,false);void *result;pthread_join(thread,&result);
 if(!passed||result)return 6;
 puts("{\"forkCreationGuard\":true,\"forkExecChildren\":32,\"rawPipeLeakPositiveControl\":true,\"realVM\":false}");return 0;
}
