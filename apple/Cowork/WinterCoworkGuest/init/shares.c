#define _GNU_SOURCE
#include "shares.h"

#ifdef WG_FILE_CHANNEL_V1
#include "mounts.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

unsigned long wg_share_mount_flags(const struct wg_share *share) {
    unsigned long flags = WG_MS_NOSUID | WG_MS_NODEV;
    if (share->read_only) flags |= WG_MS_RDONLY;
    if (share->kind != WG_SHARE_FOLDER) flags |= WG_MS_NOEXEC;   /* guidance, memory and outputs; a folder source keeps exec, builds run there */
    return flags;
}

static int join(char *out, size_t capacity, const char *a, const char *b) {
    int n = snprintf(out, capacity, "%s%s", a, b);
    return n < 0 || (size_t)n >= capacity ? -1 : 0;
}

/* A small sysfs attribute: at most capacity - 2 bytes, so a longer one is refused rather than cut. */
static int read_attribute(const char *path, char *out, size_t capacity, size_t *length) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    ssize_t n = read(fd, out, capacity - 1);
    close(fd);
    if (n < 0 || (size_t)n >= capacity - 1) return -1;
    out[n] = '\0';
    *length = (size_t)n;
    return 0;
}

static int all_digits(const char *name) {
    size_t n = strlen(name);
    if (n == 0 || n > 10) return 0;
    for (size_t i = 0; i < n; i++) if (name[i] < '0' || name[i] > '9') return 0;
    return 1;
}

/* How many virtio devices of type 26 (virtio-fs) are on the bus, bound to a driver or not; -1 when the bus cannot be read. */
static int virtio_fs_devices(const char *sys_root) {
    char path[512];
    if (join(path, sizeof path, sys_root, "/bus/virtio/devices") != 0) return -1;
    DIR *directory = opendir(path);
    if (!directory) return -1;
    int count = 0, result = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char file[768], value[32];
        size_t length = 0;
        if (snprintf(file, sizeof file, "%s/%s/device", path, entry->d_name) >= (int)sizeof file || read_attribute(file, value, sizeof value, &length) != 0) { result = -1; break; }
        if (length == sizeof WG_VIRTIO_FS_DEVICE_ID && memcmp(value, WG_VIRTIO_FS_DEVICE_ID "\n", length) == 0) count++;
    }
    closedir(directory);
    return result == 0 ? count : -1;
}

int wg_share_inventory(const char *sys_root, const struct wg_share_set *set) {
    char path[512];
    if (set->count < 1 || set->count > WG_SHARES_MAX || join(path, sizeof path, sys_root, "/fs/virtiofs") != 0) return -1;
    DIR *directory = opendir(path);
    if (!directory) return -1;   /* no virtio-fs driver, or it published nothing: every declared tag is missing */
    unsigned seen = 0, entries = 0;
    int result = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL && result == 0) {
        if (entry->d_name[0] == '.') continue;
        /* each device is a kobject named by its index; anything else under the kset is not what this kernel publishes */
        if (!all_digits(entry->d_name) || ++entries > WG_SHARES_MAX) { result = -1; break; }
        char file[768], tag[WG_SHARE_TAG_MAX + 3];
        size_t length = 0;
        if (snprintf(file, sizeof file, "%s/%s/tag", path, entry->d_name) >= (int)sizeof file || read_attribute(file, tag, sizeof tag, &length) != 0 ||
            length < 2 || tag[length - 1] != '\n') { result = -1; break; }
        tag[length - 1] = '\0';
        unsigned match = WG_SHARES_MAX;
        for (unsigned i = 0; i < set->count; i++) if (strcmp(set->item[i].tag, tag) == 0) { match = i; break; }
        if (match == WG_SHARES_MAX || (seen & (1u << match))) { result = -1; break; }   /* an extra device, or one tag twice */
        seen |= 1u << match;
    }
    closedir(directory);
    if (result != 0 || seen != (1u << set->count) - 1u) return -1;          /* a declared tag no device carries */
    return virtio_fs_devices(sys_root) == (int)set->count ? 0 : -1;        /* a virtio-fs device that published no tag is an extra device too */
}

/* ------------------------------------------------------------------------------------------------ mountinfo */

/* "ID PARENT MAJ:MIN ROOT MOUNTPOINT OPTIONS [OPTIONAL...] - FSTYPE SOURCE SUPEROPTIONS", one line per mount (proc(5)). */
#define MI_FIELDS 32
static int split(const char *line, size_t n, const char *field[MI_FIELDS], size_t size[MI_FIELDS]) {
    int count = 0;
    size_t at = 0;
    while (at < n) {
        size_t end = at;
        while (end < n && line[end] != ' ') end++;
        if (end == at || count == MI_FIELDS) return -1;   /* an empty field (two spaces) or more fields than a mountinfo line has */
        field[count] = line + at;
        size[count++] = end - at;
        at = end + (end < n);
        if (end < n && at == n) return -1;                 /* a trailing space */
    }
    return count;
}

