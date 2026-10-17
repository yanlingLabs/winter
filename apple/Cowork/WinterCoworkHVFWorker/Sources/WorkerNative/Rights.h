/* Rights: collect the descriptors one recvmsg delivered, without trusting what the kernel wrote in the headers.
 *
 * Measured on macOS 26 (arm64), reproduced by the review of PR #58 with a socketpair probe: when the control buffer is too small the
 * kernel installs ALL of the descriptors in the process, writes only the ones that fit, sets MSG_CTRUNC, and leaves `cmsg_len` at the
 * SENDER's length (20 sent into a 16 slot buffer: cmsg_len 92 against a 76 byte buffer). A walk that trusts `cmsg_len` therefore
 * reads past the control buffer and close()s whatever it finds there. This collector bounds every header by the buffer
 * (`msg_control + msg_controllen`), never reads past it, and reports a header that claims more than the buffer holds as TRUNCATED.
 * The descriptors the kernel installed but could not show cannot be closed by anyone: that is why truncation is terminal.
 *
 * Used by both receivers (Envelope.c for L2, Mux.c for L3 and L4), and unit-tested on synthetic buffers.
 */
#ifndef WINTER_COWORK_WORKER_RIGHTS_H
#define WINTER_COWORK_WORKER_RIGHTS_H

#include "WorkerCommon.h"

#include <sys/socket.h>

typedef struct {
    size_t count;      /* descriptors stored in fds[0 .. count) */
    size_t closed;     /* descriptors beyond the capacity that were closed on the spot */
    bool malformed;    /* a header that is not a whole SCM_RIGHTS item (wrong level or type, short, not a multiple of an int, over capacity) */
    bool truncated;    /* a header claims more bytes than the control buffer holds */
} cw_rights_result;

/* Walk `message`'s control buffer once. At most `capacity` descriptors are stored; any further one is closed here (and counted). Never
 * reads outside [msg_control, msg_control + msg_controllen). `message->msg_flags` is NOT consulted: the caller checks MSG_CTRUNC
 * before it believes anything (and a truncated result is fatal either way). */
void cw_rights_collect(const struct msghdr *message, int *fds, size_t capacity, cw_rights_result *result);

#endif
