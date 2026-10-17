/* Intake: the sandbox hook runs before the first read, SCOPE and VOLUMES are judged, the descriptors are checked against their
 * identity records and locked. Real temporary files, in-process socketpairs, a FAKE sandbox hook. No VM, no sandbox, no HVF. */
#include "AdmittedVolumes.h"
#include "test_support.h"

#include <errno.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>

static char directory[1024];

static void make_directory(void) {
    const char *base = getenv("TMPDIR");
    snprintf(directory, sizeof directory, "%s/cw-intake-XXXXXX", base != NULL && base[0] != 0 ? base : "/tmp");
    if (mkdtemp(directory) == NULL) { perror("mkdtemp"); exit(1); }
}

typedef struct { char path[1200]; int fd; cw_volume_identity identity; } volume;

static void make_volume(volume *v, const char *name, uint64_t size) {
    snprintf(v->path, sizeof v->path, "%s/%s", directory, name);
    v->fd = open(v->path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    CHECK(v->fd >= 3);
    CHECK(ftruncate(v->fd, (off_t)size) == 0); /* sparse */
    struct stat info;
    CHECK(fstat(v->fd, &info) == 0);
    v->identity = (cw_volume_identity){ cw_device_u64(info.st_dev), (uint64_t)info.st_ino, size, (uint32_t)info.st_uid, 0600 };
}
static void drop_volume(volume *v) { if (v->fd >= 0) close(v->fd); unlink(v->path); v->fd = -1; }

/* ---- the fake sandbox hook ---------------------------------------------------------------------------------------------- */
typedef struct { int channel; int result; int calls; int unread_at_hook; } hook;
static int fake_sandbox(void *opaque) {
    hook *h = opaque;
    h->calls++;
    int unread = 0;
    socklen_t size = sizeof unread;
    /* SO_NREAD does not touch rights: how many bytes are still queued and unread when the "sandbox" is installed. */
    if (getsockopt(h->channel, SOL_SOCKET, SO_NREAD, &unread, &size) != 0) unread = -1;
    h->unread_at_hook = unread;
    return h->result;
}
static int queued(int channel) {
    int unread = 0;
    socklen_t size = sizeof unread;
    return getsockopt(channel, SOL_SOCKET, SO_NREAD, &unread, &size) == 0 ? unread : -1;
}

/* ---- envelope builders -------------------------------------------------------------------------------------------------- */
static cw_scope make_scope(uint32_t memory) {
    cw_scope s;
    memset(&s, 0, sizeof s);
    snprintf(s.workspace_id, sizeof s.workspace_id, "workspace_a");
    snprintf(s.incarnation_id, sizeof s.incarnation_id, "inc-b");
    snprintf(s.controller_instance_id, sizeof s.controller_instance_id, "ctl-c");
    snprintf(s.worker_instance_id, sizeof s.worker_instance_id, "wrk-d");
    snprintf(s.admission_id, sizeof s.admission_id, "adm-e");
    memset(s.runtime_image_digest, 0xab, 32);
    s.lease_epoch = 3;
    s.vcpus = 2;
    s.memory_mib = memory;
    return s;
}
static size_t scope_bytes(uint8_t *out, uint32_t seq, uint32_t memory) {
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_SCOPE;
    e.seq = seq;
    e.u.scope = make_scope(memory);
    return cw_env_encode(&e, out, CW_ENV_MAX_BYTES);
}
static void scope_digest(uint32_t memory, uint8_t digest[32]) {
    uint8_t bytes[CW_ENV_MAX_BYTES];
    CHECK(scope_bytes(bytes, 1, memory) == CW_ENV_HEADER + CW_ENV_SCOPE_BYTES);
    cw_scope_payload_digest(bytes + CW_ENV_HEADER, digest);
}
static size_t volumes_bytes(uint8_t *out, uint32_t seq, const uint8_t digest[32], const cw_volume_identity *data, const cw_volume_identity *environment) {
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_VOLUMES;
    e.seq = seq;
    memcpy(e.u.volumes.scope_digest, digest, 32);
    e.u.volumes.data = *data;
    e.u.volumes.environment = *environment;
    return cw_env_encode(&e, out, CW_ENV_MAX_BYTES);
}
static size_t drain_bytes(uint8_t *out, uint32_t seq) {
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_DRAIN;
    e.seq = seq;
    memset(e.u.drain.stop_nonce, 0x0f, 16);
    e.u.drain.budget_ms = 30000;
    e.u.drain.origin = CW_ORIGIN_HOST_STOP;
    return cw_env_encode(&e, out, CW_ENV_MAX_BYTES);
}

static void send_datagram(int channel, const uint8_t *bytes, size_t length, const int *fds, int count) {
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(8 * sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { .iov_base = (void *)(uintptr_t)bytes, .iov_len = length };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    if (count > 0) {
        message.msg_control = rights.bytes;
        message.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN((size_t)count * sizeof(int));
        memcpy(CMSG_DATA(header), fds, (size_t)count * sizeof(int));
    }
    CHECK(sendmsg(channel, &message, 0) == (ssize_t)length);
}

static cw_intake_config config_for(hook *h) {
    cw_intake_config c = { fake_sandbox, h, 500, 500, geteuid(), { 2, 768, 1024 } };
    return c;
}

typedef struct { int pair[2]; hook h; volume data, environment; } rig;
static void rig_open(rig *r, const char *tag) {
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, r->pair) == 0);
    r->h = (hook){ r->pair[1], 0, 0, -2 };
    char name[64];
    snprintf(name, sizeof name, "%s-data", tag);
    make_volume(&r->data, name, 16ull << 20);
    snprintf(name, sizeof name, "%s-env", tag);
    make_volume(&r->environment, name, 32ull << 20);
}
static void rig_close(rig *r) {
    close(r->pair[0]);
    close(r->pair[1]);
    drop_volume(&r->data);
    drop_volume(&r->environment);
}
static void send_scope_and_volumes(rig *r, uint32_t memory) {
    uint8_t bytes[CW_ENV_MAX_BYTES], digest[32];
    scope_digest(memory, digest);
    size_t length = scope_bytes(bytes, 1, memory);
    send_datagram(r->pair[0], bytes, length, NULL, 0);
    length = volumes_bytes(bytes, 2, digest, &r->data.identity, &r->environment.identity);
    int fds[2] = { r->data.fd, r->environment.fd };
    send_datagram(r->pair[0], bytes, length, fds, 2);
}

