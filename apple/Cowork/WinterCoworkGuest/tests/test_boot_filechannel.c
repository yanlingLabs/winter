/*
 * Native tests of PID 1's file-channel decisions (WG_FILE_CHANNEL_V1 images only): the extended 'C' payload, the config's `fileChannel` member, the order of the
 * effects and the relay's go byte. A small recording fake of its own; the full state machine is test_boot.c's. Prints PASS/FAIL lines; driven by test_filechannel.py.
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
    char events[64][96];
    int count;
    int start_flags, device_rc, dirs_rc;
    uint64_t device;
    char config[70000];
    const char *base;
    unsigned dirs_roots[2];
    char first_source[300];
    uint32_t dirs_gid;
};
static void ev(struct fake *f, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    if (f->count < 64) vsnprintf(f->events[f->count++], sizeof f->events[0], fmt, args);
    va_end(args);
}
static int has(struct fake *f, const char *text) { for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return 1; return 0; }
static int index_of(struct fake *f, const char *text) { for (int i = 0; i < f->count; i++) if (strcmp(f->events[i], text) == 0) return i; return -1; }

static long long f_now(void *c) { (void)c; return 0; }
static void f_pause(void *c, unsigned ms) { (void)c; (void)ms; }
static void f_log(void *c, const char *code) { ev(c, "log:%s", code); }
static void f_to_relay(void *c, uint8_t tag, const void *p, size_t n) {
    if (tag == CTL_RUNTIME_GO) ev(c, "relay:G:%u", (unsigned)((const uint8_t *)p)[0]);
    else ev(c, "relay:%c:%zu", tag, n);
}
static void f_to_helper(void *c, uint8_t tag, const void *p, size_t n) {
    if (tag == CTL_CONVERSATIONS_RESULT) ev(c, "helper:r:%u:%u", (unsigned)((const uint8_t *)p)[0], (unsigned)((const uint8_t *)p)[1]);
    else ev(c, "helper:%c:%zu", tag, n);
}
static int f_wait_flushed(void *c, unsigned ms) { (void)c; (void)ms; return 1; }
static int f_replay(void *c, const char *purpose) { (void)c; (void)purpose; return 0; }
static int f_mount(void *c, const uint8_t *d, const uint8_t *e, int *leftover) { (void)d; (void)e; ev(c, "mount-volumes"); *leftover = 0; return 0; }
static int f_umount(void *c, int volume) { (void)c; (void)volume; return 0; }
static int f_verify(void *c, int volume, const uint8_t *uuid) { (void)c; (void)volume; (void)uuid; return 0; }
static int f_prepare_dirs(void *c, const struct wg_conversation_set *set) {
    struct fake *f = c;
    ev(c, "prepare-dirs");
    f->dirs_roots[0] = set->root_count[0];
    f->dirs_gid = set->workspace_gid[0];
    snprintf(f->first_source, sizeof f->first_source, "%s", set->root_source[0][0]);
    return f->dirs_rc;
}
static int f_read_artifacts(void *c, unsigned profile, char *out, size_t cap, size_t *len) { (void)c; (void)profile; snprintf(out, cap, "%s", V1_BLOCK); *len = strlen(out); return 0; }
static int f_read_base(void *c, char *out, size_t cap, size_t *len) { struct fake *f = c; snprintf(out, cap, "%s", f->base); *len = strlen(out); return 0; }
static int f_boot_id(void *c, char out[37]) { (void)c; strcpy(out, "66666666-6666-4666-8666-666666666666"); return 0; }
static int f_read_device(void *c, uint64_t *device) { struct fake *f = c; ev(c, "read-data-device"); *device = f->device; return f->device_rc; }
static int f_start_supervisor(void *c, const char *config, size_t len, int flags) {
    struct fake *f = c;
    ev(c, "start-supervisor");
    f->start_flags = flags;
    snprintf(f->config, sizeof f->config, "%.*s", (int)len, config);
    return 0;
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
        .read_data_device = f_read_device, .start_supervisor = f_start_supervisor, .stop_helper = f_stop_helper, .stop_supervisor = f_stop_supervisor,
        .kill_all = f_kill_all, .sync_all = f_sync, .flush_devices = f_flush, .power_off = f_power_off };
    return ops;
}
static void fresh(struct fake *f) {
    memset(f, 0, sizeof *f);
    f->base = "{\"artifacts\":{}}";
    f->device = 2049;
}

static const char READY_MESSAGE[] = "{\"v\":1,\"t\":\"ready\",\"operationId\":\"filesystem_55555555-5555-4555-8555-555555555555\",\"nonce\":\"" NONCE "\"}";
static const char MOUNT_PAYLOAD[] = UUID_DATA " " UUID_ENV;
static void to_mounted(struct wg_boot *boot) {
    wg_boot_relay_message(boot, CTL_BOOTSTRAP_DOWN, (const uint8_t *)READY_MESSAGE, sizeof READY_MESSAGE - 1);
    wg_boot_helper_message(boot, CTL_HELPER_MOUNT, (const uint8_t *)MOUNT_PAYLOAD, 73);
    wg_boot_helper_message(boot, CTL_HELPER_DONE, NULL, 0);
}

#define ITEMS "[{\"logicalSessionId\":\"s1\"}]"
static void put32(uint8_t *out, size_t *at, uint32_t v) { out[(*at)++] = (uint8_t)v; out[(*at)++] = (uint8_t)(v >> 8); out[(*at)++] = (uint8_t)(v >> 16); out[(*at)++] = (uint8_t)(v >> 24); }

struct spec {
    unsigned profile;
    int extended;
    uint32_t runtime_uid, browse_uid, gid;
    unsigned roots;
    int zero_roots;         /* a conversation that claims no roots at all */
    const char *source;     /* every root */
    const char *json;
};
static size_t payload_of(uint8_t *out, const struct spec *s) {
    size_t at = 0;
    out[at++] = (uint8_t)(s->profile | (s->extended ? WG_PAYLOAD_EXTENDED : 0));
    out[at++] = 1;
    put32(out, &at, s->runtime_uid ? s->runtime_uid : 20001);
    out[at++] = 2; out[at++] = 's'; out[at++] = '1';
    if (s->extended) {
        put32(out, &at, s->browse_uid);
        put32(out, &at, s->gid ? s->gid : 30001);
        unsigned roots = s->zero_roots ? 0 : s->roots ? s->roots : 1;
        out[at++] = (uint8_t)roots;
        for (unsigned r = 0; r < roots; r++) {
            const char *source = s->source ? s->source : "/workspace/repos/r1";
            out[at++] = (uint8_t)strlen(source);
            memcpy(out + at, source, strlen(source)); at += strlen(source);
        }
    }
    const char *json = s->json ? s->json : ITEMS;
    memcpy(out + at, json, strlen(json));
    return at + strlen(json);
}
static struct spec good(void) { struct spec s; memset(&s, 0, sizeof s); s.profile = 1; s.extended = 1; s.browse_uid = 40001; return s; }
static int parses(const struct spec *s, struct wg_conversation_set *set) {
    static uint8_t *exact;          /* set->json points into it */
    uint8_t scratch[2048];
    size_t n = payload_of(scratch, s);
    free(exact);
    exact = malloc(n);              /* exactly n bytes: a read past the end is an address-sanitizer error, not a lucky zero */
    memcpy(exact, scratch, n);
    return wg_parse_conversation_payload(exact, n, set);
}
static void to_running(struct wg_boot *boot, const struct spec *s) {
    to_mounted(boot);
    uint8_t payload[2048];
    size_t n = payload_of(payload, s);
    wg_boot_helper_message(boot, CTL_HELPER_CONVERSATIONS, payload, n);
    wg_boot_supervisor_ready(boot);
}

