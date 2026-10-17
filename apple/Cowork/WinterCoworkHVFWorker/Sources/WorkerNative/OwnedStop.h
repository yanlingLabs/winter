/* OwnedStop: the worker's side of a stop, as a pure (state, event) -> action machine with an injected clock.
 *
 * It never touches a socket, a thread or the time: the relay feeds it events and performs the actions it returns, and the
 * tests drive it with a fake clock. Two entry points start a stop: a DRAIN envelope from the launcher (host-stop, or the
 * launcher's own owner-loss drain), and the worker's own owner-loss path when L2 or L3 goes away.
 *
 * What it keeps apart, because the launcher's Class A receipt depends on it: the guest acknowledged THIS nonce (drain_ack),
 * said it was halting, and powered off (the VMM exit hook). A guest that powers off without acknowledging is reported as
 * halted and nothing more. Nothing here is release evidence: exit and EOF never release.
 */
#ifndef WINTER_COWORK_WORKER_OWNED_STOP_H
#define WINTER_COWORK_WORKER_OWNED_STOP_H

#include "Envelope.h"
#include "Mux.h"

/* Slack after the drain budget before the worker ends itself. NONE: the contract's stop timeline (section 5, layers G, X, K, H) has the worker
 * exit 75 (drain_timeout) at G, the DRAIN's own budget, measured from the moment the DRAIN arrived; the launcher kills later, at G + 20 s (the
 * libkrun exit watchdog) + 5 s. Kept as a named zero so the figure is one edit, and pinned by a test and a guard. */
#define CW_STOP_GRACE_MS 0u
/* After a mux violation with no stop requested, the worker ends itself this long after the violation. */
#define CW_QUARANTINE_MS 30000u

typedef enum {
    CW_PH_NOT_STARTED = 0, /* the VM has not been started */
    CW_PH_RUNNING,
    CW_PH_DRAINING,        /* the control drain frame is (being) sent; no ack yet */
    CW_PH_ACKED,           /* drain_ack with the right nonce */
    CW_PH_HALTING,         /* halting with the right nonce */
    CW_PH_HALTED           /* the VMM exit hook ran */
} cw_phase;

typedef enum {
    CW_STOP_NOTHING = 0,
    CW_STOP_SEND_DRAIN,       /* queue the control drain frame and report DRAINING */
    CW_STOP_EXIT_NOT_BOOTED,  /* a stop before the VM ever started: nothing to drain, exit cleanly */
    CW_STOP_IGNORED_SAME,     /* the same stop again: harmless */
    CW_STOP_CONFLICT,         /* a different nonce while a stop is running: fault internal, keep the first */
    CW_STOP_REPORT_ACKED,     /* report DRAIN_ACKED */
    CW_STOP_REPORT_HALTING,   /* report HALTING (the guest said so AFTER its drain_ack, with the drain's nonce) */
    CW_STOP_REPORT_FAULT,     /* report GUEST_FAULT (first control-up fault only) */
    CW_STOP_ACCEPTED,         /* accepted, nothing to report */
    CW_STOP_VIOLATION,        /* wrong order, wrong nonce, unsolicited: the mux stream is over */
    CW_STOP_TIMEOUT           /* the deadline passed: the worker ends itself */
} cw_stop_action;

typedef struct {
    cw_phase phase;
    uint8_t nonce[16];
    uint32_t origin;
    uint32_t budget_ms;
    uint64_t deadline_ms;      /* 0 = none */
    bool ping_outstanding;
    uint32_t ping_n;
    bool quarantined;
    bool guest_faulted;        /* a control-up fault arrived: from now on a `halting` is a violation and no Class A can exist */
} cw_stop;

void cw_stop_init(cw_stop *stop);
void cw_stop_vm_started(cw_stop *stop);
/* A stop is requested (DRAIN envelope, or the worker's own owner-loss with a fresh nonce and the 30 s budget). */
cw_stop_action cw_stop_request(cw_stop *stop, uint64_t now_ms, const uint8_t nonce[16], uint32_t budget_ms, uint32_t origin);
/* A control frame that came up from the guest. */
cw_stop_action cw_stop_guest_control(cw_stop *stop, const cw_control *control);
void cw_stop_ping_sent(cw_stop *stop, uint32_t n);
/* The VMM exit hook ran (after the block devices' final flush). */
void cw_stop_halted(cw_stop *stop);
/* The mux stream is over; if no stop follows within CW_QUARANTINE_MS the worker ends itself. */
void cw_stop_quarantine(cw_stop *stop, uint64_t now_ms);
cw_stop_action cw_stop_tick(cw_stop *stop, uint64_t now_ms);
/* Milliseconds until the deadline (0 when passed, a large value when there is none), to bound a poll. */
uint64_t cw_stop_wait_ms(const cw_stop *stop, uint64_t now_ms);

#endif
