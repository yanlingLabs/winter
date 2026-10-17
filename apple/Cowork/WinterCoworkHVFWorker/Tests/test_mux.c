/* Mux framing: S1's golden vectors, the strict control grammar, the sequence tracker and the stream reader.
 * Bootstrap and runtime payloads are relayed BLIND: the vectors that only their payload makes invalid are asserted to PASS THROUGH. */
#include "Mux.h"
#include "test_support.h"
#include "vectors.h"

#include <errno.h>
#include <sys/socket.h>

static void golden_vectors(void) {
    CHECK(MUX_VECTOR_COUNT == 42); /* 15 positive + 27 negative in the pinned file */
    unsigned blind_seen = 0;
    for (size_t i = 0; i < MUX_VECTOR_COUNT; i++) {
        const cw_mux_vector *v = &mux_vectors[i];
        cw_mux_header header;
        cw_control control;
        int rc = cw_mux_frame_check(v->bytes, v->length, (cw_mux_dir)v->direction, &header, &control);
        if (v->error == NULL) {
            CHECK(rc == CW_OK);
            CHECK((int)header.cls == v->cls && header.seq == v->seq);
            /* Encode it again, byte for byte. Control payloads come from the typed value; the others are carried as they are. */
            uint8_t again[CW_MUX_MAX_FRAME > 8192 ? 8192 : CW_MUX_MAX_FRAME];
            uint8_t payload[CW_MUX_CONTROL_MAX];
            size_t length = 0;
            if (header.cls == CW_CLASS_CONTROL) {
                size_t payload_length = cw_control_encode(&control, payload, sizeof payload);
                CHECK(payload_length == header.length);
                length = cw_mux_encode(header.cls, header.seq, payload, payload_length, again, sizeof again);
            } else {
                length = cw_mux_encode(header.cls, header.seq, v->bytes + CW_MUX_HEADER, header.length, again, sizeof again);
            }
            CHECK(length == v->length);
            CHECK(length == v->length && memcmp(again, v->bytes, v->length) == 0);
        } else if (v->blind) {
            blind_seen++;
            /* The TypeScript parser refuses it for its PAYLOAD (v->error). The worker never reads that payload. */
            CHECK(rc == CW_OK);
            CHECK(header.cls == CW_CLASS_BOOTSTRAP);
        } else {
            if (strcmp(cw_error_name(rc), v->error) != 0) fprintf(stderr, "vector %s: got %s want %s\n", v->name, cw_error_name(rc), v->error);
            CHECK_STR(cw_error_name(rc), v->error);
        }
    }
    CHECK(blind_seen == 6); /* plan-protocol-2, plan-unsorted-nested-keys, hello-wrong-serial, bootstrap-invalid-utf8, plan-travelling-up, bom-mux-bootstrap */
}

static int control_error(const char *text, cw_mux_dir direction) {
    cw_control control;
    return cw_control_parse((const uint8_t *)text, strlen(text), direction, &control);
}

