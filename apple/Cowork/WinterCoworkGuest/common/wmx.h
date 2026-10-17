/*
 * WMX1 mux framing, guest end (N2 slice S5).
 *
 * This is a copy of the S1 wire contract (docs/cowork-native-worker.md section 6 and protocol.ts on
 * cowork/n2-host-adapter), never the other way round. The golden vectors in ../vectors/mux-frames.json are the
 * oracle; tests/test_wmx_vectors.py feeds every one of them through this code.
 *
 * Frame: 16 byte little-endian header, then the payload.
 *    0 4 magic "WMX1"   4 1 version = 1   5 1 class   6 2 flags = 0   8 4 seq   12 4 payload length
 * `seq` starts at 1 and rises by exactly 1 per (class, direction). Class 3 (provider) is RESERVED and refused at the
 * header in both directions. The guest parses control frames only; bootstrap payloads are handed on byte for byte to
 * the bootstrap helper, and runtime payloads are opaque bytes.
 *
 * Portable C11: no Linux header, so the native macOS unit tests compile it as is.
 */
#ifndef WG_WMX_H
#define WG_WMX_H

#include <stddef.h>
#include <stdint.h>

#define WMX_HEADER_BYTES 16u
#define WMX_VERSION 1u

enum wmx_class {
    WMX_CLASS_CONTROL = 0,
    WMX_CLASS_BOOTSTRAP = 1,
    WMX_CLASS_RUNTIME = 2,
    WMX_CLASS_PROVIDER = 3, /* RESERVED: recognised only so it can be refused */
    WMX_CLASS_COUNT = 4
};

#define WMX_MAX_CONTROL 4096u
#define WMX_MAX_BOOTSTRAP 262144u
#define WMX_MAX_RUNTIME 1048576u
/* Stricter than the contract's class ceiling: the relay refuses a bootstrap payload above this (a real plan is ~1.7 KiB and the
 * helper itself caps a plan at 16 KiB). Documented as a guest-local delta in docs/research/2026-10-17-cowork-n2-guest-boot.md. */
#define WMX_GUEST_MAX_BOOTSTRAP_DOWN 20480u

/* Same vocabulary as protocol.ts COWORK_NATIVE_PROTOCOL_FAILURES (the ones a guest can raise). */
enum wmx_status {
    WMX_OK = 0,
    WMX_MALFORMED,
    WMX_OVERSIZE,
    WMX_VERSION_ERR,
    WMX_UNKNOWN_TYPE,
    WMX_BAD_FIELD,
    WMX_RESERVED_CLASS,
    WMX_BAD_SEQUENCE,
    WMX_STATUS_COUNT
};
const char *wmx_status_name(enum wmx_status status);

/* The payload ceiling of a recognised class (0 for provider). */
size_t wmx_class_limit(unsigned class_value);

struct wmx_header {
    unsigned class_value;
    uint32_t seq;
    uint32_t length;
};

/* Validates exactly the header: magic, version, class, flags, provider refusal, seq >= 1, class ceiling. The order is the
 * order of protocol.ts parseCoworkNativeMuxFrame, so a header with several faults reports the same one on both sides. */
enum wmx_status wmx_parse_header(const uint8_t *bytes, size_t length, struct wmx_header *out);
/* A whole frame: header plus exactly `length` payload bytes (anything shorter or longer is malformed). */
enum wmx_status wmx_parse_frame(const uint8_t *bytes, size_t length, struct wmx_header *out, const uint8_t **payload);

/* Writes the 16 byte header. Returns 0, or -1 for a class that may not be sent (provider, unknown), seq 0 or an oversize length. */
int wmx_write_header(uint8_t out[WMX_HEADER_BYTES], unsigned class_value, uint32_t seq, uint32_t length);
/* Header plus payload in one buffer; returns the frame size or 0 when it does not fit or is not allowed. */
size_t wmx_build_frame(uint8_t *out, size_t capacity, unsigned class_value, uint32_t seq, const uint8_t *payload, size_t length);

