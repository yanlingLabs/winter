/*
 * Native tests of PID 1's decision logic: the boot / drain state machine (init/boot.c) and the mount policy (init/mounts.c)
 * against a recording fake. Prints one `PASS name` / `FAIL name: why` line per test and exits non-zero on any failure.
 * Driven by test_init_modules.py; not part of the guest image.
 */
#define _GNU_SOURCE
#include "../common/ctl.h"
#include "../common/wmx.h"
#include "../init/boot.h"
#include "../init/ext4sb.h"
#include "../init/mounts.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NONCE "0123456789abcdef0123456789abcdef"
#define UUID_DATA "11111111-2222-4333-8444-555555555555"
#define UUID_ENV "66666666-7777-4888-8999-aaaaaaaaaaaa"

static int failures, current_failed;
static const char *current_name;
static void fail(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (!current_failed) printf("FAIL %s: ", current_name);
    else printf("      ");
    vprintf(fmt, args);
    printf("\n");
    va_end(args);
    current_failed = 1;
}
#define CHECK(cond) do { if (!(cond)) fail("%s (line %d)", #cond, __LINE__); } while (0)

/* ------------------------------------------------------------------------------------------------ the recording fake */

struct fake {
    char events[256][96];
    int count;
    long long now;
    int replay_rc, mount_rc, mount_leftover, umount_data_rc, umount_env_rc, umount_data_failures_left, umount_replay_failures_left, verify_rc[2];
    int conversations_rc;           /* 0 present, 1 absent, -1 unusable */
    const char *conversations;
    const char *base;
    int base_rc, boot_id_rc, supervisor_rc, wait_flushed_rc;
    char last_config[70000];
    char to_helper_tag[32];
    int to_helper_count;
    uint8_t to_helper_byte;
};

static void ev(struct fake *f, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (f->count < 256) vsnprintf(f->events[f->count++], sizeof f->events[0], fmt, args);
    va_end(args);
}
static int has(struct fake *f, const char *text) {
    for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return 1;
    return 0;
}
static int index_of(struct fake *f, const char *text) {
    for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return i;
    return -1;
}
static int starts(struct fake *f, const char *prefix) {
    for (int i = 0; i < f->count; i++) if (strncmp(f->events[i], prefix, strlen(prefix)) == 0) return 1;
    return 0;
}

