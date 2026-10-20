/* Must NOT compile: a hook that returns a value. */
#include "CoworkAbi.h"
static int hook(void *user, uint32_t reason) { (void)user; return (int)reason; }
CW_ASSERT_EXIT_HOOK_SIGNATURE(hook);
int use_hook(uint32_t ctx);
int use_hook(uint32_t ctx) { return (int)krun_cowork_set_exit_hook_v1(ctx, hook, 0); }
