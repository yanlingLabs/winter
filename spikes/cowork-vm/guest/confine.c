#define _GNU_SOURCE
/* Gate-1 fixture, not the production Cowork sandbox. Compile on Linux. */
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t worker_pid;
static void stop_worker(int sig) { (void)sig; if (worker_pid > 0) kill(-worker_pid, SIGKILL); }
static void unsupported(const char *operation) {
    /* Details stay on stderr; stdout contains only the stable NDJSON record. */
    fprintf(stderr, "fixture confinement: %s: %s\n", operation, strerror(errno));
    puts("{\"kind\":\"check\",\"id\":\"launcher\",\"status\":\"unsupported\",\"detail\":\"required_linux_confinement_unavailable\"}");
    fflush(stdout);
    _exit(77);
}
static void must(int result, const char *operation) { if (result < 0) unsupported(operation); }
static void path(char *out, size_t size, const char *root, const char *suffix) {
    if (snprintf(out, size, "%s%s", root, suffix) >= (int)size) { errno = ENAMETOOLONG; unsupported("path"); }
}
static void directory(const char *root, const char *suffix, mode_t mode) {
    char dest[4096]; path(dest, sizeof(dest), root, suffix); must(mkdir(dest, mode), "mkdir");
}
static void bind_path(const char *root, const char *suffix, const char *source, int ro, int executable) {
    char dest[4096]; path(dest, sizeof(dest), root, suffix);
    must(mount(source, dest, NULL, MS_BIND, NULL), "bind");
    unsigned long flags = MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV;
    if (!executable) flags |= MS_NOEXEC;
    if (ro) flags |= MS_RDONLY;
    must(mount(NULL, dest, NULL, flags, NULL), "bind remount");
}

#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void filter(void) {
#if defined(__aarch64__)
#define FIXTURE_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define FIXTURE_ARCH AUDIT_ARCH_X86_64
#else
    errno = ENOTSUP; unsupported("seccomp architecture");
#define FIXTURE_ARCH 0
#endif
    struct sock_filter insns[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIXTURE_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* Reject x32 syscall numbers, which share the x86_64 audit architecture. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        DENY(mount), DENY(umount2), DENY(pivot_root), DENY(chroot),
        DENY(setns), DENY(unshare), DENY(ptrace), DENY(process_vm_readv), DENY(process_vm_writev),
        DENY(bpf), DENY(perf_event_open), DENY(open_by_handle_at), DENY(name_to_handle_at),
        DENY(kexec_load), DENY(reboot), DENY(keyctl), DENY(add_key), DENY(request_key),
        DENY(syslog), DENY(swapon), DENY(swapoff), DENY(init_module), DENY(finit_module), DENY(delete_module),
#ifdef __NR_clone3
        DENY(clone3),
#endif
#ifdef __NR_io_uring_setup
        DENY(io_uring_setup),
#endif
#ifdef __NR_userfaultfd
        DENY(userfaultfd),
#endif
#ifdef __NR_fsopen
        DENY(fsopen), DENY(fsmount), DENY(move_mount), DENY(open_tree), DENY(fspick), DENY(fsconfig),
#endif
#ifdef __NR_mount_setattr
        DENY(mount_setattr),
#endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_VSOCK, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* Disallow namespace creation via clone while retaining ordinary fork. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWNS | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(insns) / sizeof(insns[0]), .filter = insns };
    must(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program), "seccomp");
}

