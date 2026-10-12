/* Fixed fixture-only local FD handoff. Not daemon or signed-worker authentication. */
#ifndef WINTER_WORKSPACE_FD_HANDOFF_H
#define WINTER_WORKSPACE_FD_HANDOFF_H
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#ifndef WORKSPACE_HANDOFF_FD_CAPACITY
#define WORKSPACE_HANDOFF_FD_CAPACITY 256
#endif
#define WORKSPACE_HANDOFF_MAGIC UINT32_C(0x57464431)
struct workspace_handoff_record {
    uint32_t magic;
    uint32_t version;
    struct krun_cowork_volume_identity data;
    struct krun_cowork_volume_identity environment;
};
_Static_assert(sizeof(struct workspace_handoff_record)==72,"fixed local handoff layout");

static int workspace_admit_channel(int channel) {
    int kind=0,flags=fcntl(channel,F_GETFD);socklen_t size=sizeof kind;
    struct sockaddr_un local={0},peer={0};socklen_t ll=sizeof local,pl=sizeof peer;
    if(channel<3 || flags<0 || !(flags&FD_CLOEXEC) || getsockopt(channel,SOL_SOCKET,SO_TYPE,&kind,&size) || kind!=SOCK_DGRAM ||
       getsockname(channel,(struct sockaddr*)&local,&ll) || getpeername(channel,(struct sockaddr*)&peer,&pl) ||
       ll>sizeof local || pl>sizeof peer || local.sun_family!=AF_UNIX || peer.sun_family!=AF_UNIX){errno=EINVAL;return -1;}
    for(size_t i=offsetof(struct sockaddr_un,sun_path);i<ll;i++)if(((unsigned char*)&local)[i]){errno=EINVAL;return -1;}
    for(size_t i=offsetof(struct sockaddr_un,sun_path);i<pl;i++)if(((unsigned char*)&peer)[i]){errno=EINVAL;return -1;}
    return 0;
}

/* Caller retains the channel. Outputs are owned only on success, otherwise -1.
 * DGRAM gives one atomic envelope; accept exactly one rights item with two FDs.
 * Receive buffer deliberately holds extras so all installed FDs can be closed.
 * On macOS ancillary truncation can install undisclosed FDs. Return -2 then;
 * the worker MUST exit, never continue or acknowledge handoff. Process exit
 * is descriptor cleanup only, not a canonical volume-release receipt. */
static int workspace_receive_pair(int channel,struct workspace_handoff_record *record,int output[2]) {
    output[0]=output[1]=-1;
    if(workspace_admit_channel(channel))return -1;
    struct pollfd wait={.fd=channel,.events=POLLIN};
    /* Do not retry EINTR: bounded refusal is safe, unlike resetting a deadline. */
    if(poll(&wait,1,3000)!=1 || !(wait.revents&POLLIN)){errno=ETIMEDOUT;return -1;}
    union {struct cmsghdr alignment;unsigned char bytes[CMSG_SPACE(WORKSPACE_HANDOFF_FD_CAPACITY*sizeof(int))];} ancillary;
    memset(&ancillary,0,sizeof ancillary);
    struct workspace_handoff_record incoming;
    struct iovec io={.iov_base=&incoming,.iov_len=sizeof incoming};
    struct msghdr msg={0};msg.msg_iov=&io;msg.msg_iovlen=1;msg.msg_control=ancillary.bytes;msg.msg_controllen=sizeof ancillary;
    ssize_t bytes=recvmsg(channel,&msg,MSG_DONTWAIT);
    if(bytes<0)return -1;
    int received[WORKSPACE_HANDOFF_FD_CAPACITY],count=0,items=0,bad=0;
    for(struct cmsghdr *c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)) {
        if(c->cmsg_level!=SOL_SOCKET || c->cmsg_type!=SCM_RIGHTS || c->cmsg_len<CMSG_LEN(0)){bad=1;continue;}
        size_t payload=c->cmsg_len-CMSG_LEN(0);items++;
        if(payload%sizeof(int))bad=1;
        for(size_t i=0;i<payload/sizeof(int);i++) {
            int fd;memcpy(&fd,(unsigned char*)CMSG_DATA(c)+i*sizeof(int),sizeof fd);
            if(count<WORKSPACE_HANDOFF_FD_CAPACITY)received[count++]=fd;else {close(fd);bad=1;}
        }
    }
    if(bytes!=(ssize_t)sizeof incoming || (msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)) ||
       incoming.magic!=WORKSPACE_HANDOFF_MAGIC || incoming.version!=1 || items!=1 || count!=2)bad=1;
    for(int i=0;i<count;i++) {
        int flags=fcntl(received[i],F_GETFD);
        if(received[i]<3 || flags<0 || fcntl(received[i],F_SETFD,flags|FD_CLOEXEC)<0)bad=1;
    }
    if(bad){for(int i=0;i<count;i++)close(received[i]);errno=EINVAL;return (msg.msg_flags&MSG_CTRUNC)?-2:-1;}
    *record=incoming;output[0]=received[0];output[1]=received[1];return 0;
}
#endif
