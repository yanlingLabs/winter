/* L2 envelope codec: S1's golden vectors byte for byte, every boundary of every field, and the outbound sender.
 * No VM, no sandbox, no HVF. */
#include "Envelope.h"
#include "test_support.h"
#include "vectors.h"

#include <sys/socket.h>

static void unhex(const char *hex, uint8_t *out, size_t length) {
    for (size_t i = 0; i < length; i++) {
        unsigned value = 0;
        sscanf(hex + 2 * i, "%2x", &value);
        out[i] = (uint8_t)value;
    }
}

static const cw_env_vector *find(const char *name) {
    for (size_t i = 0; i < ENV_VECTOR_COUNT; i++) if (strcmp(env_vectors[i].name, name) == 0) return &env_vectors[i];
    return NULL;
}

static void put32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i)); }
static void put64(uint8_t *p, uint64_t v) { for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i)); }

/* Parse the named positive vector after changing one byte range. */
static int mutated(const char *vector, size_t offset, const uint8_t *bytes, size_t count, size_t rights, cw_env_direction direction) {
    const cw_env_vector *v = find(vector);
    uint8_t copy[CW_ENV_MAX_BYTES + 8];
    memcpy(copy, v->bytes, v->length);
    memcpy(copy + offset, bytes, count);
    cw_envelope e;
    return cw_env_parse(copy, v->length, rights, direction, &e);
}
static int mutated32(const char *vector, size_t offset, uint32_t value) {
    uint8_t b[4];
    put32(b, value);
    const cw_env_vector *v = find(vector);
    return mutated(vector, offset, b, 4, v->rights, (cw_env_direction)v->direction);
}
static int mutated64(const char *vector, size_t offset, uint64_t value) {
    uint8_t b[8];
    put64(b, value);
    const cw_env_vector *v = find(vector);
    return mutated(vector, offset, b, 8, v->rights, (cw_env_direction)v->direction);
}
#define H CW_ENV_HEADER

static void golden_vectors(void) {
    CHECK(ENV_VECTOR_COUNT == 58); /* 28 positive + 30 negative in the pinned file */
    for (size_t i = 0; i < ENV_VECTOR_COUNT; i++) {
        const cw_env_vector *v = &env_vectors[i];
        cw_envelope e;
        int rc = cw_env_parse(v->bytes, v->length, v->rights, (cw_env_direction)v->direction, &e);
        if (v->error == NULL) {
            CHECK(rc == CW_OK);
            CHECK((int)e.kind == v->kind);
            CHECK(e.seq == (unsigned)v->seq);
            uint8_t again[CW_ENV_MAX_BYTES];
            size_t length = cw_env_encode(&e, again, sizeof again);
            CHECK(length == v->length);
            CHECK(length == v->length && memcmp(again, v->bytes, v->length) == 0); /* byte for byte */
        } else {
            if (strcmp(cw_error_name(rc), v->error) != 0) fprintf(stderr, "vector %s: got %s want %s\n", v->name, cw_error_name(rc), v->error);
            CHECK_STR(cw_error_name(rc), v->error);
        }
    }
}

static void second_drain_vector(void) {
    const cw_env_vector *v = find("fault-second-drain");
    cw_envelope e;
    CHECK(v != NULL && cw_env_parse(v->bytes, v->length, 0, CW_ENV_TO_LAUNCHER, &e) == CW_OK);
    CHECK(e.kind == CW_ENV_FAULT && e.u.fault == CW_FAULT_SECOND_DRAIN && e.u.fault == 8);
}

