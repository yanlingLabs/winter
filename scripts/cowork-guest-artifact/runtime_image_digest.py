"""runtimeImageDigest = SHA-256( SHA-256(kernel) || SHA-256(initramfs.cpio) ), each inner digest the RAW 32 bytes.

The same rule the worker recomputes (apple/Cowork/WinterCoworkHVFWorker/Sources/WorkerNative/RuntimeImage.h) and the golden vectors in
apple/Cowork/WinterCoworkHVFWorker/Tests/fixtures/runtime-image.json pin; test_runtime_image_digest.py holds this file to those vectors.

    python3 runtime_image_digest.py KERNEL INITRAMFS_CPIO [KERNEL INITRAMFS_CPIO ...]

prints one JSON line per pair. Reads files only.
"""
import hashlib, json, sys
from pathlib import Path


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.digest()


def runtime_image_digest(kernel_sha256, initramfs_sha256):
    """From the two lowercase-hex file digests."""
    for value in (kernel_sha256, initramfs_sha256):
        if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("a digest must be 64 lowercase hex characters")
    return hashlib.sha256(bytes.fromhex(kernel_sha256) + bytes.fromhex(initramfs_sha256)).hexdigest()


def runtime_image_digest_of_files(kernel, initramfs):
    return runtime_image_digest(file_sha256(kernel).hex(), file_sha256(initramfs).hex())


def main(argv):
    if not argv or len(argv) % 2:
        raise SystemExit("usage: runtime_image_digest.py KERNEL INITRAMFS [KERNEL INITRAMFS ...]")
    for kernel, initramfs in zip(argv[::2], argv[1::2]):
        k, i = file_sha256(kernel).hex(), file_sha256(initramfs).hex()
        print(json.dumps({"kernelSha256": k, "initramfsSha256": i, "runtimeImageDigest": runtime_image_digest(k, i)}, sort_keys=True))


if __name__ == "__main__":
    main(sys.argv[1:])
