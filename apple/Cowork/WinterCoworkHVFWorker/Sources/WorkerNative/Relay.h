/* Relay: the worker's pump between L3 (launcher), L4 (guest) and L2 (launcher envelopes).
 *
 *   L3 -> L4  bootstrap and runtime frames, relayed byte for byte after a header check and a sequence check.
 *   L4 -> L3  the same, the other way. The first bootstrap frame from the guest also reports `guest_hello` on L2.
 *   control   TERMINATES HERE. A control frame never crosses L3; one from the guest is parsed strictly and fed to OwnedStop;
 *             the worker's own drain/ping frames are queued toward the guest ahead of the next relayed frame.
 *   L2        The FIRST DRAIN envelope starts a stop. A second one is answered with FAULT second_drain and ignored: the first nonce and budget
 *             stand and a later one can neither replace nor extend them. Anything else after intake is a launcher fault.
 *
 * One thread runs cw_relay_step in a loop (started BEFORE krun_start_enter, which never returns); the VMM exit hook calls
 * cw_relay_vmm_exit from another. Both are serialised by one lock, and the L2 sender has its own lock below it.
 *
 * Failure policy (fail closed, bounded, never a release):
 *   mux violation   `fault mux_violation`, both mux directions stop being read ("a violation ends the stream"), the VM keeps
 *                   running until the owner stops it, and the worker ends itself CW_QUARANTINE_MS later if nobody does.
 *                   ACK LIMIT: because L4 is no longer read, the guest's drain_ack and halting are never seen after a violation. A drain that
 *                   arrives while quarantined is still delivered to the guest, but it can only end by a power-off (the exit hook) or the
 *                   deadline, and no `drain_acked` status is ever reported for it, so a quarantined stop is never a Class A candidate.
 *   owner loss      L2 or L3 closed, or the parent changed, or the parent was ALREADY gone when the worker started (getppid() == 1): the
 *                   worker starts its own drain (origin owner-loss, 30 s budget, a fresh nonce) and ends itself when the budget plus a
 *                   grace period passes.
 *   drain deadline  budget + CW_STOP_GRACE_MS passed without a power-off: exit CW_EXIT_DRAIN_TIMEOUT.
 */
#ifndef WINTER_COWORK_WORKER_RELAY_H
#define WINTER_COWORK_WORKER_RELAY_H

#include "Envelope.h"
#include "Mux.h"
#include "OwnedStop.h"

#include <sys/types.h>

#define CW_RELAY_CTL_SLOTS 4u
/* An idle worker wakes this often (to notice a changed parent) and for events; there is no other timer. */
#define CW_RELAY_IDLE_MS 5000

typedef struct {
    uint64_t (*now_ms)(void *context);
    void (*random_bytes)(void *context, uint8_t *out, size_t length);
    pid_t (*parent_pid)(void *context); /* getppid() in the worker; injected so a vanished parent can be tested */
    void *context;
} cw_relay_env;

typedef struct {
    const uint8_t *data;
    size_t length;
    size_t offset;
} cw_out_slot;

typedef struct {
    int l2, l3, l4;
    cw_l2_out *out;
    cw_relay_env env;
    pid_t parent;
    pthread_mutex_t lock;

    cw_mux_reader down_reader; /* L3 */
    cw_mux_reader up_reader;   /* L4 */
    bool down_ready, up_ready;
    cw_mux_seq seq;
    uint32_t control_down_seq;
    uint8_t control_frames[CW_RELAY_CTL_SLOTS][CW_MUX_HEADER + CW_MUX_CONTROL_MAX];
    size_t control_lengths[CW_RELAY_CTL_SLOTS];
    unsigned control_head, control_count;
    cw_out_slot slot3, slot4;
    bool slot4_is_control;

    cw_stop stop;
    uint32_t env_next_seq;
    bool l2_gone, l3_gone, l4_gone, saw_hello, quarantined, done, drain_seen;
    int exit_code;
    uint64_t frames_down, frames_up;
} cw_relay;

/* `env_next_seq` is the next inbound L2 sequence (3 after SCOPE and VOLUMES). The relay owns no descriptor: the caller closes. */
void cw_relay_init(cw_relay *relay, int l2, int l3, int l4, cw_l2_out *out, uint32_t env_next_seq, pid_t parent, const cw_relay_env *env);
/* The VM is about to be entered (called BEFORE krun_start_enter, and before the relay thread starts). */
void cw_relay_vm_started(cw_relay *relay);
/* One poll iteration, at most max_wait_ms. Returns 0 to continue, 1 when the worker must end (relay->exit_code). */
int cw_relay_step(cw_relay *relay, int max_wait_ms);
/* What the VMM exit hook learned, already translated out of libkrun's types (WorkspaceWorker.c / CoworkAbi.h build it; the decision
 * below is made HERE so it can be tested without a library). */
typedef struct {
    bool reason_off;          /* the library's reason was exactly its `off` value (a guest power-off): reset, vcpu error, terminal fault and
                               * every unknown value are NOT */
    bool counters_valid;      /* the flush counters were read, with the size and device count the worker expects */
    uint64_t requested[2];    /* guest FLUSH requests captured, data then environment */
    uint64_t completed[2];    /* ... whose flush and sync returned success */
    uint64_t final_attempted[2];
    uint64_t final_completed[2];
} cw_exit_report;

/* True when the worker may say `guest_halted`: a guest power-off (reason off), counters read, and the final flush of BOTH volumes both
 * attempted and completed, and no flush request left unfinished (completed >= requested). The envelope has no field for the final flush,
 * so the only way to state it is to withhold the claim when it did not happen. Anything uncertain (reason NONE or unknown, no counters, a
 * missing final flush, completed < requested) withholds the claim and reports `fault vm_failed` plus the real counters; a process that ends
 * without the hook ever running reports nothing at all. */
bool cw_exit_report_halted(const cw_exit_report *report);

/* The VMM exit hook ran after the block devices' final flush. Reports `guest_halted` (with counters) and `exiting` on L2 only when
 * cw_exit_report_halted; otherwise `fault vm_failed` and `exiting`. Callable from the VMM thread. */
void cw_relay_vmm_exit(cw_relay *relay, const cw_exit_report *report);
/* Queue a liveness ping toward the guest (not used by the worker's own loop; the guest answers with pong). 0 or -1. */
int cw_relay_ping(cw_relay *relay, uint32_t n);

#endif