static void scope_digest_and_values(void) {
    const cw_env_vector *scope = find("scope");
    cw_envelope e;
    CHECK(cw_env_parse(scope->bytes, scope->length, 0, CW_ENV_TO_WORKER, &e) == CW_OK);
    uint8_t expected[32];
    unhex(scope_digest_hex, expected, 32);
    CHECK(memcmp(e.u.scope.digest, expected, 32) == 0);
    uint8_t direct[32];
    cw_scope_payload_digest(scope->bytes + CW_ENV_HEADER, direct);
    CHECK(memcmp(direct, expected, 32) == 0);
    CHECK_STR(e.u.scope.workspace_id, "workspace_11111111-1111-4111-8111-111111111111");
    CHECK_STR(e.u.scope.incarnation_id, "inc-22222222-2222-4222-8222-222222222222");
    CHECK_STR(e.u.scope.admission_id, "adm-33333333-3333-4333-8333-333333333333");
    CHECK_STR(e.u.scope.worker_instance_id, "wrk-44444444-4444-4444-8444-444444444444");
    CHECK_STR(e.u.scope.controller_instance_id, "ctl-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b-a1b2c3d4");
    CHECK(e.u.scope.lease_epoch == 3 && e.u.scope.vcpus == 2 && e.u.scope.memory_mib == 768);
    CHECK(e.u.scope.runtime_image_digest[0] == 0xab && e.u.scope.runtime_image_digest[31] == 0xab);
    /* The VOLUMES vector names exactly this scope. */
    const cw_env_vector *volumes = find("volumes-two-descriptors");
    cw_envelope v;
    CHECK(cw_env_parse(volumes->bytes, volumes->length, 2, CW_ENV_TO_WORKER, &v) == CW_OK);
    CHECK(memcmp(v.u.volumes.scope_digest, expected, 32) == 0);
    CHECK(v.u.volumes.data.mode == 0600 && v.u.volumes.environment.mode == 0600);
    CHECK(v.u.volumes.data.capacity_bytes % 4096 == 0 && v.u.volumes.environment.capacity_bytes % 4096 == 0);
    /* The digest covers all 512 bytes: flip one reserved byte and it changes (and the scope is refused anyway). */
    uint8_t copy[CW_ENV_SCOPE_BYTES];
    memcpy(copy, scope->bytes + CW_ENV_HEADER, sizeof copy);
    copy[511] ^= 1;
    cw_scope_payload_digest(copy, direct);
    CHECK(memcmp(direct, expected, 32) != 0);
}

