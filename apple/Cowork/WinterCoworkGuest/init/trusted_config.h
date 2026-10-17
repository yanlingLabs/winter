/*
 * The supervisor's trusted configuration, written by PID 1 (N2 slice S5).
 *
 * The supervisor (linux-supervisor.py, `--trusted-config-fd`) wants one regular, root-owned file without group/other write
 * bits, at most 64 KiB, and its `guestBootId` must equal the live /proc/sys/kernel/random/boot_id. PID 1 therefore
 *   * takes the STATIC part from a root-owned file inside the immutable initramfs (artifact paths and digests, environment
 *     root, control directory: image.py writes it, the cpio digest pins it), never from L4;
 *   * takes the CONVERSATION SET from the bootstrap helper's validated copy of the host's `conversations` message (contract round 3,
 *     section 6.1), never from a file: the supervisor refuses an empty set, so PID 1 starts it only when one was delivered;
 *   * for a host-query profile splices the runtime artifact pins (from the initramfs) under the profile's key;
 *   * adds the live boot id itself.
 * PID 1 does not understand the JSON it splices: it checks the shape (one printable-ASCII line, balanced, bounded), refuses
 * a static part that names `guestBootId` or `conversations` (so neither can be overridden by a duplicate key) and leaves every
 * semantic check to the supervisor, which refuses on any mismatch. Portable POSIX.
 */
#ifndef WG_TRUSTED_CONFIG_H
#define WG_TRUSTED_CONFIG_H

#include <stddef.h>

#define WG_CONFIG_MAX_BYTES 60000u      /* the supervisor refuses more than 65536 */
#define WG_CONFIG_BASE_MAX 8192u
#define WG_CONFIG_CONVERSATIONS_MAX 49152u
#define WG_CONFIG_RUNTIME_ARTIFACTS_MAX 4096u

enum wg_config_result {
    WG_CONFIG_OK = 0,
    WG_CONFIG_BOOT_ID,
    WG_CONFIG_BASE_SHAPE,
    WG_CONFIG_BASE_FORBIDDEN_KEY,
    WG_CONFIG_CONVERSATIONS_SHAPE,
    WG_CONFIG_TOO_LARGE,
    WG_CONFIG_RUNTIME_SHAPE
};

/* Output: {"guestBootId":"<id>","conversations":<array>[,<static members>][,"<runtime_key>":<artifacts>]}  (no trailing newline).
 * `runtime_key` is NULL for a tools-only set, otherwise "hostQueryRuntime" or "hostQueryGuidedRuntime" and `runtime_artifacts` the
 * object that goes under it. */
enum wg_config_result wg_build_trusted_config(const char *boot_id, const char *base, size_t base_length, const char *conversations,
                                              size_t conversations_length, const char *runtime_key, const char *runtime_artifacts,
                                              size_t runtime_artifacts_length, char *out, size_t capacity, size_t *out_length);

/* A single balanced printable-ASCII JSON text of the given kind ('{' or '['), string-aware. */
int wg_json_text_shape(const char *text, size_t length, char opening, size_t maximum);
int wg_boot_id_ok(const char *text);

/* Creates `<directory>/<name>` with O_EXCL|O_NOFOLLOW, mode 0400 (the caller's umask is irrelevant), writes `text`, and returns a
 * NEW read-only descriptor for it (>= 3, close-on-exec), or -1. The writing descriptor is closed. */
int wg_write_trusted_config(const char *directory, const char *name, const char *text, size_t length);

#ifdef WG_TEST_SEAMS
/* Test builds only (not compiled into PID 1): replaces the fsync of the written config (NULL = the real one) and sets a hook that runs between the close
 * of the written file and the read-only descriptor's verification (a test plants a second link, a different mode or a longer file there). */
void wg_trusted_config_test_seams(int (*fsync_fn)(int), void (*race_hook)(const char *path));
#endif

/* Reads a whole small regular file (root-owned, no group/other write bits unless `any_owner`) into `out`; returns its length or -1. */
long wg_read_small_file(const char *path, char *out, size_t capacity, int any_owner);

#endif