static long long f_now(void *c) { return ((struct fake *)c)->now; }
static void f_pause(void *c, unsigned ms) { ((struct fake *)c)->now += ms; ev(c, "pause"); }
static void f_log(void *c, const char *code) { ev(c, "log:%s", code); }
static void f_to_relay(void *c, uint8_t tag, const void *p, size_t n) {
    (void)p;
    if (tag == CTL_BOOTSTRAP_UP) ev(c, "relay:U:%zu", n);
    else if (tag == CTL_RUNTIME_GO) ev(c, "relay:G");
    else if (tag == CTL_DRAIN_ACK || tag == CTL_HALTING) ev(c, "relay:%c:%.*s", tag == CTL_DRAIN_ACK ? 'K' : 'H', (int)n, (const char *)p);
    else ev(c, "relay:%c", tag);
}
static void f_to_helper(void *c, uint8_t tag, const void *p, size_t n) {
    struct fake *f = c;
    if (tag == CTL_REPLAY_RESULT || tag == CTL_MOUNT_RESULT) { f->to_helper_byte = ((const uint8_t *)p)[0]; ev(c, "helper:%c:%u", tag, (unsigned)f->to_helper_byte); }
    else ev(c, "helper:%c:%zu", tag, n);
}
static int f_wait_flushed(void *c, unsigned ms) { ev(c, "wait-flushed:%u", ms); return ((struct fake *)c)->wait_flushed_rc; }
static int f_replay(void *c, const char *purpose) { ev(c, "replay:%s", purpose); return ((struct fake *)c)->replay_rc; }
static int f_umount_replay(void *c, const char *purpose) {
    struct fake *f = c;
    ev(c, "umount-replay:%s", purpose);
    if (f->umount_replay_failures_left > 0) { f->umount_replay_failures_left--; return -1; }
    return 0;
}
static int f_verify(void *c, int volume, const uint8_t *uuid) {
    struct fake *f = c;
    ev(c, "verify:%s:%02x", volume == WG_VOLUME_DATA ? "data" : "env", uuid[0]);
    return f->verify_rc[volume];
}
static int f_mount(void *c, const uint8_t *d, const uint8_t *e, int *leftover) { (void)d; (void)e; ev(c, "mount-volumes"); *leftover = ((struct fake *)c)->mount_leftover; return ((struct fake *)c)->mount_rc; }
static int f_umount(void *c, int volume) {
    struct fake *f = c;
    ev(c, "umount:%s", volume == WG_VOLUME_DATA ? "data" : "env");
    if (volume == WG_VOLUME_DATA) {
        if (f->umount_data_failures_left > 0) { f->umount_data_failures_left--; return -1; }
        return f->umount_data_rc;
    }
    return f->umount_env_rc;
}
static int f_read_conversations(void *c, char *out, size_t cap, size_t *len) {
    struct fake *f = c;
    ev(c, "read-conversations");
    if (f->conversations_rc != 0) return f->conversations_rc;
    snprintf(out, cap, "%s", f->conversations);
    *len = strlen(out);
    return 0;
}
static int f_read_base(void *c, char *out, size_t cap, size_t *len) {
    struct fake *f = c;
    ev(c, "read-base");
    if (f->base_rc) return f->base_rc;
    snprintf(out, cap, "%s", f->base);
    *len = strlen(out);
    return 0;
}
static int f_boot_id(void *c, char out[37]) { ev(c, "boot-id"); if (((struct fake *)c)->boot_id_rc) return -1; strcpy(out, "66666666-6666-4666-8666-666666666666"); return 0; }
static int f_start_supervisor(void *c, const char *config, size_t len) {
    struct fake *f = c;
    ev(c, "start-supervisor");
    snprintf(f->last_config, sizeof f->last_config, "%.*s", (int)len, config);
    return f->supervisor_rc;
}
static void f_stop_helper(void *c, long long deadline) { ev(c, "stop-helper:%lld", deadline - ((struct fake *)c)->now); }
static void f_stop_supervisor(void *c, long long deadline) { ev(c, "stop-supervisor:%lld", deadline - ((struct fake *)c)->now); }
static void f_kill_all(void *c) { ev(c, "kill-all"); }
static void f_sync(void *c) { ev(c, "sync"); }
static void f_power_off(void *c) { ev(c, "power-off"); }

static struct wg_boot_ops ops_for(struct fake *f) {
    struct wg_boot_ops ops = { f, f_now, f_pause, f_log, f_to_relay, f_to_helper, f_wait_flushed, f_replay, f_umount_replay, f_mount, f_umount, f_verify,
                               f_read_conversations, f_read_base, f_boot_id, f_start_supervisor, f_stop_helper, f_stop_supervisor, f_kill_all, f_sync, f_power_off };
    return ops;
}
static void fresh(struct fake *f) {
    memset(f, 0, sizeof *f);
    f->conversations_rc = 1;
    f->conversations = "[]";
    f->base = "{\"artifacts\":{}}";
    f->wait_flushed_rc = 1;
}

static void drain_payload(uint8_t out[CTL_DRAIN_PAYLOAD_BYTES], const char *nonce, uint32_t budget, uint8_t origin) {
    memcpy(out, nonce, 32);
    out[32] = (uint8_t)budget; out[33] = (uint8_t)(budget >> 8); out[34] = (uint8_t)(budget >> 16); out[35] = (uint8_t)(budget >> 24);
    out[36] = origin;
}
static const char MOUNT_PAYLOAD[] = UUID_DATA " " UUID_ENV;

/* drive the happy path up to a given point */
static void to_mounted(struct wg_boot *boot) {
    wg_boot_helper_message(boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_message(boot, CTL_HELPER_DONE, NULL, 0);
}

static void drain(struct wg_boot *boot, const char *nonce, uint32_t budget);

/* ------------------------------------------------------------------------------------------------ boot tests */

static void test_bootstrap_payloads_flow_both_ways(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_relay_message(&boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)"abc", 3);
    CHECK(has(&f, "helper:b:3"));
    wg_boot_helper_message(&boot, CTL_HELPER_UP, (const uint8_t *)"hello", 5);
    CHECK(has(&f, "relay:U:5"));
}

static void test_a_bootstrap_payload_with_no_helper_is_dropped(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_exited(&boot, 1);
    wg_boot_relay_message(&boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)"x", 1);
    CHECK(!starts(&f, "helper:b"));
    CHECK(has(&f, "log:bootstrap-payload-dropped"));
}