static void control_grammar(void) {
    const char *nonce = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
    char text[512];
    cw_control control;
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":120000,\"origin\":\"owner-loss\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_OK);
    CHECK(cw_control_parse((const uint8_t *)text, strlen(text), CW_MUX_DOWN, &control) == CW_OK && control.budget_ms == 120000 && control.origin == CW_ORIGIN_OWNER_LOSS && control.nonce[0] == 0x0f);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":120001,\"origin\":\"host-stop\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":99999999999,\"origin\":\"host-stop\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":0,\"origin\":\"host-stop\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_OK);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":00,\"origin\":\"host-stop\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_MALFORMED); /* leading zero */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":-1,\"origin\":\"host-stop\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_MALFORMED);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":1,\"origin\":\"host\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    /* the origin is matched whole: a prefix of "owner-loss" and a longer word are other words */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":1,\"origin\":\"owner\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":1,\"origin\":\"owner-lossy\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":1,\"origin\":\"host-stopx\"}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"budgetMs\":1}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD); /* a key is missing */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"%s\",\"origin\":\"host-stop\",\"budgetMs\":1}", nonce);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_MALFORMED); /* reordered */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain\",\"stopNonce\":\"0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F0F\",\"budgetMs\":1,\"origin\":\"host-stop\"}");
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_BAD_FIELD); /* upper case hex */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\"}");
    CHECK(control_error(text, CW_MUX_UP) == CW_E_BAD_FIELD); /* 30 characters */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\"}");
    CHECK(control_error(text, CW_MUX_UP) == CW_E_BAD_FIELD); /* 36 characters: the first 32 are valid hex, the rest must not be ignored */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"%s\"}\n", nonce);
    CHECK(control_error(text, CW_MUX_UP) == CW_E_MALFORMED); /* no trailing newline in a mux payload */
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"%s\"} ", nonce);
    CHECK(control_error(text, CW_MUX_UP) == CW_E_MALFORMED);
    snprintf(text, sizeof text, "{\"v\":1,\"t\":\"drain_ack\",\"stopNonce\":\"%s\"}", nonce);
    CHECK(control_error(text, CW_MUX_UP) == CW_OK);
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_UNKNOWN_TYPE); /* direction is part of the schema */
    snprintf(text, sizeof text, "{\"v\":2,\"t\":\"ping\",\"n\":1}");
    CHECK(control_error(text, CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":4294967295}", CW_MUX_DOWN) == CW_OK);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":4294967296}", CW_MUX_DOWN) == CW_E_BAD_FIELD);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":0}", CW_MUX_DOWN) == CW_OK);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":}", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":\"7\"}", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":7e0}", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":7}x", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":7,\"v\":1}", CW_MUX_DOWN) == CW_E_MALFORMED); /* duplicate of a framing key */
    CHECK(control_error("{\"v\":1,\"t\":\"ping\",\"n\":7,\"x\":1}", CW_MUX_DOWN) == CW_E_BAD_FIELD);
    CHECK(control_error("{\"v\":1,\"t\":\"pi\\u006eg\",\"n\":7}", CW_MUX_DOWN) == CW_E_MALFORMED); /* an escape never canonicalises */
    CHECK(control_error("", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"\"}", CW_MUX_DOWN) == CW_E_MALFORMED);
    CHECK(control_error("{\"v\":1,\"t\":\"pong\",\"n\":7}", CW_MUX_UP) == CW_OK);
    CHECK(control_error("{\"v\":1,\"t\":\"pong\",\"n\":7}", CW_MUX_DOWN) == CW_E_UNKNOWN_TYPE);
    CHECK(control_error("{\"v\":1,\"t\":\"halting\",\"stopNonce\":\"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f\"}", CW_MUX_UP) == CW_OK);
    /* A payload over the class ceiling is oversize before its text is read. */
    uint8_t big[CW_MUX_CONTROL_MAX + 1];
    memset(big, ' ', sizeof big);
    CHECK(cw_control_parse(big, sizeof big, CW_MUX_DOWN, &control) == CW_E_OVERSIZE);
    /* The encoder refuses what the parser would. */
    uint8_t out[CW_MUX_CONTROL_MAX];
    memset(&control, 0, sizeof control);
    control.type = CW_CTL_DRAIN;
    control.origin = 7;
    CHECK(cw_control_encode(&control, out, sizeof out) == 0);
    control.origin = CW_ORIGIN_HOST_STOP;
    control.budget_ms = 120001;
    CHECK(cw_control_encode(&control, out, sizeof out) == 0);
    control.budget_ms = 5;
    CHECK(cw_control_encode(&control, out, 20) == 0); /* too small */
    CHECK(cw_control_encode(&control, out, sizeof out) > 0);
}

static void provider_and_limits(void) {
    uint8_t frame[64];
    uint8_t payload[4] = { 1, 2, 3, 4 };
    CHECK(cw_mux_encode(CW_CLASS_PROVIDER, 1, payload, 4, frame, sizeof frame) == 0);
    CHECK(cw_mux_encode(CW_CLASS_RUNTIME, 0, payload, 4, frame, sizeof frame) == 0);
    CHECK(cw_mux_encode(CW_CLASS_RUNTIME, 1, payload, 4, frame, 19) == 0);
    CHECK(cw_mux_encode(CW_CLASS_RUNTIME, 1, payload, 4, frame, 20) == 20);
    /* The provider class is refused at the header in both directions, empty or not. */
    for (int direction = 0; direction < 2; direction++) {
        uint8_t provider[16 + 4] = { 'W', 'M', 'X', '1', 1, 3, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 1, 2, 3, 4 };
        CHECK(cw_mux_frame_check(provider, sizeof provider, (cw_mux_dir)direction, NULL, NULL) == CW_E_RESERVED_CLASS);
        CHECK(cw_mux_frame_check(provider, 16, (cw_mux_dir)direction, NULL, NULL) == CW_E_RESERVED_CLASS);
    }
    /* Per-class payload ceilings, judged at the header. */
    uint8_t header[16] = { 'W', 'M', 'X', '1', 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 };
    cw_mux_header parsed;
    const struct { uint8_t cls; uint32_t ok; uint32_t over; } limits[] = { { 0, 4096, 4097 }, { 1, 262144, 262145 }, { 2, 1048576, 1048577 } };
    for (size_t i = 0; i < 3; i++) {
        header[5] = limits[i].cls;
        header[12] = (uint8_t)limits[i].ok; header[13] = (uint8_t)(limits[i].ok >> 8); header[14] = (uint8_t)(limits[i].ok >> 16); header[15] = 0;
        CHECK(cw_mux_parse_header(header, 16, &parsed) == CW_OK);
        header[12] = (uint8_t)limits[i].over; header[13] = (uint8_t)(limits[i].over >> 8); header[14] = (uint8_t)(limits[i].over >> 16);
        CHECK(cw_mux_parse_header(header, 16, &parsed) == CW_E_OVERSIZE);
    }
    header[5] = 4; /* an unknown class */
    CHECK(cw_mux_parse_header(header, 16, &parsed) == CW_E_MALFORMED);
    CHECK(cw_mux_parse_header(header, 15, &parsed) == CW_E_MALFORMED);
}

