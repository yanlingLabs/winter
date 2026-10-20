#include "boot.h"

#include "../common/ctl.h"
#include "../common/wmx.h"
#include "ext4sb.h"
#include "trusted_config.h"

#include <stdio.h>
#include <string.h>

#define FLUSH_WAIT_MS 3000u
#define UMOUNT_ATTEMPTS 4
#define FAIL_STOP_BUDGET_MS 10000u

static char runtime_buffer[WG_CONFIG_RUNTIME_MAX + 1];
static char base_buffer[WG_CONFIG_BASE_MAX + 1];
static char config_buffer[WG_CONFIG_MAX_BYTES + 1];

void wg_boot_init(struct wg_boot *boot, const struct wg_boot_ops *ops) {
    memset(boot, 0, sizeof *boot);
    boot->ops = ops;
    boot->phase = WG_PHASE_BOOTSTRAP;
    boot->helper_alive = 1;
}

static void note(struct wg_boot *boot, const char *code) { boot->ops->log(boot->ops->ctx, code); }

static const char *const PURPOSES[2] = { "data", "environment" };

#ifdef WG_FILE_CHANNEL_V1
static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

/* A root's `source` as PID 1 will walk it: /workspace/ and then components of [A-Za-z0-9._-], none empty, "." or ".." (the helper checked the same; PID 1 acts on it, so it checks again). */
static int root_source_ok(const uint8_t *text, size_t length) {
    static const char prefix[] = "/workspace/";
    if (length < sizeof prefix || memcmp(text, prefix, sizeof prefix - 1) != 0) return 0;   /* (the length is a byte: at most WG_ROOT_SOURCE_MAX) */
    size_t component = 0;
    for (size_t i = sizeof prefix - 1; i <= length; i++) {
        char c = i < length ? (char)text[i] : '/';
        if (c == '/') {
            const uint8_t *start = text + i - component;
            if (component == 0 || (component == 1 && start[0] == '.') || (component == 2 && start[0] == '.' && start[1] == '.')) return 0;
            component = 0;
        } else {
            int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok || ++component > 64) return 0;
        }
    }
    return 1;
}
#endif

int wg_parse_conversation_payload(const uint8_t *payload, size_t length, struct wg_conversation_set *out) {
#ifdef WG_FILE_CHANNEL_V1
    int extended = length >= 1 && (payload[0] & WG_PAYLOAD_EXTENDED) != 0;
    unsigned profile_byte = length >= 1 ? payload[0] & ~WG_PAYLOAD_EXTENDED : 0;
    if (length < 2 || profile_byte > 2 || payload[1] < 1 || payload[1] > WG_CONVERSATIONS_MAX) return -1;
    if (profile_byte != 0 && payload[1] != 1) return -1;   /* N2: ONE host-query conversation per guest */
    memset(out, 0, sizeof *out);
    out->profile = profile_byte;
#else
    if (length < 2 || payload[0] > 2 || payload[1] < 1 || payload[1] > WG_CONVERSATIONS_MAX) return -1;
    if (payload[0] != 0 && payload[1] != 1) return -1;   /* N2: ONE host-query conversation per guest */
    memset(out, 0, sizeof *out);
    out->profile = payload[0];
#endif
    out->count = payload[1];
    size_t at = 2;
    for (unsigned i = 0; i < out->count; i++) {
        if (length - at < 5) return -1;
        uint32_t uid = (uint32_t)payload[at] | ((uint32_t)payload[at + 1] << 8) | ((uint32_t)payload[at + 2] << 16) | ((uint32_t)payload[at + 3] << 24);
        size_t id_length = payload[at + 4];
        at += 5;
        if (uid < WG_UNIX_ID_MIN || uid > WG_UNIX_ID_MAX || id_length < 1 || id_length > WG_SESSION_ID_MAX || length - at < id_length) return -1;
        for (size_t k = 0; k < id_length; k++) {
            char c = (char)payload[at + k];
            int alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
            if (!(alnum || (k > 0 && (c == '_' || c == '.' || c == '-')))) return -1;
        }
        memcpy(out->session_id[i], payload + at, id_length);
        out->session_id[i][id_length] = '\0';
        out->runtime_uid[i] = uid;
        at += id_length;
        for (unsigned j = 0; j < i; j++) if (strcmp(out->session_id[j], out->session_id[i]) == 0) return -1;
    }
#ifdef WG_FILE_CHANNEL_V1
    if (extended) {
        if (length - at < 4) return -1;
        out->browse_uid = le32(payload + at);
        at += 4;
        if (out->browse_uid != 0 && (out->browse_uid < WG_UNIX_ID_MIN || out->browse_uid > WG_UNIX_ID_MAX)) return -1;
        for (unsigned i = 0; i < out->count; i++) {
            if (length - at < 5) return -1;
            uint32_t gid = le32(payload + at);
            unsigned roots = payload[at + 4];
            at += 5;
            if (gid < WG_UNIX_ID_MIN || gid > WG_UNIX_ID_MAX || roots < 1 || roots > WG_ROOTS_MAX) return -1;
            out->workspace_gid[i] = gid;
            out->root_count[i] = roots;
            for (unsigned r = 0; r < roots; r++) {
                if (length - at < 1) return -1;
                size_t source_length = payload[at++];
                if (length - at < source_length || !root_source_ok(payload + at, source_length)) return -1;
                memcpy(out->root_source[i][r], payload + at, source_length);
                out->root_source[i][r][source_length] = '\0';
                at += source_length;
            }
        }
        /* The browse uid is a fourth kind of id beside runtime uids, tool uids and workspace gids: it is none of the ones PID 1 can see. */
        for (unsigned i = 0; i < out->count; i++)
            if (out->browse_uid != 0 && (out->browse_uid == out->runtime_uid[i] || out->browse_uid == out->workspace_gid[i])) return -1;
        for (unsigned i = 0; i < out->count; i++)
            for (unsigned j = 0; j < out->count; j++) if (out->workspace_gid[i] == out->runtime_uid[j]) return -1;
    }
#endif
    if (length - at < 2) return -1;
    out->json = (const char *)payload + at;
    out->json_length = length - at;
    return 0;
}