/* ---- scenarios ---------------------------------------------------------------------------------------------------------- */

static void happy_path(void) {
    rig r;
    rig_open(&r, "happy");
    send_scope_and_volumes(&r, 768);
    int before = cw_test_open_descriptors();
    cw_intake_config config = config_for(&r.h);
    cw_intake_result result;
    CHECK(queued(r.pair[1]) > 0);
    cw_intake_run(&config, r.pair[1], &result);
    CHECK(r.h.calls == 1);
    CHECK(r.h.unread_at_hook == (int)(CW_ENV_HEADER + CW_ENV_SCOPE_BYTES)); /* ORDER: when the sandbox was installed, the SCOPE datagram (not the VOLUMES one behind it) was still the next thing queued */
    CHECK(result.outcome == CW_INTAKE_OK);
    CHECK(result.scope_accepted && result.volumes_accepted && result.next_seq == 3);
    CHECK(result.scope.memory_mib == 768 && result.scope.vcpus == 2 && result.scope.lease_epoch == 3);
    CHECK(result.fds[0] >= 3 && result.fds[1] >= 3 && result.fds[0] != result.fds[1]);
    CHECK(cw_test_open_descriptors() == before + 2);
    CHECK(fcntl(result.fds[0], F_GETFD) & FD_CLOEXEC);
    CHECK(fcntl(result.fds[1], F_GETFD) & FD_CLOEXEC);
    /* The lock is held: a second open file description of the same image cannot take it. */
    int other = open(r.data.path, O_RDWR | O_CLOEXEC);
    CHECK(other >= 3 && flock(other, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK);
    int other_environment = open(r.environment.path, O_RDWR | O_CLOEXEC);
    CHECK(other_environment >= 3 && flock(other_environment, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK);
    /* Closing a duplicate does not release it: flock belongs to the open file description, which every duplicate shares (the
     * worker closes its own copies after handing the descriptors to libkrun, and the lock must survive that). */
    int duplicate = dup(result.fds[0]);
    close(result.fds[0]);
    CHECK(flock(other, LOCK_EX | LOCK_NB) == -1);
    close(duplicate);
    CHECK(flock(other, LOCK_EX | LOCK_NB) == -1); /* the sender's copy still keeps the description alive */
    /* Only when the LAST descriptor of that description closes is the lock gone, and a gone lock is a gone lock and nothing more. */
    close(r.data.fd);
    r.data.fd = -1;
    CHECK(flock(other, LOCK_EX | LOCK_NB) == 0);
    close(other); close(other_environment); close(result.fds[1]);
    rig_close(&r);
}

static void sandbox_first(void) {
    rig r;
    rig_open(&r, "sandbox");
    send_scope_and_volumes(&r, 768);
    r.h.result = -1; /* the sandbox did not install */
    int before = cw_test_open_descriptors();
    cw_intake_config config = config_for(&r.h);
    cw_intake_result result;
    cw_intake_run(&config, r.pair[1], &result);
    CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_SANDBOX_FAILED && result.exit_code == CW_EXIT_SANDBOX);
    CHECK(r.h.calls == 1);
    CHECK(queued(r.pair[1]) == (int)(CW_ENV_HEADER + CW_ENV_SCOPE_BYTES)); /* nothing was read: the SCOPE datagram is still first in the queue ... */
    CHECK(cw_test_open_descriptors() == before);  /* ... and no descriptor was installed */
    CHECK(result.fds[0] == -1 && result.fds[1] == -1 && !result.scope_accepted);
    rig_close(&r);
}

static void gate_and_scope(void) {
    const struct { uint32_t memory; int ok; } cases[] = { { 255, 0 }, { 256, 0 }, { 512, 0 }, { 767, 0 }, { 768, 1 }, { 900, 1 }, { 1024, 1 }, { 1025, 0 } };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        rig r;
        rig_open(&r, "gate");
        if (cases[i].memory >= 256 && cases[i].memory <= 1024) send_scope_and_volumes(&r, cases[i].memory);
        else { /* the S1 parser refuses these itself: patch the byte range in by hand */
            uint8_t bytes[CW_ENV_MAX_BYTES];
            size_t length = scope_bytes(bytes, 1, 768);
            bytes[CW_ENV_HEADER + 364] = (uint8_t)cases[i].memory; bytes[CW_ENV_HEADER + 365] = (uint8_t)(cases[i].memory >> 8);
            send_datagram(r.pair[0], bytes, length, NULL, 0);
        }
        cw_intake_config config = config_for(&r.h);
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        if (cases[i].ok) {
            CHECK(result.outcome == CW_INTAKE_OK);
            if (result.outcome == CW_INTAKE_OK) { close(result.fds[0]); close(result.fds[1]); }
        } else {
            CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_SCOPE && result.exit_code == CW_EXIT_BAD_SCOPE);
            CHECK(!result.scope_accepted);
        }
        rig_close(&r);
    }
}

