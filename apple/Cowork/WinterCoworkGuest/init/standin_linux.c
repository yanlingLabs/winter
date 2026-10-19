/*
 * The Linux effects of the stand-in lifecycle (STAND-IN IMAGE ONLY; see standin.h). Compiled only into `init-standin` (build.py --profile standin).
 *
 * What it gives the runtime-sdk provider worker (scripts/guest-guided-build/entries/provider-worker*.ts), by its fixed contract:
 *   fd 3  the listening AF_UNIX stream socket, a root-owned inode at <control dir>/<sid>/provider.sock
 *   fd 4  a SOCK_SEQPACKET channel on which ROOT (this process) sends one message: 'I' plus the runtime process's pidfd
 *   fd 5  the immutable owner library (read-only), fd 6 the immutable metadata file written by standin_prepare.py
 * The worker runs as an unprivileged uid with no new privileges, no network (the guest has none), no credentials and no child process of its own.
 */
#define _GNU_SOURCE
#include "standin_linux.h"
#include "standin_hooks.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif

struct wg_standin_paths wg_standin_paths = {
    "/run/winter/standin", "/run/winter/control", "/usr/bin/python3", "/opt/winter/standin/standin_prepare.py", "/opt/winter/standin/profile.json",
    "/opt/winter/standin/winter-provider", "/opt/winter/helpers/linux-session-owner.so", "/opt/winter/runtime/winter-host-query", "winter-host-que", "/proc", 1, 65534,
};

static char *const CHILD_ENV[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", NULL };
static char *const WORKER_ENV[] = { NULL };
static int log_fd = -1;

static long long clock_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void sleep_ms(unsigned ms) {
    struct timespec t = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&t, NULL);
}
static int safe_component(const char *name) {
    size_t n = strlen(name);
    if (n < 1 || n > WG_SESSION_ID_MAX || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
    for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)name[i]) && name[i] != '_' && name[i] != '-' && name[i] != '.') return 0;
    return 1;
}

/* ------------------------------------------------------------------------------------------------ the runtime locator */

static int read_small(const char *path, char *out, size_t capacity) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, out, capacity - 1);
    close(fd);
    if (n < 0) return -1;
    out[n] = '\0';
    return 0;
}

/* 1 = this pid is the runtime (all four uids equal `uid`, and exe or comm match), 0 = not, -1 = unreadable */
static int process_matches(const char *proc_root, int pid, uint32_t uid, const char *exe, const char *comm) {
    char path[160], text[4096], target[512];
    snprintf(path, sizeof path, "%s/%d/status", proc_root, pid);
    if (read_small(path, text, sizeof text) != 0) return -1;
    const char *line = strstr(text, "\nUid:");
    if (!line) return -1;
    unsigned long ids[4];
    if (sscanf(line, "\nUid:\t%lu\t%lu\t%lu\t%lu", &ids[0], &ids[1], &ids[2], &ids[3]) != 4) return -1;
    for (int i = 0; i < 4; i++) if (ids[i] != uid) return 0;
    snprintf(path, sizeof path, "%s/%d/exe", proc_root, pid);
    ssize_t n = readlink(path, target, sizeof target - 1);
    if (n > 0) { target[n] = '\0'; if (!strcmp(target, exe)) return 1; }
    snprintf(path, sizeof path, "%s/%d/comm", proc_root, pid);
    if (read_small(path, text, sizeof text) == 0) {
        size_t length = strcspn(text, "\n");
        text[length] = '\0';
        if (!strcmp(text, comm)) return 1;
    }
    return 0;
}

int wg_standin_scan_proc(const char *proc_root, uint32_t uid, const char *exe, const char *comm, int *pid) {
    DIR *dir = opendir(proc_root);
    if (!dir) return -1;
    int found = 0, which = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        char *end;
        long value = strtol(entry->d_name, &end, 10);
        if (*end || value < 2 || value > 0x3fffffff) continue;
        int match = process_matches(proc_root, (int)value, uid, exe, comm);
        if (match == 1) { found++; which = (int)value; }
    }
    closedir(dir);
    if (found > 1) return -1;
    if (found == 1) *pid = which;
    return found;
}

void (*wg_standin_after_pidfd_open)(void) = NULL;

static int op_find_runtime(void *ctx, uint32_t uid) {
    (void)ctx;
    const struct wg_standin_paths *p = &wg_standin_paths;
    int pid = 0, found = wg_standin_scan_proc(p->proc_root, uid, p->runtime_exe, p->runtime_comm, &pid);
    if (found <= 0) return found;
    int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
    if (pidfd < 0) return 0;        /* it left between the scan and the open: look again */
    if (wg_standin_after_pidfd_open) wg_standin_after_pidfd_open();
    /* a pid can be reused between the scan and the open: what the descriptor refers to must still be the runtime */
    if (process_matches(p->proc_root, pid, uid, p->runtime_exe, p->runtime_comm) != 1) { close(pidfd); return -1; }
    return pidfd;
}

