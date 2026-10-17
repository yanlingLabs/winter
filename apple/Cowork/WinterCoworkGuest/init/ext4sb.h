/*
 * The last look PID 1 takes at an ext4 volume before it mounts it (N2 slice S5): the 1 KiB superblock at byte 1024 must be
 * a self-consistent ext4 superblock (magic, 4 KiB blocks, dynamic revision, valid metadata checksum), carry exactly the
 * UUID the bootstrap receipt named, show no pending journal recovery (a mount would replay it unrecorded) and be clean.
 * The bootstrap helper already proved the exact feature set; this is the independent, tiny second check made by the
 * process that actually calls mount(2). Portable POSIX.
 */
#ifndef WG_EXT4SB_H
#define WG_EXT4SB_H

#include <stddef.h>
#include <stdint.h>

#define WG_UUID_BYTES 16u

enum wg_ext4_result {
    WG_EXT4_OK = 0,
    WG_EXT4_IO,
    WG_EXT4_MAGIC,
    WG_EXT4_GEOMETRY,
    WG_EXT4_CHECKSUM,
    WG_EXT4_UUID,
    WG_EXT4_RECOVERY,
    WG_EXT4_NOT_CLEAN
};
const char *wg_ext4_result_name(enum wg_ext4_result result);

/* CRC-32C with the caller's seed and no final inversion (the ext4 convention). */
uint32_t wg_crc32c_raw(uint32_t seed, const uint8_t *data, size_t length);
/* "8-4-4-4-12" lowercase hex -> 16 bytes. Returns 0 or -1. */
int wg_uuid_parse(const char *text, size_t length, uint8_t out[WG_UUID_BYTES]);
enum wg_ext4_result wg_ext4_check_superblock(const uint8_t superblock[1024], const uint8_t expected_uuid[WG_UUID_BYTES]);
enum wg_ext4_result wg_ext4_check_node(const char *path, const uint8_t expected_uuid[WG_UUID_BYTES]);

#endif