/* Stops everything that could still write, then unmounts. Returns 1 only when every filesystem this boot mounted is unmounted
 * again, nothing is left mounted under the replay root, and each volume's superblock proves its final unmount happened (a mount
 * namespace or a bind mount that still holds the filesystem would leave it dirty). That is the only fact `halting` may claim. */
static int teardown(struct wg_boot *boot, long long started) {
    const struct wg_boot_ops *ops = boot->ops;
    /* The helper first: closing its channel makes a blocked helper exit at once; a helper inside mke2fs or a scan gets half of
     * the budget to finish that one operation, then it is killed. The supervisor gets up to three quarters. */
    ops->stop_helper(ops->ctx, started + (long long)(boot->budget_ms / 2));
    boot->helper_alive = 0;
    ops->stop_supervisor(ops->ctx, started + (long long)((uint64_t)boot->budget_ms * 3 / 4));
    boot->supervisor_alive = 0;
    ops->kill_all(ops->ctx);
    ops->sync_all(ops->ctx);
    for (int attempt = 0; attempt < UMOUNT_ATTEMPTS; attempt++) {
        for (int v = 0; v < 2; v++) if (boot->replay_mounted[v] && ops->umount_replay(ops->ctx, PURPOSES[v]) == 0) boot->replay_mounted[v] = 0;
        if (boot->environment_mounted && ops->umount(ops->ctx, WG_VOLUME_ENVIRONMENT) == 0) boot->environment_mounted = 0;
        if (boot->data_mounted && ops->umount(ops->ctx, WG_VOLUME_DATA) == 0) boot->data_mounted = 0;
        if (!boot->environment_mounted && !boot->data_mounted && !boot->replay_mounted[0] && !boot->replay_mounted[1]) break;
        ops->kill_all(ops->ctx);   /* something still holds a filesystem: stop whatever it is and try again */
        ops->pause_ms(ops->ctx, 100);
    }
    if (boot->environment_mounted || boot->data_mounted || boot->replay_mounted[0] || boot->replay_mounted[1]) return 0;
    for (int v = 0; v < 2; v++)
        if (boot->ever_mounted[v] && ops->verify_unmounted(ops->ctx, v, boot->uuid[v]) != 0) return 0;
    return 1;
}

/* The only bytes PID 1 inspects of a bootstrap payload: whether it is the host's `ready` (canonical order: v, t, then the message's own members).
 * The helper judges the whole message; this is defence in depth for the mount ordering. */
