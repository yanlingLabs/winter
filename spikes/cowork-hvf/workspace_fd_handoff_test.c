#include "libkrun.h"
#include "workspace_fd_handoff.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
static int descriptors(void){int n=0;for(int i=0;i<256;i++)if(fcntl(i,F_GETFD)>=0)n++;return n;}
static void transmit(int channel,int fd,int count,int version,int extra) {
    struct workspace_handoff_record record={.magic=WORKSPACE_HANDOFF_MAGIC,.version=(uint32_t)version};
    unsigned char body[sizeof record+1];memcpy(body,&record,sizeof record);body[sizeof record]=0;
    struct iovec io={.iov_base=body,.iov_len=sizeof record+(size_t)extra};
    union {struct cmsghdr alignment;unsigned char bytes[CMSG_SPACE(20*sizeof(int))];} rights;
    memset(&rights,0,sizeof rights);
    struct msghdr msg={0};msg.msg_iov=&io;msg.msg_iovlen=1;
    if(count){msg.msg_control=rights.bytes;msg.msg_controllen=CMSG_SPACE((size_t)count*sizeof(int));
        struct cmsghdr *h=CMSG_FIRSTHDR(&msg);h->cmsg_level=SOL_SOCKET;h->cmsg_type=SCM_RIGHTS;h->cmsg_len=CMSG_LEN((size_t)count*sizeof(int));
        for(int i=0;i<count;i++)memcpy((unsigned char*)CMSG_DATA(h)+i*sizeof(int),&fd,sizeof fd);
    }
    assert(sendmsg(channel,&msg,0)==(ssize_t)io.iov_len);
}
static int exercise(void){
    int sockets[2];assert(socketpair(AF_UNIX,SOCK_DGRAM,0,sockets)==0);
    int fd=open("/dev/null",O_RDWR);assert(fd>=3);
    const int cases[][4]={{2,1,0,1},{0,1,0,0},{1,1,0,0},{3,1,0,0},{20,1,0,0},{2,2,0,0},{2,1,1,0}};
    for(size_t i=0;i<sizeof cases/sizeof cases[0];i++){
        int before=descriptors(),got[2];struct workspace_handoff_record record;
        transmit(sockets[0],fd,cases[i][0],cases[i][1],cases[i][2]);
        int rc=workspace_receive_pair(sockets[1],&record,got);
        if(cases[i][3]){assert(rc==0 && got[0]!=got[1]);assert(fcntl(got[0],F_GETFD)&FD_CLOEXEC);assert(fcntl(got[1],F_GETFD)&FD_CLOEXEC);close(got[0]);close(got[1]);}
        else if(cases[i][0]>WORKSPACE_HANDOFF_FD_CAPACITY){assert(rc==-2 && got[0]==-1 && got[1]==-1);_exit(77);}
        else assert(rc==-1 && got[0]==-1 && got[1]==-1);
        if(descriptors()!=before)fprintf(stderr,"case %zu before %d after %d\n",i,before,descriptors());assert(descriptors()==before);assert(fcntl(fd,F_GETFD)>=0);
    }
    close(fd);close(sockets[0]);close(sockets[1]);return 0;
}

int main(void){pid_t child=fork();assert(child>=0);if(!child)_exit(exercise());int status;assert(waitpid(child,&status,0)==child);assert(WIFEXITED(status));assert(WEXITSTATUS(status)==(WORKSPACE_HANDOFF_FD_CAPACITY<20?77:0));puts("FD handoff cases passed; truncated ancillary path requires terminal worker exit; no VM started");return 0;}
