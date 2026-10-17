/* winter-cowork-worker: the production Cowork worker (N2 slice S3).
 *
 * It hosts the Cowork Linux VM through a patched static libkrun: two virtio-blk disks, one generic virtio-console port for the
 * mux, PL011 output. No NIC, no vsock, no virtiofs, no GPU, no input device, no shutdown GPIO device. It runs ONE workspace for
 * one incarnation and exits.
 *
 * SOURCE ONLY. This file has never been run. The VM path (krun_start_enter) and the sandbox path (cw_sandbox_install) are
 * reachable only from a worker started by the launcher; every run gate (G0 to G6) needs a review of the exact commit and the
 * owner's approval first. Nothing in the daemon, the launcher or the app refers to this package.
 *
 * ARGV. The contract says argv is exactly `[path]`. The ONE other form is `--sandbox-check`, which belongs to gate G0 alone: it is how
 * the owner's gate harness (or the launcher, run by hand) asks for the sandbox, the denial probes, the envelope intake and the lock
 * WITHOUT any libkrun context. The launcher never passes it; a launcher that did would only get a worker that exits before a VM.
 * Anything else is refused (exit 2).
 *
 * What it keeps from the admitted fixture worker (cowork/two-disk-fixture 9a588735, workspace_fixture_worker.c):
 *   the sandbox installed BEFORE anything is read, fail-closed `_exit(79)` on a truncated or unexpected descriptor, the
 *   sandbox's own denial probes, an unnamed inherited control socket, the empty libkrun environment, PL011 output only, the
 *   same libkrun device-less setup calls, and the same kernel command line.
 * What it drops:
 *   the fixed argv layout, alarm(120), the 2 vCPU / 768 MiB constants (SCOPE carries them), the vestigial-looking file-write* allow
 *   (whether it was vestigial is UNVERIFIED: see the research note and the G0 I/O variant), the fixture opt-ins and trace, and the
 *   sampler pipe.
 * What it adds: the SCOPE/VOLUMES/DRAIN/STATUS/FAULT envelopes (Envelope.c), the mux relay (Relay.c), OwnedStop, an advisory
 *   lock on the received descriptors (an extra guard, NEVER release evidence), the runtime image digest check (RuntimeImage.c), bounded
 *   console capture, flush counters for the Class A receipt, and an owner-loss watchdog.
 *
 * Process exit, EOF and a closed descriptor are cleanup. They never release a disk.
 */
#include "AdmittedVolumes.h"
#include "ConsoleRing.h"
#include "CoworkAbi.h"
#include "Envelope.h"
#include "Relay.h"
#include "RuntimeImage.h"
#include "Sandbox.h"

#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* The same command line the admitted fixture boots with (minus its fixture-only close marker). */
#define CW_KERNEL_CMDLINE "console=ttyAMA0 keep_bootcon printk.devkmsg=on rdinit=/init panic=1 reboot=k loglevel=4"
#define CW_SCOPE_WAIT_MS 10000
#define CW_VOLUMES_WAIT_MS 120000
#define CW_SPILL_BUDGET_MS 1000
/* The guest console is written out only if the guest never said hello (no workspace content can have been mounted yet), and then at most this much. */
#define CW_GUEST_SPILL_BYTES 16384u

/* ---- process state -------------------------------------------------------------------------------------------------------- */

static int saved_stderr = STDERR_FILENO; /* the launcher's stderr: fd 2 itself until a private copy is made and fd 2 is pointed at the console */
static cw_ring host_ring;       /* libkrun's own stderr: log lines. Spilled on any abnormal exit. */
static cw_ring guest_ring;      /* the guest's PL011 output. Drained so the VMM never blocks; spilled only before the guest's hello. */
static pthread_mutex_t console_lock = PTHREAD_MUTEX_INITIALIZER;
static int host_read_fd = -1, host_write_fd = -1, guest_read_fd = -1, guest_write_fd = -1;
static cw_l2_out l2_out;
static cw_relay relay;          /* static: it holds two 1 MiB frame buffers */
static uint32_t vm_context;

typedef struct { const char *guest_dir; const char *kernel; const char *initramfs; } worker_paths;

static uint64_t clock_ms(void *unused) {
    (void)unused;
    return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000000ull; /* does not count host sleep: a drain budget is guest run time */
}
static void random_bytes(void *unused, uint8_t *out, size_t length) {
    (void)unused;
    arc4random_buf(out, length);
}
static pid_t parent_pid_now(void *unused) {
    (void)unused;
    return getppid();
}

