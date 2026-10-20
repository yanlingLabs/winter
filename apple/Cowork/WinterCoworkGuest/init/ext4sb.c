#define _GNU_SOURCE
#include "ext4sb.h"

#include <fcntl.h>
#include <string.h>
#include <unistd.h>

static uint32_t crc_table[256];
static int crc_ready;

static void crc_init(void) {
    for (uint32_t n = 0; n < 256; n++) {
        uint32_t c = n;
        for (int k = 0; k < 8; k++) c = (c & 1) ? (c >> 1) ^ 0x82F63B78u : c >> 1;
        crc_table[n] = c;
    }
    crc_ready = 1;
}

uint32_t wg_crc32c_raw(uint32_t seed, const uint8_t *data, size_t length) {
    if (!crc_ready) crc_init();
    uint32_t crc = seed;
    for (size_t i = 0; i < length; i++) crc = crc_table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    return crc;
}

const char *wg_ext4_result_name(enum wg_ext4_result result) {
    switch (result) {
    case WG_EXT4_OK: return "ok";
    case WG_EXT4_IO: return "io";
    case WG_EXT4_MAGIC: return "magic";
    case WG_EXT4_GEOMETRY: return "geometry";
    case WG_EXT4_CHECKSUM: return "checksum";
    case WG_EXT4_UUID: return "uuid";
    case WG_EXT4_RECOVERY: return "recovery";
    case WG_EXT4_NOT_CLEAN: return "not-clean";
    }
    return "unknown";
}

static uint32_t le32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint16_t le16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

int wg_uuid_parse(const char *text, size_t length, uint8_t out[WG_UUID_BYTES]) {
    if (length != 36) return -1;
    size_t at = 0;
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (text[i] != '-') return -1; continue; }
        int hi = hex_nibble(text[i]);
        if (hi < 0) return -1;
        if (at % 2 == 0) out[at / 2] = (uint8_t)(hi << 4); else out[at / 2] |= (uint8_t)hi;
        at++;
    }
    return 0;
}

enum wg_ext4_result wg_ext4_check_superblock(const uint8_t sb[1024], const uint8_t expected_uuid[WG_UUID_BYTES]) {
    if (le16(sb + 0x38) != 0xEF53) return WG_EXT4_MAGIC;
    if (le32(sb + 0x18) != 2 || le32(sb + 0x4C) != 1) return WG_EXT4_GEOMETRY;
    if (sb[0x175] != 1 || le32(sb + 0x3FC) != wg_crc32c_raw(0xFFFFFFFFu, sb, 0x3FC)) return WG_EXT4_CHECKSUM;
    if (memcmp(sb + 0x68, expected_uuid, WG_UUID_BYTES) != 0) return WG_EXT4_UUID;
    if (le32(sb + 0x60) & 0x4u) return WG_EXT4_RECOVERY; /* INCOMPAT_RECOVER: needs_recovery */
    if ((le16(sb + 0x3A) & 0x3u) != 1u) return WG_EXT4_NOT_CLEAN; /* VALID_FS set, ERROR_FS clear */
    return WG_EXT4_OK;
}

enum wg_ext4_result wg_ext4_check_node(const char *path, const uint8_t expected_uuid[WG_UUID_BYTES]) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return WG_EXT4_IO;
    uint8_t sb[1024];
    size_t have = 0;
    while (have < sizeof sb) {
        ssize_t n = pread(fd, sb + have, sizeof sb - have, 1024 + (off_t)have);
        if (n <= 0) { close(fd); return WG_EXT4_IO; }
        have += (size_t)n;
    }
    close(fd);
    return wg_ext4_check_superblock(sb, expected_uuid);
}
