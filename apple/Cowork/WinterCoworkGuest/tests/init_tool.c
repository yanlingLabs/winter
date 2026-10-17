/*
 * Command line driver for the portable PID 1 modules (discover, ext4sb, skeleton, trusted_config). The Python tests build fake
 * sysfs/dev trees and call it. Not part of the guest image.
 */
#define _GNU_SOURCE
#include "../init/discover.h"
#include "../init/ext4sb.h"
#include "../init/skeleton.h"
#include "../init/boot.h"
#include "../init/trusted_config.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/sysmacros.h>  /* makedev lives here on glibc and musl; on macOS it is in <sys/types.h> */
#endif

struct fake_entry { char path[512]; char kind; unsigned major, minor; };
struct fake_table { struct fake_entry entries[16]; size_t count; };

static void load_table(const char *file, struct fake_table *table) {
    FILE *f = fopen(file, "r");
    table->count = 0;
    if (!f) return;
    while (table->count < 16 && fscanf(f, "%511s %c %u %u", table->entries[table->count].path, &table->entries[table->count].kind,
                                      &table->entries[table->count].major, &table->entries[table->count].minor) == 4) table->count++;
    fclose(f);
}
static int fake_stat(const char *path, struct stat *st, void *ctx) {
    struct fake_table *table = ctx;
    for (size_t i = 0; i < table->count; i++) {
        if (strcmp(table->entries[i].path, path) != 0) continue;
        memset(st, 0, sizeof *st);
        st->st_mode = (table->entries[i].kind == 'b' ? S_IFBLK : table->entries[i].kind == 'c' ? S_IFCHR : S_IFREG) | 0600;
        st->st_rdev = (dev_t)makedev(table->entries[i].major, table->entries[i].minor);
        return 0;
    }
    errno = ENOENT;
    return -1;
}
static const char *status_name(enum wg_discover_status s) { return s == WG_DISCOVER_OK ? "ok" : s == WG_DISCOVER_NOT_YET ? "not-yet" : "refused"; }

struct chown_log { int count; uid_t uid; gid_t gid; int fail_at; unsigned max_uid, max_gid; };
static int log_chown(int fd, uid_t uid, gid_t gid, void *ctx) {
    (void)fd;
    struct chown_log *log = ctx;
    log->count++; log->uid = uid; log->gid = gid;
    if (uid > log->max_uid) log->max_uid = uid;
    if (gid > log->max_gid) log->max_gid = gid;
    return log->fail_at && log->count == log->fail_at ? -1 : 0;
}

static char *slurp(const char *path, size_t *length) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    char *buffer = malloc(200000);
    *length = fread(buffer, 1, 199999, f);
    buffer[*length] = '\0';
    fclose(f);
    return buffer;
}

