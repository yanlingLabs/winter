/* The relay and OwnedStop together, over three in-process socketpairs (L2 envelopes, L3 launcher stream, L4 guest stream) and
 * a fake clock. The test plays the launcher and the guest. No VM, no sandbox, no HVF. */
#include "Relay.h"
#include "test_support.h"

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/wait.h>

typedef struct {
    int l2[2], l3[2], l4[2]; /* [0] the test's end (launcher / guest), [1] the relay's */
    uint64_t now;
    pid_t fake_parent;       /* what getppid() would say */
} rig_t;

static rig_t rig;
static cw_relay relay; /* two 1 MiB frame buffers: static */
static cw_l2_out l2_out;

static uint64_t fake_now(void *context) { return ((rig_t *)context)->now; }
static void fake_random(void *context, uint8_t *out, size_t length) { (void)context; memset(out, 0x5a, length); }
static pid_t fake_parent_pid(void *context) { return ((rig_t *)context)->fake_parent; }

/* What the VMM exit hook reports after a clean power-off with both volumes flushed. */
static cw_exit_report good_report(void) {
    cw_exit_report r;
    memset(&r, 0, sizeof r);
    r.reason_off = true;
    r.counters_valid = true;
    r.requested[0] = 41; r.requested[1] = 7;
    r.completed[0] = 41; r.completed[1] = 7;
    r.final_attempted[0] = r.final_attempted[1] = 1;
    r.final_completed[0] = r.final_completed[1] = 1;
    return r;
}

static void rig_up(pid_t parent, uint32_t env_next_seq) {
    memset(&rig, 0, sizeof rig);
    rig.fake_parent = parent;
    CHECK(socketpair(AF_UNIX, SOCK_DGRAM, 0, rig.l2) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, rig.l3) == 0);
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, rig.l4) == 0);
    /* The TEST's ends are non-blocking so a full buffer is a visible condition and not a hang. The relay's own ends are left exactly as
     * socketpair() made them: cw_relay_init must make them non-blocking itself, or a full socket would block the pump. */
    fcntl(rig.l3[0], F_SETFL, fcntl(rig.l3[0], F_GETFL) | O_NONBLOCK);
    fcntl(rig.l4[0], F_SETFL, fcntl(rig.l4[0], F_GETFL) | O_NONBLOCK);
    cw_l2_out_init(&l2_out, rig.l2[1]);
    cw_relay_env env = { fake_now, fake_random, fake_parent_pid, &rig };
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
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_HALTING) && !relay.quarantined);   /* reported once the ack and the nonce fit */
    /* Power-off: the VMM exit hook reports the flush counters. */
    cw_exit_report report = good_report();
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_GUEST_HALTED && events[1].value == CW_STATUS_EXITING);
    CHECK(events[0].requested[0] == 41 && events[0].requested[1] == 7 && events[0].completed[0] == 41 && events[0].completed[1] == 7);
    CHECK(seq_increases(events, count));
    CHECK(relay.stop.phase == CW_PH_HALTED);
    CHECK(!relay.done); /* the process ends by itself (libkrun exits); the relay does not */
    rig_down();
}

/* A control-up fault from the guest: `code` plus a nonce (or null when nonce_byte == 0). */
static void guest_fault_frame(uint32_t seq, const char *code, int nonce_byte) {
    char json[200], hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + 2 * i, 3, "%02x", nonce_byte);
    int n = nonce_byte == 0 ? snprintf(json, sizeof json, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":null}", code)
                            : snprintf(json, sizeof json, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":\"%s\"}", code, hex);
    uint8_t bytes[CW_MUX_HEADER + 200];
    size_t length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, seq, json, (size_t)n);
    send_all(rig.l4[0], bytes, length);
}
static void run_relay(void) { for (int i = 0; i < 6; i++) (void)cw_relay_step(&relay, 0); }

/* Round 3: guest_fault and halting are L2 statuses; a halting after a fault is a mux violation; a power-off after a fault still reports guest_halted
 * from the hook alone (the launcher's verdict, not the worker's, refuses the Class A). */
