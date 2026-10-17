/* Must NOT compile: a hook with one parameter. */
#include "CoworkAbi.h"
static void hook(void *user) { (void)user; }
CW_ASSERT_EXIT_HOOK_SIGNATURE(hook);
int use_hook(uint32_t ctx);
int use_hook(uint32_t ctx) { return (int)krun_cowork_set_exit_hook_v1(ctx, hook, 0); }
