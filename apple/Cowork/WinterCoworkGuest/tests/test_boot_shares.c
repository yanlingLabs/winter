/*
 * Native tests of PID 1's share step (WG_FILE_CHANNEL_V1 images only): the 'S' payload, when 'S' is accepted, what the answer 's' says, that no set follows a failed
 * step, and that the drain unmounts the shares before the ext4 volumes and withholds `halting` while one is still mounted. A recording fake of its own; the
 * effects themselves are shares.c's (test_shares.py). Prints PASS/FAIL lines; driven by test_shares.py.
 */
#define _GNU_SOURCE
#include "../common/ctl.h"
#include "../init/boot.h"
#include "../init/trusted_config.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NONCE "0123456789abcdef0123456789abcdef"
#define UUID_DATA "11111111-2222-4333-8444-555555555555"
#define UUID_ENV "66666666-7777-4888-8999-aaaaaaaaaaaa"
#define V1_BLOCK "{\"artifacts\":{\"executable\":{\"path\":\"/opt/winter/runtime/winter-host-query\",\"sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\"},\"launcher\":{\"path\":\"/opt/winter/helpers/linux-runtime-compartment\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},\"ownerLibrary\":{\"path\":\"/opt/winter/helpers/linux-session-owner.so\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}}}"

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

struct fake {
    char events[96][96];
    int count;
    int shares_result;
    unsigned shares_mask;            /* what mount_shares reports as mounted; ~0u: every share of the set */
    const char *stuck_share;         /* a guest path whose unmount always fails */
    struct wg_share_set seen;
};
static void ev(struct fake *f, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (f->count < 96) vsnprintf(f->events[f->count++], sizeof f->events[0], fmt, args);
    va_end(args);
}
static int has(struct fake *f, const char *text) { for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return 1; return 0; }
static int index_of(struct fake *f, const char *text) { for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return i; return -1; }
static int count_of(struct fake *f, const char *prefix) { int n = 0; for (int i = 0; i < f->count; i++) n += strncmp(f->events[i], prefix, strlen(prefix)) == 0; return n; }

static long long f_now(void *c) { (void)c; return 0; }
static void f_pause(void *c, unsigned ms) { (void)c; (void)ms; }
static void f_log(void *c, const char *code) { ev(c, "log:%s", code); }
static void f_to_relay(void *c, uint8_t tag, const void *p, size_t n) { (void)p; ev(c, "relay:%c:%zu", tag, n); }
static void f_to_helper(void *c, uint8_t tag, const void *p, size_t n) {
    if (n == 1) ev(c, "helper:%c:%u", tag, (unsigned)((const uint8_t *)p)[0]);
    else if (n == 2) ev(c, "helper:%c:%u:%u", tag, (unsigned)((const uint8_t *)p)[0], (unsigned)((const uint8_t *)p)[1]);
    else ev(c, "helper:%c:%zu", tag, n);
}
static int f_wait_flushed(void *c, unsigned ms) { (void)c; (void)ms; return 1; }
static int f_replay(void *c, const char *purpose) { (void)c; (void)purpose; return 0; }
static int f_mount(void *c, const uint8_t *d, const uint8_t *e, int *leftover) { (void)d; (void)e; ev(c, "mount-volumes"); *leftover = 0; return 0; }
static int f_umount(void *c, int volume) { ev(c, "umount-volume:%d", volume); return 0; }
static int f_verify(void *c, int volume, const uint8_t *uuid) { (void)c; (void)volume; (void)uuid; return 0; }
static int f_prepare_dirs(void *c, const struct wg_conversation_set *set) { (void)set; ev(c, "prepare-dirs"); return 0; }
static int f_read_artifacts(void *c, unsigned profile, char *out, size_t cap, size_t *len) { (void)c; (void)profile; snprintf(out, cap, "%s", V1_BLOCK); *len = strlen(out); return 0; }
static int f_read_base(void *c, char *out, size_t cap, size_t *len) { (void)c; snprintf(out, cap, "{\"artifacts\":{}}"); *len = strlen(out); return 0; }
static int f_boot_id(void *c, char out[37]) { (void)c; strcpy(out, "66666666-6666-4666-8666-666666666666"); return 0; }
static int f_read_device(void *c, uint64_t *device) { (void)c; *device = 2049; return 0; }
static int f_start_supervisor(void *c, const char *config, size_t len, int flags) { (void)config; (void)len; (void)flags; ev(c, "start-supervisor"); return 0; }
static int f_mount_shares(void *c, const struct wg_share_set *set, unsigned *mounted) {
    struct fake *f = c;
    f->seen = *set;
    ev(c, "mount-shares:%u", set->count);
    *mounted = f->shares_mask == ~0u ? (1u << set->count) - 1u : f->shares_mask;
    return f->shares_result;
}
static int f_umount_share(void *c, const char *guest_path) {
    struct fake *f = c;
    ev(c, "umount-share:%s", guest_path);
    return f->stuck_share && strcmp(f->stuck_share, guest_path) == 0 ? -1 : 0;
}
static void f_stop_helper(void *c, long long d) { (void)c; (void)d; }
static void f_stop_supervisor(void *c, long long d) { (void)c; (void)d; }
static void f_kill_all(void *c) { (void)c; }
static void f_sync(void *c) { (void)c; }
static int f_flush(void *c, unsigned v) { (void)c; (void)v; return 0; }
static void f_power_off(void *c) { ev(c, "power-off"); }

