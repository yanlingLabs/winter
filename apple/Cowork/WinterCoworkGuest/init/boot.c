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

static char conversations_buffer[WG_CONFIG_CONVERSATIONS_MAX + 1];
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

static void stop(struct wg_boot *boot, int acknowledged) {
    const struct wg_boot_ops *ops = boot->ops;
    boot->phase = WG_PHASE_DRAINING;
    boot->draining = 1;
    long long started = ops->now_ms(ops->ctx);
    if (acknowledged) ops->to_relay(ops->ctx, CTL_DRAIN_ACK, boot->nonce, WMX_NONCE_CHARS);
    int clean = teardown(boot, started);
    if (clean) {
        /* The superblocks are verified; now push the last writes to the devices themselves. `halting` promises the host that the
         * disks are final, so a flush that fails withholds it exactly like a failed unmount. */
        unsigned volumes = (boot->ever_mounted[0] ? 1u : 0u) | (boot->ever_mounted[1] ? 2u : 0u);
        if (ops->flush_devices(ops->ctx, volumes) != 0) { note(boot, "flush-failed"); clean = 0; }
    }
    if (acknowledged && clean) {
        ops->to_relay(ops->ctx, CTL_HALTING, boot->nonce, WMX_NONCE_CHARS);
        boot->halting_sent = 1;
        if (!ops->wait_flushed(ops->ctx, FLUSH_WAIT_MS)) note(boot, "halting-unconfirmed");
    } else if (!clean) {
        note(boot, "unmount-failed");
    }
    ops->sync_all(ops->ctx);   /* reboot(RB_POWER_OFF) does not sync */
    ops->power_off(ops->ctx);
    boot->phase = WG_PHASE_DEAD;
}

void wg_boot_fail_stop(struct wg_boot *boot, const char *code) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    note(boot, code);
    boot->budget_ms = FAIL_STOP_BUDGET_MS;
    stop(boot, 0);
}

static void start_supervisor_if_possible(struct wg_boot *boot) {
    const struct wg_boot_ops *ops = boot->ops;
    if (boot->supervisor_started || boot->draining || boot->phase != WG_PHASE_MOUNTED) return;
    size_t conversations_length = 0, base_length = 0, config_length = 0;
    int present = ops->read_conversations(ops->ctx, conversations_buffer, sizeof conversations_buffer, &conversations_length);
    if (present == 1) { note(boot, "supervisor-not-started:no-conversation-set"); return; }
    if (present != 0) { wg_boot_fail_stop(boot, "conversation-set-unusable"); return; }
    char boot_id[37];
    if (ops->read_base_config(ops->ctx, base_buffer, sizeof base_buffer, &base_length) != 0) { wg_boot_fail_stop(boot, "base-config-missing"); return; }
    if (ops->read_boot_id(ops->ctx, boot_id) != 0) { wg_boot_fail_stop(boot, "boot-id-unreadable"); return; }
    if (wg_build_trusted_config(boot_id, base_buffer, base_length, conversations_buffer, conversations_length, config_buffer, sizeof config_buffer,
                                &config_length) != WG_CONFIG_OK) {
        wg_boot_fail_stop(boot, "config-refused");
        return;
    }
    if (ops->start_supervisor(ops->ctx, config_buffer, config_length) != 0) { wg_boot_fail_stop(boot, "supervisor-start-failed"); return; }
    boot->supervisor_started = 1;
    boot->supervisor_alive = 1;
}

static void enter_mounted(struct wg_boot *boot) {
    if (boot->phase != WG_PHASE_BOOTSTRAP) return;
    boot->phase = WG_PHASE_MOUNTED;
    start_supervisor_if_possible(boot);
}

void wg_boot_relay_message(struct wg_boot *boot, uint8_t tag, const uint8_t *payload, size_t length) {
    const struct wg_boot_ops *ops = boot->ops;
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    switch (tag) {
    case CTL_BOOTSTRAP_DOWN:
        /* Only the helper can judge a bootstrap payload. With no helper to give it to, it is dropped. */
        if (boot->phase == WG_PHASE_BOOTSTRAP && boot->helper_alive) {
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
        stop(boot, 1);
        break;
    }
    case CTL_RELAY_FATAL: {
        char code[32];
        snprintf(code, sizeof code, "relay-fatal-%u", length == 1 ? (unsigned)payload[0] % 10u : 0u);
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
            boot->data_mounted = boot->environment_mounted = 1;
            boot->ever_mounted[0] = boot->ever_mounted[1] = 1;
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
    if (boot->phase != WG_PHASE_MOUNTED || !boot->supervisor_alive) return;
    boot->phase = WG_PHASE_RUNNING;
    boot->ops->to_relay(boot->ops->ctx, CTL_RUNTIME_GO, NULL, 0);
}

void wg_boot_supervisor_exited(struct wg_boot *boot, int exit_status) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    boot->supervisor_alive = 0;
    wg_boot_fail_stop(boot, exit_status == 78 ? "supervisor-exited-retained-debt" : "supervisor-exited");
}

void wg_boot_relay_exited(struct wg_boot *boot) {
    if (boot->phase == WG_PHASE_DEAD || boot->phase == WG_PHASE_DRAINING) return;
    wg_boot_fail_stop(boot, "relay-exited");
}