/* ---- bounded output to the launcher's stderr ------------------------------------------------------------------------------ */

/* Writes in pipe-atomic pieces, each only after poll says there is room, and gives up after `budget_ms`. It never blocks on a
 * launcher that is not reading, and it never changes the descriptor's flags (the launcher shares that open file description). */
static void write_bounded(const uint8_t *data, size_t length, int budget_ms) {
    if (saved_stderr < 0) return;
    uint64_t deadline = clock_ms(NULL) + (uint64_t)budget_ms;
    size_t offset = 0;
    while (offset < length) {
        uint64_t now = clock_ms(NULL);
        if (now >= deadline) return;
        struct pollfd wait = { .fd = saved_stderr, .events = POLLOUT, .revents = 0 };
        if (poll(&wait, 1, (int)(deadline - now)) <= 0 || !(wait.revents & POLLOUT)) return;
        size_t piece = length - offset > 512 ? 512 : length - offset;
        ssize_t written = write(saved_stderr, data + offset, piece);
        if (written <= 0) return;
        offset += (size_t)written;
    }
}

/* Fixed text only. Nothing a guest, an envelope or a path contributed ever goes through here. */
static void diag(const char *message) {
    char line[160];
    int made = snprintf(line, sizeof line, "winter-cowork-worker: %s\n", message);
    if (made > 0 && (size_t)made < sizeof line) write_bounded((const uint8_t *)line, (size_t)made, 250);
}

static void spill_ring(const cw_ring *ring, const char *title, size_t at_most) {
    static uint8_t snapshot[CW_RING_BYTES + CW_RING_LINE_MAX + 2];
    pthread_mutex_lock(&console_lock);
    size_t length = cw_ring_snapshot(ring, snapshot, sizeof snapshot);
    uint64_t dropped = ring->dropped, redacted = ring->redacted;
    pthread_mutex_unlock(&console_lock);
    if (length == 0) return;
    size_t skip = length > at_most ? length - at_most : 0; /* the tail only */
    char header[128];
    int made = snprintf(header, sizeof header, "winter-cowork-worker: %s (%llu bytes dropped, %llu addresses redacted)\n", title, (unsigned long long)dropped, (unsigned long long)redacted);
    if (made > 0 && (size_t)made < sizeof header) write_bounded((const uint8_t *)header, (size_t)made, CW_SPILL_BUDGET_MS);
    write_bounded(snapshot + skip, length - skip, CW_SPILL_BUDGET_MS);
}

/* On an abnormal exit only. The libkrun log tail always (bounded, redacted, ASCII). The guest's console only if the guest never reached its
 * hello: before that nothing of the workspace can have been mounted, so it is boot text; afterwards it can carry user content and is dropped. */
static void spill_rings(void) {
    spill_ring(&host_ring, "libkrun log tail", CW_RING_BYTES);
    if (!relay.saw_hello) spill_ring(&guest_ring, "guest console tail (before hello)", CW_GUEST_SPILL_BYTES);
}

__attribute__((noreturn)) static void worker_exit(int code) {
    if (code != CW_EXIT_OK) spill_rings();
    _exit(code);
}

/* One thread drains both pipes. Neither pipe is ever left full: the VMM thread writing into one would stall. */
static void *console_thread(void *unused) {
    (void)unused;
    uint8_t chunk[4096];
    int source[2] = { host_read_fd, guest_read_fd };
    for (;;) {
        struct pollfd fds[2] = { { .fd = source[0], .events = POLLIN, .revents = 0 }, { .fd = source[1], .events = POLLIN, .revents = 0 } };
        if (source[0] < 0 && source[1] < 0) return NULL;
        if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; return NULL; }
        for (int i = 0; i < 2; i++) {
            if (source[i] < 0 || !(fds[i].revents & (POLLIN | POLLHUP))) continue;
            ssize_t n = read(source[i], chunk, sizeof chunk); /* a pipe, never a socket: no rights can arrive on it */
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) { source[i] = -1; continue; } /* one pipe closing never stops the other from being drained */
            pthread_mutex_lock(&console_lock);
            cw_ring_feed(i == 0 ? &host_ring : &guest_ring, chunk, (size_t)n);
            pthread_mutex_unlock(&console_lock);
        }
    }
}

/* ---- guest artifacts ------------------------------------------------------------------------------------------------------ */

