#include "Sandbox.h"

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

/* Apple SPI, declared here exactly as the fixture and the OfficeHelper bridge declare it. */
extern int sandbox_init_with_parameters(const char *profile, uint64_t flags, const char *const parameters[], char **errorbuf);
extern void sandbox_free_error(char *errorbuf);
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);

const char cw_sandbox_param_guest_dir[] = "GUESTDIR";

const char cw_sandbox_profile[] =
    "(version 1)(deny default)"
    "(deny process-fork)(deny process-exec)"
    "(allow sysctl-read)(allow process-info* (target self))"
    "(allow file-read* (literal \"/usr/bin/true\"))"
    "(allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") (subpath (param \"GUESTDIR\")))"
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))";

int cw_sandbox_install(const char *guest_dir, const char **message) {
    const char *parameters[] = { cw_sandbox_param_guest_dir, guest_dir, NULL };
    char *error = NULL;
    if (sandbox_init_with_parameters(cw_sandbox_profile, 0, parameters, &error) != 0) {
        if (error != NULL) sandbox_free_error(error);
        *message = "sandbox_init_with_parameters refused the profile";
        return -1;
    }
    return 0;
}

int cw_sandbox_probe(const char *guest_dir, const char **message) {
    if (sandbox_check(getpid(), NULL, 0) == 0) { *message = "no sandbox in force"; return -1; }
    /* The fixture's probes, in its order. Each must be refused by the sandbox itself (EPERM); a DAC refusal (EACCES) does not count. */
    int fd = open("/etc/hosts", O_RDONLY);
    if (!(fd < 0 && errno == EPERM)) { if (fd >= 0) close(fd); *message = "host file read was not denied"; return -1; }
    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0) {
        struct sockaddr_in target;
        memset(&target, 0, sizeof target);
        target.sin_len = sizeof target;
        target.sin_family = AF_INET;
        target.sin_port = htons(9);
        target.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        int rc = connect(fd, (struct sockaddr *)&target, sizeof target), denied = errno;
        close(fd);
        if (!(rc < 0 && denied == EPERM)) { *message = "outbound network was not denied"; return -1; }
    } else if (errno != EPERM) { *message = "network socket denial"; return -1; }
    /* A write in a directory the user could otherwise write: the guest directory. O_EXCL, and removed at once if it ever succeeded. */
    char path[4096];
    if (snprintf(path, sizeof path, "%s/.denied-write-probe", guest_dir) >= (int)sizeof path) { *message = "guest directory path length"; return -1; }
    fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (fd >= 0) { close(fd); (void)unlink(path); *message = "unrelated write was not denied"; return -1; }
    if (errno != EPERM) { *message = "filesystem write denial"; return -1; }
    if (sandbox_check(getpid(), "process-fork", 0) == 0 || sandbox_check(getpid(), "process-exec", 0) == 0) { *message = "fork/exec policy denial"; return -1; }
    errno = 0;
    pid_t child = fork();
    if (child == 0) _exit(98); /* only reachable if the sandbox failed; the parent refuses below */
    if (!(child == -1 && errno == EPERM)) { *message = "actual process-fork denial"; return -1; }
    char *const argv[] = { "/usr/bin/true", NULL };
    char *const envp[] = { NULL };
    errno = 0;
    if (!(execve(argv[0], argv, envp) == -1 && errno == EPERM)) { *message = "actual process-exec denial"; return -1; }
    return 0;
}
