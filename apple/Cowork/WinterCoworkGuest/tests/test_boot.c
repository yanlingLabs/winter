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
    int dirs_rc, artifacts_rc, no_guided_artifacts;
    int last_with_ports;
    unsigned dirs_count;
    char dirs_ids[4][130];
    const char *artifacts;
    const char *base;
    int base_rc, boot_id_rc, supervisor_rc, wait_flushed_rc, flush_rc;
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
    else if (tag == CTL_RUNTIME_GO) ev(c, "relay:G:%u", (unsigned)((const uint8_t *)p)[0]);
    else if (tag == CTL_FAULT) {
        if (n > 1) ev(c, "relay:X:%u:%.*s", (unsigned)((const uint8_t *)p)[0], (int)n - 1, (const char *)p + 1);
        else ev(c, "relay:X:%u", (unsigned)((const uint8_t *)p)[0]);
    }
    else if (tag == CTL_DRAIN_ACK || tag == CTL_HALTING) ev(c, "relay:%c:%.*s", tag == CTL_DRAIN_ACK ? 'K' : 'H', (int)n, (const char *)p);
    else ev(c, "relay:%c", tag);
}
static void f_to_helper(void *c, uint8_t tag, const void *p, size_t n) {
    struct fake *f = c;
    if (tag == CTL_REPLAY_RESULT || tag == CTL_MOUNT_RESULT) { f->to_helper_byte = ((const uint8_t *)p)[0]; ev(c, "helper:%c:%u", tag, (unsigned)f->to_helper_byte); }
    else if (tag == CTL_CONVERSATIONS_RESULT) ev(c, "helper:r:%u:%u", (unsigned)((const uint8_t *)p)[0], (unsigned)((const uint8_t *)p)[1]);
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
static int f_prepare_dirs(void *c, const struct wg_conversation_set *set) {
    struct fake *f = c;
    ev(c, "prepare-dirs:%u", set->count);
    f->dirs_count = set->count;
    for (unsigned i = 0; i < set->count && i < 4; i++) snprintf(f->dirs_ids[i], sizeof f->dirs_ids[i], "%s:%u", set->session_id[i], (unsigned)set->runtime_uid[i]);
    return f->dirs_rc;
}
static int f_read_artifacts(void *c, unsigned profile, char *out, size_t cap, size_t *len) {
    struct fake *f = c;
    ev(c, "read-artifacts:%u", profile);
    if (f->artifacts_rc || (profile == 2 && f->no_guided_artifacts)) return f->artifacts_rc ? f->artifacts_rc : -1;
    snprintf(out, cap, "%s", f->artifacts);
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
static int f_start_supervisor(void *c, const char *config, size_t len, int with_ports) {
    struct fake *f = c;
    ev(c, "start-supervisor");
    f->last_with_ports = with_ports;
    snprintf(f->last_config, sizeof f->last_config, "%.*s", (int)len, config);
    return f->supervisor_rc;
}
static void f_stop_helper(void *c, long long deadline) { ev(c, "stop-helper:%lld", deadline - ((struct fake *)c)->now); }
static void f_stop_supervisor(void *c, long long deadline) { ev(c, "stop-supervisor:%lld", deadline - ((struct fake *)c)->now); }
static void f_kill_all(void *c) { ev(c, "kill-all"); }
static void f_sync(void *c) { ev(c, "sync"); }
static int f_flush(void *c, unsigned volumes) { ev(c, "flush:%u", volumes); return ((struct fake *)c)->flush_rc; }
static void f_power_off(void *c) { ev(c, "power-off"); }

static struct wg_boot_ops ops_for(struct fake *f) {
    struct wg_boot_ops ops = { .ctx = f, .now_ms = f_now, .pause_ms = f_pause, .log = f_log, .to_relay = f_to_relay, .to_helper = f_to_helper,
        .wait_flushed = f_wait_flushed, .replay = f_replay, .umount_replay = f_umount_replay, .mount_volumes = f_mount, .umount = f_umount,
        .verify_unmounted = f_verify, .prepare_conversation_dirs = f_prepare_dirs, .read_runtime_artifacts = f_read_artifacts, .read_base_config = f_read_base,
        .read_boot_id = f_boot_id, .start_supervisor = f_start_supervisor, .stop_helper = f_stop_helper, .stop_supervisor = f_stop_supervisor,
        .kill_all = f_kill_all, .sync_all = f_sync, .flush_devices = f_flush, .power_off = f_power_off };
    return ops;
}
static void fresh(struct fake *f) {
    memset(f, 0, sizeof *f);
    f->artifacts = "{\"artifacts\":{\"launcher\":{}}}";
    f->base = "{\"artifacts\":{}}";
    f->wait_flushed_rc = 1;
}

static void drain_payload(uint8_t out[CTL_DRAIN_PAYLOAD_BYTES], const char *nonce, uint32_t budget, uint8_t origin) {
    memcpy(out, nonce, 32);
    out[32] = (uint8_t)budget; out[33] = (uint8_t)(budget >> 8); out[34] = (uint8_t)(budget >> 16); out[35] = (uint8_t)(budget >> 24);
    out[36] = origin;
}
static const char MOUNT_PAYLOAD[] = UUID_DATA " " UUID_ENV;

/* the host's `ready`, as the helper receives it (canonical spelling of the contract) */
static const char READY_MESSAGE[] = "{\"v\":1,\"t\":\"ready\",\"operationId\":\"filesystem_55555555-5555-4555-8555-555555555555\",\"nonce\":\"" NONCE "\"}";
static void host_ready(struct wg_boot *boot) {
    wg_boot_relay_message(boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)READY_MESSAGE, sizeof READY_MESSAGE - 1);
}

#define ITEM_JSON "[{\"logicalSessionId\":\"s1\"}]"
/* The helper's 'C' message: profile, count, per conversation uid + id, then the items array. */
static size_t conversations_payload(uint8_t *out, unsigned profile, const char *const *ids, unsigned count, const char *json) {
    size_t at = 0;
    out[at++] = (uint8_t)profile;
    out[at++] = (uint8_t)count;
    for (unsigned i = 0; i < count; i++) {
        uint32_t uid = 20001 + i;
        out[at++] = (uint8_t)uid; out[at++] = (uint8_t)(uid >> 8); out[at++] = (uint8_t)(uid >> 16); out[at++] = (uint8_t)(uid >> 24);
        out[at++] = (uint8_t)strlen(ids[i]);
        memcpy(out + at, ids[i], strlen(ids[i])); at += strlen(ids[i]);
    }
    memcpy(out + at, json, strlen(json));
    return at + strlen(json);
}
static void send_conversations(struct wg_boot *boot, unsigned profile) {
    static const char *const ids[] = { "s1" };
    uint8_t payload[512];
    size_t n = conversations_payload(payload, profile, ids, 1, ITEM_JSON);
    wg_boot_helper_message(boot, CTL_HELPER_CONVERSATIONS, payload, n);
}

/* drive the happy path up to a given point */
static void to_mounted(struct wg_boot *boot) {
    host_ready(boot);
    wg_boot_helper_message(boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_message(boot, CTL_HELPER_DONE, NULL, 0);
}

static void drain(struct wg_boot *boot, const char *nonce, uint32_t budget);

/* mounted, a set delivered and the supervisor ready */
static void to_running(struct wg_boot *boot, unsigned profile) {
    to_mounted(boot);
    send_conversations(boot, profile);
    wg_boot_supervisor_ready(boot);
}

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
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_message(&boot, CTL_HELPER_REPLAY, (const uint8_t *)"data", 4);
    CHECK(!starts(&f, "replay:"));
    CHECK(has(&f, "log:replay-out-of-order"));
}

static void test_the_mount_happens_once_on_request_and_is_reported_to_the_helper(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "mount-volumes") && has(&f, "helper:m:1"));
    CHECK(boot.data_mounted && !boot.environment_mounted && boot.ever_mounted[0] && !boot.ever_mounted[1]);   /* the environment disk is never mounted in N2 */
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "log:mount-out-of-order") && has(&f, "power-off"));
}

