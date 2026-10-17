/* CoworkAbi.h: the ONE file that maps the contract's libkrun ABI names to what the linked archive really exports.
 *
 * The contract (docs/cowork-native-worker.md section 8, S1) and the implementation (N2 S4, PR #55) disagree on names:
 *
 *   contract (S1)                         implemented (S4)                         status
 *   krun_cowork_enable_profile_v1         krun_cowork_enable_production_profile    renamed
 *   krun_cowork_set_workspace_disks_v1    krun_cowork_set_workspace_disks          renamed
 *   krun_cowork_create_mux_stream_v1      krun_cowork_create_runtime_port          renamed
 *   krun_cowork_get_flush_counters_v1     (none)                                   MISSING in S4
 *   krun_cowork_set_exit_hook_v1          (none)                                   MISSING in S4
 *   (none)                                krun_cowork_validate_production_profile  optional preflight
 *
 * The worker source uses ONLY the contract's names. This header decides, at build time and never at run time:
 *
 *   CW_ABI_NAMES_CONTRACT   0 (default): the library has S4's names; the contract names are macros for them.
 *                           1: the library has the contract's names; they are declared here.
 *   CW_ABI_FLUSH_EVIDENCE   1: the library exports get_flush_counters and set_exit_hook (declared here).
 *                           0 (default): it does not; both are inline refusals returning -ENOSYS.
 *
 * build.py sets both from `nm` on the archive it links, so a rename or the arrival of the two missing symbols is a one-line
 * change in how the archive is chosen, and this file. WITHOUT FLUSH EVIDENCE THE WORKER REFUSES TO START A VM: the Class A
 * receipt's chain needs the exit hook and the counters, and a VM whose orderly stop can never be receipted must not run.
 * S4 must add the pair, or the contract must change; this is reported, not worked around (no atexit() stand-in).
 */
#ifndef WINTER_COWORK_WORKER_ABI_H
#define WINTER_COWORK_WORKER_ABI_H

#include "libkrun.h" /* from -I: S4's composed header (its generic API and the KRUN_COWORK_PRODUCTION_* limits) */

#include <errno.h>
#include <stddef.h>
#include <stdint.h>

#include "Envelope.h"

#ifndef CW_ABI_NAMES_CONTRACT
#define CW_ABI_NAMES_CONTRACT 0
#endif
#ifndef CW_ABI_FLUSH_EVIDENCE
#define CW_ABI_FLUSH_EVIDENCE 0
#endif

#if !defined(KRUN_COWORK_PRODUCTION_VCPUS) || !defined(KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB) || !defined(KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB)
#error "libkrun.h does not declare the production profile limits: link S4's header (cowork/n2-libkrun-profile)"
#endif
/* The gate the worker validates SCOPE against. S1's parser admits 256..1024 MiB; the library refuses below 768. */
#define CW_GATE_VCPUS ((uint32_t)KRUN_COWORK_PRODUCTION_VCPUS)
#define CW_GATE_MIN_MEMORY_MIB ((uint32_t)KRUN_COWORK_PRODUCTION_MIN_MEMORY_MIB)
#define CW_GATE_MAX_MEMORY_MIB ((uint32_t)KRUN_COWORK_PRODUCTION_MAX_MEMORY_MIB)

struct krun_cowork_flush_counters_v1 {
    uint64_t data_requested;
    uint64_t data_completed;
    uint64_t environment_requested;
    uint64_t environment_completed;
};

#if CW_ABI_NAMES_CONTRACT
struct krun_cowork_volume_identity_v1 {
    uint64_t device;
    uint64_t inode;
    uint64_t capacity_bytes;
    uint32_t uid;
    uint32_t mode;
};
int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id);
int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity_v1 *data,
                                           int32_t environment_fd, const struct krun_cowork_volume_identity_v1 *environment);
int32_t krun_cowork_create_mux_stream_v1(uint32_t ctx_id);
/* No preflight in the contract: the library's own start-time gate is the check. */
static inline int32_t cw_krun_preflight(uint32_t ctx_id) { (void)ctx_id; return 0; }
#else
#define krun_cowork_volume_identity_v1 krun_cowork_volume_identity
#define krun_cowork_enable_profile_v1 krun_cowork_enable_production_profile
#define krun_cowork_set_workspace_disks_v1 krun_cowork_set_workspace_disks
#define krun_cowork_create_mux_stream_v1 krun_cowork_create_runtime_port
/* S4's optional side-effect-free preflight of the same admission krun_start_enter applies. */
static inline int32_t cw_krun_preflight(uint32_t ctx_id) { return krun_cowork_validate_production_profile(ctx_id); }
#endif

#if CW_ABI_FLUSH_EVIDENCE
int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out);
int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t guest_halted), void *user);
#else
static inline int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out) {
    (void)ctx_id; (void)out;
    return -ENOSYS;
}
static inline int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t guest_halted), void *user) {
    (void)ctx_id; (void)hook; (void)user;
    return -ENOSYS;
}
#endif

/* The worker's own identity record and the library's must have the same bytes. */
_Static_assert(sizeof(struct krun_cowork_volume_identity_v1) == 32, "volume identity is 32 bytes");
_Static_assert(offsetof(struct krun_cowork_volume_identity_v1, device) == 0 && offsetof(struct krun_cowork_volume_identity_v1, inode) == 8
                   && offsetof(struct krun_cowork_volume_identity_v1, capacity_bytes) == 16 && offsetof(struct krun_cowork_volume_identity_v1, uid) == 24
                   && offsetof(struct krun_cowork_volume_identity_v1, mode) == 28, "volume identity layout");
_Static_assert(sizeof(cw_volume_identity) == sizeof(struct krun_cowork_volume_identity_v1), "cw_volume_identity matches the ABI struct");
_Static_assert(offsetof(cw_volume_identity, capacity_bytes) == offsetof(struct krun_cowork_volume_identity_v1, capacity_bytes)
                   && offsetof(cw_volume_identity, uid) == offsetof(struct krun_cowork_volume_identity_v1, uid)
                   && offsetof(cw_volume_identity, mode) == offsetof(struct krun_cowork_volume_identity_v1, mode), "cw_volume_identity layout");
_Static_assert(sizeof(struct krun_cowork_flush_counters_v1) == 32, "flush counters are 32 bytes");
_Static_assert(CW_VCPUS == KRUN_COWORK_PRODUCTION_VCPUS, "the S1 vCPU count equals the library gate");

#endif
