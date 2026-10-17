/* RuntimeImage: `runtimeImageDigest`, recomputed by the worker (docs/cowork-native-worker.md section 5, "The worker process").
 *
 *   runtimeImageDigest = SHA-256( SHA-256(kernel) || SHA-256(initramfs.cpio) )      each inner digest the RAW 32 bytes
 *
 * A worker that recomputes it and finds another value refuses the scope: fault bad_scope, exit 71. Pinned by the golden vectors in
 * runtime-image.json (S1 commit abb2f361).
 *
 * THE HASH-THEN-LOAD WINDOW (reported, not closed): the worker hashes the artifacts from descriptors it opened with O_NOFOLLOW, and
 * libkrun later opens the SAME PATHS itself (`krun_set_kernel` stats the initramfs path and stores both; `krun_start_enter` reads them
 * with std::fs::read). Between the two a writer to the directory next to the worker could swap a file. The directory is inside the
 * signed bundle, the worker runs as the user, and the sandbox gives the process read access only, but the window exists and the digest
 * proves what was on disk when it was hashed, not what libkrun loads. If libkrun accepts /dev/fd/N paths, handing it the hashed
 * descriptors (rewound with lseek, with (allow file-read* (subpath "/dev/fd")) in the profile) would close it; that is a proposal for G0
 * to try, not something this slice enables. The directory components are not O_NOFOLLOW'd (only the last one): the executable's
 * directory is realpath'd and the `cowork-guest` directory is lstat'd before the sandbox.
 */
#ifndef WINTER_COWORK_WORKER_RUNTIME_IMAGE_H
#define WINTER_COWORK_WORKER_RUNTIME_IMAGE_H

#include "WorkerCommon.h"

#include <sys/types.h>

/* Refuse to hash anything larger than this (the real initramfs is about 321 MiB). */
#define CW_ARTIFACT_MAX_BYTES (4ull << 30)

/* Open for hashing: O_RDONLY | O_NOFOLLOW | O_CLOEXEC, and it must be a regular file. Returns a descriptor or -1. */
int cw_artifact_open(const char *path);
/* SHA-256 of the whole file, read through `pread` in 1 MiB pieces from offset 0. The size must not change while it is read. 0 or -1. */
int cw_file_sha256(int fd, uint8_t out[32]);
/* The same with the read injected, so a file that shrinks or changes WHILE it is read can be tested without a second thread. */
typedef ssize_t (*cw_pread_fn)(void *context, int fd, void *buffer, size_t length, off_t offset);
int cw_file_sha256_with(int fd, cw_pread_fn reader, void *context, uint8_t out[32]);
/* SHA-256(kernel_raw || initramfs_raw). */
void cw_runtime_image_digest(const uint8_t kernel[32], const uint8_t initramfs[32], uint8_t out[32]);

enum { CW_IMAGE_OK = 0, CW_IMAGE_MISMATCH = 1, CW_IMAGE_UNREADABLE = 2 };
/* Hash both artifacts and compare. `reason` is fixed text. */
int cw_runtime_image_verify(const char *kernel_path, const char *initramfs_path, const uint8_t expected[32], const char **reason);

#endif