static void test_replay_is_allowed_before_the_mount_for_known_purposes_only(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    CHECK(has(&f, "replay:data") && has(&f, "helper:q:1"));
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"environment", 11);
    CHECK(has(&f, "replay:environment"));
    f.replay_rc = -1;
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    CHECK(has(&f, "helper:q:0") && has(&f, "log:replay-failed"));
    CHECK(boot.phase == WG_PHASE_BOOTSTRAP);
}

static void test_replay_for_an_unknown_purpose_stops_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"../etc", 6);
    CHECK(!starts(&f, "replay:"));
    CHECK(has(&f, "log:replay-purpose") && has(&f, "power-off"));
}

static void test_replay_after_the_mount_request_stops_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    CHECK(!starts(&f, "replay:"));
    CHECK(has(&f, "log:replay-out-of-order"));
}

static void test_the_mount_happens_once_on_request_and_is_reported_to_the_helper(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "mount-volumes") && has(&f, "helper:m:1"));
    CHECK(boot.data_mounted && boot.environment_mounted);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "log:mount-out-of-order") && has(&f, "power-off"));
}

static void test_a_failed_mount_is_reported_and_leaves_nothing_mounted(void) {
    struct fake f; fresh(&f);
    f.mount_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "helper:m:0") && has(&f, "log:mount-failed"));
    CHECK(!boot.data_mounted && !boot.environment_mounted);
    CHECK(!has(&f, "power-off"));   /* stays up: the host may still drain */
}

static void test_a_malformed_mount_payload_stops_the_guest_without_mounting(void) {
    const char *bad[] = { "short", UUID_DATA "-" UUID_ENV, UUID_DATA " " "ZZZZZZZZ-7777-4888-8999-aaaaaaaaaaaa", UUID_DATA " " UUID_ENV " " };
    size_t lens[] = { 5, 73, 73, 74 };
    for (int i = 0; i < 4; i++) {
        struct fake f; fresh(&f);
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)bad[i], lens[i]);
        CHECK(!has(&f, "mount-volumes"));
        CHECK(has(&f, "log:mount-payload"));
    }
}

static void test_done_without_a_mount_stops_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_DONE, NULL, 0);
    CHECK(has(&f, "log:done-out-of-order") && has(&f, "power-off"));
}

static void test_unknown_helper_and_relay_messages_stop_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, 'Z', NULL, 0);
    CHECK(has(&f, "log:helper-message") && has(&f, "power-off"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    wg_boot_relay_message(&boot, 'Z', NULL, 0);
    CHECK(has(&f, "log:relay-message") && has(&f, "power-off"));
}

static void test_a_relay_fatal_stops_the_guest_without_any_frame(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    uint8_t status = 5;
    wg_boot_relay_message(&boot, CTL_RELAY_FATAL, &status, 1);
    CHECK(has(&f, "log:relay-fatal-5") && has(&f, "power-off"));
    CHECK(!starts(&f, "relay:"));
}

static void test_the_supervisor_does_not_start_without_a_conversation_set(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(boot.phase == WG_PHASE_MOUNTED);
    CHECK(!has(&f, "start-supervisor"));
    CHECK(has(&f, "log:supervisor-not-started:no-conversation-set"));
    CHECK(!has(&f, "power-off"));
}

static void test_with_a_conversation_set_the_supervisor_starts_with_the_live_boot_id(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    f.conversations = "[{\"logicalSessionId\":\"s1\"}]";
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "start-supervisor"));
    CHECK(strstr(f.last_config, "\"guestBootId\":\"66666666-6666-4666-8666-666666666666\"") != NULL);
    CHECK(strstr(f.last_config, "\"conversations\":[{\"logicalSessionId\":\"s1\"}]") != NULL);
    CHECK(strstr(f.last_config, "\"artifacts\":{}") != NULL);
    CHECK(index_of(&f, "mount-volumes") < index_of(&f, "start-supervisor"));
    wg_boot_supervisor_ready(&boot);
    CHECK(has(&f, "relay:G") && boot.phase == WG_PHASE_RUNNING);
}

