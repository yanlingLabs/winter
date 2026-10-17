/*
 * Command line driver for the portable guest modules (wmx.c, ctl.c). The Python tests build it with the host compiler and
 * feed it the golden vectors, so the C code is exercised by exactly the bytes the TypeScript contract produced.
 * Not part of the guest image.
 */
#include "../common/ctl.h"
#include "../common/wmx.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int hex_value(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
static uint8_t *from_hex(const char *text, size_t *length) {
    size_t n = strlen(text);
    if (n % 2) return NULL;
    uint8_t *out = malloc(n / 2 + 1);
    for (size_t i = 0; i < n / 2; i++) {
        int hi = hex_value(text[2 * i]), lo = hex_value(text[2 * i + 1]);
        if (hi < 0 || lo < 0) { free(out); return NULL; }
        out[i] = (uint8_t)(hi * 16 + lo);
    }
    *length = n / 2;
    return out;
}
/* A hex argument is the text itself, or "@-" to read it from stdin: Linux limits one argument to 128 KiB, and the oversize cases are bigger. */
static uint8_t *from_hex_arg(const char *arg, size_t *length) {
    if (strcmp(arg, "@-") != 0) return from_hex(arg, length);
    size_t cap = 1 << 20, used = 0;
    char *text = malloc(cap + 1);
    size_t got;
    while ((got = fread(text + used, 1, cap - used, stdin)) > 0) {
        used += got;
        if (used == cap) { cap *= 2; text = realloc(text, cap + 1); }
    }
    while (used && (text[used - 1] == '\n' || text[used - 1] == '\r')) used--;
    text[used] = 0;
    uint8_t *out = from_hex(text, length);
    free(text);
    return out;
}
static void print_hex(const uint8_t *data, size_t length) {
    for (size_t i = 0; i < length; i++) printf("%02x", data[i]);
}
static const char *control_name(enum wmx_control_type type) {
    switch (type) {
    case WMX_CONTROL_DRAIN: return "drain";
    case WMX_CONTROL_PING: return "ping";
    case WMX_CONTROL_DRAIN_ACK: return "drain_ack";
    case WMX_CONTROL_HALTING: return "halting";
    case WMX_CONTROL_PONG: return "pong";
    case WMX_CONTROL_FAULT: return "fault";
    default: return "none";
    }
}
static void print_control(const struct wmx_control *c) {
    printf("%s|%s|%u|%d|%u", control_name(c->type), c->stop_nonce, (unsigned)c->budget_ms, (int)c->origin, (unsigned)c->n);
    if (c->type == WMX_CONTROL_FAULT) printf("|%s|%d", wmx_fault_code_name(c->fault_code), c->has_stop_nonce);
}

/* name direction hex, one per line -> name|status|class|seq|length|control fields */
static int cmd_vectors(void) {
    static char line[4 * 1024 * 1024];
    while (fgets(line, sizeof line, stdin)) {
        char name[128], direction[16];
        char *hex = malloc(sizeof line);
        if (sscanf(line, "%127s %15s %s", name, direction, hex) != 3) { free(hex); continue; }
        size_t length = 0;
        uint8_t *bytes = from_hex(hex, &length);
        free(hex);
        if (!bytes) { printf("%s|badhex\n", name); continue; }
        enum wmx_direction dir = strcmp(direction, "up") == 0 ? WMX_UP : WMX_DOWN;
        struct wmx_header header;
        const uint8_t *payload = NULL;
        enum wmx_status status = wmx_parse_frame(bytes, length, &header, &payload);
        if (status != WMX_OK) { printf("%s|%s\n", name, wmx_status_name(status)); free(bytes); continue; }
        if (header.class_value == WMX_CLASS_CONTROL) {
            struct wmx_control control;
            status = wmx_parse_control(payload, header.length, dir, &control);
            if (status != WMX_OK) { printf("%s|%s\n", name, wmx_status_name(status)); free(bytes); continue; }
            printf("%s|ok|%u|%u|%u|", name, header.class_value, (unsigned)header.seq, (unsigned)header.length);
            print_control(&control);
            if (control.type == WMX_CONTROL_DRAIN_ACK || control.type == WMX_CONTROL_HALTING || control.type == WMX_CONTROL_PONG || control.type == WMX_CONTROL_FAULT) {
                uint8_t rebuilt[512], body[256];
                size_t body_length = wmx_encode_control(&control, body, sizeof body);
                size_t frame = wmx_build_frame(rebuilt, sizeof rebuilt, WMX_CLASS_CONTROL, header.seq, body, body_length);
                printf("|%s", frame == length && memcmp(rebuilt, bytes, length) == 0 ? "reencode-same" : "reencode-DIFFERENT");
            }
            printf("\n");
        } else if (header.class_value == WMX_CLASS_RUNTIME) {
            struct wmx_runtime_prefix prefix;
            status = wmx_parse_runtime_payload(payload, header.length, dir, &prefix);
            if (status != WMX_OK) { printf("%s|%s\n", name, wmx_status_name(status)); free(bytes); continue; }
            uint8_t rebuilt[WMX_RUNTIME_PREFIX_BYTES];
            wmx_write_runtime_prefix(rebuilt, prefix.conversation, prefix.stream, prefix.end);
            printf("%s|ok|%u|%u|%u|runtime|%u|%u|%d|%s\n", name, header.class_value, (unsigned)header.seq, (unsigned)header.length, prefix.conversation, (unsigned)prefix.stream,
                   prefix.end, memcmp(rebuilt, payload, WMX_RUNTIME_PREFIX_BYTES) == 0 ? "prefix-same" : "prefix-DIFFERENT");
        } else {
            printf("%s|ok|%u|%u|%u|-\n", name, header.class_value, (unsigned)header.seq, (unsigned)header.length);
        }
        free(bytes);
    }
    return 0;
}

