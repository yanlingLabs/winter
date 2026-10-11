#define _POSIX_C_SOURCE 200809L
/* Controlled guest workload; successful free() alone does not prove host RAM return. */
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t requested;
static void request(int signal_number) { requested = signal_number; }
static long rss_kib(void) {
    FILE *file = fopen("/proc/self/status", "r");
    if (!file) return -1;
    char line[256]; long value = -1;
    while (fgets(line, sizeof(line), file)) if (sscanf(line, "VmRSS: %ld kB", &value) == 1) break;
    fclose(file); return value;
}
static void emit(const char *phase, size_t mib) {
    printf("{\"kind\":\"memory\",\"phase\":\"%s\",\"pid\":%ld,\"requestedMiB\":%zu,\"rssKiB\":%ld}\n", phase, (long)getpid(), mib, rss_kib());
    fflush(stdout);
}
int main(int argc, char **argv) {
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: memprobe MiB(1..512) [holdSeconds(1..300), default30]\n"); return 64;
    }
    char *end; errno = 0; unsigned long mib = strtoul(argv[1], &end, 10);
    if (errno || *end || mib < 1 || mib > 512) return 64;
    unsigned long hold = 30;
    if (argc == 3) { hold = strtoul(argv[2], &end, 10); if (errno || *end || hold < 1 || hold > 300) return 64; }
    struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = request;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, NULL) || sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) return 1;
    emit("before", mib);
    size_t bytes = (size_t)mib * 1024 * 1024;
    volatile unsigned char *memory = malloc(bytes);
    if (!memory) { emit("allocation_failed", mib); return 1; }
    long page = sysconf(_SC_PAGESIZE); if (page < 1) page = 4096;
    for (size_t i = 0; i < bytes; i += (size_t)page) memory[i] = (unsigned char)(i / (size_t)page);
    memory[bytes - 1] = 1;
    emit("allocated", mib);
    /* SIGUSR1 frees early; SIGTERM/INT frees and exits. The timeout is always bounded. */
    for (unsigned long i = 0; i < hold && !requested; i++) sleep(1);
    int stopping = requested == SIGTERM || requested == SIGINT;
    free((void *)memory);
    emit("freed", mib);
    if (!stopping) {
        requested = 0;
        for (unsigned long i = 0; i < hold && !requested; i++) sleep(1);
        emit("after_free_hold", mib);
    }
    return 0;
}