/* ------------------------------------------------------------------------------------------------ files and the listener */

static void op_log(void *ctx, const char *code) {
    (void)ctx;
    char line[160];
    int n = snprintf(line, sizeof line, "<6>winter-guest: ");
    for (const char *c = code; *c && n < (int)sizeof line - 2; c++) line[n++] = (*c >= 0x20 && *c < 0x7f) ? *c : '?';
    line[n++] = '\n';
    if (write(log_fd >= 0 ? log_fd : 2, line, (size_t)n) < 0) { /* nothing more to do */ }
}

static long long op_now(void *ctx) { (void)ctx; return clock_ms(); }
static void op_close(void *ctx, int fd) { (void)ctx; if (fd >= 3) close(fd); }

static int wait_child(pid_t pid, unsigned timeout_ms) {
    long long deadline = clock_ms() + timeout_ms;
    for (;;) {
        int status = 0;
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid) return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
        if (r < 0 && errno != EINTR) return -1;
        if (clock_ms() >= deadline) { kill(pid, SIGKILL); waitpid(pid, &status, 0); return -1; }
        sleep_ms(20);
    }
}

static int op_prepare(void *ctx, const char *sid, uint32_t uid, const char *items, size_t items_length) {
    (void)ctx; (void)uid;
    const struct wg_standin_paths *p = &wg_standin_paths;
    if (!safe_component(sid)) return -1;
    if (mkdir(p->standin_dir, 0700) != 0 && errno != EEXIST) return -1;
    char items_path[256], out_dir[256];
    if (snprintf(items_path, sizeof items_path, "%s/items.json", p->standin_dir) >= (int)sizeof items_path) return -1;
    if (snprintf(out_dir, sizeof out_dir, "%s/%s", p->standin_dir, sid) >= (int)sizeof out_dir) return -1;
    int fd = open(items_path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
    if (fd < 0) return -1;
    size_t at = 0;
    while (at < items_length) {
        ssize_t n = write(fd, items + at, items_length - at);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(fd); return -1; }
        at += (size_t)n;
    }
    close(fd);
    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        int null_fd = open("/dev/null", O_RDWR);
        if (null_fd >= 0) dup2(null_fd, 0);
        if (log_fd >= 0) { dup2(log_fd, 1); dup2(log_fd, 2); }
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        signal(SIGPIPE, SIG_DFL);
        umask(022);
        char *argv[] = { (char *)p->python, "-I", "-S", "-B", (char *)p->prepare, "--profile", (char *)p->profile, "--items", items_path, "--sid", (char *)sid, "--out", out_dir, NULL };
        execve(p->python, argv, CHILD_ENV);
        _exit(127);
    }
    return wait_child(child, 10000) == 0 ? 0 : -1;
}

