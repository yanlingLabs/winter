#ifndef LAUNCHER_NATIVE_H
#define LAUNCHER_NATIVE_H
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>

/*
 * The native half of winter-cowork-launcher. Three jobs:
 *   1. Descriptor-safe socket I/O. A plain read()/recv() on an AF_UNIX socket silently INSTALLS any SCM_RIGHTS descriptors the
 *      peer attached (verified on macOS by the contract's author), so EVERY read of L1, L2 and L3 goes through lc_recvmsg: a
 *      control buffer, every descriptor it was not asked for closed, MSG_CTRUNC fatal.
 *   2. The suspended spawn of the worker with an exactly-described descriptor table.
 *   3. The sole-reaper owned child. There is no entry point here that takes a caller-supplied pid: a signal can only leave
 *      through lc_kill_owned, on a handle this process created and has not yet reaped.
 */

/* ---------------------------------------------------------------------------------------------- sockets */

enum {
    LC_MAX_RIGHTS = 17,            /* descriptors one recvmsg can hand back; the policy limit is applied by the caller */
    LC_E_RIGHTS_TRUNCATED = -1000, /* MSG_CTRUNC: the kernel may have installed descriptors nobody can see. FATAL for the channel. */
    LC_E_DATA_TRUNCATED = -1001,   /* MSG_TRUNC: the datagram did not fit. Every descriptor that arrived was closed. */
    LC_E_BAD_CONTROL = -1002,      /* anything but exactly one SCM_RIGHTS message of whole descriptors. Everything closed. */
};

typedef struct {
    int32_t rights[LC_MAX_RIGHTS];
    int32_t rights_count;
    int32_t flags;
} lc_recv_info;

/* AF_UNIX socketpair, both ends FD_CLOEXEC and SO_NOSIGPIPE. type is SOCK_STREAM or SOCK_DGRAM. 0 or -1 with errno. */
int lc_socketpair(int type, int fds[2]);
/* A copy of fd at a number >= minimum (FD_CLOEXEC), closing the original on success. Returns the new fd or -1. */
int lc_relocate(int fd, int minimum);
int lc_set_nonblocking(int fd);
int lc_set_cloexec(int fd);
int lc_has_cloexec(int fd);
/* 1 when fd is an unnamed AF_UNIX socket of the given type (getsockname and getpeername both carry no path), else 0. */
int lc_is_unnamed_unix_socket(int fd, int type);

/*
 * One recvmsg(MSG_DONTWAIT). Returns the byte count (0 = EOF on a stream, or an empty datagram), or a negative errno
 * (-EAGAIN means nothing ready), or one of LC_E_*. On ANY negative return every descriptor that arrived has already been
 * closed. On success info->rights[0..rights_count) are descriptors the caller now owns, each FD_CLOEXEC.
 */
ssize_t lc_recvmsg(int fd, void *buffer, size_t capacity, lc_recv_info *info);
/* One sendmsg(MSG_DONTWAIT) with `count` descriptors attached (0..LC_MAX_RIGHTS). Returns bytes sent or a negative errno.
 * The descriptors stay the caller's. */
ssize_t lc_sendmsg(int fd, const void *buffer, size_t length, const int *rights, int count);

/* The kernel's identity of the process that made the other end: 32 bytes of audit_token_t. 0, or -1 with errno. */
int lc_peer_token(int fd, uint8_t token[32]);
int lc_peer_pid(int fd, pid_t *pid);

/* ---------------------------------------------------------------------------------------------- the owned child */

typedef struct lc_owned_child lc_owned_child;
enum { LC_OWNED_RUNNING = 0, LC_CONFIRMED_EXIT = 1, LC_TERMINATION_UNCERTAIN = 2, LC_LOST_OWNERSHIP = 3 };
enum { LC_EXIT_NONE = 0, LC_EXIT_CODE = 1, LC_EXIT_SIGNAL = 2 };
typedef struct {
    int state;       /* LC_OWNED_RUNNING ... */
    int exit_kind;   /* LC_EXIT_* (only with LC_CONFIRMED_EXIT) */
    int status;      /* exit code, or the terminating signal number */
    int error;       /* errno when uncertain / lost */
    int timed_out;
    int kill_sent;
} lc_wait_result;

/*
 * Spawn `path` SUSPENDED (POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_CLOEXEC_DEFAULT) with exactly this descriptor table:
 * 0, 1 and 2 on /dev/null, `l2_child` as 3 (the datagram link) and `l3_child` as 4 (the stream link); every other
 * descriptor of this process is closed in the child. argv is [path]; the environment is LC_ALL=C and LANG=C. Refuses
 * (EPERM) unless this process is the sole reaper: SIGCHLD at its default disposition and not SA_NOCLDWAIT. The numbers of
 * `l2_child` and `l3_child` must be above 4 and different (lc_relocate). Returns 0 or an errno value.
 */
int lc_spawn_owned(const char *path, int l2_child, int l3_child, lc_owned_child **out);
pid_t lc_owned_pid(const lc_owned_child *child);
/* SIGCONT, after a fresh non-blocking proof that the child is still this process's unreaped child. */
lc_wait_result lc_resume_owned(lc_owned_child *child);
/* A non-blocking waitpid: reaps and records the exit if the child has ended. Never signals. */
lc_wait_result lc_probe_owned(lc_owned_child *child);
/*
 * The only way a signal leaves this process: a fresh probe under the ownership mutex, and only if that proves the child is
 * still ours and unreaped, SIGKILL, then at most reap_ms (<= 1000) of probing for the reap. An interrupted or failed probe
 * never authorises a signal.
 */
lc_wait_result lc_kill_owned(lc_owned_child *child, int reap_ms);
void lc_owned_destroy(lc_owned_child *child);
/* The start time of a live process as a label ("<sec>.<usec>"), for diagnostics. 0 or -1. */
int lc_process_start_token(pid_t pid, char *out, size_t capacity);

/* ---------------------------------------------------------------------------------------------- misc */

int64_t lc_monotonic_ms(void);
/* Fill `out` with `length` bytes from the system random source. 0 or -1. */
int lc_random(void *out, size_t length);
/* The host boot session uuid exactly as the kernel spells it (kern.bootsessionuuid). Length written, or -1. */
int lc_boot_session_uuid(char *out, size_t capacity);

/* Deterministic syscall doubles for the kill/reap algorithm (no real process, no real signal): the matrix runs in
 * `swift test` and returns 1 when the scenario behaves as specified. */
int lc_test_wait_scenario(int scenario);
#endif
