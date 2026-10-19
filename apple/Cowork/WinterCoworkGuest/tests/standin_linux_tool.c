/* Drives init/standin_linux.c as an ordinary process for tests/test_standin_linux.py. Linux only; never PID 1. */
#define _GNU_SOURCE
#include "../init/standin_linux.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    const char *command = argv[1];
    if (!strcmp(command, "scan") && argc == 6) {
        int pid = 0;
        int r = wg_standin_scan_proc(argv[2], (uint32_t)strtoul(argv[3], NULL, 10), argv[4], argv[5], &pid);
        if (r == 1) printf("found %d\n", pid); else printf("%s\n", r == 0 ? "none" : "ambiguous");
        return 0;
    }
    if (!strcmp(command, "admit") && argc == 2) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_SEQPACKET, 0, pair) != 0) return 3;
        int payload = open("/dev/null", O_RDONLY);
        if (wg_standin_send_admission(pair[0], payload) != 0) { printf("send failed\n"); return 0; }
        char marker = 0, control[128];
        struct iovec vector = { &marker, 1 };
        struct msghdr message;
        memset(&message, 0, sizeof message);
        message.msg_iov = &vector; message.msg_iovlen = 1; message.msg_control = control; message.msg_controllen = sizeof control;
        ssize_t n = recvmsg(pair[1], &message, 0);
        int fds = 0, chardev = 0;
        struct cmsghdr *c = CMSG_FIRSTHDR(&message);   /* the sender attaches exactly one control message */
        if (c && c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len == CMSG_LEN(sizeof(int))) {
            int fd; memcpy(&fd, CMSG_DATA(c), sizeof fd); fds++;
            struct stat st; if (fstat(fd, &st) == 0 && S_ISCHR(st.st_mode)) chardev++;
        }
        printf("bytes=%zd marker=%c fds=%d chardev=%d\n", n, marker, fds, chardev);
        close(pair[0]);
        if (wg_standin_send_admission(pair[0], payload) == 0) printf("closed channel accepted\n"); else printf("closed channel refused\n");
        return 0;
    }
    struct wg_standin_ops ops;
    int log_fd = -1;
    if (!strcmp(command, "listener") && argc == 5) {
        wg_standin_paths.control_dir = argv[2];
        wg_standin_linux_ops(&ops, -1);
        printf("%d\n", ops.bind_listener(NULL, argv[3], (uint32_t)strtoul(argv[4], NULL, 10)));
        return 0;
    }
    if (!strcmp(command, "prepare") && argc == 8) {
        /* prepare STANDIN_DIR PYTHON PREPARE PROFILE SID ITEMS */
        wg_standin_paths.standin_dir = argv[2]; wg_standin_paths.python = argv[3]; wg_standin_paths.prepare = argv[4]; wg_standin_paths.profile = argv[5];
        wg_standin_linux_ops(&ops, -1);
        printf("%d\n", ops.prepare(NULL, argv[6], 4242, argv[7], strlen(argv[7])));
        return 0;
    }
    if (!strcmp(command, "worker") && argc == 8) {
        /* worker STANDIN_DIR WORKER LIBRARY SID LOG LISTENER_PATH */
        wg_standin_paths.standin_dir = argv[2]; wg_standin_paths.worker = argv[3]; wg_standin_paths.owner_library = argv[4]; wg_standin_paths.drop_privileges = 0;
        log_fd = open(argv[6], O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
        wg_standin_linux_ops(&ops, log_fd);
        int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
        struct sockaddr_un address;
        memset(&address, 0, sizeof address);
        address.sun_family = AF_UNIX;
        snprintf(address.sun_path, sizeof address.sun_path, "%s", argv[7]);
        if (bind(listener, (struct sockaddr *)&address, sizeof address) != 0 || listen(listener, 2) != 0) return 4;
        int pidfd = (int)syscall(434, (int)getpid(), 0);
        long worker = 0;
        int r = ops.start_worker(NULL, argv[5], 4242, listener, pidfd, &worker);
        printf("start %d\n", r);
        if (r == 0) { int status = 0; waitpid((pid_t)worker, &status, 0); printf("exit %d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1); }
        return 0;
    }
    return 2;
}
