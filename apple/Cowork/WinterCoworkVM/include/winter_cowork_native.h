#ifndef WINTER_COWORK_NATIVE_H
#define WINTER_COWORK_NATIVE_H
#include <stdint.h>
uint32_t winter_cowork_native_protocol_version(void);
void *winter_cowork_native_create(const char *json, uint32_t length);
uint64_t winter_cowork_native_submit(void *controller, const char *json, uint32_t length);
int32_t winter_cowork_native_event_fd(void *controller);
char *winter_cowork_native_poll(void *controller);
void winter_cowork_native_string_free(char *value);
uint64_t winter_cowork_native_shutdown(void *controller, uint32_t budget_ms);
// Release succeeds only after confirmed terminal ownership and all events drain.
// Zero retains the controller; never unload the library while it is retained.
int32_t winter_cowork_native_release(void *controller);
int32_t winter_cowork_native_can_release(void *controller);
#endif
