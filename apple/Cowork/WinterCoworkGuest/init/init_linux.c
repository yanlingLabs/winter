/*
 * /init: the static PID 1 of the production Mac Cowork guest (N2 slice S5). Linux only.
 *
 * It owns the process plumbing and the privileged system calls; every decision lives in boot.c (unit-tested natively).
 *
 *   1. mount the pseudo-filesystems and open /dev/kmsg (fixed log codes only: no plan, no path, no serial number but the two
 *      expected ones ever reaches the console);
 *   2. find the one virtio-console port and the two virtio disks by what the kernel publishes (discover.c), never by probe order;
 *   3. start the relay (it owns the port from now on) and the bootstrap helper (python3 -I -S -B guest_bootstrap.py);
 *   4. run the event loop: relay messages, helper messages, children, the supervisor's ready line;
 *   5. on `drain` or on any failure: stop everything, sync, unmount, and only then reboot(RB_POWER_OFF).
 *
 * There is no network bring-up of any kind: the guest has no NIC, no vsock and no interface to configure.
 */
#define _GNU_SOURCE
#include "../common/ctl.h"
#include "../common/wmx.h"
#include "boot.h"
#ifdef WG_FILE_CHANNEL_V1
#include "dataroots.h"
#endif
#include "discover.h"
#include "ext4sb.h"
#include "mounts.h"
#include "skeleton.h"
#include "trusted_config.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/reboot.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

_Static_assert(WG_MS_RDONLY == MS_RDONLY && WG_MS_NOSUID == MS_NOSUID && WG_MS_NODEV == MS_NODEV && WG_MS_NOEXEC == MS_NOEXEC &&
               WG_MS_NOATIME == MS_NOATIME, "mount flag values must be the kernel's");

#define RELAY_PATH "/opt/winter/libexec/winter-guest-relay"
#define HELPER_PATH "/opt/winter/libexec/guest_bootstrap.py"
#ifndef SUPERVISOR_PATH
#define SUPERVISOR_PATH "/opt/winter/libexec/linux-supervisor.py"
#endif
/* The three paths below may be overridden only by the native test build (tests/linux_init_tool.c), which runs the real fork / descriptor
 * plumbing against a script in a temporary directory. The production build (build.py) defines none of them. */
#ifndef PYTHON_PATH
#define PYTHON_PATH "/usr/bin/python3"
#endif
#define BASE_CONFIG_PATH "/opt/winter/etc/supervisor-base.json"
#define RUNTIME_ARTIFACTS_PATH "/opt/winter/etc/supervisor-runtime-artifacts.json"
#ifndef WORKSPACE_CONVERSATIONS
#define WORKSPACE_CONVERSATIONS "/workspace/.winter/conversations"
#endif
#ifndef RUN_CONVERSATIONS
#define RUN_CONVERSATIONS "/run/winter/conversations"
#endif
#ifndef TRUSTED_DIR
#define TRUSTED_DIR "/run/winter/trusted"
#endif
#define TRUSTED_NAME "config.json"
#define SUPERVISOR_READY_LINE "{\"fullGuestExecutionEnabled\":false,\"ready\":true}"
#define DISCOVERY_WAIT_MS 10000
#define SUPERVISOR_READY_DEADLINE_MS 30000

static long long supervisor_deadline;   /* 0 = no supervisor waiting for its ready line */

static char *const CHILD_ENV[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", NULL };

/* The system calls whose results the private-directory and flush code checks. The native test replaces them to make a refusal observable
 * (a non-root test process cannot chown to another user and no regular file's fsync fails); PID 1 never changes them. */
static struct {
    int (*fchown_fn)(int, uid_t, gid_t);
    int (*fchmod_fn)(int, mode_t);
    int (*fsync_fn)(int);
} sys_calls = { fchown, fchmod, fsync };

static struct wg_boot boot;
static struct wg_boot_ops boot_ops;
static struct wg_mount_ops mount_ops;
static int kmsg_fd = -1, signal_fd = -1;

static struct {
    pid_t relay, helper, supervisor;
    int r2p_r, p2r_w;                 /* relay -> init, init -> relay */
    int h2p_r, p2h_w;                 /* helper -> init, init -> helper */
    int rt_in_r, rt_out_w, rt_err_w;  /* the supervisor's ends of the runtime pipes */
#ifdef WG_FILE_CHANNEL_V1
    int file_in_r, file_out_w;        /* the supervisor's ends of the file channel's two FIFOs (anonymous pipes) */
#endif
    int sup_stdin_w, sup_out_r;
    struct wg_disk data, environment;
    struct wg_port port;
    char ready_line[128];
    size_t ready_have;
    int ready_seen;
} G;

static struct ctl_reader relay_reader, helper_reader;
static uint8_t relay_payload[CTL_MAX_PAYLOAD], helper_payload[CTL_MAX_PAYLOAD];

/* ------------------------------------------------------------------------------------------------ small helpers */

static long long clock_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void sleep_ms(unsigned ms) {
    struct timespec t = { ms / 1000, (long)(ms % 1000) * 1000000L };
    nanosleep(&t, NULL);
}

static void log_code(const char *code) {
    char line[160];
    int n = snprintf(line, sizeof line, "<6>winter-guest: ");
    for (const char *p = code; *p && n < (int)sizeof line - 2; p++) line[n++] = (*p >= 0x20 && *p < 0x7f) ? *p : '?';
    line[n++] = '\n';
    int fd = kmsg_fd >= 0 ? kmsg_fd : 2;
    if (write(fd, line, (size_t)n) < 0) { /* nothing more to do */ }
}

static void power_off_now(void) {
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}

static void die_early(const char *code) {
    log_code(code);
    power_off_now();
}

/* Bounded: a peer that stopped reading must never wedge PID 1 inside a write (a drain would then never be seen). */
#define WRITE_DEADLINE_MS 2000
static int write_all(int fd, const void *data, size_t length) {
    const uint8_t *p = data;
    long long deadline = clock_ms() + WRITE_DEADLINE_MS;
    while (length) {
        ssize_t n = write(fd, p, length);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) {
            long long left = deadline - clock_ms();
            if (left <= 0) return -1;
            struct pollfd w = { fd, POLLOUT, 0 };
            poll(&w, 1, (int)(left > 200 ? 200 : left));
            continue;
        }
        if (n <= 0) return -1;
        p += n; length -= (size_t)n;
    }
    return 0;
}