static void test_a_helper_that_dies_after_the_mount_without_saying_done_stops_the_guest(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_exited(&boot, 1);   /* no 'E': the host may never have been told `mounted` */
    CHECK(has(&f, "log:helper-ended-after-mount"));
    CHECK(!has(&f, "start-supervisor"));
    CHECK(has(&f, "umount:data") && has(&f, "umount:env") && has(&f, "power-off"));
    CHECK(!starts(&f, "relay:"));
}

static void test_a_helper_that_finishes_normally_and_exits_changes_nothing(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_helper_exited(&boot, 0);
    CHECK(boot.phase == WG_PHASE_MOUNTED && !has(&f, "power-off"));
}

static void test_a_helper_that_ends_before_any_mount_leaves_the_guest_up_for_the_host(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_exited(&boot, 2);
    CHECK(has(&f, "log:bootstrap-failed") && !has(&f, "power-off") && boot.phase == WG_PHASE_BOOTSTRAP);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "relay:H:" NONCE));   /* and a later drain is orderly */
}

static void test_the_supervisor_never_starts_before_the_mount_is_confirmed(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_exited(&boot, 0);   /* the helper ended without ever mounting */
    CHECK(!has(&f, "start-supervisor") && !has(&f, "read-conversations"));
}

static void test_a_refused_config_or_a_failed_start_stops_the_guest(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    f.conversations = "not json";
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "log:config-refused") && !has(&f, "start-supervisor") && has(&f, "power-off"));
    fresh(&f); f.conversations_rc = 0; f.supervisor_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "log:supervisor-start-failed") && has(&f, "power-off"));
    fresh(&f); f.conversations_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "log:conversation-set-unusable"));
    fresh(&f); f.conversations_rc = 0; f.base_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "log:base-config-missing"));
    fresh(&f); f.conversations_rc = 0; f.boot_id_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    CHECK(has(&f, "log:boot-id-unreadable") && !has(&f, "start-supervisor"));
}

static void test_the_supervisor_exiting_stops_the_guest_unless_it_was_asked_to(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_supervisor_ready(&boot);
    wg_boot_supervisor_exited(&boot, 78);
    CHECK(has(&f, "log:supervisor-exited-retained-debt") && has(&f, "power-off"));
    CHECK(!starts(&f, "relay:K") && !starts(&f, "relay:H"));
}

static void test_the_relay_exiting_stops_the_guest_without_frames(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_relay_exited(&boot);
    CHECK(has(&f, "log:relay-exited") && has(&f, "power-off") && !starts(&f, "relay:"));
    CHECK(index_of(&f, "umount:env") >= 0 && index_of(&f, "umount:data") >= 0);
}

/* ---- drain */

static void drain(struct wg_boot *boot, const char *nonce, uint32_t budget) {
    uint8_t p[CTL_DRAIN_PAYLOAD_BYTES];
    drain_payload(p, nonce, budget, 0);
    wg_boot_relay_message(boot, CTL_DRAIN, p, sizeof p);
}

static void test_a_full_drain_runs_in_the_documented_order(void) {
    struct fake f; fresh(&f);
    f.conversations_rc = 0;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_supervisor_ready(&boot);
    drain(&boot, NONCE, 30000);
    int ack = index_of(&f, "relay:K:" NONCE), helper = index_of(&f, "stop-helper:15000"), sup = index_of(&f, "stop-supervisor:22500");
    int kill = index_of(&f, "kill-all"), sync1 = index_of(&f, "sync"), env = index_of(&f, "umount:env"), data = index_of(&f, "umount:data");
    int halting = index_of(&f, "relay:H:" NONCE), flushed = index_of(&f, "wait-flushed:3000"), off = index_of(&f, "power-off");
    CHECK(ack >= 0 && helper > ack && sup > helper && kill > sup && sync1 > kill && env > sync1 && data > sync1);
    CHECK(halting > env && halting > data && flushed > halting && off > flushed);
    CHECK(f.events[f.count - 2][0] == 's');   /* a final sync directly precedes the power-off */
    CHECK(strcmp(f.events[f.count - 1], "power-off") == 0);
    CHECK(boot.phase == WG_PHASE_DEAD && boot.halting_sent);
}

static void test_halting_is_withheld_when_a_unmount_fails_and_the_guest_still_powers_off(void) {
    struct fake f; fresh(&f);
    f.umount_data_rc = -1;
    f.umount_data_failures_left = 100;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    drain(&boot, NONCE, 30000);
    CHECK(has(&f, "relay:K:" NONCE));
    CHECK(!starts(&f, "relay:H"));
    CHECK(has(&f, "log:unmount-failed") && has(&f, "power-off") && !boot.halting_sent);
}

