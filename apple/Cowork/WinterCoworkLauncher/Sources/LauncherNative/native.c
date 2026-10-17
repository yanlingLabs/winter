#include "launcher_native.h"
#include <spawn.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <pthread.h>

/* ================================================================================================ sockets */

static int set_cloexec(int fd) {
    int flags = fcntl(fd, F_GETFD);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}
static void close_all(const int *fds, int count) { for (int i = 0; i < count; i++) if (fds[i] >= 0) close(fds[i]); }

int lc_set_cloexec(int fd) { return set_cloexec(fd); }
int lc_has_cloexec(int fd) { int flags = fcntl(fd, F_GETFD); return flags >= 0 && (flags & FD_CLOEXEC) ? 1 : 0; }
int lc_set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
int lc_socketpair(int type, int fds[2]) {
    if (socketpair(AF_UNIX, type, 0, fds)) return -1;
    int on = 1;
    for (int i = 0; i < 2; i++) {
        if (set_cloexec(fds[i]) || setsockopt(fds[i], SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on)) {
            int saved = errno; close(fds[0]); close(fds[1]); errno = saved; return -1;
        }
    }
    return 0;
}
int lc_relocate(int fd, int minimum) {
    int moved = fcntl(fd, F_DUPFD_CLOEXEC, minimum);
    if (moved < 0) return -1;
    close(fd);
    return moved;
}
int lc_is_unnamed_unix_socket(int fd, int type) {
    int actual = 0; socklen_t size = sizeof actual;
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &actual, &size) || actual != type) return 0;
    struct sockaddr_un local, remote; socklen_t local_size = sizeof local, remote_size = sizeof remote;
    memset(&local, 0, sizeof local); memset(&remote, 0, sizeof remote);
    if (getsockname(fd, (struct sockaddr *)&local, &local_size) || getpeername(fd, (struct sockaddr *)&remote, &remote_size)) return 0;
    if (local.sun_family != AF_UNIX || remote.sun_family != AF_UNIX) return 0;
    return local.sun_path[0] == 0 && remote.sun_path[0] == 0 ? 1 : 0;
}

ssize_t lc_recvmsg(int fd, void *buffer, size_t capacity, lc_recv_info *info) {
    info->rights_count = 0; info->flags = 0;
    for (int i = 0; i < LC_MAX_RIGHTS; i++) info->rights[i] = -1;
    union { struct cmsghdr header; char bytes[CMSG_SPACE(sizeof(int) * LC_MAX_RIGHTS)]; } control;
    memset(&control, 0, sizeof control);
    struct iovec part = { buffer, capacity };
    struct msghdr message; memset(&message, 0, sizeof message);
    message.msg_iov = &part; message.msg_iovlen = 1; message.msg_control = control.bytes; message.msg_controllen = sizeof control.bytes;
    ssize_t received;
    do { received = recvmsg(fd, &message, MSG_DONTWAIT); } while (received < 0 && errno == EINTR);
    if (received < 0) return -errno;
    int seen[LC_MAX_RIGHTS], count = 0, items = 0, bad = 0;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&message); c != NULL; c = CMSG_NXTHDR(&message, c)) {
        if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len < CMSG_LEN(0)) { bad = 1; continue; }
        items++;
        size_t payload = c->cmsg_len - CMSG_LEN(0);
        if (payload % sizeof(int)) bad = 1;
        for (size_t at = 0; at + sizeof(int) <= payload && count < LC_MAX_RIGHTS; at += sizeof(int)) memcpy(&seen[count++], CMSG_DATA(c) + at, sizeof(int));
    }
    /* Everything below closes what arrived before it reports: the caller never holds a descriptor it was refused. */
    if (message.msg_flags & MSG_CTRUNC) { close_all(seen, count); return LC_E_RIGHTS_TRUNCATED; }
    if (bad || items > 1) { close_all(seen, count); return LC_E_BAD_CONTROL; }
    if (message.msg_flags & MSG_TRUNC) { close_all(seen, count); return LC_E_DATA_TRUNCATED; }
    for (int i = 0; i < count; i++) {
        if (set_cloexec(seen[i])) { int saved = errno; close_all(seen, count); return -saved; }
    }
    for (int i = 0; i < count; i++) info->rights[i] = seen[i];
    info->rights_count = count; info->flags = message.msg_flags;
    return received;
}

