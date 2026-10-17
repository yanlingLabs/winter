/*
 * winter-guest-relay: the root process that owns the virtio port (N2 slice S5).
 *
 * PID 1 opens the single virtio-console port, checks its identity and starts this process with the open descriptor and
 * closes its own copy, so from then on exactly one process reads and writes L4 and exactly one numbers the outgoing
 * frames. It
 *   * frames and parses the WMX1 mux (common/wmx.c): sequence per (class, direction), the reserved provider class and every
 *     header violation end the stream;
 *   * terminates the control class itself: `ping` is answered with `pong` here, `drain` is handed to PID 1, and PID 1 asks
 *     for `drain_ack` and `halting`;
 *   * passes bootstrap-class payloads to PID 1 byte for byte (the bootstrap helper judges them) and frames what PID 1 sends up;
 *   * pumps the runtime class between the port and the three pipes that the supervisor receives as its RuntimeDuplexPorts
 *     (input, stdout, stderr). A runtime payload is a 4 byte prefix {conversation, stream, flags, 0} and then the stream's bytes
 *     (section 6.2 of the contract): IN goes to the supervisor's input, OUT and ERR come back with their stream byte, and the
 *     end flag closes a stream. Runtime frames are accepted only after PID 1 says the supervisor is ready ('G'); before that,
 *     or for a conversation outside the delivered set, they end the stream. OUT and ERR are read only after the bootstrap-up
 *     `runtime_ready` has been framed, so the host never sees runtime output before it.
 *   * sends a control-up `fault` when PID 1 asks ('X'), and when the host's stream violates the contract (best effort).
 * Every queue is bounded; overflow, a malformed frame or a vanished peer ends the process, and PID 1 then stops the guest.
 *
 * Production reads the port with plain read(2) because the port is a character device and cannot carry descriptors; the
 * check below refuses anything else. A socket stands in for the port only in the native tests (WG_TEST_PORT_SOCKET).
 */
#define _GNU_SOURCE
#include "../common/ctl.h"
#include "../common/ring.h"
#include "../common/wmx.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

enum {
    EXIT_ARGUMENTS = 64, EXIT_DESCRIPTOR = 65, EXIT_PORT_KIND = 70, EXIT_STRAY_FD = 71,
    EXIT_WMX_BASE = 80, /* + enum wmx_status of the violation */
    EXIT_NEVER_CONNECTED = 90, EXIT_HOST_CLOSED = 91, EXIT_CTL = 92, EXIT_OVERFLOW = 93, EXIT_INTERNAL = 94, EXIT_STATE = 95
};

#define PORT_CONNECT_WAIT_MS 30000
#define RUNTIME_CHUNK 65536u
#define MAX_STRAY_SCAN 256

static uint8_t rx_payload[WMX_MAX_RUNTIME];
/* Headroom the runtime stream must leave in the upstream ring. One loop iteration enqueues, ahead of any runtime read and without a way to
 * defer them: the pongs for one 64 KiB port read (a pong is exactly as long as the ping it answers, so at most 64 KiB), the bootstrap frames
 * for one 64 KiB read from PID 1 (at most 64 KiB / 8 bytes of ctl header = 8192 messages, each gaining a 16-byte frame header: 128 KiB at
 * most, plus their payload bytes, which the ctl bytes already count), and the two drain frames (a few hundred bytes). 256 KiB covers it. */