/* ------------------------------------------------------------------------------------------------ the payload */

static void test_the_extended_payload_carries_the_browse_uid_the_gid_and_the_roots(void) {
    struct wg_conversation_set set;
    struct spec s = good();
    s.roots = 3; s.source = "/workspace/repos/r1";
    CHECK(parses(&s, &set) == 0);
    CHECK(set.browse_uid == 40001 && set.workspace_gid[0] == 30001 && set.root_count[0] == 3 && set.runtime_uid[0] == 20001);
    CHECK(strcmp(set.root_source[0][2], "/workspace/repos/r1") == 0);
    CHECK(strncmp(set.json, ITEMS, strlen(ITEMS)) == 0 && set.json_length == strlen(ITEMS));
    s.browse_uid = 0;
    CHECK(parses(&s, &set) == 0 && set.browse_uid == 0);    /* no browse uid: the workspace has no file channel */
    s.extended = 0;
    CHECK(parses(&s, &set) == 0 && set.browse_uid == 0 && set.root_count[0] == 0);   /* the plain payload is still the plain payload */
}

static void test_every_departure_in_the_extension_is_refused(void) {
    struct wg_conversation_set set;
    uint32_t bad_ids[] = { 1, 999, 65534, 65535, 70000 };
    for (unsigned i = 0; i < sizeof bad_ids / sizeof bad_ids[0]; i++) {
        struct spec s = good(); s.browse_uid = bad_ids[i];
        CHECK(parses(&s, &set) != 0);
        s = good(); s.gid = bad_ids[i];
        CHECK(parses(&s, &set) != 0);
    }
    struct spec s = good(); s.browse_uid = 20001;           /* the runtime uid of the set */
    CHECK(parses(&s, &set) != 0);
    s = good(); s.browse_uid = 30001; s.gid = 30001;        /* the workspace gid */
    CHECK(parses(&s, &set) != 0);
    s = good(); s.gid = 20001;                               /* a group id equal to a uid is that user's private group */
    CHECK(parses(&s, &set) != 0);
    s = good(); s.roots = 17;
    CHECK(parses(&s, &set) != 0);
    s = good(); s.zero_roots = 1;
    CHECK(parses(&s, &set) != 0);
    s = good(); s.roots = 16;
    CHECK(parses(&s, &set) == 0);
    const char *bad_sources[] = { "", "/workspace", "/workspace/", "workspace/repos/a", "/work/repos/a", "/workspace//a", "/workspace/a/", "/workspace/./a", "/workspace/a/..", "/workspace/../a",
                                  "/workspace/a b", "/workspace/a\n", "/workspace/\xc3\xa9", "/workspace/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    for (unsigned i = 0; i < sizeof bad_sources / sizeof bad_sources[0]; i++) {
        s = good(); s.source = bad_sources[i];
        CHECK(parses(&s, &set) != 0);
    }
    s = good(); s.source = "/workspace/.winter/scratch/s1";
    CHECK(parses(&s, &set) == 0);
    char component[120];
    memset(component, 'a', sizeof component);
    snprintf(component, sizeof component, "/workspace/repos/%s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");   /* 64 */
    s = good(); s.source = component;
    CHECK(parses(&s, &set) == 0);
    snprintf(component, sizeof component, "/workspace/repos/%s", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");  /* 65 */
    CHECK(parses(&s, &set) != 0);
    /* a source too short to hold the prefix whose missing bytes are the items JSON that follows it: it must not be read as "/workspace/" */
    s = good(); s.source = "/wo"; s.json = "rkspace/x[]";
    CHECK(parses(&s, &set) != 0);
    s = good(); s.source = "/workspace/.winter/scratch/s1";
    uint8_t payload[2048];
    size_t n = payload_of(payload, &s);
    for (size_t cut = 0; cut < n - strlen(ITEMS); cut++) CHECK(wg_parse_conversation_payload(payload, cut, &set) != 0);   /* every truncation inside the header or the extension */
}

/* ------------------------------------------------------------------------------------------------ the boot flow */

static void test_a_workspace_with_a_browse_uid_gets_the_file_channel_in_its_config_its_flags_and_its_go_byte(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    struct spec s = good();
    to_running(&boot, &s);
    CHECK(f.start_flags == (WG_START_PORTS | WG_START_FILE_CHANNEL));
    const char *member = ",\"fileChannel\":{\"browseUid\":40001,\"dataDevice\":2049}}";
    size_t length = strlen(f.config);
    CHECK(length > strlen(member) && strcmp(f.config + length - strlen(member), member) == 0);   /* the last member, after the runtime block */
    CHECK(has(&f, "relay:G:3"));
    CHECK(index_of(&f, "read-data-device") < index_of(&f, "prepare-dirs") && index_of(&f, "prepare-dirs") < index_of(&f, "start-supervisor"));
    CHECK(f.dirs_roots[0] == 1 && f.dirs_gid == 30001 && strcmp(f.first_source, "/workspace/repos/r1") == 0);
}

static void test_a_tools_only_set_with_a_browse_uid_still_has_a_file_service(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    struct spec s = good(); s.profile = 0;
    to_running(&boot, &s);
    CHECK(f.start_flags == WG_START_FILE_CHANNEL);
    CHECK(strstr(f.config, "\"fileChannel\":{\"browseUid\":40001,\"dataDevice\":2049}") != NULL);
    CHECK(has(&f, "relay:G:2"));
}

static void test_without_a_browse_uid_nothing_changes(void) {
    struct fake f; fresh(&f);
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    struct spec s = good(); s.browse_uid = 0;
    to_running(&boot, &s);
    CHECK(f.start_flags == WG_START_PORTS);
    CHECK(strstr(f.config, "fileChannel") == NULL);
    CHECK(has(&f, "relay:G:1") && !has(&f, "read-data-device"));
    struct fake g; fresh(&g);
    struct wg_boot_ops gops = ops_for(&g);
    struct wg_boot gboot; wg_boot_init(&gboot, &gops);
    s = good(); s.extended = 0;
    to_running(&gboot, &s);
    CHECK(g.start_flags == WG_START_PORTS && has(&g, "relay:G:1") && strstr(g.config, "fileChannel") == NULL);
}

static void test_a_data_device_that_cannot_be_read_or_is_zero_fails_the_set_before_anything_starts(void) {
    for (int mode = 0; mode < 2; mode++) {
        struct fake f; fresh(&f);
        if (mode == 0) f.device_rc = -1; else f.device = 0;
        struct wg_boot_ops ops = ops_for(&f);
        struct wg_boot boot; wg_boot_init(&boot, &ops);
        struct spec s = good();
        to_mounted(&boot);
        uint8_t payload[2048];
        size_t n = payload_of(payload, &s);
        wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, payload, n);
        CHECK(has(&f, "helper:r:2:0") && has(&f, "log:file-channel-config-failed"));
        CHECK(!has(&f, "start-supervisor") && !has(&f, "prepare-dirs") && !has(&f, "power-off"));   /* the guest stays up for the drain */
    }
}