static int send_ctl(int fd, uint8_t tag, const void *payload, size_t length) {
    static uint8_t scratch[CTL_HEADER_BYTES + CTL_MAX_PAYLOAD];
    if (fd < 0) return -1;
    size_t n = ctl_encode(scratch, sizeof scratch, tag, payload, length);
    return n && write_all(fd, scratch, n) == 0 ? 0 : -1;
}

static void close_fd(int *fd) {
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

/* ------------------------------------------------------------------------------------------------ children */

/* Moves the given descriptors to 3, 4, ... in the child (every source is first copied above 30 so none is clobbered), points
 * 0/1/2 at /dev/null or the given descriptors, and execs. Everything else is close-on-exec. */
static int high_copy(int fd) {
    int copy = fcntl(fd, F_DUPFD, 30);
    if (copy < 0) _exit(120);
    return copy;
}

static void exec_child(const int *sources, size_t count, int stdin_fd, int stdout_fd, char *const argv[]) {
    int temporary[10];
    for (size_t i = 0; i < count; i++) temporary[i] = high_copy(sources[i]);
    int low = open("/dev/null", O_RDWR);   /* not close-on-exec: it may be handed to 0, 1 and 2 */
    if (low < 0) _exit(121);
    int null_fd = high_copy(low);
    close(low);
    int in = stdin_fd >= 0 ? high_copy(stdin_fd) : -1, out = stdout_fd >= 0 ? high_copy(stdout_fd) : -1;
    if (dup2(in >= 0 ? in : null_fd, 0) < 0 || dup2(out >= 0 ? out : null_fd, 1) < 0 || dup2(null_fd, 2) < 0) _exit(122);
    for (size_t i = 0; i < count; i++) if (dup2(temporary[i], 3 + (int)i) < 0) _exit(122);
    for (size_t i = 0; i < count; i++) close(temporary[i]);
    if (in >= 0) close(in);
    if (out >= 0) close(out);
    close(null_fd);
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    signal(SIGPIPE, SIG_DFL);   /* PID 1 ignores it; the programs below expect the ordinary disposition */
    umask(022);                 /* PID 1 runs with 077; the supervisor creates directories whose modes assume the usual 022 */
    execve(argv[0], argv, CHILD_ENV);
    _exit(127);
}

static int make_pipe(int pair[2]) {
    if (pipe2(pair, O_CLOEXEC) != 0) return -1;
    return 0;
}

#ifdef WG_FILE_CHANNEL_V1
/* The file channel's two FIFOs are anonymous pipes: non-blocking, root-owned, single-link (exactly what the supervisor's file service demands of its descriptors).
 * FILE_IN carries the host's request lines (the relay writes, the supervisor reads), FILE_OUT the response lines (the supervisor writes, the relay reads). */
static int fifo_end_ok(int fd) {
    struct stat st;
    int flags = fcntl(fd, F_GETFL);
    /* "root-owned": owned by the process that made it, which in PID 1 is root (the native tests run as themselves). */
    return fstat(fd, &st) == 0 && S_ISFIFO(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == 1 && flags >= 0 && (flags & O_NONBLOCK) != 0;
}
static int make_file_pipe(int pair[2]) {
    return pipe2(pair, O_CLOEXEC | O_NONBLOCK);   /* non-blocking on both file descriptions; owned by this process and single-link by what a pipe is: fifo_end_ok() checks it again at the start */
}
/* After the fork PID 1 keeps neither supervisor end: a copy left here would keep the FIFOs open after the supervisor and the relay are gone (no EOF, no EPIPE). */
static void release_file_ends(void) {
    close_fd(&G.file_in_r);
    close_fd(&G.file_out_w);
}
#endif

static pid_t spawn_relay(int port_fd, int r2p[2], int p2r[2], int rt_in[2], int rt_out[2], int rt_err[2]
#ifdef WG_FILE_CHANNEL_V1
                         , int file_in[2], int file_out[2]
#endif
                         ) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
#ifdef WG_FILE_CHANNEL_V1
        int sources[8] = { port_fd, p2r[0], r2p[1], rt_in[1], rt_out[0], rt_err[0], file_in[1], file_out[0] };
        char *argv[] = { RELAY_PATH, "--port", "3", "--ctl-in", "4", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8", "--file-in", "9", "--file-out", "10", NULL };
        exec_child(sources, 8, -1, -1, argv);
#else
        int sources[6] = { port_fd, p2r[0], r2p[1], rt_in[1], rt_out[0], rt_err[0] };
        char *argv[] = { RELAY_PATH, "--port", "3", "--ctl-in", "4", "--ctl-out", "5", "--rt-in", "6", "--rt-out", "7", "--rt-err", "8", NULL };
        exec_child(sources, 6, -1, -1, argv);
#endif
    }
    return pid;
}

static pid_t spawn_helper(int h2p[2], int p2h[2]) {
    char data[300], environment[300];
    snprintf(data, sizeof data, "%s:%u:%u", G.data.node, G.data.major, G.data.minor);
    snprintf(environment, sizeof environment, "%s:%u:%u", G.environment.node, G.environment.major, G.environment.minor);
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        int sources[2] = { p2h[0], h2p[1] };
#ifdef WG_FILE_CHANNEL_V1
        char *argv[] = { PYTHON_PATH, "-I", "-S", "-B", HELPER_PATH, "--channel-fds", "3,4", "--data", data, "--environment", environment, "--file-channel-v1", NULL };
#else
        char *argv[] = { PYTHON_PATH, "-I", "-S", "-B", HELPER_PATH, "--channel-fds", "3,4", "--data", data, "--environment", environment, NULL };
#endif
        exec_child(sources, 2, -1, -1, argv);
    }
    return pid;
}