#define OUT_RESERVE (256u * 1024u)
static uint8_t out_storage[1024u * 1024u];
#define RUNTIME_UP_FRAME (WMX_HEADER_BYTES + WMX_RUNTIME_PREFIX_BYTES + RUNTIME_CHUNK)
/* OUT and ERR may both read in one iteration, after the pongs and bootstrap frames of that iteration. */
#define RUNTIME_GATE (OUT_RESERVE + 2u * RUNTIME_UP_FRAME)
_Static_assert(sizeof out_storage >= RUNTIME_GATE, "the upstream ring must hold the reserve plus two runtime chunks");
static uint8_t rt_in_storage[4u * 1024u * 1024u];
/* The host keeps runtime IN in flight (sent with no OUT or ERR byte received since) at or below 1 MiB (contract section 6.2, runtime-flow.json); a quarter of this queue. */
#define RUNTIME_IN_FLIGHT_LIMIT (1024u * 1024u)
_Static_assert(sizeof rt_in_storage >= 4u * RUNTIME_IN_FLIGHT_LIMIT, "the IN queue must stay at least four times the host's in-flight bound");
static uint8_t ctl_out_storage[128u * 1024u];
static uint8_t ctl_payload[CTL_MAX_PAYLOAD];
static uint8_t frame_scratch[WMX_HEADER_BYTES + WMX_RUNTIME_PREFIX_BYTES + CTL_MAX_PAYLOAD];
static uint8_t up_chunk[WMX_RUNTIME_PREFIX_BYTES + RUNTIME_CHUNK];
static uint8_t ctl_scratch[CTL_HEADER_BYTES + CTL_MAX_PAYLOAD];

static struct wmx_rx rx;
static struct wmx_seq seq_rx, seq_tx;
static struct wg_ring out_ring, rt_in_ring, ctl_out_ring;
static struct ctl_reader ctl_reader;

static int port_fd = -1, ctl_in_fd = -1, ctl_out_fd = -1, rt_in_fd = -1, rt_out_fd = -1, rt_err_fd = -1;
static int connected_once, runtime_open, runtime_ready_framed, rt_in_dead, rt_out_eof, rt_err_eof;
static int runtime_streams;            /* how many conversations' stream sets exist: 0 or 1 */
static int in_ended, out_end_sent, err_end_sent;
static int draining, drain_acked, halting, faulted;
static char drain_nonce[WMX_NONCE_CHARS + 1];

static long long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int set_nonblocking(int fd, int on) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0) return -1;
    return fcntl(fd, F_SETFL, on ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK));
}

/* Writes what is queued for PID 1, in order, for at most a second. The queue is the only writer on that pipe, so a message that was
 * half written stays whole and the fatal notice below can never be interleaved into it. */
static void flush_ctl_ring(void) {
    long long deadline = now_ms() + 1000;
    while (ctl_out_fd >= 0 && wg_ring_used(&ctl_out_ring)) {
        const uint8_t *run;
        size_t n = wg_ring_peek(&ctl_out_ring, &run);
        ssize_t written = write(ctl_out_fd, run, n);
        if (written > 0) { wg_ring_drop(&ctl_out_ring, (size_t)written); continue; }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && errno == EAGAIN) {
            long long left = deadline - now_ms();
            if (left <= 0) return;
            struct pollfd p = { ctl_out_fd, POLLOUT, 0 };
            poll(&p, 1, (int)left);
            continue;
        }
        return;
    }
}

/* Tell PID 1 why the stream ended (best effort, bounded) and leave. */
static void die(int code, int have_status, enum wmx_status status) {
    if (have_status && ctl_out_fd >= 0) {
        uint8_t byte = (uint8_t)status, message[CTL_HEADER_BYTES + 1];
        size_t n = ctl_encode(message, sizeof message, CTL_RELAY_FATAL, &byte, 1);
        if (n) wg_ring_put(&ctl_out_ring, message, n);   /* a full queue means PID 1 is not reading: its EOF will say the rest */
        flush_ctl_ring();
    }
    _exit(code);
}

static void ctl_to_init(uint8_t tag, const void *payload, size_t length) {
    size_t n = ctl_encode(ctl_scratch, sizeof ctl_scratch, tag, payload, length);
    if (!n || wg_ring_put(&ctl_out_ring, ctl_scratch, n) != 0) die(EXIT_OVERFLOW, 0, WMX_OK);
}

static void enqueue_up(unsigned class_value, const uint8_t *payload, size_t length) {
    uint32_t seq = wmx_seq_take(&seq_tx, class_value);
    size_t n = seq ? wmx_build_frame(frame_scratch, sizeof frame_scratch, class_value, seq, payload, length) : 0;
    if (!n || wg_ring_put(&out_ring, frame_scratch, n) != 0) die(EXIT_OVERFLOW, 0, WMX_OK);
}

