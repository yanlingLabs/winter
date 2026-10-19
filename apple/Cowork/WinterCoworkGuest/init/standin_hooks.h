/*
 * The seven places init_linux.c calls into the stand-in lifecycle. In the production `init` WG_STANDIN is not defined, every hook is `((void)0)`, and the compiler emits
 * nothing for them: the production binary does not contain the stand-in code, its strings or its calls. Only the separate `init-standin` build (build.py --profile standin,
 * which adds -DWG_STANDIN=1 and init/standin.c + init/standin_linux.c) has them. There is NO runtime switch: no file, setting or environment value turns a hook on.
 */
#ifndef WG_STANDIN_HOOKS_H
#define WG_STANDIN_HOOKS_H

#ifdef WG_STANDIN
#include "standin.h"
void wg_standin_hook_init(int kmsg_fd);
void wg_standin_hook_note_set(const struct wg_conversation_set *set);
void wg_standin_hook_ready(void);
int wg_standin_hook_timeout(int timeout);
void wg_standin_hook_tick(void);
void wg_standin_hook_child(long pid);
void wg_standin_hook_stop(void);
#define WG_STANDIN_INIT(kmsg) wg_standin_hook_init(kmsg)
#define WG_STANDIN_NOTE_SET(set) wg_standin_hook_note_set(set)
#define WG_STANDIN_READY() wg_standin_hook_ready()
#define WG_STANDIN_TIMEOUT(timeout) ((timeout) = wg_standin_hook_timeout(timeout))
#define WG_STANDIN_TICK() wg_standin_hook_tick()
#define WG_STANDIN_CHILD(pid) wg_standin_hook_child((long)(pid))
#define WG_STANDIN_STOP() wg_standin_hook_stop()
#else
#define WG_STANDIN_INIT(kmsg) ((void)0)
#define WG_STANDIN_NOTE_SET(set) ((void)0)
#define WG_STANDIN_READY() ((void)0)
#define WG_STANDIN_TIMEOUT(timeout) ((void)0)
#define WG_STANDIN_TICK() ((void)0)
#define WG_STANDIN_CHILD(pid) ((void)0)
#define WG_STANDIN_STOP() ((void)0)
#endif

#endif
