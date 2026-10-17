/* The relay and OwnedStop together, over three in-process socketpairs (L2 envelopes, L3 launcher stream, L4 guest stream) and
 * a fake clock. The test plays the launcher and the guest. No VM, no sandbox, no HVF. */
#include "Relay.h"
#include "test_support.h"

#include <errno.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/wait.h>

typedef struct {
    int l2[2], l3[2], l4[2]; /* [0] the test's end (launcher / guest), [1] the relay's */
    uint64_t now;
} rig_t;

static rig_t rig;
static cw_relay relay; /* two 1 MiB frame buffers: static */
static cw_l2_out l2_out;

static uint64_t fake_now(void *context) { return ((rig_t *)context)->now; }
static void fake_random(void *context, uint8_t *out, size_t length) { (void)context; memset(out, 0x5a, length); }

static void rig_up(pid_t parent, uint32_t env_next_seq) {
    memset(&rig, 0, sizeof rig);
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, rig.l2) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, rig.l3) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, rig.l4) == 0);
    for (int i = 0; i < 2; i++) { /* the test's ends are non-blocking too, so a full buffer is a visible condition and not a hang */
        fcntl(rig.l3[i], F_SETFL, fcntl(rig.l3[i], F_GETFL) | O_NONBLOCK);
        fcntl(rig.l4[i], F_SETFL, fcntl(rig.l4[i], F_GETFL) | O_NONBLOCK);
    }
    cw_l2_out_init(&l2_out, rig.l2[1]);
    cw_relay_env env = { fake_now, fake_random, &rig };
    cw_relay_init(&relay, rig.l2[1], rig.l3[1], rig.l4[1], &l2_out, env_next_seq, parent, &env);
    cw_relay_vm_started(&relay);
}
static void rig_down(void) {
    int *all[] = { rig.l2, rig.l3, rig.l4 };
    for (int g = 0; g < 3; g++) for (int i = 0; i < 2; i++) if (all[g][i] >= 0) close(all[g][i]);
}

static int pump(int steps) {
    for (int i = 0; i < steps; i++) if (cw_relay_step(&relay, 1)) return 1;
    return 0;
}

/* ---- frames ------------------------------------------------------------------------------------------------------------- */
static size_t frame(uint8_t *out, size_t capacity, cw_mux_class cls, uint32_t seq, const char *payload, size_t length) {
    size_t n = cw_mux_encode(cls, seq, (const uint8_t *)payload, length, out, capacity);
    if (n == 0) { fprintf(stderr, "frame encode failed\n"); cw_test_failures++; }
    return n;
}
static void send_all(int fd, const uint8_t *bytes, size_t length) {
    size_t offset = 0;
    for (int spin = 0; offset < length && spin < 100000; spin++) {
        ssize_t sent = send(fd, bytes + offset, length - offset, 0);
        if (sent > 0) offset += (size_t)sent;
        else if (sent < 0 && errno != EAGAIN) break;
        else (void)cw_relay_step(&relay, 0);
    }
    CHECK(offset == length);
}
/* Read exactly `length` bytes from a test end, stepping the relay while waiting. */
static size_t read_exact(int fd, uint8_t *out, size_t length) {
    size_t got = 0;
    for (int spin = 0; got < length && spin < 200000; spin++) {
        ssize_t n = recv(fd, out + got, length - got, 0);
        if (n > 0) got += (size_t)n;
        else if (n == 0) break;
        else (void)cw_relay_step(&relay, 0);
    }
    return got;
}
static bool nothing_to_read(int fd) {
    for (int i = 0; i < 20; i++) (void)cw_relay_step(&relay, 0);
    uint8_t byte;
    return recv(fd, &byte, 1, 0) < 0 && errno == EAGAIN;
}

