#include "wmx.h"

#include <stdio.h>
#include <string.h>

static const char *const STATUS_NAMES[WMX_STATUS_COUNT] = {
    "ok", "malformed", "oversize", "version", "unknown_type", "bad_field", "reserved_class", "bad_sequence", "bad_direction"
};

const char *wmx_status_name(enum wmx_status status) {
    return (unsigned)status < WMX_STATUS_COUNT ? STATUS_NAMES[status] : "malformed";
}

size_t wmx_class_limit(unsigned class_value) {
    switch (class_value) {
    case WMX_CLASS_CONTROL: return WMX_MAX_CONTROL;
    case WMX_CLASS_BOOTSTRAP: return WMX_MAX_BOOTSTRAP;
    case WMX_CLASS_RUNTIME: return WMX_MAX_RUNTIME;
    default: return 0;
    }
}

static uint32_t get_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

enum wmx_status wmx_parse_header(const uint8_t *bytes, size_t length, struct wmx_header *out) {
    if (!bytes || length < WMX_HEADER_BYTES) return WMX_MALFORMED;
    if (memcmp(bytes, "WMX1", 4) != 0) return WMX_MALFORMED;
    if (bytes[4] != WMX_VERSION) return WMX_VERSION_ERR;
    unsigned cls = bytes[5];
    /* A class byte above 3 is unknown, a non-zero flags field is reserved: both malformed, before the provider refusal. */
    if (cls >= WMX_CLASS_COUNT || bytes[6] != 0 || bytes[7] != 0) return WMX_MALFORMED;
    if (cls == WMX_CLASS_PROVIDER) return WMX_RESERVED_CLASS;
    uint32_t seq = get_u32(bytes + 8), payload = get_u32(bytes + 12);
    if (seq < 1) return WMX_BAD_SEQUENCE;
    if (payload > wmx_class_limit(cls)) return WMX_OVERSIZE;
    if (out) { out->class_value = cls; out->seq = seq; out->length = payload; }
    return WMX_OK;
}

enum wmx_status wmx_parse_frame(const uint8_t *bytes, size_t length, struct wmx_header *out, const uint8_t **payload) {
    struct wmx_header header;
    enum wmx_status status = wmx_parse_header(bytes, length, &header);
    if (status != WMX_OK) return status;
    if (length != WMX_HEADER_BYTES + (size_t)header.length) return WMX_MALFORMED;
    if (out) *out = header;
    if (payload) *payload = bytes + WMX_HEADER_BYTES;
    return WMX_OK;
}

int wmx_write_header(uint8_t out[WMX_HEADER_BYTES], unsigned class_value, uint32_t seq, uint32_t length) {
    if (class_value >= WMX_CLASS_PROVIDER || seq < 1 || length > wmx_class_limit(class_value)) return -1;
    memcpy(out, "WMX1", 4);
    out[4] = WMX_VERSION; out[5] = (uint8_t)class_value; out[6] = 0; out[7] = 0;
    put_u32(out + 8, seq); put_u32(out + 12, length);
    return 0;
}

size_t wmx_build_frame(uint8_t *out, size_t capacity, unsigned class_value, uint32_t seq, const uint8_t *payload, size_t length) {
    if (length > UINT32_MAX || capacity < WMX_HEADER_BYTES + length) return 0;
    if (wmx_write_header(out, class_value, seq, (uint32_t)length) != 0) return 0;
    if (length) memmove(out + WMX_HEADER_BYTES, payload, length);
    return WMX_HEADER_BYTES + length;
}

void wmx_seq_init(struct wmx_seq *seq) {
    for (unsigned i = 0; i < WMX_CLASS_COUNT; i++) { seq->next[i] = 1; seq->exhausted[i] = 0; }
}

