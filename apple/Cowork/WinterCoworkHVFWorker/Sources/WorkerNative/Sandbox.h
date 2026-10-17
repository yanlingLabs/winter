/* Sandbox: the worker's Seatbelt profile (deny default) and its two entry points.
 *
 * `sandbox_init_with_parameters` is Apple SPI, also used by Winter's OfficeHelper bridge and by the admitted fixture worker.
 * It has been exercised only on macOS 26.6.1 and only by the fixture. NOTHING IN THIS PACKAGE'S TESTS CALLS IT: the unit tests
 * link their own `sandbox_init_with_parameters` that aborts, and a Python guard refuses a test that names cw_sandbox_install.
 * The first real call is gate G0 (`winter-cowork-worker --sandbox-check`), after review of the exact commit and the owner's approval.
 *
 * Differences from the fixture's profile, each a removal or a narrowing:
 *   - no `file-write*` at all (the two literals were vestigial: the disks arrive as descriptors);
 *   - read access to the guest artifact directory only, in place of the worker's whole directory;
 *   - the parameter set is one name (GUESTDIR), not a list of fixture paths.
 * Everything else is the fixture's, which is what the admitted two-disk evidence ran under. `file-lock` is NOT allowed: whether
 * flock needs it under deny-default is unverified (the first named G0 item), and a blind allow would widen the profile on no evidence.
 */
#ifndef WINTER_COWORK_WORKER_SANDBOX_H
#define WINTER_COWORK_WORKER_SANDBOX_H

#include "WorkerCommon.h"

/* The profile text (a C string with no embedded paths: the guest directory arrives as the GUESTDIR parameter). */
extern const char cw_sandbox_profile[];
/* The single parameter name the profile reads. */
extern const char cw_sandbox_param_guest_dir[];

/* Directory next to the worker executable that holds the guest artifacts, and the two file names inside it. */
#define CW_GUEST_DIRNAME "cowork-guest"
#define CW_GUEST_KERNEL "kernel"
#define CW_GUEST_INITRAMFS "initramfs.cpio"

/* Apply the profile with GUESTDIR = guest_dir. Returns 0, or -1 (a fixed message in *message). NOT CALLED BY ANY TEST. */
int cw_sandbox_install(const char *guest_dir, const char **message);

/* After install: prove the denials by trying them (host file read, outbound network, an unrelated write, fork, exec) and
 * that a sandbox is in force. Returns 0 only when every one was refused with EPERM. NOT CALLED BY ANY TEST. */
int cw_sandbox_probe(const char *guest_dir, const char **message);

#endif
