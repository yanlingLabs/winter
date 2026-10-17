/*
 * The boot / drain state machine of PID 1 (N2 slice S5), written without any I/O of its own.
 *
 * init_linux.c owns the process plumbing (pipes, fork/exec, poll, signalfd, mount(2), reboot(2)) and feeds EVENTS into this
 * module; this module decides what happens and calls EFFECTS through struct wg_boot_ops. That split exists so every ordering
 * and every guard below is unit-tested natively with a recording fake, even though PID 1 itself can only run in the guest.
 *
 *   BOOTSTRAP  helper running. It may ask for a journal replay (before any mount) and, after the host's `ready`, for the mount.
 *   MOUNTED    both volumes mounted and the skeleton made. The supervisor starts only when a trusted conversation set exists.
 *   RUNNING    supervisor up; the relay is told that runtime frames are now admitted.
 *   DRAINING   drain: ack, stop helper, stop supervisor, kill the rest, sync, unmount, flush the devices, `halting` ONLY if every unmount worked and the flush succeeded, sync, power off.
 *
 * Fail-stop (relay or supervisor gone, protocol garbage, a helper message out of order) is the drain without the ack and
 * without `halting`: the host learns of it only as a power-off with no `halting`, which it must treat as uncertain.
 * Portable C11.
 */
#ifndef WG_BOOT_H
#define WG_BOOT_H

#include <stddef.h>
#include <stdint.h>

#define WG_VOLUME_DATA 0
#define WG_VOLUME_ENVIRONMENT 1

struct wg_boot_ops {
    void *ctx;
    long long (*now_ms)(void *ctx);
    void (*pause_ms)(void *ctx, unsigned ms);
    void (*log)(void *ctx, const char *code);
    /* channels to the relay and to the bootstrap helper */
    void (*to_relay)(void *ctx, uint8_t tag, const void *payload, size_t length);
    void (*to_helper)(void *ctx, uint8_t tag, const void *payload, size_t length);
    int (*wait_flushed)(void *ctx, unsigned timeout_ms); /* 1 once the relay reported that `halting` reached the host */
    /* effects */
    /* 0 = replayed, mounted and unmounted again; -1 = failed and nothing is left mounted; -2 = failed and the volume may still be mounted */
    int (*replay)(void *ctx, const char *purpose);
    int (*umount_replay)(void *ctx, const char *purpose);
    /* includes the skeleton. On failure *leftover (bit 0 data, bit 1 environment) names a volume whose rollback unmount did not succeed. */
    int (*mount_volumes)(void *ctx, const uint8_t data_uuid[16], const uint8_t environment_uuid[16], int *leftover);
    int (*umount)(void *ctx, int volume);
    /* 0 when the volume's superblock shows the final unmount happened: this UUID, clean, no pending recovery */
    int (*verify_unmounted)(void *ctx, int volume, const uint8_t uuid[16]);
    int (*read_conversations)(void *ctx, char *out, size_t capacity, size_t *length); /* 0 present, 1 absent, -1 unusable */
    int (*read_base_config)(void *ctx, char *out, size_t capacity, size_t *length);
    int (*read_boot_id)(void *ctx, char out[37]);
    int (*start_supervisor)(void *ctx, const char *config, size_t length);
    /* teardown */
    void (*stop_helper)(void *ctx, long long deadline_ms);
    void (*stop_supervisor)(void *ctx, long long deadline_ms);
    void (*kill_all)(void *ctx);
    void (*sync_all)(void *ctx);
    /* after the last unmount: sync(), then fsync every block device named in `volumes` (bit 0 data, bit 1 environment). 0 only if all of it succeeded */
    int (*flush_devices)(void *ctx, unsigned volumes);
    void (*power_off)(void *ctx);
};

enum wg_phase { WG_PHASE_BOOTSTRAP = 0, WG_PHASE_MOUNTED, WG_PHASE_RUNNING, WG_PHASE_DRAINING, WG_PHASE_DEAD };

struct wg_boot {
    const struct wg_boot_ops *ops;
    enum wg_phase phase;
    int helper_alive, helper_done;
    int mount_requested;
    int host_ready_seen;               /* a `ready` down message was forwarded to the helper: the earliest the host can have released a mount */
    int data_mounted, environment_mounted;
    int ever_mounted[2];               /* this boot mounted the volume (its final unmount is verified before `halting`) */
    int replay_mounted[2];             /* a failed replay may have left the volume mounted under the replay root */
    uint8_t uuid[2][16];
    int supervisor_started, supervisor_alive;
    int draining;
    char nonce[33];
    uint32_t budget_ms;
    int halting_sent;
};

void wg_boot_init(struct wg_boot *boot, const struct wg_boot_ops *ops);

/* Events. `payload` may be NULL when `length` is 0. */
void wg_boot_relay_message(struct wg_boot *boot, uint8_t tag, const uint8_t *payload, size_t length);
void wg_boot_helper_message(struct wg_boot *boot, uint8_t tag, const uint8_t *payload, size_t length);
void wg_boot_helper_exited(struct wg_boot *boot, int exit_status);
void wg_boot_supervisor_ready(struct wg_boot *boot);
void wg_boot_supervisor_exited(struct wg_boot *boot, int exit_status);
void wg_boot_relay_exited(struct wg_boot *boot);
void wg_boot_fail_stop(struct wg_boot *boot, const char *code);

#endif