static void gate_is_independent_of_the_parser(void) {
    /* The S1 parser caps memory at 1024 MiB and fixes 2 vCPUs. The gate is a separate, later check against the library's limits: prove
     * it refuses on its own by handing it a narrower gate than the parser. */
    const struct { cw_gate gate; const char *what; int ok; } cases[] = {
        { { 2, 768, 900 }, "ceiling below the scope", 0 }, { { 2, 768, 1024 }, "the production gate", 1 }, { { 4, 768, 1024 }, "vCPU count", 0 }, { { 2, 800, 1024 }, "floor above the scope", 0 } };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        rig r;
        rig_open(&r, "gate2");
        send_scope_and_volumes(&r, 768 + (cases[i].gate.max_memory_mib == 900 ? 232 : 0)); /* 1000 MiB against the 900 ceiling, else 768 */
        cw_intake_config config = config_for(&r.h);
        config.gate = cases[i].gate;
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        if (cases[i].ok) {
            CHECK(result.outcome == CW_INTAKE_OK);
            if (result.outcome == CW_INTAKE_OK) { close(result.fds[0]); close(result.fds[1]); }
        } else {
            CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_SCOPE);
            CHECK_STR(result.reason, "outside the production gate");
        }
        rig_close(&r);
    }
}

static void scope_refusals(void) {
    uint8_t bytes[CW_ENV_MAX_BYTES];
    size_t length;
    struct { const char *name; int mode; const char *reason; } modes[] = { { "seq2", 0, "scope sequence" }, { "truncated", 1, "scope envelope refused" }, { "magic", 2, "scope envelope refused" },
        { "volumes-first", 3, "descriptor with the scope" }, { "status-first", 4, "scope envelope refused" } };
    for (size_t i = 0; i < sizeof modes / sizeof modes[0]; i++) {
        rig r;
        rig_open(&r, modes[i].name);
        length = scope_bytes(bytes, 1, 768);
        if (modes[i].mode == 0) length = scope_bytes(bytes, 2, 768);
        if (modes[i].mode == 1) length = 100;
        if (modes[i].mode == 2) bytes[0] = 'X';
        if (modes[i].mode == 3) { uint8_t digest[32]; scope_digest(768, digest); length = volumes_bytes(bytes, 1, digest, &r.data.identity, &r.environment.identity); }
        if (modes[i].mode == 4) { cw_envelope e; memset(&e, 0, sizeof e); e.kind = CW_ENV_STATUS; e.seq = 1; e.u.status.state = CW_STATUS_SANDBOXED; length = cw_env_encode(&e, bytes, sizeof bytes); }
        int fds[2] = { r.data.fd, r.environment.fd };
        send_datagram(r.pair[0], bytes, length, modes[i].mode == 3 ? fds : NULL, modes[i].mode == 3 ? 2 : 0);
        cw_intake_config config = config_for(&r.h);
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        if (modes[i].mode == 3) CHECK(result.outcome == CW_INTAKE_SILENT_EXIT); /* descriptors with a non-SCOPE first datagram: unexpected, silent */
        else CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_SCOPE);
        CHECK_STR(result.reason, modes[i].reason); /* which guard refused it, not just that something did */
        rig_close(&r);
    }
}

