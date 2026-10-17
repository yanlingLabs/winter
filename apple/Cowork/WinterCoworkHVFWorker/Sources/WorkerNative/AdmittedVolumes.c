#include "AdmittedVolumes.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

/* ---- descriptors --------------------------------------------------------------------------------------------------------- */

static int unnamed(const struct sockaddr_un *address, socklen_t length) {
    if (length > sizeof *address || address->sun_family != AF_UNIX) return 0;
    for (size_t i = offsetof(struct sockaddr_un, sun_path); i < length; i++) if (((const unsigned char *)address)[i] != 0) return 0;
    return 1;
}

int cw_channel_admit(int fd, int socket_type) {
    int kind = 0, flags = fcntl(fd, F_GETFD);
    socklen_t size = sizeof kind;
    struct sockaddr_un local, peer;
    memset(&local, 0, sizeof local);
    memset(&peer, 0, sizeof peer);
    socklen_t local_length = sizeof local, peer_length = sizeof peer;
    if (fd < 3 || flags < 0 || !(flags & FD_CLOEXEC) || getsockopt(fd, SOL_SOCKET, SO_TYPE, &kind, &size) != 0 || kind != socket_type
        || getsockname(fd, (struct sockaddr *)&local, &local_length) != 0 || getpeername(fd, (struct sockaddr *)&peer, &peer_length) != 0
        || !unnamed(&local, local_length) || !unnamed(&peer, peer_length)) {
        errno = EINVAL;
        return -1;
    }
    return 0;
}

void cw_close_stray_fds(int keep_a, int keep_b) {
    int limit = getdtablesize();
    if (limit > 65536) limit = 65536;
    for (int fd = 3; fd < limit; fd++) if (fd != keep_a && fd != keep_b) (void)close(fd);
    for (int fd = 0; fd <= 2; fd++) {
        if (fcntl(fd, F_GETFD) >= 0) continue;
        int null = open("/dev/null", fd == 0 ? O_RDONLY : O_WRONLY);
        if (null >= 0 && null != fd) { (void)dup2(null, fd); (void)close(null); }
    }
}

/* ---- one volume ---------------------------------------------------------------------------------------------------------- */

const char *cw_volume_result_name(int result) {
    switch (result) {
    case CW_VOL_OK: return "ok";
    case CW_VOL_FSTAT: return "fstat";
    case CW_VOL_NOT_REGULAR: return "not_regular";
    case CW_VOL_NLINK: return "nlink";
    case CW_VOL_OWNER: return "owner";
    case CW_VOL_MODE: return "mode";
    case CW_VOL_ACCESS: return "access";
    case CW_VOL_APPEND: return "append";
    case CW_VOL_IDENTITY: return "identity";
    case CW_VOL_SIZE: return "size";
    case CW_VOL_LOCK: return "lock";
    default: return "unknown";
    }
}

uint64_t cw_device_u64(dev_t device) { return (uint64_t)(int64_t)device; }

int cw_volume_admit(int fd, const cw_volume_identity *identity, uid_t effective_uid) {
    int status = fcntl(fd, F_GETFL);
    if (status < 0) return CW_VOL_FSTAT;
    if ((status & O_ACCMODE) != O_RDWR) return CW_VOL_ACCESS;
    if (status & O_APPEND) return CW_VOL_APPEND;
    struct stat info;
    if (fstat(fd, &info) != 0) return CW_VOL_FSTAT;
    if (!S_ISREG(info.st_mode)) return CW_VOL_NOT_REGULAR;
    if (info.st_nlink != 1) return CW_VOL_NLINK;
    if (info.st_uid != effective_uid || (uint64_t)info.st_uid != (uint64_t)identity->uid) return CW_VOL_OWNER;
    if ((uint32_t)(info.st_mode & 07777) != identity->mode) return CW_VOL_MODE;
    if (cw_device_u64(info.st_dev) != identity->device || (uint64_t)info.st_ino != identity->inode) return CW_VOL_IDENTITY;
    if (info.st_size < 0 || (uint64_t)info.st_size != identity->capacity_bytes) return CW_VOL_SIZE;
    return CW_VOL_OK;
}

int cw_volume_lock(int fd) { return flock(fd, LOCK_EX | LOCK_NB) == 0 ? CW_VOL_OK : CW_VOL_LOCK; }

int cw_volume_final_flush(int fd) {
    if (fcntl(fd, F_FULLFSYNC) == 0) return 0;
    return fsync(fd);
}

/* ---- intake -------------------------------------------------------------------------------------------------------------- */

static void fail(cw_intake_result *r, uint32_t fault, int exit_code, const char *reason) {
    r->outcome = CW_INTAKE_FAULT;
    r->fault = fault;
    r->exit_code = exit_code;
    r->reason = reason;
}
static void silent(cw_intake_result *r, const char *reason) {
    r->outcome = CW_INTAKE_SILENT_EXIT;
    r->exit_code = CW_EXIT_RIGHTS;
    r->reason = reason;
}
static void close_pair(int fds[2]) {
    for (int i = 0; i < 2; i++) if (fds[i] >= 0) { close(fds[i]); fds[i] = -1; }
}

