/* L2 envelopes: launcher <-> worker, one datagram each (docs/cowork-native-worker.md section 5).
 *
 * 16 byte header: "WEV1", u8 version = 1, u8 kind, u16 flags = 0, u32 seq (from 1, +1 per direction), u32 payload length.
 * All integers are little-endian and every reserved byte is zero. A parse is never an authentication.
 */
#ifndef WINTER_COWORK_WORKER_ENVELOPE_H
#define WINTER_COWORK_WORKER_ENVELOPE_H

#include "WorkerCommon.h"

#include <pthread.h>

#define CW_ENV_HEADER 16u
#define CW_ENV_SCOPE_BYTES 512u
#define CW_ENV_VOLUMES_BYTES 104u
#define CW_ENV_DRAIN_BYTES 28u
#define CW_ENV_STATUS_BYTES 40u
#define CW_ENV_FAULT_BYTES 8u
#define CW_ENV_MAX_BYTES (CW_ENV_HEADER + CW_ENV_SCOPE_BYTES)
#define CW_ENV_NAME_FIELD 64u

typedef enum { CW_ENV_SCOPE = 1, CW_ENV_VOLUMES = 2, CW_ENV_DRAIN = 3, CW_ENV_STATUS = 4, CW_ENV_FAULT = 5 } cw_env_kind;
typedef enum { CW_ENV_TO_WORKER = 0, CW_ENV_TO_LAUNCHER = 1 } cw_env_direction;

/* STATUS states (wire values). Informational for the launcher; never release evidence. */
enum {
    CW_STATUS_SANDBOXED = 1, CW_STATUS_VOLUMES_ACCEPTED = 2, CW_STATUS_VM_RUNNING = 3, CW_STATUS_GUEST_HELLO = 4,
    CW_STATUS_DRAINING = 5, CW_STATUS_DRAIN_ACKED = 6, CW_STATUS_GUEST_HALTED = 7, CW_STATUS_EXITING = 8
};
/* FAULT codes (wire values). TRUNCATED_RIGHTS has no sender: the contract says a truncated control buffer exits at once
 * without acknowledging, so the worker leaves it unsaid and exits 79. */
enum {
    CW_FAULT_BAD_SCOPE = 1, CW_FAULT_BAD_VOLUMES = 2, CW_FAULT_SANDBOX_FAILED = 3, CW_FAULT_VM_FAILED = 4,
    CW_FAULT_MUX_VIOLATION = 5, CW_FAULT_TRUNCATED_RIGHTS = 6, CW_FAULT_INTERNAL = 7
};

typedef struct {
    char workspace_id[CW_ENV_NAME_FIELD];
    char incarnation_id[CW_ENV_NAME_FIELD];
    char controller_instance_id[CW_ENV_NAME_FIELD];
    char worker_instance_id[CW_ENV_NAME_FIELD];
    char admission_id[CW_ENV_NAME_FIELD];
    uint8_t runtime_image_digest[32];
    uint64_t lease_epoch;
    uint32_t vcpus;
    uint32_t memory_mib;
    /* SHA-256 of the 512 byte payload exactly as received: how VOLUMES names the scope it belongs to. */
    uint8_t digest[32];
} cw_scope;

/* The same four fields and order as struct krun_cowork_volume_identity (32 bytes); CoworkAbi.h asserts the layout. */
typedef struct {
    uint64_t device;
    uint64_t inode;
    uint64_t capacity_bytes;
    uint32_t uid;
    uint32_t mode;
} cw_volume_identity;

typedef struct {
    uint8_t scope_digest[32];
    cw_volume_identity data;
    cw_volume_identity environment;
} cw_volumes;

typedef struct {
    uint8_t stop_nonce[16];
    uint32_t budget_ms;
    uint32_t origin; /* CW_ORIGIN_* */
} cw_drain;

typedef struct {
    uint32_t state; /* CW_STATUS_* */
    uint64_t requested[2]; /* data, environment */
    uint64_t completed[2];
} cw_status;

typedef struct {
    cw_env_kind kind;
    uint32_t seq;
    union { cw_scope scope; cw_volumes volumes; cw_drain drain; cw_status status; uint32_t fault; } u;
} cw_envelope;

/* Parse one whole datagram. `rights` is how many descriptors arrived WITH it. Returns CW_OK or a cw_error. The order of the
 * checks is the TypeScript parser's, so every golden negative vector gets its own code. The result re-encodes to the input
 * byte for byte (checked) or the datagram is malformed. */
int cw_env_parse(const uint8_t *bytes, size_t length, size_t rights, cw_env_direction direction, cw_envelope *out);

/* Encode, validating the same domain the parser enforces. Returns the datagram length, or 0 when the value is invalid. */
size_t cw_env_encode(const cw_envelope *envelope, uint8_t *out, size_t capacity);

/* SHA-256 of a 512 byte SCOPE payload. */
void cw_scope_payload_digest(const uint8_t payload[CW_ENV_SCOPE_BYTES], uint8_t out[32]);

/* True when `text` is an identifier token: [A-Za-z0-9][A-Za-z0-9_-]{0,62}. */
bool cw_valid_token(const char *text);

/* ---- receiving -------------------------------------------------------------------------------------------------------
 * HARD RULE (verified on macOS by S1): a plain read() or recv() on an AF_UNIX socket silently installs any SCM_RIGHTS
 * descriptors the peer attached. Every reader of L2 and L3 therefore uses recvmsg with a control buffer, closes every
 * descriptor it did not ask for, and treats MSG_CTRUNC as fatal. */
typedef struct {
    uint8_t bytes[CW_ENV_MAX_BYTES + 8];
    size_t length;
    int fds[CW_FD_CAPACITY];
    size_t fd_count;
} cw_inbound;

enum { CW_RECV_OK = 0, CW_RECV_REFUSED = -1, CW_RECV_CTRUNC = -2, CW_RECV_TIMEOUT = -3, CW_RECV_GONE = -4, CW_RECV_AGAIN = -5 };

/* Receive one datagram. `timeout_ms` < 0 does not wait (MSG_DONTWAIT only), 0 or more polls first.
 *   CW_RECV_OK       length bytes in `in->bytes`; `in->fds` holds the descriptors that came with it, all CLOEXEC and >= 3.
 *   CW_RECV_REFUSED  a malformed control message or an oversized datagram; every descriptor was closed.
 *   CW_RECV_CTRUNC   the control buffer was truncated; every visible descriptor was closed; the caller MUST _exit(79).
 *   CW_RECV_GONE     the peer closed (ECONNRESET is one-shot on macOS datagram pairs; the caller must latch it).
 * The caller owns in->fds on CW_RECV_OK. */
int cw_env_recv(int channel, cw_inbound *in, int timeout_ms);
void cw_inbound_close_fds(cw_inbound *in);

/* ---- sending ---------------------------------------------------------------------------------------------------------
 * One owner of the outbound sequence counter, shared by the relay thread and the VMM exit hook. */
typedef struct {
    int fd;
    pthread_mutex_t lock;
    uint32_t seq;
    bool gone;
} cw_l2_out;

void cw_l2_out_init(cw_l2_out *out, int fd);
int cw_l2_send_status(cw_l2_out *out, uint32_t state, const uint64_t requested[2], const uint64_t completed[2]);
int cw_l2_send_fault(cw_l2_out *out, uint32_t code);

#endif