static void sequence_tracker(void) {
    cw_mux_seq seq;
    cw_mux_seq_init(&seq);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 1) == CW_OK);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 2) == CW_OK);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 2) == CW_E_BAD_SEQUENCE); /* repeat */
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 1) == CW_E_BAD_SEQUENCE); /* rewind */
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 4) == CW_E_BAD_SEQUENCE); /* gap */
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 3) == CW_OK);             /* a refusal did not move it */
    /* Independent per class and per direction. */
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_UP, 1) == CW_OK);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_BOOTSTRAP, CW_MUX_DOWN, 1) == CW_OK);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_CONTROL, CW_MUX_UP, 1) == CW_OK);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_BOOTSTRAP, CW_MUX_UP, 2) == CW_E_BAD_SEQUENCE);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_PROVIDER, CW_MUX_DOWN, 1) == CW_E_BAD_SEQUENCE);
    CHECK(cw_mux_seq_accept(&seq, CW_CLASS_RUNTIME, CW_MUX_DOWN, 0) == CW_E_BAD_SEQUENCE);
    /* The counter wrapping ends the stream rather than restarting it. */
    cw_mux_seq wrap;
    cw_mux_seq_init(&wrap);
    wrap.next[CW_CLASS_RUNTIME][CW_MUX_UP] = 0xffffffffu;
    CHECK(cw_mux_seq_accept(&wrap, CW_CLASS_RUNTIME, CW_MUX_UP, 0xffffffffu) == CW_OK);
    CHECK(cw_mux_seq_accept(&wrap, CW_CLASS_RUNTIME, CW_MUX_UP, 0) == CW_E_BAD_SEQUENCE);
    CHECK(cw_mux_seq_accept(&wrap, CW_CLASS_RUNTIME, CW_MUX_UP, 1) == CW_E_BAD_SEQUENCE);
}

static cw_mux_reader reader; /* 1 MiB: static */

static void reader_memory(void) {
    for (size_t i = 0; i < MUX_POSITIVE_COUNT; i++) {
        const cw_mux_vector *v = &mux_vectors[i];
        /* One byte at a time: the frame completes on exactly the last byte, never earlier. */
        cw_mux_reader_reset(&reader);
        int rc = CW_MR_MORE;
        for (size_t at = 0; at < v->length; at++) {
            size_t consumed = 0;
            CHECK(rc == CW_MR_MORE);
            rc = cw_mux_reader_feed(&reader, v->bytes + at, 1, &consumed);
            CHECK(consumed == 1);
        }
        CHECK(rc == CW_MR_FRAME);
        CHECK(reader.total == v->length && memcmp(reader.buf, v->bytes, v->length) == 0);
        /* Bytes after the frame are never taken: the reader owns no leftovers. */
        cw_mux_reader_reset(&reader);
        uint8_t doubled[8192];
        CHECK(v->length * 2 <= sizeof doubled);
        memcpy(doubled, v->bytes, v->length);
        memcpy(doubled + v->length, v->bytes, v->length);
        size_t used = 0;
        int fed = CW_MR_MORE;
        while (fed == CW_MR_MORE && used < v->length * 2) { /* the reader takes the header, then the payload, and stops at the frame's end */
            size_t consumed = 0;
            fed = cw_mux_reader_feed(&reader, doubled + used, v->length * 2 - used, &consumed);
            used += consumed;
        }
        CHECK(fed == CW_MR_FRAME);
        CHECK(used == v->length);
        CHECK(cw_mux_reader_space(&reader, NULL) == 0);
    }
    /* A refused header is refused as soon as its 16 bytes are in, before any payload is buffered. */
    const struct { const char *vector; int error; } early[] = { { "runtime-over-limit-header-only", CW_E_OVERSIZE }, { "provider-class-with-payload", CW_E_RESERVED_CLASS },
        { "bad-magic", CW_E_MALFORMED }, { "bad-version", CW_E_VERSION }, { "sequence-zero", CW_E_BAD_SEQUENCE }, { "unknown-class", CW_E_MALFORMED } };
    for (size_t i = 0; i < sizeof early / sizeof early[0]; i++) {
        const cw_mux_vector *v = NULL;
        for (size_t k = 0; k < MUX_VECTOR_COUNT; k++) if (strcmp(mux_vectors[k].name, early[i].vector) == 0) v = &mux_vectors[k];
        CHECK(v != NULL);
        cw_mux_reader_reset(&reader);
        size_t consumed = 0;
        CHECK(cw_mux_reader_feed(&reader, v->bytes, v->length, &consumed) == -early[i].error);
        CHECK(consumed == 16 && reader.have == 16);
    }
}

