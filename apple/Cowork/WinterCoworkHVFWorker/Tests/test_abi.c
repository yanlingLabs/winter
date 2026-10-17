/* The ABI glue, with S4's real header and NO library: the translation from what libkrun reports (exit reason, flush counters) into the
 * worker's own record, and the decision made on it. Compiled with -isystem <libkrun include dir>; links no archive. */
#include "CoworkAbi.h"
#include "test_support.h"
#include "vectors.h"

static struct krun_cowork_flush_counters_v1 healthy(void) {
    struct krun_cowork_flush_counters_v1 c;
    memset(&c, 0, sizeof c);
    c.size = (uint32_t)sizeof c;
    c.device_count = 2;
    c.device[0] = (struct krun_cowork_flush_device_v1){ 41, 41, 1, 1 };
    c.device[1] = (struct krun_cowork_flush_device_v1){ 7, 7, 1, 1 };
    return c;
}

static void reasons(void) {
    struct krun_cowork_flush_counters_v1 c = healthy();
    cw_exit_report r;
    /* Only the header's OFF is off. Reset, vcpu error, terminal fault, "none" and unknown values are not, whatever their numbers are. */
    const struct { uint32_t reason; bool off; } cases[] = {
        { KRUN_COWORK_EXIT_OFF, true }, { KRUN_COWORK_EXIT_RESET, false }, { KRUN_COWORK_EXIT_VCPU_ERROR, false }, { KRUN_COWORK_EXIT_TERMINAL_FAULT, false },
        { KRUN_COWORK_EXIT_NONE, false }, { 99, false }, { 0xffffffffu, false } };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        cw_exit_report_from_library(cases[i].reason, 0, &c, &r);
        CHECK(r.reason_off == cases[i].off);
        CHECK(cw_exit_report_halted(&r) == cases[i].off);
    }
    /* The contract's own numbering (off=0 reset=1 vcpu-error=2 terminal-fault=3) must NOT be mistaken for the library's: reason 0 is NONE here. */
    cw_exit_report_from_library(0, 0, &c, &r);
    CHECK(!r.reason_off && !cw_exit_report_halted(&r));
    CHECK(KRUN_COWORK_EXIT_OFF != 0);
}

static void counters(void) {
    struct krun_cowork_flush_counters_v1 c = healthy();
    cw_exit_report r;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(r.counters_valid && r.requested[0] == 41 && r.completed[0] == 41 && r.requested[1] == 7 && r.completed[1] == 7);
    CHECK(r.final_attempted[0] == 1 && r.final_completed[0] == 1 && r.final_attempted[1] == 1 && r.final_completed[1] == 1);
    CHECK(cw_exit_report_halted(&r));
    /* data and environment are not swapped */
    c.device[0].requested = 100; c.device[1].requested = 200; c.device[0].completed = 101; c.device[1].completed = 202;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(r.requested[0] == 100 && r.requested[1] == 200 && r.completed[0] == 101 && r.completed[1] == 202);
    /* The call failed, or the structure came back with another size or device count: no counters, no claim. */
    c = healthy();
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, -22, &c, &r);
    CHECK(!r.counters_valid && !cw_exit_report_halted(&r));
    c = healthy(); c.size -= 4;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!r.counters_valid && !cw_exit_report_halted(&r));
    c = healthy(); c.device_count = 1;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!r.counters_valid);
    c = healthy(); c.device_count = 3;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!r.counters_valid);
    /* The final flush of EITHER volume missing withholds the claim; unequal counts do not (the launcher judges those). */
    c = healthy(); c.device[1].final_sync_completed = 0;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(r.counters_valid && !cw_exit_report_halted(&r));
    c = healthy(); c.device[0].final_sync_attempted = 0;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!cw_exit_report_halted(&r));
    c = healthy(); c.device[0].final_sync_completed = 2;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!cw_exit_report_halted(&r));
    c = healthy(); c.device[0].completed = 40;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!cw_exit_report_halted(&r) && r.counters_valid && r.requested[0] == 41 && r.completed[0] == 40); /* completed < requested: uncertain */
    c = healthy(); c.device[1].completed = 9;
    cw_exit_report_from_library(KRUN_COWORK_EXIT_OFF, 0, &c, &r);
    CHECK(!cw_exit_report_halted(&r) && r.completed[1] == 9);    /* completed ABOVE requested cannot be believed either */
}

static void limits(void) {
    CHECK(CW_GATE_VCPUS == 2 && CW_GATE_MIN_MEMORY_MIB == 768 && CW_GATE_MAX_MEMORY_MIB == 1024);
    CHECK(CW_SCOPE_MIN_MEMORY_MIB == CW_GATE_MIN_MEMORY_MIB && CW_SCOPE_MAX_MEMORY_MIB == CW_GATE_MAX_MEMORY_MIB);
    CHECK(CW_ABI_FLUSH_EVIDENCE == 1);
}

