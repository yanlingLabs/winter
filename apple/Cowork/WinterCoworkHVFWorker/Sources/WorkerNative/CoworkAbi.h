/* CoworkAbi.h: the ONE file that knows the libkrun production ABI as the linked archive really has it.
 *
 * Since S4's review round (PR #55, patch 0017, now through 0023, vendored in PR #62 at PR #62's libkrun queue directory under apple/Cowork) the library exports the contract's `_v1` names, and since contract
 * round 3 (S1 1313040a) the contract's ABI section is this header's own: nothing is mapped and nothing differs. The worker codes against the header
 * it links, and pins.json pins every declaration it relies on, so a header change stops the build.
 *
 *   exit hook      `void (*)(void *user_data, uint32_t reason)`; KRUN_COWORK_EXIT_NONE=0 OFF=1 RESET=2 VCPU_ERROR=3 TERMINAL_FAULT=4. The worker
 *                  uses the header's SYMBOLS, never a number. Only KRUN_COWORK_EXIT_OFF may ever lead to `guest_halted`.
 *   flush counters `get_flush_counters_v1(struct {size, device_count, device[2]{requested, completed, final_sync_attempted, final_sync_completed}} *)`:
 *                  process-global, no ctx_id, and it carries the FINAL flush the STATUS payload has no field for.
 *   pin counters   `krun_cowork_get_pin_counters_v1`: optional diagnostics (G4 reads it). Not called by the worker; it feeds no decision.
 *
 * What is UNCERTAIN, and therefore never `guest_halted` (a Class A candidate): reason NONE or any unknown value; reset, vcpu error and
 * terminal fault; no counters, or counters of another size or device count; a final flush not both attempted and completed on both
 * volumes; `completed < requested` on either volume. A hung observer after a clean off (libkrun exits 0 and the hook never runs) and a
 * crash signal (default disposition, no hook) leave NO hook observation at all: the worker reports nothing and the launcher, which sees
 * only the process exit, must treat it as uncertain.
 *
 * Call order (S4 and the contract agree): krun_create_ctx, the non-device setters, krun_cowork_enable_profile_v1,
 * krun_cowork_create_runtime_port_v1 (BEFORE the disks), krun_cowork_set_workspace_disks_v1, krun_cowork_set_exit_hook_v1,
 * krun_cowork_validate_profile_v1 (MANDATORY; a non-zero result starts no VM), krun_start_enter.
 *
 * The exit hook's signature is enforced twice: the compiler refuses to pass a function of another type to
 * krun_cowork_set_exit_hook_v1 (-Werror), and CW_ASSERT_EXIT_HOOK_SIGNATURE refuses it by name; Tests/abi/ proves both refuse a hook with
 * a different signature. C has no link-time type, so "refuse to link" is "refuse to compile".
 */
#ifndef WINTER_COWORK_WORKER_ABI_H
#define WINTER_COWORK_WORKER_ABI_H

#include "libkrun.h" /* from -isystem: S4's composed header (pinned by pins.json, derived from its committed patch queue) */

#include <stdint.h>
#include <string.h>

#include "Envelope.h"
#include "Relay.h"

#if !defined(KRUN_COWORK_PRODUCTION_VCPUS) || !defined(KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB) || !defined(KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB)
#error "libkrun.h does not declare the production profile limits: link S4's header (PR #62's libkrun queue directory under apple/Cowork, PR #62)"
#endif
#if !defined(KRUN_COWORK_EXIT_OFF) || !defined(KRUN_COWORK_EXIT_RESET) || !defined(KRUN_COWORK_EXIT_VCPU_ERROR) || !defined(KRUN_COWORK_EXIT_TERMINAL_FAULT)
#error "libkrun.h does not declare the exit reasons: link S4's header (PR #62's libkrun queue directory under apple/Cowork, PR #62)"
#endif

/* The flush evidence the Class A receipt needs is part of the library now. Always on; there is no fallback. */
#define CW_ABI_FLUSH_EVIDENCE 1

