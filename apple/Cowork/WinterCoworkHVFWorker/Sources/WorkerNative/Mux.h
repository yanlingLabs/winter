/* Mux frames: L3 (launcher <-> worker, stream socketpair) and L4 (worker <-> guest, the libkrun generic virtio-console port)
 * (docs/cowork-native-worker.md section 6).
 *
 * 16 byte header: "WMX1", u8 version = 1, u8 class, u16 flags = 0, u32 seq, u32 payload length. `seq` starts at 1 and rises by
 * exactly 1 per (class, direction); a gap, a repeat or a rewind is a protocol violation and ends the stream.
 *
 *   control    JSON, at most 4 KiB     terminates at the worker. Parsed STRICTLY here (canonical text compare).
 *   bootstrap  JSON, at most 256 KiB   daemon <-> guest. Relayed BLIND: the worker checks the header and nothing else.
 *   runtime    opaque, at most 1 MiB   daemon <-> guest. Relayed blind.
 *   provider   RESERVED: refused at the header, in both directions.
 */
#ifndef WINTER_COWORK_WORKER_MUX_H
#define WINTER_COWORK_WORKER_MUX_H

#include "WorkerCommon.h"

#define CW_MUX_HEADER 16u
#define CW_MUX_CONTROL_MAX 4096u
#define CW_MUX_BOOTSTRAP_MAX 262144u
#define CW_MUX_RUNTIME_MAX 1048576u
#define CW_MUX_MAX_FRAME (CW_MUX_HEADER + CW_MUX_RUNTIME_MAX)

typedef enum { CW_CLASS_CONTROL = 0, CW_CLASS_BOOTSTRAP = 1, CW_CLASS_RUNTIME = 2, CW_CLASS_PROVIDER = 3 } cw_mux_class;
/* DOWN = host to guest, UP = guest to host. */
typedef enum { CW_MUX_DOWN = 0, CW_MUX_UP = 1 } cw_mux_dir;

typedef struct {
    cw_mux_class cls;
    uint32_t seq;
    uint32_t length;
} cw_mux_header;

/* Check a header. `available` must be at least 16 (the caller decides what a short read means). The order of the checks is
 * the TypeScript parser's. Returns CW_OK or a cw_error. */
int cw_mux_parse_header(const uint8_t *bytes, size_t available, cw_mux_header *out);

/* Build a frame. Refuses the provider class and any payload over its class ceiling. Returns the length, or 0. */
size_t cw_mux_encode(cw_mux_class cls, uint32_t seq, const uint8_t *payload, size_t length, uint8_t *out, size_t capacity);

/* ---- control messages ---------------------------------------------------------------------------------------------------
 *   down  drain {stopNonce, budgetMs, origin}   ping {n}
 *   up    drain_ack {stopNonce}   halting {stopNonce}   pong {n}   fault {code, stopNonce | null} */
typedef enum { CW_CTL_DRAIN = 1, CW_CTL_PING = 2, CW_CTL_DRAIN_ACK = 3, CW_CTL_HALTING = 4, CW_CTL_PONG = 5, CW_CTL_FAULT = 6 } cw_control_type;
/* Control-up `fault` codes (contract section 6): the guest says it is failing. */
typedef enum { CW_GUEST_FAULT_UNMOUNT_FAILED = 1, CW_GUEST_FAULT_SUPERVISOR_LOST = 2, CW_GUEST_FAULT_PROTOCOL_VIOLATION = 3, CW_GUEST_FAULT_INTERNAL = 4 } cw_guest_fault;
typedef struct {
    cw_control_type type;
    uint8_t nonce[16];  /* drain, drain_ack, halting */
    uint32_t budget_ms; /* drain */
    uint32_t origin;    /* drain: CW_ORIGIN_* */
    uint32_t n;         /* ping, pong */
    uint32_t fault_code; /* fault: CW_GUEST_FAULT_* */
    bool nonce_null;     /* fault: stopNonce was null (the nonce field is then zero) */
} cw_control;

/* Parse the JSON payload of a control frame for one direction. Keys must appear in the contract's order, with no whitespace,
 * no escapes and canonical integers; the tolerant forms are all malformed. */
int cw_control_parse(const uint8_t *payload, size_t length, cw_mux_dir direction, cw_control *out);
/* The canonical payload (no trailing newline). Returns the length, or 0 for an invalid value. */
size_t cw_control_encode(const cw_control *control, uint8_t *out, size_t capacity);

/* A whole frame as the worker judges it: header, exact length, and for the control class the strict payload. Bootstrap and
 * runtime payloads are NOT inspected: the worker is deliberately blind to them. `control` is filled for control frames only. */
int cw_mux_frame_check(const uint8_t *frame, size_t length, cw_mux_dir direction, cw_mux_header *header, cw_control *control);

/* ---- sequence ---------------------------------------------------------------------------------------------------------- */
typedef struct { uint32_t next[3][2]; } cw_mux_seq;
void cw_mux_seq_init(cw_mux_seq *seq);
/* CW_OK and advance, or CW_E_BAD_SEQUENCE (gap, repeat, rewind). The provider class is never accepted. */
int cw_mux_seq_accept(cw_mux_seq *seq, cw_mux_class cls, cw_mux_dir direction, uint32_t value);

/* ---- stream reader ------------------------------------------------------------------------------------------------------
 * Reads exactly one frame at a time and never past its end, so the reader owns no leftover bytes. The header is judged as
 * soon as its 16 bytes are in, so an oversized or reserved frame is refused before any payload is buffered. */
typedef struct {
    uint8_t buf[CW_MUX_MAX_FRAME];
    size_t have;
    size_t total; /* 0 until the header is complete */
    cw_mux_header header;
} cw_mux_reader;

#define CW_MR_FRAME 1 /* a whole frame is in buf[0 .. total) */
#define CW_MR_MORE 0  /* bytes were taken; the frame is not complete yet */
#define CW_MR_AGAIN 2 /* nothing to read right now (EAGAIN) */

void cw_mux_reader_reset(cw_mux_reader *reader);
/* Memory interface (tests, and the socket pump below): where the next bytes go, and how many the reader will take. */
size_t cw_mux_reader_space(cw_mux_reader *reader, uint8_t **where);
/* Returns CW_MR_FRAME, CW_MR_MORE, or -(cw_error) when the header is refused (the stream is then dead). */
int cw_mux_reader_commit(cw_mux_reader *reader, size_t added);
int cw_mux_reader_feed(cw_mux_reader *reader, const uint8_t *data, size_t length, size_t *consumed);
/* One recvmsg with a control buffer. Returns CW_MR_FRAME, CW_MR_MORE, CW_MR_AGAIN, or -(cw_error): -CW_E_EOF when the peer closed,
 * -CW_E_BAD_RIGHTS when a descriptor arrived (closed here), -CW_E_CTRUNC (fatal, exit 79), -CW_E_IO, or a header refusal. */
int cw_mux_reader_pump(cw_mux_reader *reader, int fd);

#endif