/* Reaps every exited child. With `dispatch`, the three known children become boot events; stop operations reap silently. */
static void reap_children(int dispatch);
static void pump_helper(void);

static void reap_children(int dispatch) {
    for (;;) {
        int status = 0;
        pid_t pid = waitpid(-1, &status, WNOHANG);
        if (pid <= 0) return;
        int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
        if (pid == G.helper) {
            G.helper = 0;
            if (dispatch) { pump_helper(); wg_boot_helper_exited(&boot, code); }
        } else if (pid == G.supervisor) {
            G.supervisor = 0;
            if (dispatch) wg_boot_supervisor_exited(&boot, code);
        } else if (pid == G.relay) {
            G.relay = 0;
            if (dispatch) wg_boot_relay_exited(&boot);
        }
    }
}

static void wait_for_exit(pid_t *pid, long long deadline_ms) {
    while (*pid > 0) {
        reap_children(0);
        if (*pid <= 0) return;
        if (clock_ms() >= deadline_ms) break;
        sleep_ms(20);
    }
    if (*pid > 0) {
        kill(*pid, SIGKILL);
        for (int i = 0; i < 100 && *pid > 0; i++) { reap_children(0); if (*pid > 0) sleep_ms(10); }
    }
}

/* ------------------------------------------------------------------------------------------------ boot_ops: effects */

static long long op_now(void *ctx) { (void)ctx; return clock_ms(); }
static void op_pause(void *ctx, unsigned ms) { (void)ctx; sleep_ms(ms); }
static void op_log(void *ctx, const char *code) { (void)ctx; log_code(code); }
static void op_to_relay(void *ctx, uint8_t tag, const void *payload, size_t length) {
    (void)ctx;
    if (send_ctl(G.p2r_w, tag, payload, length) != 0) wg_boot_fail_stop(&boot, "relay-write-failed");
}
static void op_to_helper(void *ctx, uint8_t tag, const void *payload, size_t length) {
    (void)ctx;
    if (G.p2h_w >= 0 && send_ctl(G.p2h_w, tag, payload, length) != 0) wg_boot_fail_stop(&boot, "helper-write-failed");
}

static int op_wait_flushed(void *ctx, unsigned timeout_ms) {
    (void)ctx;
    long long deadline = clock_ms() + timeout_ms;
    struct ctl_reader reader;
    static uint8_t payload[CTL_MAX_PAYLOAD];
    ctl_reader_init(&reader, payload, sizeof payload, "PDFf");
    for (;;) {
        long long left = deadline - clock_ms();
        if (left <= 0) return 0;
        struct pollfd p = { G.r2p_r, POLLIN, 0 };
        if (poll(&p, 1, (int)left) <= 0) continue;
        uint8_t buffer[512];
        ssize_t n = read(G.r2p_r, buffer, sizeof buffer);
        if (n <= 0) return 0;
        for (ssize_t off = 0; off < n;) {
            size_t used = 0;
            enum ctl_event event = ctl_reader_feed(&reader, buffer + off, (size_t)(n - off), &used);
            off += (ssize_t)used;
            if (event == CTL_BAD) return 0;
            if (event == CTL_MESSAGE && reader.tag == CTL_FLUSHED) return 1;
            if (used == 0) break;
        }
    }
}

