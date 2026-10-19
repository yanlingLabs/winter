/* Stand-in for the provider worker in tests/test_standin_linux.py: reports exactly what start_worker handed it, as `key value` lines on stdout. Linux only. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

static const char *kind(int fd) {
    struct stat st;
    if (fstat(fd, &st) != 0) return "closed";
    if (S_ISSOCK(st.st_mode)) { int type = 0, accepting = 0; socklen_t size = sizeof type; getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size); size = sizeof accepting; getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &size);
        return type == SOCK_SEQPACKET ? "seqpacket" : accepting ? "listener" : "stream"; }
    if (S_ISREG(st.st_mode)) return "file";
    if (S_ISCHR(st.st_mode)) return "chardev";
    return "other";
}

int main(int argc, char **argv) {
    for (int i = 0; i < argc; i++) printf("argv %d %s\n", i, argv[i]);
    int env = 0;
    for (char **e = environ; e && *e; e++) env++;
    printf("env %d\n", env);
    for (int fd = 0; fd < 64; fd++) {
        const char *k = kind(fd);
        if (strcmp(k, "closed")) {
            int flags = fcntl(fd, F_GETFD);
            printf("fd %d %s cloexec=%d\n", fd, k, (flags & FD_CLOEXEC) ? 1 : 0);
        }
    }
    char marker[2] = { 0, 0 };
    char control[256];
    struct iovec vector = { marker, sizeof marker };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &vector; message.msg_iovlen = 1; message.msg_control = control; message.msg_controllen = sizeof control;
    ssize_t n = recvmsg(4, &message, MSG_CMSG_CLOEXEC);
    int fds = 0;
    char link[128] = "";
    struct cmsghdr *c = CMSG_FIRSTHDR(&message);
    if (c && c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len == CMSG_LEN(sizeof(int))) {
        int fd;
        memcpy(&fd, CMSG_DATA(c), sizeof fd);
        fds++;
        char path[64];
        snprintf(path, sizeof path, "/proc/self/fd/%d", fd);
        ssize_t m = readlink(path, link, sizeof link - 1);
        link[m > 0 ? m : 0] = '\0';
    }
    printf("admission bytes=%zd marker=%c fds=%d link=%s\n", n, marker[0] ? marker[0] : '?', fds, link);
    printf("nonewprivs %d\n", prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
    sigset_t blocked;
    sigprocmask(SIG_SETMASK, NULL, &blocked);
    int any = 0;
    for (int s = 1; s < 32; s++) if (sigismember(&blocked, s) == 1) any++;
    struct sigaction action;
    sigaction(SIGPIPE, NULL, &action);
    printf("blocked %d sigpipe_default %d\n", any, action.sa_handler == SIG_DFL);
    printf("uid %d gid %d\n", (int)getuid(), (int)getgid());
    return 0;
}