static int fsync_calls;
static int counting_fsync(int fd) { fsync_calls++; return fsync(fd); }
static int failing_fsync(int fd) { (void)fd; fsync_calls++; return -1; }
static const char *race_mode, *race_path_extra;
static void race(const char *path) {
    if (strcmp(race_mode, "link") == 0) {
        char other[700];
        snprintf(other, sizeof other, "%s.second-link", path);
        if (link(path, other) != 0) abort();
    } else if (strcmp(race_mode, "chmod") == 0) {
        if (chmod(path, 0644) != 0) abort();
    } else if (strcmp(race_mode, "grow") == 0 || strcmp(race_mode, "shrink") == 0) {
        if (chmod(path, 0600) != 0) abort();
        int fd = open(path, O_WRONLY | O_APPEND);
        if (fd < 0) abort();
        if (strcmp(race_mode, "grow") == 0 && write(fd, "x", 1) != 1) abort();
        if (strcmp(race_mode, "shrink") == 0 && ftruncate(fd, 1) != 0) abort();
        close(fd);
        if (chmod(path, 0400) != 0) abort();
    }
    (void)race_path_extra;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    char why[64] = "";
    if (strcmp(argv[1], "disks") == 0 && argc == 5) {
        struct fake_table table;
        load_table(argv[4], &table);
        struct wg_discover_env env = { argv[2], argv[3], fake_stat, &table };
        struct wg_disk data, environment;
        enum wg_discover_status s = wg_find_disks(&env, &data, &environment, why, sizeof why);
        printf("%s|%s", status_name(s), why);
        if (s == WG_DISCOVER_OK) printf("|%s %u:%u %s|%s %u:%u %s", data.node, data.major, data.minor, data.serial, environment.node, environment.major, environment.minor, environment.serial);
        printf("\n");
        return 0;
    }
    if (strcmp(argv[1], "port") == 0 && argc == 5) {
        struct fake_table table;
        load_table(argv[4], &table);
        struct wg_discover_env env = { argv[2], argv[3], fake_stat, &table };
        struct wg_port port;
        enum wg_discover_status s = wg_find_port(&env, &port, why, sizeof why);
        printf("%s|%s", status_name(s), why);
        if (s == WG_DISCOVER_OK) printf("|%s %u:%u", port.node, port.major, port.minor);
        printf("\n");
        return 0;
    }
    if (strcmp(argv[1], "ext4") == 0 && argc == 4) {
        uint8_t uuid[16];
        if (wg_uuid_parse(argv[3], strlen(argv[3]), uuid) != 0) { printf("bad-uuid\n"); return 0; }
        printf("%s\n", wg_ext4_result_name(wg_ext4_check_node(argv[2], uuid)));
        return 0;
    }
    if (strcmp(argv[1], "uuid") == 0 && argc == 3) {
        uint8_t uuid[16];
        if (wg_uuid_parse(argv[2], strlen(argv[2]), uuid) != 0) { printf("bad\n"); return 0; }
        for (int i = 0; i < 16; i++) printf("%02x", uuid[i]);
        printf("\n");
        return 0;
    }
    if (strcmp(argv[1], "crc") == 0 && argc == 3) {
        printf("%08x\n", (unsigned)wg_crc32c_raw(0xFFFFFFFFu, (const uint8_t *)argv[2], strlen(argv[2])));
        return 0;
    }
    if (strcmp(argv[1], "skeleton") == 0 && argc >= 4) {
        int root = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        struct chown_log log = { 0, 0, 0, argc >= 5 ? atoi(argv[4]) : 0, 0, 0 };
        struct wg_skeleton_ops ops = { log_chown, &log };
        const struct wg_skeleton_entry *table = strcmp(argv[3], "ws") == 0 ? WG_WORKSPACE_SKELETON : WG_RUN_SKELETON;
        size_t count = strcmp(argv[3], "ws") == 0 ? WG_WORKSPACE_SKELETON_COUNT : WG_RUN_SKELETON_COUNT;
        int rc = wg_skeleton_apply(root, table, count, &ops);
        printf("rc=%d chown=%d last=%u:%u max=%u:%u\n", rc, log.count, (unsigned)log.uid, (unsigned)log.gid, log.max_uid, log.max_gid);
        return 0;
    }
    if (strcmp(argv[1], "skeleton-custom") == 0 && argc == 5) {
        int root = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        struct wg_skeleton_entry entry = { argv[3], (unsigned)strtoul(argv[4], NULL, 8), 0, 0 };
        struct chown_log log = { 0, 0, 0, 0, 0, 0 };
        struct wg_skeleton_ops ops = { log_chown, &log };
        printf("rc=%d\n", wg_skeleton_apply(root, &entry, 1, &ops));
        return 0;
    }
    if ((strcmp(argv[1], "config") == 0 && (argc == 5 || argc == 6)) || (strcmp(argv[1], "configrt") == 0 && (argc == 7 || argc == 8))) {
        int rt = strcmp(argv[1], "configrt") == 0;
        size_t base_length = 0, conv_length = 0, art_length = 0;
        char *base = slurp(argv[3], &base_length), *conv = slurp(argv[4], &conv_length);
        char *art = rt ? slurp(argv[6], &art_length) : NULL;
        static char out[70000];
        size_t out_length = 0;
        int cap_at = rt ? 7 : 5, has_cap = argc == cap_at + 1;
        size_t capacity = has_cap && strtoul(argv[cap_at], NULL, 10) < sizeof out ? strtoul(argv[cap_at], NULL, 10) : sizeof out;
        enum wg_config_result r = wg_build_trusted_config(argv[2], base, base_length, conv, conv_length, rt ? (strcmp(argv[5], "-") == 0 ? NULL : argv[5]) : NULL, art, art_length, out, capacity, &out_length);
        printf("%d|%s\n", (int)r, r == WG_CONFIG_OK ? out : "");
        free(base);
        free(conv);
        free(art);
        return 0;
    }
    if (strcmp(argv[1], "convparse") == 0 && argc == 3) {
        size_t length = strlen(argv[2]) / 2;
        uint8_t *bytes = malloc(length + 1);
        for (size_t i = 0; i < length; i++) { unsigned v; sscanf(argv[2] + 2 * i, "%2x", &v); bytes[i] = (uint8_t)v; }
        struct wg_conversation_set set;
        if (wg_parse_conversation_payload(bytes, length, &set) != 0) { printf("refused\n"); free(bytes); return 0; }
        printf("%u|%u", set.profile, set.count);
        for (unsigned i = 0; i < set.count; i++) printf("|%s:%u", set.session_id[i], (unsigned)set.runtime_uid[i]);
        printf("|%.*s\n", (int)set.json_length, set.json);
        free(bytes);
        return 0;
    }
    if (strcmp(argv[1], "writecfg") == 0 && (argc == 5 || argc == 6)) {
        if (argc == 6) umask((mode_t)strtoul(argv[5], NULL, 8));
        size_t length = 0;
        char *text = slurp(argv[4], &length);
        int fd = wg_write_trusted_config(argv[2], argv[3], text, length);
        free(text);
        if (fd < 0) { printf("fail\n"); return 0; }
        struct stat st;
        fstat(fd, &st);
        char back[64] = { 0 };
        ssize_t n = read(fd, back, sizeof back - 1);
        printf("fd=%d mode=%o size=%lld first=%.*s cloexec=%d\n", fd >= 3, (unsigned)(st.st_mode & 0777), (long long)st.st_size, (int)(n > 8 ? 8 : n), back, (fcntl(fd, F_GETFD) & FD_CLOEXEC) != 0);
        return 0;
    }
    /* writecfgx DIR NAME FILE FSYNC RACE: the same call with the two seams: the fsync result (ok|fail) and what happens between the close of the
     * written file and the verification of the read-only descriptor (none|link|chmod|grow|shrink). */
    if (strcmp(argv[1], "writecfgx") == 0 && argc == 7) {
        size_t length = 0;
        char *text = slurp(argv[4], &length);
        fsync_calls = 0;
        wg_trusted_config_test_seams(strcmp(argv[5], "fail") == 0 ? failing_fsync : counting_fsync, strcmp(argv[6], "none") == 0 ? NULL : race);
        race_path_extra = argv[2];
        race_mode = argv[6];
        int fd = wg_write_trusted_config(argv[2], argv[3], text, length);
        free(text);
        char path[600];
        snprintf(path, sizeof path, "%s/%s", argv[2], argv[3]);
        struct stat st;
        printf("%s fsync=%d exists=%d\n", fd >= 0 ? "ok" : "fail", fsync_calls, stat(path, &st) == 0);
        return 0;
    }
    if (strcmp(argv[1], "readsmall") == 0 && argc == 4) {
        char out[128];
        long n = wg_read_small_file(argv[2], out, sizeof out, atoi(argv[3]));
        printf("%ld|%s\n", n, n >= 0 ? out : "");
        return 0;
    }
    return 2;
}
