/*
 * Native driver of the share step (init/shares.c) and of PID 1's share payload parser (init/boot.c), for test_shares.py. Built with WG_FILE_CHANNEL_V1; never part of
 * the guest image. A share on the command line is KIND:RO:TAG:PATH (KIND folder|guidance|memory|outputs, RO 0|1). Every effect of the step goes through recording
 * operations: nothing is mounted, and the directories it makes are made in the temporary tree the test names, as the invoking user.
 *
 *   flags SHARE                               the mount flags of one share
 *   parse HEX                                 wg_parse_share_payload: `refused`, or `count` then one `kind:ro:tag:path` line per share
 *   inventory SYS SHARE...                    wg_share_inventory: rc
 *   find MOUNTINFO WHERE                      wg_mountinfo_find on a file: count, then the fields of the entry
 *   check MOUNTINFO WHERE SHARE               wg_share_mountinfo_ok: rc
 *   checkas MOUNTINFO WHERE SHARE FS SRC DATA wg_mountinfo_entry_ok: rc
 *   point ROOT SHARE                          wg_share_mount_point as the invoking user: rc
 *   alias ROOT                                wg_share_guidance_alias as the invoking user: rc
 *   step ROOT SYS MOUNTINFO FAIL SHARE...     wg_mount_shares; FAIL is `-`, `mount:N` (the Nth mount fails), `umount` (every unmount fails) or `mountinfo` (it cannot be
 *                                             read). MOUNTINFO is read as the table after the mounts, with @ROOT@ replaced by ROOT. Prints every effect (a
 *                                             mount with the inode of the directory its /proc/self/fd/<n> target holds), then rc and the mask.
 */
#define _GNU_SOURCE
#include "../init/boot.h"
#include "../init/mounts.h"
#include "../init/shares.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Who the walk treats as PID 1: the invoking user, or SHARES_OWNER (a test reaches the owner check as an ordinary user that way). */
static uid_t owner(void) {
    const char *value = getenv("SHARES_OWNER");
    return value ? (uid_t)strtoul(value, NULL, 10) : getuid();
}

static int parse_share(const char *text, struct wg_share *share) {
    char kind[16];
    int ro = 0, used = 0;
    memset(share, 0, sizeof *share);
    if (sscanf(text, "%15[a-z]:%d:%32[a-z0-9-]:%n", kind, &ro, share->tag, &used) != 3 || used == 0) return -1;
    snprintf(share->guest_path, sizeof share->guest_path, "%s", text + used);
    share->read_only = ro;
    if (strcmp(kind, "folder") == 0) share->kind = WG_SHARE_FOLDER;
    else if (strcmp(kind, "guidance") == 0) share->kind = WG_SHARE_GUIDANCE;
    else if (strcmp(kind, "memory") == 0) share->kind = WG_SHARE_MEMORY;
    else if (strcmp(kind, "outputs") == 0) share->kind = WG_SHARE_OUTPUTS;
    else return -1;
    return 0;
}
static void set_of(int argc, char **argv, int first, struct wg_share_set *set) {
    memset(set, 0, sizeof *set);
    for (int i = first; i < argc && set->count < WG_SHARES_MAX; i++)
        if (parse_share(argv[i], &set->item[set->count++]) != 0) { fprintf(stderr, "bad share %s\n", argv[i]); exit(2); }
}

static char *slurp(const char *path, size_t *length) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    static char buffer[1 << 17];
    *length = fread(buffer, 1, sizeof buffer, f);
    fclose(f);
    return buffer;
}

/* ------------------------------------------------------------------------------------------------ the recording operations of `step` */

