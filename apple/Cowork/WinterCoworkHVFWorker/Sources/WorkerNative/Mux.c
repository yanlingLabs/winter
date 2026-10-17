#include "Mux.h"

#include "Envelope.h"
#include "Rights.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

static uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void wr32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static size_t class_limit(cw_mux_class cls) {
    switch (cls) {
    case CW_CLASS_CONTROL: return CW_MUX_CONTROL_MAX;
    case CW_CLASS_BOOTSTRAP: return CW_MUX_BOOTSTRAP_MAX;
    case CW_CLASS_RUNTIME: return CW_MUX_RUNTIME_MAX;
    case CW_CLASS_PROVIDER: return 0;
    }
    return 0;
}

int cw_mux_parse_header(const uint8_t *bytes, size_t available, cw_mux_header *out) {
    memset(out, 0, sizeof *out);
    if (available < CW_MUX_HEADER) return CW_E_MALFORMED;
    if (memcmp(bytes, "WMX1", 4) != 0) return CW_E_MALFORMED;
    if (bytes[4] != 1) return CW_E_VERSION;
    uint8_t class_byte = bytes[5];
    uint16_t flags = (uint16_t)(bytes[6] | (bytes[7] << 8));
    if (class_byte > CW_CLASS_PROVIDER || flags != 0) return CW_E_MALFORMED;
    if (class_byte == CW_CLASS_PROVIDER) return CW_E_RESERVED_CLASS;
    uint32_t seq = rd32(bytes + 8), length = rd32(bytes + 12);
    if (seq < 1) return CW_E_BAD_SEQUENCE;
    if (length > class_limit((cw_mux_class)class_byte)) return CW_E_OVERSIZE;
    out->cls = (cw_mux_class)class_byte;
    out->seq = seq;
    out->length = length;
    return CW_OK;
}

size_t cw_mux_encode(cw_mux_class cls, uint32_t seq, const uint8_t *payload, size_t length, uint8_t *out, size_t capacity) {
    if (cls == CW_CLASS_PROVIDER || (unsigned)cls > CW_CLASS_PROVIDER || seq < 1) return 0;
    if (length > class_limit(cls) || capacity < CW_MUX_HEADER + length) return 0;
    memcpy(out, "WMX1", 4);
    out[4] = 1;
    out[5] = (uint8_t)cls;
    out[6] = 0;
    out[7] = 0;
    wr32(out + 8, seq);
    wr32(out + 12, (uint32_t)length);
    if (length > 0) memcpy(out + CW_MUX_HEADER, payload, length);
    return CW_MUX_HEADER + length;
}

/* ---- control JSON ------------------------------------------------------------------------------------------------------
 * A fixed-grammar parser, not a general one: the contract's rule is "parse, re-serialize, compare byte for byte", and for a
 * message this small the grammar IS the canonical text. Anything that departs from it is malformed, except a well-formed
 * unknown type (unknown_type) and a well-formed missing or extra key or out-of-domain value (bad_field), so the golden
 * negative vectors get the same code the TypeScript parser gives them. */

typedef struct { const uint8_t *p; size_t n; size_t i; } cursor;

static bool take(cursor *c, const char *literal) {
    size_t length = strlen(literal);
    if (c->n - c->i < length || memcmp(c->p + c->i, literal, length) != 0) return false;
    c->i += length;
    return true;
}
static bool peek_is(const cursor *c, char ch) { return c->i < c->n && c->p[c->i] == (uint8_t)ch; }

/* `,"key":` ; a missing key (the object closes where a key was due) is bad_field, any other departure is malformed. */
static int take_key(cursor *c, const char *key) {
    char literal[48];
    int made = snprintf(literal, sizeof literal, ",\"%s\":", key);
    if (made <= 0 || (size_t)made >= sizeof literal) return CW_E_MALFORMED;
    if (take(c, literal)) return CW_OK;
    return peek_is(c, '}') ? CW_E_BAD_FIELD : CW_E_MALFORMED;
}

