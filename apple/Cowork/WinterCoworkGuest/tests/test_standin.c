/*
 * Native tests of the stand-in lifecycle decisions (init/standin.c) against a recording fake. One `PASS name` / `FAIL name: why` line per test; non-zero exit on any failure.
 * Driven by test_standin.py; not part of the guest image.
 */
#define _GNU_SOURCE
#include "../init/standin.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures, current_failed;
static const char *current_name;
static void fail(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (!current_failed) printf("FAIL %s: ", current_name); else printf("      ");
    vprintf(fmt, args);
    printf("\n");
    va_end(args);
    current_failed = 1;
}
#define CHECK(cond) do { if (!(cond)) fail("%s (line %d)", #cond, __LINE__); } while (0)

/* ------------------------------------------------------------------------------------------------ the recording fake */
struct fake {
    long long now;
    char log[32][48];
    int logs;
    int prepare_result, listener_result, start_result;
    int runtime_results[8], runtime_calls, runtime_count;   /* what find_runtime returns, in order; the last repeats */
    int prepares, binds, starts, stops, closes;
    int closed[16];
    long started_worker, stopped_worker;
    int started_listener, started_pidfd;
    char prepared_sid[WG_SESSION_ID_MAX + 1];
    uint32_t prepared_uid;
    char prepared_items[256];
};
static struct fake F;

static long long f_now(void *ctx) { (void)ctx; return F.now; }
static void f_log(void *ctx, const char *code) { (void)ctx; if (F.logs < 32) snprintf(F.log[F.logs++], sizeof F.log[0], "%s", code); }
static int f_prepare(void *ctx, const char *sid, uint32_t uid, const char *items, size_t length) {
    (void)ctx; F.prepares++;
    snprintf(F.prepared_sid, sizeof F.prepared_sid, "%s", sid);
    F.prepared_uid = uid;
    snprintf(F.prepared_items, sizeof F.prepared_items, "%.*s", (int)(length < 255 ? length : 255), items);
    return F.prepare_result;
}
static int f_bind(void *ctx, const char *sid, uint32_t uid) { (void)ctx; (void)sid; (void)uid; F.binds++; return F.listener_result; }
static int f_find(void *ctx, uint32_t uid) {
    (void)ctx; (void)uid;
    int index = F.runtime_calls < F.runtime_count ? F.runtime_calls : F.runtime_count - 1;
    F.runtime_calls++;
    return F.runtime_results[index];
}
static int f_start(void *ctx, const char *sid, uint32_t uid, int listener, int pidfd, long *worker) {
    (void)ctx; (void)sid; (void)uid;
    F.starts++; F.started_listener = listener; F.started_pidfd = pidfd;
    if (F.start_result != 0) return F.start_result;
    *worker = 4242; F.started_worker = 4242;
    return 0;
}
static void f_stop(void *ctx, long worker) { (void)ctx; F.stops++; F.stopped_worker = worker; }
static void f_close(void *ctx, int fd) { (void)ctx; if (F.closes < 16) F.closed[F.closes] = fd; F.closes++; }
static const struct wg_standin_ops OPS = { NULL, f_now, f_log, f_prepare, f_bind, f_find, f_start, f_stop, f_close };

static int closed_has(int fd) { for (int i = 0; i < F.closes && i < 16; i++) if (F.closed[i] == fd) return 1; return 0; }
static int logged(const char *code) { for (int i = 0; i < F.logs; i++) if (!strcmp(F.log[i], code)) return 1; return 0; }

static struct wg_conversation_set make_set(unsigned profile, unsigned count) {
    static const char JSON[] = "[{\"logicalSessionId\":\"session_a\"}]";
    struct wg_conversation_set set;
    memset(&set, 0, sizeof set);
    set.profile = profile; set.count = count;
    set.runtime_uid[0] = 4242;
    snprintf(set.session_id[0], sizeof set.session_id[0], "%s", "session_a");
    set.json = JSON; set.json_length = sizeof JSON - 1;
    return set;
}