static void write_all_nonblocking(int fd, const uint8_t *data, size_t length, size_t *offset) {
    while (*offset < length) {
        ssize_t sent = send(fd, data + *offset, length - *offset, 0);
        if (sent <= 0) return;
        *offset += (size_t)sent;
    }
}

static void reader_socket(void) {
    int pair[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    int flags = fcntl(pair[0], F_GETFL);
    fcntl(pair[0], F_SETFL, flags | O_NONBLOCK);
    flags = fcntl(pair[1], F_GETFL);
    fcntl(pair[1], F_SETFL, flags | O_NONBLOCK);
    cw_mux_reader_reset(&reader);
    CHECK(cw_mux_reader_pump(&reader, pair[1]) == CW_MR_AGAIN);
    /* A maximum-size runtime frame, written and read in lockstep through a small socket buffer. */
    static uint8_t big[CW_MUX_MAX_FRAME];
    static uint8_t payload[CW_MUX_RUNTIME_MAX];
    for (size_t i = 0; i < sizeof payload; i++) payload[i] = (uint8_t)(i * 31 + 7);
    size_t length = cw_mux_encode(CW_CLASS_RUNTIME, 1, payload, sizeof payload, big, sizeof big);
    CHECK(length == CW_MUX_MAX_FRAME);
    size_t offset = 0;
    int rc = CW_MR_MORE;
    for (int spin = 0; spin < 1000000 && rc != CW_MR_FRAME; spin++) {
        write_all_nonblocking(pair[0], big, length, &offset);
        rc = cw_mux_reader_pump(&reader, pair[1]);
        CHECK(rc >= 0);
        if (rc < 0) break;
    }
    CHECK(rc == CW_MR_FRAME && reader.total == length && memcmp(reader.buf, big, length) == 0);
    cw_mux_reader_reset(&reader);
    /* A frame whose header is refused ends the stream. */
    uint8_t provider[16] = { 'W', 'M', 'X', '1', 1, 3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0 };
    CHECK(send(pair[0], provider, sizeof provider, 0) == (ssize_t)sizeof provider);
    int result = CW_MR_MORE;
    while (result == CW_MR_MORE) result = cw_mux_reader_pump(&reader, pair[1]);
    CHECK(result == -CW_E_RESERVED_CLASS);
    /* EOF is reported, not retried. */
    cw_mux_reader_reset(&reader);
    close(pair[0]);
    CHECK(cw_mux_reader_pump(&reader, pair[1]) == -CW_E_EOF);
    close(pair[1]);

    /* A descriptor on a mux stream is never asked for: it is closed and the stream is refused. */
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    fcntl(pair[1], F_SETFL, fcntl(pair[1], F_GETFL) | O_NONBLOCK);
    int victim = open("/dev/null", O_RDONLY);
    CHECK(victim >= 3);
    uint8_t byte = 0x57;
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } rights;
    memset(&rights, 0, sizeof rights);
    struct iovec io = { &byte, 1 };
    struct msghdr message;
    memset(&message, 0, sizeof message);
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = rights.bytes;
    message.msg_controllen = sizeof rights.bytes;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &victim, sizeof victim);
    int before = cw_test_open_descriptors();
    CHECK(sendmsg(pair[0], &message, 0) == 1);
    cw_mux_reader_reset(&reader);
    CHECK(cw_mux_reader_pump(&reader, pair[1]) == -CW_E_BAD_RIGHTS);
    CHECK(cw_test_open_descriptors() == before); /* nothing leaked into this process */
    close(victim);
    close(pair[0]);
    close(pair[1]);
}

int main(void) {
    golden_vectors();
    control_grammar();
    provider_and_limits();
    sequence_tracker();
    reader_memory();
    reader_socket();
    return cw_test_finish("test_mux");
}