static void enqueue_control(const struct wmx_control *message) {
    uint8_t body[256];
    size_t n = wmx_encode_control(message, body, sizeof body);
    if (!n) die(EXIT_INTERNAL, 0, WMX_OK);
    enqueue_up(WMX_CLASS_CONTROL, body, n);
}

/* Pushes what is queued to the port without ever blocking for long: a violation report is best effort. */
static void flush_port_best_effort(int milliseconds) {
    long long deadline = now_ms() + milliseconds;
    while (connected_once && wg_ring_used(&out_ring)) {
        const uint8_t *run;
        size_t n = wg_ring_peek(&out_ring, &run);
        ssize_t written = write(port_fd, run, n);
        if (written > 0) { wg_ring_drop(&out_ring, (size_t)written); continue; }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && errno == EAGAIN) {
            long long left = deadline - now_ms();
            if (left <= 0) return;
            struct pollfd p = { port_fd, POLLOUT, 0 };
            poll(&p, 1, (int)left);
            continue;
        }
        return;
    }
}

static void enqueue_fault(enum wmx_fault_code code, int with_nonce) {
    struct wmx_control message;
    memset(&message, 0, sizeof message);
    message.type = WMX_CONTROL_FAULT;
    message.fault_code = code;
    message.has_stop_nonce = with_nonce;
    if (with_nonce) memcpy(message.stop_nonce, drain_nonce, sizeof drain_nonce);
    enqueue_control(&message);
}

/* The host's stream broke the contract: say so (the worker turns it into the `guest_fault` status), then end the stream. */
static void fatal_status(enum wmx_status status) {
    if (!faulted && !halting) {
        faulted = 1;
        enqueue_fault(WMX_FAULT_PROTOCOL_VIOLATION, draining);
        flush_port_best_effort(1000);
    }
    die(EXIT_WMX_BASE + (int)status, 1, status);
}

static void handle_control(const uint8_t *payload, size_t length) {
    struct wmx_control control;
    enum wmx_status status = wmx_parse_control(payload, length, WMX_DOWN, &control);
    if (status != WMX_OK) fatal_status(status);
    if (control.type == WMX_CONTROL_PING) {
        struct wmx_control pong;
        memset(&pong, 0, sizeof pong);
        pong.type = WMX_CONTROL_PONG;
        pong.n = control.n;
        enqueue_control(&pong);
        return;
    }
    /* drain: the first one wins; the same nonce again is a retransmission, another nonce is a violation. */
    if (draining) {
        if (strcmp(control.stop_nonce, drain_nonce) != 0) fatal_status(WMX_BAD_FIELD);
        return;
    }
    draining = 1;
    memcpy(drain_nonce, control.stop_nonce, sizeof drain_nonce);
    uint8_t message[CTL_DRAIN_PAYLOAD_BYTES];
    memcpy(message, control.stop_nonce, WMX_NONCE_CHARS);
    message[32] = (uint8_t)control.budget_ms; message[33] = (uint8_t)(control.budget_ms >> 8);
    message[34] = (uint8_t)(control.budget_ms >> 16); message[35] = (uint8_t)(control.budget_ms >> 24);
    message[36] = (uint8_t)control.origin;
    ctl_to_init(CTL_DRAIN, message, sizeof message);
}

static void handle_frame(void) {
    enum wmx_status status = wmx_seq_accept(&seq_rx, rx.current.class_value, rx.current.seq);
    if (status != WMX_OK) fatal_status(status);
    switch (rx.current.class_value) {
    case WMX_CLASS_CONTROL:
        handle_control(rx.payload, rx.current.length);
        break;
    case WMX_CLASS_BOOTSTRAP:
        if (!draining) ctl_to_init(CTL_BOOTSTRAP_DOWN, rx.payload, rx.current.length);
        break;
    case WMX_CLASS_RUNTIME:
        /* A host that speaks before PID 1 sent 'G' (before `runtime_ready` could have been framed) violates the contract: nothing is
         * queued for the supervisor, the check below ends the stream. */
        if (draining) break;
        struct wmx_runtime_prefix prefix;
        status = wmx_parse_runtime_payload(rx.payload, rx.current.length, WMX_DOWN, &prefix);
        if (status != WMX_OK) fatal_status(status);
        /* Not delivered yet (the host speaks before `runtime_ready`), outside the delivered set, or after the stream's end. */
        if (!runtime_open || (int)prefix.conversation >= runtime_streams || in_ended) fatal_status(WMX_BAD_FIELD);
        if (prefix.end) in_ended = 1;
        if (rt_in_dead) break;
        size_t data = rx.current.length - WMX_RUNTIME_PREFIX_BYTES;
        if (data && wg_ring_put(&rt_in_ring, rx.payload + WMX_RUNTIME_PREFIX_BYTES, data) != 0) die(EXIT_OVERFLOW, 1, WMX_OVERSIZE);
        break;
    default:
        fatal_status(WMX_RESERVED_CLASS); /* unreachable: the header parser refuses the provider class */
    }
}

