#include "mounts.h"

#include <stdio.h>
#include <string.h>

int wg_mount_volumes(const struct wg_mount_ops *ops, const char *data_node, const uint8_t data_uuid[16], const char *environment_node,
                     const uint8_t environment_uuid[16], int *leftover) {
    *leftover = 0;
    if (ops->check_volume(ops->ctx, data_node, data_uuid) != 0) return -1;
    /* The environment disk is attached, probed and formatted but NOT mounted in N2: nothing consumes it (the supervisor's environment
     * root is a static base inside the initramfs). It is still held to its plan here, so a swapped or dirty disk is refused. */
    if (ops->check_volume(ops->ctx, environment_node, environment_uuid) != 0) return -1;
    if (ops->mount(ops->ctx, data_node, WG_WORKSPACE_PATH, "ext4", WG_WORKING_FLAGS, WG_EXT4_DATA) != 0) return -1;
    if (ops->skeleton(ops->ctx) != 0) {
        if (ops->umount(ops->ctx, WG_WORKSPACE_PATH) != 0) *leftover |= 1;
        return -1;
    }
    return 0;
}

int wg_replay_journal(const struct wg_mount_ops *ops, const char *node, const char *purpose) {
    char target[96];
    if (strcmp(purpose, "data") != 0 && strcmp(purpose, "environment") != 0) return -1;
    if (snprintf(target, sizeof target, "%s/%s", WG_REPLAY_ROOT, purpose) >= (int)sizeof target) return -1;
    if (ops->mkdir_private(ops->ctx, WG_REPLAY_ROOT) != 0 || ops->mkdir_private(ops->ctx, target) != 0) return -1;
    if (ops->mount(ops->ctx, node, target, "ext4", WG_REPLAY_FLAGS, WG_EXT4_DATA) != 0) return -1;
    int flushed = ops->syncfs_path(ops->ctx, target);
    int unmounted = ops->umount(ops->ctx, target);
    if (unmounted != 0) return -2;   /* still mounted: the caller must get it out before it may claim an orderly stop */
    return flushed == 0 ? 0 : -1;
}
