#define _GNU_SOURCE
#include "dataroots.h"

#ifdef WG_FILE_CHANNEL_V1
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WORKSPACE_PREFIX "/workspace/"
#define ROOT_MODE 02770
#define PARENT_MODE 0711

static int under(const char *source, const char *directory) {
    size_t n = strlen(directory);
    return strncmp(source, directory, n) == 0 && (source[n] == '\0' || source[n] == '/');
}

int wg_data_root_is_share_mount(const char *source) {
    return under(source, "/workspace/outputs") || under(source, "/workspace/.winter/memory");
}

static int real_fchown(int fd, uid_t uid, gid_t gid, void *ctx) {
    (void)ctx;
    return fchown(fd, uid, gid);
}
const struct wg_dataroots_ops wg_dataroots_production = { NULL, real_fchown, 0, 0 };

/* One component below `parent`: created (mode `create_mode`) when missing, opened without following a link. */
static int open_component(int parent, const char *name, mode_t create_mode) {
    if (mkdirat(parent, name, create_mode) != 0 && errno != EEXIST) return -1;
    return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

static int make_one(int workspace, const char *source, gid_t gid, const struct wg_dataroots_ops *ops) {
    const char *path = source + sizeof WORKSPACE_PREFIX - 1;
    uid_t owner = ops->owner, parent_owner = ops->parent_owner;
    int current = dup(workspace);
    if (current < 0) return -1;
    for (;;) {
        const char *slash = strchr(path, '/');
        size_t length = slash ? (size_t)(slash - path) : strlen(path);
        char name[65];
        if (length > 64) { close(current); return -1; }                   /* (an empty component fails in mkdirat) */
        memcpy(name, path, length);
        name[length] = '\0';
        int last = slash == NULL;
        int next = open_component(current, name, last ? 0700 : PARENT_MODE);
        close(current);
        if (next < 0) return -1;
        current = next;
        struct stat st;
        if (fstat(current, &st) != 0) { close(current); return -1; }
        if (!last) {
            if (st.st_uid != parent_owner) { close(current); return -1; }   /* a directory above a root is root's, whoever else might have made it */
            path = slash + 1;
            continue;
        }
        int rc = ops->fchown_fd(current, owner, gid, ops->ctx);
        if (rc == 0) rc = fchmod(current, ROOT_MODE);               /* after the chown: a chown clears the setgid bit */
        if (rc == 0 && (fstat(current, &st) != 0 || st.st_uid != owner || st.st_gid != gid)) rc = -1;   /* what the descriptor now says, not what the calls returned */
        close(current);
        return rc;
    }
}

int wg_make_data_roots(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops) {
    int workspace = open(workspace_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (workspace < 0) return -1;
    int rc = 0;
    for (unsigned i = 0; i < set->count && rc == 0; i++) {
        for (unsigned r = 0; r < set->root_count[i] && rc == 0; r++) {
            const char *source = set->root_source[i][r];
            if (strncmp(source, WORKSPACE_PREFIX, sizeof WORKSPACE_PREFIX - 1) != 0) { rc = -1; break; }
            if (wg_data_root_is_share_mount(source)) continue;
            rc = make_one(workspace, source, (gid_t)set->workspace_gid[i], ops);
        }
    }
    close(workspace);
    return rc;
}
#endif