static void test_a_failed_mount_is_reported_and_leaves_nothing_mounted(void) {
    struct fake f; fresh(&f);
    f.mount_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
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
        host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)bad[i], lens[i]);
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
    CHECK(boot.phase == WG_PHASE_MOUNTED && boot.conv_state == WG_CONV_NONE);
    CHECK(!has(&f, "start-supervisor") && !has(&f, "power-off"));
}

static void test_a_host_query_set_starts_the_supervisor_with_ports_and_the_live_boot_id(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 1);
    CHECK(has(&f, "start-supervisor") && f.last_with_ports && boot.conv_state == WG_CONV_STARTING && boot.phase == WG_PHASE_MOUNTED);
    CHECK(strstr(f.last_config, "\"guestBootId\":\"66666666-6666-4666-8666-666666666666\"") != NULL);
    CHECK(strstr(f.last_config, "\"conversations\":" ITEM_JSON) != NULL);
    CHECK(strstr(f.last_config, "\"artifacts\":{}") != NULL);
    CHECK(strstr(f.last_config, ",\"hostQueryRuntime\":{\"artifacts\":{\"launcher\":{}}}}") != NULL);
    CHECK(f.dirs_count == 1 && strcmp(f.dirs_ids[0], "s1:20001") == 0);
    CHECK(index_of(&f, "mount-volumes") < index_of(&f, "prepare-dirs:1") && index_of(&f, "prepare-dirs:1") < index_of(&f, "start-supervisor"));
    CHECK(!has(&f, "relay:G:1") && !starts(&f, "helper:r"));   /* nothing is promised before the ready line */
    wg_boot_supervisor_ready(&boot);
    CHECK(has(&f, "relay:G:1") && has(&f, "helper:r:0:1") && boot.phase == WG_PHASE_RUNNING && boot.conv_state == WG_CONV_RUNNING);
    CHECK(index_of(&f, "relay:G:1") < index_of(&f, "helper:r:0:1"));   /* the relay admits runtime frames before the host can hear `runtime_ready` */
}