static void scope_boundaries(void) {
    const size_t p = H;
    /* The floor is 768 in the PARSER too (the contract's ruling, equal to the library gate's): 256 to 767 are no longer a valid SCOPE. */
    CHECK(mutated32("scope", p + 364, 255) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 364, 256) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 364, 512) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 364, 767) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 364, 768) == CW_OK);
    CHECK(mutated32("scope", p + 364, 1024) == CW_OK);
    CHECK(mutated32("scope", p + 364, 1025) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 360, 1) == CW_E_BAD_FIELD);
    CHECK(mutated32("scope", p + 360, 3) == CW_E_BAD_FIELD);
    CHECK(mutated64("scope", p + 352, 0) == CW_E_BAD_FIELD);
    CHECK(mutated64("scope", p + 352, 0xffffffffull) == CW_OK);
    CHECK(mutated64("scope", p + 352, 0x100000000ull) == CW_E_BAD_FIELD);
    uint8_t one = 1;
    CHECK(mutated("scope", p + 368, &one, 1, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("scope", p + 511, &one, 1, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    /* Name fields: 63 characters fit; 64 leave no NUL; empty, hyphen first, dot, space and bytes after the NUL are refused. */
    uint8_t sixty_three[64], sixty_four[64], hyphen[2] = { '-', 'a' }, dot[3] = { 'a', '.', 'b' }, space[3] = { 'a', ' ', 'b' }, after_nul[3] = { 0, 0, 'x' };
    memset(sixty_three, 'a', 63); sixty_three[63] = 0;
    memset(sixty_four, 'a', 64);
    CHECK(mutated("scope", p + 0, sixty_three, 64, 0, CW_ENV_TO_WORKER) == CW_OK);
    CHECK(mutated("scope", p + 0, sixty_four, 64, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("scope", p + 64, hyphen, 2, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("scope", p + 128, dot, 3, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("scope", p + 192, space, 3, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("scope", p + 256 + 40, after_nul, 3, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    uint8_t zero = 0;
    CHECK(mutated("scope", p + 0, &zero, 1, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD); /* empty workspace id */
    CHECK(mutated("scope", p + 256, &zero, 1, 0, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD); /* empty admission id */
    CHECK(cw_valid_token("a") && cw_valid_token("A_b-9") && !cw_valid_token("") && !cw_valid_token("_a") && !cw_valid_token("a b"));
    char long_token[80];
    memset(long_token, 'a', 63); long_token[63] = 0;
    CHECK(cw_valid_token(long_token));
    long_token[63] = 'a'; long_token[64] = 0;
    CHECK(!cw_valid_token(long_token));
}

static void volumes_boundaries(void) {
    const size_t p = H, data = p + 40, env = p + 72;
    const uint64_t mib16 = 16ull << 20, gib256 = 256ull << 30;
    CHECK(mutated64("volumes-two-descriptors", data + 16, mib16 - 4096) == CW_E_BAD_FIELD);
    CHECK(mutated64("volumes-two-descriptors", data + 16, mib16) == CW_OK);
    CHECK(mutated64("volumes-two-descriptors", env + 16, gib256) == CW_OK);
    CHECK(mutated64("volumes-two-descriptors", env + 16, gib256 + 4096) == CW_E_BAD_FIELD);
    CHECK(mutated64("volumes-two-descriptors", env + 16, mib16 + 1) == CW_E_BAD_FIELD);
    CHECK(mutated64("volumes-two-descriptors", env + 16, 0) == CW_E_BAD_FIELD);
    CHECK(mutated64("volumes-two-descriptors", env + 16, ((1ull << 53) - 1) & ~4095ull) == CW_E_BAD_FIELD); /* above 256 GiB */
    CHECK(mutated32("volumes-two-descriptors", data + 28, 0644) == CW_E_BAD_FIELD);
    CHECK(mutated32("volumes-two-descriptors", env + 28, 0600) == CW_OK);
    CHECK(mutated32("volumes-two-descriptors", data + 24, 0xffffffffu) == CW_OK); /* any uid; the worker compares it to the file */
    CHECK(mutated32("volumes-two-descriptors", p + 0, 2) == CW_E_BAD_FIELD);  /* record version */
    CHECK(mutated32("volumes-two-descriptors", p + 4, 1) == CW_E_BAD_FIELD);  /* reserved */
    /* One file may never back both disks: same device and inode refused; same inode on another device is two files. */
    const cw_env_vector *v = find("volumes-two-descriptors");
    uint8_t same[16];
    memcpy(same, v->bytes + data, 16);
    CHECK(mutated("volumes-two-descriptors", env, same, 16, 2, CW_ENV_TO_WORKER) == CW_E_BAD_FIELD);
    CHECK(mutated("volumes-two-descriptors", env, same + 0, 8, 2, CW_ENV_TO_WORKER) == CW_OK); /* same device, different inode */
}

static void other_payloads(void) {
    const size_t p = H;
    CHECK(mutated32("drain-host-stop", p + 16, 120000) == CW_OK);
    CHECK(mutated32("drain-host-stop", p + 16, 120001) == CW_E_BAD_FIELD);
    CHECK(mutated32("drain-host-stop", p + 16, 0) == CW_OK);
    CHECK(mutated32("drain-host-stop", p + 20, 0) == CW_E_BAD_FIELD);
    CHECK(mutated32("drain-host-stop", p + 20, 2) == CW_OK);
    CHECK(mutated32("drain-host-stop", p + 20, 3) == CW_E_BAD_FIELD);
    CHECK(mutated32("drain-host-stop", p + 24, 1) == CW_E_BAD_FIELD);
    for (uint32_t state = 0; state <= 11; state++) {
        int rc = mutated32("status-sandboxed", p + 0, state);
        CHECK(rc == (state >= 1 && state <= 10 ? CW_OK : CW_E_BAD_FIELD));
    }
    CHECK(mutated32("status-sandboxed", p + 4, 1) == CW_E_BAD_FIELD);
    CHECK(mutated64("status-guest-halted-with-flush", p + 8, (1ull << 53) - 1) == CW_OK);
    CHECK(mutated64("status-guest-halted-with-flush", p + 8, 1ull << 53) == CW_E_BAD_FIELD);
    CHECK(mutated64("status-guest-halted-with-flush", p + 32, 1ull << 53) == CW_E_BAD_FIELD);
    for (uint32_t code = 0; code <= 9; code++) { /* 8 is second_drain */
        int rc = mutated32("fault-truncated-rights", p + 0, code);
        CHECK(rc == (code >= 1 && code <= 8 ? CW_OK : CW_E_BAD_FIELD));
    }
    CHECK(mutated32("fault-truncated-rights", p + 4, 1) == CW_E_BAD_FIELD);
}

static void header_rules(void) {
    const cw_env_vector *drain = find("drain-host-stop");
    CHECK(mutated32("drain-host-stop", 8, 0) == CW_E_BAD_SEQUENCE);
    CHECK(mutated32("drain-host-stop", 8, 0xffffffffu) == CW_OK);
    uint8_t two[2] = { 2, 0 };
    CHECK(mutated("drain-host-stop", 4, two, 1, 0, CW_ENV_TO_WORKER) == CW_E_VERSION);
    uint8_t zero = 0;
    CHECK(mutated("drain-host-stop", 4, &zero, 1, 0, CW_ENV_TO_WORKER) == CW_E_VERSION);
    uint8_t flags[2] = { 1, 0 };
    CHECK(mutated("drain-host-stop", 6, flags, 2, 0, CW_ENV_TO_WORKER) == CW_E_UNKNOWN_TYPE);
    uint8_t six = 6;
    CHECK(mutated("drain-host-stop", 5, &six, 1, 0, CW_ENV_TO_WORKER) == CW_E_UNKNOWN_TYPE);
    CHECK(mutated("drain-host-stop", 5, &zero, 1, 0, CW_ENV_TO_WORKER) == CW_E_UNKNOWN_TYPE);
    /* Length field versus datagram: both directions of disagreement are malformed. */
    CHECK(mutated32("drain-host-stop", 12, 27) == CW_E_MALFORMED);
    CHECK(mutated32("drain-host-stop", 12, 29) == CW_E_MALFORMED);
    cw_envelope e;
    CHECK(cw_env_parse(drain->bytes, 15, 0, CW_ENV_TO_WORKER, &e) == CW_E_MALFORMED);
    CHECK(cw_env_parse(drain->bytes, 0, 0, CW_ENV_TO_WORKER, &e) == CW_E_MALFORMED);
    /* Rights: VOLUMES wants exactly 2, everything else exactly 0. */
    for (size_t rights = 0; rights <= 4; rights++) {
        CHECK(cw_env_parse(drain->bytes, drain->length, rights, CW_ENV_TO_WORKER, &e) == (rights == 0 ? CW_OK : CW_E_BAD_RIGHTS));
        const cw_env_vector *volumes = find("volumes-two-descriptors");
        CHECK(cw_env_parse(volumes->bytes, volumes->length, rights, CW_ENV_TO_WORKER, &e) == (rights == 2 ? CW_OK : CW_E_BAD_RIGHTS));
    }
    /* Direction: each kind in the other direction. */
    const char *to_worker[] = { "scope", "volumes-two-descriptors", "drain-host-stop" };
    const char *to_launcher[] = { "status-sandboxed", "fault-truncated-rights" };
    for (int i = 0; i < 3; i++) { const cw_env_vector *v = find(to_worker[i]); CHECK(cw_env_parse(v->bytes, v->length, v->rights, CW_ENV_TO_LAUNCHER, &e) == CW_E_BAD_DIRECTION); }
    for (int i = 0; i < 2; i++) { const cw_env_vector *v = find(to_launcher[i]); CHECK(cw_env_parse(v->bytes, v->length, 0, CW_ENV_TO_WORKER, &e) == CW_E_BAD_DIRECTION); }
}

static void encoder_refusals(void) {
    uint8_t out[CW_ENV_MAX_BYTES];
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_DRAIN;
    e.seq = 1;
    e.u.drain.origin = CW_ORIGIN_HOST_STOP;
    e.u.drain.budget_ms = 30000;
    CHECK(cw_env_encode(&e, out, sizeof out) == CW_ENV_HEADER + CW_ENV_DRAIN_BYTES);
    e.seq = 0;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.seq = 1;
    e.u.drain.budget_ms = 120001;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.drain.budget_ms = 1;
    e.u.drain.origin = 9;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.drain.origin = CW_ORIGIN_HOST_STOP;
    CHECK(cw_env_encode(&e, out, CW_ENV_HEADER + CW_ENV_DRAIN_BYTES - 1) == 0); /* too small */
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_STATUS;
    e.seq = 1;
    e.u.status.state = 0;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.status.state = CW_STATUS_EXITING;
    e.u.status.requested[0] = 1ull << 53;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.status.requested[0] = (1ull << 53) - 1;
    CHECK(cw_env_encode(&e, out, sizeof out) == CW_ENV_HEADER + CW_ENV_STATUS_BYTES);
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_FAULT;
    e.seq = 1;
    e.u.fault = 0;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.fault = 9;
    CHECK(cw_env_encode(&e, out, sizeof out) == 0);
    e.u.fault = CW_FAULT_SECOND_DRAIN;
    CHECK(cw_env_encode(&e, out, sizeof out) == CW_ENV_HEADER + CW_ENV_FAULT_BYTES);
    e.u.fault = CW_FAULT_INTERNAL;
    CHECK(cw_env_encode(&e, out, sizeof out) == CW_ENV_HEADER + CW_ENV_FAULT_BYTES);
}

/* The bounded sender never waits, even on a BLOCKING socket: with the buffer full, one attempt returns -1 at once. */
static void bounded_sender_does_not_block(void) {
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);                   /* blocking, no O_NONBLOCK on purpose */
    int small = 4096;
    (void)setsockopt(pair[0], SOL_SOCKET, SO_SNDBUF, &small, sizeof small);
    cw_l2_out out;
    cw_l2_out_init(&out, pair[0]);
    int sent = 0;
    while (sent < 100000 && cw_l2_send_status_once(&out, CW_STATUS_GUEST_HELLO, NULL, NULL) == 0) sent++;
    CHECK(sent > 0 && sent < 100000);                                       /* returned -1 instead of hanging */
    uint32_t seq = out.seq;
    CHECK(cw_l2_send_status_once(&out, CW_STATUS_EXITING, NULL, NULL) == -1 && out.seq == seq);
    CHECK(pthread_mutex_lock(&out.lock) == 0);
    CHECK(cw_l2_send_status_once(&out, CW_STATUS_EXITING, NULL, NULL) == -1);   /* a busy lock is not waited for */
    CHECK(pthread_mutex_unlock(&out.lock) == 0);
    close(pair[0]); close(pair[1]);
}

static void outbound_sender(void) {
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) == 0);
    cw_l2_out out;
    cw_l2_out_init(&out, pair[0]);
    uint64_t requested[2] = { 7, 9 }, completed[2] = { 7, 8 };
    CHECK(cw_l2_send_status(&out, CW_STATUS_SANDBOXED, NULL, NULL) == 0);
    CHECK(cw_l2_send_fault(&out, CW_FAULT_MUX_VIOLATION) == 0);
    CHECK(cw_l2_send_fault(&out, CW_FAULT_SECOND_DRAIN) == 0);
    CHECK(cw_l2_send_status(&out, CW_STATUS_GUEST_HALTED, requested, completed) == 0);
    uint64_t too_big[2] = { 1ull << 53, 0 };
    CHECK(cw_l2_send_status(&out, CW_STATUS_EXITING, too_big, NULL) == -1); /* refused; no datagram, no sequence number spent */
    CHECK(cw_l2_send_status(&out, CW_STATUS_EXITING, NULL, NULL) == 0);
    CHECK(cw_l2_send_status(&out, CW_STATUS_HALTING, NULL, NULL) == 0);      /* round 3: the wire values are 9 and 10, and nothing above */
    CHECK(cw_l2_send_status(&out, CW_STATUS_GUEST_FAULT, NULL, NULL) == 0);
    CHECK(CW_STATUS_HALTING == 9 && CW_STATUS_GUEST_FAULT == 10);
    CHECK(cw_l2_send_status(&out, 11, NULL, NULL) == -1);
    unsigned expected_seq = 1;
    for (int i = 0; i < 7; i++) {
        cw_inbound in;
        CHECK(cw_env_recv(pair[1], &in, 0) == CW_RECV_OK);
        cw_envelope e;
        CHECK(cw_env_parse(in.bytes, in.length, in.fd_count, CW_ENV_TO_LAUNCHER, &e) == CW_OK);
        CHECK(e.seq == expected_seq++); /* one counter, from 1, +1 per datagram */
        if (i == 1) CHECK(e.u.fault == CW_FAULT_MUX_VIOLATION);
        if (i == 2) CHECK(e.u.fault == CW_FAULT_SECOND_DRAIN);
        if (i == 5) CHECK(e.u.status.state == CW_STATUS_HALTING);
        if (i == 6) CHECK(e.u.status.state == CW_STATUS_GUEST_FAULT);
        if (i == 3) CHECK(e.u.status.state == CW_STATUS_GUEST_HALTED && e.u.status.requested[1] == 9 && e.u.status.completed[1] == 8);
    }
    cw_inbound none;
    CHECK(cw_env_recv(pair[1], &none, -1) == CW_RECV_AGAIN);
    close(pair[1]);
    CHECK(cw_l2_send_status(&out, CW_STATUS_EXITING, NULL, NULL) == -1); /* the launcher is gone: reported, not fatal */
    CHECK(out.gone);
    close(pair[0]);
}

int main(void) {
    golden_vectors();
    second_drain_vector();
    scope_digest_and_values();
    scope_boundaries();
    volumes_boundaries();
    other_payloads();
    header_rules();
    encoder_refusals();
    bounded_sender_does_not_block();
    outbound_sender();
    return cw_test_finish("test_envelope");
}