static void unexpected_descriptors(void) {
    /* A descriptor with the SCOPE: closed, silent, exit 79. */
    {
        rig r;
        rig_open(&r, "scope-fd");
        uint8_t bytes[CW_ENV_MAX_BYTES];
        size_t length = scope_bytes(bytes, 1, 768);
        int fds[1] = { r.data.fd };
        send_datagram(r.pair[0], bytes, length, fds, 1);
        int before = cw_test_open_descriptors();
        cw_intake_config config = config_for(&r.h);
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        CHECK(result.outcome == CW_INTAKE_SILENT_EXIT && result.exit_code == CW_EXIT_RIGHTS);
        CHECK(cw_test_open_descriptors() == before);
        rig_close(&r);
    }
    /* VOLUMES with 1, 3 descriptors: closed, silent. With none: a bad_volumes fault, nothing unexpected arrived. */
    const int counts[] = { 1, 3, 0 };
    for (size_t i = 0; i < 3; i++) {
        rig r;
        rig_open(&r, "volumes-count");
        uint8_t bytes[CW_ENV_MAX_BYTES], digest[32];
        scope_digest(768, digest);
        size_t length = scope_bytes(bytes, 1, 768);
        send_datagram(r.pair[0], bytes, length, NULL, 0);
        length = volumes_bytes(bytes, 2, digest, &r.data.identity, &r.environment.identity);
        int fds[3] = { r.data.fd, r.environment.fd, r.data.fd };
        send_datagram(r.pair[0], bytes, length, fds, counts[i]);
        int before = cw_test_open_descriptors();
        cw_intake_config config = config_for(&r.h);
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        if (counts[i] == 0) CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_VOLUMES);
        else CHECK(result.outcome == CW_INTAKE_SILENT_EXIT && result.exit_code == CW_EXIT_RIGHTS);
        CHECK(cw_test_open_descriptors() == before);
        CHECK(result.fds[0] == -1 && result.fds[1] == -1);
        rig_close(&r);
    }
}