static void test_the_guided_profile_uses_its_own_key_and_a_tools_only_set_has_no_ports_or_runtime_key(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 2);
    CHECK(strstr(f.last_config, ",\"hostQueryGuidedRuntime\":{") != NULL && strstr(f.last_config, "\"hostQueryRuntime\"") == NULL && f.last_with_ports);
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_running(&boot, 0);
    CHECK(!f.last_with_ports && strstr(f.last_config, "hostQuery") == NULL && !has(&f, "read-artifacts:0") && !has(&f, "read-artifacts:1") && !has(&f, "read-artifacts:2"));
    CHECK(has(&f, "relay:G:0") && has(&f, "helper:r:0:1"));   /* no runtime streams exist */
}

static void test_a_second_or_early_conversation_set_is_a_helper_bug_and_stops_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    send_conversations(&boot, 1);                     // before the mount
    CHECK(has(&f, "log:conversations-out-of-order") && !has(&f, "start-supervisor") && has(&f, "power-off"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    send_conversations(&boot, 1);
    CHECK(has(&f, "log:conversations-out-of-order") && has(&f, "power-off"));
}

static void test_malformed_conversation_payloads_are_refused_without_starting_anything(void) {
    static const char *const ids[] = { "s1", "s2" };
    uint8_t good[512], bad[512];
    size_t n = conversations_payload(good, 1, ids, 1, ITEM_JSON);
    CHECK(n > 10);
    struct { size_t at; uint8_t value; } edits[] = {
        { 0, 3 }, { 1, 0 }, { 1, 17 },                   // profile out of range, no conversations, too many
        { 2, 0 },                                        // runtimeUid 999 or lower: first byte 0 gives 20000 & ~0xff... keep it a real change below
    };
    (void)edits;
    for (int variant = 0; variant < 12; variant++) {
        memcpy(bad, good, n);
        size_t length = n;
        switch (variant) {
        case 0: bad[0] = 3; break;                       // unknown profile
        case 1: bad[1] = 0; break;                       // no conversation
        case 2: bad[1] = 2; break;                       // N2: a profile means exactly one
        case 3: bad[2] = 0; bad[3] = 0; bad[4] = 0; bad[5] = 0; break;     // uid 0
        case 4: bad[2] = 0xff; bad[3] = 0xff; bad[4] = 0xff; bad[5] = 0; break;   // uid above 65535
        case 5: bad[6] = 0; break;                       // empty logical session id
        case 6: bad[7] = '/'; break;                     // a path separator in the id
        case 7: length = 6; break;                       // truncated
        case 8: length = 6 + 2; break;                   // no json after the ids
        case 9: bad[2] = 0xfe; bad[3] = 0xff; bad[4] = 0; bad[5] = 0; break;     // uid 65534 is nobody
        case 10: bad[2] = 0xff; bad[3] = 0xff; bad[4] = 0; bad[5] = 0; break;    // uid 65535 is the invalid id
        case 11: bad[2] = 0xe7; bad[3] = 0x03; bad[4] = 0; bad[5] = 0; break;    // uid 999
        }
        struct fake f; fresh(&f);
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        to_mounted(&boot);
        wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, bad, length);
        CHECK(has(&f, "log:conversations-payload") && has(&f, "helper:r:1:0") && !has(&f, "start-supervisor") && !has(&f, "prepare-dirs:1"));
        CHECK(!has(&f, "power-off") && boot.conv_state == WG_CONV_FAILED);
    }
    {   /* the ends of the contract's unixId range are accepted (1000 and 65533) */
        struct wg_conversation_set set;
        uint8_t edge[512];
        memcpy(edge, good, n);
        edge[2] = 0xe8; edge[3] = 0x03; edge[4] = 0; edge[5] = 0;
        CHECK(wg_parse_conversation_payload(edge, n, &set) == 0 && set.runtime_uid[0] == 1000);
        edge[2] = 0xfd; edge[3] = 0xff;
        CHECK(wg_parse_conversation_payload(edge, n, &set) == 0 && set.runtime_uid[0] == 65533);
    }
    {   /* the count rules stand on their own, whatever else is in the payload */
        struct wg_conversation_set set;
        uint8_t big[2048];
        const char *many[WG_CONVERSATIONS_MAX + 1];
        char names[WG_CONVERSATIONS_MAX + 1][8];
        for (unsigned i = 0; i <= WG_CONVERSATIONS_MAX; i++) { snprintf(names[i], sizeof names[i], "s%u", i); many[i] = names[i]; }
        size_t n = conversations_payload(big, 0, many, 0, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) != 0);                          // none
        n = conversations_payload(big, 0, many, WG_CONVERSATIONS_MAX, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) == 0 && set.count == WG_CONVERSATIONS_MAX);   // sixteen
        n = conversations_payload(big, 0, many, WG_CONVERSATIONS_MAX + 1, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) != 0);                          // seventeen
        n = conversations_payload(big, 1, many, 2, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) != 0);                          // a profile means exactly one, even when both are well formed
        n = conversations_payload(big, 2, many, 2, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) != 0);
        n = conversations_payload(big, 1, many, 1, "[]");
        CHECK(wg_parse_conversation_payload(big, n, &set) == 0);
    }
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    uint8_t two[512];
    size_t m = conversations_payload(two, 0, ids, 2, "[{},{}]");
    wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, two, m);   // two tools-only conversations are fine
    CHECK(has(&f, "start-supervisor") && has(&f, "prepare-dirs:2") && strcmp(f.dirs_ids[1], "s2:20002") == 0);
    memcpy(bad, two, m);
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    const char *dup[] = { "s1", "s1" };
    m = conversations_payload(two, 0, dup, 2, "[{},{}]");
    wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, two, m);
    CHECK(has(&f, "log:conversations-payload") && !has(&f, "start-supervisor"));   // distinct ids only
}