/* stream CHUNK DIRECTION HEX: feed the concatenated bytes CHUNK at a time (0 = all at once) */
static int cmd_stream(int argc, char **argv) {
    if (argc != 5) return 2;
    size_t chunk = (size_t)strtoul(argv[2], NULL, 10), length = 0;
    enum wmx_direction dir = strcmp(argv[3], "up") == 0 ? WMX_UP : WMX_DOWN;
    uint8_t *bytes = from_hex_arg(argv[4], &length);
    if (!bytes) return 2;
    static uint8_t payload[WMX_MAX_RUNTIME + 16];
    struct wmx_rx rx;
    wmx_rx_init(&rx, payload, sizeof payload);
    struct wmx_seq seq;
    wmx_seq_init(&seq);
    size_t offset = 0;
    while (offset < length) {
        size_t take = chunk ? (length - offset < chunk ? length - offset : chunk) : length - offset;
        size_t used = 0;
        while (used < take) {
            size_t consumed = 0;
            enum wmx_status status = WMX_OK;
            enum wmx_rx_event event = wmx_rx_feed(&rx, bytes + offset + used, take - used, &consumed, &status);
            used += consumed;
            if (event == WMX_RX_ERROR) { printf("E %s\n", wmx_status_name(status)); free(bytes); return 0; }
            if (event == WMX_RX_FRAME) {
                enum wmx_status order = wmx_seq_accept(&seq, rx.current.class_value, rx.current.seq);
                printf("F %u %u %u %s", rx.current.class_value, (unsigned)rx.current.seq, (unsigned)rx.current.length, wmx_status_name(order));
                if (rx.current.class_value == WMX_CLASS_CONTROL) {
                    struct wmx_control control;
                    enum wmx_status parsed = wmx_parse_control(rx.payload, rx.current.length, dir, &control);
                    printf(" %s", wmx_status_name(parsed));
                    if (parsed == WMX_OK) { printf(" "); print_control(&control); }
                }
                printf("\n");
            }
            if (consumed == 0 && event == WMX_RX_NEED_MORE) break;
        }
        offset += take;
    }
    printf("END\n");
    free(bytes);
    return 0;
}

static int cmd_encode(int argc, char **argv) {
    if (argc < 5) return 2;
    struct wmx_control control;
    memset(&control, 0, sizeof control);
    uint32_t seq = (uint32_t)strtoul(argv[4], NULL, 10);
    if (strcmp(argv[2], "drain_ack") == 0 || strcmp(argv[2], "halting") == 0) {
        control.type = strcmp(argv[2], "halting") == 0 ? WMX_CONTROL_HALTING : WMX_CONTROL_DRAIN_ACK;
        if (strlen(argv[3]) > WMX_NONCE_CHARS) { printf("refused\n"); return 0; }
        strcpy(control.stop_nonce, argv[3]);
    } else if (strcmp(argv[2], "fault") == 0 && argc >= 6) {
        control.type = WMX_CONTROL_FAULT;
        control.fault_code = (enum wmx_fault_code)strtoul(argv[3], NULL, 10);
        control.has_stop_nonce = strlen(argv[5]) > 0;
        if (strlen(argv[5]) > WMX_NONCE_CHARS) { printf("refused\n"); return 0; }
        strcpy(control.stop_nonce, argv[5]);
    } else if (strcmp(argv[2], "pong") == 0) {
        control.type = WMX_CONTROL_PONG;
        control.n = (uint32_t)strtoul(argv[3], NULL, 10);
    } else if (strcmp(argv[2], "drain") == 0) {
        control.type = WMX_CONTROL_DRAIN;
    }
    uint8_t body[256], frame[512];
    size_t body_length = wmx_encode_control(&control, body, sizeof body);
    if (!body_length) { printf("refused\n"); return 0; }
    size_t size = wmx_build_frame(frame, sizeof frame, WMX_CLASS_CONTROL, seq, body, body_length);
    if (!size) { printf("refused\n"); return 0; }
    print_hex(frame, size);
    printf("\n");
    return 0;
}

