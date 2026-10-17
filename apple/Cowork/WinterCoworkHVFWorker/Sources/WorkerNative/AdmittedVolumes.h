/* AdmittedVolumes: everything the worker does between "I am running" and "the VM may be configured".
 *
 * ORDER IS THE POINT. The sandbox is installed first; only then does the worker read one byte from L2. It then accepts exactly
 * a SCOPE envelope and a VOLUMES envelope carrying exactly two descriptors, validates each against what the launcher told it,
 * and takes an advisory flock on both as an EXTRA guard. The lock is not release evidence: nothing in the contract treats a
 * lock, a closed descriptor, an exited process or an EOF as proof that a disk is free.
 *
 * Fail-closed intake kept from the admitted fixture (workspace_fd_handoff.h). THE RIGHTS POLICY, uniform and complete:
 *
 *   silent exit 79 (nothing acknowledged on L2, everything visible closed)    ANY descriptor that is not exactly the two the VOLUMES
 *       envelope was meant to carry: a truncated control buffer; a descriptor with SCOPE or DRAIN; VOLUMES with one, three or more, OR NONE;
 *       a datagram this receiver refused (malformed control message, too long) that nevertheless carried a descriptor.
 *   fault + exit 71/72     everything else that is wrong with a datagram: unreadable, malformed, wrong sequence, wrong kind, a bad value.
 *
 * The same rule applies after intake (Relay.c): a descriptor on L2, L3 or L4 is exit 79 / a violation, never an acknowledgement.
 */
#ifndef WINTER_COWORK_WORKER_ADMITTED_VOLUMES_H
#define WINTER_COWORK_WORKER_ADMITTED_VOLUMES_H

#include "Envelope.h"

#include <sys/types.h>

/* ---- descriptors --------------------------------------------------------------------------------------------------------- */

/* The inherited channel must be an unnamed AF_UNIX socket of `socket_type` with FD_CLOEXEC restored (the launcher clears it so
 * the descriptor survives exec; the worker restores it before any intake). Returns 0, or -1 with errno EINVAL. */
int cw_channel_admit(int fd, int socket_type);

/* Close every descriptor >= 3 that is not `keep_a` or `keep_b`, up to the process's real descriptor limit (getdtablesize() and
 * RLIMIT_NOFILE, whichever is larger; no fixed cap), and make sure 0, 1 and 2 are open (any closed one is pointed at /dev/null) so a
 * received descriptor can never land in a standard slot. */
void cw_close_stray_fds(int keep_a, int keep_b);

/* The worker's descriptor hygiene as one testable step: close everything else, restore FD_CLOEXEC on the two inherited ends (the
 * launcher clears it so they survive exec), and admit them as the unnamed L2 datagram socket and the unnamed L3 stream socket.
 * Returns 0, or -1 when they are not exactly that. */
int cw_prepare_descriptors(int l2, int l3);

/* ---- one volume ---------------------------------------------------------------------------------------------------------- */

enum {
    CW_VOL_OK = 0, CW_VOL_FSTAT, CW_VOL_NOT_REGULAR, CW_VOL_NLINK, CW_VOL_OWNER, CW_VOL_MODE, CW_VOL_ACCESS, CW_VOL_APPEND,
    CW_VOL_IDENTITY, CW_VOL_SIZE, CW_VOL_LOCK
};
const char *cw_volume_result_name(int result);

/* The record's `device` is st_dev read the way the daemon (libuv: `st_dev` assigned to a uint64) and libkrun's own identity check
 * (Rust: `st_dev as u64`) read it: dev_t is a signed 32 bit number on macOS and both SIGN-extend it. */
uint64_t cw_device_u64(dev_t device);

/* Validate a received descriptor against its identity record, the same list libkrun's own setter applies (so a refusal is a
 * `bad_volumes` fault at intake, not a `vm_failed` later): a regular file, one link, owned by the effective user and by the
 * record's uid, mode exactly 0600, opened O_RDWR and not O_APPEND, with the recorded device, inode and size. Returns CW_VOL_OK
 * or the first thing that failed. */
int cw_volume_admit(int fd, const cw_volume_identity *identity, uid_t effective_uid);

/* flock(LOCK_EX | LOCK_NB). flock, never fcntl locks: a POSIX lock is dropped by ANY close of the file in the process, and the
 * worker closes its copies after handing the descriptors to libkrun; a flock belongs to the open file description, which
 * libkrun's duplicates keep alive. Returns CW_VOL_OK or CW_VOL_LOCK (errno says why: EWOULDBLOCK is held, EPERM is the sandbox). */
int cw_volume_lock(int fd);

/* fsync both: the worker's final flush for a stop that arrives before the VM ever ran (nothing was written). */
int cw_volume_final_flush(int fd);

/* ---- intake -------------------------------------------------------------------------------------------------------------- */

typedef struct {
    uint32_t vcpus;
    uint32_t min_memory_mib;
    uint32_t max_memory_mib;
} cw_gate; /* the libkrun production gate: 2 vCPU, 768..1024 MiB; narrower than the S1 parser's 256..1024 */

enum { CW_SCOPE_OK = 0, CW_SCOPE_REFUSED = 1, CW_SCOPE_UNAVAILABLE = 2 };

typedef struct {
    int (*install_sandbox)(void *context); /* installs the sandbox and proves its denials; 0 on success */
    /* Judges an accepted SCOPE against what only the worker can see (the runtime image digest). CW_SCOPE_REFUSED is `bad_scope` / exit 71;
     * CW_SCOPE_UNAVAILABLE (the artifacts could not be read at all) is `internal` / exit 78. `reason` is fixed text. Never NULL. */
    int (*check_scope)(void *context, const cw_scope *scope, const char **reason);
    void *context;
    int scope_wait_ms;
    int volumes_wait_ms;
    uid_t effective_uid;
    cw_gate gate;
} cw_intake_config;

typedef enum {
    CW_INTAKE_OK = 0,
    CW_INTAKE_FAULT,          /* send `fault` (result.fault), then exit with result.exit_code */
    CW_INTAKE_SILENT_EXIT,    /* truncated or unexpected descriptor: exit 79 with nothing said */
    CW_INTAKE_STOP_BEFORE_VM, /* a DRAIN arrived before the VM existed: exit cleanly (result.drain) */
    CW_INTAKE_OWNER_GONE      /* L2 closed: nothing started, nothing to drain */
} cw_intake_outcome;

typedef struct {
    cw_intake_outcome outcome;
    uint32_t fault;
    int exit_code;
    const char *reason; /* fixed diagnostic text, never untrusted content */
    cw_scope scope;
    cw_volumes volumes;
    int fds[2];         /* data, environment: admitted, locked, CLOEXEC; -1 when not held */
    cw_drain drain;
    bool scope_accepted;
    bool volumes_accepted;
    uint32_t next_seq;  /* the next inbound envelope sequence the relay must expect */
} cw_intake_result;

/* Install the sandbox, then receive SCOPE (seq 1) and VOLUMES (seq 2). On anything but CW_INTAKE_OK no descriptor is held. */
void cw_intake_run(const cw_intake_config *config, int channel, cw_intake_result *result);

#endif
