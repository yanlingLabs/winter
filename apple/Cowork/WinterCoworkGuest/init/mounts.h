/*
 * Mount policy of PID 1 (N2 slice S5), expressed over an operations table so the exact flags, options and order are
 * unit-tested natively while the real syscalls stay in init_linux.c. Flag values are the Linux uapi constants
 * (asserted equal to <sys/mount.h> in the Linux translation unit).
 *
 *   data volume          /workspace                       nosuid,nodev,noatime   noinit_itable,errors=remount-ro
 *   environment volume   /opt/winter/environment/disk     nosuid,nodev,noatime   noinit_itable,errors=remount-ro
 *   journal replay       /run/winter/replay/<purpose>     nosuid,nodev,noexec,noatime   noinit_itable,errors=remount-ro
 *
 * `noinit_itable` is mandatory at every mount: the volumes were created with lazy inode tables from sparse zero files, and
 * the durable zero-provenance contract (docs/cowork-raw-volumes.md) forbids the background initialisation that would write them.
 * `noexec` is deliberately NOT set on the two working mounts: tools build and run programs under /workspace; the tool
 * compartments re-mount their own views with their own flags. Portable C11.
 */
#ifndef WG_MOUNTS_H
#define WG_MOUNTS_H

#include <stddef.h>
#include <stdint.h>

#define WG_MS_RDONLY 1ul
#define WG_MS_NOSUID 2ul
#define WG_MS_NODEV 4ul
#define WG_MS_NOEXEC 8ul
#define WG_MS_NOATIME 1024ul

#define WG_WORKSPACE_PATH "/workspace"
#define WG_ENVIRONMENT_PATH "/opt/winter/environment/disk"
#define WG_REPLAY_ROOT "/run/winter/replay"

#define WG_WORKING_FLAGS (WG_MS_NOSUID | WG_MS_NODEV | WG_MS_NOATIME)
#define WG_REPLAY_FLAGS (WG_MS_NOSUID | WG_MS_NODEV | WG_MS_NOEXEC | WG_MS_NOATIME)
#define WG_EXT4_DATA "noinit_itable,errors=remount-ro"

struct wg_mount_ops {
    void *ctx;
    int (*mount)(void *ctx, const char *source, const char *target, const char *fstype, unsigned long flags, const char *data);
    int (*umount)(void *ctx, const char *target);
    int (*syncfs_path)(void *ctx, const char *path);
    int (*mkdir_private)(void *ctx, const char *path); /* idempotent, root-only */
    /* 0 when the node's superblock is a clean ext4 with exactly this UUID and no pending recovery */
    int (*check_volume)(void *ctx, const char *node, const uint8_t uuid[16]);
    /* the protected directory skeleton below /workspace */
    int (*skeleton)(void *ctx);
};

/* Both volumes are checked first, then the data volume is mounted, then the environment volume, then the skeleton is made. Any
 * failure unmounts what this call mounted; a rollback unmount that fails sets that volume's bit in *leftover (1 data, 2 environment)
 * so the caller keeps track of a filesystem that is still mounted. Returns 0 only when everything is in place. */
int wg_mount_volumes(const struct wg_mount_ops *ops, const char *data_node, const uint8_t data_uuid[16], const char *environment_node,
                     const uint8_t environment_uuid[16], int *leftover);

/* The protocol-3 `replay-journal-then-probe` effect: mount the volume privately (writable, so the kernel replays its journal),
 * flush it, unmount it. Returns 0 only when all three happened; a failure after the mount attempt tries to unmount and never
 * reports success. -1: failed, nothing mounted. -2: failed and the volume may still be mounted under WG_REPLAY_ROOT. */
int wg_replay_journal(const struct wg_mount_ops *ops, const char *node, const char *purpose);

#endif
