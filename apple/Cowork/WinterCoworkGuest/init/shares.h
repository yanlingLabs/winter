/*
 * The guest side of host-backed shares (image with `file-channel-v1` only; written by PID 1). Design 2026-10-18 n2-extensions sections 2.1, 2.5 and R6.
 *
 * After the data volume is mounted and before the conversation set, PID 1 receives the validated share set from the helper and, in this order:
 *   1. reads the virtio-fs tag inventory the kernel publishes (<sys>/fs/virtiofs/<n>/tag). It must equal the declared tags exactly: no extra, missing or
 *      repeated tag, and as many virtio devices of type 26 (virtio-fs) on the bus as there are tags, so a device the driver did not take is an extra device
 *      too. Anything else is `share_inventory`;
 *   2. checks or makes each mount point. The three Winter mount points are the skeleton's (made with the data volume and /run); a folder's
 *      /workspace/folders/<name> is created when missing, root's, mode 0700 (PID 1's umask), below the skeleton's /workspace/folders, and never chowned or
 *      chmodded. Every component is opened without following a link;
 *   3. mounts each tag on the checked mount point's descriptor (/proc/self/fd/<n>, so the path is never resolved a second time): mount(tag, guestPath, "virtiofs", MS_NOSUID|MS_NODEV [|MS_RDONLY when read-only] [|MS_NOEXEC on guidance, memory and outputs],
 *      "dax=never"). Folder sources keep exec: builds run there;
 *   4. checks every mount in /proc/self/mountinfo: exactly one mount at the guest path, the whole share (root "/"), fstype virtiofs, source the tag, `ro`
 *      exactly when read-only, nosuid and nodev, noexec exactly on a Winter share, and `dax=never` as the only DAX option; and no other mount of the tag;
 *   5. makes the alias /workspace/.winter/WINTER.md, a root-owned symlink to /run/winter/shared-instructions/WINTER.md, when the guidance share is in the set
 *      (an existing alias is kept only if it is exactly that link).
 * Any failure after a mount unmounts what this step mounted (the last first). Nothing here ever changes the owner or mode of a mount point or of anything on
 * a share: the host serves shares under simplified ownership, so guest ownership and modes there are no boundary (test_shares.py holds that).
 * Portable POSIX: the native tests run it against a temporary tree, a fake sysfs and a recorded mount table.
 */
#ifndef WG_SHARES_H
#define WG_SHARES_H

#include <stddef.h>
#include <sys/types.h>

#include "boot.h"

#ifdef WG_FILE_CHANNEL_V1
#define WG_SHARE_FSTYPE "virtiofs"
#define WG_SHARE_MOUNT_DATA "dax=never"
#define WG_SHARE_GUIDANCE_ALIAS_DIRECTORY "/workspace/.winter"
#define WG_SHARE_GUIDANCE_ALIAS_NAME "WINTER.md"
#define WG_SHARE_GUIDANCE_ALIAS_TARGET "/run/winter/shared-instructions/WINTER.md"
#define WG_VIRTIO_FS_DEVICE_ID "0x001a"
#define WG_MOUNTINFO_MAX 65536u

struct wg_share_ops {
    void *ctx;
    const char *root;        /* "" in PID 1: a guest path P is the path root + P (the native tests point it at a temporary tree) */
    const char *sys_root;    /* "/sys" */
    int (*mount)(void *ctx, const char *source, const char *target, const char *fstype, unsigned long flags, const char *data);
    int (*umount)(void *ctx, const char *target);
    /* the whole of /proc/self/mountinfo into out (no terminator needed); its length, or -1 (also when it does not fit) */
    long (*read_mountinfo)(void *ctx, char *out, size_t capacity);
    uid_t owner;             /* the owner of every directory on the way to a mount point, and of the alias: 0 in PID 1 */
};

/* The mount(2) flags of one share (WG_MS_* values, mounts.h). */
unsigned long wg_share_mount_flags(const struct wg_share *share);

/* 0 when the virtio-fs inventory under sys_root is exactly the set's tags (step 1). */
int wg_share_inventory(const char *sys_root, const struct wg_share_set *set);

/* One mountinfo entry as the kernel prints it, the fields this module judges. */
struct wg_mountinfo_entry {
    char root[256], mount_point[256], options[256], fstype[64], source[256], super_options[512];
};
/* How many entries of `text` are mounted at `where`; the last one is copied into *entry (when not NULL). -1 for a line that is not a mountinfo line. */
int wg_mountinfo_find(const char *text, size_t length, const char *where, struct wg_mountinfo_entry *entry);
/* 0 when `text` shows `share` mounted at `where` exactly as step 4 requires. */
int wg_share_mountinfo_ok(const char *text, size_t length, const char *where, const struct wg_share *share);
/* The same check for any filesystem: `fstype`, mount source `source`, and the mount's one data option `data_option` (KEY=VALUE: present once, no other KEY option).
 * wg_share_mountinfo_ok is this with virtiofs, the tag and dax=never; the root-only CI tests run it on the kernel's own output for a real mount. */
int wg_mountinfo_entry_ok(const char *text, size_t length, const char *where, const struct wg_share *share, const char *fstype, const char *source, const char *data_option);

/* Step 2 for one share. 0 when the mount point is in place. */
int wg_share_mount_point(const char *root, const struct wg_share *share, uid_t owner);

/* Step 5. 0 when the alias exists and is exactly the expected link. */
int wg_share_guidance_alias(const char *root, uid_t owner);

/* Steps 1 to 5. Returns WG_SHARES_MOUNTED, WG_SHARES_INVENTORY or WG_SHARES_MOUNT_FAILED; *mounted as in boot.h's mount_shares. Each mount's target is the
 * descriptor of the mount point the walk checked (/proc/self/fd/<n>). PID 1 calls only this. */
int wg_mount_shares(const struct wg_share_ops *ops, const struct wg_share_set *set, unsigned *mounted);
/* The same step with another filesystem type and data option: wg_mount_shares is this with virtiofs and dax=never. Only the root-only CI test calls it, to run the
 * whole step for real (tmpfs) on a runner that has no virtio-fs device. */
int wg_mount_shares_as(const struct wg_share_ops *ops, const struct wg_share_set *set, unsigned *mounted, const char *fstype, const char *data);
#endif

#endif