static struct wg_boot_ops ops_for(struct fake *f) {
    struct wg_boot_ops ops = { .ctx = f, .now_ms = f_now, .pause_ms = f_pause, .log = f_log, .to_relay = f_to_relay, .to_helper = f_to_helper,
        .wait_flushed = f_wait_flushed, .replay = f_replay, .mount_volumes = f_mount, .umount = f_umount, .verify_unmounted = f_verify,
        .prepare_conversation_dirs = f_prepare_dirs, .read_runtime_artifacts = f_read_artifacts, .read_base_config = f_read_base, .read_boot_id = f_boot_id,
        .read_data_device = f_read_device, .mount_shares = f_mount_shares, .umount_share = f_umount_share, .start_supervisor = f_start_supervisor,
        .stop_helper = f_stop_helper, .stop_supervisor = f_stop_supervisor, .kill_all = f_kill_all, .sync_all = f_sync, .flush_devices = f_flush, .power_off = f_power_off };
    return ops;
}
static void fresh(struct fake *f) { memset(f, 0, sizeof *f); f->shares_result = WG_SHARES_MOUNTED; f->shares_mask = ~0u; }

static const char READY_MESSAGE[] = "{\"v\":1,\"t\":\"ready\",\"operationId\":\"filesystem_55555555-5555-4555-8555-555555555555\",\"nonce\":\"" NONCE "\"}";
static const char MOUNT_PAYLOAD[] = UUID_DATA " " UUID_ENV;
static void to_mounted_without_done(struct wg_boot *boot) {
    wg_boot_relay_message(boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)READY_MESSAGE, sizeof READY_MESSAGE - 1);
    wg_boot_helper_message(boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
}
static void to_mounted(struct wg_boot *boot) {
    to_mounted_without_done(boot);
    wg_boot_helper_message(boot, CTL_HELPER_DONE, NULL, 0);
}

/* ------------------------------------------------------------------------------------------------ payloads */