/* A canonical unsigned integer that ends at ',' or '}'. */
static int take_uint(cursor *c, uint64_t max, uint32_t *out) {
    size_t start = c->i;
    uint64_t value = 0;
    while (c->i < c->n && c->p[c->i] >= '0' && c->p[c->i] <= '9') {
        if (c->i - start >= 20) return CW_E_MALFORMED;
        value = value * 10 + (uint64_t)(c->p[c->i] - '0');
        c->i++;
    }
    size_t digits = c->i - start;
    if (digits == 0) return CW_E_MALFORMED;
    if (c->p[start] == '0' && digits > 1) return CW_E_MALFORMED; /* leading zero */
    if (!(peek_is(c, ',') || peek_is(c, '}'))) return CW_E_MALFORMED; /* 7.0, 7e3, -, space ... */
    if (digits > 10 || value > max) return CW_E_BAD_FIELD;
    *out = (uint32_t)value;
    return CW_OK;
}

/* A quoted string without escapes or control bytes, returned without its quotes. */
static int take_string(cursor *c, const uint8_t **text, size_t *length) {
    if (!take(c, "\"")) return CW_E_MALFORMED;
    size_t start = c->i;
    while (c->i < c->n && c->p[c->i] != '"') {
        uint8_t b = c->p[c->i];
        if (b < 0x20 || b == '\\' || b >= 0x7f) return CW_E_MALFORMED;
        if (c->i - start > 64) return CW_E_MALFORMED;
        c->i++;
    }
    if (c->i >= c->n) return CW_E_MALFORMED;
    *text = c->p + start;
    *length = c->i - start;
    c->i++; /* closing quote */
    return CW_OK;
}

static int hex_nibble(uint8_t b) {
    if (b >= '0' && b <= '9') return b - '0';
    if (b >= 'a' && b <= 'f') return b - 'a' + 10;
    return -1;
}
static int take_nonce(cursor *c, uint8_t out[16]) {
    const uint8_t *text;
    size_t length;
    int rc = take_string(c, &text, &length);
    if (rc != CW_OK) return rc;
    if (length != 32) return CW_E_BAD_FIELD;
    for (size_t i = 0; i < 16; i++) {
        int hi = hex_nibble(text[2 * i]), lo = hex_nibble(text[2 * i + 1]);
        if (hi < 0 || lo < 0) return CW_E_BAD_FIELD;
        out[i] = (uint8_t)(hi << 4 | lo);
    }
    return CW_OK;
}
/* `null`, or a nonce. */
static int take_nullable_nonce(cursor *c, uint8_t out[16], bool *is_null) {
    *is_null = false;
    if (take(c, "null")) { *is_null = true; return CW_OK; }
    return take_nonce(c, out);
}
static const char *const guest_fault_names[] = { NULL, "unmount_failed", "supervisor_lost", "protocol_violation", "internal" };
static int take_guest_fault(cursor *c, uint32_t *out) {
    const uint8_t *text;
    size_t length;
    int rc = take_string(c, &text, &length);
    if (rc != CW_OK) return rc;
    for (uint32_t code = 1; code <= 4; code++)
        if (strlen(guest_fault_names[code]) == length && memcmp(guest_fault_names[code], text, length) == 0) { *out = code; return CW_OK; }
    return CW_E_BAD_FIELD;
}
static int take_origin(cursor *c, uint32_t *out) {
    const uint8_t *text;
    size_t length;
    int rc = take_string(c, &text, &length);
    if (rc != CW_OK) return rc;
    if (length == 9 && memcmp(text, "host-stop", 9) == 0) { *out = CW_ORIGIN_HOST_STOP; return CW_OK; }
    if (length == 10 && memcmp(text, "owner-loss", 10) == 0) { *out = CW_ORIGIN_OWNER_LOSS; return CW_OK; }
    return CW_E_BAD_FIELD;
}

/* The object must close here and the payload end with it. A further well-formed key is bad_field unless it repeats a key the
 * message already has (a duplicate: malformed). */