static void guest_fault_and_halting(void) {
    l2_event events[8];
    size_t count;
    /* a fault outside any drain (null nonce) */
    rig_up(getppid(), 3);
    guest_fault_frame(1, "supervisor_lost", 0);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_FAULT) && !relay.quarantined);
    guest_fault_frame(2, "internal", 0);                         /* reported once */
    run_relay();
    CHECK(collect_l2(events, 8) == 0 && !relay.quarantined);
    rig_down();
    /* a fault during a drain, then the guest keeps going: drain_ack is still fine, halting is a violation */
    rig_up(getppid(), 3);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    run_relay();
    cw_control control;
    uint32_t seq = 0;
    CHECK(read_control_down(&control, &seq));
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAINING));
    guest_fault_frame(1, "unmount_failed", 0x0f);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_FAULT));
    guest_control(2, "drain_ack", 0x0f);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAIN_ACKED));
    guest_control(3, "halting", 0x0f);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION) && !has(events, count, CW_ENV_STATUS, CW_STATUS_HALTING) && relay.quarantined);
    cw_exit_report report = good_report();
    cw_relay_vmm_exit(&relay, &report);                           /* the hook still speaks for itself */
    count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].value == CW_STATUS_GUEST_HALTED && events[1].value == CW_STATUS_EXITING);
    rig_down();
    /* a fault that names another drain's nonce, or a nonce when no drain runs, is a violation and reports nothing */
    rig_up(getppid(), 3);
    guest_fault_frame(1, "internal", 0xa5);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION) && relay.quarantined);
    rig_down();
    rig_up(getppid(), 3);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    run_relay();
    (void)collect_l2(events, 8);
    guest_fault_frame(1, "internal", 0xa5);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_FAULT));
    rig_down();
    /* a fault code outside the contract's four is a violation */
    rig_up(getppid(), 3);
    guest_fault_frame(1, "meltdown", 0);
    run_relay();
    count = collect_l2(events, 8);
    CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION));
    rig_down();
    /* a fault travelling down is not a thing: the launcher side has no fault type */
    rig_up(getppid(), 3);
    {
        char json[160];
        int n = snprintf(json, sizeof json, "{\"v\":1,\"t\":\"fault\",\"code\":\"internal\",\"stopNonce\":null}");
        uint8_t bytes[CW_MUX_HEADER + 160];
        size_t length = frame(bytes, sizeof bytes, CW_CLASS_CONTROL, 1, json, (size_t)n);
        send_all(rig.l3[0], bytes, length);
        run_relay();
        count = collect_l2(events, 8);
        CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_MUX_VIOLATION));
    }
    rig_down();
    /* runtime frames carry a 4 byte stream prefix the worker never reads: all three streams, the end flag and an unknown conversation pass untouched */
    rig_up(getppid(), 3);
    {
        const uint8_t prefixes[][4] = { { 0, 1, 0, 0 }, { 15, 3, 1, 0 }, { 200, 9, 7, 9 } };   /* the last one is garbage the TypeScript parser refuses */
        for (size_t i = 0; i < 3; i++) {
            uint8_t payload[8] = { prefixes[i][0], prefixes[i][1], prefixes[i][2], prefixes[i][3], 'a', 'b', 'c', 'd' };
            uint8_t bytes[CW_MUX_HEADER + 8], got[CW_MUX_HEADER + 8];
            size_t length = frame(bytes, sizeof bytes, CW_CLASS_RUNTIME, (uint32_t)i + 1, (const char *)payload, sizeof payload);
            send_all(rig.l4[0], bytes, length);
            run_relay();
            CHECK(read_exact(rig.l3[0], got, length) == length && memcmp(got, bytes, length) == 0);
        }
        CHECK(!relay.quarantined);
    }
    rig_down();
}

/* The exhaustive truth table of cw_exit_report_halted: 2 (reason) x 2 (counters valid) x 3^2 (final attempted: 0, 1, 2) x 3^2 (final completed) x 3^2
 * (completed <, ==, > requested on each disk) = 2,916 reports. Exactly ONE says halted: reason OFF, counters valid, final attempted and completed == 1 on
 * both disks, completed == requested on both. */