static void test_a_set_that_cannot_start_leaves_the_guest_up_and_tells_the_helper(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    uint8_t payload[512];
    static const char *const ids[] = { "s1" };
    to_mounted(&boot);
    size_t n = conversations_payload(payload, 0, ids, 1, "not json");
    wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, payload, n);
    CHECK(has(&f, "log:config-refused") && has(&f, "helper:r:1:0") && !has(&f, "start-supervisor") && !has(&f, "power-off") && boot.conv_state == WG_CONV_FAILED);
    fresh(&f); f.dirs_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    CHECK(has(&f, "log:conversation-dirs-failed") && has(&f, "helper:r:2:0") && !has(&f, "start-supervisor") && !has(&f, "power-off"));
    fresh(&f); f.supervisor_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    CHECK(has(&f, "log:supervisor-start-failed") && has(&f, "helper:r:2:0") && !has(&f, "power-off"));
    fresh(&f); f.artifacts_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 1);
    CHECK(has(&f, "log:runtime-artifacts-missing") && has(&f, "helper:r:2:0") && !has(&f, "start-supervisor") && !has(&f, "power-off"));
    CHECK(has(&f, "read-artifacts:1"));   /* the host-query profile asks for its own artifacts */
    /* an image without the guided executable cannot run the guided profile: it fails at boot, with the supervisor not started */
    fresh(&f); f.no_guided_artifacts = 1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 2);
    CHECK(has(&f, "read-artifacts:2") && has(&f, "log:runtime-artifacts-missing") && has(&f, "helper:r:2:0") && !has(&f, "start-supervisor") && !has(&f, "power-off"));
    fresh(&f); f.no_guided_artifacts = 1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 1);   /* the same image still serves host-query */
    CHECK(has(&f, "start-supervisor") && !has(&f, "log:runtime-artifacts-missing"));
    fresh(&f); f.base_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    CHECK(has(&f, "log:base-config-missing") && has(&f, "power-off") && has(&f, "relay:X:4"));   // an image fault, not the host's: fail-stop with an internal fault
    fresh(&f); f.boot_id_rc = -1; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    CHECK(has(&f, "log:boot-id-unreadable") && !has(&f, "start-supervisor") && has(&f, "power-off"));
}

