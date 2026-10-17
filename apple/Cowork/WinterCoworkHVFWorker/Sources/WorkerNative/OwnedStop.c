#include "OwnedStop.h"

#include <string.h>

void cw_stop_init(cw_stop *stop) { memset(stop, 0, sizeof *stop); stop->phase = CW_PH_NOT_STARTED; }

void cw_stop_vm_started(cw_stop *stop) {
    if (stop->phase == CW_PH_NOT_STARTED) stop->phase = CW_PH_RUNNING;
}

cw_stop_action cw_stop_request(cw_stop *stop, uint64_t now_ms, const uint8_t nonce[16], uint32_t budget_ms, uint32_t origin) {
    if (origin != CW_ORIGIN_HOST_STOP && origin != CW_ORIGIN_OWNER_LOSS) return CW_STOP_VIOLATION;
    if (budget_ms > CW_DRAIN_BUDGET_CEILING_MS) return CW_STOP_VIOLATION;
    switch (stop->phase) {
    case CW_PH_NOT_STARTED:
        return CW_STOP_EXIT_NOT_BOOTED;
    case CW_PH_RUNNING:
        memcpy(stop->nonce, nonce, 16);
        stop->origin = origin;
        stop->budget_ms = budget_ms;
        stop->deadline_ms = now_ms + budget_ms + CW_STOP_GRACE_MS;
        stop->phase = CW_PH_DRAINING;
        return CW_STOP_SEND_DRAIN;
    case CW_PH_DRAINING:
    case CW_PH_ACKED:
    case CW_PH_HALTING:
        return memcmp(stop->nonce, nonce, 16) == 0 ? CW_STOP_IGNORED_SAME : CW_STOP_CONFLICT;
    case CW_PH_HALTED:
        return CW_STOP_NOTHING;
    }
    return CW_STOP_VIOLATION;
}

cw_stop_action cw_stop_guest_control(cw_stop *stop, const cw_control *control) {
    switch (control->type) {
    case CW_CTL_DRAIN_ACK:
        if (stop->phase != CW_PH_DRAINING || memcmp(control->nonce, stop->nonce, 16) != 0) return CW_STOP_VIOLATION;
        stop->phase = CW_PH_ACKED;
        return CW_STOP_REPORT_ACKED;
    case CW_CTL_HALTING:
        if (stop->phase != CW_PH_ACKED || memcmp(control->nonce, stop->nonce, 16) != 0) return CW_STOP_VIOLATION;
        stop->phase = CW_PH_HALTING;
        return CW_STOP_ACCEPTED;
    case CW_CTL_PONG:
        if (!stop->ping_outstanding || control->n != stop->ping_n) return CW_STOP_VIOLATION;
        stop->ping_outstanding = false;
        return CW_STOP_ACCEPTED;
    case CW_CTL_DRAIN:
    case CW_CTL_PING:
        return CW_STOP_VIOLATION; /* down-only types can never come up */
    }
    return CW_STOP_VIOLATION;
}

void cw_stop_ping_sent(cw_stop *stop, uint32_t n) {
    stop->ping_outstanding = true;
    stop->ping_n = n;
}

void cw_stop_halted(cw_stop *stop) {
    stop->phase = CW_PH_HALTED;
    stop->deadline_ms = 0; /* the process is about to exit by itself */
}

void cw_stop_quarantine(cw_stop *stop, uint64_t now_ms) {
    stop->quarantined = true;
    if (stop->deadline_ms == 0 && stop->phase != CW_PH_HALTED) stop->deadline_ms = now_ms + CW_QUARANTINE_MS;
}

cw_stop_action cw_stop_tick(cw_stop *stop, uint64_t now_ms) {
    if (stop->deadline_ms != 0 && now_ms >= stop->deadline_ms) return CW_STOP_TIMEOUT;
    return CW_STOP_NOTHING;
}

uint64_t cw_stop_wait_ms(const cw_stop *stop, uint64_t now_ms) {
    if (stop->deadline_ms == 0) return UINT64_MAX;
    return now_ms >= stop->deadline_ms ? 0 : stop->deadline_ms - now_ms;
}
