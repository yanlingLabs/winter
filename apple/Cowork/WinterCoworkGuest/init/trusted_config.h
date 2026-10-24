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
#include <stdint.h>

#define WG_CONFIG_MAX_BYTES 60000u      /* the supervisor refuses more than 65536 */
#define WG_CONFIG_BASE_MAX 8192u
#define WG_CONFIG_CONVERSATIONS_MAX 49152u
#define WG_CONFIG_RUNTIME_MAX 16384u            /* the object under hostQueryRuntime / hostQueryGuidedRuntime; the guided one carries `reader` with up to WG_READER_DEPENDENCIES_MAX dependencies */
#define WG_READER_DEPENDENCIES_MAX 32u
/* Root-side path of the guided conversation's guidance directory (the supervisor's `guidanceDirectory`): the directory the skeleton makes for the tool
 * view's `/run/winter/shared-instructions`. Empty in the first session (no host-backed shares, decision D10). */
#define WG_GUIDANCE_DIRECTORY "/run/winter/shared-instructions"

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

/* The object that goes under `hostQueryRuntime` (profile 1) or `hostQueryGuidedRuntime` (profile 2), checked against exactly what the supervisor reads
 * (agent-sdk 68e57c64, vectors/sdk-guided-config.json): compact JSON without escapes, no duplicate or unknown key, every digest 64 lowercase hex.
 *   profile 1: {"artifacts":{"executable":P,"launcher":P,"ownerLibrary":P}}
 *   profile 2: the same plus "reader":{"artifacts":{"executable":P,"launcher":P},"dependencies":[{"guestPath","path","sha256"},...],"uid":N}
 * where P = {"path":<absolute path>,"sha256":<digest>}, `dependencies` is PRESENT and may be empty (at most WG_READER_DEPENDENCIES_MAX, guest paths under
 * /lib/ /lib64/ /usr/lib/ with no empty, "." or ".." component and none equal to or inside another) and `uid` is outside the range the host can assign
 * (65534 or 65535), so no runtime uid, tool uid or workspace gid can ever equal it. `reader` is absent for profile 1. Returns 1 when valid. */
int wg_runtime_block_valid(unsigned profile, const char *text, size_t length);

/* The per-conversation `guidanceDirectory` the supervisor requires of a guided conversation and refuses on any other (`runtime_config`): for profile 2 the
 * conversations text names exactly `count` of them, each WG_GUIDANCE_DIRECTORY; for any other profile it names none. Returns 1 when that holds. */
int wg_guidance_members_ok(unsigned profile, unsigned count, const char *conversations, size_t length);

#ifdef WG_FILE_CHANNEL_V1
/* Adds `"fileChannel":{"browseUid":N,"dataDevice":D}` as the last member of a config built above (image with `file-channel-v1` only). `browse_uid` must be in the
 * contract's unixId range and `data_device` non-zero; the config must not already name `fileChannel` (the static part is not allowed to). 0 = added. */
int wg_add_file_channel(char *config, size_t length, size_t capacity, uint32_t browse_uid, uint64_t data_device, size_t *out_length);
#endif

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
