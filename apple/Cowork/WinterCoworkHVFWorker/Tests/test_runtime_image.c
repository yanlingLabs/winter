/* runtimeImageDigest = SHA-256( SHA-256(kernel) || SHA-256(initramfs) ), each part raw. S1's golden vectors, the file hashing (chunk
 * boundaries, O_NOFOLLOW, regular files only, a file that changes while it is read) and the verify step. Temp files only. */
#include "RuntimeImage.h"
#include "test_support.h"
#include "vectors.h"

#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/time.h>

static char directory[1024];

static void unhex(const char *hex, uint8_t *out, size_t length) {
    for (size_t i = 0; i < length; i++) { unsigned v = 0; sscanf(hex + 2 * i, "%2x", &v); out[i] = (uint8_t)v; }
}
static void make_directory(void) {
    const char *base = getenv("TMPDIR");
    snprintf(directory, sizeof directory, "%s/cw-image-XXXXXX", base != NULL && base[0] != 0 ? base : "/tmp");
    if (mkdtemp(directory) == NULL) { perror("mkdtemp"); exit(1); }
}
static void write_file(const char *name, const uint8_t *data, size_t length, char *path, size_t path_size) {
    snprintf(path, path_size, "%s/%s", directory, name);
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    CHECK(fd >= 3);
    size_t done = 0;
    while (done < length) { ssize_t n = write(fd, data + done, length - done); if (n <= 0) break; done += (size_t)n; }
    CHECK(done == length);
    close(fd);
}

static void golden_vectors(void) {
    CHECK(IMAGE_VECTOR_COUNT == 2);
    for (size_t i = 0; i < IMAGE_VECTOR_COUNT; i++) {
        uint8_t kernel[32], initramfs[32], expected[32], got[32];
        unhex(image_vectors[i].kernel_sha256, kernel, 32);
        unhex(image_vectors[i].initramfs_sha256, initramfs, 32);
        unhex(image_vectors[i].digest, expected, 32);
        cw_runtime_image_digest(kernel, initramfs, got);
        CHECK(memcmp(got, expected, 32) == 0);
        /* order matters: swapping the parts must give another value (the second vector is the first with its parts swapped) */
        uint8_t swapped[32];
        cw_runtime_image_digest(initramfs, kernel, swapped);
        CHECK(memcmp(swapped, expected, 32) != 0);
    }
    uint8_t first[32], second[32];
    unhex(image_vectors[0].digest, first, 32);
    unhex(image_vectors[1].digest, second, 32);
    CHECK(memcmp(first, second, 32) != 0);
}

static void hashing(void) {
    const size_t sizes[] = { 0, 1, 63, 64, (1u << 20) - 1, 1u << 20, (1u << 20) + 1, 3 * (1u << 20) + 17 }; /* every side of the 1 MiB chunk */
    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
        uint8_t *data = malloc(sizes[i] + 1);
        for (size_t k = 0; k < sizes[i]; k++) data[k] = (uint8_t)(k * 131 + i);
        char path[1200];
        write_file("hashed", data, sizes[i], path, sizeof path);
        uint8_t expected[32], got[32];
        CC_SHA256(data, (CC_LONG)sizes[i], expected);
        int fd = cw_artifact_open(path);
        CHECK(fd >= 3);
        CHECK(cw_file_sha256(fd, got) == 0 && memcmp(got, expected, 32) == 0);
        close(fd);
        free(data);
        unlink(path);
    }
}

static void opening(void) {
    char path[1200], link[1300], file[1300];
    uint8_t data[8] = "winter";
    write_file("real", data, sizeof data, path, sizeof path);
    snprintf(link, sizeof link, "%s/link", directory);
    CHECK(symlink(path, link) == 0);
    CHECK(cw_artifact_open(path) >= 3);
    int fd = cw_artifact_open(link);                 /* O_NOFOLLOW: a symlink in the last component is refused */
    CHECK(fd < 0);
    if (fd >= 0) close(fd);
    CHECK(cw_artifact_open(directory) < 0);          /* not a regular file */
    CHECK(cw_artifact_open("/dev/null") < 0);
    snprintf(file, sizeof file, "%s/missing", directory);
    CHECK(cw_artifact_open(file) < 0);
    int dir = open(directory, O_RDONLY);
    uint8_t out[32];
    CHECK(cw_file_sha256(dir, out) == -1);           /* the hasher itself refuses anything but a regular file */
    close(dir);
    unlink(link);
    unlink(path);
}