typedef struct { cw_env_kind kind; uint32_t seq; uint32_t value; uint64_t requested[2], completed[2]; } l2_event;
static size_t collect_l2(l2_event *events, size_t capacity) {
    size_t count = 0;
    for (;;) {
        cw_inbound in;
        if (cw_env_recv(rig.l2[0], &in, -1) != CW_RECV_OK || count >= capacity) break;
        cw_envelope e;
        CHECK(cw_env_parse(in.bytes, in.length, in.fd_count, CW_ENV_TO_LAUNCHER, &e) == CW_OK);
        l2_event ev = { e.kind, e.seq, e.kind == CW_ENV_STATUS ? e.u.status.state : e.u.fault, { 0, 0 }, { 0, 0 } };
        if (e.kind == CW_ENV_STATUS) for (int i = 0; i < 2; i++) { ev.requested[i] = e.u.status.requested[i]; ev.completed[i] = e.u.status.completed[i]; }
        events[count++] = ev;
    }
    return count;
}
static void send_drain_envelope(uint32_t seq, uint8_t nonce_byte, uint32_t budget, uint32_t origin) {
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_DRAIN;
    e.seq = seq;
    memset(e.u.drain.stop_nonce, nonce_byte, 16);
    e.u.drain.budget_ms = budget;
    e.u.drain.origin = origin;
    uint8_t bytes[CW_ENV_MAX_BYTES];
    size_t length = cw_env_encode(&e, bytes, sizeof bytes);
    CHECK(length > 0 && send(rig.l2[0], bytes, length, 0) == (ssize_t)length);
}
static void guest_control(uint32_t seq, const char *type, uint8_t nonce_byte) {
    char json[200], hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + 2 * i, 3, "%02x", nonce_byte);
    int n = snprintf(json, sizeof json, "{\"v\":1,\"t\":\"%s\",\"stopNonce\":\"%s\"}", type, hex);
    uint8_t bytes[CW_MUX_HEADER + 200];
    size_t length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, seq, json, (size_t)n);
    send_all(rig.l4[0], bytes, length);
}
static bool has(const l2_event *events, size_t count, cw_env_kind kind, uint32_t value) {
    for (size_t i = 0; i < count; i++) if (events[i].kind == kind && events[i].value == value) return true;
    return false;
}
static bool seq_increases(const l2_event *events, size_t count) {
    for (size_t i = 1; i < count; i++) if (events[i].seq != events[i - 1].seq + 1) return false;
    return count == 0 || events[0].seq >= 1;
}
/* The control frame the relay queued toward the guest, decoded. */
static bool read_control_down(cw_control *control, uint32_t *seq) {
    uint8_t header[CW_MUX_HEADER];
    if (read_exact(rig.l4[0], header, CW_MUX_HEADER) != CW_MUX_HEADER) return false;
    cw_mux_header parsed;
    if (cw_mux_parse_header(header, CW_MUX_HEADER, &parsed) != CW_OK || parsed.cls != CW_CLASS_CONTROL) return false;
    uint8_t payload[CW_MUX_CONTROL_MAX];
    if (read_exact(rig.l4[0], payload, parsed.length) != parsed.length) return false;
    *seq = parsed.seq;
    return cw_control_parse(payload, parsed.length, CW_MUX_DOWN, control) == CW_OK;
}

/* ---- scenarios ---------------------------------------------------------------------------------------------------------- */