ssize_t lc_sendmsg(int fd, const void *buffer, size_t length, const int *rights, int count) {
    if (count < 0 || count > LC_MAX_RIGHTS) return -EINVAL;
    union { struct cmsghdr header; char bytes[CMSG_SPACE(sizeof(int) * LC_MAX_RIGHTS)]; } control;
    memset(&control, 0, sizeof control);
    struct iovec part = { (void *)buffer, length };
    struct msghdr message; memset(&message, 0, sizeof message);
    message.msg_iov = &part; message.msg_iovlen = 1;
    if (count > 0) {
        message.msg_control = control.bytes; message.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)count);
        struct cmsghdr *c = CMSG_FIRSTHDR(&message);
        c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)count);
        memcpy(CMSG_DATA(c), rights, sizeof(int) * (size_t)count);
    }
    ssize_t sent;
    do { sent = sendmsg(fd, &message, MSG_DONTWAIT); } while (sent < 0 && errno == EINTR);
    return sent < 0 ? -errno : sent;
}

int lc_peer_token(int fd, uint8_t token[32]) {
    socklen_t size = 32;
    if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &size) || size != 32) return -1;
    return 0;
}
int lc_peer_pid(int fd, pid_t *pid) {
    socklen_t size = sizeof *pid;
    return getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pid, &size) == 0 && size == sizeof *pid ? 0 : -1;
}

/* ================================================================================================ the owned child */

static int spawn_suspended(const char *path, int l2_child, int l3_child, pid_t *pid) {
    posix_spawn_file_actions_t actions; posix_spawnattr_t attributes;
    int rc = posix_spawn_file_actions_init(&actions); if (rc) return rc;
    rc = posix_spawnattr_init(&attributes);
    if (rc) { posix_spawn_file_actions_destroy(&actions); return rc; }
    sigset_t all, none; sigfillset(&all); sigemptyset(&none);
    if (!(rc = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) &&
        !(rc = posix_spawnattr_setsigdefault(&attributes, &all)) &&
        !(rc = posix_spawnattr_setsigmask(&attributes, &none)) &&
        !(rc = posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)) &&
        !(rc = posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)) &&
        !(rc = posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)) &&
        !(rc = posix_spawn_file_actions_adddup2(&actions, l2_child, 3)) &&
        !(rc = posix_spawn_file_actions_adddup2(&actions, l3_child, 4))) {
        char *argv[] = { (char *)path, NULL };
        /* No inherited BUN_BE_BUN, DYLD injection, HOME or provider secrets. */
        char *env[] = { "LC_ALL=C", "LANG=C", NULL };
        rc = posix_spawn(pid, path, &actions, &attributes, argv, env);
    }
    posix_spawnattr_destroy(&attributes); posix_spawn_file_actions_destroy(&actions);
    return rc;
}

/* Sole-reaper contract: no SIGCHLD handler or auto-reap, and no other wait()/waitpid() consumer in this process. A child that
 * is not reaped keeps its PID reserved even after it exits, which is what makes "the handle names the process" true.
 * Not atomic against a hostile external reaper; the launcher is the worker's only parent. */
struct lc_owned_child { pid_t pid; pthread_mutex_t lock; lc_wait_result result; };
typedef struct {
    void *context;
    int64_t (*clock)(void *);
    pid_t (*wait)(void *, pid_t, int *);
    int (*signal)(void *, pid_t, int);
    void (*tick)(void *);
    int (*exclusive)(void *);
} wait_ops;

int64_t lc_monotonic_ms(void) { struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1; return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }
static int64_t wait_clock(void *unused) { (void)unused; return lc_monotonic_ms(); }
static pid_t wait_probe(void *unused, pid_t pid, int *status) { (void)unused; return waitpid(pid, status, WNOHANG); }
static int wait_signal(void *unused, pid_t pid, int signal) { (void)unused; return kill(pid, signal); }
static void wait_tick(void *unused) { (void)unused; struct timespec tick = { 0, 1000000 }; (void)nanosleep(&tick, NULL); }
static int exclusive_reaper(void *unused) {
    (void)unused; struct sigaction action;
    return sigaction(SIGCHLD, NULL, &action) == 0 && action.sa_handler == SIG_DFL && !(action.sa_flags & SA_NOCLDWAIT);
}
static const wait_ops real_ops = { NULL, wait_clock, wait_probe, wait_signal, wait_tick, exclusive_reaper };