/* S1's guest-stop.json (round 3). The vectors give the order of the L2 statuses the launcher saw, the exit reason and the counters, and the launcher's verdict.
 * The worker's part is narrower: whether `guest_halted` may be among them. Two properties tie the files together:
 *   1. the numbers the file calls none/off/reset/vcpu-error/terminal-fault are the header's constants (so the contract and the library cannot drift apart);
 *   2. wherever the contract's verdict is ORDERLY (the only case that can lead to a Class A), the worker's own decision says halted; and wherever the worker's
 *      decision says not halted, the verdict is never orderly, whatever the statuses in the file claim. */
static void stop_vectors_drift(void) {
    CHECK(stop_reason_none == KRUN_COWORK_EXIT_NONE && stop_reason_off == KRUN_COWORK_EXIT_OFF && stop_reason_reset == KRUN_COWORK_EXIT_RESET
          && stop_reason_vcpu_error == KRUN_COWORK_EXIT_VCPU_ERROR && stop_reason_terminal_fault == KRUN_COWORK_EXIT_TERMINAL_FAULT);
    CHECK(STOP_VECTOR_COUNT == 23);
    unsigned orderly = 0, withheld = 0;
    for (size_t i = 0; i < STOP_VECTOR_COUNT; i++) {
        const cw_stop_vector *v = &stop_vectors[i];
        struct krun_cowork_flush_counters_v1 counters;
        memset(&counters, 0, sizeof counters);
        counters.size = (uint32_t)sizeof counters;
        counters.device_count = 2;
        for (int disk = 0; disk < 2; disk++)
            counters.device[disk] = (struct krun_cowork_flush_device_v1){ v->counters[disk][0], v->counters[disk][1], v->counters[disk][2], v->counters[disk][3] };
        cw_exit_report report;
        if (v->reason < 0) memset(&report, 0, sizeof report); /* the hook never ran: there is no report at all, and the relay is never asked */
        else cw_exit_report_from_library((uint32_t)v->reason, v->counters_valid ? 0 : -22, &counters, &report);
        bool halted = v->reason >= 0 && cw_exit_report_halted(&report);
        bool is_orderly = strstr(v->states, "halting") != NULL && v->halting && v->halted && !v->guest_fault && strcmp(v->name, "orderly") == 0;
        if (is_orderly) { orderly++; CHECK(halted); }
        if (!halted) { withheld++; CHECK(strcmp(v->name, "orderly") != 0); }
        /* the cases that are not orderly because of the exit hook alone */
        if (strcmp(v->name, "reset-instead-of-off") == 0 || strcmp(v->name, "vcpu-error") == 0 || strcmp(v->name, "terminal-fault") == 0 || strcmp(v->name, "reason-none") == 0
            || strcmp(v->name, "no-reason-delivered") == 0 || strcmp(v->name, "flush-requested-never-completed") == 0 || strcmp(v->name, "final-sync-failed-exit-status-unchanged") == 0
            || strcmp(v->name, "final-sync-never-attempted") == 0 || strcmp(v->name, "counters-unreadable") == 0)
            CHECK(!halted);
    }
    /* The two round 3 final vectors: the WORKER may send guest_halted after a mux quarantine or with no drain_ack (the hook knows nothing of either); it is the
     * launcher's drain rule that makes both Class B. So the worker's own decision for them is "halted", and the verdict file must not call them orderly. */
    unsigned launcher_rule = 0;
    for (size_t i = 0; i < STOP_VECTOR_COUNT; i++) {
        if (strcmp(stop_vectors[i].name, "guest-halted-after-mux-quarantine") != 0 && strcmp(stop_vectors[i].name, "guest-halted-without-drain-ack") != 0) continue;
        launcher_rule++;
        struct krun_cowork_flush_counters_v1 counters;
        memset(&counters, 0, sizeof counters);
        counters.size = (uint32_t)sizeof counters;
        counters.device_count = 2;
        for (int disk = 0; disk < 2; disk++)
            counters.device[disk] = (struct krun_cowork_flush_device_v1){ stop_vectors[i].counters[disk][0], stop_vectors[i].counters[disk][1], stop_vectors[i].counters[disk][2], stop_vectors[i].counters[disk][3] };
        cw_exit_report report;
        cw_exit_report_from_library((uint32_t)stop_vectors[i].reason, 0, &counters, &report);
        CHECK(cw_exit_report_halted(&report) && stop_vectors[i].halted);
    }
    CHECK(launcher_rule == 2);
    CHECK(orderly == 1 && withheld >= 9);
}

/* The hook the worker registers has the library's type; a function of any other signature is refused at compile time by
 * CW_ASSERT_EXIT_HOOK_SIGNATURE and by the call (see Tests/abi/ and build.py, which compile a deliberately wrong hook and require failure). */
static void accepted_hook(void *user, uint32_t reason) { (void)user; (void)reason; }
CW_ASSERT_EXIT_HOOK_SIGNATURE(accepted_hook);

int main(void) {
    reasons();
    counters();
    limits();
    stop_vectors_drift();
    krun_cowork_exit_hook_v1 typed = accepted_hook;
    CHECK(typed != NULL);
    return cw_test_finish("test_abi");
}