static void feed_port(const uint8_t *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        size_t used = 0;
        enum wmx_status status = WMX_OK;
        enum wmx_rx_event event = wmx_rx_feed(&rx, bytes + offset, length - offset, &used, &status);
        offset += used;
        if (event == WMX_RX_ERROR) fatal_status(status);
        if (event == WMX_RX_FRAME) handle_frame();
        else if (used == 0) die(EXIT_INTERNAL, 0, WMX_OK);
    }
}

/* The last frame before power-off (`halting` or a `fault`): write what is queued with a BLOCKING write. The virtio-console driver
 * returns from a blocking write only after the host consumed the buffer, which is the only acknowledgement the guest can get. */
static void flush_blocking_and_report(void) {
    set_nonblocking(port_fd, 0);
    int flushed = 1;
    while (wg_ring_used(&out_ring)) {
        const uint8_t *run;
        size_t n = wg_ring_peek(&out_ring, &run);
        ssize_t written = write(port_fd, run, n);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { flushed = 0; break; }
        wg_ring_drop(&out_ring, (size_t)written);
    }
    /* If the host never took the frame, PID 1 must not be told it did: leave without the 'f' and let its wait time out. */
    if (!flushed) die(EXIT_HOST_CLOSED, 0, WMX_OK);
    wg_ring_clear(&out_ring);
    set_nonblocking(port_fd, 1);
    ctl_to_init(CTL_FLUSHED, NULL, 0);
}

static void on_ctl_message(void) {
    uint8_t tag = ctl_reader.tag;
    size_t length = ctl_reader.length;
    if (tag == CTL_BOOTSTRAP_UP) {
        enqueue_up(WMX_CLASS_BOOTSTRAP, ctl_reader.payload, length);
        /* From here on the ring holds `runtime_ready` ahead of anything the runtime streams add, so the host never sees runtime output
         * before it. The helper's JSON is compact and its type field is a fixed token no other message carries. */
        if (memmem(ctl_reader.payload, length, "\"t\":\"runtime_ready\"", 19) != NULL) runtime_ready_framed = 1;
    } else if (tag == CTL_DRAIN_ACK || tag == CTL_HALTING) {
        char nonce[WMX_NONCE_CHARS + 1];
        if (length != WMX_NONCE_CHARS) die(EXIT_STATE, 1, WMX_BAD_FIELD);
        memcpy(nonce, ctl_reader.payload, WMX_NONCE_CHARS);
        nonce[WMX_NONCE_CHARS] = '\0';
        if (!draining || strcmp(nonce, drain_nonce) != 0 || (tag == CTL_DRAIN_ACK ? drain_acked : (!drain_acked || halting)) || faulted)
            die(EXIT_STATE, 1, WMX_BAD_FIELD);
        struct wmx_control message;
        memset(&message, 0, sizeof message);
        message.type = tag == CTL_DRAIN_ACK ? WMX_CONTROL_DRAIN_ACK : WMX_CONTROL_HALTING;
        memcpy(message.stop_nonce, nonce, sizeof nonce);
        enqueue_control(&message);
        if (tag == CTL_DRAIN_ACK) { drain_acked = 1; return; }
        halting = 1;
        flush_blocking_and_report();
    } else if (tag == CTL_RUNTIME_GO) {
        if (length != 1 || ctl_reader.payload[0] > 1 || runtime_open || draining) die(EXIT_STATE, 1, WMX_BAD_FIELD);
        runtime_open = 1;
        runtime_streams = ctl_reader.payload[0];
        if (!runtime_streams) { rt_out_eof = rt_err_eof = 1; out_end_sent = err_end_sent = 1; rt_in_dead = 1; }
    } else if (tag == CTL_FAULT) {
        if ((length != 1 && length != 1 + WMX_NONCE_CHARS) || ctl_reader.payload[0] < WMX_FAULT_UNMOUNT_FAILED || ctl_reader.payload[0] > WMX_FAULT_INTERNAL || faulted || halting)
            die(EXIT_STATE, 1, WMX_BAD_FIELD);
        int with_nonce = length != 1;
        if (with_nonce) {
            char nonce[WMX_NONCE_CHARS + 1];
            memcpy(nonce, ctl_reader.payload + 1, WMX_NONCE_CHARS);
            nonce[WMX_NONCE_CHARS] = '\0';
            if (!draining || strcmp(nonce, drain_nonce) != 0) die(EXIT_STATE, 1, WMX_BAD_FIELD);
        }
        faulted = 1;
        enqueue_fault((enum wmx_fault_code)ctl_reader.payload[0], with_nonce);
        flush_blocking_and_report();
    } else {
        die(EXIT_STATE, 1, WMX_BAD_FIELD);
    }
}