/* The gate the worker validates SCOPE against, and the equalities that make the parser's own bounds the library's. */
#define CW_GATE_VCPUS ((uint32_t)KRUN_COWORK_PRODUCTION_VCPUS)
#define CW_GATE_MIN_MEMORY_MIB ((uint32_t)KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB)
#define CW_GATE_MAX_MEMORY_MIB ((uint32_t)KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB)
_Static_assert(CW_VCPUS == KRUN_COWORK_PRODUCTION_VCPUS, "the S1 vCPU count equals the library gate");
_Static_assert(CW_SCOPE_MIN_MEMORY_MIB == KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB, "the S1 memory floor equals the library gate's");
_Static_assert(CW_SCOPE_MAX_MEMORY_MIB == KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB, "the S1 memory ceiling equals the library gate's");

/* The worker's identity record and the library's must have the same bytes. */
_Static_assert(sizeof(struct krun_cowork_volume_identity) == 32, "volume identity is 32 bytes");
_Static_assert(offsetof(struct krun_cowork_volume_identity, device) == 0 && offsetof(struct krun_cowork_volume_identity, inode) == 8
                   && offsetof(struct krun_cowork_volume_identity, capacity_bytes) == 16 && offsetof(struct krun_cowork_volume_identity, uid) == 24
                   && offsetof(struct krun_cowork_volume_identity, mode) == 28, "volume identity layout");
_Static_assert(sizeof(cw_volume_identity) == sizeof(struct krun_cowork_volume_identity), "cw_volume_identity matches the ABI struct");
_Static_assert(offsetof(cw_volume_identity, capacity_bytes) == offsetof(struct krun_cowork_volume_identity, capacity_bytes)
                   && offsetof(cw_volume_identity, uid) == offsetof(struct krun_cowork_volume_identity, uid)
                   && offsetof(cw_volume_identity, mode) == offsetof(struct krun_cowork_volume_identity, mode), "cw_volume_identity layout");

/* The reasons the worker tells apart must be distinct, and "off" must not be the "unknown" value. */
_Static_assert(KRUN_COWORK_EXIT_OFF != KRUN_COWORK_EXIT_RESET && KRUN_COWORK_EXIT_OFF != KRUN_COWORK_EXIT_VCPU_ERROR
                   && KRUN_COWORK_EXIT_OFF != KRUN_COWORK_EXIT_TERMINAL_FAULT && KRUN_COWORK_EXIT_OFF != KRUN_COWORK_EXIT_NONE, "exit reasons are distinct");

/* The hook the worker registers must have EXACTLY the library's type. */
#define CW_ASSERT_EXIT_HOOK_SIGNATURE(function) \
    _Static_assert(_Generic(&(function), krun_cowork_exit_hook_v1: 1, default: 0), "the exit hook's signature differs from the library's krun_cowork_exit_hook_v1")

/* The flush-counter structure the library fills in (always asked for with `size` set). */
static inline int32_t cw_read_flush_counters(struct krun_cowork_flush_counters_v1 *out) {
    memset(out, 0, sizeof *out);
    out->size = (uint32_t)sizeof *out;
    return krun_cowork_get_flush_counters_v1(out);
}

/* Translate what the library reported into the worker's own, library-free record; the decision about it is made in Relay.c. A reason
 * is "off" only when it equals the header's KRUN_COWORK_EXIT_OFF; reset, vcpu error, terminal fault, NONE and anything unknown are not.
 * Counters are valid only when the call succeeded and the structure came back with the size and device count the worker expects. */
static inline void cw_exit_report_from_library(uint32_t reason, int32_t counters_result, const struct krun_cowork_flush_counters_v1 *counters, cw_exit_report *out) {
    memset(out, 0, sizeof *out);
    out->reason_off = reason == (uint32_t)KRUN_COWORK_EXIT_OFF;
    if (counters_result != 0 || counters->size != sizeof *counters || counters->device_count != 2) return;
    out->counters_valid = true;
    for (int disk = 0; disk < 2; disk++) {
        out->requested[disk] = counters->device[disk].requested;
        out->completed[disk] = counters->device[disk].completed;
        out->final_attempted[disk] = counters->device[disk].final_sync_attempted;
        out->final_completed[disk] = counters->device[disk].final_sync_completed;
    }
}

#endif