/* One datagram, or the reason there will be none. Returns 1 when `in` holds a datagram, 0 when the result was filled. */
static int next_datagram(int channel, int wait_ms, uint32_t timeout_fault, int timeout_exit, cw_inbound *in, cw_intake_result *r) {
    for (;;) {
        int rc = cw_env_recv(channel, in, wait_ms);
        if (rc == CW_RECV_OK) return 1;
        if (rc == CW_RECV_AGAIN) continue;
        if (rc == CW_RECV_CTRUNC) silent(r, "truncated control buffer");
        else if (rc == CW_RECV_GONE) { r->outcome = CW_INTAKE_OWNER_GONE; r->exit_code = CW_EXIT_OK; r->reason = "launcher closed L2"; }
        else if (rc == CW_RECV_TIMEOUT) fail(r, timeout_fault, timeout_exit, "intake timed out");
        else fail(r, timeout_fault, timeout_fault == CW_FAULT_BAD_SCOPE ? CW_EXIT_BAD_SCOPE : CW_EXIT_BAD_VOLUMES, "unreadable datagram");
        return 0;
    }
}

void cw_intake_run(const cw_intake_config *config, int channel, cw_intake_result *r) {
    memset(r, 0, sizeof *r);
    r->fds[0] = r->fds[1] = -1;
    r->exit_code = CW_EXIT_OK;
    /* 1. The sandbox, BEFORE the first read. Nothing below runs if it did not install. */
    if (config->install_sandbox(config->context) != 0) { fail(r, CW_FAULT_SANDBOX_FAILED, CW_EXIT_SANDBOX, "sandbox did not install"); return; }

    cw_inbound in;
    cw_envelope envelope;

    /* 2. SCOPE (sequence 1, no descriptors). */
    if (!next_datagram(channel, config->scope_wait_ms, CW_FAULT_BAD_SCOPE, CW_EXIT_INTAKE_TIMEOUT, &in, r)) return;
    if (in.fd_count != 0) { cw_inbound_close_fds(&in); silent(r, "descriptor with the scope"); return; }
    int rc = cw_env_parse(in.bytes, in.length, 0, CW_ENV_TO_WORKER, &envelope);
    if (rc != CW_OK) { fail(r, CW_FAULT_BAD_SCOPE, CW_EXIT_BAD_SCOPE, "scope envelope refused"); return; }
    if (envelope.seq != 1) { fail(r, CW_FAULT_BAD_SCOPE, CW_EXIT_BAD_SCOPE, "scope sequence"); return; }
    if (envelope.kind == CW_ENV_DRAIN) { r->outcome = CW_INTAKE_STOP_BEFORE_VM; r->drain = envelope.u.drain; r->reason = "drain before scope"; return; }
    if (envelope.kind != CW_ENV_SCOPE) { fail(r, CW_FAULT_BAD_SCOPE, CW_EXIT_BAD_SCOPE, "scope expected"); return; }
    r->scope = envelope.u.scope;
    /* The S1 parser admits 256..1024 MiB; libkrun's production gate admits 768..1024. Refuse here, early and named. */
    if (r->scope.vcpus != config->gate.vcpus || r->scope.memory_mib < config->gate.min_memory_mib || r->scope.memory_mib > config->gate.max_memory_mib) {
        fail(r, CW_FAULT_BAD_SCOPE, CW_EXIT_BAD_SCOPE, "outside the production gate");
        return;
    }
    r->scope_accepted = true;

    /* 3. VOLUMES (sequence 2, exactly two descriptors). */
    if (!next_datagram(channel, config->volumes_wait_ms, CW_FAULT_BAD_VOLUMES, CW_EXIT_INTAKE_TIMEOUT, &in, r)) return;
    rc = cw_env_parse(in.bytes, in.length, in.fd_count, CW_ENV_TO_WORKER, &envelope);
    if (rc == CW_E_BAD_RIGHTS) {
        /* VOLUMES with no descriptor at all is a launcher mistake and nothing unexpected arrived: say so. Any other count, or a
         * descriptor on any other kind, is "an fd nobody asked for": close everything, acknowledge nothing, exit 79. */
        bool none_at_all = in.fd_count == 0 && in.length > 5 && in.bytes[5] == CW_ENV_VOLUMES;
        cw_inbound_close_fds(&in);
        if (none_at_all) fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "volumes without descriptors");
        else silent(r, "descriptor count");
        return;
    }
    if (rc != CW_OK) { cw_inbound_close_fds(&in); fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "volumes envelope refused"); return; }
    if (envelope.seq != 2) { cw_inbound_close_fds(&in); fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "volumes sequence"); return; }
    if (envelope.kind == CW_ENV_DRAIN) { r->outcome = CW_INTAKE_STOP_BEFORE_VM; r->drain = envelope.u.drain; r->reason = "drain before volumes"; return; }
    if (envelope.kind != CW_ENV_VOLUMES) { cw_inbound_close_fds(&in); fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "volumes expected"); return; }
    r->fds[0] = in.fds[0];
    r->fds[1] = in.fds[1];
    in.fd_count = 0;
    r->volumes = envelope.u.volumes;
    if (memcmp(r->volumes.scope_digest, r->scope.digest, 32) != 0) { close_pair(r->fds); fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "scope digest mismatch"); return; }
    const cw_volume_identity *identities[2] = { &r->volumes.data, &r->volumes.environment };
    for (int i = 0; i < 2; i++) {
        if (cw_volume_admit(r->fds[i], identities[i], config->effective_uid) != CW_VOL_OK) {
            close_pair(r->fds);
            fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "descriptor does not match its identity");
            return;
        }
    }
    /* 4. The advisory lock: an extra guard, never release evidence. Both or neither. */
    for (int i = 0; i < 2; i++) {
        if (cw_volume_lock(r->fds[i]) != CW_VOL_OK) {
            close_pair(r->fds); /* closing drops any lock taken on the first descriptor */
            fail(r, CW_FAULT_BAD_VOLUMES, CW_EXIT_BAD_VOLUMES, "advisory lock refused");
            return;
        }
    }
    r->volumes_accepted = true;
    r->next_seq = 3;
    r->outcome = CW_INTAKE_OK;
}