static int mop_mount(void *ctx, const char *source, const char *target, const char *fstype, unsigned long flags, const char *data) {
    (void)ctx;
    return mount(source, target, fstype, flags, data);
}
static int mop_umount(void *ctx, const char *target) { (void)ctx; return umount2(target, 0); }
static int mop_syncfs(void *ctx, const char *path) {
    (void)ctx;
    int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    int rc = syncfs(fd);
    close(fd);
    return rc;
}
static int mop_mkdir(void *ctx, const char *path) {
    (void)ctx;
    if (mkdir(path, 0700) != 0 && errno != EEXIST) return -1;
    return chmod(path, 0700);
}
static int mop_check(void *ctx, const char *node, const uint8_t uuid[16]) {
    (void)ctx;
    enum wg_ext4_result result = wg_ext4_check_node(node, uuid);
    if (result != WG_EXT4_OK) { char code[48]; snprintf(code, sizeof code, "volume-check-%s", wg_ext4_result_name(result)); log_code(code); }
    return result == WG_EXT4_OK ? 0 : -1;
}
static int mop_skeleton(void *ctx) {
    (void)ctx;
    int root = open(WG_WORKSPACE_PATH, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (root < 0) return -1;
    int rc = wg_skeleton_apply(root, WG_WORKSPACE_SKELETON, WG_WORKSPACE_SKELETON_COUNT, NULL);
    close(root);
    return rc;
}

static int op_replay(void *ctx, const char *purpose) {
    (void)ctx;
    const char *node = strcmp(purpose, "data") == 0 ? G.data.node : G.environment.node;
    return wg_replay_journal(&mount_ops, node, purpose);
}
static int op_umount_replay(void *ctx, const char *purpose) {
    (void)ctx;
    char target[96];
    if (snprintf(target, sizeof target, "%s/%s", WG_REPLAY_ROOT, purpose) >= (int)sizeof target) return -1;
    return umount2(target, 0);
}
static int op_mount_volumes(void *ctx, const uint8_t data_uuid[16], const uint8_t environment_uuid[16], int *leftover) {
    (void)ctx;
    return wg_mount_volumes(&mount_ops, G.data.node, data_uuid, G.environment.node, environment_uuid, leftover);
}
static int op_verify_unmounted(void *ctx, int volume, const uint8_t uuid[16]) {
    (void)ctx;
    return wg_ext4_check_node(volume == WG_VOLUME_DATA ? G.data.node : G.environment.node, uuid) == WG_EXT4_OK ? 0 : -1;
}
static int op_umount(void *ctx, int volume) {
    (void)ctx;
    return volume == WG_VOLUME_DATA ? umount2(WG_WORKSPACE_PATH, 0) : -1;   /* the environment disk is never mounted in N2 */
}

static int op_read_runtime_artifacts(void *ctx, unsigned profile, char *out, size_t capacity, size_t *length) {
    (void)ctx;
    /* This image carries the host-query runtime only. The guided profile needs a second executable that is not part of it, so that profile fails here, at
     * boot, instead of starting a supervisor whose runtime would refuse every session. */
    if (profile != 1) return -1;
    long n = wg_read_small_file(RUNTIME_ARTIFACTS_PATH, out, capacity, 0);
    if (n < 0) return -1;
    *length = (size_t)n;
    return 0;
}

/* One private directory per conversation: created or adopted below a root-held descriptor, never by path through a link. Ownership and
 * mode are set on the open descriptor. The supervisor refuses a store that is not empty (N2 starts fresh conversations only). */
static int make_private_dir(const char *parent_path, const char *name, uid_t uid) {
    int parent = open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return -1;
    if (mkdirat(parent, name, 0700) != 0 && errno != EEXIST) { close(parent); return -1; }
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(parent);
    if (fd < 0) return -1;
    struct stat st;
    int rc = sys_calls.fchown_fn(fd, uid, (gid_t)uid);
    if (rc == 0) rc = sys_calls.fchmod_fn(fd, 0700);
    if (rc == 0 && (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != uid || (st.st_mode & 07777) != 0700)) rc = -1;
    close(fd);
    return rc;
}
#ifdef WG_FILE_CHANNEL_V1
/* The supervisor's file service reads only a root that is root:workspaceGid 02770 on the data volume, so PID 1 makes every data-volume root that way, for a workspace that has
 * a file channel (a browse uid). */
static const struct wg_dataroots_ops *dataroots_ops = &wg_dataroots_production;   /* the native tests, which run as an ordinary user, point it at their own owner */
static int prepare_data_roots(const struct wg_conversation_set *set) {
    if (set->browse_uid == 0) return wg_make_plan_views(WG_WORKSPACE_PATH, set, dataroots_ops);   /* no browse uid: no data roots, but a plan view is PID 1's to make */
    return wg_make_data_roots(WG_WORKSPACE_PATH, set, dataroots_ops);
}
#endif
static int op_prepare_conversation_dirs(void *ctx, const struct wg_conversation_set *set) {
    (void)ctx;
    for (unsigned i = 0; i < set->count; i++) {
        if (make_private_dir(WORKSPACE_CONVERSATIONS, set->session_id[i], (uid_t)set->runtime_uid[i]) != 0) return -1;
        if (make_private_dir(RUN_CONVERSATIONS, set->session_id[i], (uid_t)set->runtime_uid[i]) != 0) return -1;
    }
#ifdef WG_FILE_CHANNEL_V1
    if (prepare_data_roots(set) != 0) return -1;
#endif
    return 0;
}
#ifdef WG_FILE_CHANNEL_V1
static int op_read_data_device(void *ctx, uint64_t *device) {
    (void)ctx;
    struct stat st;
    if (stat(WG_WORKSPACE_PATH, &st) != 0 || !S_ISDIR(st.st_mode)) return -1;
    *device = (uint64_t)st.st_dev;
    return 0;
}
#endif
static int op_read_base_config(void *ctx, char *out, size_t capacity, size_t *length) {
    (void)ctx;
    long n = wg_read_small_file(BASE_CONFIG_PATH, out, capacity, 0);
    if (n < 0) return -1;
    *length = (size_t)n;
    return 0;
}
static int op_read_boot_id(void *ctx, char out[37]) {
    (void)ctx;
    int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char text[64];
    ssize_t n = read(fd, text, sizeof text - 1);
    close(fd);
    if (n < 36) return -1;
    text[36] = '\0';
    if (!wg_boot_id_ok(text)) return -1;
    memcpy(out, text, 37);
    return 0;
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 ? 0 : -1;
}
/* The supervisor's ends of the runtime pipes are non-blocking file descriptions (RuntimeDuplexPorts demands it). */
static int runtime_ends_nonblocking(void) {
    return set_nonblocking(G.rt_in_r) == 0 && set_nonblocking(G.rt_out_w) == 0 && set_nonblocking(G.rt_err_w) == 0 ? 0 : -1;
}
/* After the fork PID 1 keeps none of them: a copy left here would keep the pipes open after the supervisor and the relay are gone
 * (no EOF, no EPIPE). With no host-query conversation these ends were never handed to anyone. */
static void release_runtime_ends(void) {
    close_fd(&G.rt_in_r);
    close_fd(&G.rt_out_w);
    close_fd(&G.rt_err_w);
}

static int op_start_supervisor(void *ctx, const char *config, size_t length, int flags) {
    (void)ctx;
#ifdef WG_FILE_CHANNEL_V1
    int with_ports = (flags & WG_START_PORTS) != 0, with_files = (flags & WG_START_FILE_CHANNEL) != 0;
#else
    int with_ports = flags;
#endif
    int config_fd = wg_write_trusted_config(TRUSTED_DIR, TRUSTED_NAME, config, length);
    if (config_fd < 0) return -1;
    int stdin_pipe[2], stdout_pipe[2];
    if (make_pipe(stdin_pipe) != 0) { close(config_fd); return -1; }
    if (make_pipe(stdout_pipe) != 0) { close(config_fd); close(stdin_pipe[0]); close(stdin_pipe[1]); return -1; }
    /* The supervisor's ends of the runtime pipes are non-blocking file descriptions, root-owned, single-link: exactly what
     * RuntimeDuplexPorts demands of its input/stdout/stderr descriptors. */
    if (with_ports && runtime_ends_nonblocking() != 0) { close(config_fd); close(stdin_pipe[0]); close(stdin_pipe[1]); close(stdout_pipe[0]); close(stdout_pipe[1]); return -1; }
#ifdef WG_FILE_CHANNEL_V1
    if (with_files && (!fifo_end_ok(G.file_in_r) || !fifo_end_ok(G.file_out_w))) { close(config_fd); close(stdin_pipe[0]); close(stdin_pipe[1]); close(stdout_pipe[0]); close(stdout_pipe[1]); return -1; }
#endif
    pid_t pid = fork();
    if (pid < 0) { close(config_fd); close(stdin_pipe[0]); close(stdin_pipe[1]); close(stdout_pipe[0]); close(stdout_pipe[1]); return -1; }
    if (pid == 0) {
        setsid();
#ifdef WG_FILE_CHANNEL_V1
        /* Descriptors, in order: 3 the config, then 4,5,6 the runtime ports (a host-query conversation), then the file channel's IN and OUT (7,8 or 4,5): always the
         * LAST two arguments, so the supervisor can tell a file service from none by the tail alone. */
        int sources[6], count = 0;
        sources[count++] = config_fd;
        if (with_ports) { sources[count++] = G.rt_in_r; sources[count++] = G.rt_out_w; sources[count++] = G.rt_err_w; }
        if (with_files) { sources[count++] = G.file_in_r; sources[count++] = G.file_out_w; }
        char *argv[12];
        int n = 0;
        argv[n++] = PYTHON_PATH; argv[n++] = "-I"; argv[n++] = "-S"; argv[n++] = "-B"; argv[n++] = SUPERVISOR_PATH; argv[n++] = "--trusted-config-fd"; argv[n++] = "3";
        if (with_ports) { argv[n++] = "--runtime-ports-fds"; argv[n++] = "4,5,6"; }
        if (with_files) { argv[n++] = "--file-channel-fds"; argv[n++] = with_ports ? "7,8" : "4,5"; }
        argv[n] = NULL;
        exec_child(sources, (size_t)count, stdin_pipe[0], stdout_pipe[1], argv);
#else
        int sources[4] = { config_fd, G.rt_in_r, G.rt_out_w, G.rt_err_w };
        char *with[] = { PYTHON_PATH, "-I", "-S", "-B", SUPERVISOR_PATH, "--trusted-config-fd", "3", "--runtime-ports-fds", "4,5,6", NULL };
        char *without[] = { PYTHON_PATH, "-I", "-S", "-B", SUPERVISOR_PATH, "--trusted-config-fd", "3", NULL };
        exec_child(sources, with_ports ? 4 : 1, stdin_pipe[0], stdout_pipe[1], with_ports ? with : without);
#endif
    }
    close(config_fd);
    close(stdin_pipe[0]);
    close(stdout_pipe[1]);
    release_runtime_ends();
#ifdef WG_FILE_CHANNEL_V1
    release_file_ends();
#endif
    G.supervisor = pid;
    supervisor_deadline = clock_ms() + SUPERVISOR_READY_DEADLINE_MS;
    G.sup_stdin_w = stdin_pipe[1];
    G.sup_out_r = stdout_pipe[0];
    fcntl(G.sup_out_r, F_SETFL, fcntl(G.sup_out_r, F_GETFL) | O_NONBLOCK);
    return 0;
}

static void op_stop_helper(void *ctx, long long deadline_ms) {
    (void)ctx;
    close_fd(&G.p2h_w);                 /* end of stream: a helper waiting for a message leaves at once */
    if (G.helper > 0) wait_for_exit(&G.helper, deadline_ms);
    close_fd(&G.h2p_r);
}
static void op_stop_supervisor(void *ctx, long long deadline_ms) {
    (void)ctx;
    close_fd(&G.sup_stdin_w);           /* the supervisor serves until its stdin ends, then closes its service */
    if (G.supervisor > 0) {
        pid_t group = G.supervisor;
        wait_for_exit(&G.supervisor, deadline_ms);
        kill(-group, SIGKILL);          /* anything left in its session */
    }
    close_fd(&G.sup_out_r);
}

static int is_kernel_thread(pid_t pid) {
    char path[64], text[512];
    snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 1;               /* gone already */
    ssize_t n = read(fd, text, sizeof text - 1);
    close(fd);
    if (n <= 0) return 1;
    text[n] = '\0';
    const char *close_paren = strrchr(text, ')');
    int ppid = 0;
    char state;
    if (!close_paren || sscanf(close_paren + 1, " %c %d", &state, &ppid) != 2) return 1;
    return ppid == 2 || pid == 2;
}

static void op_kill_all(void *ctx) {
    (void)ctx;
    for (int round = 0; round < 10; round++) {
        int killed = 0;
        DIR *proc = opendir("/proc");
        if (!proc) return;
        struct dirent *entry;
        while ((entry = readdir(proc)) != NULL) {
            char *end = NULL;
            long pid = strtol(entry->d_name, &end, 10);
            if (!*entry->d_name || *end || pid <= 1 || pid == G.relay || pid == getpid()) continue;
            if (is_kernel_thread((pid_t)pid)) continue;
            if (kill((pid_t)pid, SIGKILL) == 0) killed++;
        }
        closedir(proc);
        reap_children(0);
        if (!killed) return;
        sleep_ms(20);
    }
}
static void op_sync_all(void *ctx) { (void)ctx; sync(); }
static int op_flush_devices(void *ctx, unsigned volumes) {
    (void)ctx;
    sync();
    int result = 0;
    for (int v = 0; v < 2; v++) {
        if (!(volumes & (1u << v))) continue;
        int fd = open(v == WG_VOLUME_DATA ? G.data.node : G.environment.node, O_RDONLY | O_CLOEXEC);
        if (fd < 0) { result = -1; continue; }
        if (sys_calls.fsync_fn(fd) != 0) result = -1;
        if (close(fd) != 0) result = -1;
    }
    return result;
}
static void op_power_off(void *ctx) { (void)ctx; power_off_now(); }

/* ------------------------------------------------------------------------------------------------ event loop */

static void dispatch_relay(void) {
    wg_boot_relay_message(&boot, relay_reader.tag, relay_reader.payload, relay_reader.length);
}
static void dispatch_helper(void) {
    wg_boot_helper_message(&boot, helper_reader.tag, helper_reader.payload, helper_reader.length);
}

/* Returns 0 normally, 1 at end of stream, -1 for garbage. */
static int pump(int fd, struct ctl_reader *reader, void (*dispatch)(void)) {
    uint8_t buffer[4096];
    for (;;) {
        ssize_t n = read(fd, buffer, sizeof buffer);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == EAGAIN) return 0;
        if (n <= 0) return 1;
        for (ssize_t off = 0; off < n;) {
            size_t used = 0;
            enum ctl_event event = ctl_reader_feed(reader, buffer + off, (size_t)(n - off), &used);
            off += (ssize_t)used;
            if (event == CTL_BAD) return -1;
            if (event == CTL_MESSAGE) { dispatch(); if (boot.phase == WG_PHASE_DEAD) return 0; }
            else if (used == 0) return -1;
        }
    }
}