struct record {
    const char *root, *mountinfo;
    int fail_mount, fail_umount, fail_mountinfo, mounts;
};
static int r_mount(void *c, const char *source, const char *target, const char *fstype, unsigned long flags, const char *data) {
    struct record *r = c;
    r->mounts++;
    /* a target of the form /proc/self/fd/<n> is a descriptor of this process: report the directory it holds, so the test can see which one was mounted on */
    int fd = -1;
    char extra = 0;
    struct stat st;
    unsigned long long inode = 0;
    /* SHARES_SWAP=PATH: before the first mount, the directory at PATH is renamed aside and a new one made in its place (a swap after the walk checked it) */
    const char *swap = getenv("SHARES_SWAP");
    if (swap && r->mounts == 1) {
        char aside[4096];
        snprintf(aside, sizeof aside, "%s.aside", swap);
        if (rename(swap, aside) != 0 || mkdir(swap, 0700) != 0) { printf("swap-failed\n"); exit(3); }
    }
    if (sscanf(target, "/proc/self/fd/%d%c", &fd, &extra) == 1) { if (fstat(fd, &st) == 0) inode = (unsigned long long)st.st_ino; }
    else if (stat(target, &st) == 0) inode = (unsigned long long)st.st_ino;   /* a path target: whatever the path names now */
    printf("mount %s %s %s %lu %s ino=%llu\n", source, target, fstype, flags, data ? data : "(null)", inode);
    return r->fail_mount == r->mounts ? -1 : 0;
}
static int r_umount(void *c, const char *target) {
    struct record *r = c;
    printf("umount %s\n", target);
    return r->fail_umount ? -1 : 0;
}
static long r_mountinfo(void *c, char *out, size_t capacity) {
    struct record *r = c;
    printf("mountinfo\n");
    if (r->fail_mountinfo) return -1;
    size_t length = 0;
    const char *text = slurp(r->mountinfo, &length);
    if (!text) return -1;
    size_t have = 0, root = strlen(r->root);
    for (size_t i = 0; i < length; i++) {
        if (length - i >= 6 && memcmp(text + i, "@ROOT@", 6) == 0) {
            if (have + root > capacity) return -1;
            memcpy(out + have, r->root, root); have += root; i += 5;
        } else {
            if (have + 1 > capacity) return -1;
            out[have++] = text[i];
        }
    }
    return (long)have;
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "flags") == 0) {
        struct wg_share share;
        if (parse_share(argv[2], &share) != 0) return 2;
        unsigned long flags = wg_share_mount_flags(&share);
        printf("%s%s%s%s\n", flags & WG_MS_RDONLY ? "ro," : "", flags & WG_MS_NOSUID ? "nosuid," : "", flags & WG_MS_NODEV ? "nodev," : "", flags & WG_MS_NOEXEC ? "noexec," : "");
        printf("%lu\n", flags);
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "parse") == 0) {
        size_t length = strlen(argv[2]) / 2;
        uint8_t *bytes = malloc(length ? length : 1);   /* exactly the payload: a read past its end is an address-sanitizer error */
        for (size_t i = 0; i < length; i++) { unsigned v; if (sscanf(argv[2] + 2 * i, "%2x", &v) != 1) return 2; bytes[i] = (uint8_t)v; }
        static struct wg_share_set set;
        int rc = wg_parse_share_payload(bytes, length, &set);
        free(bytes);
        if (rc != 0) { printf("refused\n"); return 0; }
        printf("%u\n", set.count);
        static const char *const KINDS[4] = { "folder", "guidance", "memory", "outputs" };
        for (unsigned i = 0; i < set.count; i++) printf("%s:%d:%s:%s\n", KINDS[set.item[i].kind], set.item[i].read_only, set.item[i].tag, set.item[i].guest_path);
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "inventory") == 0) {
        static struct wg_share_set set;
        set_of(argc, argv, 3, &set);
        printf("%d\n", wg_share_inventory(argv[2], &set));
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "find") == 0) {
        size_t length = 0;
        const char *text = slurp(argv[2], &length);
        if (!text) return 2;
        struct wg_mountinfo_entry entry;
        memset(&entry, 0, sizeof entry);
        int count = wg_mountinfo_find(text, length, argv[3], &entry);
        printf("%d\n", count);
        if (count > 0) printf("root=%s\nmount_point=%s\noptions=%s\nfstype=%s\nsource=%s\nsuper=%s\n", entry.root, entry.mount_point, entry.options, entry.fstype, entry.source, entry.super_options);
        return 0;
    }
    if (argc == 5 && strcmp(argv[1], "check") == 0) {
        size_t length = 0;
        const char *text = slurp(argv[2], &length);
        struct wg_share share;
        if (!text || parse_share(argv[4], &share) != 0) return 2;
        printf("%d\n", wg_share_mountinfo_ok(text, length, argv[3], &share));
        return 0;
    }
    if (argc == 8 && strcmp(argv[1], "checkas") == 0) {     /* MOUNTINFO WHERE SHARE FSTYPE SOURCE DATA: wg_mountinfo_entry_ok, the check for any filesystem */
        size_t length = 0;
        const char *text = slurp(argv[2], &length);
        struct wg_share share;
        if (!text || parse_share(argv[4], &share) != 0) return 2;
        printf("%d\n", wg_mountinfo_entry_ok(text, length, argv[3], &share, argv[5], argv[6], argv[7]));
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "point") == 0) {
        struct wg_share share;
        if (parse_share(argv[3], &share) != 0) return 2;
        printf("%d\n", wg_share_mount_point(argv[2], &share, owner()));
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "alias") == 0) {
        printf("%d\n", wg_share_guidance_alias(argv[2], owner()));
        return 0;
    }
    if (argc >= 6 && strcmp(argv[1], "step") == 0) {
        struct record r = { argv[2], argv[4], 0, 0, 0, 0 };
        if (strncmp(argv[5], "mount:", 6) == 0) r.fail_mount = atoi(argv[5] + 6);
        else if (strcmp(argv[5], "umount") == 0) r.fail_umount = 1;
        else if (strcmp(argv[5], "mountinfo") == 0) r.fail_mountinfo = 1;
        static struct wg_share_set set;
        set_of(argc, argv, 6, &set);
        struct wg_share_ops ops = { &r, argv[2], argv[3], r_mount, r_umount, r_mountinfo, owner() };
        unsigned mounted = 99;
        int rc = wg_mount_shares(&ops, &set, &mounted);
        printf("rc=%d mounted=%u\n", rc, mounted);
        return 0;
    }
    fprintf(stderr, "usage\n");
    return 2;
}