static int is_ready_message(const uint8_t *payload, size_t length) {
    static const char PREFIX[] = "{\"v\":1,\"t\":\"ready\",\"";
    return payload != NULL && length > sizeof PREFIX - 1 && memcmp(payload, PREFIX, sizeof PREFIX - 1) == 0;
}

/* Which control-up fault a fail-stop reason becomes. Reasons that mean the relay itself is gone cannot be reported at all. */
static enum wmx_fault_code fault_for(const char *code) {
    if (strncmp(code, "relay-fatal", 11) == 0 || strcmp(code, "relay-exited") == 0) return WMX_FAULT_NONE;
    if (strncmp(code, "supervisor-exited", 17) == 0) return WMX_FAULT_SUPERVISOR_LOST;
    if (strcmp(code, "drain-payload") == 0 || strcmp(code, "drain-fields") == 0 || strcmp(code, "relay-message") == 0) return WMX_FAULT_PROTOCOL_VIOLATION;
    return WMX_FAULT_INTERNAL;
}

/* One control-up fault per run: the relay refuses a second, and the worker treats the first as final. */
static void send_fault(struct wg_boot *boot, enum wmx_fault_code code, int with_nonce) {
    const struct wg_boot_ops *ops = boot->ops;
    if (boot->fault_sent || boot->relay_gone || code == WMX_FAULT_NONE) return;
    uint8_t payload[1 + WMX_NONCE_CHARS];
    payload[0] = (uint8_t)code;
    size_t length = 1;
    if (with_nonce) { memcpy(payload + 1, boot->nonce, WMX_NONCE_CHARS); length += WMX_NONCE_CHARS; }
    boot->fault_sent = 1;
    ops->to_relay(ops->ctx, CTL_FAULT, payload, length);
    if (!ops->wait_flushed(ops->ctx, FLUSH_WAIT_MS)) note(boot, "fault-unconfirmed");
}

static void stop(struct wg_boot *boot, int acknowledged, enum wmx_fault_code fail_fault) {
    const struct wg_boot_ops *ops = boot->ops;
    boot->phase = WG_PHASE_DRAINING;
    boot->draining = 1;
    long long started = ops->now_ms(ops->ctx);
    if (acknowledged) ops->to_relay(ops->ctx, CTL_DRAIN_ACK, boot->nonce, WMX_NONCE_CHARS);
    if (!acknowledged) send_fault(boot, fail_fault, 0);   /* first: the host should not wait for the unmounts to learn the guest is failing */
    enum wmx_fault_code after = WMX_FAULT_UNMOUNT_FAILED;
    int clean = teardown(boot, started);
    if (clean) {
        /* The superblocks are verified; now push the last writes to the devices themselves. `halting` promises the host that the
         * disks are final, so a flush that fails withholds it exactly like a failed unmount. */
        unsigned volumes = (boot->ever_mounted[0] ? 1u : 0u) | (boot->ever_mounted[1] ? 2u : 0u);
        if (ops->flush_devices(ops->ctx, volumes) != 0) { note(boot, "flush-failed"); clean = 0; after = WMX_FAULT_INTERNAL; }
    }
    if (acknowledged && clean) {
        ops->to_relay(ops->ctx, CTL_HALTING, boot->nonce, WMX_NONCE_CHARS);
        boot->halting_sent = 1;
        if (!ops->wait_flushed(ops->ctx, FLUSH_WAIT_MS)) note(boot, "halting-unconfirmed");
    } else if (!clean) {
        note(boot, "unmount-failed");
        if (acknowledged) send_fault(boot, after, 1);   /* after the drain_ack, with the drain's nonce */
    }
    ops->sync_all(ops->ctx);   /* reboot(RB_POWER_OFF) does not sync */
    ops->power_off(ops->ctx);
    boot->phase = WG_PHASE_DEAD;
}

void wg_boot_fail_stop(struct wg_boot *boot, const char *code) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    note(boot, code);
    boot->budget_ms = FAIL_STOP_BUDGET_MS;
    stop(boot, 0, fault_for(code));
}

static void answer_conversations(struct wg_boot *boot, uint8_t status) {
    uint8_t message[2] = { status, (uint8_t)(status == 0 ? boot->conv_count : 0) };
    if (boot->helper_alive) boot->ops->to_helper(boot->ops->ctx, CTL_CONVERSATIONS_RESULT, message, sizeof message);
}