struct item { unsigned kind, flags; const char *tag, *path; };
static size_t share_payload(uint8_t *out, const struct item *items, unsigned count) {
    size_t at = 0;
    out[at++] = (uint8_t)count;
    for (unsigned i = 0; i < count; i++) {
        out[at++] = (uint8_t)items[i].kind; out[at++] = (uint8_t)items[i].flags;
        out[at++] = (uint8_t)strlen(items[i].tag); memcpy(out + at, items[i].tag, strlen(items[i].tag)); at += strlen(items[i].tag);
        out[at++] = (uint8_t)strlen(items[i].path); memcpy(out + at, items[i].path, strlen(items[i].path)); at += strlen(items[i].path);
    }
    return at;
}
static const struct item FOUR[4] = {
    { WG_SHARE_FOLDER, 0, "src-0", "/workspace/folders/notes" }, { WG_SHARE_GUIDANCE, 1, "winter-guidance", "/run/winter/shared-instructions" },
    { WG_SHARE_MEMORY, 0, "winter-memory", "/workspace/.winter/memory" }, { WG_SHARE_OUTPUTS, 0, "winter-outputs", "/workspace/outputs" },
};
/* The parser on exactly `n` bytes of `bytes`, in a heap block of exactly that size: a read past the payload is an address-sanitizer error, never a lucky byte. */
static int parses_exactly(const uint8_t *bytes, size_t n) {
    uint8_t *exact = malloc(n ? n : 1);
    memcpy(exact, bytes, n);
    static struct wg_share_set set;
    int rc = wg_parse_share_payload(exact, n, &set);
    free(exact);
    return rc;
}
static int parses(const struct item *items, unsigned count) {
    uint8_t scratch[4096];
    size_t n = share_payload(scratch, items, count);
    uint8_t *exact = malloc(n);   /* exactly n bytes: a read past the end is an address-sanitizer error */
    memcpy(exact, scratch, n);
    static struct wg_share_set set;
    int rc = wg_parse_share_payload(exact, n, &set);
    free(exact);
    return rc;
}
static void send_shares(struct wg_boot *boot, const struct item *items, unsigned count) {
    uint8_t payload[4096];
    size_t n = share_payload(payload, items, count);
    wg_boot_helper_message(boot, CTL_HELPER_SHARES, payload, n);
}
#define ITEMS "[{\"logicalSessionId\":\"s1\"}]"
static void send_conversations(struct wg_boot *boot) {
    /* the plain payload: one host-query conversation, no file channel */
    uint8_t payload[256];
    size_t at = 0;
    payload[at++] = 1; payload[at++] = 1;
    payload[at++] = 0x21; payload[at++] = 0x4e; payload[at++] = 0; payload[at++] = 0;   /* runtime uid 20001 */
    payload[at++] = 2; payload[at++] = 's'; payload[at++] = '1';
    memcpy(payload + at, ITEMS, strlen(ITEMS)); at += strlen(ITEMS);
    wg_boot_helper_message(boot, CTL_HELPER_CONVERSATIONS, payload, at);
}
static void drain(struct wg_boot *boot) {
    uint8_t payload[CTL_DRAIN_PAYLOAD_BYTES];
    memcpy(payload, NONCE, 32);
    payload[32] = 0x10; payload[33] = 0x27; payload[34] = 0; payload[35] = 0; payload[36] = 0;
    wg_boot_relay_message(boot, CTL_DRAIN, payload, sizeof payload);
}

static void test_the_payload_carries_every_share_with_its_kind_mode_tag_and_path(void) {
    uint8_t payload[4096];
    size_t n = share_payload(payload, FOUR, 4);
    static struct wg_share_set set;
    CHECK(wg_parse_share_payload(payload, n, &set) == 0 && set.count == 4);
    CHECK(set.item[0].kind == WG_SHARE_FOLDER && !set.item[0].read_only && strcmp(set.item[0].tag, "src-0") == 0 && strcmp(set.item[0].guest_path, "/workspace/folders/notes") == 0);
    CHECK(set.item[1].kind == WG_SHARE_GUIDANCE && set.item[1].read_only && strcmp(set.item[1].guest_path, "/run/winter/shared-instructions") == 0);
    CHECK(set.item[3].kind == WG_SHARE_OUTPUTS && !set.item[3].read_only);
    struct item ro_folder = { WG_SHARE_FOLDER, 1, "src-1", "/workspace/folders/photos" };
    CHECK(parses(&ro_folder, 1) == 0);   /* a folder is read-only or read-write as its grant says */
    for (unsigned cut = 0; cut < n; cut++) CHECK(parses_exactly(payload, cut) != 0);   /* every truncation, each in a block of exactly its own size */
    /* a path length that claims more than the payload still holds (the payload ends inside the last path) */
    struct item one = { WG_SHARE_FOLDER, 0, "src-0", "/workspace/folders/notes" };
    uint8_t single[256];
    size_t m = share_payload(single, &one, 1);
    single[m - strlen(one.path) - 1] = (uint8_t)(strlen(one.path) + 1);
    CHECK(parses_exactly(single, m) != 0);
    payload[n] = 0;
    CHECK(wg_parse_share_payload(payload, n + 1, &set) != 0);   /* a byte after the last share */
}

