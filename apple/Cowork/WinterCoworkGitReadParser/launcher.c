/* Owned Git parser bootstrap. No packet parsing, token, socket, guest pathname or writable file. */
#include <errno.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <fcntl.h>
extern int sandbox_check(pid_t, const char *, int, ...);
static int denied(const char *operation, int filter, const char *value) {
    return sandbox_check(getpid(), operation, filter | 0x40000000, value) == 1;
}
static int limit(int resource, rlim_t value) {
    struct rlimit cap = { value, value }, actual;
    return setrlimit(resource, &cap) == 0 && getrlimit(resource, &actual) == 0 && actual.rlim_cur == value && actual.rlim_max == value;
}
int main(int argc, char **argv) {
    /* Refuse unsandboxed/weak launches before exec or reading stdin. These checks perform no
       real Keychain/file/network operation. Filter1 is literal path, filter2 global mach name. */
    if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/' || sandbox_check(getpid(), NULL, 0) != 1
        || !denied("mach-lookup", 2, "com.apple.SecurityServer") || !denied("mach-lookup", 2, "com.apple.securityd.xpc")
        || !denied("file-read-data", 1, "/Users") || !denied("file-write-data", 1, "/private/tmp/winter-git-parser-denied")
        || !denied("network-outbound", 0, NULL) || !denied("process-fork", 0, NULL)) return 77;
    int maxfds = 0; size_t size = sizeof(maxfds);
    if (sysctlbyname("kern.maxfilesperproc", &maxfds, &size, NULL, 0) != 0 || size != sizeof(maxfds) || maxfds < 3 || maxfds > 1048576) return 77;
    if (!limit(RLIMIT_CPU, 2) || !limit(RLIMIT_NOFILE, 64) || !limit(RLIMIT_CORE, 0) || !limit(RLIMIT_FSIZE, 0)) return 77;
    /* Parent supplies only three pipe descriptors. Close even an accidentally inherited fourth. */
    for (int fd = 3; fd < maxfds; fd++) close(fd);
    char *args[] = { argv[1], "--jitless", "--no-addons", "--no-global-search-paths", "--max-old-space-size=128", argv[2], NULL };
    char *env[] = { "PATH=/usr/bin:/bin", "HOME=/nonexistent", "NODE_OPTIONS=", "NODE_DISABLE_COMPILE_CACHE=1", "UV_THREADPOOL_SIZE=1", "LC_ALL=C", NULL };
    execve(argv[1], args, env);
    return 77;
}