/* A set that cannot start leaves the guest up for the host's drain; the helper turns the status into a bootstrap fault. */
static void conversations_failed(struct wg_boot *boot, uint8_t status, const char *code) {
    note(boot, code);
    boot->conv_state = WG_CONV_FAILED;
    answer_conversations(boot, status);
}

static void start_conversations(struct wg_boot *boot, const uint8_t *payload, size_t length) {
    const struct wg_boot_ops *ops = boot->ops;
    struct wg_conversation_set set;
    if (boot->phase != WG_PHASE_MOUNTED || boot->conv_state != WG_CONV_NONE) { wg_boot_fail_stop(boot, "conversations-out-of-order"); return; }
    boot->conv_state = WG_CONV_FAILED;   /* one attempt per incarnation, whatever happens */
    if (wg_parse_conversation_payload(payload, length, &set) != 0) { conversations_failed(boot, 1, "conversations-payload"); return; }
    boot->conv_count = set.count;
    boot->conv_profile = set.profile;
    const char *runtime_key = set.profile == 0 ? NULL : set.profile == 1 ? "hostQueryRuntime" : "hostQueryGuidedRuntime";
    size_t base_length = 0, runtime_length = 0, config_length = 0;
    char boot_id[37];
    if (ops->read_base_config(ops->ctx, base_buffer, sizeof base_buffer, &base_length) != 0) { wg_boot_fail_stop(boot, "base-config-missing"); return; }
    if (ops->read_boot_id(ops->ctx, boot_id) != 0) { wg_boot_fail_stop(boot, "boot-id-unreadable"); return; }
    if (runtime_key && ops->read_runtime_artifacts(ops->ctx, set.profile, runtime_buffer, sizeof runtime_buffer, &runtime_length) != 0) {
        conversations_failed(boot, 2, "runtime-artifacts-missing");   /* the image cannot run this profile: the supervisor cannot start */
        return;
    }
    /* The supervisor requires `guidanceDirectory` in every guided conversation and refuses it in any other: the helper writes it, PID 1 checks it. */
    if (!wg_guidance_members_ok(set.profile, set.count, set.json, set.json_length)) { conversations_failed(boot, 1, "config-refused"); return; }
    enum wg_config_result built = wg_build_trusted_config(boot_id, base_buffer, base_length, set.json, set.json_length, runtime_key, runtime_buffer, runtime_length,
                                                          config_buffer, sizeof config_buffer, &config_length);
    if (built == WG_CONFIG_RUNTIME_SHAPE) { conversations_failed(boot, 2, "runtime-artifacts-invalid"); return; }   /* the image's own file is not what the supervisor reads */
    if (built != WG_CONFIG_OK) { conversations_failed(boot, 1, "config-refused"); return; }
#ifdef WG_FILE_CHANNEL_V1
    int start_flags = set.profile != 0 ? WG_START_PORTS : 0;
    if (set.browse_uid != 0) {
        uint64_t device = 0;
        if (ops->read_data_device(ops->ctx, &device) != 0 || wg_add_file_channel(config_buffer, config_length, sizeof config_buffer, set.browse_uid, device, &config_length) != 0) {
            conversations_failed(boot, 2, "file-channel-config-failed");
            return;
        }
        start_flags |= WG_START_FILE_CHANNEL;
    }
#endif
    if (ops->prepare_conversation_dirs(ops->ctx, &set) != 0) { conversations_failed(boot, 2, "conversation-dirs-failed"); return; }
#ifdef WG_FILE_CHANNEL_V1
    if (ops->start_supervisor(ops->ctx, config_buffer, config_length, start_flags) != 0) { conversations_failed(boot, 2, "supervisor-start-failed"); return; }
    boot->conv_file_channel = (start_flags & WG_START_FILE_CHANNEL) != 0;
#else
    if (ops->start_supervisor(ops->ctx, config_buffer, config_length, set.profile != 0) != 0) { conversations_failed(boot, 2, "supervisor-start-failed"); return; }
#endif
    boot->supervisor_started = 1;
    boot->supervisor_alive = 1;
    boot->conv_state = WG_CONV_STARTING;
}

static void enter_mounted(struct wg_boot *boot) {
    if (boot->phase != WG_PHASE_BOOTSTRAP) return;
    boot->phase = WG_PHASE_MOUNTED;
}