static void test_a_busy_unmount_is_retried_after_killing_the_holders(void) {
    struct fake f; fresh(&f);
    f.umount_data_failures_left = 2;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    drain(&boot, NONCE, 30000);
    int umounts = 0, kills = 0;
    for (int i = 0; i < f.count; i++) { umounts += strcmp(f.events[i], "umount:data") == 0; kills += strcmp(f.events[i], "kill-all") == 0; }
    CHECK(umounts == 3);
    CHECK(kills == 3);   /* once before the first attempt, once after each failure */
    CHECK(starts(&f, "relay:H"));
}

static void test_the_unmount_attempts_are_bounded(void) {
    struct fake f; fresh(&f);
    f.umount_data_failures_left = 1000;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    drain(&boot, NONCE, 30000);
    int umounts = 0;
    for (int i = 0; i < f.count; i++) umounts += strcmp(f.events[i], "umount:data") == 0;
    CHECK(umounts == 4);
}

static void test_a_drain_before_any_mount_has_nothing_to_unmount_and_is_still_orderly(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    drain(&boot, NONCE, 5000);
    CHECK(!starts(&f, "umount:"));
    CHECK(has(&f, "relay:H:" NONCE) && has(&f, "power-off"));
    CHECK(has(&f, "stop-helper:2500") && has(&f, "stop-supervisor:3750"));
}

static void test_a_zero_budget_still_ends_in_a_power_off(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    drain(&boot, NONCE, 0);
    CHECK(has(&f, "stop-helper:0") && has(&f, "power-off") && has(&f, "umount:data"));
}

static void test_a_malformed_drain_stops_the_guest_without_an_ack(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    uint8_t p[CTL_DRAIN_PAYLOAD_BYTES];
    drain_payload(p, NONCE, 120001, 0);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, sizeof p);
    CHECK(has(&f, "log:drain-fields") && !starts(&f, "relay:K") && has(&f, "power-off"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    drain_payload(p, "ZZ23456789abcdef0123456789abcdef", 10, 0);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, sizeof p);
    CHECK(has(&f, "log:drain-fields"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    drain_payload(p, NONCE, 10, 2);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, sizeof p);
    CHECK(has(&f, "log:drain-fields"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, 36);
    CHECK(has(&f, "log:drain-payload"));
}

static void test_events_after_the_power_off_are_ignored(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    drain(&boot, NONCE, 100);
    int before = f.count;
    wg_boot_helper_exited(&boot, 0);
    wg_boot_relay_exited(&boot);
    wg_boot_supervisor_exited(&boot, 0);
    drain(&boot, NONCE, 100);
    CHECK(f.count == before);
}

static void test_a_second_stop_cannot_start_while_the_first_runs(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    boot.phase = WG_PHASE_DRAINING;
    wg_boot_fail_stop(&boot, "x");
    CHECK(f.count == 0);
}

static void test_the_fail_stop_unmounts_and_syncs_but_sends_no_frames(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_fail_stop(&boot, "because");
    CHECK(has(&f, "log:because") && has(&f, "sync") && has(&f, "umount:data") && has(&f, "umount:env") && has(&f, "power-off"));
    CHECK(!starts(&f, "relay:"));
    CHECK(index_of(&f, "sync") < index_of(&f, "umount:data"));
}

static void test_a_failed_replay_that_left_the_volume_mounted_is_unmounted_before_halting(void) {
    struct fake f; fresh(&f);
    f.replay_rc = -2;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    CHECK(has(&f, "helper:q:0") && boot.replay_mounted[0]);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "umount-replay:data"));
    CHECK(index_of(&f, "umount-replay:data") < index_of(&f, "relay:H:" NONCE));
}

static void test_a_replay_volume_that_cannot_be_unmounted_withholds_halting(void) {
    struct fake f; fresh(&f);
    f.replay_rc = -2;
    f.umount_replay_failures_left = 100;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"environment", 11);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "relay:K:" NONCE) && !starts(&f, "relay:H") && has(&f, "log:unmount-failed") && has(&f, "power-off"));
}

