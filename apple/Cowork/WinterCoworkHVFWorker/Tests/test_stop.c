/* OwnedStop: a pure state machine, driven with a fake clock. No sockets, no threads, no VM. */
#include "OwnedStop.h"
#include "test_support.h"

static const uint8_t NONCE_A[16] = { 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f };
static const uint8_t NONCE_B[16] = { 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5 };

static cw_control control(cw_control_type type, const uint8_t nonce[16], uint32_t n) {
    cw_control c;
    memset(&c, 0, sizeof c);
    c.type = type;
    if (nonce != NULL) memcpy(c.nonce, nonce, 16);
    c.n = n;
    return c;
}

static void orderly_stop(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    CHECK(stop.phase == CW_PH_NOT_STARTED);
    cw_stop_vm_started(&stop);
    CHECK(stop.phase == CW_PH_RUNNING);
    CHECK(cw_stop_request(&stop, 1000, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(stop.phase == CW_PH_DRAINING && stop.deadline_ms == 1000 + 30000 + CW_STOP_GRACE_MS);
    cw_control ack = control(CW_CTL_DRAIN_ACK, NONCE_A, 0), halting = control(CW_CTL_HALTING, NONCE_A, 0);
    CHECK(cw_stop_guest_control(&stop, &halting) == CW_STOP_VIOLATION);          /* halting before the ack: out of order */
    CHECK(stop.phase == CW_PH_DRAINING);
    CHECK(cw_stop_guest_control(&stop, &ack) == CW_STOP_REPORT_ACKED);
    CHECK(cw_stop_guest_control(&stop, &ack) == CW_STOP_VIOLATION);              /* a second ack */
    CHECK(cw_stop_guest_control(&stop, &halting) == CW_STOP_REPORT_HALTING);
    CHECK(stop.phase == CW_PH_HALTING);
    cw_stop_halted(&stop);
    CHECK(stop.phase == CW_PH_HALTED && stop.deadline_ms == 0);
    CHECK(cw_stop_tick(&stop, 1000000) == CW_STOP_NOTHING);                      /* halted: nothing left to time out */
}

static void wrong_nonce_and_unsolicited(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    cw_control ack_b = control(CW_CTL_DRAIN_ACK, NONCE_B, 0);
    cw_control ack_a = control(CW_CTL_DRAIN_ACK, NONCE_A, 0);
    CHECK(cw_stop_guest_control(&stop, &ack_a) == CW_STOP_VIOLATION);            /* an ack with no drain in flight */
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 100, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_guest_control(&stop, &ack_b) == CW_STOP_VIOLATION);            /* another stop's nonce */
    CHECK(stop.phase == CW_PH_DRAINING);
    cw_control halting_b = control(CW_CTL_HALTING, NONCE_B, 0);
    CHECK(cw_stop_guest_control(&stop, &ack_a) == CW_STOP_REPORT_ACKED);
    CHECK(cw_stop_guest_control(&stop, &halting_b) == CW_STOP_VIOLATION);
    /* Down-only types can never arrive from the guest. */
    cw_control drain = control(CW_CTL_DRAIN, NONCE_A, 0), ping = control(CW_CTL_PING, NULL, 1);
    CHECK(cw_stop_guest_control(&stop, &drain) == CW_STOP_VIOLATION);
    CHECK(cw_stop_guest_control(&stop, &ping) == CW_STOP_VIOLATION);
}

static void second_request(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_request(&stop, 5, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_IGNORED_SAME);
    CHECK(cw_stop_request(&stop, 5, NONCE_B, 30000, CW_ORIGIN_OWNER_LOSS) == CW_STOP_CONFLICT);
    CHECK(memcmp(stop.nonce, NONCE_A, 16) == 0 && stop.origin == CW_ORIGIN_HOST_STOP); /* the first stop stands */
    CHECK(stop.deadline_ms == 30000 + CW_STOP_GRACE_MS);                               /* and its deadline did not move */
    cw_stop_halted(&stop);
    CHECK(cw_stop_request(&stop, 9, NONCE_B, 1, CW_ORIGIN_HOST_STOP) == CW_STOP_NOTHING);
}

static void before_the_vm(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_EXIT_NOT_BOOTED);
    CHECK(stop.phase == CW_PH_NOT_STARTED && stop.deadline_ms == 0);
}

static void request_validation(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, 0) == CW_STOP_VIOLATION);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, 3) == CW_STOP_VIOLATION);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, CW_DRAIN_BUDGET_CEILING_MS + 1, CW_ORIGIN_HOST_STOP) == CW_STOP_VIOLATION);
    CHECK(stop.phase == CW_PH_RUNNING);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, CW_DRAIN_BUDGET_CEILING_MS, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
}