static void halted_truth_table(void) {
    unsigned halted = 0, total = 0;
    for (unsigned reason = 0; reason < 2; reason++) for (unsigned valid = 0; valid < 2; valid++)
    for (unsigned a0 = 0; a0 < 3; a0++) for (unsigned a1 = 0; a1 < 3; a1++) for (unsigned f0 = 0; f0 < 3; f0++) for (unsigned f1 = 0; f1 < 3; f1++)
    for (unsigned r0 = 0; r0 < 3; r0++) for (unsigned r1 = 0; r1 < 3; r1++) {
        cw_exit_report report;
        memset(&report, 0, sizeof report);
        report.reason_off = reason == 1;
        report.counters_valid = valid == 1;
        report.final_attempted[0] = a0; report.final_attempted[1] = a1;
        report.final_completed[0] = f0; report.final_completed[1] = f1;
        const unsigned relation[2] = { r0, r1 }; /* 0: completed < requested, 1: equal, 2: completed > requested */
        for (int disk = 0; disk < 2; disk++) {
            report.requested[disk] = 41;
            report.completed[disk] = relation[disk] == 0 ? 40 : relation[disk] == 1 ? 41 : 42;
        }
        bool expected = reason == 1 && valid == 1 && a0 == 1 && a1 == 1 && f0 == 1 && f1 == 1 && r0 == 1 && r1 == 1;
        CHECK(cw_exit_report_halted(&report) == expected);
        if (cw_exit_report_halted(&report)) halted++;
        total++;
    }
    CHECK(total == 2916 && halted == 1);
}

/* The exit hook must not block (libkrun's header): with L2 not read and full, or its lock held, it returns promptly and loses only the statuses. */
static uint64_t wall_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000; }
static void exit_hook_does_not_block(void) {
    l2_event events[8];
    /* L2 full: the launcher is not reading. Fill the socket until a send fails. */
    rig_up(getppid(), 3);
    int filled = 0;
    while (filled < 100000 && cw_l2_send_status(&l2_out, CW_STATUS_GUEST_HELLO, NULL, NULL) == 0) filled++;
    CHECK(filled > 0 && filled < 100000);
    cw_exit_report report = good_report();
    uint64_t started = wall_ms();
    uint32_t seq_before = l2_out.seq;
    cw_relay_vmm_exit(&relay, &report);
    CHECK(l2_out.seq == seq_before);                       /* a status that was not sent spends no sequence number */
    CHECK(wall_ms() - started < 150);                      /* the old path retried 20 x 100 ms per status, three statuses */
    rig_down();
    /* The L2 sender's lock held by another thread of the process (the relay thread mid-send): the hook gives up at once. */
    rig_up(getppid(), 3);
    CHECK(pthread_mutex_lock(&l2_out.lock) == 0);
    started = wall_ms();
    cw_relay_vmm_exit(&relay, &report);
    CHECK(wall_ms() - started < 150);
    CHECK(pthread_mutex_unlock(&l2_out.lock) == 0);
    CHECK(collect_l2(events, 8) == 0);                     /* nothing was sent, and no sequence number was spent */
    rig_down();
    /* The relay's own lock held: the phase update is skipped, the statuses still go. */
    rig_up(getppid(), 3);
    CHECK(pthread_mutex_lock(&relay.lock) == 0);
    cw_relay_vmm_exit(&relay, &report);
    CHECK(pthread_mutex_unlock(&relay.lock) == 0);
    size_t count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].value == CW_STATUS_GUEST_HALTED && events[1].value == CW_STATUS_EXITING && events[1].seq == events[0].seq + 1);
    rig_down();
}

