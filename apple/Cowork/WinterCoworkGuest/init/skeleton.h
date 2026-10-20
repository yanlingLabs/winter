/*
 * The protected directory skeleton PID 1 creates after the volumes are mounted (N2 slice S5, docs/cowork-execution-contracts.md
 * "Protect the directory skeleton and ancestors"). Every directory is created or adopted component by component with
 * openat(O_NOFOLLOW|O_DIRECTORY), so a symlink or a file in the way is a refusal; only the LAST component of an entry is ever
 * created, so a table that lists a child before its parent fails instead of building stray trees. Ownership and mode are
 * set on the open descriptor, never by path. Portable POSIX.
 */
#ifndef WG_SKELETON_H
#define WG_SKELETON_H

#include <stddef.h>
#include <sys/types.h>

struct wg_skeleton_entry {
    const char *path;   /* relative to the root descriptor; "." is the root itself */
    unsigned mode;
    unsigned uid, gid;
};

struct wg_skeleton_ops {
    int (*fchown_fd)(int fd, uid_t uid, gid_t gid, void *ctx); /* NULL = fchown(2) */
    void *ctx;
};

/* Returns 0, or the 1-based index of the entry that failed (negated errno is not leaked). */
int wg_skeleton_apply(int root_fd, const struct wg_skeleton_entry *entries, size_t count, const struct wg_skeleton_ops *ops);

extern const struct wg_skeleton_entry WG_WORKSPACE_SKELETON[];
extern const size_t WG_WORKSPACE_SKELETON_COUNT;
extern const struct wg_skeleton_entry WG_RUN_SKELETON[];
extern const size_t WG_RUN_SKELETON_COUNT;

#endif