static void pump_helper(void) {
    if (G.h2p_r < 0) return;
    int result = pump(G.h2p_r, &helper_reader, dispatch_helper);
    if (result < 0) wg_boot_fail_stop(&boot, "helper-channel-garbage");
    if (result > 0) close_fd(&G.h2p_r);
}

static void pump_supervisor_ready(void) {
    if (G.sup_out_r < 0) return;
    char chunk[256];
    for (int round = 0; round < 8; round++) {   /* bounded: other events must not starve behind a chatty child */
        ssize_t n = read(G.sup_out_r, chunk, sizeof chunk);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
        if (n <= 0) { close_fd(&G.sup_out_r); if (!G.ready_seen) { supervisor_deadline = 0; wg_boot_supervisor_not_ready(&boot, "supervisor-ready-eof"); } return; }
        for (ssize_t i = 0; i < n; i++) {
            if (G.ready_seen) break;                 /* anything after the first line is discarded unread */
            if (chunk[i] == '\n') {
                G.ready_line[G.ready_have] = '\0';
                if (G.ready_have != sizeof SUPERVISOR_READY_LINE - 1 || memcmp(G.ready_line, SUPERVISOR_READY_LINE, G.ready_have) != 0) { G.ready_seen = 1; supervisor_deadline = 0; wg_boot_supervisor_not_ready(&boot, "supervisor-ready-line"); return; }
                G.ready_seen = 1;
                supervisor_deadline = 0;
                wg_boot_supervisor_ready(&boot);
            } else if (G.ready_have + 1 >= sizeof G.ready_line) {
                G.ready_seen = 1;
                supervisor_deadline = 0;
                wg_boot_supervisor_not_ready(&boot, "supervisor-ready-line");
                return;
            } else {
                G.ready_line[G.ready_have++] = chunk[i];
            }
        }
    }
}