static void volumes_refusals(void) {
    enum { DIGEST, INODE, DEVICE, SIZE, MODE, OWNER, READ_ONLY, APPEND, HARD_LINK, SEQ3, NOT_REGULAR, LOCKED, SAME_FILE, SCOPE_AGAIN, COUNT };
    for (int mode = 0; mode < COUNT; mode++) {
        rig r;
        rig_open(&r, "refuse");
        uint8_t bytes[CW_ENV_MAX_BYTES], digest[32];
        scope_digest(768, digest);
        size_t length = scope_bytes(bytes, 1, 768);
        send_datagram(r.pair[0], bytes, length, NULL, 0);
        cw_volume_identity data = r.data.identity, environment = r.environment.identity;
        int fds[2] = { r.data.fd, r.environment.fd };
        int extra = -1;
        char link_path[1300] = "";
        uid_t effective = geteuid();
        uint32_t seq = 2;
        switch (mode) {
        case DIGEST: digest[0] ^= 1; break;
        case INODE: data.inode += 1000003; break;
        case DEVICE: environment.device ^= 1; break;
        case SIZE: CHECK(ftruncate(r.environment.fd, (off_t)(48ull << 20)) == 0); break;
        case MODE: CHECK(fchmod(r.data.fd, 0644) == 0); break;
        case OWNER: effective = geteuid() + 1; break;
        case READ_ONLY: extra = open(r.data.path, O_RDONLY | O_CLOEXEC); fds[0] = extra; break;
        case APPEND: extra = open(r.data.path, O_RDWR | O_APPEND | O_CLOEXEC); fds[0] = extra; break;
        case HARD_LINK: snprintf(link_path, sizeof link_path, "%s.link", r.data.path); CHECK(link(r.data.path, link_path) == 0); break;
        case SEQ3: seq = 3; break;
        case NOT_REGULAR: extra = open("/dev/null", O_RDWR | O_CLOEXEC); fds[0] = extra; break;
        case LOCKED: extra = open(r.environment.path, O_RDWR | O_CLOEXEC); CHECK(flock(extra, LOCK_EX | LOCK_NB) == 0); break;
        case SAME_FILE: environment = data; fds[1] = r.data.fd; break;
        case SCOPE_AGAIN: break;
        }
        if (mode == SCOPE_AGAIN) length = scope_bytes(bytes, 2, 768);
        else length = volumes_bytes(bytes, seq, digest, &data, &environment);
        CHECK(length > 0 || mode == SAME_FILE);
        if (mode == SAME_FILE) { /* the encoder refuses this pair: forge the datagram by copying the data record over the environment record */
            length = volumes_bytes(bytes, 2, digest, &r.data.identity, &r.environment.identity);
            memcpy(bytes + CW_ENV_HEADER + 72, bytes + CW_ENV_HEADER + 40, 32);
        }
        send_datagram(r.pair[0], bytes, length, mode == SCOPE_AGAIN ? NULL : fds, mode == SCOPE_AGAIN ? 0 : 2);
        int before = cw_test_open_descriptors();
        cw_intake_config config = config_for(&r.h);
        config.effective_uid = effective;
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        CHECK(result.outcome == CW_INTAKE_FAULT);
        CHECK(result.fault == CW_FAULT_BAD_VOLUMES && result.exit_code == CW_EXIT_BAD_VOLUMES);
        if (result.outcome != CW_INTAKE_FAULT || result.fault != CW_FAULT_BAD_VOLUMES) fprintf(stderr, "volumes refusal mode %d: outcome %d fault %u reason %s\n", mode, result.outcome, result.fault, result.reason);
        CHECK(result.scope_accepted && !result.volumes_accepted);
        CHECK(result.fds[0] == -1 && result.fds[1] == -1);
        CHECK(cw_test_open_descriptors() == before); /* every descriptor that arrived was closed */
        if (mode == LOCKED) { /* the first descriptor's lock was dropped with the pair (once the sender's copy is closed too) */
            close(r.data.fd);
            r.data.fd = -1;
            int probe = open(r.data.path, O_RDWR | O_CLOEXEC);
            CHECK(flock(probe, LOCK_EX | LOCK_NB) == 0);
            close(probe);
        }
        if (extra >= 0) close(extra);
        if (link_path[0] != 0) unlink(link_path);
        rig_close(&r);
    }
}

