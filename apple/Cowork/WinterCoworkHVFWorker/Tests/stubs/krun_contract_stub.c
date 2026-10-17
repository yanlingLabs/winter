/* A STUB of the libkrun surface the worker uses, with the CONTRACT's names (the five *_v1 entry points of
 * docs/cowork-native-worker.md section 8). Every function returns -ENOSYS. It exists to prove that the worker source links in the
 * configuration the contract describes, i.e. that the rename S4 will make is the one-file change CoworkAbi.h says it is.
 *
 * THIS IS NOT libkrun AND THE BINARY IT PRODUCES MUST NEVER BE RUN: it creates no VM, calls no Hypervisor function, and refuses
 * everything. build.py links it and stops. */
#include "libkrun.h"

#include <errno.h>
#include <stdint.h>

struct krun_cowork_volume_identity_v1 { uint64_t device; uint64_t inode; uint64_t capacity_bytes; uint32_t uid; uint32_t mode; };
struct krun_cowork_flush_counters_v1 { uint64_t data_requested; uint64_t data_completed; uint64_t environment_requested; uint64_t environment_completed; };

int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id);
int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity_v1 *data, int32_t environment_fd,
                                           const struct krun_cowork_volume_identity_v1 *environment);
int32_t krun_cowork_create_mux_stream_v1(uint32_t ctx_id);
int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out);
int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t guest_halted), void *user);

int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id) { (void)ctx_id; return -ENOSYS; }
int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity_v1 *data, int32_t environment_fd,
                                           const struct krun_cowork_volume_identity_v1 *environment) {
    (void)ctx_id; (void)data_fd; (void)data; (void)environment_fd; (void)environment;
    return -ENOSYS;
}
int32_t krun_cowork_create_mux_stream_v1(uint32_t ctx_id) { (void)ctx_id; return -ENOSYS; }
int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out) { (void)ctx_id; (void)out; return -ENOSYS; }
int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t guest_halted), void *user) { (void)ctx_id; (void)hook; (void)user; return -ENOSYS; }

/* The generic setters the worker calls, with the header's own signatures. */
int32_t krun_init_log(int32_t target_fd, uint32_t level, uint32_t style, uint32_t options) { (void)target_fd; (void)level; (void)style; (void)options; return -ENOSYS; }
int32_t krun_create_ctx(void) { return -ENOSYS; }
int32_t krun_set_vm_config(uint32_t ctx_id, uint8_t num_vcpus, uint32_t ram_mib) { (void)ctx_id; (void)num_vcpus; (void)ram_mib; return -ENOSYS; }
int32_t krun_disable_implicit_vsock(uint32_t ctx_id) { (void)ctx_id; return -ENOSYS; }
int32_t krun_set_env(uint32_t ctx_id, const char *const envp[]) { (void)ctx_id; (void)envp; return -ENOSYS; }
int32_t krun_disable_implicit_console(uint32_t ctx_id) { (void)ctx_id; return -ENOSYS; }
int32_t krun_add_serial_console_default(uint32_t ctx_id, int input_fd, int output_fd) { (void)ctx_id; (void)input_fd; (void)output_fd; return -ENOSYS; }
int32_t krun_set_kernel(uint32_t ctx_id, const char *kernel_path, uint32_t kernel_format, const char *initramfs, const char *cmdline) {
    (void)ctx_id; (void)kernel_path; (void)kernel_format; (void)initramfs; (void)cmdline;
    return -ENOSYS;
}
int32_t krun_start_enter(uint32_t ctx_id) { (void)ctx_id; return -ENOSYS; }