static int same(const char *text, size_t n, const char *word) { return strlen(word) == n && memcmp(text, word, n) == 0; }

static int copy(char *out, size_t capacity, const char *text, size_t n) {
    if (n >= capacity) return -1;
    memcpy(out, text, n);
    out[n] = '\0';
    return 0;
}

/* Counts the entries at `where` (when not NULL) or of fstype virtiofs with source `tag` (when not NULL); the last entry at `where` goes to *entry. */
static int scan(const char *text, size_t length, const char *where, const char *tag, struct wg_mountinfo_entry *entry) {
    int found = 0;
    size_t at = 0;
    while (at < length) {
        const char *newline = memchr(text + at, '\n', length - at);
        if (!newline) return -1;                           /* the kernel ends every line */
        size_t n = (size_t)(newline - (text + at));
        const char *line = text + at;
        at += n + 1;
        const char *field[MI_FIELDS];
        size_t size[MI_FIELDS];
        int count = split(line, n, field, size);
        if (count < 10) return -1;
        int separator = -1;
        for (int i = 6; i < count; i++) if (same(field[i], size[i], "-")) { separator = i; break; }
        if (separator < 0 || separator + 4 != count) return -1;
        int at_where = where != NULL && same(field[4], size[4], where);
        int of_tag = tag != NULL && same(field[separator + 1], size[separator + 1], WG_SHARE_FSTYPE) && same(field[separator + 2], size[separator + 2], tag);
        if (!at_where && !of_tag) continue;
        found++;
        if (at_where && entry != NULL) {
            if (copy(entry->root, sizeof entry->root, field[3], size[3]) != 0 || copy(entry->mount_point, sizeof entry->mount_point, field[4], size[4]) != 0 ||
                copy(entry->options, sizeof entry->options, field[5], size[5]) != 0 || copy(entry->fstype, sizeof entry->fstype, field[separator + 1], size[separator + 1]) != 0 ||
                copy(entry->source, sizeof entry->source, field[separator + 2], size[separator + 2]) != 0 ||
                copy(entry->super_options, sizeof entry->super_options, field[separator + 3], size[separator + 3]) != 0) return -1;
        }
    }
    return found;
}

int wg_mountinfo_find(const char *text, size_t length, const char *where, struct wg_mountinfo_entry *entry) {
    return scan(text, length, where, NULL, entry);
}

/* How many comma-separated options of `list` are exactly `word` (with `prefix`: start with it). */
static int options_named(const char *list, const char *word, int prefix) {
    int found = 0;
    size_t n = strlen(word);
    for (const char *p = list; *p;) {
        const char *comma = strchr(p, ',');
        size_t length = comma ? (size_t)(comma - p) : strlen(p);
        if (prefix ? (length >= n && memcmp(p, word, n) == 0) : (length == n && memcmp(p, word, n) == 0)) found++;
        p += length + (comma != NULL);
    }
    return found;
}

int wg_share_mountinfo_ok(const char *text, size_t length, const char *where, const struct wg_share *share) {
    struct wg_mountinfo_entry entry;
    if (wg_mountinfo_find(text, length, where, &entry) != 1) return -1;   /* nothing there, or something mounted over (or under) it */
    if (strcmp(entry.root, "/") != 0 || strcmp(entry.fstype, WG_SHARE_FSTYPE) != 0 || strcmp(entry.source, share->tag) != 0) return -1;
    if (options_named(entry.options, "ro", 0) != (share->read_only ? 1 : 0) || options_named(entry.options, "rw", 0) != (share->read_only ? 0 : 1)) return -1;
    if (options_named(entry.options, "nosuid", 0) != 1 || options_named(entry.options, "nodev", 0) != 1) return -1;
    if (options_named(entry.options, "noexec", 0) != (share->kind != WG_SHARE_FOLDER ? 1 : 0)) return -1;
    /* R6: no DAX. The fuse client prints the DAX mode it runs with; it must be `never`, and nothing else may name DAX. */
    if (options_named(entry.super_options, WG_SHARE_MOUNT_DATA, 0) != 1 || options_named(entry.super_options, "dax", 1) != 1) return -1;
    if (scan(text, length, NULL, share->tag, NULL) != 1) return -1;       /* the tag is mounted here and nowhere else */
    return 0;
}

/* ------------------------------------------------------------------------------------------------ mount points and the alias */

/* Opens root + `directory` (an absolute guest path) component by component, never through a link; every component must be a directory owned by `owner`.
 * With `create_last`, a missing last component is made (mode 0700 before the umask, owner by who makes it: PID 1). The root prefix itself is the caller's. */