static void test_a_static_config_that_names_file_channel_is_refused(void) {
    struct fake f; fresh(&f);
    f.base = "{\"fileChannel\":{\"browseUid\":1000,\"dataDevice\":1}}";
    struct wg_boot_ops ops = ops_for(&f);
    struct wg_boot boot; wg_boot_init(&boot, &ops);
    struct spec s = good();
    to_mounted(&boot);
    uint8_t payload[2048];
    size_t n = payload_of(payload, &s);
    wg_boot_helper_message(&boot, CTL_HELPER_CONVERSATIONS, payload, n);
    CHECK(has(&f, "log:file-channel-config-failed") && !has(&f, "start-supervisor"));
}

static void test_add_file_channel_checks_what_it_writes(void) {
    char config[256];
    size_t length = 0;
    snprintf(config, sizeof config, "{\"a\":1}");
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) == 0);
    CHECK(strcmp(config, "{\"a\":1,\"fileChannel\":{\"browseUid\":1000,\"dataDevice\":5}}") == 0 && length == strlen(config));
    snprintf(config, sizeof config, "{\"a\":1}");
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 999, 5, &length) != 0);
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 65534, 5, &length) != 0);
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 0, &length) != 0);
    CHECK(wg_add_file_channel(config, strlen(config), strlen(config) + 20, 1000, 5, &length) != 0);   /* does not fit with its terminator */
    snprintf(config, sizeof config, "{\"a\":1}");
    size_t member = strlen(",\"fileChannel\":{\"browseUid\":1000,\"dataDevice\":5}");
    CHECK(wg_add_file_channel(config, strlen(config), strlen(config) + member, 1000, 5, &length) != 0);        /* no room for the terminator */
    CHECK(wg_add_file_channel(config, strlen(config), strlen(config) + member + 1, 1000, 5, &length) == 0);    /* exactly enough */
    snprintf(config, sizeof config, "[1]");
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) != 0);
    snprintf(config, sizeof config, "{\"a\":1");              /* not closed */
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) != 0);
    snprintf(config, sizeof config, "x\"a\":1}");              /* not an object */
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) != 0);
    snprintf(config, sizeof config, "{}");                       /* an empty object takes the member too */
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) == 0 && strcmp(config, "{\"fileChannel\":{\"browseUid\":1000,\"dataDevice\":5}}") == 0);
    {
        char *heap = malloc(8);                                   /* length 0 must not read config[-1] */
        CHECK(wg_add_file_channel(heap, 0, 8, 1000, 5, &length) != 0);
        free(heap);
        size_t big = 59990;                                       /* with the member the config would pass WG_CONFIG_MAX_BYTES (60000) though the buffer is large */
        char *large = malloc(70000);
        memset(large, 'a', big);
        large[0] = '{'; large[big - 1] = '}'; large[big] = '\0';
        CHECK(wg_add_file_channel(large, big, 70000, 1000, 5, &length) != 0);
        free(large);
    }
    snprintf(config, sizeof config, "{\"x\":{\"fileChannel\":1},\"fileChannel\":2}");
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 5, &length) != 0);
    snprintf(config, sizeof config, "{\"x\":{\"fileChannel\":1}}");   /* a nested mention is not a top-level key */
    CHECK(wg_add_file_channel(config, strlen(config), sizeof config, 1000, 18446744073709551615ull, &length) == 0);
    CHECK(strstr(config, "\"dataDevice\":18446744073709551615}}") != NULL);
}

#define RUN(fn) do { current_name = #fn; current_failed = 0; fn(); if (current_failed) failures++; else printf("PASS %s\n", #fn); } while (0)

int main(void) {
    RUN(test_the_extended_payload_carries_the_browse_uid_the_gid_and_the_roots);
    RUN(test_every_departure_in_the_extension_is_refused);
    RUN(test_a_workspace_with_a_browse_uid_gets_the_file_channel_in_its_config_its_flags_and_its_go_byte);
    RUN(test_a_tools_only_set_with_a_browse_uid_still_has_a_file_service);
    RUN(test_without_a_browse_uid_nothing_changes);
    RUN(test_a_data_device_that_cannot_be_read_or_is_zero_fails_the_set_before_anything_starts);
    RUN(test_a_static_config_that_names_file_channel_is_refused);
    RUN(test_add_file_channel_checks_what_it_writes);
    return failures ? 1 : 0;
}