static int wait_child(pid_t pid) {
    int status; while (waitpid(pid, &status, 0) < 0) if (errno != EINTR) unsupported("waitpid");
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

int main(int argc, char **argv) {
    if (argc == 3 && !strcmp(argv[1], "--probe")) {
        errno = 0; long result;
        if (!strcmp(argv[2], "vsock")) result = socket(AF_VSOCK, SOCK_STREAM, 0);
        else if (!strcmp(argv[2], "ptrace")) result = ptrace(PTRACE_TRACEME, 0, NULL, NULL);
        else if (!strcmp(argv[2], "mount")) result = mount("tmpfs", "/tmp", "tmpfs", 0, NULL);
        else if (!strcmp(argv[2], "unshare")) result = unshare(CLONE_NEWUSER);
#ifdef __NR_landlock_create_ruleset
        else if (!strcmp(argv[2], "landlock")) result = syscall(__NR_landlock_create_ruleset, NULL, 0, 1);
#endif
        else return 64;
        int error = errno;
        printf("{\"kind\":\"observation\",\"id\":\"syscall_%s\",\"result\":%ld,\"errno\":%d}\n", argv[2], result, error);
        if (!strcmp(argv[2], "landlock")) return result > 0 ? 0 : 77;
        return result == -1 && error == EPERM ? 0 : 1;
    }
    if (argc < 8 || (strcmp(argv[1], "auto") && strcmp(argv[1], "plan"))) {
        fprintf(stderr, "usage: confine auto|plan UID SOURCE MEMORY SCRATCH INSTRUCTIONS SUITE [ARG...]\n"); return 64;
    }
    if (geteuid() != 0) { errno = EPERM; unsupported("supervisor must be root"); }
    /* Driver's control-store umask must not make tool mountpoint ancestors 0700. */
    umask(0022);
    char *end; unsigned long uid = strtoul(argv[2], &end, 10);
    if (*end || (uid != 10001 && uid != 10002)) { fprintf(stderr, "fixture UID must be 10001 or 10002\n"); return 64; }
    char resolved[5][4096];
    for (int i = 0; i < 5; i++) {
        if (!realpath(argv[i + 3], resolved[i])) unsupported("resolve input");
        struct stat st; must(lstat(resolved[i], &st), "input stat");
        if (i < 3 ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) { errno = EINVAL; unsupported("input type"); }
    }
    char root[] = "/tmp/cowork-tool-XXXXXX";
    char executable[4096];
    if (!realpath("/proc/self/exe", executable)) unsupported("launcher path");
    if (!mkdtemp(root)) unsupported("mkdtemp");
    signal(SIGTERM, stop_worker); signal(SIGINT, stop_worker);
    pid_t worker = fork(); must(worker, "fork");
    if (worker) { worker_pid = worker; int code = wait_child(worker); rmdir(root); return code; }
    must(setsid(), "setsid");
    must(unshare(CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWNET), "namespaces");
    must(mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL), "mount propagation");
    pid_t init = fork(); must(init, "pid namespace fork");
    if (init) return wait_child(init);
    must(mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755,size=16m"), "tool root");
    const char *dirs[] = { "/bin", "/sbin", "/lib", "/usr", "/usr/bin", "/usr/sbin", "/usr/lib", "/proc", "/dev", "/tmp", "/run", "/root", "/opt", "/workspace", "/workspace/source", "/workspace/.winter", "/workspace/.winter/memory", "/workspace/.winter/scratch" };
    for (size_t i = 0; i < sizeof(dirs)/sizeof(dirs[0]); i++) directory(root, dirs[i], 0755);
    const char *binaries[] = { "/bin", "/sbin", "/lib", "/usr/bin", "/usr/sbin", "/usr/lib" };
    for (size_t i = 0; i < sizeof(binaries)/sizeof(binaries[0]); i++) {
        struct stat st; if (stat(binaries[i], &st) == 0) bind_path(root, binaries[i], binaries[i], 1, 1);
    }
    int ro = !strcmp(argv[1], "plan");
    bind_path(root, "/workspace/source", resolved[0], ro, 1);
    bind_path(root, "/workspace/.winter/memory", resolved[1], ro, 0);
    bind_path(root, "/workspace/.winter/scratch", resolved[2], 0, 1);
    char dest[4096]; path(dest, sizeof(dest), root, "/workspace/.winter/WINTER.md");
    must(close(open(dest, O_CREAT | O_WRONLY | O_EXCL, 0444)), "instruction mountpoint");
    bind_path(root, "/workspace/.winter/WINTER.md", resolved[3], 1, 0);
    path(dest, sizeof(dest), root, "/opt/tool-smoke.sh");
    must(close(open(dest, O_CREAT | O_WRONLY | O_EXCL, 0444)), "suite mountpoint");
    bind_path(root, "/opt/tool-smoke.sh", resolved[4], 1, 0);
    path(dest, sizeof(dest), root, "/opt/syscall-probe");
    must(close(open(dest, O_CREAT | O_WRONLY | O_EXCL, 0555)), "probe mountpoint");
    bind_path(root, "/opt/syscall-probe", executable, 1, 1);
    path(dest, sizeof(dest), root, "/tmp");
    must(mount("tmpfs", dest, "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=16m"), "private tmp");
    const char *devices[] = { "null", "zero", "random", "urandom" };
    for (size_t i = 0; i < 4; i++) {
        char suffix[80], source[80]; snprintf(suffix, sizeof(suffix), "/dev/%s", devices[i]); snprintf(source, sizeof(source), "/dev/%s", devices[i]);
        path(dest, sizeof(dest), root, suffix); must(close(open(dest, O_CREAT | O_WRONLY | O_EXCL, 0666)), "device mountpoint");
        must(mount(source, dest, NULL, MS_BIND, NULL), "device bind");
        must(mount(NULL, dest, NULL, MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NOEXEC, NULL), "device remount");
    }
    path(dest, sizeof(dest), root, "/proc"); must(mount("proc", dest, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=2"), "private proc");
    /* Read-only root protects mountpoint ancestors; writable submounts retain their own flags. */
    must(mount(NULL, root, NULL, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL), "read-only skeleton");
    must(chdir(root), "enter tool root"); must(chroot("."), "chroot"); must(chdir("/workspace/source"), "tool cwd");
    long maxfd = sysconf(_SC_OPEN_MAX); if (maxfd < 0) maxfd = 65536;
    for (long fd = 3; fd < maxfd; fd++) close((int)fd);
    must(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs");
    for (int cap = 0; cap <= CAP_LAST_CAP; cap++) must(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0), "bounding caps");
    gid_t workspace_group = 10000;
    must(setgroups(1, &workspace_group), "workspace-only group"); must(setresgid((gid_t)uid, (gid_t)uid, (gid_t)uid), "gid");
    must(setresuid((uid_t)uid, (uid_t)uid, (uid_t)uid), "uid");
    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct caps[2] = {{0}, {0}};
    must(syscall(SYS_capset, &header, &caps), "clear capabilities");
    filter();
    umask(0002);
    char uid_text[32]; snprintf(uid_text, sizeof(uid_text), "FIXTURE_UID=%lu", uid);
    char policy[40]; snprintf(policy, sizeof(policy), "FIXTURE_POLICY=%s", argv[1]);
    char *env[] = { "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/tmp", "LANG=C", "LC_ALL=C", policy, uid_text, NULL };
    /* No caller environment, preload hooks, control FD, or arbitrary root-executed command. */
    char *args[64] = { "/bin/sh", "/opt/tool-smoke.sh", NULL };
    if (argc > 69) { errno = E2BIG; unsupported("suite arguments"); }
    for (int i = 8; i < argc; i++) args[i - 6] = argv[i];
    execve(args[0], args, env); unsupported("exec tool suite");
}