static void check_descriptor(int fd, int want_fifo, const char *role) {
    struct stat st;
    (void)role;
    if (fd < 3 || fstat(fd, &st) != 0) die(EXIT_DESCRIPTOR, 0, WMX_OK);
    if (want_fifo && !S_ISFIFO(st.st_mode)) die(EXIT_DESCRIPTOR, 0, WMX_OK);
}

static void reject_stray_descriptors(void) {
    int allowed[6] = { port_fd, ctl_in_fd, ctl_out_fd, rt_in_fd, rt_out_fd, rt_err_fd };
    for (int fd = 3; fd < MAX_STRAY_SCAN; fd++) {
        int known = 0;
        for (int i = 0; i < 6; i++) known |= allowed[i] == fd;
        if (!known && fcntl(fd, F_GETFD) != -1) die(EXIT_STRAY_FD, 0, WMX_OK);
    }
}

static int parse_fd(const char *text) {
    char *end = NULL;
    long value = strtol(text, &end, 10);
    return (!*text || *end || value < 3 || value >= MAX_STRAY_SCAN) ? -1 : (int)value;
}

static void parse_arguments(int argc, char **argv) {
    static const char *const names[6] = { "--port", "--ctl-in", "--ctl-out", "--rt-in", "--rt-out", "--rt-err" };
    int *slots[6] = { &port_fd, &ctl_in_fd, &ctl_out_fd, &rt_in_fd, &rt_out_fd, &rt_err_fd };
    if (argc != 13) _exit(EXIT_ARGUMENTS);
    for (int i = 0; i < 6; i++) {
        if (strcmp(argv[1 + 2 * i], names[i]) != 0) _exit(EXIT_ARGUMENTS);
        *slots[i] = parse_fd(argv[2 + 2 * i]);
        if (*slots[i] < 0) _exit(EXIT_ARGUMENTS);
        for (int j = 0; j < i; j++) if (*slots[j] == *slots[i]) _exit(EXIT_ARGUMENTS);
    }
}

/* One read of a supervisor output stream, framed with its stream byte; its end becomes an empty frame with the end flag. */
static void pump_up(int fd, enum wmx_stream stream, int *end_sent) {
    ssize_t n = read(fd, up_chunk + WMX_RUNTIME_PREFIX_BYTES, RUNTIME_CHUNK);
    if (n > 0) {
        wmx_write_runtime_prefix(up_chunk, 0, stream, 0);
        enqueue_up(WMX_CLASS_RUNTIME, up_chunk, WMX_RUNTIME_PREFIX_BYTES + (size_t)n);
    } else if (n == 0 || (errno != EAGAIN && errno != EINTR)) {
        wmx_write_runtime_prefix(up_chunk, 0, stream, 1);
        enqueue_up(WMX_CLASS_RUNTIME, up_chunk, WMX_RUNTIME_PREFIX_BYTES);
        *end_sent = 1;
    }
}

