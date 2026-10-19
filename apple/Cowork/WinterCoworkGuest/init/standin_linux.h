/* The Linux effects of the stand-in lifecycle (STAND-IN IMAGE ONLY). Exposed so tests/test_standin_linux.c can run the real descriptor plumbing against a temporary tree. */
#ifndef WG_STANDIN_LINUX_H
#define WG_STANDIN_LINUX_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#include "standin.h"

struct wg_standin_paths {
    const char *standin_dir;     /* /run/winter/standin: items.json, <sid>/metadata.json (root only) */
    const char *control_dir;     /* /run/winter/control: the supervisor's per-conversation private directories */
    const char *python;
    const char *prepare;         /* the prepare script */
    const char *profile;         /* the closed stand-in profile */
    const char *worker;          /* the provider worker executable */
    const char *owner_library;   /* linux-session-owner.so: the worker's native accept / frame calls */
    const char *runtime_exe;     /* the runtime executable the locator matches */
    const char *runtime_comm;    /* its process name as the kernel truncates it (15 characters) */
    const char *proc_root;
    int drop_privileges;         /* 1 in the image; tests that are not root set 0 */
    uid_t worker_uid;            /* 65534 */
};
extern struct wg_standin_paths wg_standin_paths;

/* How many processes in `proc_root` have real, effective, saved and filesystem uid `uid` AND are the runtime (exe link equals `exe` or process name equals `comm`).
 * 1 with *pid set when exactly one; 0 when none; -1 when more than one or a /proc entry could not be read consistently. */
/* Test seam: called (when set) between opening the runtime's pidfd and re-checking that the process is still the runtime. NULL in the image; tests/standin_linux_tool.c sets it
 * to change the process entry at exactly that point, so the guard against a reused pid is exercised deterministically. */
extern void (*wg_standin_after_pidfd_open)(void);
int wg_standin_scan_proc(const char *proc_root, uint32_t uid, const char *exe, const char *comm, int *pid);
/* One message on a SOCK_SEQPACKET channel: the byte 'I' carrying exactly one SCM_RIGHTS descriptor. 0 = sent. */
int wg_standin_send_admission(int channel, int pidfd);
void wg_standin_linux_ops(struct wg_standin_ops *ops, int kmsg_fd);

#endif