static void uncertain(lc_owned_child *child, int error) { child->result.state = LC_TERMINATION_UNCERTAIN; child->result.error = error; }
static void record_exit(lc_owned_child *child, int status) {
    child->result.state = LC_CONFIRMED_EXIT; child->result.error = 0;
    if (WIFEXITED(status)) { child->result.exit_kind = LC_EXIT_CODE; child->result.status = WEXITSTATUS(status); }
    else { child->result.exit_kind = LC_EXIT_SIGNAL; child->result.status = WTERMSIG(status); }
}
/* 1 = confirmed exit or an error that ends ownership; 0 = still this unreaped child; -1 = EINTR. */
static int probe(lc_owned_child *child, const wait_ops *ops) {
    int status = 0; pid_t result = ops->wait(ops->context, child->pid, &status);
    if (result == child->pid) {
        if (WIFEXITED(status) || WIFSIGNALED(status)) record_exit(child, status);
        else uncertain(child, EPROTO);
        return 1;
    }
    if (result == 0) return 0;
    if (result < 0 && errno == EINTR) return -1;
    child->result.state = result < 0 && errno == ECHILD ? LC_LOST_OWNERSHIP : LC_TERMINATION_UNCERTAIN;
    child->result.error = result < 0 ? errno : EPROTO;
    return 1;
}
static int poll_until(lc_owned_child *child, int milliseconds, const wait_ops *ops) {
    int64_t start = ops->clock(ops->context); if (start < 0) { uncertain(child, EIO); return 1; }
    int64_t end = start + milliseconds;
    for (;;) {
        if (probe(child, ops) == 1) return 1;
        int64_t now = ops->clock(ops->context);
        if (now < start) { uncertain(child, EIO); return 1; }
        if (now >= end) return 0;
        ops->tick(ops->context); /* EINTR never restarts either deadline. */
    }
}
/* Wait up to `milliseconds` for the exit; if the child is still ours after that, SIGKILL it and wait up to `reap_milliseconds`
 * for the reap. The signal needs a FRESH probe under the ownership mutex that proves the child is unreaped, and
 * an interrupted or failed probe never authorises one, even at the deadline. */
static lc_wait_result wait_locked(lc_owned_child *child, int milliseconds, int reap_milliseconds, const wait_ops *ops) {
    if (child->result.state != LC_OWNED_RUNNING) return child->result;
    if (child->pid <= 0) { uncertain(child, EINVAL); return child->result; }
    if (milliseconds < 0 || milliseconds > 10000 || reap_milliseconds < 0 || reap_milliseconds > 1000) { uncertain(child, EINVAL); return child->result; }
    if (!ops->exclusive(ops->context)) { uncertain(child, EPERM); return child->result; }
    if (poll_until(child, milliseconds, ops)) return child->result;
    child->result.timed_out = 1;
    int check = probe(child, ops);
    if (check != 0) { if (check < 0) uncertain(child, EINTR); return child->result; }
    if (!ops->exclusive(ops->context)) { uncertain(child, EPERM); return child->result; }
    if (ops->signal(ops->context, child->pid, SIGKILL) == 0) child->result.kill_sent = 1;
    else {
        int error = errno; /* ESRCH is not proof of reap. */
        if (probe(child, ops) != 1) uncertain(child, error);
        return child->result;
    }
    if (!poll_until(child, reap_milliseconds, ops)) uncertain(child, ETIMEDOUT);
    return child->result;
}

int lc_spawn_owned(const char *path, int l2_child, int l3_child, lc_owned_child **out) {
    *out = NULL;
    if (l2_child <= 4 || l3_child <= 4 || l2_child == l3_child) return EINVAL;
    if (!exclusive_reaper(NULL)) return EPERM;
    lc_owned_child *child = calloc(1, sizeof *child); if (!child) return ENOMEM;
    int rc = pthread_mutex_init(&child->lock, NULL); if (rc) { free(child); return rc; }
    child->result.status = -1;
    rc = spawn_suspended(path, l2_child, l3_child, &child->pid);
    if (rc) { pthread_mutex_destroy(&child->lock); free(child); return rc; }
    *out = child;
    return 0;
}
pid_t lc_owned_pid(const lc_owned_child *child) { return child->pid; }

lc_wait_result lc_resume_owned(lc_owned_child *child) {
    if (pthread_mutex_trylock(&child->lock)) return (lc_wait_result){ LC_TERMINATION_UNCERTAIN, LC_EXIT_NONE, -1, EBUSY, 0, 0 };
    if (child->result.state == LC_OWNED_RUNNING) {
        if (child->pid <= 0) uncertain(child, EINVAL);
        else if (!exclusive_reaper(NULL)) uncertain(child, EPERM);
        else {
            int check = probe(child, &real_ops);
            if (check < 0) uncertain(child, EINTR);
            else if (check == 0) {
                if (!exclusive_reaper(NULL)) uncertain(child, EPERM);
                else if (kill(child->pid, SIGCONT) < 0) uncertain(child, errno);
            }
        }
    }
    lc_wait_result result = child->result; pthread_mutex_unlock(&child->lock); return result;
}
lc_wait_result lc_probe_owned(lc_owned_child *child) {
    if (pthread_mutex_trylock(&child->lock)) return (lc_wait_result){ LC_TERMINATION_UNCERTAIN, LC_EXIT_NONE, -1, EBUSY, 0, 0 };
    if (child->result.state == LC_OWNED_RUNNING) {
        if (!exclusive_reaper(NULL)) uncertain(child, EPERM);
        else (void)probe(child, &real_ops); /* an interrupted probe leaves the child running; the next one asks again */
    }
    lc_wait_result result = child->result; pthread_mutex_unlock(&child->lock); return result;
}
lc_wait_result lc_kill_owned(lc_owned_child *child, int reap_ms) {
    if (pthread_mutex_trylock(&child->lock)) return (lc_wait_result){ LC_TERMINATION_UNCERTAIN, LC_EXIT_NONE, -1, EBUSY, 0, 0 };
    lc_wait_result result = wait_locked(child, 0, reap_ms, &real_ops);
    pthread_mutex_unlock(&child->lock); return result;
}
void lc_owned_destroy(lc_owned_child *child) { pthread_mutex_destroy(&child->lock); free(child); }