static void drain_before_vm(void) {
    for (int stage = 1; stage <= 2; stage++) {
        rig r;
        rig_open(&r, "drain");
        uint8_t bytes[CW_ENV_MAX_BYTES];
        size_t length;
        if (stage == 2) { length = scope_bytes(bytes, 1, 768); send_datagram(r.pair[0], bytes, length, NULL, 0); }
        length = drain_bytes(bytes, (uint32_t)stage);
        send_datagram(r.pair[0], bytes, length, NULL, 0);
        int before = cw_test_open_descriptors();
        cw_intake_config config = config_for(&r.h);
        cw_intake_result result;
        cw_intake_run(&config, r.pair[1], &result);
        CHECK(result.outcome == CW_INTAKE_STOP_BEFORE_VM);
        CHECK(result.drain.origin == CW_ORIGIN_HOST_STOP && result.drain.budget_ms == 30000 && result.drain.stop_nonce[0] == 0x0f);
        CHECK(result.fds[0] == -1 && result.fds[1] == -1 && cw_test_open_descriptors() == before);
        CHECK(result.scope_accepted == (stage == 2) && !result.volumes_accepted);
        rig_close(&r);
    }
}

static void waiting_and_gone(void) {
    rig r;
    rig_open(&r, "wait");
    cw_intake_config config = config_for(&r.h);
    config.scope_wait_ms = 30;
    cw_intake_result result;
    cw_intake_run(&config, r.pair[1], &result);
    CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_SCOPE && result.exit_code == CW_EXIT_INTAKE_TIMEOUT);
    /* SCOPE arrives, VOLUMES never does. */
    uint8_t bytes[CW_ENV_MAX_BYTES];
    size_t length = scope_bytes(bytes, 1, 768);
    send_datagram(r.pair[0], bytes, length, NULL, 0);
    config.volumes_wait_ms = 30;
    cw_intake_run(&config, r.pair[1], &result);
    CHECK(result.outcome == CW_INTAKE_FAULT && result.fault == CW_FAULT_BAD_VOLUMES && result.exit_code == CW_EXIT_INTAKE_TIMEOUT && result.scope_accepted);
    /* The launcher closes L2: nothing was started, nothing to drain. */
    close(r.pair[0]);
    r.pair[0] = open("/dev/null", O_RDONLY); /* keep rig_close happy */
    cw_intake_run(&config, r.pair[1], &result);
    CHECK(result.outcome == CW_INTAKE_OWNER_GONE && result.exit_code == CW_EXIT_OK);
    rig_close(&r);
}

