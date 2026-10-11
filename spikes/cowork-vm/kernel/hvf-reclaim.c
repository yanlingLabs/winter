/* Bounded Hypervisor.framework reclaim primitive, NOT a Linux backend.
 * Requires explicit --run-fixture. 384 MiB touched, 256 MiB returned, one vCPU,
 * five cycles, no network/disks/host-pressure generator. Reclaim follows a guest
 * handoff with the vCPU stopped at an MMIO exit; other live ranges survive.
 * Tests public unmap/munmap/mmap/map rather than reusable-accounting advice.
 * Approach reference: arcboxlabs/macos-vm-memory-ratchet at 35b28f379daa,
 * crates/hv-reclaim/src/timing.rs. This independent fixture checks every word,
 * zero-fill after discard, retained live ranges, and continued execution.
 */
#include <Hypervisor/Hypervisor.h>
#include <libkern/OSCacheControl.h>
#include <mach/mach.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define MIB (1024ULL * 1024ULL)
#define RAM_SIZE (384 * MIB)
#define LIVE_SIZE (64 * MIB)
#define RECLAIM_SIZE (256 * MIB)
#define CODE_GPA 0x10000000ULL
#define RAM_GPA 0x80000000ULL
#define DOORBELL_GPA 0x0F000000ULL
extern const char cowork_fill_start[], cowork_fill_end[];
extern const char cowork_verify_start[], cowork_verify_end[];
static hv_vcpu_t cpu;
static hv_vcpu_exit_t *exit_info;