static void relays_bootstrap_and_runtime_blind(void) {
    rig_up(getppid(), 3);
    uint8_t down[3][600];
    size_t lengths[3];
    /* Payloads the worker must not look at: not JSON, not UTF-8, no schema at all. It only judges headers. */
    lengths[0] = frame(down[0], sizeof down[0], CW_CLASS_BOOTSTRAP, 1, "\xc3(", 2);
    lengths[1] = frame(down[1], sizeof down[1], CW_CLASS_RUNTIME, 1, "\x00\x01\x02\xff", 4);
    lengths[2] = frame(down[2], sizeof down[2], CW_CLASS_RUNTIME, 2, "", 0);
    for (int i = 0; i < 3; i++) send_all(rig.l3[0], down[i], lengths[i]);
    for (int i = 0; i < 3; i++) {
        uint8_t got[600];
        CHECK(read_exact(rig.l4[0], got, lengths[i]) == lengths[i]);
        CHECK(memcmp(got, down[i], lengths[i]) == 0); /* byte for byte */
    }
    CHECK(relay.frames_down == 3);
    /* Up: the first bootstrap frame from the guest reports guest_hello on L2, once, without being read. */
    uint8_t up[3][600];
    size_t up_lengths[3];
    up_lengths[0] = frame(up[0], sizeof up[0], CW_CLASS_BOOTSTRAP, 1, "{\"anything\":true", 16);
    up_lengths[1] = frame(up[1], sizeof up[1], CW_CLASS_BOOTSTRAP, 2, "x", 1);
    up_lengths[2] = frame(up[2], sizeof up[2], CW_CLASS_RUNTIME, 1, "hello\n", 6);
    for (int i = 0; i < 3; i++) send_all(rig.l4[0], up[i], up_lengths[i]);
    for (int i = 0; i < 3; i++) {
        uint8_t got[600];
        CHECK(read_exact(rig.l3[0], got, up_lengths[i]) == up_lengths[i]);
        CHECK(memcmp(got, up[i], up_lengths[i]) == 0);
    }
    l2_event events[8];
    size_t count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_GUEST_HELLO);
    CHECK(!relay.quarantined && !relay.done);
    rig_down();
}

static void relays_maximum_frames_under_backpressure(void) {
    rig_up(getppid(), 3);
    static uint8_t payload[CW_MUX_RUNTIME_MAX], big[CW_MUX_MAX_FRAME], got[CW_MUX_MAX_FRAME];
    for (size_t i = 0; i < sizeof payload; i++) payload[i] = (uint8_t)(i * 13 + 5);
    size_t length = cw_mux_encode(CW_CLASS_RUNTIME, 1, payload, sizeof payload, big, sizeof big);
    CHECK(length == CW_MUX_MAX_FRAME);
    /* Down, with nobody reading L4: the relay must hold the frame and keep stepping without blocking or reading L3 further. */
    send_all(rig.l3[0], big, length / 2);
    for (int i = 0; i < 50; i++) (void)cw_relay_step(&relay, 0);
    CHECK(relay.frames_down == 0 && !relay.done);
    send_all(rig.l3[0], big + length / 2, length - length / 2);
    CHECK(read_exact(rig.l4[0], got, length) == length);
    CHECK(memcmp(got, big, length) == 0);
    CHECK(relay.frames_down == 1);
    /* Up, the same. A second frame behind it waits until the first is fully out. */
    size_t second = cw_mux_encode(CW_CLASS_RUNTIME, 2, (const uint8_t *)"two", 3, big + 0, 19);
    CHECK(second == 19);
    uint8_t two[19];
    memcpy(two, big, 19);
    size_t first = cw_mux_encode(CW_CLASS_RUNTIME, 1, payload, sizeof payload, big, sizeof big);
    CHECK(first == length);
    send_all(rig.l4[0], big, first);
    send_all(rig.l4[0], two, sizeof two);
    CHECK(read_exact(rig.l3[0], got, first) == first && memcmp(got, big, first) == 0);
    uint8_t got_two[19];
    CHECK(read_exact(rig.l3[0], got_two, sizeof got_two) == sizeof got_two && memcmp(got_two, two, sizeof two) == 0);
    CHECK(relay.frames_up == 2 && !relay.quarantined);
    rig_down();
}