static void volume_admit_unit(void) {
    volume v;
    make_volume(&v, "unit", 16ull << 20);
    uid_t me = geteuid();
    CHECK(cw_volume_admit(v.fd, &v.identity, me) == CW_VOL_OK);
    /* dev_t is a signed 32 bit number; the daemon and libkrun both sign-extend it, so the worker must too. */
    CHECK(cw_device_u64((dev_t)-1) == 0xffffffffffffffffull && cw_device_u64((dev_t)0x01000012) == 0x01000012ull && cw_device_u64((dev_t)INT32_MIN) == 0xffffffff80000000ull);
    cw_volume_identity wrong = v.identity;
    wrong.capacity_bytes += 4096;
    CHECK(cw_volume_admit(v.fd, &wrong, me) == CW_VOL_SIZE);
    wrong = v.identity; wrong.inode += 1;
    CHECK(cw_volume_admit(v.fd, &wrong, me) == CW_VOL_IDENTITY);
    wrong = v.identity; wrong.device += 1;
    CHECK(cw_volume_admit(v.fd, &wrong, me) == CW_VOL_IDENTITY);
    wrong = v.identity; wrong.mode = 0644;
    CHECK(cw_volume_admit(v.fd, &wrong, me) == CW_VOL_MODE);
    wrong = v.identity; wrong.uid += 1;
    CHECK(cw_volume_admit(v.fd, &wrong, me) == CW_VOL_OWNER);
    CHECK(cw_volume_admit(v.fd, &v.identity, me + 1) == CW_VOL_OWNER);
    CHECK(cw_volume_admit(-1, &v.identity, me) == CW_VOL_FSTAT);
    int read_only = open(v.path, O_RDONLY | O_CLOEXEC);
    CHECK(cw_volume_admit(read_only, &v.identity, me) == CW_VOL_ACCESS);
    close(read_only);
    int append = open(v.path, O_RDWR | O_APPEND | O_CLOEXEC);
    CHECK(cw_volume_admit(append, &v.identity, me) == CW_VOL_APPEND);
    close(append);
    int null = open("/dev/null", O_RDWR | O_CLOEXEC);
    CHECK(cw_volume_admit(null, &v.identity, me) == CW_VOL_NOT_REGULAR);
    close(null);
    CHECK(fchmod(v.fd, 04600) == 0); /* an extra mode bit is a different mode: the compare is on all of 07777 */
    CHECK(cw_volume_admit(v.fd, &v.identity, me) == CW_VOL_MODE);
    CHECK(fchmod(v.fd, 0600) == 0);
    int other = open(v.path, O_RDWR | O_CLOEXEC);
    CHECK(cw_volume_lock(v.fd) == CW_VOL_OK);
    CHECK(cw_volume_lock(other) == CW_VOL_LOCK);
    close(other);
    CHECK(cw_volume_final_flush(v.fd) == 0);
    drop_volume(&v);
}

static int stray_child(void) {
    cw_test_failures = 0; /* the child counts its own checks; the parent's are inherited at fork */
    int keep_a = open("/dev/null", O_RDONLY), keep_b = open("/dev/null", O_RDONLY);
    int strays[3] = { open("/dev/null", O_RDONLY), open("/dev/null", O_RDONLY), open("/dev/null", O_RDONLY) };
    CHECK(keep_a >= 3 && keep_b >= 3);
    close(STDIN_FILENO); /* a closed standard slot must be refilled, or a received descriptor could land in it */
    cw_close_stray_fds(keep_a, keep_b);
    CHECK(fcntl(keep_a, F_GETFD) >= 0 && fcntl(keep_b, F_GETFD) >= 0);
    for (int i = 0; i < 3; i++) CHECK(fcntl(strays[i], F_GETFD) < 0);
    CHECK(fcntl(0, F_GETFD) >= 0 && fcntl(1, F_GETFD) >= 0 && fcntl(2, F_GETFD) >= 0);
    int extra = open("/dev/null", O_RDONLY);
    CHECK(extra >= 3);
    return cw_test_failures != 0 ? 1 : 0;
}

int main(void) {
    make_directory();
    happy_path();
    sandbox_first();
    gate_and_scope();
    gate_is_independent_of_the_parser();
    scope_refusals();
    unexpected_descriptors();
    volumes_refusals();
    drain_before_vm();
    waiting_and_gone();
    volume_admit_unit();
    fflush(NULL);
    pid_t child = fork();
    if (child == 0) _exit(stray_child());
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    rmdir(directory);
    return cw_test_finish("test_intake");
}