static void changing_while_read(void) {
    /* A file whose size differs from what fstat promised is refused. Simulated by truncating after open and before hashing starts is not a
     * race; the check that matters is the one at the end (size and mtime unchanged), exercised by touching the mtime between the two fstats
     * through a helper thread-free trick: hash a file, then change it, then hash the stale expectation. */
    char path[1200];
    uint8_t data[4096];
    memset(data, 7, sizeof data);
    write_file("shifting", data, sizeof data, path, sizeof path);
    int fd = cw_artifact_open(path);
    uint8_t first[32], second[32];
    CHECK(cw_file_sha256(fd, first) == 0);
    data[100] = 8;
    int writer = open(path, O_WRONLY);
    CHECK(pwrite(writer, data, sizeof data, 0) == (ssize_t)sizeof data);
    close(writer);
    CHECK(cw_file_sha256(fd, second) == 0);          /* a new, whole read of the new content */
    CHECK(memcmp(first, second, 32) != 0);           /* the digest follows the bytes, nothing is cached */
    close(fd);
    unlink(path);
}

typedef struct { int calls; int mode; off_t shrink_to; const char *path; } hook_state;
enum { HOOK_PLAIN = 0, HOOK_SHRINK = 1, HOOK_TOUCH = 2, HOOK_GROW = 3, HOOK_GROW_SAME_MTIME = 4 };
static ssize_t hooked_pread(void *context, int fd, void *buffer, size_t length, off_t offset) {
    hook_state *state = context;
    state->calls++;
    if (state->calls == 2 && state->mode == HOOK_SHRINK) return 0;                   /* the file ended early */
    if (state->calls == 2 && state->mode == HOOK_TOUCH) {                           /* same size, new mtime */
        struct timeval times[2] = { { 1000000000, 0 }, { 1000000000, 0 } };
        CHECK(futimes(fd, times) == 0);
    }
    if (state->calls == 2 && state->mode == HOOK_GROW) CHECK(truncate(state->path, state->shrink_to) == 0);
    if (state->calls == 2 && state->mode == HOOK_GROW_SAME_MTIME) {                 /* a longer file whose mtime was put back */
        CHECK(truncate(state->path, state->shrink_to) == 0);
        struct timeval times[2] = { { 1000000000, 0 }, { 1000000000, 0 } };
        CHECK(futimes(fd, times) == 0);
    }
    return pread(fd, buffer, length, offset);
}

static void racing_reads(void) {
    char path[1200];
    size_t size = 3 * (1u << 20) + 5;                 /* four reads */
    uint8_t *data = calloc(size, 1);
    memset(data, 9, size);
    write_file("racing", data, size, path, sizeof path);
    uint8_t out[32], sentinel[32];
    memset(sentinel, 0xab, 32);
    for (int mode = HOOK_PLAIN; mode <= HOOK_GROW_SAME_MTIME; mode++) {
        int fd = cw_artifact_open(path);
        CHECK(fd >= 3);
        if (mode == HOOK_GROW_SAME_MTIME) { struct timeval times[2] = { { 1000000000, 0 }, { 1000000000, 0 } }; CHECK(futimes(fd, times) == 0); }
        hook_state state = { 0, mode, (off_t)size + 100, path };
        memcpy(out, sentinel, 32);
        int rc = cw_file_sha256_with(fd, hooked_pread, &state, out);
        if (mode == HOOK_PLAIN) CHECK(rc == 0 && state.calls == 4);
        else CHECK(rc == -1 && memcmp(out, sentinel, 32) == 0);      /* a short read, a touched mtime, a changed size: no digest at all */
        close(fd);
        CHECK(truncate(path, (off_t)size) == 0);
    }
    /* A file larger than the cap is refused before one byte is read (sparse, so it costs nothing). */
    write_file("huge", data, 1, path, sizeof path);
    int fd = open(path, O_RDWR);
    CHECK(fd >= 3 && ftruncate(fd, (off_t)CW_ARTIFACT_MAX_BYTES + 1) == 0);
    hook_state counting = { 0, HOOK_PLAIN, 0, path };
    CHECK(cw_file_sha256_with(fd, hooked_pread, &counting, out) == -1 && counting.calls == 0);
    CHECK(ftruncate(fd, (off_t)CW_ARTIFACT_MAX_BYTES) == 0);                   /* exactly the cap is allowed: the bound is inclusive */
    CHECK(cw_file_sha256_with(fd, hooked_pread, &counting, out) == 0 && counting.calls > 0);
    close(fd);
    unlink(path);
    free(data);
}