static void a_violation_ends_the_stream_not_the_vm(void) {
    struct { const char *name; int side; /* 3 = launcher, 4 = guest */ int mode; } cases[] = {
        { "control class from the launcher", 3, 0 }, { "bootstrap seq gap from the launcher", 3, 1 }, { "runtime repeat from the launcher", 3, 2 },
        { "provider class from the launcher", 3, 3 }, { "bad magic from the launcher", 3, 4 }, { "oversize header from the launcher", 3, 5 },
        { "provider class from the guest", 4, 3 }, { "runtime gap from the guest", 4, 1 }, { "bad control JSON from the guest", 4, 6 },
        { "unsolicited drain_ack from the guest", 4, 7 }, { "drain travelling up", 4, 8 }, { "unsolicited pong", 4, 9 },
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        rig_up(getppid(), 3);
        uint8_t bytes[200];
        size_t length = 0;
        int fd = cases[i].side == 3 ? rig.l3[0] : rig.l4[0];
        switch (cases[i].mode) {
        case 0: length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, "{\"v\":1,\"t\":\"ping\",\"n\":1}", 24); break;
        case 1: length = frame(bytes, sizeof bytes, cases[i].side == 3 ? CW_CLASS_BOOTSTRAP : CW_CLASS_RUNTIME, 2, "x", 1); break;
        case 2: { uint8_t one[40]; size_t n = frame(one, sizeof one, CW_CLASS_RUNTIME, 1, "x", 1); send_all(fd, one, n); uint8_t got[40]; CHECK(read_exact(rig.l4[0], got, n) == n);
                  length = frame(bytes, sizeof bytes, CW_CLASS_RUNTIME, 1, "y", 1); break; }
        case 3: { uint8_t provider[16] = { 'W', 'M', 'X', '1', 1, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 }; memcpy(bytes, provider, 16); length = 16; break; }
        case 4: { uint8_t junk[16] = { 'N', 'O', 'P', 'E' }; memcpy(bytes, junk, 16); length = 16; break; }
        case 5: { uint8_t big[16] = { 'W', 'M', 'X', '1', 1, 2, 0, 0, 1, 0, 0, 0, 1, 0, 0x10, 0 }; memcpy(bytes, big, 16); length = 16; break; }
        case 6: length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, "{\"v\":1,\"t\":\"pong\",\"n\":01}", 24); break;
        case 7: { char json[120]; int n = snprintf(json, sizeof json, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\"}"); length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, json, (size_t)n); break; }
        case 8: { char json[160]; int n = snprintf(json, sizeof json, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\",\"budgetMs\":1,\"origin\":\"host-stop\"}"); length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, json, (size_t)n); break; }
        case 9: length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, "{\"v\":1,\"t\":\"pong\",\"n\":4}", 24); break;
        }
        send_all(fd, bytes, length);
        for (int k = 0; k < 20; k++) (void)cw_relay_step(&relay, 0);
        if (!relay.quarantined) fprintf(stderr, "no violation for: %s\n", cases[i].name);
        CHECK(relay.quarantined);
        CHECK(!relay.done); /* the VM keeps running; the worker ends itself only when the quarantine deadline passes */
        l2_event events[4];
        size_t count = collect_l2(events, 4);
        CHECK(count == 1 && events[0].kind == CW_ENV_FAULT && events[0].value == CW_FAULT_MUX_VIOLATION);
        /* Nothing more is read from either mux link: a frame that WOULD be valid (bootstrap seq 1 in each direction) is never forwarded. */
        uint8_t after[40];
        size_t n = frame(after, sizeof after, CW_CLASS_BOOTSTRAP, 1, "z", 1);
        (void)send(rig.l3[0], after, n, 0);
        (void)send(rig.l4[0], after, n, 0);
        CHECK(nothing_to_read(rig.l4[0]));
        CHECK(nothing_to_read(rig.l3[0]));
        rig_down();
    }
}

static void descriptor_on_a_mux_stream(void) {
    rig_up(getppid(), 3);
    int victim = open("/dev/null", O_RDONLY);
    uint8_t byte = 'W';
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { &byte, 1 };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io; message.msg_iovlen = 1; message.msg_control = rights.bytes; message.msg_controllen = sizeof rights.bytes;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &victim, sizeof victim);
    int before = cw_test_open_descriptors();
    CHECK(sendmsg(rig.l4[0], &message, 0) == 1);
    for (int i = 0; i < 20; i++) (void)cw_relay_step(&relay, 0);
    CHECK(relay.quarantined);
    CHECK(cw_test_open_descriptors() == before); /* closed, not kept */
    close(victim);
    rig_down();
}

