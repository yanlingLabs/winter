/* A tiny assertion kit for the strict-C tests. CHECK never compiles out (unlike assert under NDEBUG). */
#ifndef WINTER_COWORK_WORKER_TEST_SUPPORT_H
#define WINTER_COWORK_WORKER_TEST_SUPPORT_H

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int cw_test_failures = 0;
static int cw_test_checks = 0;

#define CHECK(condition) \
    do { cw_test_checks++; if (!(condition)) { cw_test_failures++; fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #condition); } } while (0)
#define CHECK_STR(actual, expected) \
    do { cw_test_checks++; const char *a_ = (actual), *e_ = (expected); \
        if (a_ == NULL || e_ == NULL || strcmp(a_, e_) != 0) { cw_test_failures++; fprintf(stderr, "FAIL %s:%d: got \"%s\" want \"%s\"\n", __FILE__, __LINE__, a_ ? a_ : "(null)", e_ ? e_ : "(null)"); } } while (0)

__attribute__((unused)) static int cw_test_open_descriptors(void) {
    int count = 0;
    for (int fd = 0; fd < 1024; fd++) if (fcntl(fd, F_GETFD) >= 0) count++;
    return count;
}

static int cw_test_finish(const char *name) {
    if (cw_test_failures != 0) { fprintf(stderr, "%s: %d of %d checks FAILED\n", name, cw_test_failures, cw_test_checks); return 1; }
    printf("%s: %d checks passed\n", name, cw_test_checks);
    return 0;
}

#endif
