/* Bounded console capture. The guest's PL011 output and libkrun's own stderr rows (reclaim JSON, log lines) go into a pipe
 * that a reader thread drains into a fixed ring. The reader NEVER blocks on anything but its own read: a full ring drops the
 * oldest bytes and counts them, because a stalled reader would stall the VMM thread that is printing into the pipe (the
 * fixture-era `eprintln!` rows sit in the reclaim hot path, and `eprintln!` panics when stderr cannot be written).
 *
 * Redaction (S4's note, review item 7): `reclaim_unmap` rows carry host virtual addresses (`"hva":<n>`). Every line is
 * redacted BEFORE it enters the ring, and the ring is sanitised to printable ASCII, so nothing a guest prints can inject
 * terminal escapes into a log. The ring is only ever written out on an abnormal exit.
 */
#ifndef WINTER_COWORK_WORKER_CONSOLE_RING_H
#define WINTER_COWORK_WORKER_CONSOLE_RING_H

#include "WorkerCommon.h"

#define CW_RING_BYTES 65536u
#define CW_RING_LINE_MAX 2048u

typedef struct {
    uint8_t data[CW_RING_BYTES];
    size_t start;      /* index of the oldest byte */
    size_t length;     /* bytes held */
    uint64_t dropped;  /* bytes overwritten or cut since the start */
    uint64_t redacted; /* addresses redacted */
    uint8_t line[CW_RING_LINE_MAX];
    size_t line_length;
    bool line_cut;     /* the current line already overflowed and was truncated */
} cw_ring;

void cw_ring_init(cw_ring *ring);
/* Feed raw bytes (any chunking). Complete lines are redacted and stored; a line longer than CW_RING_LINE_MAX is cut. */
void cw_ring_feed(cw_ring *ring, const uint8_t *data, size_t length);
/* Copy the held text, oldest first, plus any unterminated tail (redacted), into out. Returns the length. */
size_t cw_ring_snapshot(const cw_ring *ring, uint8_t *out, size_t capacity);

/* Redact one line. Returns the output length (never more than `capacity`); counts redactions into *count. */
size_t cw_redact_line(const uint8_t *line, size_t length, uint8_t *out, size_t capacity, uint64_t *count);

#endif
