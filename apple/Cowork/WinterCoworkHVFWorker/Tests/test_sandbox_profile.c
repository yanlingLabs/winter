/* The Seatbelt profile as TEXT. This test never applies it.
 *
 * The test binary defines its own sandbox_init_with_parameters and sandbox_check, which the linker binds in place of the
 * system's: if anything ever called either, the test would print a banner and exit 99 instead of sandboxing the test process.
 * gate G0 (--sandbox-check of the production worker) is the first real call, after review and the owner's approval. */
#include "Sandbox.h"
#include "test_support.h"

#include <stdint.h>
#include <sys/types.h>

int sandbox_init_with_parameters(const char *profile, uint64_t flags, const char *const parameters[], char **errorbuf);
void sandbox_free_error(char *errorbuf);
int sandbox_check(pid_t pid, const char *operation, int type, ...);

int sandbox_init_with_parameters(const char *profile, uint64_t flags, const char *const parameters[], char **errorbuf) {
    (void)profile; (void)flags; (void)parameters; (void)errorbuf;
    fprintf(stderr, "FATAL: a test called sandbox_init_with_parameters\n");
    _exit(99);
}
void sandbox_free_error(char *errorbuf) { (void)errorbuf; fprintf(stderr, "FATAL: a test called sandbox_free_error\n"); _exit(99); }
int sandbox_check(pid_t pid, const char *operation, int type, ...) { (void)pid; (void)operation; (void)type; fprintf(stderr, "FATAL: a test called sandbox_check\n"); _exit(99); }

static int count(const char *text, const char *needle) {
    int n = 0;
    for (const char *at = strstr(text, needle); at != NULL; at = strstr(at + 1, needle)) n++;
    return n;
}

int main(void) {
    const char *p = cw_sandbox_profile;
    CHECK(strncmp(p, "(version 1)(deny default)", 25) == 0);
    /* Deny-default, and fork/exec explicitly denied. */
    CHECK(count(p, "(deny default)") == 1 && count(p, "(deny process-fork)") == 1 && count(p, "(deny process-exec)") == 1);
    /* NOTHING that writes, listens or connects is allowed. The fixture's vestigial file-write* allow on the two disk literals is gone. */
    const char *never[] = { "file-write", "file*", "network", "mach-lookup", "mach*", "ipc-", "iokit", "process-exec*", "process-fork*", "signal", "system-", "sysctl-write",
                            "file-lock", "(allow default)", "pseudo-tty", "user-preference", "job-creation", "(allow process-exec", "(allow process-fork" };
    for (size_t i = 0; i < sizeof never / sizeof never[0]; i++) CHECK(strstr(p, never[i]) == NULL);
    CHECK(count(p, "(allow ") == 5); /* sysctl-read, process-info*, and three file-read* groups ... */
    /* ... the exact allow list. */
    CHECK(strstr(p, "(allow sysctl-read)") != NULL);
    CHECK(strstr(p, "(allow process-info* (target self))") != NULL);
    CHECK(strstr(p, "(allow file-read* (literal \"/usr/bin/true\"))") != NULL);
    CHECK(strstr(p, "(allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") (subpath (param \"GUESTDIR\")))") != NULL);
    CHECK(strstr(p, "(allow file-read* (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))") != NULL);
    /* Reads are the only allow on the filesystem; the only parameter is the guest directory; no path is baked in. */
    CHECK(count(p, "file-read*") == 3 && count(p, "(param ") == 1);
    CHECK_STR(cw_sandbox_param_guest_dir, "GUESTDIR");
    CHECK(strstr(p, "/Users") == NULL && strstr(p, "/private") == NULL && strstr(p, "/Volumes") == NULL && strstr(p, "/var/") == NULL);
    CHECK(strstr(p, "fixture") == NULL && strstr(p, "FIXTURE") == NULL && strstr(p, "DISK") == NULL && strstr(p, "ENVIRONMENT") == NULL);
    /* Balanced parentheses: a profile that would not parse is caught here, not at G0. */
    int depth = 0, in_string = 0;
    for (const char *c = p; *c != 0; c++) {
        if (*c == '"' && (c == p || c[-1] != '\\')) in_string = !in_string;
        if (in_string) continue;
        if (*c == '(') depth++;
        if (*c == ')') depth--;
        CHECK(depth >= 0);
    }
    CHECK(depth == 0 && !in_string);
    CHECK_STR(CW_GUEST_DIRNAME, "cowork-guest");
    return cw_test_finish("test_sandbox_profile");
}