static void orderly_drain(void) {
    rig_up(getppid(), 3);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    cw_control control;
    uint32_t seq = 0;
    CHECK(read_control_down(&control, &seq));
    CHECK(seq == 1 && control.type == CW_CTL_DRAIN && control.origin == CW_ORIGIN_HOST_STOP && control.budget_ms == 30000 && control.nonce[0] == 0x0f && control.nonce[15] == 0x0f);
    l2_event events[8];
    size_t count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAINING));
    /* The guest acknowledges THIS nonce, then says it is halting. */
    guest_control(1, "drain_ack", 0x0f);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAIN_ACKED));
    guest_control(2, "halting", 0x0f);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    CHECK(collect_l2(events, 8) == 0 && !relay.quarantined);
    /* Power-off: the VMM exit hook reports the flush counters. */
    uint64_t requested[2] = { 41, 7 }, completed[2] = { 41, 7 };
    cw_relay_guest_halted(&relay, 1, requested, completed);
    count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_GUEST_HALTED && events[1].value == CW_STATUS_EXITING);
    CHECK(events[0].requested[0] == 41 && events[0].requested[1] == 7 && events[0].completed[0] == 41 && events[0].completed[1] == 7);
    CHECK(seq_increases(events, count));
    CHECK(relay.stop.phase == CW_PH_HALTED);
    CHECK(!relay.done); /* the process ends by itself (libkrun exits); the relay does not */
    rig_down();
}

static void halt_without_ack_and_a_failed_vm(void) {
    rig_up(getppid(), 3);
    uint64_t zero[2] = { 0, 0 };
    cw_relay_guest_halted(&relay, 1, zero, zero); /* the guest powered off on its own: reported, never as an acknowledged drain */
    l2_event events[8];
    size_t count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].value == CW_STATUS_GUEST_HALTED && !has(events, count, CW_ENV_STATUS, CW_STATUS_DRAIN_ACKED));
    rig_down();
    rig_up(getppid(), 3);
    cw_relay_guest_halted(&relay, 0, zero, zero); /* the VMM exited without a halt */
    count = collect_l2(events, 8);
    CHECK(count == 2 && has(events, count, CW_ENV_FAULT, CW_FAULT_VM_FAILED) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED));
    rig_down();
}

static void wrong_acknowledgement(void) {
    rig_up(getppid(), 3);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    cw_control control;
    uint32_t seq;
    CHECK(read_control_down(&control, &seq));
    l2_event events[8];
    (void)collect_l2(events, 8);
    guest_control(1, "drain_ack", 0x10); /* another stop's nonce */
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    size_t count = collect_l2(events, 8);
    CHECK(relay.quarantined && count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION) && !has(events, count, CW_ENV_STATUS, CW_STATUS_DRAIN_ACKED));
    rig_down();
}

static void repeated_and_conflicting_drains(void) {
    rig_up(getppid(), 3);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    send_drain_envelope(4, 0x0f, 30000, CW_ORIGIN_HOST_STOP); /* the same stop again: harmless */
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    l2_event events[8];
    size_t count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAINING));
    send_drain_envelope(5, 0x33, 1000, CW_ORIGIN_OWNER_LOSS); /* a different stop: the contract has no code, so internal; the first stands */
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_INTERNAL));
    CHECK(relay.stop.nonce[0] == 0x0f && relay.stop.origin == CW_ORIGIN_HOST_STOP && !relay.done);
    CHECK(relay.control_down_seq == 1); /* exactly one drain frame went toward the guest */
    rig_down();
}

