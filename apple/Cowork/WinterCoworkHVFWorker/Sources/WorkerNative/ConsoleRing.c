#include "ConsoleRing.h"

#include <string.h>

void cw_ring_init(cw_ring *ring) { memset(ring, 0, sizeof *ring); }

/* Printable ASCII and newline survive; everything else becomes '.'. */
static uint8_t clean(uint8_t b) { return (b >= 0x20 && b < 0x7f) || b == '\n' ? b : (uint8_t)'.'; }

size_t cw_redact_line(const uint8_t *line, size_t length, uint8_t *out, size_t capacity, uint64_t *count) {
    static const char key[] = "\"hva\":";
    const size_t key_length = sizeof key - 1;
    size_t written = 0, i = 0;
    while (i < length && written < capacity) {
        if (length - i >= key_length && memcmp(line + i, key, key_length) == 0) {
            size_t digits = i + key_length;
            /* The value is a decimal integer in the rows libkrun prints; accept optional spaces and a quote so a reformat does not leak. */
            size_t j = digits;
            while (j < length && (line[j] == ' ' || line[j] == '"')) j++;
            size_t number_start = j;
            while (j < length && ((line[j] >= '0' && line[j] <= '9') || (line[j] >= 'a' && line[j] <= 'f') || (line[j] >= 'A' && line[j] <= 'F') || line[j] == 'x' || line[j] == 'X')) j++;
            if (j > number_start) {
                for (size_t k = 0; k < key_length && written < capacity; k++) out[written++] = clean(line[i + k]);
                if (written < capacity) out[written++] = (uint8_t)'0';
                if (count != NULL) (*count)++;
                i = j;
                continue;
            }
        }
        out[written++] = clean(line[i]);
        i++;
    }
    return written;
}

/* Append to the ring, dropping the oldest bytes when it is full. */
static void ring_store(cw_ring *ring, const uint8_t *data, size_t length) {
    if (length > CW_RING_BYTES) { /* keep only the tail that fits */
        ring->dropped += length - CW_RING_BYTES;
        data += length - CW_RING_BYTES;
        length = CW_RING_BYTES;
    }
    size_t overflow = ring->length + length > CW_RING_BYTES ? ring->length + length - CW_RING_BYTES : 0;
    if (overflow > 0) {
        ring->start = (ring->start + overflow) % CW_RING_BYTES;
        ring->length -= overflow;
        ring->dropped += overflow;
    }
    size_t end = (ring->start + ring->length) % CW_RING_BYTES;
    size_t first = CW_RING_BYTES - end < length ? CW_RING_BYTES - end : length;
    memcpy(ring->data + end, data, first);
    if (first < length) memcpy(ring->data, data + first, length - first);
    ring->length += length;
}

/* Redact the held line and store it with its newline. */
static void flush_line(cw_ring *ring) {
    uint8_t redacted[CW_RING_LINE_MAX + 1];
    size_t length = cw_redact_line(ring->line, ring->line_length, redacted, CW_RING_LINE_MAX, &ring->redacted);
    redacted[length++] = (uint8_t)'\n';
    ring_store(ring, redacted, length);
    ring->line_length = 0;
}

void cw_ring_feed(cw_ring *ring, const uint8_t *data, size_t length) {
    for (size_t i = 0; i < length; i++) {
        uint8_t b = data[i];
        if (ring->line_cut) { /* the rest of an over-long line is dropped, to its newline */
            ring->dropped++;
            if (b == '\n') ring->line_cut = false;
            continue;
        }
        if (b == '\n') { flush_line(ring); continue; }
        if (ring->line_length >= CW_RING_LINE_MAX) {
            /* A line this long is not a JSON row. Store what fits and drop the rest of it. */
            flush_line(ring);
            ring->line_cut = true;
            ring->dropped++;
            continue;
        }
        ring->line[ring->line_length++] = b;
    }
}

size_t cw_ring_snapshot(const cw_ring *ring, uint8_t *out, size_t capacity) {
    size_t written = 0;
    for (size_t i = 0; i < ring->length && written < capacity; i++) out[written++] = ring->data[(ring->start + i) % CW_RING_BYTES];
    if (ring->line_length > 0 && written < capacity) {
        uint64_t ignored = 0;
        written += cw_redact_line(ring->line, ring->line_length, out + written, capacity - written, &ignored);
        if (written < capacity) out[written++] = (uint8_t)'\n';
    }
    return written;
}
