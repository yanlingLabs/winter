/*
 * The boot / drain state machine of PID 1 (N2 slice S5), written without any I/O of its own.
 *
 * init_linux.c owns the process plumbing (pipes, fork/exec, poll, signalfd, mount(2), reboot(2)) and feeds EVENTS into this
 * module; this module decides what happens and calls EFFECTS through struct wg_boot_ops. That split exists so every ordering
 * and every guard below is unit-tested natively with a recording fake, even though PID 1 itself can only run in the guest.
 *
 *   BOOTSTRAP  helper running. It may ask for a journal replay (before any mount) and, after the host's `ready`, for the mount.
 *   MOUNTED    the data volume is mounted and the skeleton made (the environment disk is NOT mounted in N2). The helper stays up and
 *              may deliver the conversation set ('C') once; PID 1 then makes the conversation directories, writes the trusted
 *              config and starts the supervisor. Until the supervisor's ready line arrives the set is "starting"; if it never
 *              does, or the supervisor dies first, the helper is told `supervisor_failed` and the guest stays up for the drain.
 *   RUNNING    supervisor ready: the helper is told (it answers `runtime_ready`) and the relay is told that runtime frames are now admitted.
 *   DRAINING   drain: ack, stop helper, stop supervisor, kill the rest, sync, unmount, flush the devices, `halting` ONLY if every unmount worked and the flush succeeded, sync, power off.
 *
 * Fail-stop (relay or supervisor gone, protocol garbage, a helper message out of order) is the drain without the ack and
 * without `halting`. While the relay lives PID 1 first has it send one control-up `fault` (unmount_failed, supervisor_lost,
 * protocol_violation or internal); a drain whose unmounts or device flush failed sends the fault AFTER its drain_ack, with the
 * drain's nonce. Either way no `halting` follows, so the host classifies the run as uncertain (Class B).
 * Portable C11.
 */
#ifndef WG_BOOT_H
#define WG_BOOT_H

#include <stddef.h>
#include <stdint.h>

#define WG_VOLUME_DATA 0
#define WG_VOLUME_ENVIRONMENT 1

/* The conversation set the bootstrap helper hands PID 1 ('C'): the helper has already validated the host's message and built the
 * supervisor's conversation items. Payload: u8 profile (0 tools only, 1 host-query-v1, 2 host-query-guided-v1), u8 count (1 to 16;
 * exactly 1 with a profile), then per conversation u32 LE runtimeUid, u8 length of the logicalSessionId (1 to 128) and its bytes,
 * then the JSON array of the items for the trusted config (the rest of the payload). PID 1 re-checks the small part it acts on. */
#define WG_CONVERSATIONS_MAX 16u
#define WG_SESSION_ID_MAX 128u
#define WG_UNIX_ID_MIN 1000u   /* the contract's unixId range: 65534 is `nobody` and 65535 the invalid id */
#define WG_UNIX_ID_MAX 65533u
#ifdef WG_FILE_CHANNEL_V1
/* Image with the runtime capability `file-channel-v1` only. The helper (started with --file-channel-v1) sends the payload below with the profile byte's bit 7 set:
 *   u8 profile | 0x80, u8 count, per conversation {u32 runtimeUid, u8 id length, id}, then
 *   u32 LE browseUid (0 = the workspace has none; otherwise 1000 to 65533, never a runtime or tool uid or a workspace gid of the set),
 *   per conversation {u32 LE toolUid (1000 to 65533, distinct from every runtime and tool uid of the set: the owner of the conversation's plan view),
 *   u32 LE workspaceGid (1000 to 65533, never a runtime or tool uid of the set), u8 root count (1 to 16), per root {u8 length (11 to 255), the root's `source` path}},
 *   then the items JSON. A payload without bit 7 is the plain one and means "no file channel". */
