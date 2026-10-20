#define _GNU_SOURCE
#include "skeleton.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* /workspace is the data volume. Tools never see this tree directly: the supervisor builds each conversation's view from
 * admitted roots. 0711 lets a conversation's runtime identity traverse to its own 0700 store without listing anything. */
const struct wg_skeleton_entry WG_WORKSPACE_SKELETON[] = {
    { ".", 0711, 0, 0 },
    { ".winter", 0711, 0, 0 },
    { ".winter/conversations", 0711, 0, 0 },
    { ".winter/scratch", 0711, 0, 0 },
    { ".winter/memory", 0711, 0, 0 },   /* mount point for the host-backed memory share (outside this slice) */
    { "repos", 0711, 0, 0 },
    { "folders", 0711, 0, 0 },
    { "outputs", 0711, 0, 0 },          /* mount point for the host-backed outputs share (outside this slice) */
};
const size_t WG_WORKSPACE_SKELETON_COUNT = sizeof WG_WORKSPACE_SKELETON / sizeof WG_WORKSPACE_SKELETON[0];

/* /run is a fresh tmpfs. control/ is the supervisor's controlDirectory (root-owned, 0700 or 0711); trusted/ holds the trusted
 * config PID 1 writes when the host's conversation set arrives, and is root-only. */
const struct wg_skeleton_entry WG_RUN_SKELETON[] = {
    { "winter", 0711, 0, 0 },
    { "winter/control", 0711, 0, 0 },
    { "winter/conversations", 0711, 0, 0 },
    { "winter/shared-instructions", 0755, 0, 0 },
    { "winter/trusted", 0700, 0, 0 },
};
const size_t WG_RUN_SKELETON_COUNT = sizeof WG_RUN_SKELETON / sizeof WG_RUN_SKELETON[0];

static int component_ok(const char *start, size_t length) {
    if (length == 0 || length > 64) return 0;
    if ((length == 1 && start[0] == '.') || (length == 2 && start[0] == '.' && start[1] == '.')) return 0;
    for (size_t i = 0; i < length; i++) {
        char c = start[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static int apply_one(int root_fd, const struct wg_skeleton_entry *entry, const struct wg_skeleton_ops *ops) {
    int current = -1;
    if (strcmp(entry->path, ".") == 0) {
        current = dup(root_fd);
    } else {
        current = dup(root_fd);
        const char *p = entry->path;
        while (current >= 0) {
            const char *slash = strchr(p, '/');
            size_t length = slash ? (size_t)(slash - p) : strlen(p);
            if (!component_ok(p, length)) { close(current); return -1; }
            char name[65];
            memcpy(name, p, length);
            name[length] = '\0';
            if (!slash) {
                if (mkdirat(current, name, 0700) != 0 && errno != EEXIST) { close(current); return -1; }
            }
            int next = openat(current, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            close(current);
            current = next;
            if (!slash) break;
            p = slash + 1;
        }
    }
    if (current < 0) return -1;
    int rc = ops && ops->fchown_fd ? ops->fchown_fd(current, (uid_t)entry->uid, (gid_t)entry->gid, ops->ctx)
                                   : fchown(current, (uid_t)entry->uid, (gid_t)entry->gid);
    if (rc == 0) rc = fchmod(current, (mode_t)entry->mode);
    struct stat st;
    if (rc == 0 && (fstat(current, &st) != 0 || !S_ISDIR(st.st_mode) || (st.st_mode & 07777) != entry->mode)) rc = -1;
    close(current);
    return rc;
}

int wg_skeleton_apply(int root_fd, const struct wg_skeleton_entry *entries, size_t count, const struct wg_skeleton_ops *ops) {
    for (size_t i = 0; i < count; i++)
        if (apply_one(root_fd, &entries[i], ops) != 0) return (int)i + 1;
    return 0;
}