/* The guest artifacts live in <directory of this executable>/cowork-guest/ (docs/cowork-native-worker.md section 5). */
static int resolve_artifacts(char guest_dir[4096], char kernel[4096], char initramfs[4096]) {
    char executable[4096], resolved[4096];
    uint32_t length = sizeof executable;
    if (_NSGetExecutablePath(executable, &length) != 0 || realpath(executable, resolved) == NULL) return -1;
    char *slash = strrchr(resolved, '/');
    if (slash == NULL) return -1;
    *slash = 0;
    if (snprintf(guest_dir, 4096, "%s/%s", resolved, CW_GUEST_DIRNAME) >= 4096) return -1;
    if (snprintf(kernel, 4096, "%s/%s", guest_dir, CW_GUEST_KERNEL) >= 4096 || snprintf(initramfs, 4096, "%s/%s", guest_dir, CW_GUEST_INITRAMFS) >= 4096) return -1;
    struct stat info;
    if (lstat(guest_dir, &info) != 0 || !S_ISDIR(info.st_mode)) return -1;
    if (lstat(kernel, &info) != 0 || !S_ISREG(info.st_mode) || lstat(initramfs, &info) != 0 || !S_ISREG(info.st_mode)) return -1;
    return 0;
}

/* ---- the two callbacks of intake ------------------------------------------------------------------------------------------ */

static int install_sandbox_step(void *opaque) {
    const worker_paths *paths = opaque;
    const char *message = NULL;
    if (cw_sandbox_install(paths->guest_dir, &message) != 0) { diag("sandbox did not install"); return -1; }
    if (cw_sandbox_probe(paths->guest_dir, &message) != 0) { diag("sandbox denial probe failed"); return -1; }
    (void)cw_l2_send_status(&l2_out, CW_STATUS_SANDBOXED, NULL, NULL);
    return 0;
}

/* `runtimeImageDigest` is recomputed from the artifacts (opened O_NOFOLLOW) and must equal SCOPE's. A mismatch is exit 71. */
static int check_scope_step(void *opaque, const cw_scope *scope, const char **reason) {
    const worker_paths *paths = opaque;
    int rc = cw_runtime_image_verify(paths->kernel, paths->initramfs, scope->runtime_image_digest, reason);
    return rc == CW_IMAGE_OK ? CW_SCOPE_OK : (rc == CW_IMAGE_MISMATCH ? CW_SCOPE_REFUSED : CW_SCOPE_UNAVAILABLE);
}

/* ---- the VMM exit hook ---------------------------------------------------------------------------------------------------- */

/* Runs on the exiting thread after the final flush of both volumes, immediately before libkrun _exit()s. It must not block and must call no
 * krun_* function but the counter getters. The decision (may the worker say guest_halted?) is made in Relay.c on a library-free record. */
static void exit_hook(void *unused, uint32_t reason) {
    (void)unused;
    struct krun_cowork_flush_counters_v1 counters;
    int32_t counters_result = cw_read_flush_counters(&counters);
    cw_exit_report report;
    cw_exit_report_from_library(reason, counters_result, &counters, &report);
    cw_relay_vmm_exit(&relay, &report);
}
CW_ASSERT_EXIT_HOOK_SIGNATURE(exit_hook);

static void *relay_thread(void *unused) {
    (void)unused;
    for (;;) if (cw_relay_step(&relay, CW_RELAY_IDLE_MS)) worker_exit(relay.exit_code);
}

/* ---- the VM --------------------------------------------------------------------------------------------------------------- */

static int krun_check(int32_t result, const char *what) {
    if (result < 0) { char line[96]; snprintf(line, sizeof line, "libkrun refused: %s (%d)", what, (int)result); diag(line); return -1; }
    return 0;
}

