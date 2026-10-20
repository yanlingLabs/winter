#include "ctl.h"

#include <string.h>

size_t ctl_encode(uint8_t *out, size_t capacity, uint8_t tag, const void *payload, size_t length) {
    if (length > CTL_MAX_PAYLOAD || capacity < CTL_HEADER_BYTES + length) return 0;
    out[0] = tag; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = (uint8_t)length; out[5] = (uint8_t)(length >> 8); out[6] = (uint8_t)(length >> 16); out[7] = (uint8_t)(length >> 24);
    if (length) memmove(out + CTL_HEADER_BYTES, payload, length);
    return CTL_HEADER_BYTES + length;
}

void ctl_reader_init(struct ctl_reader *reader, uint8_t *payload_buffer, size_t capacity, const char *allowed_tags) {
    memset(reader, 0, sizeof *reader);
    reader->payload = payload_buffer;
    reader->capacity = capacity < CTL_MAX_PAYLOAD ? capacity : CTL_MAX_PAYLOAD;
    reader->allowed = allowed_tags;
}

enum ctl_event ctl_reader_feed(struct ctl_reader *reader, const uint8_t *data, size_t length, size_t *consumed) {
    size_t used = 0;
    *consumed = 0;
    if (reader->dead) return CTL_BAD;
    if (reader->in_payload && reader->have == reader->length) { reader->in_payload = 0; reader->have = 0; }
    if (!reader->in_payload) {
        size_t want = CTL_HEADER_BYTES - reader->have;
        size_t take = length - used < want ? length - used : want;
        memcpy(reader->header + reader->have, data + used, take);
        reader->have += take; used += take;
        if (reader->have < CTL_HEADER_BYTES) { *consumed = used; return CTL_NEED_MORE; }
        uint32_t size = (uint32_t)reader->header[4] | ((uint32_t)reader->header[5] << 8) | ((uint32_t)reader->header[6] << 16) |
                        ((uint32_t)reader->header[7] << 24);
        reader->tag = reader->header[0];
        reader->length = size;
        if (reader->header[1] || reader->header[2] || reader->header[3] || size > reader->capacity ||
            !reader->allowed || reader->tag == 0 || !strchr(reader->allowed, (int)reader->tag)) {
            reader->dead = 1; *consumed = used; return CTL_BAD;
        }
        reader->in_payload = 1;
        reader->have = 0;
        if (size == 0) { *consumed = used; return CTL_MESSAGE; }
    }
    size_t want = reader->length - reader->have;
    size_t take = length - used < want ? length - used : want;
    if (take) memcpy(reader->payload + reader->have, data + used, take);
    reader->have += take; used += take;
    *consumed = used;
    return reader->have == reader->length ? CTL_MESSAGE : CTL_NEED_MORE;
}