static int op_bind_listener(void *ctx, const char *sid, uint32_t uid) {
    (void)ctx;
    const struct wg_standin_paths *p = &wg_standin_paths;
    if (!safe_component(sid)) return -1;
    char dir_path[256];
    if (snprintf(dir_path, sizeof dir_path, "%s/%s", p->control_dir, sid) >= (int)sizeof dir_path) return -1;
    int dir = open(dir_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (dir < 0) return -1;
    struct stat st;
    /* the supervisor made it root:<runtime uid> 0750; anything else is not the directory this module was written for */
    if (fstat(dir, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != (gid_t)uid || (st.st_mode & 0777) != 0750) { close(dir); return -1; }
    int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (sock < 0) { close(dir); return -1; }
    struct sockaddr_un address;
    memset(&address, 0, sizeof address);
    address.sun_family = AF_UNIX;
    if (snprintf(address.sun_path, sizeof address.sun_path, "/proc/self/fd/%d/provider.sock", dir) >= (int)sizeof address.sun_path) { close(sock); close(dir); return -1; }
    mode_t old = umask(0117);                   /* the socket inode is created 0660 */
    int rc = bind(sock, (struct sockaddr *)&address, sizeof address);
    umask(old);
    if (rc == 0) rc = fchownat(dir, "provider.sock", 0, (gid_t)uid, AT_SYMLINK_NOFOLLOW);
    if (rc == 0 && (fstatat(dir, "provider.sock", &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISSOCK(st.st_mode) || st.st_uid != 0 || st.st_gid != (gid_t)uid || (st.st_mode & 0777) != 0660)) rc = -1;
    if (rc == 0) rc = listen(sock, 4);
    close(dir);
    if (rc != 0) { close(sock); return -1; }
    return sock;
}

/* ------------------------------------------------------------------------------------------------ the worker */

int wg_standin_send_admission(int channel, int pidfd) {
    char marker = 'I';
    struct iovec vector = { &marker, 1 };
    char control[CMSG_SPACE(sizeof(int))];
    memset(control, 0, sizeof control);
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &vector;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof control;
    struct cmsghdr *c = CMSG_FIRSTHDR(&message);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &pidfd, sizeof pidfd);
    return sendmsg(channel, &message, MSG_NOSIGNAL) == 1 ? 0 : -1;
}

static int high_copy(int fd) {
    int copy = fcntl(fd, F_DUPFD, 30);
    if (copy < 0) _exit(120);
    return copy;
}

static int op_start_worker(void *ctx, const char *sid, uint32_t uid, int listener, int pidfd, long *worker) {
    (void)ctx; (void)uid;
    const struct wg_standin_paths *p = &wg_standin_paths;
    if (!safe_component(sid)) return -1;
    char metadata_path[256];
    if (snprintf(metadata_path, sizeof metadata_path, "%s/%s/metadata.json", p->standin_dir, sid) >= (int)sizeof metadata_path) return -1;
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) != 0) return -1;
    int library = open(p->owner_library, O_RDONLY | O_NOFOLLOW | O_CLOEXEC), metadata = open(metadata_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (library < 0 || metadata < 0) { if (library >= 0) close(library); if (metadata >= 0) close(metadata); close(pair[0]); close(pair[1]); return -1; }
    pid_t child = fork();
    if (child < 0) { close(library); close(metadata); close(pair[0]); close(pair[1]); return -1; }
    if (child == 0) {
        int sources[4] = { listener, pair[1], library, metadata };
        int temporary[4];
        for (int i = 0; i < 4; i++) temporary[i] = high_copy(sources[i]);
        int low = open("/dev/null", O_RDWR);
        if (low < 0) _exit(121);
        int null_fd = high_copy(low);
        close(low);
        int out = log_fd >= 0 ? high_copy(log_fd) : null_fd;
        if (dup2(null_fd, 0) < 0 || dup2(out, 1) < 0 || dup2(out, 2) < 0) _exit(122);
        for (int i = 0; i < 4; i++) if (dup2(temporary[i], 3 + i) < 0) _exit(122);
        for (int fd = 7; fd < 1024; fd++) close(fd);
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        signal(SIGPIPE, SIG_DFL);
        umask(077);
        if (p->drop_privileges) {
            if (setgroups(0, NULL) != 0 || setresgid(p->worker_uid, p->worker_uid, p->worker_uid) != 0 || setresuid(p->worker_uid, p->worker_uid, p->worker_uid) != 0) _exit(123);
            if (setuid(0) == 0) _exit(124);     /* privileges must not be recoverable */
        }
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(125);
        char *argv[] = { (char *)p->worker, "--listener-fd", "3", "--admission-fd", "4", "--owner-library-fd", "5", "--metadata-fd", "6", NULL };
        execve(p->worker, argv, WORKER_ENV);
        _exit(127);
    }
    close(pair[1]);
    close(library);
    close(metadata);
    int sent = wg_standin_send_admission(pair[0], pidfd);
    close(pair[0]);
    if (sent != 0) { kill(child, SIGKILL); waitpid(child, NULL, 0); return -1; }
    *worker = (long)child;
    return 0;
}

static void op_stop_worker(void *ctx, long worker) {
    (void)ctx;
    kill((pid_t)worker, SIGTERM);
    long long deadline = clock_ms() + 2000;
    for (;;) {
        int status = 0;
        pid_t r = waitpid((pid_t)worker, &status, WNOHANG);
        if (r == (pid_t)worker || (r < 0 && errno != EINTR)) return;
        if (clock_ms() >= deadline) break;
        sleep_ms(20);
    }
    kill((pid_t)worker, SIGKILL);
    waitpid((pid_t)worker, NULL, 0);
}

void wg_standin_linux_ops(struct wg_standin_ops *ops, int kmsg_fd) {
    log_fd = kmsg_fd;
    memset(ops, 0, sizeof *ops);
    ops->now_ms = op_now;
    ops->log = op_log;
    ops->prepare = op_prepare;
    ops->bind_listener = op_bind_listener;
    ops->find_runtime = op_find_runtime;
    ops->start_worker = op_start_worker;
    ops->stop_worker = op_stop_worker;
    ops->close_fd = op_close;
}

/* ------------------------------------------------------------------------------------------------ the hooks init_linux.c calls */

static struct wg_standin state;
static struct wg_standin_ops ops;

void wg_standin_hook_init(int kmsg_fd) { wg_standin_linux_ops(&ops, kmsg_fd); wg_standin_init(&state, &ops); }
void wg_standin_hook_note_set(const struct wg_conversation_set *set) { if (wg_standin_note_set(&state, set) != 0) op_log(NULL, "standin-set-noted-unsupported"); }
void wg_standin_hook_ready(void) { wg_standin_supervisor_ready(&state); }
int wg_standin_hook_timeout(int timeout) { int hint = wg_standin_poll_hint(&state); return hint >= 0 && (timeout < 0 || timeout > hint) ? hint : timeout; }
void wg_standin_hook_tick(void) { wg_standin_tick(&state); }
void wg_standin_hook_child(long pid) { wg_standin_child_exited(&state, pid); }
void wg_standin_hook_stop(void) { wg_standin_stop(&state); }