#define WG_PAYLOAD_EXTENDED 0x80u
#define WG_ROOTS_MAX 16u
#define WG_ROOT_SOURCE_MAX 255u
#endif
struct wg_conversation_set {
    unsigned profile;
    unsigned count;
    uint32_t runtime_uid[WG_CONVERSATIONS_MAX];
    char session_id[WG_CONVERSATIONS_MAX][WG_SESSION_ID_MAX + 1];
    const char *json;
    size_t json_length;
#ifdef WG_FILE_CHANNEL_V1
    uint32_t browse_uid;                                              /* 0 = no file channel for this set */
    uint32_t tool_uid[WG_CONVERSATIONS_MAX];
    uint32_t workspace_gid[WG_CONVERSATIONS_MAX];
    unsigned root_count[WG_CONVERSATIONS_MAX];
    char root_source[WG_CONVERSATIONS_MAX][WG_ROOTS_MAX][WG_ROOT_SOURCE_MAX + 1];
#endif
};
/* 0 when the payload is well formed. The JSON text itself is only shape-checked later, by the config builder. */
int wg_parse_conversation_payload(const uint8_t *payload, size_t length, struct wg_conversation_set *out);

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
    /* The data volume only, and the skeleton; the environment disk is checked, not mounted. On failure *leftover (bit 0 data, bit 1
     * environment) names a volume whose rollback unmount did not succeed. */
    int (*mount_volumes)(void *ctx, const uint8_t data_uuid[16], const uint8_t environment_uuid[16], int *leftover);
    int (*umount)(void *ctx, int volume);
    /* 0 when the volume's superblock shows the final unmount happened: this UUID, clean, no pending recovery */
    int (*verify_unmounted)(void *ctx, int volume, const uint8_t uuid[16]);
    /* /run/winter/conversations/<id> (owner runtimeUid, 0700) and /workspace/.winter/conversations/<id> for every conversation of the set; 0 = all made */
    int (*prepare_conversation_dirs)(void *ctx, const struct wg_conversation_set *set);
    /* the runtime artifact pins the initramfs holds for this profile (1 = host-query, 2 = guided; an object), needed for a host-query profile; 0 = read, non-zero =
     * the image cannot run that profile (the supervisor is not started and the set fails with `supervisor_failed`) */
    int (*read_runtime_artifacts)(void *ctx, unsigned profile, char *out, size_t capacity, size_t *length);
    int (*read_base_config)(void *ctx, char *out, size_t capacity, size_t *length);
    int (*read_boot_id)(void *ctx, char out[37]);
    /* with_ports: pass --runtime-ports-fds 4,5,6 (one host-query conversation). With WG_FILE_CHANNEL_V1 the value is a set of bits: WG_START_PORTS, and
     * WG_START_FILE_CHANNEL for `--file-channel-fds IN,OUT` as the last two arguments (the config then names `fileChannel`). */
    int (*start_supervisor)(void *ctx, const char *config, size_t length, int with_ports);
#ifdef WG_FILE_CHANNEL_V1
    /* st_dev of the mounted data volume (/workspace): the supervisor's `fileChannel.dataDevice`. 0 = read, non-zero = refused */
    int (*read_data_device)(void *ctx, uint64_t *device);
#endif
    /* teardown */
    void (*stop_helper)(void *ctx, long long deadline_ms);
    void (*stop_supervisor)(void *ctx, long long deadline_ms);
    void (*kill_all)(void *ctx);
    void (*sync_all)(void *ctx);
    /* after the last unmount: sync(), then fsync every block device named in `volumes` (bit 0 data, bit 1 environment). 0 only if all of it succeeded */
    int (*flush_devices)(void *ctx, unsigned volumes);
    void (*power_off)(void *ctx);
};

#define WG_START_PORTS 1
#ifdef WG_FILE_CHANNEL_V1
#define WG_START_FILE_CHANNEL 2
#endif
enum wg_conv_state { WG_CONV_NONE = 0, WG_CONV_STARTING, WG_CONV_RUNNING, WG_CONV_FAILED };
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
    int conv_state;                    /* WG_CONV_* */
    unsigned conv_count, conv_profile;
#ifdef WG_FILE_CHANNEL_V1
    int conv_file_channel;             /* the supervisor was started with a file service */
#endif
    int fault_sent, relay_gone;
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
/* The supervisor did not print its exact ready line (late, wrong, or a closed stdout): while the set is starting that is
 * `supervisor_failed`, never a fail-stop. */
void wg_boot_supervisor_not_ready(struct wg_boot *boot, const char *code);
void wg_boot_supervisor_exited(struct wg_boot *boot, int exit_status);
void wg_boot_relay_exited(struct wg_boot *boot);
void wg_boot_fail_stop(struct wg_boot *boot, const char *code);

#endif
