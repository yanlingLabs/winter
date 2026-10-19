/*
 * The data-volume roots of a conversation set (image with `file-channel-v1` only; written by PID 1).
 *
 * The supervisor's guest file service (agent-sdk FC4) answers a read only from a root that is ext4 on the admitted device, owned by root, in the workspace
 * group and mode 02770 (setgid, so what the tools create below it keeps the group). It refuses any other root as `file_unavailable`, and that refusal is intended.
 * So for every root of every conversation PID 1 creates the root's `source` directory below /workspace as root:workspaceGid, mode 02770, before the
 * supervisor starts. Everything above the root is root:root 0711 (traversable, not listable). Host-backed share mount points (the outputs share and the
 * memory share) are not data-volume roots: their directories are the share's, not PID 1's, and are left alone. Walks use O_NOFOLLOW from a held descriptor.
 * Portable POSIX (the native tests run it on a temporary tree with a recording fchown).
 */
#ifndef WG_DATAROOTS_H
#define WG_DATAROOTS_H

#include <stddef.h>
#include <sys/types.h>

#include "boot.h"

#ifdef WG_FILE_CHANNEL_V1
struct wg_dataroots_ops {
    void *ctx;
    int (*fchown_fd)(int fd, uid_t uid, gid_t gid, void *ctx);
    uid_t owner;                                                  /* "root" for a root directory: 0 in PID 1; the native tests run as themselves */
    uid_t parent_owner;                                           /* "root" for the directories above it (the same 0; a test sets it apart to reach that check as a non-root user) */
};

/* 1 when `source` is a host-backed share mount point or below one: /workspace/outputs and /workspace/.winter/memory. */
int wg_data_root_is_share_mount(const char *source);

/* PID 1's own: root owns the roots and the directories above them, and fchown(2) is the real one. */
extern const struct wg_dataroots_ops wg_dataroots_production;

/* 0 when every data-volume root exists as described above; -1 on anything else (a symlink, a root-foreign intermediate directory). A root that two conversations name with
 * different groups ends up with the later one's: the other conversation's file service then refuses it (`file_unavailable`), which fails closed. `workspace_path` is where the
 * data volume is mounted; `ops` is mandatory. */
int wg_make_data_roots(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops);
#endif

#endif