enum wmx_status wmx_seq_accept(struct wmx_seq *seq, unsigned class_value, uint32_t value) {
    if (class_value >= WMX_CLASS_COUNT || seq->exhausted[class_value] || value != seq->next[class_value]) return WMX_BAD_SEQUENCE;
    if (value == UINT32_MAX) seq->exhausted[class_value] = 1; else seq->next[class_value] = value + 1;
    return WMX_OK;
}

uint32_t wmx_seq_take(struct wmx_seq *seq, unsigned class_value) {
    if (class_value >= WMX_CLASS_COUNT || seq->exhausted[class_value]) return 0;
    uint32_t value = seq->next[class_value];
    if (value == UINT32_MAX) seq->exhausted[class_value] = 1; else seq->next[class_value] = value + 1;
    return value;
}

/* ------------------------------------------------------------------------------------------------ control payloads */

int wmx_is_nonce(const char *text) {
    if (!text) return 0;
    for (size_t i = 0; i < WMX_NONCE_CHARS; i++) {
        char c = text[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return text[WMX_NONCE_CHARS] == '\0';
}

enum field_kind { F_NONCE, F_U32, F_BUDGET, F_ORIGIN, F_FAULT_CODE, F_NONCE_OR_NULL };
struct field_spec { const char *key; enum field_kind kind; };
struct control_spec {
    const char *type;
    enum wmx_control_type id;
    enum wmx_direction direction;
    size_t count;
    struct field_spec fields[3];
};
static const struct control_spec SPECS[] = {
    { "drain", WMX_CONTROL_DRAIN, WMX_DOWN, 3, { { "stopNonce", F_NONCE }, { "budgetMs", F_BUDGET }, { "origin", F_ORIGIN } } },
    { "ping", WMX_CONTROL_PING, WMX_DOWN, 1, { { "n", F_U32 } } },
    { "drain_ack", WMX_CONTROL_DRAIN_ACK, WMX_UP, 1, { { "stopNonce", F_NONCE } } },
    { "halting", WMX_CONTROL_HALTING, WMX_UP, 1, { { "stopNonce", F_NONCE } } },
    { "pong", WMX_CONTROL_PONG, WMX_UP, 1, { { "n", F_U32 } } },
    { "fault", WMX_CONTROL_FAULT, WMX_UP, 2, { { "code", F_FAULT_CODE }, { "stopNonce", F_NONCE_OR_NULL } } },
};
static const char *const FAULT_NAMES[] = { "none", "unmount_failed", "supervisor_lost", "protocol_violation", "internal" };
const char *wmx_fault_code_name(enum wmx_fault_code code) { return (unsigned)code <= WMX_FAULT_INTERNAL ? FAULT_NAMES[code] : "none"; }
#define SPEC_COUNT (sizeof SPECS / sizeof SPECS[0])

struct cursor { const uint8_t *p; const uint8_t *end; };

static int take_literal(struct cursor *c, const char *text) {
    size_t n = strlen(text);
    if ((size_t)(c->end - c->p) < n || memcmp(c->p, text, n) != 0) return 0;
    c->p += n;
    return 1;
}
static int simple_char(uint8_t c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}
/* Reads a quote-free token of simple characters up to the next '"' (not consumed). Returns its length, or -1. */
static int read_token(const struct cursor *c, const uint8_t **start) {
    const uint8_t *p = c->p;
    *start = p;
    while (p < c->end && *p != '"') { if (!simple_char(*p)) return -1; p++; }
    if (p >= c->end || p - *start > 40) return -1;
    return (int)(p - *start);
}
static const struct control_spec *spec_for_type(const uint8_t *name, int length) {
    for (size_t i = 0; i < SPEC_COUNT; i++)
        if (strlen(SPECS[i].type) == (size_t)length && memcmp(SPECS[i].type, name, (size_t)length) == 0) return &SPECS[i];
    return NULL;
}
static int key_known(const struct control_spec *spec, const uint8_t *key, int length) {
    if ((length == 1 && (key[0] == 'v' || key[0] == 't'))) return 1;
    for (size_t i = 0; i < spec->count; i++)
        if (strlen(spec->fields[i].key) == (size_t)length && memcmp(spec->fields[i].key, key, (size_t)length) == 0) return 1;
    return 0;
}
/* At a ',' that does not introduce the key we wanted: a known key (reordered or duplicated) is a non-canonical spelling,
 * an unknown key is a wrong key set. */
static enum wmx_status classify_unexpected_key(const struct control_spec *spec, struct cursor c) {
    if (!take_literal(&c, ",\"")) return WMX_MALFORMED;
    const uint8_t *key;
    int length = read_token(&c, &key);
    if (length < 0) return WMX_MALFORMED;
    return key_known(spec, key, length) ? WMX_MALFORMED : WMX_BAD_FIELD;
}

/* Digits of a JSON number into *value. Floats and leading zeros are non-canonical spellings (MALFORMED); a minus sign or an
 * out-of-range value is a bad value (BAD_FIELD). */
static enum wmx_status read_uint(struct cursor *c, uint32_t maximum, uint32_t *value) {
    if (c->p < c->end && *c->p == '-') return WMX_BAD_FIELD;
    const uint8_t *start = c->p;
    uint64_t acc = 0;
    while (c->p < c->end && *c->p >= '0' && *c->p <= '9') {
        acc = acc * 10 + (uint64_t)(*c->p - '0');
        if (acc > 0xffffffffull) acc = 0x1ffffffffull; /* saturate; the range check below refuses it */
        c->p++;
    }
    size_t digits = (size_t)(c->p - start);
    if (digits == 0) return WMX_MALFORMED;
    if (digits > 1 && *start == '0') return WMX_MALFORMED;
    if (c->p < c->end && (*c->p == '.' || *c->p == 'e' || *c->p == 'E' || *c->p == '+')) return WMX_MALFORMED;
    if (acc > maximum) return WMX_BAD_FIELD;
    *value = (uint32_t)acc;
    return WMX_OK;
}

static enum wmx_status read_value(struct cursor *c, enum field_kind kind, struct wmx_control *out) {
    if (kind == F_U32 || kind == F_BUDGET) {
        uint32_t value;
        enum wmx_status status = read_uint(c, kind == F_BUDGET ? WMX_DRAIN_BUDGET_CEILING_MS : 0xffffffffu, &value);
        if (status != WMX_OK) return status;
        if (kind == F_BUDGET) out->budget_ms = value; else out->n = value;
        return WMX_OK;
    }
    if (kind == F_NONCE_OR_NULL && take_literal(c, "null")) { out->has_stop_nonce = 0; return WMX_OK; }
    if (!take_literal(c, "\"")) return WMX_MALFORMED;
    const uint8_t *text;
    int length = read_token(c, &text);
    if (length < 0) return WMX_MALFORMED;
    c->p += length + 1; /* token and the closing quote */
    if (kind == F_FAULT_CODE) {
        for (unsigned code = WMX_FAULT_UNMOUNT_FAILED; code <= WMX_FAULT_INTERNAL; code++)
            if (strlen(FAULT_NAMES[code]) == (size_t)length && memcmp(FAULT_NAMES[code], text, (size_t)length) == 0) { out->fault_code = (enum wmx_fault_code)code; return WMX_OK; }
        return WMX_BAD_FIELD;
    }
    if (kind == F_NONCE || kind == F_NONCE_OR_NULL) {
        char candidate[WMX_NONCE_CHARS + 1];
        if (length != WMX_NONCE_CHARS) return WMX_BAD_FIELD;
        memcpy(candidate, text, WMX_NONCE_CHARS);
        candidate[WMX_NONCE_CHARS] = '\0';
        if (!wmx_is_nonce(candidate)) return WMX_BAD_FIELD;
        memcpy(out->stop_nonce, candidate, sizeof candidate);
        out->has_stop_nonce = 1;
        return WMX_OK;
    }
    if (length == 9 && memcmp(text, "host-stop", 9) == 0) { out->origin = WMX_ORIGIN_HOST_STOP; return WMX_OK; }
    if (length == 10 && memcmp(text, "owner-loss", 10) == 0) { out->origin = WMX_ORIGIN_OWNER_LOSS; return WMX_OK; }
    return WMX_BAD_FIELD;
}

enum wmx_status wmx_parse_control(const uint8_t *payload, size_t length, enum wmx_direction direction, struct wmx_control *out) {
    struct wmx_control result;
    memset(&result, 0, sizeof result);
    if (!payload || length > WMX_MAX_CONTROL) return length > WMX_MAX_CONTROL ? WMX_OVERSIZE : WMX_MALFORMED;
    for (size_t i = 0; i < length; i++) if (payload[i] < 0x20 || payload[i] > 0x7e) return WMX_MALFORMED;
    struct cursor c = { payload, payload + length };
    if (!take_literal(&c, "{\"v\":1,\"t\":\"")) return WMX_MALFORMED;
    const uint8_t *name;
    int name_length = read_token(&c, &name);
    if (name_length < 0) return WMX_MALFORMED;
    c.p += name_length + 1;
    const struct control_spec *spec = spec_for_type(name, name_length);
    if (!spec || spec->direction != direction) return WMX_UNKNOWN_TYPE;
    result.type = spec->id;
    for (size_t i = 0; i < spec->count; i++) {
        if (c.p < c.end && *c.p == '}') return WMX_BAD_FIELD; /* a key is missing */
        if (!take_literal(&c, ",\"")) return WMX_MALFORMED;
        const uint8_t *key;
        int key_length = read_token(&c, &key);
        if (key_length < 0) return WMX_MALFORMED;
        if (strlen(spec->fields[i].key) != (size_t)key_length || memcmp(spec->fields[i].key, key, (size_t)key_length) != 0)
            return key_known(spec, key, key_length) ? WMX_MALFORMED : WMX_BAD_FIELD;
        c.p += key_length;
        if (!take_literal(&c, "\":")) return WMX_MALFORMED;
        enum wmx_status status = read_value(&c, spec->fields[i].kind, &result);
        if (status != WMX_OK) return status;
    }
    if (c.p < c.end && *c.p == ',') return classify_unexpected_key(spec, c);
    if (!take_literal(&c, "}") || c.p != c.end) return WMX_MALFORMED;
    if (out) *out = result;
    return WMX_OK;
}

size_t wmx_encode_control(const struct wmx_control *message, uint8_t *out, size_t capacity) {
    char text[160];
    int n;
    switch (message->type) {
    case WMX_CONTROL_DRAIN_ACK:
    case WMX_CONTROL_HALTING:
        if (!wmx_is_nonce(message->stop_nonce)) return 0;
        n = snprintf(text, sizeof text, "{\"v\":1,\"t\":\"%s\",\"stopNonce\":\"%s\"}",
                     message->type == WMX_CONTROL_DRAIN_ACK ? "drain_ack" : "halting", message->stop_nonce);
        break;
    case WMX_CONTROL_PONG:
        n = snprintf(text, sizeof text, "{\"v\":1,\"t\":\"pong\",\"n\":%u}", (unsigned)message->n);
        break;
    case WMX_CONTROL_FAULT:
        if (message->fault_code < WMX_FAULT_UNMOUNT_FAILED || message->fault_code > WMX_FAULT_INTERNAL) return 0;
        if (message->has_stop_nonce) {
            if (!wmx_is_nonce(message->stop_nonce)) return 0;
            n = snprintf(text, sizeof text, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":\"%s\"}", FAULT_NAMES[message->fault_code], message->stop_nonce);
        } else {
            n = snprintf(text, sizeof text, "{\"v\":1,\"t\":\"fault\",\"code\":\"%s\",\"stopNonce\":null}", FAULT_NAMES[message->fault_code]);
        }
        break;
    default:
        return 0; /* drain and ping are host messages: the guest never writes them */
    }
    if (n <= 0 || (size_t)n >= sizeof text || (size_t)n > capacity) return 0;
    memcpy(out, text, (size_t)n);
    return (size_t)n;
}

/* ------------------------------------------------------------------------------------------------ runtime payloads */

enum wmx_status wmx_parse_runtime_payload(const uint8_t *payload, size_t length, enum wmx_direction direction, struct wmx_runtime_prefix *out) {
    if (!payload || length < WMX_RUNTIME_PREFIX_BYTES) return WMX_MALFORMED;
    unsigned conversation = payload[0], stream = payload[1], flags = payload[2];
    if (conversation >= WMX_RUNTIME_CONVERSATIONS || stream < WMX_STREAM_IN || stream > WMX_STREAM_ERR || flags > 1 || payload[3] != 0) return WMX_BAD_FIELD;
    if ((stream == WMX_STREAM_IN) != (direction == WMX_DOWN)) return WMX_BAD_DIRECTION;
    if (length == WMX_RUNTIME_PREFIX_BYTES && flags == 0) return WMX_BAD_FIELD;
    if (out) { out->conversation = conversation; out->stream = (enum wmx_stream)stream; out->end = (int)flags; }
    return WMX_OK;
}

void wmx_write_runtime_prefix(uint8_t out[WMX_RUNTIME_PREFIX_BYTES], unsigned conversation, enum wmx_stream stream, int end) {
    out[0] = (uint8_t)conversation; out[1] = (uint8_t)stream; out[2] = end ? 1 : 0; out[3] = 0;
}

/* ------------------------------------------------------------------------------------------------ stream assembler */

void wmx_rx_init(struct wmx_rx *rx, uint8_t *payload_buffer, size_t capacity) {
    memset(rx, 0, sizeof *rx);
    rx->payload = payload_buffer;
    rx->capacity = capacity;
    for (unsigned i = 0; i < WMX_CLASS_COUNT; i++) {
        size_t limit = wmx_class_limit(i);
        rx->limit[i] = limit < capacity ? limit : capacity;
    }
}

enum wmx_rx_event wmx_rx_feed(struct wmx_rx *rx, const uint8_t *data, size_t length, size_t *consumed, enum wmx_status *status) {
    size_t used = 0;
    *consumed = 0;
    if (rx->in_payload && rx->have == rx->current.length) { /* a finished frame is released by the next call */
        rx->in_payload = 0;
        rx->have = 0;
    }
    while (1) {
        if (!rx->in_payload) {
            size_t want = WMX_HEADER_BYTES - rx->have;
            size_t take = length - used < want ? length - used : want;
            memcpy(rx->header + rx->have, data + used, take);
            rx->have += take; used += take;
            if (rx->have < WMX_HEADER_BYTES) { *consumed = used; return WMX_RX_NEED_MORE; }
            enum wmx_status result = wmx_parse_header(rx->header, WMX_HEADER_BYTES, &rx->current);
            if (result == WMX_OK && rx->current.length > rx->limit[rx->current.class_value]) result = WMX_OVERSIZE;
            if (result != WMX_OK) { *consumed = used; *status = result; return WMX_RX_ERROR; }
            rx->in_payload = 1;
            rx->have = 0;
            if (rx->current.length == 0) { *consumed = used; return WMX_RX_FRAME; }
        }
        size_t want = rx->current.length - rx->have;
        size_t take = length - used < want ? length - used : want;
        if (take) memcpy(rx->payload + rx->have, data + used, take);
        rx->have += take; used += take;
        *consumed = used;
        if (rx->have == rx->current.length) return WMX_RX_FRAME;
        return WMX_RX_NEED_MORE;
    }
}
