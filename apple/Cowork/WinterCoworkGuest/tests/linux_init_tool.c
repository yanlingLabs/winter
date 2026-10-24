/*
 * Linux-only driver for the pieces of /init that the portable tests cannot reach: it compiles init_linux.c itself (main renamed) so
 * the real static functions run unchanged, as an ordinary process in a temporary directory. It is never PID 1 and never mounts,
 * reboots or touches a real device. The system calls whose failure cannot be provoked as a normal user go through init_linux.c's
 * `sys_calls` table. Not part of the guest image.
 */
#define main wg_pid1_main
#include "../init/init_linux.c"
#undef main

#include <stdio.h>
#include <stdlib.h>

static int chown_calls, chmod_calls, fsync_calls;
static unsigned long long seen_inode;
static unsigned seen_uid, seen_gid;
static unsigned long long synced[8];

static int chown_log(int fd, uid_t uid, gid_t gid) {
    struct stat st;
    if (fstat(fd, &st) != 0) abort();
    seen_inode = st.st_ino; seen_uid = (unsigned)uid; seen_gid = (unsigned)gid; chown_calls++;
    return 0;
}
static int chown_fail(int fd, uid_t uid, gid_t gid) { (void)fd; (void)uid; (void)gid; chown_calls++; return -1; }
static int chmod_real(int fd, mode_t mode) { chmod_calls++; return fchmod(fd, mode); }
static int chmod_noop(int fd, mode_t mode) { (void)fd; (void)mode; chmod_calls++; return 0; }
static int chmod_fail(int fd, mode_t mode) { (void)fd; (void)mode; chmod_calls++; return -1; }
static int fsync_log(int fd) {
    struct stat st;
    if (fstat(fd, &st) != 0) abort();
    if (fsync_calls < 8) synced[fsync_calls] = st.st_ino;
    fsync_calls++;
    return fsync(fd);
}
static int fsync_fail(int fd) { (void)fd; fsync_calls++; return -1; }

#ifdef WG_FILE_CHANNEL_V1
static int own_chown(int fd, uid_t uid, gid_t gid, void *ctx) { (void)ctx; return fchown(fd, uid, gid); }

/* KIND:RO:TAG:PATH arguments (KIND folder|guidance|memory|outputs) into a share set. */
static int share_set(int argc, char **argv, int first, struct wg_share_set *set) {
    memset(set, 0, sizeof *set);
    for (int i = first; i < argc && set->count < WG_SHARES_MAX; i++) {
        struct wg_share *share = &set->item[set->count++];
        char kind[16];
        int ro = 0, used = 0;
        if (sscanf(argv[i], "%15[a-z]:%d:%32[a-z0-9-]:%n", kind, &ro, share->tag, &used) != 3 || used == 0) return -1;
        snprintf(share->guest_path, sizeof share->guest_path, "%s", argv[i] + used);
        share->read_only = ro;
        share->kind = strcmp(kind, "folder") == 0 ? WG_SHARE_FOLDER : strcmp(kind, "guidance") == 0 ? WG_SHARE_GUIDANCE : strcmp(kind, "memory") == 0 ? WG_SHARE_MEMORY : WG_SHARE_OUTPUTS;
    }
    return set->count ? 0 : -1;
}
#endif

