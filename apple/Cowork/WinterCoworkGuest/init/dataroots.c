#define _GNU_SOURCE
#include "dataroots.h"

#ifdef WG_FILE_CHANNEL_V1
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WORKSPACE_PREFIX "/workspace/"
#define ROOT_MODE 02770
#define PARENT_MODE 0711
#define PLAN_ROOT "/workspace/plan"

static int under(const char *source, const char *directory) {
    size_t n = strlen(directory);
    return strncmp(source, directory, n) == 0 && (source[n] == '\0' || source[n] == '/');
}

/* The plan view (contract 12.5): `source` is exactly /workspace/plan/<sid>/<epoch>, <sid> this conversation's own logicalSessionId, <epoch> a canonical decimal of at most nine digits
 * (no sign, no leading zero, nothing deeper). Returns the epoch, or -1 for anything else that is at or under /workspace/plan. */
static long plan_view_epoch(const char *source, const char *session_id) {
    static const char prefix[] = "/workspace/plan/";
    size_t id_length = strlen(session_id);
    if (strncmp(source, prefix, sizeof prefix - 1) != 0) return -1;
    const char *at = source + sizeof prefix - 1;
    if (strncmp(at, session_id, id_length) != 0 || at[id_length] != '/') return -1;
    const char *digits = at + id_length + 1;
    size_t n = strlen(digits);
    if (n < 1 || n > 9 || (n > 1 && digits[0] == '0')) return -1;
    long epoch = 0;
    for (size_t i = 0; i < n; i++) {
        if (digits[i] < '0' || digits[i] > '9') return -1;
        epoch = epoch * 10 + (digits[i] - '0');
    }
    return epoch;
}

/* The data disk is the record of which epochs were ever made: an epoch below one that already exists beside it is stale and is never made again (the supervisor refuses it too).
 * The walk never follows a link and an unreadable parent refuses. A missing /workspace/plan or /workspace/plan/<sid> means no earlier epoch. 0 = fine, -1 = refuse. */
static int plan_epoch_is_current(int workspace, const char *session_id, long epoch, uid_t parent_owner) {
    int plan = openat(workspace, &PLAN_ROOT[sizeof WORKSPACE_PREFIX - 1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (plan < 0) return errno == ENOENT ? 0 : -1;
    int parent = openat(plan, session_id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(plan);
    if (parent < 0) return saved == ENOENT ? 0 : -1;
    struct stat st;
    if (fstat(parent, &st) != 0 || st.st_uid != parent_owner) { close(parent); return -1; }
    DIR *directory = fdopendir(parent);
    if (!directory) { close(parent); return -1; }
    int result = 0;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        const char *name = entry->d_name;
        size_t n = strlen(name);
        if (n < 1 || n > 9 || (n > 1 && name[0] == '0')) continue;       /* not a canonical epoch name */
        long value = 0;
        size_t i = 0;
        for (; i < n && name[i] >= '0' && name[i] <= '9'; i++) value = value * 10 + (name[i] - '0');
        if (i == n && value > epoch) { result = -1; break; }
    }
    if (result == 0 && errno != 0) result = -1;                          /* a read error is not "no later epoch" */
    closedir(directory);
    return result;
}

int wg_data_root_is_share_mount(const char *source) {
    return under(source, "/workspace/outputs") || under(source, "/workspace/.winter/memory") || under(source, "/workspace/folders");
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
            /* mkdirat's mode is filtered by PID 1's umask(077), which would leave every parent 0700 and unreachable for the browse and tool uids: set it on the descriptor, then read it back. */
            if (fchmod(current, PARENT_MODE) != 0 || fstat(current, &st) != 0 || (st.st_mode & 07777) != PARENT_MODE) { close(current); return -1; }
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

static int make_roots(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops, int plan_only) {
    int workspace = open(workspace_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (workspace < 0) return -1;
    int rc = 0;
    for (unsigned i = 0; i < set->count && rc == 0; i++) {
        for (unsigned r = 0; r < set->root_count[i] && rc == 0; r++) {
            const char *source = set->root_source[i][r];
            if (strncmp(source, WORKSPACE_PREFIX, sizeof WORKSPACE_PREFIX - 1) != 0) { rc = -1; break; }
            if (wg_data_root_is_share_mount(source)) continue;
            if (under(source, PLAN_ROOT)) {
                long epoch = plan_view_epoch(source, set->session_id[i]);
                if (epoch < 0 || plan_epoch_is_current(workspace, set->session_id[i], epoch, ops->parent_owner) != 0) { rc = -1; break; }
            } else if (plan_only) {
                continue;
            }
            rc = make_one(workspace, source, (gid_t)set->workspace_gid[i], ops);
        }
    }
    close(workspace);
    return rc;
}

int wg_make_data_roots(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops) {
    return make_roots(workspace_path, set, ops, 0);
}

int wg_make_plan_views(const char *workspace_path, const struct wg_conversation_set *set, const struct wg_dataroots_ops *ops) {
    return make_roots(workspace_path, set, ops, 1);
}
#endif