static int open_chain(const char *root, const char *directory, uid_t owner, int create_last) {
    int current = open(root[0] ? root : "/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (current < 0) return -1;
    const char *p = directory;
    if (*p != '/') { close(current); return -1; }
    p++;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t n = slash ? (size_t)(slash - p) : strlen(p);
        char name[256];
        if (n == 0 || n >= sizeof name || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) { close(current); return -1; }
        memcpy(name, p, n);
        name[n] = '\0';
        int last = slash == NULL;
        int next = openat(current, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0 && last && create_last && errno == ENOENT) {
            if (mkdirat(current, name, 0700) != 0 && errno != EEXIST) { close(current); return -1; }
            next = openat(current, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        }
        struct stat parent, st;
        int ok = next >= 0 && fstat(current, &parent) == 0 && fstat(next, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == owner;
        /* the mount point is not a mount point yet: it sits on its parent's filesystem */
        if (ok && last) ok = st.st_dev == parent.st_dev;
        close(current);
        if (!ok) { if (next >= 0) close(next); return -1; }
        current = next;
        p += n + (slash != NULL);
    }
    return current;
}

int wg_share_mount_point(const char *root, const struct wg_share *share, uid_t owner) {
    /* Only a folder's mount point may be made here, and only directly below the skeleton's /workspace/folders; the Winter ones are the skeleton's own. */
    int create = share->kind == WG_SHARE_FOLDER;
    if (create && (strncmp(share->guest_path, WG_SHARE_FOLDERS_PREFIX, sizeof WG_SHARE_FOLDERS_PREFIX - 1) != 0 ||
                   strchr(share->guest_path + sizeof WG_SHARE_FOLDERS_PREFIX - 1, '/') != NULL)) return -1;
    int fd = open_chain(root, share->guest_path, owner, create);
    if (fd < 0) return -1;
    close(fd);
    return 0;
}

int wg_share_guidance_alias(const char *root, uid_t owner) {
    int directory = open_chain(root, WG_SHARE_GUIDANCE_ALIAS_DIRECTORY, owner, 0);
    if (directory < 0) return -1;
    static const char target[] = WG_SHARE_GUIDANCE_ALIAS_TARGET;
    int rc = 0;
    if (symlinkat(target, directory, WG_SHARE_GUIDANCE_ALIAS_NAME) != 0 && errno != EEXIST) rc = -1;
    /* made now or left by an earlier boot: it must be exactly this link, and PID 1's */
    struct stat st;
    char text[sizeof target + 1];
    if (rc == 0 && (fstatat(directory, WG_SHARE_GUIDANCE_ALIAS_NAME, &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISLNK(st.st_mode) || st.st_uid != owner)) rc = -1;
    if (rc == 0) {
        ssize_t n = readlinkat(directory, WG_SHARE_GUIDANCE_ALIAS_NAME, text, sizeof text);
        if (n != (ssize_t)(sizeof target - 1) || memcmp(text, target, sizeof target - 1) != 0) rc = -1;
    }
    close(directory);
    return rc;
}

/* ------------------------------------------------------------------------------------------------ the step */

static char mountinfo[WG_MOUNTINFO_MAX];

static int where_of(const struct wg_share_ops *ops, const struct wg_share *share, char *out, size_t capacity) {
    return join(out, capacity, ops->root, share->guest_path);
}

int wg_mount_shares(const struct wg_share_ops *ops, const struct wg_share_set *set, unsigned *mounted) {
    *mounted = 0;
    if (wg_share_inventory(ops->sys_root, set) != 0) return WG_SHARES_INVENTORY;
    char where[WG_SHARE_PATH_MAX + 4096];
    int result = WG_SHARES_MOUNT_FAILED;
    for (unsigned i = 0; i < set->count; i++)
        if (wg_share_mount_point(ops->root, &set->item[i], ops->owner) != 0) return WG_SHARES_MOUNT_FAILED;
    for (unsigned i = 0; i < set->count; i++) {
        if (where_of(ops, &set->item[i], where, sizeof where) != 0) goto rollback;
        if (ops->mount(ops->ctx, set->item[i].tag, where, WG_SHARE_FSTYPE, wg_share_mount_flags(&set->item[i]), WG_SHARE_MOUNT_DATA) != 0) goto rollback;
        *mounted |= 1u << i;
    }
    long length = ops->read_mountinfo(ops->ctx, mountinfo, sizeof mountinfo);
    if (length < 0) goto rollback;
    for (unsigned i = 0; i < set->count; i++) {
        if (where_of(ops, &set->item[i], where, sizeof where) != 0 || wg_share_mountinfo_ok(mountinfo, (size_t)length, where, &set->item[i]) != 0) goto rollback;
    }
    for (unsigned i = 0; i < set->count; i++)
        if (set->item[i].kind == WG_SHARE_GUIDANCE && wg_share_guidance_alias(ops->root, ops->owner) != 0) goto rollback;
    return WG_SHARES_MOUNTED;
rollback:
    for (unsigned i = set->count; i-- > 0;) {
        if (!(*mounted & (1u << i))) continue;
        if (where_of(ops, &set->item[i], where, sizeof where) == 0 && ops->umount(ops->ctx, where) == 0) *mounted &= ~(1u << i);
    }
    return result;
}
#endif