static void exit_reports(void) {
    l2_event events[8];
    size_t count;
    /* A guest that powered off on its own, with both volumes flushed: reported as halted, never as an acknowledged drain. */
    rig_up(getppid(), 3);
    cw_exit_report report = good_report();
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 2 && events[0].value == CW_STATUS_GUEST_HALTED && events[1].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_STATUS, CW_STATUS_DRAIN_ACKED));
    CHECK(events[0].requested[0] == 41 && events[0].completed[1] == 7);
    rig_down();
    /* Every exit that is not a power-off - reset, vcpu error, terminal fault, an unknown reason: reason_off is false - is NOT a halt. */
    rig_up(getppid(), 3);
    report = good_report();
    report.reason_off = false;
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_FAULT, CW_FAULT_VM_FAILED) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED));
    CHECK(relay.stop.phase == CW_PH_HALTED);
    rig_down();
    /* Counters that could not be read: no claim, and the EXITING status carries zeros rather than invented numbers. */
    rig_up(getppid(), 3);
    report = good_report();
    report.counters_valid = false;
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_FAULT, CW_FAULT_VM_FAILED) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED));
    CHECK(events[0].requested[0] == 0 && events[0].completed[0] == 0);
    rig_down();
    /* The final flush of either volume not attempted, or not completed, withholds the claim. */
    for (int disk = 0; disk < 2; disk++) {
        for (int which = 0; which < 2; which++) {
            rig_up(getppid(), 3);
            report = good_report();
            if (which == 0) report.final_attempted[disk] = 0; else report.final_completed[disk] = 0;
            cw_relay_vmm_exit(&relay, &report);
            count = collect_l2(events, 8);
            CHECK(count == 1 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_FAULT, CW_FAULT_VM_FAILED) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED));
            rig_down();
        }
    }
    /* completed < requested after a stop is an uncertain final flush: no guest_halted, `exiting` ALONE (no fault), and the real counters still shown on exiting. */
    rig_up(getppid(), 3);
    report = good_report();
    report.completed[0] = 40;
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].kind == CW_ENV_STATUS && events[0].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_FAULT, CW_FAULT_VM_FAILED) && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED));
    CHECK(events[0].requested[0] == 41 && events[0].completed[0] == 40);
    rig_down();
    /* completed ABOVE requested is counters that cannot be believed: also withheld (the reviewer's truth table found it reported as halted) */
    rig_up(getppid(), 3);
    report = good_report();
    report.completed[1] = 8;
    cw_relay_vmm_exit(&relay, &report);
    count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].value == CW_STATUS_EXITING && !has(events, count, CW_ENV_STATUS, CW_STATUS_GUEST_HALTED) && events[0].completed[1] == 8);
    rig_down();
    /* the hook never observed (the process ended some other way): the relay itself reports no halt and no clean exit */
    rig_up(getppid(), 3);
    count = collect_l2(events, 8);
    CHECK(count == 0 && !relay.done);
    rig_down();
    CHECK(cw_exit_report_halted(&(cw_exit_report){ .reason_off = true, .counters_valid = true, .final_attempted = { 1, 1 }, .final_completed = { 1, 1 } }));
    CHECK(!cw_exit_report_halted(&(cw_exit_report){ .reason_off = true, .counters_valid = false, .final_attempted = { 1, 1 }, .final_completed = { 1, 1 } }));
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