static void test_a_failed_attempt_still_counts_as_the_one_attempt(void) {
    struct fake f; fresh(&f);
    f.supervisor_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    CHECK(boot.conv_state == WG_CONV_FAILED && !has(&f, "power-off"));
    f.supervisor_rc = 0;
    send_conversations(&boot, 0);                 // the helper must answer a second set itself; PID 1 treats one as a helper bug
    CHECK(has(&f, "log:conversations-out-of-order") && has(&f, "power-off"));
}

static void test_a_supervisor_that_is_not_ready_fails_the_set_but_not_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 1);
    wg_boot_supervisor_not_ready(&boot, "supervisor-ready-timeout");
    CHECK(has(&f, "log:supervisor-ready-timeout") && has(&f, "stop-supervisor:0") && has(&f, "helper:r:2:0") && !has(&f, "power-off") && boot.conv_state == WG_CONV_FAILED);
    wg_boot_supervisor_exited(&boot, 137);                      // the stopped supervisor's exit is not news
    CHECK(!has(&f, "power-off") && !starts(&f, "relay:X"));
    wg_boot_supervisor_ready(&boot);                             // a ready line that comes too late changes nothing
    CHECK(!has(&f, "relay:G:1") && boot.phase == WG_PHASE_MOUNTED);
    drain(&boot, NONCE, 1000);
    CHECK(starts(&f, "relay:H"));                                // and the guest can still stop in order
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 1);
    wg_boot_supervisor_exited(&boot, 3);                        // died before its ready line
    CHECK(has(&f, "log:supervisor-exited-before-ready") && has(&f, "helper:r:2:0") && !has(&f, "power-off"));
}

static void test_a_helper_that_dies_after_the_mount_without_saying_done_stops_the_guest(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_exited(&boot, 1);   /* no 'E': the host may never have been told `mounted` */
    CHECK(has(&f, "log:helper-ended-after-mount"));
    CHECK(!has(&f, "start-supervisor"));
    CHECK(has(&f, "umount:data") && !has(&f, "umount:env") && has(&f, "power-off"));
    CHECK(has(&f, "relay:X:4") && !starts(&f, "relay:K") && !starts(&f, "relay:H"));   /* an internal fault, never an ack or halting */
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
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_exited(&boot, 0);   /* the helper ended without ever mounting */
    CHECK(!has(&f, "start-supervisor") && !has(&f, "prepare-dirs:1"));
}

static void test_the_supervisor_exiting_after_ready_stops_the_guest_with_a_supervisor_lost_fault(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    wg_boot_supervisor_exited(&boot, 78);
    CHECK(has(&f, "log:supervisor-exited-retained-debt") && has(&f, "power-off"));
    CHECK(has(&f, "relay:X:2") && !starts(&f, "relay:K") && !starts(&f, "relay:H"));
    CHECK(index_of(&f, "relay:X:2") < index_of(&f, "umount:data"));   /* the host hears of it before the unmounts */
}

static void test_the_relay_exiting_stops_the_guest_without_frames(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    wg_boot_relay_exited(&boot);
    CHECK(has(&f, "log:relay-exited") && has(&f, "power-off") && !starts(&f, "relay:"));
    CHECK(index_of(&f, "umount:data") >= 0);
}

/* ---- drain */

static void drain(struct wg_boot *boot, const char *nonce, uint32_t budget) {
    uint8_t p[CTL_DRAIN_PAYLOAD_BYTES];
    drain_payload(p, nonce, budget, 0);
    wg_boot_relay_message(boot, CTL_DRAIN, p, sizeof p);
}

static void test_a_full_drain_runs_in_the_documented_order(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    drain(&boot, NONCE, 30000);
    int ack = index_of(&f, "relay:K:" NONCE), helper = index_of(&f, "stop-helper:15000"), sup = index_of(&f, "stop-supervisor:22500");
    int kill = index_of(&f, "kill-all"), sync1 = index_of(&f, "sync"), data = index_of(&f, "umount:data");
    int halting = index_of(&f, "relay:H:" NONCE), flushed = index_of(&f, "wait-flushed:3000"), off = index_of(&f, "power-off");
    CHECK(ack >= 0 && helper > ack && sup > helper && kill > sup && sync1 > kill && data > sync1 && !has(&f, "umount:env"));
    CHECK(halting > data && flushed > halting && off > flushed);
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
    CHECK(has(&f, "relay:X:1:" NONCE));   /* unmount_failed, after the drain_ack, with the drain's nonce */
    CHECK(index_of(&f, "relay:K:" NONCE) < index_of(&f, "relay:X:1:" NONCE));
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
    CHECK(has(&f, "log:because") && has(&f, "sync") && has(&f, "umount:data") && has(&f, "power-off"));
    CHECK(has(&f, "relay:X:4") && !starts(&f, "relay:K") && !starts(&f, "relay:H") && !starts(&f, "relay:G"));   /* an internal fault is the only frame */
    CHECK(index_of(&f, "relay:X:4") < index_of(&f, "umount:data"));
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
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
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
    host_ready(&boot); wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(!boot.data_mounted && boot.environment_mounted);
    drain(&boot, NONCE, 1000);
    CHECK(has(&f, "umount:env") && !has(&f, "umount:data") && has(&f, "verify:env:66") && !has(&f, "verify:data:11") && starts(&f, "relay:H"));
}

