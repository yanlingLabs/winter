/* Bounded console capture and the redaction of host virtual addresses. No VM, no sandbox. */
#include "ConsoleRing.h"
#include "test_support.h"

static size_t snapshot(const cw_ring *ring, char *out, size_t capacity) {
    size_t length = cw_ring_snapshot(ring, (uint8_t *)out, capacity - 1);
    out[length] = 0;
    return length;
}
static cw_ring ring; /* 64 KiB: static */

static void feed_text(const char *text) { cw_ring_feed(&ring, (const uint8_t *)text, strlen(text)); }

static void redaction(void) {
    uint64_t count = 0;
    uint8_t out[512];
    const char *row = "{\"kind\":\"reclaim_unmap\",\"epoch\":3,\"gpa\":1073741824,\"hva\":140737488347136,\"len\":16384,\"return\":0}";
    size_t n = cw_redact_line((const uint8_t *)row, strlen(row), out, sizeof out, &count);
    out[n] = 0;
    CHECK_STR((char *)out, "{\"kind\":\"reclaim_unmap\",\"epoch\":3,\"gpa\":1073741824,\"hva\":0,\"len\":16384,\"return\":0}");
    CHECK(count == 1 && strstr((char *)out, "140737488347136") == NULL); /* the address is gone; the guest physical address (not a host secret) is not touched */
    /* Two on one line, a quoted value, a hex spelling, spaces after the colon. */
    count = 0;
    const char *two = "\"hva\":123 and \"hva\": 4567 and \"hva\":\"0x7fff00001000\"";
    n = cw_redact_line((const uint8_t *)two, strlen(two), out, sizeof out, &count);
    out[n] = 0;
    CHECK(count == 3);
    CHECK(strstr((char *)out, "123") == NULL && strstr((char *)out, "4567") == NULL && strstr((char *)out, "7fff") == NULL);
    /* A line with no address is untouched; a key with no value is untouched. */
    count = 0;
    const char *plain = "kernel: virtio_blk virtio0: [vda] 131072 512-byte logical blocks \"hva\":";
    n = cw_redact_line((const uint8_t *)plain, strlen(plain), out, sizeof out, &count);
    out[n] = 0;
    CHECK(count == 0 && strcmp((char *)out, plain) == 0);
    /* Output is printable ASCII only: terminal escapes and NULs cannot reach a log. */
    const uint8_t hostile[] = { 'a', 0x1b, '[', '3', '1', 'm', 0, 0xff, 'z' };
    n = cw_redact_line(hostile, sizeof hostile, out, sizeof out, &count);
    out[n] = 0;
    CHECK_STR((char *)out, "a.[31m..z");
    /* The output bound is respected. */
    n = cw_redact_line((const uint8_t *)row, strlen(row), out, 10, &count);
    CHECK(n <= 10);
}

static void storing(void) {
    char text[200000];
    cw_ring_init(&ring);
    feed_text("first line\nsecond ");
    feed_text("line, in pieces\n");
    size_t n = snapshot(&ring, text, sizeof text);
    CHECK_STR(text, "first line\nsecond line, in pieces\n");
    CHECK(n == strlen(text) && ring.dropped == 0);
    /* An unterminated tail is shown (redacted) but not stored as a line. */
    feed_text("partial \"hva\":99");
    snapshot(&ring, text, sizeof text);
    CHECK(strstr(text, "partial \"hva\":0\n") != NULL && strstr(text, "99") == NULL);
    /* Redaction survives any chunking: one byte at a time. */
    cw_ring_init(&ring);
    const char *row = "{\"kind\":\"reclaim_unmap\",\"hva\":140737488347136,\"len\":1}\n";
    for (size_t i = 0; i < strlen(row); i++) cw_ring_feed(&ring, (const uint8_t *)row + i, 1);
    snapshot(&ring, text, sizeof text);
    CHECK_STR(text, "{\"kind\":\"reclaim_unmap\",\"hva\":0,\"len\":1}\n");
    CHECK(ring.redacted == 1);
}

static void bounds(void) {
    static char text[CW_RING_BYTES + CW_RING_LINE_MAX + 16];
    cw_ring_init(&ring);
    /* Far more than the ring holds: the NEWEST bytes survive, the oldest are counted as dropped, nothing blocks. */
    char line[64];
    unsigned total_lines = 5000;
    for (unsigned i = 0; i < total_lines; i++) {
        snprintf(line, sizeof line, "line %06u of a long console session\n", i);
        feed_text(line);
    }
    size_t n = snapshot(&ring, text, sizeof text);
    CHECK(n <= CW_RING_BYTES);
    CHECK(ring.length <= CW_RING_BYTES && ring.dropped > 0);
    CHECK(strstr(text, "line 004999 of a long console session\n") != NULL);   /* newest kept */
    CHECK(strstr(text, "line 000000 of a long console session\n") == NULL);   /* oldest gone */
    CHECK(n + ring.dropped == strlen("line 000000 of a long console session\n") * total_lines); /* every byte accounted for */
    /* A line longer than CW_RING_LINE_MAX is cut; its remainder is dropped to the newline; the next line is whole. */
    cw_ring_init(&ring);
    static char longline[CW_RING_LINE_MAX * 3];
    memset(longline, 'x', sizeof longline - 2);
    longline[sizeof longline - 2] = '\n';
    longline[sizeof longline - 1] = 0;
    feed_text(longline);
    feed_text("after\n");
    n = snapshot(&ring, text, sizeof text);
    CHECK(n == CW_RING_LINE_MAX + 1 + strlen("after\n"));
    CHECK(strstr(text, "after\n") != NULL);
    CHECK(ring.dropped == sizeof longline - 1 - CW_RING_LINE_MAX);
    /* An address inside the part of an over-long line that was dropped can never be stored. */
    cw_ring_init(&ring);
    memset(longline, 'x', CW_RING_LINE_MAX);
    snprintf(longline + CW_RING_LINE_MAX, 64, "\"hva\":140737488347136\n");
    feed_text(longline);
    snapshot(&ring, text, sizeof text);
    CHECK(strstr(text, "140737488347136") == NULL);
}

int main(void) {
    redaction();
    storing();
    bounds();
    return cw_test_finish("test_ring");
}