static struct wg_standin S;
static void reset(void) {
    memset(&F, 0, sizeof F);
    F.listener_result = 7; F.runtime_count = 1; F.runtime_results[0] = 0;
    wg_standin_init(&S, &OPS);
}
static void begin(const char *name) { current_name = name; current_failed = 0; reset(); }
static void end(void) { if (current_failed) failures++; else printf("PASS %s\n", current_name); }
static void ready_set(void) { struct wg_conversation_set set = make_set(1, 1); CHECK(wg_standin_note_set(&S, &set) == 0); wg_standin_supervisor_ready(&S); }

/* ------------------------------------------------------------------------------------------------ the tests */

static void test_a_ready_supervisor_prepares_binds_and_waits(void) {
    begin(__func__);
    ready_set();
    CHECK(S.state == WG_SI_LISTENING);
    CHECK(F.prepares == 1 && F.binds == 1 && F.starts == 0);
    CHECK(!strcmp(F.prepared_sid, "session_a") && F.prepared_uid == 4242);
    CHECK(!strcmp(F.prepared_items, "[{\"logicalSessionId\":\"session_a\"}]"));
    CHECK(logged("standin-listening"));
    CHECK(wg_standin_poll_hint(&S) == WG_STANDIN_TICK_MS);
    end();
}

static void test_the_copy_of_the_set_does_not_depend_on_the_callers_memory(void) {
    begin(__func__);
    struct wg_conversation_set set = make_set(1, 1);
    char json[64];
    snprintf(json, sizeof json, "%s", set.json);
    set.json = json;
    CHECK(wg_standin_note_set(&S, &set) == 0);
    memset(json, 'x', sizeof json - 1);
    memset(&set, 0, sizeof set);
    wg_standin_supervisor_ready(&S);
    CHECK(!strcmp(F.prepared_items, "[{\"logicalSessionId\":\"session_a\"}]") && !strcmp(F.prepared_sid, "session_a") && F.prepared_uid == 4242);
    end();
}

static void test_the_worker_starts_only_when_the_runtime_is_found_and_both_descriptors_are_released(void) {
    begin(__func__);
    F.runtime_count = 3; F.runtime_results[0] = 0; F.runtime_results[1] = 0; F.runtime_results[2] = 9;
    ready_set();
    wg_standin_tick(&S); wg_standin_tick(&S);
    CHECK(F.starts == 0 && S.state == WG_SI_LISTENING);
    wg_standin_tick(&S);
    CHECK(F.starts == 1 && S.state == WG_SI_RUNNING && S.worker == 4242);
    CHECK(F.started_listener == 7 && F.started_pidfd == 9);
    CHECK(closed_has(9) && closed_has(7));            /* PID 1 keeps neither the runtime's pidfd nor the listener */
    CHECK(S.listener_fd == -1 && wg_standin_poll_hint(&S) == -1);
    CHECK(logged("standin-worker-started"));
    end();
}

static void test_once_running_a_tick_never_starts_a_second_worker(void) {
    begin(__func__);
    F.runtime_results[0] = 9;
    ready_set();
    wg_standin_tick(&S);
    for (int i = 0; i < 5; i++) wg_standin_tick(&S);
    CHECK(F.starts == 1 && F.runtime_calls == 1);
    end();
}

static void test_a_worker_that_exits_is_not_restarted_because_that_would_reset_the_two_answer_budget(void) {
    begin(__func__);
    F.runtime_results[0] = 9;
    ready_set();
    wg_standin_tick(&S);
    wg_standin_child_exited(&S, 1);                   /* some other child */
    CHECK(S.state == WG_SI_RUNNING);
    wg_standin_child_exited(&S, 4242);
    CHECK(S.state == WG_SI_FAILED && logged("standin-worker-exited"));
    for (int i = 0; i < 5; i++) wg_standin_tick(&S);
    CHECK(F.starts == 1);
    end();
}