void wg_boot_relay_message(struct wg_boot *boot, uint8_t tag, const uint8_t *payload, size_t length) {
    const struct wg_boot_ops *ops = boot->ops;
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    switch (tag) {
    case CTL_BOOTSTRAP_DOWN:
        /* Only the helper can judge a bootstrap payload. With no helper to give it to, it is dropped. */
        if ((boot->phase == WG_PHASE_BOOTSTRAP || boot->phase == WG_PHASE_MOUNTED || boot->phase == WG_PHASE_RUNNING) && boot->helper_alive) {
            if (is_ready_message(payload, length)) boot->host_ready_seen = 1;
            ops->to_helper(ops->ctx, CTL_HELPER_DOWN, payload, length);
        }
        else note(boot, "bootstrap-payload-dropped");
        break;
    case CTL_DRAIN: {
        if (length != CTL_DRAIN_PAYLOAD_BYTES) { wg_boot_fail_stop(boot, "drain-payload"); return; }
        char nonce[WMX_NONCE_CHARS + 1];
        memcpy(nonce, payload, WMX_NONCE_CHARS);
        nonce[WMX_NONCE_CHARS] = '\0';
        uint32_t budget = (uint32_t)payload[32] | ((uint32_t)payload[33] << 8) | ((uint32_t)payload[34] << 16) | ((uint32_t)payload[35] << 24);
        if (!wmx_is_nonce(nonce) || budget > WMX_DRAIN_BUDGET_CEILING_MS || payload[36] > 1) { wg_boot_fail_stop(boot, "drain-fields"); return; }
        memcpy(boot->nonce, nonce, sizeof nonce);
        boot->budget_ms = budget;
        stop(boot, 1, WMX_FAULT_NONE);
        break;
    }
    case CTL_RELAY_FATAL: {
        char code[32];
        snprintf(code, sizeof code, "relay-fatal-%u", length == 1 ? (unsigned)payload[0] % 10u : 0u);
        boot->relay_gone = 1;   /* the relay announced its own end: it cannot carry a fault */
        wg_boot_fail_stop(boot, code);
        break;
    }
    default:
        wg_boot_fail_stop(boot, "relay-message");
    }
}

void wg_boot_helper_message(struct wg_boot *boot, uint8_t tag, const uint8_t *payload, size_t length) {
    const struct wg_boot_ops *ops = boot->ops;
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    switch (tag) {
    case CTL_HELPER_UP:
        ops->to_relay(ops->ctx, CTL_BOOTSTRAP_UP, payload, length);
        break;
    case CTL_HELPER_REPLAY: {
        /* A replay mounts the volume writably: it is allowed only before the real mount, for the two known volumes. */
        if (boot->phase != WG_PHASE_BOOTSTRAP || boot->mount_requested) { wg_boot_fail_stop(boot, "replay-out-of-order"); return; }
        char purpose[16];
        if (length == 0 || length >= sizeof purpose) { wg_boot_fail_stop(boot, "replay-purpose"); return; }
        memcpy(purpose, payload, length);
        purpose[length] = '\0';
        if (strcmp(purpose, "data") != 0 && strcmp(purpose, "environment") != 0) { wg_boot_fail_stop(boot, "replay-purpose"); return; }
        int result = ops->replay(ops->ctx, purpose);
        uint8_t ok = result == 0 ? 1 : 0;
        if (!ok) note(boot, "replay-failed");
        if (result == -2) boot->replay_mounted[strcmp(purpose, "data") == 0 ? 0 : 1] = 1;   /* teardown must get it out again */
        ops->to_helper(ops->ctx, CTL_REPLAY_RESULT, &ok, 1);
        break;
    }
    case CTL_HELPER_MOUNT: {
        if (boot->phase != WG_PHASE_BOOTSTRAP || boot->mount_requested || !boot->host_ready_seen) { wg_boot_fail_stop(boot, "mount-out-of-order"); return; }
        uint8_t data_uuid[WG_UUID_BYTES], environment_uuid[WG_UUID_BYTES];
        if (length != 73 || payload[36] != ' ' || wg_uuid_parse((const char *)payload, 36, data_uuid) != 0 ||
            wg_uuid_parse((const char *)payload + 37, 36, environment_uuid) != 0) {
            wg_boot_fail_stop(boot, "mount-payload");
            return;
        }
        boot->mount_requested = 1;
        memcpy(boot->uuid[WG_VOLUME_DATA], data_uuid, WG_UUID_BYTES);
        memcpy(boot->uuid[WG_VOLUME_ENVIRONMENT], environment_uuid, WG_UUID_BYTES);
        uint8_t ok = 0;
        int leftover = 0;
        if (ops->mount_volumes(ops->ctx, data_uuid, environment_uuid, &leftover) == 0) {
            boot->data_mounted = 1;                 /* the environment disk is checked against its plan but not mounted in N2 */
            boot->ever_mounted[0] = 1;
            ok = 1;
        } else {
            note(boot, "mount-failed");
            /* a rollback that did not complete leaves that volume mounted: it must be unmounted and verified before `halting` */
            if (leftover & 1) { boot->data_mounted = 1; boot->ever_mounted[0] = 1; }
            if (leftover & 2) { boot->environment_mounted = 1; boot->ever_mounted[1] = 1; }
        }
        ops->to_helper(ops->ctx, CTL_MOUNT_RESULT, &ok, 1);
        break;
    }
    case CTL_HELPER_CONVERSATIONS:
        start_conversations(boot, payload, length);
        break;
    case CTL_HELPER_DONE:
        if (!boot->mount_requested || !boot->data_mounted || length != 0) { wg_boot_fail_stop(boot, "done-out-of-order"); return; }
        boot->helper_done = 1;
        enter_mounted(boot);
        break;
    default:
        wg_boot_fail_stop(boot, "helper-message");
    }
}