static int mount_pseudo(const char *source, const char *target, const char *type, unsigned long flags, const char *data) {
    if (mount(source, target, type, flags, data) == 0 || errno == EBUSY) return 0;
    return -1;
}

#ifdef WG_FILE_CHANNEL_V1
#define PROTECTED_HARDLINKS_PATH "/proc/sys/fs/protected_hardlinks"
static int set_protected_hardlinks(const char *path) {
    int fd = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t written = write(fd, "1\n", 2);   /* a sysctl write that the kernel refuses fails here; there is nothing to read back that the return value does not say */
    close(fd);
    return written == 2 ? 0 : -1;
}
#endif

static void discover_or_die(void) {
    struct wg_discover_env env = { "/sys", "/dev", NULL, NULL };
    long long deadline = clock_ms() + DISCOVERY_WAIT_MS;
    char why[64];
    for (;;) {
        enum wg_discover_status disks = wg_find_disks(&env, &G.data, &G.environment, why, sizeof why);
        if (disks == WG_DISCOVER_REFUSED) { char code[96]; snprintf(code, sizeof code, "disks-refused:%s", why); die_early(code); }
        enum wg_discover_status port = wg_find_port(&env, &G.port, why, sizeof why);
        if (port == WG_DISCOVER_REFUSED) { char code[96]; snprintf(code, sizeof code, "port-refused:%s", why); die_early(code); }
        if (disks == WG_DISCOVER_OK && port == WG_DISCOVER_OK) return;
        if (clock_ms() >= deadline) die_early("discovery-timeout");
        sleep_ms(50);
    }
}