/* One direction's sequence tracker (a link end keeps one per direction). A gap, a repeat or a rewind is WMX_BAD_SEQUENCE and
 * leaves the tracker unchanged; 0xffffffff is the last usable number, after which every frame is refused. */
struct wmx_seq {
    uint32_t next[WMX_CLASS_COUNT];
    int exhausted[WMX_CLASS_COUNT];
};
void wmx_seq_init(struct wmx_seq *seq);
enum wmx_status wmx_seq_accept(struct wmx_seq *seq, unsigned class_value, uint32_t value);
/* The number to put on the next outgoing frame of the class, then advance. Returns 0 when exhausted. */
uint32_t wmx_seq_take(struct wmx_seq *seq, unsigned class_value);

/* ---- control payloads (JSON without a trailing newline, exact canonical spelling, ASCII only) ---- */

enum wmx_direction { WMX_DOWN = 0, WMX_UP = 1 }; /* down = host to guest */

enum wmx_control_type {
    WMX_CONTROL_NONE = 0,
    WMX_CONTROL_DRAIN,     /* down */
    WMX_CONTROL_PING,      /* down */
    WMX_CONTROL_DRAIN_ACK, /* up */
    WMX_CONTROL_HALTING,   /* up */
    WMX_CONTROL_PONG       /* up */
};
#define WMX_NONCE_CHARS 32u
#define WMX_DRAIN_BUDGET_CEILING_MS 120000u
enum wmx_drain_origin { WMX_ORIGIN_HOST_STOP = 0, WMX_ORIGIN_OWNER_LOSS = 1 };

struct wmx_control {
    enum wmx_control_type type;
    char stop_nonce[WMX_NONCE_CHARS + 1]; /* drain, drain_ack, halting: 32 lowercase hex */
    uint32_t budget_ms;                    /* drain */
    enum wmx_drain_origin origin;          /* drain */
    uint32_t n;                            /* ping, pong */
};

/* The exact canonical text only. The status mirrors protocol.ts: unknown type -> UNKNOWN_TYPE, a wrong key set or a bad value
 * -> BAD_FIELD, any other deviation from the one canonical spelling (whitespace, order, duplicates, float spellings) ->
 * MALFORMED. Direction matters: a drain travelling up is UNKNOWN_TYPE. */
enum wmx_status wmx_parse_control(const uint8_t *payload, size_t length, enum wmx_direction direction, struct wmx_control *out);
/* Canonical text for the guest's own messages; returns the length or 0 when it does not fit / the fields are invalid. */
size_t wmx_encode_control(const struct wmx_control *message, uint8_t *out, size_t capacity);

int wmx_is_nonce(const char *text); /* exactly 32 chars of [a-f0-9] */

/* ---- incremental frame assembler for a byte stream (the virtio port) ---- */

struct wmx_rx {
    uint8_t header[WMX_HEADER_BYTES];
    size_t have;          /* bytes of the current header or payload collected so far */
    int in_payload;
    struct wmx_header current;
    uint8_t *payload;     /* caller-provided buffer of at least `capacity` bytes */
    size_t capacity;
    size_t limit[WMX_CLASS_COUNT]; /* per-class payload ceiling, never above the contract ceiling or `capacity` */
};
void wmx_rx_init(struct wmx_rx *rx, uint8_t *payload_buffer, size_t capacity);
enum wmx_rx_event { WMX_RX_NEED_MORE = 0, WMX_RX_FRAME = 1, WMX_RX_ERROR = 2 };
/* Consumes bytes from `data` (advancing *consumed). WMX_RX_FRAME: rx->current and rx->payload are valid until the next call.
 * WMX_RX_ERROR: *status says why and the stream is no longer usable. At most one frame is returned per call. */
enum wmx_rx_event wmx_rx_feed(struct wmx_rx *rx, const uint8_t *data, size_t length, size_t *consumed, enum wmx_status *status);

#endif
