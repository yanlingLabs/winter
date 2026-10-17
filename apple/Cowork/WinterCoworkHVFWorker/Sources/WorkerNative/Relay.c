#include "Relay.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define CW_PARENT_CHECK_MS 5000u

/* ---- helpers ----------------------------------------------------------------------------------------------------------- */

static void apply(cw_relay *r, cw_stop_action action, uint64_t now);

static void prepare_socket(int fd) {
    int on = 1;
    (void)setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
    int flags = fcntl(fd, F_GETFL);
    if (flags >= 0) (void)fcntl(fd, F_SETFL, flags | O_NONBLOCK); /* every write is bounded: a full socket returns EAGAIN, never blocks the pump */
}

void cw_relay_init(cw_relay *r, int l2, int l3, int l4, cw_l2_out *out, uint32_t env_next_seq, pid_t parent, const cw_relay_env *env) {
    memset(r, 0, sizeof *r);
    r->l2 = l2;
    r->l3 = l3;
    r->l4 = l4;
    r->out = out;
    r->env = *env;
    r->parent = parent;
    r->env_next_seq = env_next_seq;
    pthread_mutex_init(&r->lock, NULL);
    cw_mux_seq_init(&r->seq);
    cw_mux_reader_reset(&r->down_reader);
    cw_mux_reader_reset(&r->up_reader);
    cw_stop_init(&r->stop);
    prepare_socket(l2);
    prepare_socket(l3);
    prepare_socket(l4);
}

void cw_relay_vm_started(cw_relay *r) {
    pthread_mutex_lock(&r->lock);
    cw_stop_vm_started(&r->stop);
    pthread_mutex_unlock(&r->lock);
}

static int queue_control(cw_relay *r, const cw_control *control) {
    if (r->control_count >= CW_RELAY_CTL_SLOTS) return -1;
    unsigned slot = (r->control_head + r->control_count) % CW_RELAY_CTL_SLOTS;
    uint8_t payload[CW_MUX_CONTROL_MAX];
    size_t payload_length = cw_control_encode(control, payload, sizeof payload);
    if (payload_length == 0) return -1;
    size_t length = cw_mux_encode(CW_CLASS_CONTROL, r->control_down_seq + 1, payload, payload_length, r->control_frames[slot], sizeof r->control_frames[slot]);
    if (length == 0) return -1;
    r->control_down_seq++;
    r->control_lengths[slot] = length;
    r->control_count++;
    return 0;
}

int cw_relay_ping(cw_relay *r, uint32_t n) {
    pthread_mutex_lock(&r->lock);
    cw_control control;
    memset(&control, 0, sizeof control);
    control.type = CW_CTL_PING;
    control.n = n;
    int rc = queue_control(r, &control);
    if (rc == 0) cw_stop_ping_sent(&r->stop, n);
    pthread_mutex_unlock(&r->lock);
    return rc;
}

static void finish(cw_relay *r, int exit_code) {
    if (!r->done) { r->done = true; r->exit_code = exit_code; }
}

/* A violation ends the mux stream, not the VM: stop reading both directions, say so on L2, and arm the quarantine deadline.
 * Frames already validated finish; the worker's own control frames (a drain) still flow. */
static void violation(cw_relay *r, uint64_t now) {
    if (r->quarantined) return;
    r->quarantined = true;
    (void)cw_l2_send_fault(r->out, CW_FAULT_MUX_VIOLATION);
    cw_stop_quarantine(&r->stop, now);
}

/* The launcher stopped speaking the contract on L2. The only trustworthy answer is to stop, orderly and bounded. */
static void launcher_fault(cw_relay *r, uint64_t now);