static void test_every_departure_from_the_contracts_share_rules_is_refused(void) {
    struct item s[13];
    memcpy(s, FOUR, sizeof FOUR);
    s[1].flags = 0; CHECK(parses(s, 4) != 0);                       /* guidance writable */
    memcpy(s, FOUR, sizeof FOUR); s[2].flags = 1; CHECK(parses(s, 4) != 0);   /* memory read-only */
    memcpy(s, FOUR, sizeof FOUR); s[3].flags = 1; CHECK(parses(s, 4) != 0);   /* outputs read-only */
    memcpy(s, FOUR, sizeof FOUR); s[0].flags = 2; CHECK(parses(s, 4) != 0);   /* an unknown flag */
    memcpy(s, FOUR, sizeof FOUR); s[0].kind = 4; CHECK(parses(s, 4) != 0);    /* an unknown kind */
    memcpy(s, FOUR, sizeof FOUR); s[3].path = "/workspace/output"; CHECK(parses(s, 4) != 0);
    memcpy(s, FOUR, sizeof FOUR); s[2].path = "/workspace/.winter/memory/x"; CHECK(parses(s, 4) != 0);
    memcpy(s, FOUR, sizeof FOUR); s[1].path = "/run/winter/shared-instructions/"; CHECK(parses(s, 4) != 0);
    memcpy(s, FOUR, sizeof FOUR); s[1].tag = "src-0"; CHECK(parses(s, 4) != 0);   /* a repeated tag */
    memcpy(s, FOUR, sizeof FOUR); s[2].kind = WG_SHARE_FOLDER; s[2].path = "/workspace/folders/notes"; CHECK(parses(s, 4) != 0);   /* a repeated path */
    memcpy(s, FOUR, sizeof FOUR); s[3] = s[2]; s[3].tag = "winter-memory-2"; s[3].path = "/workspace/.winter/memory"; CHECK(parses(s, 4) != 0);   /* two memory shares */
    const char *bad_folders[] = { "/workspace/folders/", "/workspace/folders/a/b", "/workspace/folders/.x", "/workspace/folders/_x", "/workspace/folders/..",
                                  "/workspace/folders/a b", "/workspace/repos/a", "/workspace/foldersx", "/workspace/folders/\xc3\xa9" };
    for (unsigned i = 0; i < sizeof bad_folders / sizeof bad_folders[0]; i++) { memcpy(s, FOUR, sizeof FOUR); s[0].path = bad_folders[i]; CHECK(parses(s, 4) != 0); }
    char long_name[200];
    snprintf(long_name, sizeof long_name, "/workspace/folders/a%0127d", 0);   /* 128 characters: the longest name */
    memcpy(s, FOUR, sizeof FOUR); s[0].path = long_name; CHECK(parses(s, 4) == 0);
    snprintf(long_name, sizeof long_name, "/workspace/folders/a%0128d", 0);   /* 129 */
    CHECK(parses(s, 4) != 0);
    const char *bad_tags[] = { "", "Src-0", "src_0", "src.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    for (unsigned i = 0; i < sizeof bad_tags / sizeof bad_tags[0]; i++) { memcpy(s, FOUR, sizeof FOUR); s[0].tag = bad_tags[i]; CHECK(parses(s, 4) != 0); }
    memcpy(s, FOUR, sizeof FOUR); s[0].tag = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; CHECK(parses(s, 4) == 0);   /* 32 */
    /* at most nine folders, at most twelve shares, at least one */
    static char tags[12][8], paths[12][40];
    for (unsigned i = 0; i < 10; i++) {
        snprintf(tags[i], sizeof tags[i], "src-%u", i); snprintf(paths[i], sizeof paths[i], "/workspace/folders/f%u", i);
        s[i].kind = WG_SHARE_FOLDER; s[i].flags = 0; s[i].tag = tags[i]; s[i].path = paths[i];
    }
    CHECK(parses(s, 9) == 0);
    CHECK(parses(s, 10) != 0);
    memcpy(s + 9, FOUR + 1, 3 * sizeof FOUR[0]);
    CHECK(parses(s, 12) == 0);
    uint8_t payload[4096];
    size_t n = share_payload(payload, s, 12);
    payload[0] = 13;
    static struct wg_share_set set;
    CHECK(wg_parse_share_payload(payload, n, &set) != 0);
    uint8_t none[1] = { 0 };
    CHECK(wg_parse_share_payload(none, 1, &set) != 0);
}

/* ------------------------------------------------------------------------------------------------ when 'S' is accepted, and what follows */

static void test_a_mounted_set_is_answered_yes_and_the_conversation_set_starts_after_it(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_shares(&boot, FOUR, 4);
    CHECK(has(&f, "mount-shares:4") && has(&f, "helper:s:0"));
    CHECK(f.seen.count == 4 && strcmp(f.seen.item[2].guest_path, "/workspace/.winter/memory") == 0);
    send_conversations(&boot);
    CHECK(has(&f, "start-supervisor") && index_of(&f, "helper:s:0") < index_of(&f, "start-supervisor"));
    CHECK(!has(&f, "power-off"));
}

static void test_the_share_step_is_accepted_only_after_the_mount_and_before_any_set_and_only_once(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted_without_done(&boot);                       /* the volumes are mounted, but the helper has not said 'E' */
    send_shares(&boot, FOUR, 4);
    CHECK(has(&f, "log:shares-out-of-order") && !has(&f, "mount-shares:4"));
    struct fake g; fresh(&g);
    struct wg_boot_ops gops = ops_for(&g);
    struct wg_boot gboot; wg_boot_init(&gboot, &gops);
    send_shares(&gboot, FOUR, 4);                         /* before anything is mounted */
    CHECK(has(&g, "log:shares-out-of-order") && !has(&g, "mount-shares:4"));
    struct fake h; fresh(&h);
    struct wg_boot_ops hops = ops_for(&h);
    struct wg_boot hboot; wg_boot_init(&hboot, &hops);
    to_mounted(&hboot);
    send_conversations(&hboot);
    send_shares(&hboot, FOUR, 4);                         /* after the set */
    CHECK(has(&h, "log:shares-out-of-order") && !has(&h, "mount-shares:4"));
    struct fake k; fresh(&k);
    struct wg_boot_ops kops = ops_for(&k);
    struct wg_boot kboot; wg_boot_init(&kboot, &kops);
    to_mounted(&kboot);
    send_shares(&kboot, FOUR, 4);
    send_shares(&kboot, FOUR, 4);                         /* a second step */
    CHECK(count_of(&k, "mount-shares:") == 1 && has(&k, "log:shares-out-of-order"));
}

static void test_a_failed_step_is_answered_with_its_fault_and_no_set_may_follow(void) {
    int results[3] = { WG_SHARES_INVENTORY, WG_SHARES_MOUNT_FAILED, 9 };
    const char *answers[3] = { "helper:s:1", "helper:s:2", "helper:s:2" };
    for (int i = 0; i < 3; i++) {
        struct fake f; fresh(&f);
        f.shares_result = results[i];
        f.shares_mask = 0;
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        to_mounted(&boot);
        send_shares(&boot, FOUR, 4);
        CHECK(has(&f, answers[i]));
        send_conversations(&boot);
        CHECK(has(&f, "log:conversations-after-failed-shares") && !has(&f, "start-supervisor"));
    }
}

static void test_a_yes_that_does_not_cover_every_share_is_a_failure(void) {
    struct fake f; fresh(&f);
    f.shares_mask = 0x7;                                  /* three of four */
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_shares(&boot, FOUR, 4);
    CHECK(has(&f, "helper:s:2") && !has(&f, "helper:s:0"));
    send_conversations(&boot);
    CHECK(!has(&f, "start-supervisor"));
}

static void test_a_payload_pid_1_refuses_mounts_nothing(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    struct item s[4];
    memcpy(s, FOUR, sizeof FOUR);
    s[1].flags = 0;                                       /* guidance writable */
    send_shares(&boot, s, 4);
    CHECK(has(&f, "helper:s:2") && !has(&f, "mount-shares:4") && has(&f, "log:shares-payload"));
    send_conversations(&boot);
    CHECK(!has(&f, "start-supervisor"));
}

/* ------------------------------------------------------------------------------------------------ the drain */

static void test_the_drain_unmounts_the_shares_last_first_and_before_the_data_volume(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_shares(&boot, FOUR, 4);
    send_conversations(&boot);
    wg_boot_supervisor_ready(&boot);
    drain(&boot);
    int outputs = index_of(&f, "umount-share:/workspace/outputs"), memory = index_of(&f, "umount-share:/workspace/.winter/memory");
    int guidance = index_of(&f, "umount-share:/run/winter/shared-instructions"), folder = index_of(&f, "umount-share:/workspace/folders/notes");
    int data = index_of(&f, "umount-volume:0");
    CHECK(outputs >= 0 && outputs < memory && memory < guidance && guidance < folder && folder < data);
    CHECK(has(&f, "relay:H:32") && count_of(&f, "umount-share:") == 4);
}

static void test_a_share_that_stays_mounted_withholds_halting_and_the_data_volume_is_never_unmounted_under_it(void) {
    struct fake f; fresh(&f);
    f.stuck_share = "/workspace/.winter/memory";
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_shares(&boot, FOUR, 4);
    drain(&boot);
    CHECK(!has(&f, "relay:H:32") && !has(&f, "umount-volume:0"));
    CHECK(has(&f, "relay:X:33"));                          /* the fault after the drain_ack, with the drain's nonce */
    CHECK(count_of(&f, "umount-share:/workspace/outputs") == 1);   /* what came off stays off */
}

static void test_what_a_failed_step_left_mounted_is_unmounted_by_the_drain(void) {
    struct fake f; fresh(&f);
    f.shares_result = WG_SHARES_MOUNT_FAILED;
    f.shares_mask = 0x2;                                  /* the guidance share's rollback unmount did not succeed */
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_shares(&boot, FOUR, 4);
    drain(&boot);
    CHECK(count_of(&f, "umount-share:") == 1 && has(&f, "umount-share:/run/winter/shared-instructions"));
    CHECK(index_of(&f, "umount-share:/run/winter/shared-instructions") < index_of(&f, "umount-volume:0") && has(&f, "relay:H:32"));
}

static void test_without_a_share_set_nothing_changes(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    to_mounted(&boot);
    send_conversations(&boot);
    wg_boot_supervisor_ready(&boot);
    drain(&boot);
    CHECK(has(&f, "start-supervisor") && count_of(&f, "umount-share:") == 0 && !has(&f, "mount-shares:4") && has(&f, "umount-volume:0") && has(&f, "relay:H:32"));
}

#define RUN(fn) do { current_name = #fn; current_failed = 0; fn(); if (current_failed) failures++; else printf("PASS %s\n", #fn); } while (0)

int main(void) {
    RUN(test_the_payload_carries_every_share_with_its_kind_mode_tag_and_path);
    RUN(test_every_departure_from_the_contracts_share_rules_is_refused);
    RUN(test_a_mounted_set_is_answered_yes_and_the_conversation_set_starts_after_it);
    RUN(test_the_share_step_is_accepted_only_after_the_mount_and_before_any_set_and_only_once);
    RUN(test_a_failed_step_is_answered_with_its_fault_and_no_set_may_follow);
    RUN(test_a_yes_that_does_not_cover_every_share_is_a_failure);
    RUN(test_a_payload_pid_1_refuses_mounts_nothing);
    RUN(test_the_drain_unmounts_the_shares_last_first_and_before_the_data_volume);
    RUN(test_a_share_that_stays_mounted_withholds_halting_and_the_data_volume_is_never_unmounted_under_it);
    RUN(test_what_a_failed_step_left_mounted_is_unmounted_by_the_drain);
    RUN(test_without_a_share_set_nothing_changes);
    return failures ? 1 : 0;
}