static void verify(void) {
    char kernel[1200], initramfs[1200], missing[1300];
    uint8_t k[100], i2[200];
    memset(k, 1, sizeof k);
    memset(i2, 2, sizeof i2);
    write_file("kernel", k, sizeof k, kernel, sizeof kernel);
    write_file("initramfs.cpio", i2, sizeof i2, initramfs, sizeof initramfs);
    uint8_t kd[32], id[32], expected[32], wrong[32];
    CC_SHA256(k, sizeof k, kd);
    CC_SHA256(i2, sizeof i2, id);
    cw_runtime_image_digest(kd, id, expected);
    const char *reason = NULL;
    CHECK(cw_runtime_image_verify(kernel, initramfs, expected, &reason) == CW_IMAGE_OK);
    memcpy(wrong, expected, 32);
    wrong[31] ^= 1;
    CHECK(cw_runtime_image_verify(kernel, initramfs, wrong, &reason) == CW_IMAGE_MISMATCH);
    CHECK_STR(reason, "runtime image digest mismatch");
    /* The parts are not interchangeable and the digest covers both. */
    CHECK(cw_runtime_image_verify(initramfs, kernel, expected, &reason) == CW_IMAGE_MISMATCH);
    k[50] ^= 1;
    write_file("kernel", k, sizeof k, kernel, sizeof kernel);
    CHECK(cw_runtime_image_verify(kernel, initramfs, expected, &reason) == CW_IMAGE_MISMATCH); /* one flipped bit in the kernel */
    k[50] ^= 1;
    write_file("kernel", k, sizeof k, kernel, sizeof kernel);
    i2[199] ^= 1;
    write_file("initramfs.cpio", i2, sizeof i2, initramfs, sizeof initramfs);
    CHECK(cw_runtime_image_verify(kernel, initramfs, expected, &reason) == CW_IMAGE_MISMATCH); /* and in the initramfs */
    snprintf(missing, sizeof missing, "%s/absent", directory);
    CHECK(cw_runtime_image_verify(missing, initramfs, expected, &reason) == CW_IMAGE_UNREADABLE);
    CHECK_STR(reason, "kernel is not a readable regular file");
    CHECK(cw_runtime_image_verify(kernel, missing, expected, &reason) == CW_IMAGE_UNREADABLE);
    CHECK_STR(reason, "initramfs is not a readable regular file");
    /* A symlink in place of either artifact is refused, not followed. */
    char link[1300];
    snprintf(link, sizeof link, "%s/kernel-link", directory);
    CHECK(symlink(kernel, link) == 0);
    CHECK(cw_runtime_image_verify(link, initramfs, expected, &reason) == CW_IMAGE_UNREADABLE);
    unlink(link);
    unlink(kernel);
    unlink(initramfs);
}

int main(void) {
    make_directory();
    golden_vectors();
    hashing();
    opening();
    changing_while_read();
    racing_reads();
    verify();
    rmdir(directory);
    return cw_test_finish("test_runtime_image");
}