static void owner_lost(cw_relay *r, uint64_t now) {
    if (r->stop.phase == CW_PH_RUNNING) {
        uint8_t nonce[16];
        r->env.random_bytes(r->env.context, nonce, sizeof nonce);
        apply(r, cw_stop_request(&r->stop, now, nonce, CW_DRAIN_BUDGET_OWNER_LOSS_MS, CW_ORIGIN_OWNER_LOSS), now);
    } else if (r->stop.phase == CW_PH_NOT_STARTED) {
        finish(r, CW_EXIT_OK); /* nothing was started, nothing to drain */
    }
    /* DRAINING, ACKED, HALTING: a stop is already running. HALTED: the process is on its way out. */
}

static void launcher_fault(cw_relay *r, uint64_t now) {
    (void)cw_l2_send_fault(r->out, CW_FAULT_INTERNAL);
    r->l2_gone = true; /* no longer trusted; not read again */
    owner_lost(r, now);
}

static void apply(cw_relay *r, cw_stop_action action, uint64_t now) {
    switch (action) {
    case CW_STOP_SEND_DRAIN: {
        cw_control control;
        memset(&control, 0, sizeof control);
        control.type = CW_CTL_DRAIN;
        memcpy(control.nonce, r->stop.nonce, 16);
        control.budget_ms = r->stop.budget_ms;
        control.origin = r->stop.origin;
        if (queue_control(r, &control) != 0) { finish(r, CW_EXIT_INTERNAL); break; }
        (void)cw_l2_send_status(r->out, CW_STATUS_DRAINING, NULL, NULL);
        break;
    }
    case CW_STOP_EXIT_NOT_BOOTED:
        finish(r, CW_EXIT_OK);
        break;
    case CW_STOP_CONFLICT:
        (void)cw_l2_send_fault(r->out, CW_FAULT_INTERNAL); /* the contract has no code for a second drain; the first one stands */
        break;
    case CW_STOP_REPORT_ACKED:
        (void)cw_l2_send_status(r->out, CW_STATUS_DRAIN_ACKED, NULL, NULL);
        break;
    case CW_STOP_VIOLATION:
        violation(r, now);
        break;
    case CW_STOP_TIMEOUT:
        finish(r, r->stop.phase >= CW_PH_DRAINING && r->stop.phase < CW_PH_HALTED ? CW_EXIT_DRAIN_TIMEOUT : CW_EXIT_MUX_QUARANTINE);
        break;
    case CW_STOP_NOTHING:
    case CW_STOP_IGNORED_SAME:
    case CW_STOP_ACCEPTED:
        break;
    }
}

/* ---- L2 ---------------------------------------------------------------------------------------------------------------- */

static void read_l2(cw_relay *r, uint64_t now) {
    while (!r->l2_gone && !r->done) {
        cw_inbound in;
        int rc = cw_env_recv(r->l2, &in, -1);
        if (rc == CW_RECV_AGAIN) return;
        if (rc == CW_RECV_GONE) { r->l2_gone = true; owner_lost(r, now); return; }
        if (rc == CW_RECV_CTRUNC) { finish(r, CW_EXIT_RIGHTS); return; }
        if (rc != CW_RECV_OK) { launcher_fault(r, now); return; }
        /* After intake no descriptor is ever expected: close what came and end, silently. */
        if (in.fd_count != 0) { cw_inbound_close_fds(&in); finish(r, CW_EXIT_RIGHTS); return; }
        cw_envelope envelope;
        if (cw_env_parse(in.bytes, in.length, 0, CW_ENV_TO_WORKER, &envelope) != CW_OK || envelope.seq != r->env_next_seq || envelope.kind != CW_ENV_DRAIN) {
            launcher_fault(r, now);
            return;
        }
        r->env_next_seq++;
        apply(r, cw_stop_request(&r->stop, now, envelope.u.drain.stop_nonce, envelope.u.drain.budget_ms, envelope.u.drain.origin), now);
    }
}

/* ---- L3 and L4 --------------------------------------------------------------------------------------------------------- */

