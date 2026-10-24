/*
 * The data-volume roots of a conversation set (image with `file-channel-v1` only; written by PID 1).
 *
 * The supervisor's guest file service (agent-sdk FC4) answers a read only from a root that is ext4 on the admitted device, owned by root, in the workspace
 * group and mode 02770 (setgid, so what the tools create below it keeps the group). It refuses any other root as `file_unavailable`, and that refusal is intended.
 * So for every root of every conversation PID 1 creates the root's `source` directory below /workspace as root:workspaceGid, mode 02770, before the
 * supervisor starts. Everything above the root is root:root 0711 (traversable, not listable). Host-backed share mount points (the outputs share and the
 * memory share) are not data-volume roots: their directories are the share's, not PID 1's, and are left alone. Walks use O_NOFOLLOW from a held descriptor.
 * The plan view (contract 12.5, /workspace/plan/<sid>/<epoch>) is the exception: it is the conversation's own, so the EPOCH directory belongs to that conversation's toolUid
 * (group = the same id, mode 0700), never to the workspace group, which several conversations of a workspace may share. /workspace/plan and /workspace/plan/<sid> are
 * root:root 0711: the folder of the id is the record of the epochs ever made, which the tool uid must not be able to edit.
 * Portable POSIX (the native tests run it on a temporary tree with a recording fchown).
 */
#ifndef WG_DATAROOTS_H
#define WG_DATAROOTS_H

#include <dirent.h>
#include <stddef.h>
#include <sys/types.h>

#include "boot.h"

#ifdef WG_FILE_CHANNEL_V1
struct wg_dataroots_ops {
    void *ctx;
    int (*fchown_fd)(int fd, uid_t uid, gid_t gid, void *ctx);
    uid_t owner;                                                  /* "root" for a root directory: 0 in PID 1; the native tests run as themselves */
    uid_t parent_owner;                                           /* "root" for the directories above it (the same 0; a test sets it apart to reach that check as a non-root user) */
    /* Optional (NULL in PID 1): what the file system will report for an owner PID 1 asked fchown to set, for a test that cannot chown to the conversation's tool uid. The
     * check of the result then compares against the mapped pair, so it stays a real check. */
    void (*stored)(uid_t *uid, gid_t *gid, void *ctx);
    /* Optional (NULL in PID 1 = readdir(3)): the directory reader of the epoch scan, so a test can make a read fail. */
    struct dirent *(*read_entry)(DIR *directory, void *ctx);
    gid_t owner_group;                                            /* "root"'s group, for the plan directories that are root:root (0 in PID 1; a test uses its own) */
};

/* 1 when `source` is a host-backed share mount point or below one: /workspace/outputs and /workspace/.winter/memory. */
int wg_data_root_is_share_mount(const char *source);

/* PID 1's own: root owns the roots and the directories above them, and fchown(2) is the real one. */
extern const struct wg_dataroots_ops wg_dataroots_production;

/* 0 when every data-volume root exists as described above; -1 on anything else (a symlink, a root-foreign intermediate directory). A root that two conversations name with
 * different groups ends up with the later one's: the other conversation's file service then refuses it (`file_unavailable`), which fails closed. `workspace_path` is where the
 * data volume is mounted; `ops` is mandatory. */
int wg_make_data_roots(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops);

/* Only the plan views (/workspace/plan/<sid>/<epoch>, contract 12.5) of the set, for a workspace without a browse uid (wg_make_data_roots makes them too, with every other root): each is
 * this conversation's own, the epoch canonical (at most nine digits) and not below one already on the disk (the data disk is the record of the epochs ever made, an earlier epoch is
 * never made again or touched), made as a directory of the conversation's toolUid (group toolUid) mode 0700, below /workspace/plan and /workspace/plan/<sid>, both root:root 0711 (the folder of the
 * id is the record of past epochs, which the tool uid must not be able to edit). 0 or -1. */
int wg_make_plan_views(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops);
#endif

#endif