static int open_descriptors(void) {
    int count = 0;
    for (int fd = 0; fd < 256; fd++) count += fcntl(fd, F_GETFD) != -1;
    return count;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc == 7 && strcmp(argv[1], "privdir") == 0) {   /* PARENT NAME UID CHOWN(log|fail) CHMOD(real|noop|fail) */
        umask(0);
        sys_calls.fchown_fn = strcmp(argv[5], "fail") == 0 ? chown_fail : chown_log;
        sys_calls.fchmod_fn = strcmp(argv[6], "noop") == 0 ? chmod_noop : strcmp(argv[6], "fail") == 0 ? chmod_fail : chmod_real;
        int rc = make_private_dir(argv[2], argv[3], (uid_t)strtoul(argv[4], NULL, 10));
        printf("rc=%d chown=%d chmod=%d inode=%llu uid=%u gid=%u\n", rc, chown_calls, chmod_calls, seen_inode, seen_uid, seen_gid);
        return 0;
    }
    if (argc == 6 && strcmp(argv[1], "flush") == 0) {      /* DATA_NODE ENV_NODE VOLUMES FSYNC(log|fail) */
        snprintf(G.data.node, sizeof G.data.node, "%s", argv[2]);
        snprintf(G.environment.node, sizeof G.environment.node, "%s", argv[3]);
        sys_calls.fsync_fn = strcmp(argv[5], "fail") == 0 ? fsync_fail : fsync_log;
        int rc = op_flush_devices(NULL, (unsigned)strtoul(argv[4], NULL, 10));
        printf("rc=%d fsync=%d", rc, fsync_calls);
        for (int i = 0; i < fsync_calls && i < 8; i++) printf(" %llu", synced[i]);
        printf("\n");
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "startsup") == 0) {   /* WITH_PORTS: PYTHON_PATH and TRUSTED_DIR are test paths (-D) and PYTHON_PATH is the fake supervisor */
        /* PID 1's own state: umask 077 and its signals blocked (it reads them from a signalfd); the child must not inherit either. */
        umask(077);
        sigset_t blocked;
        sigemptyset(&blocked);
        sigaddset(&blocked, SIGUSR1);
        sigaddset(&blocked, SIGTERM);
        sigprocmask(SIG_BLOCK, &blocked, NULL);
        int in[2], out[2], err[2];
        if (pipe2(in, O_CLOEXEC) || pipe2(out, O_CLOEXEC) || pipe2(err, O_CLOEXEC)) abort();
        G.rt_in_r = in[0]; G.rt_out_w = out[1]; G.rt_err_w = err[1];
        int old[3] = { in[0], out[1], err[1] };
#ifdef WG_FILE_CHANNEL_V1
        /* the file channel's two FIFOs, made as PID 1 makes them; the test keeps the relay's ends (file_in[1] writes FILE_IN, file_out[0] reads FILE_OUT) */
        int file_in[2], file_out[2];
        if (make_file_pipe(file_in) != 0 || make_file_pipe(file_out) != 0) abort();
        G.file_in_r = file_in[0]; G.file_out_w = file_out[1];
        if (argc > 3 && strcmp(argv[3], "blocking") == 0) {   /* a supervisor end that is not what the file service demands: a plain, blocking pipe */
            int plain[2];
            if (pipe2(plain, O_CLOEXEC) != 0) abort();
            G.file_in_r = plain[0];
        }
        int file_old[2] = { file_in[0], file_out[1] };
#endif
        static const char config[] = "{\"guestBootId\":\"x\"}";
        int before = open_descriptors();
        int rc = op_start_supervisor(NULL, config, sizeof config - 1, atoi(argv[2]));
        int added = open_descriptors() - before;
        printf("rc=%d\n", rc);
        if (rc != 0) return 0;
        int status = 0;
        if (waitpid(G.supervisor, &status, 0) < 0) abort();
        printf("exit:%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        char buffer[8192];
        size_t have = 0;
        for (;;) {
            struct pollfd p = { G.sup_out_r, POLLIN, 0 };
            if (poll(&p, 1, 5000) <= 0) break;
            ssize_t n = read(G.sup_out_r, buffer + have, sizeof buffer - 1 - have);
            if (n <= 0) break;
            have += (size_t)n;
        }
        buffer[have] = '\0';
        fputs(buffer, stdout);
        int closed = 1;
        for (int i = 0; i < 3; i++) closed &= fcntl(old[i], F_GETFD) == -1 && errno == EBADF;
        printf("parent:in=%d out=%d err=%d closed=%d added=%d\n", G.rt_in_r, G.rt_out_w, G.rt_err_w, closed, added);
#ifdef WG_FILE_CHANNEL_V1
        int file_closed = 1;
        for (int i = 0; i < 2; i++) file_closed &= fcntl(file_old[i], F_GETFD) == -1 && errno == EBADF;
        printf("parentfile:in=%d out=%d closed=%d\n", G.file_in_r, G.file_out_w, file_closed);
        char file_byte;
        fcntl(file_out[0], F_SETFL, O_NONBLOCK);
        ssize_t file_read = read(file_out[0], &file_byte, 1), file_write = write(file_in[1], "x", 1);
        printf("fileeof:out=%d in_reader_gone=%d\n", file_read == 0, file_write < 0 && errno == EPIPE);
#endif
        /* No copy of the supervisor's pipe ends is left anywhere: its stdout/stderr FIFOs read end-of-file, and the input FIFO has no reader. */
        char byte;
        fcntl(out[0], F_SETFL, O_NONBLOCK); fcntl(err[0], F_SETFL, O_NONBLOCK);
        ssize_t r1 = read(out[0], &byte, 1), r2 = read(err[0], &byte, 1);
        ssize_t w = write(in[1], "x", 1);
        printf("eof:out=%d err=%d input_reader_gone=%d\n", r1 == 0, r2 == 0, w < 0 && errno == EPIPE);
        return 0;
    }
#ifdef WG_FILE_CHANNEL_V1
    if (argc == 2 && strcmp(argv[1], "fifos") == 0) {         /* the four ends of the two FIFOs, as PID 1 makes them */
        int a[2], b[2];
        if (make_file_pipe(a) != 0 || make_file_pipe(b) != 0) { printf("fail\n"); return 0; }
        int ends[4] = { a[0], a[1], b[0], b[1] };
        for (int i = 0; i < 4; i++) {
            struct stat st;
            fstat(ends[i], &st);
            printf("end:%d fifo=%d owner=%d nlink=%lu nonblock=%d cloexec=%d access=%d\n", i, S_ISFIFO(st.st_mode), st.st_uid == geteuid(), (unsigned long)st.st_nlink,
                   (fcntl(ends[i], F_GETFL) & O_NONBLOCK) != 0, (fcntl(ends[i], F_GETFD) & FD_CLOEXEC) != 0, fcntl(ends[i], F_GETFL) & O_ACCMODE);
        }
        return 0;
    }
    if (argc == 4 && strcmp(argv[1], "fifook") == 0) {        /* PATH OPEN_FLAGS: would the supervisor's file service accept this descriptor */
        int fd = open(argv[2], atoi(argv[3]));
        printf("%d\n", fd < 0 ? -1 : fifo_end_ok(fd));
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "hardlinks") == 0) {     /* PATH */
        printf("rc=%d\n", set_protected_hardlinks(argv[2]));
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "datadev") == 0) {       /* WG_WORKSPACE_PATH is a test path (-D) */
        uint64_t device = 0;
        int rc = op_read_data_device(NULL, &device);
        printf("rc=%d device=%llu\n", rc, (unsigned long long)device);
        return 0;
    }
    if (argc >= 5 && strcmp(argv[1], "roots") == 0) {         /* BROWSE_UID GID SOURCE...: op_prepare_conversation_dirs for one conversation, as the invoking user */
        static struct wg_conversation_set set;
        memset(&set, 0, sizeof set);
        set.count = 1;
        set.browse_uid = (uint32_t)strtoul(argv[2], NULL, 10);
        set.workspace_gid[0] = (uint32_t)strtoul(argv[3], NULL, 10);
        set.runtime_uid[0] = (uint32_t)getuid();
        snprintf(set.session_id[0], sizeof set.session_id[0], "s1");
        for (int i = 4; i < argc && set.root_count[0] < WG_ROOTS_MAX; i++) snprintf(set.root_source[0][set.root_count[0]++], WG_ROOT_SOURCE_MAX + 1, "%s", argv[i]);
        sys_calls.fchown_fn = chown_log;                     /* the per-conversation directories: a non-root test cannot chown to another uid */
        static const struct wg_dataroots_ops own = { NULL, own_chown, 0, 0 };
        struct wg_dataroots_ops mine = own;
        mine.owner = mine.parent_owner = getuid();
        static struct wg_dataroots_ops installed;
        installed = mine;
        dataroots_ops = &installed;
        printf("rc=%d\n", op_prepare_conversation_dirs(NULL, &set));
        return 0;
    }
    if (argc >= 3 && strcmp(argv[1], "shares") == 0) {       /* SHARE...: op_mount_shares with SHARES_ROOT, SHARES_SYS_ROOT and SHARES_OWNER test values (-D), the real mount(2) */
        static struct wg_share_set set;
        if (share_set(argc, argv, 2, &set) != 0) return 2;
        unsigned mounted = 99;
        errno = 0;
        int rc = op_mount_shares(NULL, &set, &mounted);
        int saved = errno;                                    /* what the refused mount(2) said: nothing after it touches errno when nothing was mounted */
        printf("rc=%d mounted=%u errno=%d\n", rc, mounted, saved);
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "umountshare") == 0) {  /* GUEST_PATH below SHARES_ROOT */
        printf("rc=%d\n", op_umount_share(NULL, argv[2]));
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "mountinfo") == 0) {    /* WHERE: this process's real mount table, read and parsed as PID 1 does */
        static char table[WG_MOUNTINFO_MAX];
        long length = sop_read_mountinfo(NULL, table, sizeof table);
        struct wg_mountinfo_entry entry;
        memset(&entry, 0, sizeof entry);
        int count = length < 0 ? -2 : wg_mountinfo_find(table, (size_t)length, argv[2], &entry);
        printf("count=%d\n", count);
        if (count > 0) printf("root=%s\nmount_point=%s\noptions=%s\nfstype=%s\nsource=%s\nsuper=%s\n", entry.root, entry.mount_point, entry.options, entry.fstype, entry.source, entry.super_options);
        return 0;
    }
    if (argc >= 5 && strcmp(argv[1], "realstep") == 0) {     /* FSTYPE DATA SHARE...: the whole share step for real (root, in a private mount namespace), then every share unmounted */
        static struct wg_share_set set;
        if (share_set(argc, argv, 4, &set) != 0) return 2;
        const struct wg_share_ops ops = { NULL, SHARES_ROOT, SHARES_SYS_ROOT, mop_mount, mop_umount, sop_read_mountinfo, (uid_t)SHARES_OWNER };
        unsigned mounted = 99;
        int rc = wg_mount_shares_as(&ops, &set, &mounted, argv[2], argv[3]);
        printf("rc=%d mounted=%u\n", rc, mounted);
        static char table[WG_MOUNTINFO_MAX];
        for (unsigned i = 0; i < set.count; i++) {
            char where[WG_SHARE_PATH_MAX + 4096];
            snprintf(where, sizeof where, "%s%s", SHARES_ROOT, set.item[i].guest_path);
            long length = sop_read_mountinfo(NULL, table, sizeof table);
            struct wg_mountinfo_entry entry;
            memset(&entry, 0, sizeof entry);
            int count = length < 0 ? -2 : wg_mountinfo_find(table, (size_t)length, where, &entry);
            printf("share=%s count=%d options=%s fstype=%s source=%s super=%s\n", set.item[i].tag, count, entry.options, entry.fstype, entry.source, entry.super_options);
        }
        char alias[WG_SHARE_PATH_MAX + 4096], text[128];
        snprintf(alias, sizeof alias, "%s%s/%s", SHARES_ROOT, WG_SHARE_GUIDANCE_ALIAS_DIRECTORY, WG_SHARE_GUIDANCE_ALIAS_NAME);
        ssize_t n = readlink(alias, text, sizeof text - 1);
        printf("alias=%.*s\n", n < 0 ? 0 : (int)n, text);
        for (unsigned i = set.count; i-- > 0;) if (mounted & (1u << i)) printf("umount=%s:%d\n", set.item[i].tag, op_umount_share(NULL, set.item[i].guest_path));
        long length = sop_read_mountinfo(NULL, table, sizeof table);
        int left = 0;
        for (unsigned i = 0; i < set.count; i++) {
            char where[WG_SHARE_PATH_MAX + 4096];
            snprintf(where, sizeof where, "%s%s", SHARES_ROOT, set.item[i].guest_path);
            left += length < 0 ? 1 : wg_mountinfo_find(table, (size_t)length, where, NULL);
        }
        printf("left=%d\n", left);
        return 0;
    }
    if (argc == 10 && strcmp(argv[1], "realcheck") == 0) {   /* FSTYPE SOURCE DATA SHARE  CHECK_FSTYPE CHECK_SOURCE CHECK_DATA CHECK_SHARE (root, private mount namespace) */
        static struct wg_share_set mounted_set, checked_set;
        char *mount_argv[] = { argv[0], argv[5] }, *check_argv[] = { argv[0], argv[9] };
        if (share_set(2, mount_argv, 1, &mounted_set) != 0 || share_set(2, check_argv, 1, &checked_set) != 0) return 2;
        const struct wg_share *share = &mounted_set.item[0];
        char where[WG_SHARE_PATH_MAX + 4096], target[64];
        snprintf(where, sizeof where, "%s%s", SHARES_ROOT, share->guest_path);
        int fd = open(where, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);   /* through the descriptor, as the step mounts */
        if (fd < 0) { printf("open-failed\n"); return 0; }
        snprintf(target, sizeof target, "/proc/self/fd/%d", fd);
        if (mop_mount(NULL, argv[3], target, argv[2], wg_share_mount_flags(share), argv[4]) != 0) { printf("mount-failed errno=%d\n", errno); close(fd); return 0; }
        close(fd);
        static char table[WG_MOUNTINFO_MAX];
        long length = sop_read_mountinfo(NULL, table, sizeof table);
        struct wg_mountinfo_entry entry;
        memset(&entry, 0, sizeof entry);
        int count = length < 0 ? -2 : wg_mountinfo_find(table, (size_t)length, where, &entry);
        int ok = length < 0 ? -2 : wg_mountinfo_entry_ok(table, (size_t)length, where, &checked_set.item[0], argv[6], argv[7], argv[8]);
        printf("count=%d check=%d\noptions=%s\nfstype=%s\nsource=%s\nsuper=%s\n", count, ok, entry.options, entry.fstype, entry.source, entry.super_options);
        printf("umount=%d\n", umount2(where, 0));
        return 0;
    }
    if (argc == 3 && strcmp(argv[1], "realmount") == 0) {    /* TARGET: inside a user and mount namespace, a real tmpfs mount with a share's flags, then its own table */
        if (mount("winter-probe", argv[2], "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY, "size=1m") != 0) { printf("mount-failed\n"); return 0; }
        static char table[WG_MOUNTINFO_MAX];
        long length = sop_read_mountinfo(NULL, table, sizeof table);
        struct wg_mountinfo_entry entry;
        memset(&entry, 0, sizeof entry);
        int count = length < 0 ? -2 : wg_mountinfo_find(table, (size_t)length, argv[2], &entry);
        printf("count=%d\n", count);
        if (count > 0) printf("root=%s\nmount_point=%s\noptions=%s\nfstype=%s\nsource=%s\nsuper=%s\n", entry.root, entry.mount_point, entry.options, entry.fstype, entry.source, entry.super_options);
        printf("umount=%d\n", umount2(argv[2], 0));
        return 0;
    }
#endif
    fprintf(stderr, "usage\n");
    return 2;
}