static int take_end(cursor *c, const char *const *known) {
    if (peek_is(c, '}')) { c->i++; return c->i == c->n ? CW_OK : CW_E_MALFORMED; }
    if (!(peek_is(c, ',') && c->i + 1 < c->n && c->p[c->i + 1] == '"')) return CW_E_MALFORMED;
    size_t start = c->i + 2, end = start;
    while (end < c->n && c->p[end] != '"') {
        uint8_t b = c->p[end];
        if (!((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_') || end - start > 32) return CW_E_MALFORMED;
        end++;
    }
    if (end >= c->n || end + 1 >= c->n || c->p[end + 1] != ':') return CW_E_MALFORMED;
    for (; *known != NULL; known++) if (strlen(*known) == end - start && memcmp(*known, c->p + start, end - start) == 0) return CW_E_MALFORMED;
    return CW_E_BAD_FIELD;
}

int cw_control_parse(const uint8_t *payload, size_t length, cw_mux_dir direction, cw_control *out) {
    memset(out, 0, sizeof *out);
    if (length > CW_MUX_CONTROL_MAX) return CW_E_OVERSIZE;
    cursor c = { payload, length, 0 };
    if (!take(&c, "{\"v\":1,\"t\":\"")) return CW_E_MALFORMED;
    size_t start = c.i;
    while (c.i < c.n && c.p[c.i] != '"') {
        uint8_t b = c.p[c.i];
        if (!((b >= 'a' && b <= 'z') || b == '_') || c.i - start > 16) return CW_E_MALFORMED;
        c.i++;
    }
    if (c.i >= c.n || c.i == start) return CW_E_MALFORMED;
    size_t type_length = c.i - start;
    const uint8_t *type = c.p + start;
    c.i++; /* closing quote */
#define IS_TYPE(name) (type_length == strlen(name) && memcmp(type, name, type_length) == 0)
    int rc;
    if (direction == CW_MUX_DOWN && IS_TYPE("drain")) {
        static const char *const known[] = { "v", "t", "stopNonce", "budgetMs", "origin", NULL };
        out->type = CW_CTL_DRAIN;
        if ((rc = take_key(&c, "stopNonce")) != CW_OK || (rc = take_nonce(&c, out->nonce)) != CW_OK) return rc;
        if ((rc = take_key(&c, "budgetMs")) != CW_OK || (rc = take_uint(&c, CW_DRAIN_BUDGET_CEILING_MS, &out->budget_ms)) != CW_OK) return rc;
        if ((rc = take_key(&c, "origin")) != CW_OK || (rc = take_origin(&c, &out->origin)) != CW_OK) return rc;
        rc = take_end(&c, known);
    } else if (direction == CW_MUX_DOWN && IS_TYPE("ping")) {
        static const char *const known[] = { "v", "t", "n", NULL };
        out->type = CW_CTL_PING;
        if ((rc = take_key(&c, "n")) != CW_OK || (rc = take_uint(&c, 0xffffffffull, &out->n)) != CW_OK) return rc;
        rc = take_end(&c, known);
    } else if (direction == CW_MUX_UP && (IS_TYPE("drain_ack") || IS_TYPE("halting"))) {
        static const char *const known[] = { "v", "t", "stopNonce", NULL };
        out->type = IS_TYPE("drain_ack") ? CW_CTL_DRAIN_ACK : CW_CTL_HALTING;
        if ((rc = take_key(&c, "stopNonce")) != CW_OK || (rc = take_nonce(&c, out->nonce)) != CW_OK) return rc;
        rc = take_end(&c, known);
    } else if (direction == CW_MUX_UP && IS_TYPE("pong")) {
        static const char *const known[] = { "v", "t", "n", NULL };
        out->type = CW_CTL_PONG;
        if ((rc = take_key(&c, "n")) != CW_OK || (rc = take_uint(&c, 0xffffffffull, &out->n)) != CW_OK) return rc;
        rc = take_end(&c, known);
    } else if (direction == CW_MUX_UP && IS_TYPE("fault")) {
        static const char *const known[] = { "v", "t", "code", "stopNonce", NULL };
        out->type = CW_CTL_FAULT;
        if ((rc = take_key(&c, "code")) != CW_OK || (rc = take_guest_fault(&c, &out->fault_code)) != CW_OK) return rc;
        if ((rc = take_key(&c, "stopNonce")) != CW_OK || (rc = take_nullable_nonce(&c, out->nonce, &out->nonce_null)) != CW_OK) return rc;
        rc = take_end(&c, known);
    } else {
        /* A well-formed type this direction does not carry (drain travelling up, explode) is unknown_type. The text after it
         * is not looked at: an unknown type has no schema. */
        return CW_E_UNKNOWN_TYPE;
    }
#undef IS_TYPE
    if (rc != CW_OK) { memset(out, 0, sizeof *out); return rc; }
    /* The contract's rule: re-serialize and compare. The grammar above already is the canonical text, so this is the second,
     * independent check that nothing slipped through. */
    uint8_t again[CW_MUX_CONTROL_MAX];
    size_t again_length = cw_control_encode(out, again, sizeof again);
    if (again_length != length || memcmp(again, payload, length) != 0) { memset(out, 0, sizeof *out); return CW_E_MALFORMED; }
    return CW_OK;
}

static void hex16(const uint8_t nonce[16], char out[33]) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < 16; i++) { out[2 * i] = digits[nonce[i] >> 4]; out[2 * i + 1] = digits[nonce[i] & 15]; }
    out[32] = 0;
}

size_t cw_control_encode(const cw_control *control, uint8_t *out, size_t capacity) {
    char hex[33];
    hex16(control->nonce, hex);
    int made = 0;
    switch (control->type) {
    case CW_CTL_DRAIN:
        if ((control->origin != CW_ORIGIN_HOST_STOP && control->origin != CW_ORIGIN_OWNER_LOSS) || control->budget_ms > CW_DRAIN_BUDGET_CEILING_MS) return 0;
        made = snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":%u,\"origin\":\"%s\"}", hex,
                        (unsigned)control->budget_ms, control->origin == CW_ORIGIN_HOST_STOP ? "host-stop" : "owner-loss");
        break;
    case CW_CTL_PING: made = snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"ping\",\"n\":%u}", (unsigned)control->n); break;
    case CW_CTL_PONG: made = snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"pong\",\"n\":%u}", (unsigned)control->n); break;
    case CW_CTL_DRAIN_ACK: made = snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"%s\"}", hex); break;
    case CW_CTL_HALTING: made = snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"halting\",\"stopNonce\":\"%s\"}", hex); break;
    case CW_CTL_FAULT:
        if (control->fault_code < 1 || control->fault_code > 4) return 0;
        made = control->nonce_null
            ? snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":null}", guest_fault_names[control->fault_code])
            : snprintf((char *)out, capacity, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":\"%s\"}", guest_fault_names[control->fault_code], hex);
        break;
    default: return 0;
    }
    if (made <= 0 || (size_t)made >= capacity) return 0;
    return (size_t)made;
}

