#include "RuntimeImage.h"

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int cw_artifact_open(const char *path) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) { close(fd); errno = EINVAL; return -1; }
    return fd;
}

static ssize_t real_pread(void *context, int fd, void *buffer, size_t length, off_t offset) {
    (void)context;
    return pread(fd, buffer, length, offset);
}

int cw_file_sha256(int fd, uint8_t out[32]) { return cw_file_sha256_with(fd, real_pread, NULL, out); }

int cw_file_sha256_with(int fd, cw_pread_fn reader, void *reader_context, uint8_t out[32]) {
    struct stat before, after;
    if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 0 || (unsigned long long)before.st_size > CW_ARTIFACT_MAX_BYTES) return -1;
    static uint8_t chunk[1u << 20];
    CC_SHA256_CTX context;
    CC_SHA256_Init(&context);
    off_t offset = 0;
    while (offset < before.st_size) {
        size_t want = (size_t)(before.st_size - offset) < sizeof chunk ? (size_t)(before.st_size - offset) : sizeof chunk;
        ssize_t got = reader(reader_context, fd, chunk, want, offset);
        if (got < 0 && errno == EINTR) continue;
        if (got <= 0) return -1; /* shorter than fstat said: it changed under us */
        CC_SHA256_Update(&context, chunk, (CC_LONG)got);
        offset += got;
    }
    if (fstat(fd, &after) != 0 || after.st_size != before.st_size || after.st_mtimespec.tv_sec != before.st_mtimespec.tv_sec
        || after.st_mtimespec.tv_nsec != before.st_mtimespec.tv_nsec) return -1;
    CC_SHA256_Final(out, &context);
    return 0;
}

void cw_runtime_image_digest(const uint8_t kernel[32], const uint8_t initramfs[32], uint8_t out[32]) {
    uint8_t joined[64];
    memcpy(joined, kernel, 32);
    memcpy(joined + 32, initramfs, 32);
    CC_SHA256(joined, (CC_LONG)sizeof joined, out);
}

int cw_runtime_image_verify(const char *kernel_path, const char *initramfs_path, const uint8_t expected[32], const char **reason) {
    uint8_t kernel[32], initramfs[32], digest[32];
    int kernel_fd = cw_artifact_open(kernel_path);
    if (kernel_fd < 0) { *reason = "kernel is not a readable regular file"; return CW_IMAGE_UNREADABLE; }
    int rc = cw_file_sha256(kernel_fd, kernel);
    close(kernel_fd);
    if (rc != 0) { *reason = "kernel could not be hashed"; return CW_IMAGE_UNREADABLE; }
    int initramfs_fd = cw_artifact_open(initramfs_path);
    if (initramfs_fd < 0) { *reason = "initramfs is not a readable regular file"; return CW_IMAGE_UNREADABLE; }
    rc = cw_file_sha256(initramfs_fd, initramfs);
    close(initramfs_fd);
    if (rc != 0) { *reason = "initramfs could not be hashed"; return CW_IMAGE_UNREADABLE; }
    cw_runtime_image_digest(kernel, initramfs, digest);
    if (memcmp(digest, expected, 32) != 0) { *reason = "runtime image digest mismatch"; return CW_IMAGE_MISMATCH; }
    return CW_IMAGE_OK;
}