static void test_halting_needs_a_verified_clean_superblock_on_every_mounted_volume(void) {
    {
        struct fake f; fresh(&f);
        f.verify_rc[0] = -1;
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        to_mounted(&boot);
        drain(&boot, NONCE, 1000);
        CHECK(has(&f, "verify:data:11"));
        CHECK(index_of(&f, "umount:data") < index_of(&f, "verify:data:11"));
        CHECK(!starts(&f, "relay:H") && has(&f, "power-off") && has(&f, "relay:X:1:" NONCE));
    }
    {   /* the environment disk was never mounted: its superblock is not part of what `halting` claims */
        struct fake f; fresh(&f);
        f.verify_rc[1] = -1;
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        to_mounted(&boot);
        drain(&boot, NONCE, 1000);
        CHECK(!has(&f, "verify:env:66") && starts(&f, "relay:H"));
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
    CHECK(!mhas(&m, "mount /dev/vdb /opt/winter/environment/disk ext4 1030 noinit_itable,errors=remount-ro"));   /* the environment disk is not mounted in N2 */
    for (int i = 0; i < m.count; i++) CHECK(strncmp(m.events[i], "mount /dev/vdb", 14) != 0);
    CHECK(midx(&m, "check /dev/vda 11") < midx(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));
    CHECK(midx(&m, "check /dev/vdb 66") < midx(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));   /* both checked before any mount */
    CHECK(midx(&m, "skeleton") > midx(&m, "mount /dev/vda /workspace ext4 1030 noinit_itable,errors=remount-ro"));
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

static void test_a_failed_data_mount_mounts_nothing_else_and_skips_the_skeleton(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.mount_rc[0] = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = -1;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0 && leftover == 0);
    CHECK(!mhas(&m, "skeleton") && !mhas(&m, "umount /workspace"));
    for (int i = 0; i < m.count; i++) CHECK(strncmp(m.events[i], "mount /dev/vdb", 14) != 0);
}

static void test_a_failed_skeleton_unmounts_the_data_volume(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.skeleton_rc = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = -1;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0 && leftover == 0);
    CHECK(mhas(&m, "umount /workspace"));
}

