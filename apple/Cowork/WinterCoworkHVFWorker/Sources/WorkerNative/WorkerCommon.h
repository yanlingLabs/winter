/* Shared constants of the production Cowork worker (N2 slice S3).
 *
 * SOURCE ONLY: nothing in this package has ever been run against a VM, and nothing here is wired into the daemon, the
 * launcher or the app. The wire contract is docs/cowork-native-worker.md and packages/core/src/cowork/native/protocol.ts
 * (N2 S1, PR #56); every number below that is a wire number is copied from there and pinned by the golden vectors.
 */
#ifndef WINTER_COWORK_WORKER_COMMON_H
#define WINTER_COWORK_WORKER_COMMON_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* How many descriptors one recvmsg control buffer can hold. A datagram carrying more is MSG_CTRUNC, which is fatal: on macOS
 * the kernel may already have installed descriptors nobody can see. The tests build with 256 (production) and 16. */
#ifndef CW_FD_CAPACITY
#define CW_FD_CAPACITY 256
#endif

/* Every refusal a parser raises. The names and order are the TypeScript contract's CoworkNativeProtocolFailure; the numeric
 * values are the C twin and are not on the wire. */
enum cw_error {
    CW_OK = 0,
    CW_E_MALFORMED = 1,
    CW_E_OVERSIZE = 2,
    CW_E_VERSION = 3,
    CW_E_UNKNOWN_TYPE = 4,
    CW_E_BAD_FIELD = 5,
    CW_E_BAD_DIRECTION = 6,
    CW_E_BAD_RIGHTS = 7,
    CW_E_RESERVED_CLASS = 8,
    CW_E_BAD_SEQUENCE = 9,
    /* Transport-level outcomes that no vector can express. */
    CW_E_EOF = 20,         /* the peer closed */
    CW_E_IO = 21,          /* a system call failed */
    CW_E_CTRUNC = 22       /* truncated ancillary data: fatal, exit 79 */
};
const char *cw_error_name(int code);

/* Inherited descriptors. The contract does not name them (reported to S1 and S2); the launcher must install exactly these.
 * 0, 1, 2 are the launcher's business and are never read. Everything else is closed at start. */
#define CW_FD_L2 3 /* unnamed AF_UNIX SOCK_DGRAM socketpair end: envelopes */
#define CW_FD_L3 4 /* unnamed AF_UNIX SOCK_STREAM socketpair end: bootstrap and runtime mux frames */

/* Process exit codes. libkrun uses 77 for its own fatal stops, so none of these collide with it. */
#define CW_EXIT_OK 0
#define CW_EXIT_USAGE 2
#define CW_EXIT_SANDBOX 70
#define CW_EXIT_BAD_SCOPE 71
#define CW_EXIT_BAD_VOLUMES 72
#define CW_EXIT_VM_FAILED 73
#define CW_EXIT_MUX_QUARANTINE 74
#define CW_EXIT_DRAIN_TIMEOUT 75
#define CW_EXIT_INTAKE_TIMEOUT 76
#define CW_EXIT_INTERNAL 78
/* A truncated or unexpected descriptor: terminal and silent. Process exit is descriptor cleanup, never a release. */
#define CW_EXIT_RIGHTS 79

/* Why a stop was requested (the DRAIN envelope's and the control frame's `origin`). */
enum { CW_ORIGIN_HOST_STOP = 1, CW_ORIGIN_OWNER_LOSS = 2 };

/* Limits copied from COWORK_NATIVE_LIMITS. */
#define CW_VCPUS 2u
#define CW_SCOPE_MIN_MEMORY_MIB 256u  /* what the S1 parser accepts; the production gate is narrower, see CoworkAbi.h */
#define CW_SCOPE_MAX_MEMORY_MIB 1024u
#define CW_DRAIN_BUDGET_CEILING_MS 120000u
#define CW_DRAIN_BUDGET_OWNER_LOSS_MS 30000u
#define CW_VOLUME_MODE 0600u
#define CW_VOLUME_MIN_BYTES (16ull * 1024 * 1024)
#define CW_VOLUME_MAX_BYTES (256ull * 1024 * 1024 * 1024)
#define CW_VOLUME_ALIGN 4096ull
#define CW_MAX_SAFE_INTEGER ((1ull << 53) - 1)

#endif