int main(void) {
    if (getpid() != 1) return 2;
    G.r2p_r = G.p2r_w = G.h2p_r = G.p2h_w = G.rt_in_r = G.rt_out_w = G.rt_err_w = G.sup_stdin_w = G.sup_out_r = -1;
#ifdef WG_FILE_CHANNEL_V1
    G.file_in_r = G.file_out_w = -1;
#endif
    umask(077);
    signal(SIGPIPE, SIG_IGN);
    prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);

    /* /dev first: it gives us /dev/null and /dev/kmsg. */
    if (mount_pseudo("devtmpfs", "/dev", "devtmpfs", MS_NOSUID | MS_NOEXEC, "mode=0755") != 0) { reboot(RB_POWER_OFF); for (;;) pause(); }
    /* The kernel starts init with 0, 1 and 2 closed when the initramfs has no /dev/console. Fill them with /dev/null BEFORE any other
     * descriptor is opened, so that none of ours (the kmsg log, pipes, the port) ever lands on a standard descriptor. */
    for (int fd = 0; fd < 3; fd++) {
        if (fcntl(fd, F_GETFD) >= 0) continue;
        int null_fd = open("/dev/null", O_RDWR);
        if (null_fd < 0) { reboot(RB_POWER_OFF); for (;;) pause(); }
        if (null_fd != fd) { dup2(null_fd, fd); close(null_fd); }
    }
    kmsg_fd = open("/dev/kmsg", O_WRONLY | O_CLOEXEC | O_NOCTTY);
    if (mount_pseudo("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) die_early("mount-proc");
    if (mount_pseudo("sysfs", "/sys", "sysfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) die_early("mount-sys");
    if (mount_pseudo("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=0755,size=32m") != 0) die_early("mount-run");
    if (mount_pseudo("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777,size=64m") != 0) die_early("mount-tmp");
    log_code("init-start");
#ifdef WG_FILE_CHANNEL_V1
    /* The file service refuses a hard link to a file the browse identity could not itself open; the kernel enforces the same for every identity once this is 1. */
    if (set_protected_hardlinks(PROTECTED_HARDLINKS_PATH) != 0) die_early("protected-hardlinks");
#endif

    int run_root = open("/run", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (run_root < 0 || wg_skeleton_apply(run_root, WG_RUN_SKELETON, WG_RUN_SKELETON_COUNT, NULL) != 0) die_early("run-skeleton");
    close(run_root);

    discover_or_die();

    sigset_t mask;
    sigemptyset(&mask);
    sigaddset(&mask, SIGCHLD);
    sigprocmask(SIG_BLOCK, &mask, NULL);
    signal_fd = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
    if (signal_fd < 0) die_early("signalfd");

    int port_fd = open(G.port.node, O_RDWR | O_CLOEXEC | O_NOCTTY | O_NONBLOCK);
    struct stat st;
    if (port_fd < 0 || fstat(port_fd, &st) != 0 || !S_ISCHR(st.st_mode) || (unsigned)major(st.st_rdev) != G.port.major || (unsigned)minor(st.st_rdev) != G.port.minor)
        die_early("port-open");

    int r2p[2], p2r[2], h2p[2], p2h[2], rt_in[2], rt_out[2], rt_err[2];
    if (make_pipe(r2p) || make_pipe(p2r) || make_pipe(h2p) || make_pipe(p2h) || make_pipe(rt_in) || make_pipe(rt_out) || make_pipe(rt_err)) die_early("pipes");
#ifdef WG_FILE_CHANNEL_V1
    int file_in[2], file_out[2];
    if (make_file_pipe(file_in) != 0 || make_file_pipe(file_out) != 0) die_early("file-channel-fifos");
#endif

    memset(&mount_ops, 0, sizeof mount_ops);
    mount_ops.mount = mop_mount; mount_ops.umount = mop_umount; mount_ops.syncfs_path = mop_syncfs;
    mount_ops.mkdir_private = mop_mkdir; mount_ops.check_volume = mop_check; mount_ops.skeleton = mop_skeleton;
    memset(&boot_ops, 0, sizeof boot_ops);
    boot_ops.now_ms = op_now; boot_ops.pause_ms = op_pause; boot_ops.log = op_log; boot_ops.to_relay = op_to_relay; boot_ops.to_helper = op_to_helper;
    boot_ops.wait_flushed = op_wait_flushed; boot_ops.replay = op_replay; boot_ops.umount_replay = op_umount_replay;
    boot_ops.mount_volumes = op_mount_volumes; boot_ops.umount = op_umount; boot_ops.verify_unmounted = op_verify_unmounted;
    boot_ops.prepare_conversation_dirs = op_prepare_conversation_dirs; boot_ops.read_runtime_artifacts = op_read_runtime_artifacts; boot_ops.read_base_config = op_read_base_config; boot_ops.read_boot_id = op_read_boot_id;
    boot_ops.start_supervisor = op_start_supervisor;
#ifdef WG_FILE_CHANNEL_V1
    boot_ops.read_data_device = op_read_data_device;
#endif
    boot_ops.stop_helper = op_stop_helper; boot_ops.stop_supervisor = op_stop_supervisor;
    boot_ops.kill_all = op_kill_all; boot_ops.sync_all = op_sync_all; boot_ops.flush_devices = op_flush_devices; boot_ops.power_off = op_power_off;
    wg_boot_init(&boot, &boot_ops);
    ctl_reader_init(&relay_reader, relay_payload, sizeof relay_payload, "PDFf");
    ctl_reader_init(&helper_reader, helper_payload, sizeof helper_payload, "BQMEC");

#ifdef WG_FILE_CHANNEL_V1
    G.relay = spawn_relay(port_fd, r2p, p2r, rt_in, rt_out, rt_err, file_in, file_out);
#else
    G.relay = spawn_relay(port_fd, r2p, p2r, rt_in, rt_out, rt_err);
#endif
    if (G.relay < 0) die_early("relay-spawn");
    close(port_fd);                    /* from here on exactly one process holds the port: the relay */
    G.helper = spawn_helper(h2p, p2h);
    if (G.helper < 0) die_early("helper-spawn");

    /* keep our ends, close the child's */
    G.r2p_r = r2p[0]; close(r2p[1]);
    G.p2r_w = p2r[1]; close(p2r[0]);
    G.h2p_r = h2p[0]; close(h2p[1]);
    G.p2h_w = p2h[1]; close(p2h[0]);
    G.rt_in_r = rt_in[0]; close(rt_in[1]);
    G.rt_out_w = rt_out[1]; close(rt_out[0]);
    G.rt_err_w = rt_err[1]; close(rt_err[0]);
#ifdef WG_FILE_CHANNEL_V1
    G.file_in_r = file_in[0]; close(file_in[1]);        /* the relay holds the write end of FILE_IN, the supervisor will hold the read end */
    G.file_out_w = file_out[1]; close(file_out[0]);     /* the relay holds the read end of FILE_OUT */
#endif
    fcntl(G.r2p_r, F_SETFL, fcntl(G.r2p_r, F_GETFL) | O_NONBLOCK);
    fcntl(G.h2p_r, F_SETFL, fcntl(G.h2p_r, F_GETFL) | O_NONBLOCK);
    fcntl(G.p2r_w, F_SETFL, fcntl(G.p2r_w, F_GETFL) | O_NONBLOCK);
    fcntl(G.p2h_w, F_SETFL, fcntl(G.p2h_w, F_GETFL) | O_NONBLOCK);
    log_code("children-started");

    for (;;) {
        struct pollfd fds[4];
        fds[0].fd = G.r2p_r; fds[0].events = POLLIN; fds[0].revents = 0;
        fds[1].fd = G.h2p_r; fds[1].events = POLLIN; fds[1].revents = 0;
        fds[2].fd = G.sup_out_r; fds[2].events = POLLIN; fds[2].revents = 0;
        fds[3].fd = signal_fd; fds[3].events = POLLIN; fds[3].revents = 0;
        int timeout = -1;
        if (supervisor_deadline) {
            long long left = supervisor_deadline - clock_ms();
            if (left <= 0) { supervisor_deadline = 0; wg_boot_supervisor_not_ready(&boot, "supervisor-ready-timeout"); continue; }
            timeout = (int)(left > 1000 ? 1000 : left);
        }
        if (poll(fds, 4, timeout) < 0) { if (errno == EINTR) continue; wg_boot_fail_stop(&boot, "poll"); }
        if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
            int result = pump(G.r2p_r, &relay_reader, dispatch_relay);
            if (result != 0) { wg_boot_fail_stop(&boot, result < 0 ? "relay-channel-garbage" : "relay-channel-closed"); }
        }
        if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) pump_helper();
        if (fds[2].revents & (POLLIN | POLLHUP | POLLERR)) pump_supervisor_ready();
        if (fds[3].revents & POLLIN) {
            struct signalfd_siginfo info;
            while (read(signal_fd, &info, sizeof info) == (ssize_t)sizeof info) { /* drained; the reaping below is the work */ }
            reap_children(1);
        }
    }
}