static void test_the_runtime_not_appearing_in_time_fails_closed_and_closes_the_listener(void) {
    begin(__func__);
    ready_set();
    F.now = WG_STANDIN_LOCATE_MS - 1;
    wg_standin_tick(&S);
    CHECK(S.state == WG_SI_LISTENING);
    F.now = WG_STANDIN_LOCATE_MS;
    wg_standin_tick(&S);
    CHECK(S.state == WG_SI_FAILED && logged("standin-runtime-not-found") && closed_has(7) && F.starts == 0);
    end();
}

static void test_an_ambiguous_runtime_is_refused_without_starting_anything(void) {
    begin(__func__);
    F.runtime_results[0] = -1;
    ready_set();
    wg_standin_tick(&S);
    CHECK(S.state == WG_SI_FAILED && logged("standin-runtime-refused") && closed_has(7) && F.starts == 0);
    end();
}

static void test_a_worker_that_does_not_start_closes_everything_it_was_given(void) {
    begin(__func__);
    F.runtime_results[0] = 9; F.start_result = -1;
    ready_set();
    wg_standin_tick(&S);
    CHECK(S.state == WG_SI_FAILED && logged("standin-worker-failed") && closed_has(9) && closed_has(7) && F.stops == 0);
    end();
}

static void test_a_prepare_failure_creates_no_listener(void) {
    begin(__func__);
    F.prepare_result = -1;
    ready_set();
    CHECK(S.state == WG_SI_FAILED && logged("standin-prepare-failed") && F.binds == 0);
    end();
}

static void test_a_listener_failure_is_a_failure_not_a_wait(void) {
    begin(__func__);
    F.listener_result = -1;
    ready_set();
    CHECK(S.state == WG_SI_FAILED && logged("standin-listener-failed") && F.runtime_calls == 0);
    wg_standin_tick(&S);
    CHECK(F.runtime_calls == 0);
    end();
}

static void test_a_listener_descriptor_below_three_is_refused(void) {
    begin(__func__);
    F.listener_result = 2;
    ready_set();
    CHECK(S.state == WG_SI_FAILED && logged("standin-listener-failed"));
    end();
}

static void test_only_one_host_query_conversation_is_served(void) {
    begin(__func__);
    unsigned profiles[] = { 0, 2, 3 };
    for (int i = 0; i < 3; i++) {
        reset();
        struct wg_conversation_set set = make_set(profiles[i], 1);
        wg_standin_note_set(&S, &set);
        wg_standin_supervisor_ready(&S);
        CHECK(S.state == WG_SI_FAILED && logged("standin-unsupported-set") && F.prepares == 0 && F.binds == 0);
    }
    reset();
    struct wg_conversation_set two = make_set(1, 2);
    CHECK(wg_standin_note_set(&S, &two) != 0);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0 && F.binds == 0);
    end();
}

static void test_a_ready_without_a_noted_set_serves_nothing(void) {
    begin(__func__);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0 && F.binds == 0);
    end();
}

static void test_oversized_or_empty_items_are_not_kept(void) {
    begin(__func__);
    static char big[WG_STANDIN_ITEMS_MAX + 2];
    memset(big, 'a', sizeof big);
    struct wg_conversation_set set = make_set(1, 1);
    set.json = big; set.json_length = WG_STANDIN_ITEMS_MAX + 1;
    CHECK(wg_standin_note_set(&S, &set) != 0);
    set.json_length = 1;
    CHECK(wg_standin_note_set(&S, &set) != 0);
    set.json_length = WG_STANDIN_ITEMS_MAX;
    CHECK(wg_standin_note_set(&S, &set) == 0);
    /* a refused set after an accepted one must not leave the accepted one to be served */
    reset();
    struct wg_conversation_set good = make_set(1, 1);
    CHECK(wg_standin_note_set(&S, &good) == 0);
    set.json_length = WG_STANDIN_ITEMS_MAX + 1;
    CHECK(wg_standin_note_set(&S, &set) != 0);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0 && F.binds == 0);
    /* a set that was refused must not be served either, even though its profile and count were seen */
    reset();
    set.json_length = WG_STANDIN_ITEMS_MAX + 1;
    CHECK(wg_standin_note_set(&S, &set) != 0);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0 && F.binds == 0);
    reset();
    set.json_length = 1;
    CHECK(wg_standin_note_set(&S, &set) != 0);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0 && F.binds == 0);
    end();
}