static void second_drain(void) {
    /* The first DRAIN stands. ANY later one - the same stop again, another nonce, a longer budget, another origin - is answered with FAULT
     * second_drain (code 8) and ignored: it can neither replace the first one's nonce and budget nor extend its deadline. */
    const struct { uint8_t nonce; uint32_t budget; uint32_t origin; const char *what; } later[] = {
        { 0x0f, 30000, CW_ORIGIN_HOST_STOP, "the same stop again" }, { 0x33, 30000, CW_ORIGIN_HOST_STOP, "another nonce" },
        { 0x0f, 120000, CW_ORIGIN_HOST_STOP, "the same nonce with a longer budget" }, { 0x33, 1000, CW_ORIGIN_OWNER_LOSS, "another nonce, budget and origin" } };
    for (size_t i = 0; i < sizeof later / sizeof later[0]; i++) {
        rig_up(getppid(), 3);
        rig.now = 5000;
        send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
        for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
        l2_event events[8];
        size_t count = collect_l2(events, 8);
        CHECK(count == 1 && has(events, count, CW_ENV_STATUS, CW_STATUS_DRAINING));
        uint64_t first_deadline = relay.stop.deadline_ms;
        rig.now = 9000;
        send_drain_envelope(4, later[i].nonce, later[i].budget, later[i].origin);
        for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
        count = collect_l2(events, 8);
        if (!(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_SECOND_DRAIN))) fprintf(stderr, "no second_drain for: %s\n", later[i].what);
        CHECK(count == 1 && has(events, count, CW_ENV_FAULT, CW_FAULT_SECOND_DRAIN) && events[0].value == 8);
        CHECK(relay.stop.nonce[0] == 0x0f && relay.stop.origin == CW_ORIGIN_HOST_STOP && relay.stop.budget_ms == 30000 && !relay.done);
        CHECK(relay.stop.deadline_ms == first_deadline); /* not replaced, not extended */
        CHECK(relay.control_down_seq == 1);              /* exactly one drain frame went toward the guest */
        CHECK(!relay.quarantined);
        /* A third one is answered too. */
        send_drain_envelope(5, 0x44, 1, CW_ORIGIN_HOST_STOP);
        for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
        count = collect_l2(events, 8);
        CHECK(count == 1 && events[0].value == CW_FAULT_SECOND_DRAIN && seq_increases(events, count));
        /* The deadline that stands is the FIRST one's: the later budget did not move it. */
        rig.now = first_deadline;
        CHECK(pump(3) == 1 && relay.exit_code == CW_EXIT_DRAIN_TIMEOUT);
        rig_down();
    }
    /* A launcher DRAIN while the WORKER's own owner-loss drain is running is a second drain as well: the worker's nonce stands. */
    rig_up(getppid(), 3);
    rig.fake_parent = 99999; /* the parent changed: the worker starts its own drain */
    for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
    CHECK(relay.stop.phase == CW_PH_DRAINING && relay.stop.origin == CW_ORIGIN_OWNER_LOSS && relay.stop.nonce[0] == 0x5a);
    l2_event events[8];
    (void)collect_l2(events, 8);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
    size_t count = collect_l2(events, 8);
    CHECK(count == 1 && events[0].value == CW_FAULT_SECOND_DRAIN && relay.stop.nonce[0] == 0x5a && relay.control_down_seq == 1);
    rig_down();
    /* A first DRAIN after the guest already powered off by itself is still a FIRST drain (no second_drain), and starts nothing. */
    rig_up(getppid(), 3);
    cw_exit_report report = good_report();
    cw_relay_vmm_exit(&relay, &report);
    (void)collect_l2(events, 8);
    send_drain_envelope(3, 0x0f, 30000, CW_ORIGIN_HOST_STOP);
    for (int k = 0; k < 5; k++) (void)cw_relay_step(&relay, 0);
    CHECK(collect_l2(events, 8) == 0 && relay.control_down_seq == 0);
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
    const char *names[] = { "L2 closed", "L3 closed", "parent changed", "parent already gone at start" };
    for (int mode = 0; mode < 4; mode++) {
        rig_up(mode == 3 ? 1 : 4242, 3);      /* mode 3: the relay was told its parent is pid 1 (launchd): the launcher was gone before the worker began */
        if (mode == 2) rig.fake_parent = 4243; /* mode 2: it was 4242 and is now somebody else */
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
        cw_exit_report report = good_report();
        cw_relay_vmm_exit(&relay, &report);
        CHECK(relay.stop.phase == CW_PH_HALTED);
        rig_down();
    }
    /* Control: a parent that is where it was is not an owner loss, however long the worker idles. */
    rig_up(4242, 3);
    rig.now = 1u << 30;
    CHECK(pump(10) == 0 && relay.stop.phase == CW_PH_RUNNING && relay.control_count == 0 && !relay.l2_gone);
    rig_down();
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
    cw_exit_report report = good_report();
    cw_relay_vmm_exit(&relay, &report);
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
    /* The uniform rule: a datagram the receiver REFUSES (here, longer than any envelope) that carried a descriptor is the same silent exit; the
     * same oversized datagram without a descriptor is an ordinary launcher fault (fault internal, then the owner-loss drain). */
    for (int with_fd = 0; with_fd <= 1; with_fd++) {
        rig_up(getppid(), 3);
        victim = open("/dev/null", O_RDONLY);
        uint8_t big[CW_ENV_MAX_BYTES + 200];
        memset(big, 0x41, sizeof big);
        struct iovec big_io = { big, sizeof big };
        memset(&message, 0, sizeof message);
        message.msg_iov = &big_io; message.msg_iovlen = 1;
        if (with_fd) { message.msg_control = rights.bytes; message.msg_controllen = sizeof rights.bytes; }
        CHECK(sendmsg(rig.l2[0], &message, 0) == (ssize_t)sizeof big);
        before = cw_test_open_descriptors();
        if (with_fd) {
            CHECK(pump(5) == 1 && relay.exit_code == CW_EXIT_RIGHTS);
            CHECK(collect_l2(events, 4) == 0);
        } else {
            CHECK(pump(5) == 0);
            size_t count = collect_l2(events, 4);
            CHECK(has(events, count, CW_ENV_FAULT, CW_FAULT_INTERNAL) && relay.l2_gone);
        }
        CHECK(cw_test_open_descriptors() == before);
        close(victim);
        rig_down();
    }
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
    exit_reports();
    halted_truth_table();
    exit_hook_does_not_block();
    guest_fault_and_halting();
    wrong_acknowledgement();
    second_drain();
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