/* Everything between the admitted descriptors and krun_start_enter, in the library's call order. Returns 0 and leaves `mux_peer` set, or -1. */
static int configure_vm(const cw_intake_result *intake, const char *kernel, const char *initramfs, int *mux_peer) {
    if (krun_check(krun_init_log(2, KRUN_LOG_LEVEL_WARN, KRUN_LOG_STYLE_NEVER, KRUN_LOG_OPTION_NO_ENV), "log")) return -1;
    int ctx = krun_create_ctx();
    if (krun_check(ctx, "context")) return -1;
    vm_context = (uint32_t)ctx;
    if (krun_check(krun_set_vm_config((uint32_t)ctx, (uint8_t)intake->scope.vcpus, intake->scope.memory_mib), "vm config")) return -1;
    if (krun_check(krun_disable_implicit_vsock((uint32_t)ctx), "disable implicit vsock")) return -1;
    const char *environment[] = { NULL };
    if (krun_check(krun_set_env((uint32_t)ctx, environment), "empty environment")) return -1;
    if (krun_check(krun_disable_implicit_console((uint32_t)ctx), "disable implicit console")) return -1;
    if (krun_check(krun_add_serial_console_default((uint32_t)ctx, -1, guest_write_fd), "PL011 output-only serial")) return -1;
    if (krun_check(krun_set_kernel((uint32_t)ctx, kernel, KRUN_KERNEL_FORMAT_RAW, initramfs, CW_KERNEL_CMDLINE), "kernel and initramfs")) return -1;
    if (krun_check(krun_cowork_enable_profile_v1((uint32_t)ctx), "production profile")) return -1;
    /* Fork and exec were denied by the sandbox before this point and the process never forks afterwards. The PORT comes BEFORE the disks. */
    int peer = krun_cowork_create_runtime_port_v1((uint32_t)ctx);
    if (krun_check(peer, "runtime port")) return -1;
    int type = 0;
    socklen_t size = sizeof type;
    if (peer < 5 || !(fcntl(peer, F_GETFD) & FD_CLOEXEC) || getsockopt(peer, SOL_SOCKET, SO_TYPE, &type, &size) != 0 || type != SOCK_STREAM) { diag("runtime port descriptor"); return -1; }
    *mux_peer = peer;
    struct krun_cowork_volume_identity data = { intake->volumes.data.device, intake->volumes.data.inode, intake->volumes.data.capacity_bytes, intake->volumes.data.uid, intake->volumes.data.mode };
    struct krun_cowork_volume_identity environment_disk = { intake->volumes.environment.device, intake->volumes.environment.inode, intake->volumes.environment.capacity_bytes,
                                                           intake->volumes.environment.uid, intake->volumes.environment.mode };
    if (krun_check(krun_cowork_set_workspace_disks_v1((uint32_t)ctx, intake->fds[0], &data, intake->fds[1], &environment_disk), "workspace disks")) return -1;
    /* The descriptors were borrowed and duplicated by the library. The flock belongs to the open file description, which the
     * library's duplicates keep alive; closing ours is not a release and the lock is not evidence of one. */
    close(intake->fds[0]);
    close(intake->fds[1]);
    /* The exit hook is what lets the Class A receipt exist; without it there is no reason to start a VM that could never be receipted. */
    if (krun_check(krun_cowork_set_exit_hook_v1((uint32_t)ctx, exit_hook, NULL), "exit hook")) return -1;
    /* MANDATORY preflight, after ALL configuration: a non-zero result starts no VM (the library also refuses to start a context without it). */
    if (krun_check(krun_cowork_validate_profile_v1((uint32_t)ctx), "profile preflight")) return -1;
    return 0;
}

/* ---- main ----------------------------------------------------------------------------------------------------------------- */

