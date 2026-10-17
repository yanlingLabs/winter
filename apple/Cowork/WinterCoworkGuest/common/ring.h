/* Fixed-capacity byte ring (power-of-two capacity), used by the relay's bounded queues. Portable C11, header only. */
#ifndef WG_RING_H
#define WG_RING_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct wg_ring {
    uint8_t *data;
    size_t mask;  /* capacity - 1 */
    size_t head;  /* next byte to read, counts up forever */
    size_t tail;  /* next byte to write, counts up forever */
};

static inline void wg_ring_init(struct wg_ring *r, uint8_t *storage, size_t capacity_pow2) {
    r->data = storage; r->mask = capacity_pow2 - 1; r->head = 0; r->tail = 0;
}
static inline size_t wg_ring_capacity(const struct wg_ring *r) { return r->mask + 1; }
static inline size_t wg_ring_used(const struct wg_ring *r) { return r->tail - r->head; }
static inline size_t wg_ring_free(const struct wg_ring *r) { return wg_ring_capacity(r) - wg_ring_used(r); }

/* All or nothing: returns 0 on success, -1 when the bytes do not fit. */
static inline int wg_ring_put(struct wg_ring *r, const uint8_t *bytes, size_t length) {
    if (length > wg_ring_free(r)) return -1;
    for (size_t i = 0; i < length;) {
        size_t at = (r->tail + i) & r->mask, run = wg_ring_capacity(r) - at;
        if (run > length - i) run = length - i;
        memcpy(r->data + at, bytes + i, run);
        i += run;
    }
    r->tail += length;
    return 0;
}

/* The longest contiguous readable run (may be shorter than used()). */
static inline size_t wg_ring_peek(const struct wg_ring *r, const uint8_t **out) {
    size_t used = wg_ring_used(r), at = r->head & r->mask, run = wg_ring_capacity(r) - at;
    *out = r->data + at;
    return run < used ? run : used;
}
static inline void wg_ring_drop(struct wg_ring *r, size_t length) { r->head += length; }
static inline void wg_ring_clear(struct wg_ring *r) { r->head = r->tail; }

#endif