static void deadlines(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_wait_ms(&stop, 5) == UINT64_MAX);
    CHECK(cw_stop_tick(&stop, 1u << 30) == CW_STOP_NOTHING);                     /* no stop, no deadline: a long-lived guest is not timed */
    CHECK(cw_stop_request(&stop, 1000, NONCE_A, 30000, CW_ORIGIN_OWNER_LOSS) == CW_STOP_SEND_DRAIN);
    uint64_t deadline = 1000 + 30000 + CW_STOP_GRACE_MS;
    CHECK(cw_stop_tick(&stop, deadline - 1) == CW_STOP_NOTHING);
    CHECK(cw_stop_tick(&stop, deadline) == CW_STOP_TIMEOUT);
    CHECK(cw_stop_tick(&stop, deadline + 7) == CW_STOP_TIMEOUT);
    CHECK(cw_stop_wait_ms(&stop, deadline - 10) == 10);
    CHECK(cw_stop_wait_ms(&stop, deadline + 10) == 0);
    /* A mux violation with no stop arms the quarantine deadline; a later stop replaces it; a stop already running keeps its own. */
    cw_stop q;
    cw_stop_init(&q);
    cw_stop_vm_started(&q);
    cw_stop_quarantine(&q, 500);
    CHECK(q.quarantined && q.deadline_ms == 500 + CW_QUARANTINE_MS);
    CHECK(cw_stop_tick(&q, 500 + CW_QUARANTINE_MS) == CW_STOP_TIMEOUT);
    CHECK(cw_stop_request(&q, 600, NONCE_A, 1000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(q.deadline_ms == 600 + 1000 + CW_STOP_GRACE_MS);
    cw_stop r;
    cw_stop_init(&r);
    cw_stop_vm_started(&r);
    CHECK(cw_stop_request(&r, 100, NONCE_A, 1000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    cw_stop_quarantine(&r, 900);
    CHECK(r.deadline_ms == 100 + 1000 + CW_STOP_GRACE_MS);
}

static void pings(void) {
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    cw_control pong = control(CW_CTL_PONG, NULL, 7);
    CHECK(cw_stop_guest_control(&stop, &pong) == CW_STOP_VIOLATION);             /* unsolicited */
    cw_stop_ping_sent(&stop, 7);
    cw_control wrong = control(CW_CTL_PONG, NULL, 8);
    CHECK(cw_stop_guest_control(&stop, &wrong) == CW_STOP_VIOLATION);
    CHECK(cw_stop_guest_control(&stop, &pong) == CW_STOP_ACCEPTED);
    CHECK(cw_stop_guest_control(&stop, &pong) == CW_STOP_VIOLATION);             /* answered once */
}

static cw_control guest_fault(const uint8_t nonce[16]) {
    cw_control c = control(CW_CTL_FAULT, nonce, 0);
    c.fault_code = CW_GUEST_FAULT_UNMOUNT_FAILED;
    c.nonce_null = nonce == NULL;
    return c;
}

/* Round 3: a control-up fault is reported once as guest_fault, binds to the running drain's nonce, and makes any later halting a violation. */
static void guest_faults(void) {
    CHECK(CW_STOP_GRACE_MS == 0u); /* layer G: the worker's own deadline is the DRAIN's budget */
    cw_stop stop;
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    cw_control outside = guest_fault(NULL), bound = guest_fault(NONCE_A), other = guest_fault(NONCE_B);
    CHECK(cw_stop_guest_control(&stop, &bound) == CW_STOP_VIOLATION);             /* a nonce with no drain running */
    static const uint8_t ZERO[16] = { 0 };
    cw_control zero_nonce = guest_fault(ZERO);                                    /* ... even one equal to the (unset) stored nonce */
    CHECK(cw_stop_guest_control(&stop, &zero_nonce) == CW_STOP_VIOLATION);
    CHECK(!stop.guest_faulted);
    CHECK(cw_stop_guest_control(&stop, &outside) == CW_STOP_REPORT_FAULT);        /* null nonce outside any drain */
    CHECK(stop.guest_faulted);
    CHECK(cw_stop_guest_control(&stop, &outside) == CW_STOP_ACCEPTED);            /* reported once */
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_guest_control(&stop, &other) == CW_STOP_VIOLATION);             /* another drain's nonce */
    CHECK(cw_stop_guest_control(&stop, &bound) == CW_STOP_ACCEPTED);
    cw_control ack = control(CW_CTL_DRAIN_ACK, NONCE_A, 0), halting = control(CW_CTL_HALTING, NONCE_A, 0);
    CHECK(cw_stop_guest_control(&stop, &ack) == CW_STOP_REPORT_ACKED);
    CHECK(cw_stop_guest_control(&stop, &halting) == CW_STOP_VIOLATION);           /* halting after a fault is not believable */
    CHECK(stop.phase == CW_PH_ACKED);

    /* a fault during a drain, before any halting, then the usual order is refused only at halting */
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_guest_control(&stop, &bound) == CW_STOP_REPORT_FAULT);
    CHECK(cw_stop_guest_control(&stop, &ack) == CW_STOP_REPORT_ACKED);
    /* a fault after halting is still a fault, and still reported */
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_request(&stop, 0, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_guest_control(&stop, &ack) == CW_STOP_REPORT_ACKED);
    CHECK(cw_stop_guest_control(&stop, &halting) == CW_STOP_REPORT_HALTING);
    CHECK(cw_stop_guest_control(&stop, &bound) == CW_STOP_REPORT_FAULT);
    /* the deadline is exactly the budget */
    cw_stop_init(&stop);
    cw_stop_vm_started(&stop);
    CHECK(cw_stop_request(&stop, 1000, NONCE_A, 30000, CW_ORIGIN_HOST_STOP) == CW_STOP_SEND_DRAIN);
    CHECK(cw_stop_tick(&stop, 1000 + 30000 - 1) == CW_STOP_NOTHING && cw_stop_tick(&stop, 1000 + 30000) == CW_STOP_TIMEOUT);
}

int main(void) {
    guest_faults();
    orderly_stop();
    wrong_nonce_and_unsolicited();
    second_request();
    before_the_vm();
    request_validation();
    deadlines();
    pings();
    return cw_test_finish("test_stop");
}
