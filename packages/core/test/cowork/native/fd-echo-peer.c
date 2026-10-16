/*
 * Unit-test helper for fd-channel.test.ts. It RECEIVES file descriptors on its inherited descriptor 3 and ECHOES their
 * metadata. It starts no VM, uses no Hypervisor.framework call, opens no path and signs nothing; it exists only so the
 * bun:ffi sendmsg/recvmsg code is exercised against an independent C implementation of the same syscalls.
 *
 * usage: fd-echo-peer [control-slots]      (the number of descriptors its control buffer has room for; default 16)
 * Each datagram or stream chunk received is answered with ONE JSON line on descriptor 3:
 *   {"bytes":N,"items":K,"ctrunc":0|1,"trunc":0|1,"rights":[{"dev":D,"ino":I,"mode":M,"size":S,"cloexec":0|1,"acc":A}...]}
 * and then every received descriptor is closed, except that a chunk whose data starts with "echo-fd" makes the peer send the
 * FIRST descriptor back (one marker byte "F" carrying SCM_RIGHTS) before closing it. A chunk that starts with "quit" ends it.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

#define CHANNEL 3
#define MAX_FDS 64

int main(int argc, char **argv) {
    int slots = argc > 1 ? atoi(argv[1]) : 16;
    if (slots < 0 || slots > MAX_FDS) return 2;
    for (;;) {
        char data[4096];
        union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(MAX_FDS * sizeof(int))]; } control;
        memset(&control, 0, sizeof control);
        struct iovec io = { data, sizeof data };
        struct msghdr msg = { 0 };
        msg.msg_iov = &io; msg.msg_iovlen = 1;
        msg.msg_control = control.bytes; msg.msg_controllen = slots ? CMSG_SPACE(slots * sizeof(int)) : 0;
        ssize_t bytes = recvmsg(CHANNEL, &msg, 0);
        if (bytes <= 0) return 0;
        int fds[MAX_FDS], count = 0, items = 0;
        for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
            if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS) continue;
            items++;
            /* After ancillary truncation the header can still claim the full length: never read past what the kernel returned. */
            size_t payload = c->cmsg_len - CMSG_LEN(0), room = (size_t)((unsigned char *)msg.msg_control + msg.msg_controllen - (unsigned char *)CMSG_DATA(c));
            if (payload > room) payload = room;
            for (size_t i = 0; i < payload / sizeof(int) && count < MAX_FDS; i++) memcpy(&fds[count++], (unsigned char *)CMSG_DATA(c) + i * sizeof(int), sizeof(int));
        }
        if (bytes >= 4 && !memcmp(data, "quit", 4)) { for (int i = 0; i < count; i++) close(fds[i]); return 0; }
        char reply[4096]; int used = snprintf(reply, sizeof reply, "{\"bytes\":%zd,\"items\":%d,\"ctrunc\":%d,\"trunc\":%d,\"rights\":[", bytes, items, !!(msg.msg_flags & MSG_CTRUNC), !!(msg.msg_flags & MSG_TRUNC));
        for (int i = 0; i < count && used < (int)sizeof reply - 200; i++) {
            struct stat st; int ok = fstat(fds[i], &st) == 0, flags = fcntl(fds[i], F_GETFD), mode = fcntl(fds[i], F_GETFL);
            used += snprintf(reply + used, sizeof reply - used, "%s{\"dev\":%llu,\"ino\":%llu,\"mode\":%u,\"size\":%lld,\"cloexec\":%d,\"acc\":%d}", i ? "," : "",
                ok ? (unsigned long long)st.st_dev : 0ULL, ok ? (unsigned long long)st.st_ino : 0ULL, ok ? (unsigned)st.st_mode : 0U, ok ? (long long)st.st_size : -1LL, flags >= 0 && (flags & FD_CLOEXEC) ? 1 : 0, mode >= 0 ? (mode & O_ACCMODE) : -1);
        }
        used += snprintf(reply + used, sizeof reply - used, "]}\n");
        if (write(CHANNEL, reply, (size_t)used) != used) return 3;
        if (bytes >= 7 && !memcmp(data, "echo-fd", 7) && count > 0) {
            char marker = 'F'; unsigned char back[CMSG_SPACE(sizeof(int))]; memset(back, 0, sizeof back);
            struct iovec out = { &marker, 1 };
            struct msghdr reply_msg = { 0 };
            reply_msg.msg_iov = &out; reply_msg.msg_iovlen = 1; reply_msg.msg_control = back; reply_msg.msg_controllen = sizeof back;
            struct cmsghdr *h = CMSG_FIRSTHDR(&reply_msg);
            h->cmsg_level = SOL_SOCKET; h->cmsg_type = SCM_RIGHTS; h->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(h), &fds[0], sizeof(int));
            if (sendmsg(CHANNEL, &reply_msg, 0) != 1) return 4;
        }
        for (int i = 0; i < count; i++) close(fds[i]);
    }
}