static void read_failed(cw_relay *r, int error, bool is_l3, uint64_t now) {
    switch (error) {
    case CW_E_CTRUNC: finish(r, CW_EXIT_RIGHTS); break;
    case CW_E_EOF:
    case CW_E_IO:
        if (is_l3) { r->l3_gone = true; owner_lost(r, now); } else r->l4_gone = true;
        break;
    default: /* a descriptor on a mux stream, or a refused header */
        violation(r, now);
        break;
    }
}

static void read_l3(cw_relay *r, uint64_t now) {
    while (!r->down_ready && !r->quarantined && !r->l3_gone && !r->done) {
        int rc = cw_mux_reader_pump(&r->down_reader, r->l3);
        if (rc == CW_MR_AGAIN) return;
        if (rc == CW_MR_MORE) continue;
        if (rc < 0) { read_failed(r, -rc, true, now); return; }
        const cw_mux_header *header = &r->down_reader.header;
        /* Control frames terminate at the worker and never cross L3 (and a frame from the launcher is never a control frame). */
        if (header->cls == CW_CLASS_CONTROL || cw_mux_seq_accept(&r->seq, header->cls, CW_MUX_DOWN, header->seq) != CW_OK) { violation(r, now); return; }
        r->down_ready = true;
        r->frames_down++;
    }
}

static void read_l4(cw_relay *r, uint64_t now) {
    while (!r->up_ready && !r->quarantined && !r->l4_gone && !r->done) {
        int rc = cw_mux_reader_pump(&r->up_reader, r->l4);
        if (rc == CW_MR_AGAIN) return;
        if (rc == CW_MR_MORE) continue;
        if (rc < 0) { read_failed(r, -rc, false, now); return; }
        const cw_mux_header *header = &r->up_reader.header;
        if (cw_mux_seq_accept(&r->seq, header->cls, CW_MUX_UP, header->seq) != CW_OK) { violation(r, now); return; }
        if (header->cls == CW_CLASS_CONTROL) {
            cw_control control;
            if (cw_control_parse(r->up_reader.buf + CW_MUX_HEADER, header->length, CW_MUX_UP, &control) != CW_OK) { violation(r, now); return; }
            cw_mux_reader_reset(&r->up_reader);
            apply(r, cw_stop_guest_control(&r->stop, &control), now);
            continue;
        }
        if (header->cls == CW_CLASS_BOOTSTRAP && !r->saw_hello) {
            /* The first bootstrap frame from the guest is its hello. Informational only: the payload is not read. */
            r->saw_hello = true;
            (void)cw_l2_send_status(r->out, CW_STATUS_GUEST_HELLO, NULL, NULL);
        }
        r->up_ready = true;
        r->frames_up++;
    }
}

/* Write as much of a slot as the socket takes. Returns 1 when finished, 0 when it would block, -1 when the peer is gone. */
static int write_slot(int fd, cw_out_slot *slot) {
    while (slot->offset < slot->length) {
        ssize_t sent = send(fd, slot->data + slot->offset, slot->length - slot->offset, 0);
        if (sent > 0) { slot->offset += (size_t)sent; continue; }
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS)) return 0;
        if (sent < 0 && errno == EINTR) continue;
        return -1;
    }
    return 1;
}

static void pump_out(cw_relay *r, uint64_t now) {
    /* L3, toward the launcher: one relayed guest frame at a time. */
    if (r->slot3.data == NULL && r->up_ready) {
        r->slot3 = (cw_out_slot){ r->up_reader.buf, r->up_reader.total, 0 };
    }
    if (r->slot3.data != NULL) {
        int rc = r->l3_gone ? -1 : write_slot(r->l3, &r->slot3);
        if (rc != 0) {
            r->slot3 = (cw_out_slot){ NULL, 0, 0 };
            r->up_ready = false;
            cw_mux_reader_reset(&r->up_reader);
            if (rc < 0 && !r->l3_gone) { r->l3_gone = true; owner_lost(r, now); }
        }
    }
    /* L4, toward the guest: the worker's own control frames first, then one relayed launcher frame. A frame in flight finishes first. */
    if (r->slot4.data == NULL) {
        if (r->control_count > 0) {
            r->slot4 = (cw_out_slot){ r->control_frames[r->control_head], r->control_lengths[r->control_head], 0 };
            r->slot4_is_control = true;
        } else if (r->down_ready) {
            r->slot4 = (cw_out_slot){ r->down_reader.buf, r->down_reader.total, 0 };
            r->slot4_is_control = false;
        }
    }
    if (r->slot4.data != NULL) {
        int rc = r->l4_gone ? -1 : write_slot(r->l4, &r->slot4);
        if (rc != 0) {
            if (r->slot4_is_control) { r->control_head = (r->control_head + 1) % CW_RELAY_CTL_SLOTS; r->control_count--; }
            else { r->down_ready = false; cw_mux_reader_reset(&r->down_reader); }
            r->slot4 = (cw_out_slot){ NULL, 0, 0 };
            if (rc < 0) r->l4_gone = true;
        }
    }
}