static void test_a_clean_replay_failure_leaves_nothing_to_unmount(void) {
    struct fake f; fresh(&f);
    f.replay_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    drain(&boot, NONCE, 1000);
    CHECK(!starts(&f, "umount-replay:") && starts(&f, "relay:H"));
}

static void test_a_mount_rollback_that_failed_is_tracked_and_verified(void) {
    struct fake f; fresh(&f);
    f.mount_rc = -1;
    f.mount_leftover = 1;   /* the data volume could not be unmounted during the rollback */
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "helper:m:0") && boot.data_mounted && !boot.environment_mounted);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "umount:data") && !has(&f, "umount:env") && has(&f, "verify:data:11") && !has(&f, "verify:env:66") && starts(&f, "relay:H"));
}

static void test_a_leftover_environment_volume_is_tracked_and_verified_too(void) {
    struct fake f; fresh(&f);
    f.mount_rc = -1;
    f.mount_leftover = 2;   /* the environment volume could not be unmounted during the rollback */
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(!boot.data_mounted && boot.environment_mounted);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "umount:env") && !has(&f, "umount:data") && has(&f, "verify:env:66") && !has(&f, "verify:data:11") && starts(&f, "relay:H"));
}

static void test_halting_needs_a_verified_clean_superblock_on_every_mounted_volume(void) {
    for (int which = 0; which < 2; which++) {
        struct fake f; fresh(&f);
        f.verify_rc[which] = -1;
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        to_mounted(&boot);
        drain(&boot, NONCE, 1000);
        CHECK(has(&f, "verify:data:11") && (which == 0 || has(&f, "verify:env:66")));   /* the first failure ends the check */
        CHECK(index_of(&f, "umount:data") < index_of(&f, "verify:data:11"));
        CHECK(!starts(&f, "relay:H") && has(&f, "power-off"));
    }
}

static void test_a_volume_that_was_never_mounted_is_not_verified(void) {
    struct fake f; fresh(&f);
    f.verify_rc[0] = f.verify_rc[1] = -1;   // would fail if asked
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    drain(&boot, NONCE, 1000);
    CHECK(!starts(&f, "verify:") && starts(&f, "relay:H"));
}

static void test_an_unconfirmed_halting_is_logged(void) {
    struct fake f; fresh(&f);
    f.wait_flushed_rc = 0;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "log:halting-unconfirmed") && has(&f, "power-off"));
}

/* ------------------------------------------------------------------------------------------------ mount policy */

struct mfake {
    char events[32][160];
    int count;
    int check_rc[2], mount_rc[2], umount_rc, sync_rc, mkdir_rc, skeleton_rc;
    int mounts_done;
};
static void mev(struct mfake *m, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (m->count < 32) vsnprintf(m->events[m->count++], sizeof m->events[0], fmt, args);
    va_end(args);
}
static int mhas(struct mfake *m, const char *text) { for (int i = 0; i < m->count; i++) if (strcmp(m->events[i], text) == 0) return 1; return 0; }
static int midx(struct mfake *m, const char *text) { for (int i = 0; i < m->count; i++) if (strcmp(m->events[i], text) == 0) return i; return -1; }
static int m_mount(void *c, const char *s, const char *t, const char *fs, unsigned long flags, const char *data) {
    struct mfake *m = c;
    mev(m, "mount %s %s %s %lu %s", s, t, fs, flags, data);
    int rc = m->mount_rc[m->mounts_done < 2 ? m->mounts_done : 1];
    m->mounts_done++;
    return rc;
}
static int m_umount(void *c, const char *t) { mev(c, "umount %s", t); return ((struct mfake *)c)->umount_rc; }
static int m_syncfs(void *c, const char *p) { mev(c, "syncfs %s", p); return ((struct mfake *)c)->sync_rc; }
static int m_mkdir(void *c, const char *p) { mev(c, "mkdir %s", p); return ((struct mfake *)c)->mkdir_rc; }
static int m_check(void *c, const char *node, const uint8_t *uuid) { struct mfake *m = c; mev(m, "check %s %02x", node, uuid[0]); return m->check_rc[strcmp(node, "/dev/vda") == 0 ? 0 : 1]; }
static int m_skeleton(void *c) { mev(c, "skeleton"); return ((struct mfake *)c)->skeleton_rc; }
static struct wg_mount_ops mops(struct mfake *m) {
    struct wg_mount_ops ops = { m, m_mount, m_umount, m_syncfs, m_mkdir, m_check, m_skeleton };
    return ops;
}