static void a_bad_launcher_envelope_starts_an_owner_loss_drain(void) {
    struct { const char *name; int mode; } cases[] = { { "wrong sequence", 0 }, { "a SCOPE again", 1 }, { "garbage", 2 }, { "a STATUS", 3 } };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        rig_up(getppid(), 3);
        uint8_t bytes[CW_ENV_MAX_BYTES];
        size_t length = 0;
        cw_envelope e;
        memset(&e, 0, sizeof e);
        if (cases[i].mode == 0) { e.kind = CW_ENV_DRAIN; e.seq = 9; e.u.drain.origin = CW_ORIGIN_HOST_STOP; length = cw_env_encode(&e, bytes, sizeof bytes); }
        if (cases[i].mode == 1) {
            e.kind = CW_ENV_SCOPE; e.seq = 3; snprintf(e.u.scope.workspace_id, 64, "w"); snprintf(e.u.scope.incarnation_id, 64, "i"); snprintf(e.u.scope.controller_instance_id, 64, "c");
            snprintf(e.u.scope.worker_instance_id, 64, "k"); snprintf(e.u.scope.admission_id, 64, "a"); e.u.scope.lease_epoch = 1; e.u.scope.vcpus = 2; e.u.scope.memory_mib = 768;
            length = cw_env_encode(&e, bytes, sizeof bytes);
        }
        if (cases[i].mode == 2) { memset(bytes, 0x41, 40); length = 40; }
        if (cases[i].mode == 3) { e.kind = CW_ENV_STATUS; e.seq = 3; e.u.status.state = CW_STATUS_SANDBOXED; length = cw_env_encode(&e, bytes, sizeof bytes); }
        CHECK(length > 0 && send(rig.l2[0], bytes, length, 0) == (ssize_t)length);
        for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
        l2_event events[8];
        size_t count = collect_l2(events, 8);
        CHECK(has(events, count, CW_ENV_FAULT, CW_FAULT_INTERNAL));
        CHECK(has(events, count, CW_ENV_STATUS, CW_STATUS_DRAINING));
        cw_control control;
        uint32_t seq;
        CHECK(read_control_down(&control, &seq) && control.type == CW_CTL_DRAIN && control.origin == CW_ORIGIN_OWNER_LOSS && control.budget_ms == 30000 && control.nonce[3] == 0x5a);
        CHECK(relay.l2_gone); /* an untrusted channel is not read again */
        rig_down();
    }
}

static void owner_loss(void) {
    const char *names[] = { "L2 closed", "L3 closed", "parent changed" };
    for (int mode = 0; mode < 3; mode++) {
        rig_up(mode == 2 ? 1 : getppid(), 3); /* a different parent pid */
        if (mode == 0) { close(rig.l2[0]); rig.l2[0] = -1; }
        if (mode == 1) { close(rig.l3[0]); rig.l3[0] = -1; }
        for (int k = 0; k < 10; k++) (void)cw_relay_step(&relay, 0);
        cw_control control;
        uint32_t seq = 0;
        bool got = read_control_down(&control, &seq);
        if (!got) fprintf(stderr, "no worker-originated drain for: %s\n", names[mode]);
        CHECK(got);
        CHECK(got && seq == 1 && control.type == CW_CTL_DRAIN && control.origin == CW_ORIGIN_OWNER_LOSS && control.budget_ms == CW_DRAIN_BUDGET_OWNER_LOSS_MS);
        CHECK(got && control.nonce[0] == 0x5a && control.nonce[15] == 0x5a); /* a nonce the worker minted itself */
        CHECK(relay.stop.phase == CW_PH_DRAINING && relay.stop.deadline_ms == CW_DRAIN_BUDGET_OWNER_LOSS_MS + CW_STOP_GRACE_MS);
        CHECK(!relay.done);
        /* The guest cooperates even though nobody is listening: the statuses simply cannot be delivered, and nothing breaks. */
        guest_control(1, "drain_ack", 0x5a);
        guest_control(2, "halting", 0x5a);
        for (int k = 0; k < 10; k++) (void)cw_relay_step(&relay, 0);
        CHECK(relay.stop.phase == CW_PH_HALTING && !relay.quarantined);
        uint64_t zero[2] = { 0, 0 };
        cw_relay_guest_halted(&relay, 1, zero, zero);
        CHECK(relay.stop.phase == CW_PH_HALTED);
        rig_down();
    }
}

