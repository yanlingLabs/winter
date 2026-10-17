/*
 * Stand-in for `python3 -I -S -B linux-supervisor.py ...` in the Linux PID 1 plumbing test (test_pid1_linux.py). It reports what PID 1's
 * fork/exec handed over: the command line, the environment, the umask, the signal state, the session and every open descriptor.
 * Not part of the guest image.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
    printf("argv:");
    for (int i = 1; i < argc; i++) printf("%s%s", i > 1 ? "|" : "", argv[i]);
    printf("\n");
    mode_t mask = umask(0);
    printf("umask:%03o\n", (unsigned)mask);
    printf("env:");
    for (char **e = environ; e && *e; e++) printf("%s%s", e == environ ? "" : "|", *e);
    printf("\n");
    struct sigaction action;
    sigaction(SIGPIPE, NULL, &action);
    printf("sigpipe:%s\n", action.sa_handler == SIG_DFL ? "default" : "other");
    sigset_t blocked;
    sigprocmask(SIG_SETMASK, NULL, &blocked);
    int any = 0;
    for (int sig = 1; sig < 32; sig++) any |= sigismember(&blocked, sig) == 1;
    printf("sigmask:%s\n", any ? "blocked" : "empty");
    printf("session:%s\n", getsid(0) == getpid() ? "leader" : "inherited");
    for (int fd = 0; fd < 256; fd++) {
        int fd_flags = fcntl(fd, F_GETFD);
        if (fd_flags < 0) continue;
        struct stat st;
        fstat(fd, &st);
        const char *kind = S_ISFIFO(st.st_mode) ? "fifo" : S_ISREG(st.st_mode) ? "reg" : S_ISCHR(st.st_mode) ? "chr" : "other";
        int status = fcntl(fd, F_GETFL);
        printf("fd:%d kind=%s access=%d nonblock=%d cloexec=%d mode=%o nlink=%lu\n", fd, kind, status & O_ACCMODE, (status & O_NONBLOCK) != 0,
               (fd_flags & FD_CLOEXEC) != 0, (unsigned)(st.st_mode & 0777), (unsigned long)st.st_nlink);
    }
    char config[256];
    ssize_t n = pread(3, config, sizeof config - 1, 0);
    printf("config:%.*s\n", n > 0 ? (int)n : 0, config);
    fflush(stdout);
    return 0;
}