static void test_an_empty_session_id_is_not_kept(void) {
    begin(__func__);
    struct wg_conversation_set set = make_set(1, 1);
    set.session_id[0][0] = '\0';
    CHECK(wg_standin_note_set(&S, &set) != 0);
    wg_standin_supervisor_ready(&S);
    CHECK(S.state == WG_SI_FAILED && F.prepares == 0);
    end();
}

static void test_a_second_ready_does_nothing(void) {
    begin(__func__);
    ready_set();
    wg_standin_supervisor_ready(&S);
    CHECK(F.prepares == 1 && F.binds == 1);
    end();
}

static void test_stop_in_every_state_releases_what_is_held_and_is_idempotent(void) {
    begin(__func__);
    ready_set();
    wg_standin_stop(&S);
    CHECK(S.state == WG_SI_STOPPED && closed_has(7) && F.stops == 0);
    int closes = F.closes;
    wg_standin_stop(&S);
    CHECK(F.closes == closes && F.stops == 0);
    reset();
    F.runtime_results[0] = 9;
    ready_set();
    wg_standin_tick(&S);
    wg_standin_stop(&S);
    CHECK(S.state == WG_SI_STOPPED && F.stops == 1 && F.stopped_worker == 4242);
    wg_standin_stop(&S);
    CHECK(F.stops == 1);
    wg_standin_tick(&S);
    CHECK(S.state == WG_SI_STOPPED && F.starts == 1);
    reset();
    wg_standin_stop(&S);
    CHECK(S.state == WG_SI_STOPPED && F.closes == 0);
    end();
}

static void test_a_stopped_module_never_starts_a_worker_afterwards(void) {
    begin(__func__);
    F.runtime_results[0] = 9;
    ready_set();
    wg_standin_stop(&S);
    wg_standin_tick(&S);
    wg_standin_supervisor_ready(&S);
    CHECK(F.starts == 0 && S.state == WG_SI_STOPPED);
    end();
}

int main(void) {
    test_a_ready_supervisor_prepares_binds_and_waits();
    test_the_copy_of_the_set_does_not_depend_on_the_callers_memory();
    test_the_worker_starts_only_when_the_runtime_is_found_and_both_descriptors_are_released();
    test_once_running_a_tick_never_starts_a_second_worker();
    test_a_worker_that_exits_is_not_restarted_because_that_would_reset_the_two_answer_budget();
    test_the_runtime_not_appearing_in_time_fails_closed_and_closes_the_listener();
    test_an_ambiguous_runtime_is_refused_without_starting_anything();
    test_a_worker_that_does_not_start_closes_everything_it_was_given();
    test_a_prepare_failure_creates_no_listener();
    test_a_listener_failure_is_a_failure_not_a_wait();
    test_a_listener_descriptor_below_three_is_refused();
    test_only_one_host_query_conversation_is_served();
    test_a_ready_without_a_noted_set_serves_nothing();
    test_oversized_or_empty_items_are_not_kept();
    test_an_empty_session_id_is_not_kept();
    test_a_second_ready_does_nothing();
    test_stop_in_every_state_releases_what_is_held_and_is_idempotent();
    test_a_stopped_module_never_starts_a_worker_afterwards();
    return failures ? 1 : 0;
}