static void test_mount_flags_options_and_order(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0x11 }, eu[16] = { 0x66 };
    int leftover = -1;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) == 0 && leftover == 0);
    CHECK(mhas(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));       /* nosuid|nodev|noatime = 2|4|1024 */
    CHECK(mhas(&m, "mount /dev/vdb /opt/winter/environment/disk ext4 1030 noinit_itable,errors=remount-ro"));
    CHECK(midx(&m, "check /dev/vda 11") < midx(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));
    CHECK(midx(&m, "check /dev/vdb 66") < midx(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));   /* both checked before any mount */
    CHECK(midx(&m, "skeleton") > midx(&m, "mount /dev/vdb /opt/winter/environment/disk ext4 1030 noinit_itable,errors=remount-ro"));
    CHECK((WG_WORKING_FLAGS & WG_MS_NOEXEC) == 0 && (WG_WORKING_FLAGS & WG_MS_RDONLY) == 0);
}

static void test_a_failed_check_mounts_nothing(void) {
    for (int which = 0; which < 2; which++) {
        struct mfake m; memset(&m, 0, sizeof m);
        m.check_rc[which] = -1;
        struct wg_mount_ops ops = mops(&m);
        const uint8_t du[16] = { 0 }, eu[16] = { 0 };
        int leftover = -1;
        CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
        CHECK(!mhas(&m, "skeleton"));
        for (int i = 0; i < m.count; i++) CHECK(strncmp(m.events[i], "mount ", 6) != 0);
    }
}

static void test_a_failed_second_mount_unmounts_the_first(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.mount_rc[1] = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = -1;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
    CHECK(mhas(&m, "umount /workspace") && !mhas(&m, "skeleton"));
}

static void test_a_failed_skeleton_unmounts_both(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.skeleton_rc = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = -1;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
    CHECK(mhas(&m, "umount /workspace") && mhas(&m, "umount /opt/winter/environment/disk"));
    CHECK(midx(&m, "umount /opt/winter/environment/disk") < midx(&m, "umount /workspace"));
}

static void test_rollback_unmount_failures_are_reported_per_volume(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.mount_rc[1] = -1;
    m.umount_rc = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = 0;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
    CHECK(leftover == 1);   /* the data volume is still mounted */
    memset(&m, 0, sizeof m);
    m.skeleton_rc = -1;
    m.umount_rc = -1;
    leftover = 0;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
    CHECK(leftover == 3);   /* both */
}

static void test_journal_replay_is_mount_flush_unmount_and_never_executable(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    struct wg_mount_ops ops = mops(&m);
    CHECK(wg_replay_journal(&ops, "/dev/vda", "data") == 0);
    CHECK(mhas(&m, "mount /dev/vda /run/winter/replay/data ext4 1038 noinit_itable,errors=remount-ro"));   /* nosuid|nodev|noexec|noatime */
    CHECK(midx(&m, "mount /dev/vda /run/winter/replay/data ext4 1038 noinit_itable,errors=remount-ro") < midx(&m, "syncfs /run/winter/replay/data"));
    CHECK(midx(&m, "syncfs /run/winter/replay/data") < midx(&m, "umount /run/winter/replay/data"));
}

static void test_a_replay_that_cannot_flush_or_unmount_does_not_succeed(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.sync_rc = -1;
    struct wg_mount_ops ops = mops(&m);
    CHECK(wg_replay_journal(&ops, "/dev/vda", "data") == -1);   /* flush failed, unmount worked: nothing left mounted */
    CHECK(mhas(&m, "umount /run/winter/replay/data"));   /* still tries to get out */
    memset(&m, 0, sizeof m);
    m.umount_rc = -1;
    CHECK(wg_replay_journal(&ops, "/dev/vda", "environment") == -2);   /* may still be mounted */
    memset(&m, 0, sizeof m);
    m.mount_rc[0] = -1;
    CHECK(wg_replay_journal(&ops, "/dev/vda", "data") == -1);
    CHECK(!mhas(&m, "syncfs /run/winter/replay/data") && !mhas(&m, "umount /run/winter/replay/data"));
}