/* ctl feed CHUNK ALLOWED HEX */
static int cmd_ctl(int argc, char **argv) {
    if (argc == 5 && strcmp(argv[2], "encode") == 0) {
        size_t length = 0;
        uint8_t *payload = from_hex_arg(argv[4], &length);
        if (!payload) return 2;
        uint8_t out[CTL_HEADER_BYTES + CTL_MAX_PAYLOAD + 8];
        size_t n = ctl_encode(out, sizeof out, (uint8_t)argv[3][0], payload, length);
        if (!n) printf("refused\n"); else { print_hex(out, n); printf("\n"); }
        free(payload);
        return 0;
    }
    if (argc != 6 || strcmp(argv[2], "feed") != 0) return 2;
    size_t chunk = (size_t)strtoul(argv[3], NULL, 10), length = 0;
    uint8_t *bytes = from_hex_arg(argv[5], &length);
    if (!bytes) return 2;
    static uint8_t payload[CTL_MAX_PAYLOAD];
    struct ctl_reader reader;
    ctl_reader_init(&reader, payload, sizeof payload, argv[4]);
    size_t offset = 0;
    while (offset < length) {
        size_t take = chunk ? (length - offset < chunk ? length - offset : chunk) : length - offset, used = 0;
        while (used < take) {
            size_t consumed = 0;
            enum ctl_event event = ctl_reader_feed(&reader, bytes + offset + used, take - used, &consumed);
            used += consumed;
            if (event == CTL_BAD) { printf("BAD\n"); free(bytes); return 0; }
            if (event == CTL_MESSAGE) { printf("M %c %u ", (char)reader.tag, (unsigned)reader.length); print_hex(reader.payload, reader.length); printf("\n"); }
            if (consumed == 0) break;
        }
        offset += take;
    }
    printf("END\n");
    free(bytes);
    return 0;
}

/* control DIRECTION TEXT: the payload text itself, no frame around it */
static int cmd_control(int argc, char **argv) {
    if (argc != 4) return 2;
    struct wmx_control control;
    enum wmx_status status = wmx_parse_control((const uint8_t *)argv[3], strlen(argv[3]), strcmp(argv[2], "up") == 0 ? WMX_UP : WMX_DOWN, &control);
    printf("%s", wmx_status_name(status));
    if (status == WMX_OK) { printf("|"); print_control(&control); }
    printf("\n");
    return 0;
}

/* frame CLASS SEQ HEXPAYLOAD: what wmx_build_frame produces, or "refused" */
static int cmd_frame(int argc, char **argv) {
    if (argc != 5) return 2;
    size_t length = 0;
    uint8_t *payload = from_hex_arg(argv[4], &length);
    if (!payload) return 2;
    static uint8_t frame[WMX_MAX_RUNTIME + 64];
    size_t n = wmx_build_frame(frame, sizeof frame, (unsigned)strtoul(argv[2], NULL, 10), (uint32_t)strtoul(argv[3], NULL, 10), payload, length);
    if (!n) printf("refused\n"); else { print_hex(frame, n < 64 ? n : 64); printf("\n"); }
    free(payload);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (strcmp(argv[1], "frame") == 0) return cmd_frame(argc, argv);
    if (strcmp(argv[1], "control") == 0) return cmd_control(argc, argv);
    if (strcmp(argv[1], "vectors") == 0) return cmd_vectors();
    if (strcmp(argv[1], "stream") == 0) return cmd_stream(argc, argv);
    if (strcmp(argv[1], "encode") == 0) return cmd_encode(argc, argv);
    if (strcmp(argv[1], "ctl") == 0) return cmd_ctl(argc, argv);
    return 2;
}