int main(int argc, char **argv) {
    bool check_only = argc == 2 && strcmp(argv[1], "--sandbox-check") == 0;
    if (!check_only && argc != 1) return CW_EXIT_USAGE; /* no argv layout: the worker takes nothing from its caller but the descriptors */

    /* The launcher spawned this process and is its owner. If it is already gone, say so and leave: no disk was ever held. */
    const pid_t launcher_pid = getppid();
    (void)signal(SIGPIPE, SIG_IGN);
    if (cw_prepare_descriptors(CW_FD_L2, CW_FD_L3) != 0) { /* closes everything else, restores CLOEXEC on 3 and 4, admits them */
        diag("the inherited channels are not the unnamed L2/L3 socketpair ends");
        return CW_EXIT_USAGE;
    }
    if (launcher_pid == 1) { diag("the launcher was already gone at start"); return CW_EXIT_OK; }
    cw_l2_out_init(&l2_out, CW_FD_L2);
    cw_ring_init(&host_ring);
    cw_ring_init(&guest_ring);

    char guest_dir[4096], kernel[4096], initramfs[4096];
    if (resolve_artifacts(guest_dir, kernel, initramfs) != 0) {
        diag("guest artifacts are missing next to the worker");
        (void)cw_l2_send_fault(&l2_out, CW_FAULT_INTERNAL);
        return CW_EXIT_INTERNAL;
    }
    if (!check_only) {
        saved_stderr = fcntl(STDERR_FILENO, F_DUPFD_CLOEXEC, 10); /* a private copy; fd 2 itself is about to become the log pipe */
        int host_pipe[2], guest_pipe[2];
        if (pipe(host_pipe) != 0 || pipe(guest_pipe) != 0) { diag("console pipes"); return CW_EXIT_INTERNAL; }
        int all[4] = { host_pipe[0], host_pipe[1], guest_pipe[0], guest_pipe[1] };
        for (int i = 0; i < 4; i++) if (fcntl(all[i], F_SETFD, FD_CLOEXEC) != 0) { diag("console pipe flags"); return CW_EXIT_INTERNAL; }
        host_read_fd = host_pipe[0]; host_write_fd = host_pipe[1];
        guest_read_fd = guest_pipe[0]; guest_write_fd = guest_pipe[1];
    }

    /* 1. SANDBOX FIRST, then SCOPE and VOLUMES. cw_intake_run installs the sandbox before it reads one byte from L2. */
    worker_paths paths = { guest_dir, kernel, initramfs };
    cw_intake_config config = { install_sandbox_step, check_scope_step, &paths, CW_SCOPE_WAIT_MS, CW_VOLUMES_WAIT_MS, geteuid(), { CW_GATE_VCPUS, CW_GATE_MIN_MEMORY_MIB, CW_GATE_MAX_MEMORY_MIB } };
    static cw_intake_result intake;
    cw_intake_run(&config, CW_FD_L2, &intake);
    switch (intake.outcome) {
    case CW_INTAKE_OK:
        break;
    case CW_INTAKE_FAULT:
        (void)cw_l2_send_fault(&l2_out, intake.fault);
        diag(intake.reason);
        worker_exit(intake.exit_code);
    case CW_INTAKE_SILENT_EXIT:
        diag(intake.reason); /* a diagnostic is not an acknowledgement; nothing is sent on L2 */
        worker_exit(intake.exit_code);
    case CW_INTAKE_STOP_BEFORE_VM:
        (void)cw_l2_send_status(&l2_out, CW_STATUS_EXITING, NULL, NULL); /* no VM existed; no disk was held */
        worker_exit(intake.exit_code);
    case CW_INTAKE_OWNER_GONE:
        worker_exit(intake.exit_code);
    }
    (void)cw_l2_send_status(&l2_out, CW_STATUS_VOLUMES_ACCEPTED, NULL, NULL);

    if (check_only) {
        /* G0: the sandbox, the probes, the envelopes, the image digest and the lock were exercised; no libkrun context is ever created. */
        close(intake.fds[0]);
        close(intake.fds[1]);
        (void)cw_l2_send_status(&l2_out, CW_STATUS_EXITING, NULL, NULL);
        diag("sandbox check passed; no VM was created");
        worker_exit(CW_EXIT_OK);
    }

    /* 2. The console: libkrun's stderr and the guest's PL011 output go to two pipes; one thread keeps both rings drained. */
    pthread_t console;
    if (dup2(host_write_fd, STDERR_FILENO) < 0 || pthread_create(&console, NULL, console_thread, NULL) != 0) {
        (void)cw_l2_send_fault(&l2_out, CW_FAULT_INTERNAL);
        worker_exit(CW_EXIT_INTERNAL);
    }
    (void)pthread_detach(console);

    /* 3. The VM. */
    int mux_peer = -1;
    if (configure_vm(&intake, kernel, initramfs, &mux_peer) != 0) {
        (void)cw_l2_send_fault(&l2_out, CW_FAULT_VM_FAILED);
        worker_exit(CW_EXIT_VM_FAILED);
    }

    /* 4. Everything that must keep running once krun_start_enter takes this thread is started now. */
    cw_relay_env env = { clock_ms, random_bytes, parent_pid_now, NULL };
    cw_relay_init(&relay, CW_FD_L2, CW_FD_L3, mux_peer, &l2_out, intake.next_seq, launcher_pid, &env);
    cw_relay_vm_started(&relay);
    pthread_t pump;
    if (pthread_create(&pump, NULL, relay_thread, NULL) != 0) {
        (void)cw_l2_send_fault(&l2_out, CW_FAULT_INTERNAL);
        worker_exit(CW_EXIT_INTERNAL);
    }
    (void)pthread_detach(pump);
    (void)cw_l2_send_status(&l2_out, CW_STATUS_VM_RUNNING, NULL, NULL);
    int32_t started = krun_start_enter(vm_context);
    /* Success never returns: the library owns the process and ends it. */
    (void)krun_check(started, "start");
    (void)cw_l2_send_fault(&l2_out, CW_FAULT_VM_FAILED);
    worker_exit(CW_EXIT_VM_FAILED);
}
