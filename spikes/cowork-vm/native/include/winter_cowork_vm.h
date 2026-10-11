#ifndef WINTER_COWORK_VM_H
#define WINTER_COWORK_VM_H
#include <stdint.h>
// No callbacks into JavaScript. Submit copies JSON before returning. Zero means
// backpressure or null input; poll drains completed operations, including errors.
uint32_t winter_cowork_vm_abi_version(void);
uint64_t winter_cowork_vm_submit(const char *request_json);
char *winter_cowork_vm_poll(void);
void winter_cowork_vm_string_free(char *value);
#endif
