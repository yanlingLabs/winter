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
 *     (input, stdout, stderr): runtime bytes are accepted only after PID 1 says the supervisor exists ('G'), and stderr
 *     is read and dropped because the mux has no stderr stream.
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
static uint8_t out_storage[512u * 1024u];
static uint8_t rt_in_storage[4u * 1024u * 1024u];
static uint8_t ctl_out_storage[128u * 1024u];
static uint8_t ctl_payload[CTL_MAX_PAYLOAD];
static uint8_t frame_scratch[WMX_HEADER_BYTES + CTL_MAX_PAYLOAD];
static uint8_t ctl_scratch[CTL_HEADER_BYTES + CTL_MAX_PAYLOAD];

static struct wmx_rx rx;
static struct wmx_seq seq_rx, seq_tx;
static struct wg_ring out_ring, rt_in_ring, ctl_out_ring;
static struct ctl_reader ctl_reader;

static int port_fd = -1, ctl_in_fd = -1, ctl_out_fd = -1, rt_in_fd = -1, rt_out_fd = -1, rt_err_fd = -1;
static int connected_once, runtime_open, rt_in_dead, rt_out_eof, rt_err_eof;
static int draining, drain_acked, halting;
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

static void fatal_status(enum wmx_status status) { die(EXIT_WMX_BASE + (int)status, 1, status); }

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
        /* The contract has no "runtime ready" signal, so a host may speak right after `mounted`. The bytes wait in the bounded queue and
         * reach the supervisor only after PID 1 sent 'G'; a flood with no consumer ends the stream when the queue is full. */
        if (draining || rt_in_dead) break;
        if (wg_ring_put(&rt_in_ring, rx.payload, rx.current.length) != 0) die(EXIT_OVERFLOW, 1, WMX_OVERSIZE);
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

static void on_ctl_message(void) {
    uint8_t tag = ctl_reader.tag;
    size_t length = ctl_reader.length;
    if (tag == CTL_BOOTSTRAP_UP) {
        enqueue_up(WMX_CLASS_BOOTSTRAP, ctl_reader.payload, length);
    } else if (tag == CTL_DRAIN_ACK || tag == CTL_HALTING) {
        char nonce[WMX_NONCE_CHARS + 1];
        if (length != WMX_NONCE_CHARS) die(EXIT_STATE, 1, WMX_BAD_FIELD);
        memcpy(nonce, ctl_reader.payload, WMX_NONCE_CHARS);
        nonce[WMX_NONCE_CHARS] = '\0';
        if (!draining || strcmp(nonce, drain_nonce) != 0 || (tag == CTL_DRAIN_ACK ? drain_acked : (!drain_acked || halting)))
            die(EXIT_STATE, 1, WMX_BAD_FIELD);
        struct wmx_control message;
        memset(&message, 0, sizeof message);
        message.type = tag == CTL_DRAIN_ACK ? WMX_CONTROL_DRAIN_ACK : WMX_CONTROL_HALTING;
        memcpy(message.stop_nonce, nonce, sizeof nonce);
        enqueue_control(&message);
        if (tag == CTL_DRAIN_ACK) { drain_acked = 1; return; }
        halting = 1;
        /* The last frame before power-off: write what is queued with a BLOCKING write. The virtio-console driver returns from a
         * blocking write only after the host consumed the buffer, which is the only acknowledgement the guest can get. */
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
        /* If the host never took `halting`, PID 1 must not be told it did: leave without the 'f' and let its wait time out. */
        if (!flushed) die(EXIT_HOST_CLOSED, 0, WMX_OK);
        wg_ring_clear(&out_ring);
        set_nonblocking(port_fd, 1);
        ctl_to_init(CTL_FLUSHED, NULL, 0);
    } else if (tag == CTL_RUNTIME_GO) {
        if (length != 0 || runtime_open || draining) die(EXIT_STATE, 1, WMX_BAD_FIELD);
        runtime_open = 1;
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
    ctl_reader_init(&ctl_reader, ctl_payload, sizeof ctl_payload, "UKHG");

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
        if (runtime_open && !rt_in_dead && wg_ring_used(&rt_in_ring)) { fds[RT_IN].fd = rt_in_fd; fds[RT_IN].events = POLLOUT; }
        if (runtime_open && !rt_out_eof && wg_ring_free(&out_ring) >= WMX_HEADER_BYTES + RUNTIME_CHUNK) { fds[RT_OUT].fd = rt_out_fd; fds[RT_OUT].events = POLLIN; }
        if (runtime_open && !rt_err_eof) { fds[RT_ERR].fd = rt_err_fd; fds[RT_ERR].events = POLLIN; }
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
            else if (written < 0 && errno == EPIPE) { rt_in_dead = 1; wg_ring_clear(&rt_in_ring); }
            else if (written < 0 && errno != EAGAIN && errno != EINTR) { rt_in_dead = 1; wg_ring_clear(&rt_in_ring); }
        }
        if (fds[RT_OUT].fd >= 0 && (fds[RT_OUT].revents & (POLLIN | POLLHUP))) {
            ssize_t n = read(rt_out_fd, buffer, RUNTIME_CHUNK);
            if (n > 0) enqueue_up(WMX_CLASS_RUNTIME, buffer, (size_t)n);
            else if (n == 0) rt_out_eof = 1;
            else if (errno != EAGAIN && errno != EINTR) rt_out_eof = 1;
        }
        if (fds[RT_ERR].fd >= 0 && (fds[RT_ERR].revents & (POLLIN | POLLHUP))) {
            ssize_t n = read(rt_err_fd, buffer, sizeof buffer);
            if (n == 0) rt_err_eof = 1;
            else if (n < 0 && errno != EAGAIN && errno != EINTR) rt_err_eof = 1;
        }
    }
}
