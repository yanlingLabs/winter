/* Must NOT compile: the S1 contract's spelling of the hook (int32_t reason) is not the library's (uint32_t). The worker follows the header
 * it links; a hook declared the contract's way is refused by name and by the call. */
#include "CoworkAbi.h"
static void hook(void *user, int32_t reason) { (void)user; (void)reason; }
CW_ASSERT_EXIT_HOOK_SIGNATURE(hook);
int use_hook(uint32_t ctx);
int use_hook(uint32_t ctx) { return (int)krun_cowork_set_exit_hook_v1(ctx, hook, 0); }