static void test_replay_refuses_unknown_purposes_and_failed_directories(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    struct wg_mount_ops ops = mops(&m);
    CHECK(wg_replay_journal(&ops, "/dev/vda", "../x") != 0 && m.count == 0);
    CHECK(wg_replay_journal(&ops, "/dev/vda", "") != 0 && m.count == 0);
    m.mkdir_rc = -1;
    CHECK(wg_replay_journal(&ops, "/dev/vda", "data") != 0);
    for (int i = 0; i < m.count; i++) CHECK(strncmp(m.events[i], "mount ", 6) != 0);
}

typedef void (*test_fn)(void);
struct test_case { const char *name; test_fn fn; };
#define T(x) { #x, x }

int main(void) {
    static const struct test_case tests[] = {
        T(test_bootstrap_payloads_flow_both_ways), T(test_a_bootstrap_payload_with_no_helper_is_dropped),
        T(test_replay_is_allowed_before_the_mount_for_known_purposes_only), T(test_replay_for_an_unknown_purpose_stops_the_guest),
        T(test_replay_after_the_mount_request_stops_the_guest), T(test_the_mount_happens_once_on_request_and_is_reported_to_the_helper),
        T(test_a_failed_mount_is_reported_and_leaves_nothing_mounted), T(test_a_malformed_mount_payload_stops_the_guest_without_mounting),
        T(test_done_without_a_mount_stops_the_guest), T(test_unknown_helper_and_relay_messages_stop_the_guest),
        T(test_a_relay_fatal_stops_the_guest_without_any_frame), T(test_the_supervisor_does_not_start_without_a_conversation_set),
        T(test_with_a_conversation_set_the_supervisor_starts_with_the_live_boot_id), T(test_a_helper_that_dies_after_the_mount_without_saying_done_stops_the_guest), T(test_a_helper_that_finishes_normally_and_exits_changes_nothing), T(test_a_helper_that_ends_before_any_mount_leaves_the_guest_up_for_the_host), T(test_the_supervisor_never_starts_before_the_mount_is_confirmed),
        T(test_a_refused_config_or_a_failed_start_stops_the_guest), T(test_the_supervisor_exiting_stops_the_guest_unless_it_was_asked_to),
        T(test_the_relay_exiting_stops_the_guest_without_frames), T(test_a_full_drain_runs_in_the_documented_order),
        T(test_halting_is_withheld_when_a_unmount_fails_and_the_guest_still_powers_off), T(test_a_busy_unmount_is_retried_after_killing_the_holders),
        T(test_the_unmount_attempts_are_bounded), T(test_a_drain_before_any_mount_has_nothing_to_unmount_and_is_still_orderly),
        T(test_a_zero_budget_still_ends_in_a_power_off), T(test_a_malformed_drain_stops_the_guest_without_an_ack),
        T(test_events_after_the_power_off_are_ignored), T(test_a_second_stop_cannot_start_while_the_first_runs),
        T(test_the_fail_stop_unmounts_and_syncs_but_sends_no_frames), T(test_a_failed_replay_that_left_the_volume_mounted_is_unmounted_before_halting), T(test_a_replay_volume_that_cannot_be_unmounted_withholds_halting), T(test_a_clean_replay_failure_leaves_nothing_to_unmount), T(test_a_mount_rollback_that_failed_is_tracked_and_verified), T(test_a_leftover_environment_volume_is_tracked_and_verified_too), T(test_halting_needs_a_verified_clean_superblock_on_every_mounted_volume), T(test_a_volume_that_was_never_mounted_is_not_verified), T(test_an_unconfirmed_halting_is_logged), T(test_mount_flags_options_and_order),
        T(test_a_failed_check_mounts_nothing), T(test_a_failed_second_mount_unmounts_the_first), T(test_a_failed_skeleton_unmounts_both), T(test_rollback_unmount_failures_are_reported_per_volume),
        T(test_journal_replay_is_mount_flush_unmount_and_never_executable), T(test_a_replay_that_cannot_flush_or_unmount_does_not_succeed),
        T(test_replay_refuses_unknown_purposes_and_failed_directories),
    };
    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; i++) {
        current_name = tests[i].name;
        current_failed = 0;
        tests[i].fn();
        if (current_failed) failures++; else printf("PASS %s\n", current_name);
    }
    printf("%s %zu tests, %d failed\n", failures ? "FAILED" : "OK", sizeof tests / sizeof tests[0], failures);
    return failures ? 1 : 0;
}