int cw_mux_frame_check(const uint8_t *frame, size_t length, cw_mux_dir direction, cw_mux_header *header, cw_control *control) {
    cw_mux_header local;
    if (header == NULL) header = &local;
    int rc = cw_mux_parse_header(frame, length, header);
    if (rc != CW_OK) return rc;
    if (length != CW_MUX_HEADER + (size_t)header->length) return CW_E_MALFORMED;
    if (header->cls == CW_CLASS_CONTROL) {
        cw_control scratch;
        return cw_control_parse(frame + CW_MUX_HEADER, header->length, direction, control != NULL ? control : &scratch);
    }
    return CW_OK; /* bootstrap and runtime: blind by design */
}

/* ---- sequence ---------------------------------------------------------------------------------------------------------- */

void cw_mux_seq_init(cw_mux_seq *seq) {
    for (int cls = 0; cls < 3; cls++) for (int dir = 0; dir < 2; dir++) seq->next[cls][dir] = 1;
}

int cw_mux_seq_accept(cw_mux_seq *seq, cw_mux_class cls, cw_mux_dir direction, uint32_t value) {
    if ((unsigned)cls > CW_CLASS_RUNTIME || (unsigned)direction > CW_MUX_UP) return CW_E_BAD_SEQUENCE;
    uint32_t *expected = &seq->next[cls][direction];
    if (*expected == 0 || value != *expected) return CW_E_BAD_SEQUENCE; /* 0: the counter wrapped, the stream is over */
    *expected = value + 1; /* wraps to 0 after 0xffffffff, which refuses everything after it */
    return CW_OK;
}

