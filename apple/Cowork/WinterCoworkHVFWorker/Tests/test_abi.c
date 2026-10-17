/* The ABI glue, with S4's real header and NO library: the translation from what libkrun reports (exit reason, flush counters) into the
 * worker's own record, and the decision made on it. Compiled with -isystem <libkrun include dir>; links no archive. */
#include "CoworkAbi.h"
#include "test_support.h"

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
    CHECK(cw_exit_report_halted(&r));
}

static void limits(void) {
    CHECK(CW_GATE_VCPUS == 2 && CW_GATE_MIN_MEMORY_MIB == 768 && CW_GATE_MAX_MEMORY_MIB == 1024);
    CHECK(CW_SCOPE_MIN_MEMORY_MIB == CW_GATE_MIN_MEMORY_MIB && CW_SCOPE_MAX_MEMORY_MIB == CW_GATE_MAX_MEMORY_MIB);
    CHECK(CW_ABI_FLUSH_EVIDENCE == 1);
}

/* The hook the worker registers has the library's type; a function of any other signature is refused at compile time by
 * CW_ASSERT_EXIT_HOOK_SIGNATURE and by the call (see Tests/abi/ and build.py, which compile a deliberately wrong hook and require failure). */
static void accepted_hook(void *user, uint32_t reason) { (void)user; (void)reason; }
CW_ASSERT_EXIT_HOOK_SIGNATURE(accepted_hook);

int main(void) {
    reasons();
    counters();
    limits();
    krun_cowork_exit_hook_v1 typed = accepted_hook;
    CHECK(typed != NULL);
    return cw_test_finish("test_abi");
}