static void test_a_rollback_unmount_failure_is_reported_for_the_data_volume(void) {
    struct mfake m; memset(&m, 0, sizeof m);
    m.skeleton_rc = -1;
    m.umount_rc = -1;
    struct wg_mount_ops ops = mops(&m);
    const uint8_t du[16] = { 0 }, eu[16] = { 0 };
    int leftover = 0;
    CHECK(wg_mount_volumes(&ops, "/dev/vda", du, "/dev/vdb", eu, &leftover) != 0);
    CHECK(leftover == 1);   /* the data volume is still mounted */
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

static void test_a_mount_request_before_the_hosts_ready_stops_the_guest(void) {
    const char *others[] = { "{\"v\":1,\"t\":\"plan\",\"x\":1}", "{\"v\":1,\"t\":\"readyx\"}", "{\"v\":1,\"t\":\"ready\"", "{\"t\":\"ready\",\"v\":1}", "" };
    for (int i = -1; i < 5; i++) {
        struct fake f; fresh(&f);
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        if (i >= 0) wg_boot_relay_message(&boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)others[i], strlen(others[i]));
        wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
        CHECK(!has(&f, "mount-volumes"));
        CHECK(has(&f, "log:mount-out-of-order") && has(&f, "power-off"));
    }
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    host_ready(&boot);
    wg_boot_helper_message(&boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    CHECK(has(&f, "mount-volumes") && !has(&f, "power-off"));
}

static void test_a_ready_that_arrives_after_the_helper_is_gone_does_not_unlock_the_mount(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    wg_boot_helper_exited(&boot, 1);
    host_ready(&boot);
    CHECK(!boot.host_ready_seen);
}

static void test_the_devices_are_flushed_after_the_last_unmount_and_before_halting(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    drain(&boot, NONCE, 30000);
    int data = index_of(&f, "umount:data"), flush = index_of(&f, "flush:1"), halting = index_of(&f, "relay:H:" NONCE);
    CHECK(data >= 0 && flush > data && halting > flush);   /* only the data volume was ever mounted: only it is flushed */
    CHECK(boot.halting_sent);
}

static void test_a_failed_flush_withholds_halting_but_still_powers_off(void) {
    struct fake f; fresh(&f);
    f.flush_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    drain(&boot, NONCE, 30000);
    CHECK(has(&f, "relay:K:" NONCE) && !has(&f, "relay:H:" NONCE) && !boot.halting_sent);
    CHECK(has(&f, "relay:X:4:" NONCE));   /* internal: the unmounts worked, the flush did not */
    CHECK(has(&f, "log:flush-failed") && has(&f, "power-off"));
}

static void test_no_flush_is_asked_for_a_volume_that_was_never_mounted_and_none_when_unmounting_failed(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    drain(&boot, NONCE, 30000);
    CHECK(has(&f, "flush:0") && has(&f, "relay:H:" NONCE));
    struct fake g; fresh(&g);
    g.umount_data_rc = -1;
    struct wg_boot_ops gops = ops_for(&g);
    struct wg_boot b2; wg_boot_init(&b2, &gops);
    to_mounted(&b2);
    drain(&b2, NONCE, 30000);
    CHECK(!starts(&g, "flush") && !has(&g, "relay:H:" NONCE));
}

static void test_fail_stop_faults_name_what_failed(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    uint8_t p[CTL_DRAIN_PAYLOAD_BYTES];
    drain_payload(p, NONCE, 120001, 0);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, sizeof p);
    CHECK(has(&f, "relay:X:3") && !starts(&f, "relay:K"));                    // protocol_violation: the host's drain was malformed
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    wg_boot_relay_message(&boot, CTL_DRAIN, p, 36);
    CHECK(has(&f, "relay:X:3"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    wg_boot_relay_message(&boot, 'Z', NULL, 0);                                  // a tag the relay never sends
    CHECK(has(&f, "log:relay-message") && has(&f, "relay:X:3"));
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    wg_boot_helper_message(&boot, 'Z', NULL, 0);                                 // a helper that says something it may not: PID 1's own affair
    CHECK(has(&f, "log:helper-message") && has(&f, "relay:X:4") && !has(&f, "relay:X:3"));
}

static void test_a_fault_is_flushed_before_anything_else_happens_and_an_unconfirmed_one_is_logged(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    wg_boot_supervisor_exited(&boot, 1);
    CHECK(index_of(&f, "relay:X:2") >= 0 && index_of(&f, "wait-flushed:3000") > index_of(&f, "relay:X:2") && index_of(&f, "stop-helper:5000") > index_of(&f, "wait-flushed:3000"));
    CHECK(!has(&f, "log:fault-unconfirmed"));
    fresh(&f); f.wait_flushed_rc = 0; ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    wg_boot_supervisor_exited(&boot, 1);
    CHECK(has(&f, "log:fault-unconfirmed") && has(&f, "power-off"));
}

static void test_a_late_not_ready_event_changes_nothing(void) {
    struct fake f; fresh(&f);
    f.supervisor_rc = -1;
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot, 0);
    int before = f.count;
    wg_boot_supervisor_not_ready(&boot, "supervisor-ready-timeout");        // the set already failed: no second answer, no second stop
    CHECK(f.count == before);
    fresh(&f); ops = ops_for(&f); wg_boot_init(&boot, &ops);
    to_running(&boot, 1);
    before = f.count;
    wg_boot_supervisor_not_ready(&boot, "supervisor-ready-line");           // already running
    CHECK(f.count == before && boot.conv_state == WG_CONV_RUNNING);
}

static void test_the_helper_gets_the_hosts_messages_in_every_live_phase_and_not_while_draining(void) {
    static const uint8_t body[] = "{\"v\":1}";
    for (int stage = 0; stage < 4; stage++) {
        struct fake f; fresh(&f);
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        if (stage == 1) to_mounted(&boot);
        if (stage >= 2) to_running(&boot, 1);
        if (stage == 3) { drain(&boot, NONCE, 1000); }
        int before = f.count;
        wg_boot_relay_message(&boot, CTL_BOOTSTRAP_DOWN, body, sizeof body - 1);
        if (stage == 3) CHECK(f.count == before);
        else CHECK(has(&f, "helper:b:7"));
    }
}

int main(void) {
    static const struct test_case tests[] = {
        T(test_bootstrap_payloads_flow_both_ways), T(test_a_bootstrap_payload_with_no_helper_is_dropped),
        T(test_replay_is_allowed_before_the_mount_for_known_purposes_only), T(test_replay_for_an_unknown_purpose_stops_the_guest),
        T(test_replay_after_the_mount_request_stops_the_guest), T(test_the_mount_happens_once_on_request_and_is_reported_to_the_helper),
        T(test_a_failed_mount_is_reported_and_leaves_nothing_mounted), T(test_a_malformed_mount_payload_stops_the_guest_without_mounting),
        T(test_done_without_a_mount_stops_the_guest), T(test_unknown_helper_and_relay_messages_stop_the_guest),
        T(test_a_relay_fatal_stops_the_guest_without_any_frame), T(test_the_supervisor_does_not_start_without_a_conversation_set),
        T(test_a_host_query_set_starts_the_supervisor_with_ports_and_the_live_boot_id), T(test_the_guided_profile_uses_its_own_key_and_a_tools_only_set_has_no_ports_or_runtime_key), T(test_a_second_or_early_conversation_set_is_a_helper_bug_and_stops_the_guest), T(test_malformed_conversation_payloads_are_refused_without_starting_anything), T(test_a_set_that_cannot_start_leaves_the_guest_up_and_tells_the_helper), T(test_a_supervisor_that_is_not_ready_fails_the_set_but_not_the_guest), T(test_a_failed_attempt_still_counts_as_the_one_attempt), T(test_fail_stop_faults_name_what_failed), T(test_a_fault_is_flushed_before_anything_else_happens_and_an_unconfirmed_one_is_logged), T(test_a_late_not_ready_event_changes_nothing), T(test_the_helper_gets_the_hosts_messages_in_every_live_phase_and_not_while_draining), T(test_a_helper_that_dies_after_the_mount_without_saying_done_stops_the_guest), T(test_a_helper_that_finishes_normally_and_exits_changes_nothing), T(test_a_helper_that_ends_before_any_mount_leaves_the_guest_up_for_the_host), T(test_the_supervisor_never_starts_before_the_mount_is_confirmed),
        T(test_the_supervisor_exiting_after_ready_stops_the_guest_with_a_supervisor_lost_fault),
        T(test_the_relay_exiting_stops_the_guest_without_frames), T(test_a_full_drain_runs_in_the_documented_order),
        T(test_halting_is_withheld_when_a_unmount_fails_and_the_guest_still_powers_off), T(test_a_busy_unmount_is_retried_after_killing_the_holders),
        T(test_the_unmount_attempts_are_bounded), T(test_a_drain_before_any_mount_has_nothing_to_unmount_and_is_still_orderly),
        T(test_a_zero_budget_still_ends_in_a_power_off), T(test_a_malformed_drain_stops_the_guest_without_an_ack),
        T(test_events_after_the_power_off_are_ignored), T(test_a_second_stop_cannot_start_while_the_first_runs),
        T(test_the_fail_stop_unmounts_and_syncs_but_sends_no_frames), T(test_a_failed_replay_that_left_the_volume_mounted_is_unmounted_before_halting), T(test_a_replay_volume_that_cannot_be_unmounted_withholds_halting), T(test_a_clean_replay_failure_leaves_nothing_to_unmount), T(test_a_mount_rollback_that_failed_is_tracked_and_verified), T(test_a_leftover_environment_volume_is_tracked_and_verified_too), T(test_halting_needs_a_verified_clean_superblock_on_every_mounted_volume), T(test_a_volume_that_was_never_mounted_is_not_verified), T(test_an_unconfirmed_halting_is_logged), T(test_mount_flags_options_and_order),
        T(test_a_failed_check_mounts_nothing), T(test_a_failed_data_mount_mounts_nothing_else_and_skips_the_skeleton), T(test_a_failed_skeleton_unmounts_the_data_volume), T(test_a_rollback_unmount_failure_is_reported_for_the_data_volume),
        T(test_journal_replay_is_mount_flush_unmount_and_never_executable), T(test_a_replay_that_cannot_flush_or_unmount_does_not_succeed),
        T(test_replay_refuses_unknown_purposes_and_failed_directories), T(test_a_mount_request_before_the_hosts_ready_stops_the_guest), T(test_a_ready_that_arrives_after_the_helper_is_gone_does_not_unlock_the_mount), T(test_the_devices_are_flushed_after_the_last_unmount_and_before_halting), T(test_a_failed_flush_withholds_halting_but_still_powers_off), T(test_no_flush_is_asked_for_a_volume_that_was_never_mounted_and_none_when_unmounting_failed),
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