/* ---- the loop ---------------------------------------------------------------------------------------------------------- */

int cw_relay_step(cw_relay *r, int max_wait_ms) {
    pthread_mutex_lock(&r->lock);
    uint64_t now = r->env.now_ms(r->env.context);
    uint64_t wait = (uint64_t)(max_wait_ms < 0 ? 0 : max_wait_ms);
    if (wait > CW_PARENT_CHECK_MS) wait = CW_PARENT_CHECK_MS;
    uint64_t until_deadline = cw_stop_wait_ms(&r->stop, now);
    if (until_deadline < wait) wait = until_deadline;
    struct pollfd fds[3];
    nfds_t count = 0;
    if (!r->l2_gone) fds[count++] = (struct pollfd){ .fd = r->l2, .events = POLLIN, .revents = 0 };
    short wants3 = 0, wants4 = 0;
    if (!r->l3_gone) {
        if (!r->down_ready && !r->quarantined) wants3 |= POLLIN;
        if (r->slot3.data != NULL || r->up_ready) wants3 |= POLLOUT;
    }
    if (!r->l4_gone) {
        if (!r->up_ready && !r->quarantined) wants4 |= POLLIN;
        if (r->slot4.data != NULL || r->control_count > 0 || r->down_ready) wants4 |= POLLOUT;
    }
    /* A descriptor nobody wants to read or write is left out, so a closed peer on a link under backpressure cannot spin the loop. */
    if (wants3 != 0) fds[count++] = (struct pollfd){ .fd = r->l3, .events = wants3, .revents = 0 };
    if (wants4 != 0) fds[count++] = (struct pollfd){ .fd = r->l4, .events = wants4, .revents = 0 };
    pthread_mutex_unlock(&r->lock);

    (void)poll(count > 0 ? fds : NULL, count, (int)wait);

    pthread_mutex_lock(&r->lock);
    now = r->env.now_ms(r->env.context);
    read_l2(r, now);
    read_l3(r, now);
    read_l4(r, now);
    pump_out(r, now);
    /* A frame that just finished writing frees a reader: read again before sleeping. */
    read_l3(r, now);
    read_l4(r, now);
    pump_out(r, now);
    if (getppid() != r->parent && !r->done) owner_lost(r, now);
    apply(r, cw_stop_tick(&r->stop, now), now);
    int done = r->done ? 1 : 0;
    pthread_mutex_unlock(&r->lock);
    return done;
}

void cw_relay_guest_halted(cw_relay *r, int guest_halted, const uint64_t requested[2], const uint64_t completed[2]) {
    pthread_mutex_lock(&r->lock);
    cw_stop_halted(&r->stop);
    pthread_mutex_unlock(&r->lock);
    if (guest_halted) {
        (void)cw_l2_send_status(r->out, CW_STATUS_GUEST_HALTED, requested, completed);
    } else {
        (void)cw_l2_send_fault(r->out, CW_FAULT_VM_FAILED);
    }
    (void)cw_l2_send_status(r->out, CW_STATUS_EXITING, requested, completed);
}