/* ---- stream reader ----------------------------------------------------------------------------------------------------- */

void cw_mux_reader_reset(cw_mux_reader *reader) {
    reader->have = 0;
    reader->total = 0;
    memset(&reader->header, 0, sizeof reader->header);
}

size_t cw_mux_reader_space(cw_mux_reader *reader, uint8_t **where) {
    size_t goal = reader->total != 0 ? reader->total : CW_MUX_HEADER;
    if (where != NULL) *where = reader->buf + reader->have;
    return goal > reader->have ? goal - reader->have : 0;
}

int cw_mux_reader_commit(cw_mux_reader *reader, size_t added) {
    reader->have += added;
    if (reader->total == 0 && reader->have >= CW_MUX_HEADER) {
        int rc = cw_mux_parse_header(reader->buf, reader->have, &reader->header);
        if (rc != CW_OK) return -rc;
        reader->total = CW_MUX_HEADER + (size_t)reader->header.length;
    }
    return (reader->total != 0 && reader->have == reader->total) ? CW_MR_FRAME : CW_MR_MORE;
}

int cw_mux_reader_feed(cw_mux_reader *reader, const uint8_t *data, size_t length, size_t *consumed) {
    uint8_t *where;
    size_t room = cw_mux_reader_space(reader, &where);
    size_t take_now = length < room ? length : room;
    if (take_now > 0) memcpy(where, data, take_now);
    *consumed = take_now;
    return cw_mux_reader_commit(reader, take_now);
}

int cw_mux_reader_pump(cw_mux_reader *reader, int fd) {
    uint8_t *where;
    size_t room = cw_mux_reader_space(reader, &where);
    if (room == 0) return reader->total != 0 ? CW_MR_FRAME : -CW_E_IO;
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(CW_FD_CAPACITY * sizeof(int))]; } ancillary;
    memset(&ancillary, 0, sizeof ancillary);
    struct iovec io = { .iov_base = where, .iov_len = room };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.bytes;
    message.msg_controllen = sizeof ancillary;
    ssize_t received = recvmsg(fd, &message, MSG_DONTWAIT);
    if (received < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return CW_MR_AGAIN;
        if (errno == ECONNRESET || errno == ENOTCONN || errno == EPIPE) return -CW_E_EOF;
        return -CW_E_IO;
    }
    /* A descriptor on a mux stream is never asked for. Truncation is fatal and is judged BEFORE any header is believed; whatever is
     * visible is closed. The collector is bounded by the control buffer (macOS leaves cmsg_len at the sender's length). */
    int stray[CW_FD_CAPACITY];
    cw_rights_result rights;
    cw_rights_collect(&message, stray, CW_FD_CAPACITY, &rights);
    for (size_t i = 0; i < rights.count; i++) (void)close(stray[i]);
    if ((message.msg_flags & MSG_CTRUNC) || rights.truncated) return -CW_E_CTRUNC;
    if (rights.count > 0 || rights.closed > 0 || rights.malformed) return -CW_E_BAD_RIGHTS;
    if (received == 0) return -CW_E_EOF;
    return cw_mux_reader_commit(reader, (size_t)received);
}