static void deadlines(void) {
    /* A drain that never completes: the worker ends itself at budget + grace. */
    rig_up(getppid(), 3);
    rig.now = 10000;
    send_drain_envelope(3, 0x0f, 2000, CW_ORIGIN_HOST_STOP);
    CHECK(pump(5) == 0);
    rig.now = 10000 + 2000 + CW_STOP_GRACE_MS - 1;
    CHECK(pump(3) == 0);
    rig.now = 10000 + 2000 + CW_STOP_GRACE_MS;
    CHECK(pump(3) == 1 && relay.exit_code == CW_EXIT_DRAIN_TIMEOUT);
    rig_down();
    /* A violation with nobody stopping the VM: the worker ends itself CW_QUARANTINE_MS later. */
    rig_up(getppid(), 3);
    rig.now = 500;
    uint8_t junk[16] = { 'N', 'O', 'P', 'E' };
    send_all(rig.l3[0], junk, 16);
    CHECK(pump(5) == 0 && relay.quarantined);
    rig.now = 500 + CW_QUARANTINE_MS - 1;
    CHECK(pump(3) == 0);
    rig.now = 500 + CW_QUARANTINE_MS;
    CHECK(pump(3) == 1 && relay.exit_code == CW_EXIT_MUX_QUARANTINE);
    rig_down();
    /* A guest that powered off in time is never timed out afterwards. */
    rig_up(getppid(), 3);
    rig.now = 0;
    send_drain_envelope(3, 0x0f, 1000, CW_ORIGIN_HOST_STOP);
    CHECK(pump(5) == 0);
    uint64_t zero[2] = { 0, 0 };
    cw_relay_guest_halted(&relay, 1, zero, zero);
    rig.now = 1000000;
    CHECK(pump(5) == 0);
    rig_down();
    /* An idle, healthy guest is never timed out either. */
    rig_up(getppid(), 3);
    rig.now = 1u << 30;
    CHECK(pump(5) == 0);
    rig_down();
}

static void a_drain_during_quarantine_still_reaches_the_guest(void) {
    rig_up(getppid(), 3);
    uint8_t junk[16] = { 'N', 'O', 'P', 'E' };
    send_all(rig.l4[0], junk, 16);
    CHECK(pump(5) == 0 && relay.quarantined);
    l2_event events[8];
    (void)collect_l2(events, 8);
    send_drain_envelope(3, 0x77, 1000, CW_ORIGIN_HOST_STOP);
    CHECK(pump(5) == 0);
    cw_control control;
    uint32_t seq;
    CHECK(read_control_down(&control, &seq) && control.type == CW_CTL_DRAIN && control.nonce[0] == 0x77);
    rig_down();
}

static void before_the_vm(void) {
    rig_up(getppid(), 3);
    relay.stop.phase = CW_PH_NOT_STARTED; /* the production order calls cw_relay_vm_started first; this is the defensive branch */
    send_drain_envelope(3, 0x0f, 1000, CW_ORIGIN_HOST_STOP);
    CHECK(pump(5) == 1 && relay.exit_code == CW_EXIT_OK);
    rig_down();
    rig_up(getppid(), 3);
    relay.stop.phase = CW_PH_NOT_STARTED;
    close(rig.l2[0]); rig.l2[0] = -1;
    CHECK(pump(5) == 1 && relay.exit_code == CW_EXIT_OK);
    rig_down();
}

static void descriptors_after_intake(void) {
    rig_up(getppid(), 3);
    int victim = open("/dev/null", O_RDONLY);
    uint8_t bytes[CW_ENV_MAX_BYTES];
    cw_envelope e;
    memset(&e, 0, sizeof e);
    e.kind = CW_ENV_DRAIN; e.seq = 3; e.u.drain.origin = CW_ORIGIN_HOST_STOP; e.u.drain.budget_ms = 1;
    size_t length = cw_env_encode(&e, bytes, sizeof bytes);
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { bytes, length };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io; message.msg_iovlen = 1; message.msg_control = rights.bytes; message.msg_controllen = sizeof rights.bytes;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &victim, sizeof victim);
    int before = cw_test_open_descriptors();
    CHECK(sendmsg(rig.l2[0], &message, 0) == (ssize_t)length);
    CHECK(pump(5) == 1 && relay.exit_code == CW_EXIT_RIGHTS); /* a descriptor nobody asked for: closed, silent, exit 79 */
    CHECK(cw_test_open_descriptors() == before);
    l2_event events[4];
    CHECK(collect_l2(events, 4) == 0); /* and nothing was acknowledged */
    close(victim);
    rig_down();
}