static void check(bool ok, const char *what) {
    if (!ok) { fprintf(stderr, "fixture failed: %s\n", what); exit(1); }
}
static void hvcheck(hv_return_t result, const char *what) {
    if (result != HV_SUCCESS) { fprintf(stderr, "fixture failed: %s: 0x%x\n", what, result); exit(1); }
}
static void reg(hv_reg_t r, uint64_t value) { hvcheck(hv_vcpu_set_reg(cpu, r, value), "set register"); }
static uint64_t monotonic_ns(void) {
    struct timespec t; check(clock_gettime(CLOCK_MONOTONIC, &t) == 0, "clock");
    return (uint64_t)t.tv_sec * 1000000000ULL + (uint64_t)t.tv_nsec;
}
static uint64_t footprint(void) {
    task_vm_info_data_t info = {0}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    check(task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) == KERN_SUCCESS, "task_info");
    return info.phys_footprint;
}
static uint64_t pass(uint64_t entry, size_t begin, size_t end, uint64_t word) {
    check(begin < end && end <= RAM_SIZE && begin % 8 == 0 && end % 8 == 0, "guest range");
    reg(HV_REG_PC, entry); reg(HV_REG_X1, RAM_GPA + begin); reg(HV_REG_X2, RAM_GPA + end);
    reg(HV_REG_X3, DOORBELL_GPA); reg(HV_REG_X4, 0); reg(HV_REG_X5, word);
    for (;;) {
        hvcheck(hv_vcpu_run(cpu), "run");
        if (exit_info->reason == HV_EXIT_REASON_CANCELED) continue;
        check(exit_info->reason == HV_EXIT_REASON_EXCEPTION &&
              ((exit_info->exception.syndrome >> 26) & 0x3f) == 0x24 &&
              exit_info->exception.physical_address == DOORBELL_GPA, "expected guest handoff");
        uint64_t failures = 0; hvcheck(hv_vcpu_get_reg(cpu, HV_REG_X4, &failures), "read result");
        return failures;
    }
}
static void verify(size_t begin, size_t end, uint64_t word) {
    check(pass(CODE_GPA + 256, begin, end, word) == 0, "guest word integrity");
}
int main(int argc, char **argv) {
    if (argc != 2 || strcmp(argv[1], "--run-fixture") != 0) {
        fprintf(stderr, "usage: hvf-reclaim --run-fixture (384 MiB bounded, no pressure)\n"); return 2;
    }
    alarm(30);
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    check(page == 16384, "Apple Silicon host page size");
    void *ram = mmap(NULL, RAM_SIZE, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0);
    void *code = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0);
    check(ram != MAP_FAILED && code != MAP_FAILED, "anonymous fixture mappings");
    size_t fill_bytes = (size_t)(cowork_fill_end - cowork_fill_start);
    size_t verify_bytes = (size_t)(cowork_verify_end - cowork_verify_start);
    check(fill_bytes < 256 && verify_bytes < 256, "guest code bounds");
    memcpy(code, cowork_fill_start, fill_bytes);
    memcpy((char *)code + 256, cowork_verify_start, verify_bytes);
    sys_icache_invalidate(code, page);
    hvcheck(hv_vm_create(NULL), "VM create");
    hvcheck(hv_vm_map(code, CODE_GPA, page, HV_MEMORY_READ | HV_MEMORY_EXEC), "code map");
    hvcheck(hv_vm_map(ram, RAM_GPA, RAM_SIZE, HV_MEMORY_READ | HV_MEMORY_WRITE), "RAM map");
    hvcheck(hv_vcpu_create(&cpu, &exit_info, NULL), "vCPU create");
    reg(HV_REG_CPSR, 0x3c5);
    uint64_t baseline = footprint();
    printf("{\"kind\":\"bounded_hvf_primitive\",\"ramBytes\":%llu,\"returnBytes\":%llu,\"baselineBytes\":%llu,\"pressure\":false,\"linux\":false}\n",
        RAM_SIZE, RECLAIM_SIZE, (unsigned long long)baseline);
    for (unsigned cycle = 1; cycle <= 5; cycle++) {
        uint64_t word = 0xF00DCAFE10000000ULL + cycle;
        pass(CODE_GPA, 0, RAM_SIZE, word); verify(0, RAM_SIZE, word);
        uint64_t before = footprint(), started = monotonic_ns();
        // Only the handed-off range is destroyed; code and both live regions remain.
        for (size_t off = LIVE_SIZE; off < LIVE_SIZE + RECLAIM_SIZE; off += 2 * MIB) {
            void *at = (char *)ram + off;
            hvcheck(hv_vm_unmap(RAM_GPA + off, 2 * MIB), "reclaim unmap");
            check(munmap(at, 2 * MIB) == 0, "discard mapping");
            check(mmap(at, 2 * MIB, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE | MAP_FIXED, -1, 0) == at, "fresh zero mapping");
            hvcheck(hv_vm_map(at, RAM_GPA + off, 2 * MIB, HV_MEMORY_READ | HV_MEMORY_WRITE), "reclaim remap");
        }
        uint64_t elapsed = monotonic_ns() - started, after = footprint();
        check(before > after && before - after >= 240 * MIB, "substantial host RAM return");
        verify(0, LIVE_SIZE, word); verify(LIVE_SIZE + RECLAIM_SIZE, RAM_SIZE, word);
        verify(LIVE_SIZE, LIVE_SIZE + RECLAIM_SIZE, 0);
        pass(CODE_GPA, LIVE_SIZE, LIVE_SIZE + RECLAIM_SIZE, word); verify(0, RAM_SIZE, word);
        printf("{\"cycle\":%u,\"beforeBytes\":%llu,\"afterBytes\":%llu,\"returnedBytes\":%llu,\"reusedBytes\":%llu,\"reclaimNs\":%llu,\"liveWordsPreserved\":true,\"discardedWordsZero\":true,\"reuseVerified\":true}\n",
            cycle, (unsigned long long)before, (unsigned long long)after, (unsigned long long)(before-after),
            (unsigned long long)footprint(), (unsigned long long)elapsed);
    }
    hvcheck(hv_vcpu_destroy(cpu), "vCPU destroy"); hvcheck(hv_vm_destroy(), "VM destroy");
    check(munmap(ram, RAM_SIZE) == 0 && munmap(code, page) == 0, "mapping cleanup");
    printf("{\"completed\":true,\"vmDestroyed\":true,\"finalBytes\":%llu}\n", (unsigned long long)footprint());
    return 0;
}
