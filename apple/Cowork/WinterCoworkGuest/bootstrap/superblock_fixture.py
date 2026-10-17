"""Superblock fixtures for the guest tests: a synthetic ext4 superblock with a valid metadata checksum. Test helper only; the
guest image never contains it."""
import struct

import guest_bootstrap as gb

UUID_A = "11111111-2222-4333-8444-555555555555"
REQUIRED_COMPAT = 0x4 | 0x20
REQUIRED_INCOMPAT = 0x2 | 0x40 | 0x80 | 0x200
REQUIRED_RO = 0x1 | 0x2 | 0x8 | 0x20 | 0x40 | 0x400


def make_sb(uuid_text=UUID_A, blocks=4096, compat=0, incompat=0, ro=0, state=1, log_block_size=2, inode_size=256, rev=1,
            magic=0xEF53, checksum_type=1, break_checksum=False):
    sb = bytearray(1024)
    struct.pack_into("<I", sb, 4, blocks & 0xFFFFFFFF)
    struct.pack_into("<I", sb, 0x150, blocks >> 32)
    struct.pack_into("<I", sb, 0x18, log_block_size)
    struct.pack_into("<H", sb, 0x38, magic)
    struct.pack_into("<H", sb, 0x3A, state)
    struct.pack_into("<I", sb, 0x4C, rev)
    struct.pack_into("<H", sb, 0x58, inode_size)
    struct.pack_into("<III", sb, 0x5C, REQUIRED_COMPAT | compat, REQUIRED_INCOMPAT | incompat, REQUIRED_RO | ro)
    sb[0x68:0x78] = bytes.fromhex(uuid_text.replace("-", ""))
    sb[0x175] = checksum_type
    crc = gb.crc32c_raw(bytes(sb[:0x3FC]))
    struct.pack_into("<I", sb, 0x3FC, crc ^ 1 if break_checksum else crc)
    return bytes(sb)


def write_image(path, capacity, sb=None):
    with open(path, "wb") as handle:
        handle.truncate(capacity)
        if sb is not None:
            handle.seek(1024)
            handle.write(sb)