static void pings(void) {
    rig_up(getppid(), 3);
    CHECK(cw_relay_ping(&relay, 41) == 0);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    cw_control control;
    uint32_t seq;
    CHECK(read_control_down(&control, &seq) && control.type == CW_CTL_PING && control.n == 41 && seq == 1);
    uint8_t bytes[CW_MUX_HEADER + 40];
    size_t length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, "{\"v\":1,\"t\":\"pong\",\"n\":41}", 25);
    send_all(rig.l4[0], bytes, length);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    CHECK(!relay.quarantined);
    length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 2, "{\"v\":1,\"t\":\"pong\",\"n\":41}", 25);
    send_all(rig.l4[0], bytes, length);
    for (int i = 0; i < 5; i++) (void)cw_relay_step(&relay, 0);
    CHECK(relay.quarantined); /* answered once; a second pong is unsolicited */
    rig_down();
}

/* Only meaningful with a 16 slot control buffer: twenty descriptors on L2 or on L3 AFTER intake are a truncated control buffer, which
 * ends the worker with exit 79 and acknowledges nothing. Runs in a child; the parent checks the status. */
static void send_rights(int fd, int count) {
    int victim = open("/dev/null", O_RDONLY);
    uint8_t byte = 'W';
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(40 * sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { &byte, 1 };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io; message.msg_iovlen = 1; message.msg_control = rights.bytes; message.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN((size_t)count * sizeof(int));
    for (int i = 0; i < count; i++) memcpy((unsigned char *)CMSG_DATA(header) + (size_t)i * sizeof victim, &victim, sizeof victim);
    CHECK(sendmsg(fd, &message, 0) == 1);
    close(victim);
}
static int truncated_rights_child(int on_l2) {
    cw_test_failures = 0;
    rig_up(getppid(), 3);
    send_rights(on_l2 ? rig.l2[0] : rig.l3[0], 20);
    int done = pump(5);
    l2_event events[4];
    CHECK(collect_l2(events, 4) == 0); /* nothing is acknowledged */
    return cw_test_failures != 0 ? 1 : (done && relay.exit_code == CW_EXIT_RIGHTS ? 0 : 3);
}
static int on_l2_child(void) { return truncated_rights_child(1); }
static int on_l3_child(void) { return truncated_rights_child(0); }
static void truncated_control_buffer(void) {
    if (CW_FD_CAPACITY >= 20) return;
    int (*bodies[2])(void) = { on_l2_child, on_l3_child };
    for (int i = 0; i < 2; i++) {
        fflush(NULL);
        pid_t child = fork();
        CHECK(child >= 0);
        if (child == 0) _exit(bodies[i]());
        int status = 0;
        CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status));
        if (WEXITSTATUS(status) != 0) fprintf(stderr, "truncated-rights child %d exited %d\n", i, WEXITSTATUS(status));
        CHECK(WEXITSTATUS(status) == 0);
    }
}

int main(void) {
    int before = cw_test_open_descriptors();
    relays_bootstrap_and_runtime_blind();
    relays_maximum_frames_under_backpressure();
    a_violation_ends_the_stream_not_the_vm();
    descriptor_on_a_mux_stream();
    orderly_drain();
    halt_without_ack_and_a_failed_vm();
    wrong_acknowledgement();
    repeated_and_conflicting_drains();
    a_bad_launcher_envelope_starts_an_owner_loss_drain();
    owner_loss();
    deadlines();
    a_drain_during_quarantine_still_reaches_the_guest();
    before_the_vm();
    descriptors_after_intake();
    pings();
    truncated_control_buffer();
    CHECK(cw_test_open_descriptors() == before);
    return cw_test_finish(CW_FD_CAPACITY == 256 ? "test_relay[256]" : "test_relay[16]");
}