int main(int argc, char **argv) {
    parse_arguments(argc, argv);
    signal(SIGPIPE, SIG_IGN);
    umask(077);
#ifdef __linux__
    prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
#endif
    struct stat st;
    if (fstat(port_fd, &st) != 0) die(EXIT_DESCRIPTOR, 0, WMX_OK);
#ifdef WG_TEST_PORT_SOCKET
    if (!S_ISCHR(st.st_mode) && !S_ISSOCK(st.st_mode)) die(EXIT_PORT_KIND, 0, WMX_OK);
#else
    if (!S_ISCHR(st.st_mode)) die(EXIT_PORT_KIND, 0, WMX_OK);
#endif
    check_descriptor(ctl_in_fd, 1, "ctl-in");
    check_descriptor(ctl_out_fd, 1, "ctl-out");
    check_descriptor(rt_in_fd, 1, "rt-in");
    check_descriptor(rt_out_fd, 1, "rt-out");
    check_descriptor(rt_err_fd, 1, "rt-err");
    reject_stray_descriptors();
    int all[6] = { port_fd, ctl_in_fd, ctl_out_fd, rt_in_fd, rt_out_fd, rt_err_fd };
    for (int i = 0; i < 6; i++) if (set_nonblocking(all[i], 1) != 0) die(EXIT_DESCRIPTOR, 0, WMX_OK);

    wmx_rx_init(&rx, rx_payload, sizeof rx_payload);
    rx.limit[WMX_CLASS_BOOTSTRAP] = WMX_GUEST_MAX_BOOTSTRAP_DOWN;
    wmx_seq_init(&seq_rx);
    wmx_seq_init(&seq_tx);
    wg_ring_init(&out_ring, out_storage, sizeof out_storage);
    wg_ring_init(&rt_in_ring, rt_in_storage, sizeof rt_in_storage);
    wg_ring_init(&ctl_out_ring, ctl_out_storage, sizeof ctl_out_storage);
    ctl_reader_init(&ctl_reader, ctl_payload, sizeof ctl_payload, "UKHGX");

    long long connect_deadline = now_ms() + PORT_CONNECT_WAIT_MS;
    uint8_t buffer[65536];
    for (;;) {
        struct pollfd fds[6];
        enum { PORT, CTL_IN, CTL_OUT, RT_IN, RT_OUT, RT_ERR };
        memset(fds, 0, sizeof fds);
        for (int i = 0; i < 6; i++) fds[i].fd = -1;
        fds[PORT].fd = port_fd; fds[PORT].events = POLLIN | ((connected_once && wg_ring_used(&out_ring)) ? POLLOUT : 0);
        fds[CTL_IN].fd = ctl_in_fd; fds[CTL_IN].events = POLLIN;
        fds[CTL_OUT].fd = ctl_out_fd; fds[CTL_OUT].events = wg_ring_used(&ctl_out_ring) ? POLLOUT : 0;
        if (runtime_open && !rt_in_dead && rt_in_fd >= 0 && wg_ring_used(&rt_in_ring)) { fds[RT_IN].fd = rt_in_fd; fds[RT_IN].events = POLLOUT; }
        int room = wg_ring_free(&out_ring) >= RUNTIME_GATE;
        if (runtime_open && runtime_ready_framed && !out_end_sent && room) { fds[RT_OUT].fd = rt_out_fd; fds[RT_OUT].events = POLLIN; }
        if (runtime_open && runtime_ready_framed && !err_end_sent && room) { fds[RT_ERR].fd = rt_err_fd; fds[RT_ERR].events = POLLIN; }
        long long wait = connected_once ? -1 : connect_deadline - now_ms();
        if (!connected_once && wait <= 0) die(EXIT_NEVER_CONNECTED, 0, WMX_OK);
        int ready = poll(fds, 6, connected_once ? -1 : (int)(wait > 100 ? 100 : wait));
        if (ready < 0) { if (errno == EINTR) continue; die(EXIT_INTERNAL, 0, WMX_OK); }

        short port_events = fds[PORT].revents;
        /* A connected port shows no POLLHUP. The virtio-console driver reports "the host has not opened its end yet" as POLLHUP
         * (and a read of 0), so an idle poll that comes back without it means the host is there. */
        if (!connected_once && !(port_events & (POLLHUP | POLLERR | POLLNVAL))) connected_once = 1;
        if (port_events & (POLLIN | POLLHUP | POLLERR)) {
            ssize_t n = read(port_fd, buffer, sizeof buffer);
            if (n > 0) {
                connected_once = 1;
                feed_port(buffer, (size_t)n);
            } else if (n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR)) {
                if (connected_once) die(EXIT_HOST_CLOSED, 0, WMX_OK);
                struct timespec pause = { 0, 50 * 1000 * 1000 };
                nanosleep(&pause, NULL);
            }
        }
        if (connected_once && (port_events & POLLOUT) && wg_ring_used(&out_ring)) {
            const uint8_t *run;
            size_t n = wg_ring_peek(&out_ring, &run);
            ssize_t written = write(port_fd, run, n);
            if (written > 0) wg_ring_drop(&out_ring, (size_t)written);
            else if (written < 0 && errno != EAGAIN && errno != EINTR) die(EXIT_HOST_CLOSED, 0, WMX_OK);
        }
        if (fds[CTL_IN].revents & (POLLIN | POLLHUP)) {
            ssize_t n = read(ctl_in_fd, buffer, sizeof buffer);
            if (n == 0) die(EXIT_CTL, 0, WMX_OK); /* PID 1 is gone */
            if (n < 0 && errno != EAGAIN && errno != EINTR) die(EXIT_CTL, 0, WMX_OK);
            for (ssize_t offset = 0; n > 0 && offset < n;) {
                size_t used = 0;
                enum ctl_event event = ctl_reader_feed(&ctl_reader, buffer + offset, (size_t)(n - offset), &used);
                offset += (ssize_t)used;
                if (event == CTL_BAD) die(EXIT_CTL, 0, WMX_OK);
                if (event == CTL_MESSAGE) on_ctl_message();
                else if (used == 0) die(EXIT_INTERNAL, 0, WMX_OK);
            }
        }
        if ((fds[CTL_OUT].revents & POLLOUT) && wg_ring_used(&ctl_out_ring)) {
            const uint8_t *run;
            size_t n = wg_ring_peek(&ctl_out_ring, &run);
            ssize_t written = write(ctl_out_fd, run, n);
            if (written > 0) wg_ring_drop(&ctl_out_ring, (size_t)written);
            else if (written < 0 && errno != EAGAIN && errno != EINTR) die(EXIT_CTL, 0, WMX_OK);
        }
        if (fds[RT_IN].fd >= 0 && (fds[RT_IN].revents & (POLLOUT | POLLERR | POLLHUP))) {
            const uint8_t *run;
            size_t n = wg_ring_peek(&rt_in_ring, &run);
            ssize_t written = write(rt_in_fd, run, n);
            if (written > 0) wg_ring_drop(&rt_in_ring, (size_t)written);
            else if (written < 0 && errno != EAGAIN && errno != EINTR) { rt_in_dead = 1; wg_ring_clear(&rt_in_ring); }
        }
        /* The end of the host's IN stream closes the supervisor's input once everything before it was written. */
        if (in_ended && rt_in_fd >= 0 && !wg_ring_used(&rt_in_ring)) { close(rt_in_fd); rt_in_fd = -1; rt_in_dead = 1; }
        if (fds[RT_OUT].fd >= 0 && (fds[RT_OUT].revents & (POLLIN | POLLHUP)))
            pump_up(rt_out_fd, WMX_STREAM_OUT, &out_end_sent);
        if (fds[RT_ERR].fd >= 0 && (fds[RT_ERR].revents & (POLLIN | POLLHUP)))
            pump_up(rt_err_fd, WMX_STREAM_ERR, &err_end_sent);
    }
}