void wg_boot_helper_exited(struct wg_boot *boot, int exit_status) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    boot->helper_alive = 0;
    /* The helper ends after `mounted` and its own `E`. An end after the mount with no `E` means the host may never have been told
     * `mounted`, so the mount is not promoted to a running guest: stop it (the unmount path verifies the volumes). An end before any
     * mount only means this boot's single bootstrap is over; the guest stays up for the host's drain. */
    if (boot->data_mounted && !boot->helper_done) wg_boot_fail_stop(boot, "helper-ended-after-mount");
    else if (!boot->data_mounted) note(boot, exit_status == 0 ? "bootstrap-ended" : "bootstrap-failed");
}

void wg_boot_supervisor_ready(struct wg_boot *boot) {
    if (boot->phase != WG_PHASE_MOUNTED || !boot->supervisor_alive || boot->conv_state != WG_CONV_STARTING) return;
    boot->phase = WG_PHASE_RUNNING;
    boot->conv_state = WG_CONV_RUNNING;
    /* The relay first: its pipe carries the helper's `runtime_ready` right after this, so no runtime frame can be answered before it
     * admits them. */
    uint8_t streams = boot->conv_profile != 0 ? 1 : 0;
#ifdef WG_FILE_CHANNEL_V1
    if (boot->conv_file_channel) streams |= 2;   /* bit 1: the supervisor has a file service, so the relay admits streams 4 and 5 */
#endif
    boot->ops->to_relay(boot->ops->ctx, CTL_RUNTIME_GO, &streams, 1);
    answer_conversations(boot, 0);
}

void wg_boot_supervisor_not_ready(struct wg_boot *boot, const char *code) {
    if (boot->phase != WG_PHASE_MOUNTED || boot->conv_state != WG_CONV_STARTING) return;
    boot->ops->stop_supervisor(boot->ops->ctx, boot->ops->now_ms(boot->ops->ctx));
    boot->supervisor_alive = 0;
    conversations_failed(boot, 2, code);
}

void wg_boot_supervisor_exited(struct wg_boot *boot, int exit_status) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    boot->supervisor_alive = 0;
    if (boot->conv_state == WG_CONV_FAILED || boot->conv_state == WG_CONV_NONE) return;   /* PID 1 stopped it itself, or it never ran */
    if (boot->conv_state == WG_CONV_STARTING) {   /* it never became ready: the set failed, the guest stays up */
        conversations_failed(boot, 2, exit_status == 78 ? "supervisor-exited-before-ready-debt" : "supervisor-exited-before-ready");
        return;
    }
    wg_boot_fail_stop(boot, exit_status == 78 ? "supervisor-exited-retained-debt" : "supervisor-exited");
}

void wg_boot_relay_exited(struct wg_boot *boot) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    boot->relay_gone = 1;
    wg_boot_fail_stop(boot, "relay-exited");
}