int lc_process_start_token(pid_t pid, char *out, size_t capacity) {
    struct proc_bsdinfo info;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) != (int)sizeof info) return -1;
    int n = snprintf(out, capacity, "%llu.%06llu", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
    return n > 0 && (size_t)n < capacity ? 0 : -1;
}

/* ================================================================================================ misc */

int lc_random(void *out, size_t length) { arc4random_buf(out, length); return 0; }
int lc_boot_session_uuid(char *out, size_t capacity) {
    size_t size = capacity;
    if (sysctlbyname("kern.bootsessionuuid", out, &size, NULL, 0) || size < 2 || size > capacity) return -1;
    return (int)(size - 1); /* excluding the NUL the kernel writes */
}

/* ================================================================================================ test doubles */

/* No process lookup and no real signal: the syscall boundary of wait_locked is injected, including EINTR storms and
 * unconfirmed post-kill termination. */
typedef struct { int scenario, probes, signals, killed; int64_t time; } fake_wait;
static int64_t fake_clock(void *context) { fake_wait *f = context; if (f->scenario == 9 && f->probes > 0) return -1; return f->time; }
static void fake_tick(void *context) { ((fake_wait *)context)->time += 5; }
static int fake_exclusive(void *context) { return ((fake_wait *)context)->scenario != 10; }
static pid_t fake_probe(void *context, pid_t pid, int *status) {
    fake_wait *f = context; f->probes++;
    if (f->scenario == 0) { *status = 0; return pid; }
    if (f->scenario == 1 || (f->scenario == 8 && f->killed)) { errno = ECHILD; return -1; }
    if (f->scenario == 2 || (f->scenario == 6 && f->signals)) { errno = EIO; return -1; }
    if (f->scenario == 3 || (f->scenario == 5 && f->killed) || (f->scenario == 11 && f->time >= 10)) { errno = EINTR; return -1; }
    if (f->scenario == 7 && f->probes == 4) { *status = 0; return pid; }
    if (f->scenario == 4 && f->killed) { *status = SIGKILL; return pid; }
    return 0;
}
static int fake_signal(void *context, pid_t pid, int signal) {
    (void)pid; fake_wait *f = context; f->signals++; if (signal != SIGKILL) return -1;
    if (f->scenario == 6) { errno = ESRCH; return -1; }
    f->killed = 1; return 0;
}
int lc_test_wait_scenario(int scenario) {
    if (scenario < 0 || scenario > 14) return 0;
    fake_wait fake = { .scenario = scenario };
    wait_ops ops = { &fake, fake_clock, fake_probe, fake_signal, fake_tick, fake_exclusive };
    lc_owned_child child = { .pid = scenario == 12 ? 0 : scenario == 13 ? -1 : 4242, .result = { LC_OWNED_RUNNING, LC_EXIT_NONE, -1, 0, 0, 0 } };
    lc_wait_result result = wait_locked(&child, scenario == 14 ? -1 : 10, 10, &ops);
    int state = scenario == 0 || scenario == 4 || scenario == 7 ? LC_CONFIRMED_EXIT : scenario == 1 || scenario == 8 ? LC_LOST_OWNERSHIP : LC_TERMINATION_UNCERTAIN;
    int signals = scenario == 4 || scenario == 5 || scenario == 6 || scenario == 8 ? 1 : 0;
    if (result.state != state || fake.signals != signals || fake.time > 20) return 0;
    if (scenario == 4 && (result.exit_kind != LC_EXIT_SIGNAL || result.status != SIGKILL || !result.kill_sent || !result.timed_out)) return 0;
    if (scenario == 5 && (result.error != ETIMEDOUT || !result.kill_sent)) return 0;
    if (scenario == 1 && result.error != ECHILD) return 0;
    if (scenario == 6 && result.kill_sent) return 0;
    int probes = fake.probes; result = wait_locked(&child, 10, 10, &ops);
    return result.state == state && fake.probes == probes && fake.signals == signals;
}
