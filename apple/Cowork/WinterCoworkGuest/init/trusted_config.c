#define _GNU_SOURCE
#include "trusted_config.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int wg_boot_id_ok(const char *text) {
    if (!text || strlen(text) != 36) return 0;
    for (size_t i = 0; i < 36; i++) {
        char c = text[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return 0; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return 1;
}

int wg_json_text_shape(const char *text, size_t length, char opening, size_t maximum) {
    if (!text || length < 2 || length > maximum) return 0;
    char closing = opening == '{' ? '}' : ']';
    if (text[0] != opening || text[length - 1] != closing) return 0;
    int depth = 0, in_string = 0;
    for (size_t i = 0; i < length; i++) {
        unsigned char c = (unsigned char)text[i];
        if (c < 0x20 || c > 0x7e) return 0;
        if (in_string) {
            if (c == '\\') { if (++i >= length) return 0; }
            else if (c == '"') in_string = 0;
            continue;
        }
        if (c == '"') in_string = 1;
        else if (c == '{' || c == '[') { if (++depth > 32) return 0; }
        else if (c == '}' || c == ']') { if (--depth < 0) return 0; if (depth == 0 && i != length - 1) return 0; }
    }
    return depth == 0 && !in_string;
}

/* Does the top-level object name `key`? Structural, not a substring: a string value or a nested key that merely mentions the word is
 * fine (a protected path may well contain "conversations"). A top-level key spelled with an escape is refused outright, because the
 * JSON parser downstream would decode it and a duplicate of a key PID 1 supplies could then override ours. Returns -1 for the escape. */
static int top_level_key(const char *text, size_t length, const char *key) {
    size_t key_length = strlen(key);
    int depth = 0;
    for (size_t i = 0; i < length; i++) {
        char c = text[i];
        if (c == '"') {
            size_t start = ++i;
            int escaped = 0;
            while (i < length && text[i] != '"') { if (text[i] == '\\') { escaped = 1; i++; } i++; }
            size_t end = i;   /* the closing quote */
            if (depth == 1) {
                size_t after = end + 1;
                while (after < length && text[after] == ' ') after++;
                if (after < length && text[after] == ':') {
                    if (escaped) return -1;
                    if (end - start == key_length && memcmp(text + start, key, key_length) == 0) return 1;
                }
            }
        } else if (c == '{' || c == '[') {
            depth++;
        } else if (c == '}' || c == ']') {
            depth--;
        }
    }
    return 0;
}

/* ---- the runtime object, checked against what the supervisor reads ------------------------------------------------------------------------- */

struct jp { const char *s; size_t n, i; };

static int jp_char(struct jp *p, char c) {
    if (p->i < p->n && p->s[p->i] == c) { p->i++; return 1; }
    return 0;
}
/* A string without escapes: printable ASCII from '!' to '~' (no space; the upper end is the caller's wg_json_text_shape) except '"' and '\\'. */
static int jp_string(struct jp *p, const char **out, size_t *length) {
    if (!jp_char(p, '"')) return 0;
    size_t start = p->i;
    while (p->i < p->n && p->s[p->i] != '"') {
        unsigned char c = (unsigned char)p->s[p->i];
        if (c < 0x21 || c == '\\') return 0;   /* wg_json_text_shape has already refused anything above '~' */
        p->i++;
    }
    if (p->i >= p->n) return 0;
    *out = p->s + start;
    *length = p->i - start;
    p->i++;
    return 1;
}
/* A positive decimal without sign or leading zero and no larger than `maximum`; digits are consumed only while the value stays within it. */
static int jp_uint(struct jp *p, unsigned long maximum, unsigned long *value) {
    if (p->i >= p->n || p->s[p->i] < '1' || p->s[p->i] > '9') return 0;
    unsigned long v = 0;
    while (p->i < p->n && p->s[p->i] >= '0' && p->s[p->i] <= '9') {
        v = v * 10 + (unsigned long)(p->s[p->i] - '0');
        if (v > maximum) return 0;
        p->i++;
    }
    *value = v;
    return 1;
}
/* {"a":V,"b":V,...} with exactly the names given (any order, each once); `member(p, ctx, index)` parses the value of names[index]. */
typedef int (*jp_member)(struct jp *p, void *ctx, size_t index);
static int jp_object(struct jp *p, const char *const *names, size_t count, jp_member member, void *ctx) {
    unsigned seen = 0;
    if (!jp_char(p, '{')) return 0;
    for (size_t k = 0; k < count; k++) {
        if (k > 0 && !jp_char(p, ',')) return 0;
        const char *key;
        size_t key_length;
        if (!jp_string(p, &key, &key_length) || !jp_char(p, ':')) return 0;
        size_t index = count;
        for (size_t j = 0; j < count; j++) if (strlen(names[j]) == key_length && memcmp(names[j], key, key_length) == 0) index = j;
        if (index == count || (seen & (1u << index))) return 0;   /* unknown or repeated */
        seen |= 1u << index;
        if (!member(p, ctx, index)) return 0;
    }
    return jp_char(p, '}');
}
/* A path every part of which is non-empty and neither "." nor ".." (value[1:].split('/') in the supervisor's reader_dependency_path). */
static int path_parts_ok(const char *s, size_t n) {
    size_t start = 1;
    for (size_t i = 1; i <= n; i++) {
        if (i == n || s[i] == '/') {
            size_t length = i - start;
            if (length == 0 || (length == 1 && s[start] == '.') || (length == 2 && s[start] == '.' && s[start + 1] == '.')) return 0;
            start = i + 1;
        }
    }
    return 1;
}
static int has_prefix(const char *s, size_t n, const char *prefix) {
    size_t m = strlen(prefix);
    return n >= m && memcmp(s, prefix, m) == 0;
}
static int is_lower_hex_digest(const char *s, size_t n) {
    if (n != 64) return 0;
    for (size_t i = 0; i < n; i++) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return 0;
    return 1;
}

static const char *const PIN_NAMES[2] = { "path", "sha256" };
static int pin_member(struct jp *p, void *ctx, size_t index) {
    (void)ctx;
    const char *s;
    size_t n;
    if (!jp_string(p, &s, &n)) return 0;
    if (index == 0) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);   /* an absolute, canonical path ("/" has an empty part) */
    return is_lower_hex_digest(s, n);
}
static int jp_pin(struct jp *p) { return jp_object(p, PIN_NAMES, 2, pin_member, NULL); }

static const char *const RUNTIME_ARTIFACT_NAMES[3] = { "executable", "launcher", "ownerLibrary" };
static int runtime_artifact_member(struct jp *p, void *ctx, size_t index) { (void)ctx; (void)index; return jp_pin(p); }
static const char *const READER_ARTIFACT_NAMES[2] = { "executable", "launcher" };
static const char *const DEPENDENCY_NAMES[3] = { "guestPath", "path", "sha256" };

struct dependencies { const char *guest[WG_READER_DEPENDENCIES_MAX]; size_t length[WG_READER_DEPENDENCIES_MAX]; size_t count; };
static int dependency_member(struct jp *p, void *ctx, size_t index) {
    struct dependencies *d = ctx;
    const char *s;
    size_t n;
    if (!jp_string(p, &s, &n)) return 0;
    if (index == 0) {   /* guestPath: the supervisor's reader_dependency_path, and no pair equal or one inside the other */
        if (n > 1024 || !(has_prefix(s, n, "/lib/") || has_prefix(s, n, "/lib64/") || has_prefix(s, n, "/usr/lib/")) || !path_parts_ok(s, n)) return 0;
        for (size_t k = 0; k < d->count; k++) {
            size_t m = d->length[k] < n ? d->length[k] : n;
            if (memcmp(d->guest[k], s, m) == 0 && (d->length[k] == n || (d->length[k] < n ? s[m] == '/' : d->guest[k][m] == '/'))) return 0;
        }
        d->guest[d->count] = s;
        d->length[d->count] = n;
        return 1;
    }
    if (index == 1) return n <= 1024 && s[0] == '/' && path_parts_ok(s, n);
    return is_lower_hex_digest(s, n);
}
static int jp_dependencies(struct jp *p) {
    struct dependencies d;
    memset(&d, 0, sizeof d);
    if (!jp_char(p, '[')) return 0;
    if (jp_char(p, ']')) return 1;   /* present and empty is allowed; absent is not (the object requires the key) */
    for (;;) {
        if (d.count >= WG_READER_DEPENDENCIES_MAX) return 0;
        if (!jp_object(p, DEPENDENCY_NAMES, 3, dependency_member, &d)) return 0;
        d.count++;
        if (jp_char(p, ']')) return 1;
        if (!jp_char(p, ',')) return 0;
    }
}
static int reader_artifact_member(struct jp *p, void *ctx, size_t index) { (void)ctx; (void)index; return jp_pin(p); }
static const char *const READER_NAMES[3] = { "artifacts", "dependencies", "uid" };
static int reader_member(struct jp *p, void *ctx, size_t index) {
    (void)ctx;
    if (index == 0) return jp_object(p, READER_ARTIFACT_NAMES, 2, reader_artifact_member, NULL);
    if (index == 1) return jp_dependencies(p);
    unsigned long uid;   /* 65534 or 65535: inside the supervisor's 1000 to 65535, outside the 1000 to 65533 the host can assign */
    return jp_uint(p, 65535ul, &uid) && uid >= 65534ul;
}
static int block_member(struct jp *p, void *ctx, size_t index) {
    (void)ctx;
    if (index == 0) return jp_object(p, RUNTIME_ARTIFACT_NAMES, 3, runtime_artifact_member, NULL);
    return jp_object(p, READER_NAMES, 3, reader_member, NULL);
}

int wg_runtime_block_valid(unsigned profile, const char *text, size_t length) {
    static const char *const V1[1] = { "artifacts" };
    static const char *const GUIDED[2] = { "artifacts", "reader" };
    if (profile != 1 && profile != 2) return 0;
    if (!wg_json_text_shape(text, length, '{', WG_CONFIG_RUNTIME_MAX)) return 0;
    struct jp p = { text, length, 0 };
    return jp_object(&p, profile == 2 ? GUIDED : V1, profile == 2 ? 2 : 1, block_member, NULL);   /* the text is balanced, so the object's closing brace is its last byte */
}

static size_t count_occurrences(const char *text, size_t length, const char *needle) {
    size_t m = strlen(needle), count = 0;
    for (size_t i = 0; i + m <= length; i++) if (memcmp(text + i, needle, m) == 0) count++;
    return count;
}
int wg_guidance_members_ok(unsigned profile, unsigned count, const char *conversations, size_t length) {
    size_t named = count_occurrences(conversations, length, "\"guidanceDirectory\"");
    if (profile != 2) return named == 0;
    if (named != count) return 0;
    size_t exact = count_occurrences(conversations, length, "\"guidanceDirectory\":\"" WG_GUIDANCE_DIRECTORY "\"");
    return !(exact < named);   /* none of the members names another directory */
}

enum wg_config_result wg_build_trusted_config(const char *boot_id, const char *base, size_t base_length, const char *conversations,
                                              size_t conversations_length, const char *runtime_key, const char *runtime_artifacts,
                                              size_t runtime_artifacts_length, char *out, size_t capacity, size_t *out_length) {
    if (!wg_boot_id_ok(boot_id)) return WG_CONFIG_BOOT_ID;
    if (!wg_json_text_shape(base, base_length, '{', WG_CONFIG_BASE_MAX)) return WG_CONFIG_BASE_SHAPE;
    if (top_level_key(base, base_length, "guestBootId") != 0 || top_level_key(base, base_length, "conversations") != 0 ||
        top_level_key(base, base_length, "hostQueryRuntime") != 0 || top_level_key(base, base_length, "hostQueryGuidedRuntime") != 0)
        return WG_CONFIG_BASE_FORBIDDEN_KEY;
    if (!wg_json_text_shape(conversations, conversations_length, '[', WG_CONFIG_CONVERSATIONS_MAX)) return WG_CONFIG_CONVERSATIONS_SHAPE;
    size_t runtime_extra = 0;
    if (runtime_key != NULL) {
        unsigned profile = strcmp(runtime_key, "hostQueryRuntime") == 0 ? 1 : strcmp(runtime_key, "hostQueryGuidedRuntime") == 0 ? 2 : 0;
        if (profile == 0 || !wg_runtime_block_valid(profile, runtime_artifacts, runtime_artifacts_length)) return WG_CONFIG_RUNTIME_SHAPE;
        runtime_extra = 1 + 2 + strlen(runtime_key) + 1 + runtime_artifacts_length;   /* ,"key":object */
    }
    int has_members = base_length > 2;
    size_t need = strlen("{\"guestBootId\":\"\",\"conversations\":") + 36 + conversations_length + (has_members ? 1 + (base_length - 2) : 0) + runtime_extra + 1;
    if (need > WG_CONFIG_MAX_BYTES || need + 1 > capacity) return WG_CONFIG_TOO_LARGE;
    int n = snprintf(out, capacity, "{\"guestBootId\":\"%s\",\"conversations\":", boot_id);
    if (n < 0 || (size_t)n >= capacity) return WG_CONFIG_TOO_LARGE;
    size_t at = (size_t)n;
    memcpy(out + at, conversations, conversations_length); at += conversations_length;
    if (has_members) { out[at++] = ','; memcpy(out + at, base + 1, base_length - 2); at += base_length - 2; }
    if (runtime_key != NULL) {
        out[at++] = ',';
        out[at++] = '"';
        memcpy(out + at, runtime_key, strlen(runtime_key)); at += strlen(runtime_key);
        out[at++] = '"';
        out[at++] = ':';
        memcpy(out + at, runtime_artifacts, runtime_artifacts_length); at += runtime_artifacts_length;
    }
    out[at++] = '}';
    out[at] = '\0';
    if (out_length) *out_length = at;
    return WG_CONFIG_OK;
}

/* Test seams exist only in a build that defines WG_TEST_SEAMS (the native tests do; build.py never does, and a hygiene test pins that). In the production
 * binary the config is synced by a direct fsync(2) and there is no hook and no writable pointer. */
#ifdef WG_TEST_SEAMS
static int (*seam_fsync)(int) = fsync;
static void (*seam_race_hook)(const char *path) = NULL;
void wg_trusted_config_test_seams(int (*fsync_fn)(int), void (*race_hook)(const char *path)) {
    seam_fsync = fsync_fn ? fsync_fn : fsync;
    seam_race_hook = race_hook;
}
#define SYNC_CONFIG(fd) seam_fsync(fd)
#define AFTER_CLOSE(path) do { if (seam_race_hook) seam_race_hook(path); } while (0)
#else
#define SYNC_CONFIG(fd) fsync(fd)
#define AFTER_CLOSE(path) ((void)0)
#endif

int wg_write_trusted_config(const char *directory, const char *name, const char *text, size_t length) {
    char path[512];
    if (snprintf(path, sizeof path, "%s/%s", directory, name) >= (int)sizeof path) return -1;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
    if (fd < 0) return -1;
    size_t done = 0;
    while (done < length) {
        ssize_t n = write(fd, text + done, length - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(fd); unlink(path); return -1; }
        done += (size_t)n;
    }
    if (fchmod(fd, 0400) != 0 || SYNC_CONFIG(fd) != 0) { close(fd); unlink(path); return -1; }
    close(fd);
    AFTER_CLOSE(path);
    int reader = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (reader < 0) return -1;
    struct stat st;
    if (fstat(reader, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || (st.st_mode & 0777) != 0400 || (size_t)st.st_size != length) { close(reader); return -1; }
    return reader;
}

long wg_read_small_file(const char *path, char *out, size_t capacity, int any_owner) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);   /* a FIFO or device must be refused, never waited on */
    if (fd < 0) return -1;
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || (st.st_mode & 022) != 0 || (!any_owner && st.st_uid != 0) || (size_t)st.st_size >= capacity) {
        close(fd);
        return -1;
    }
    size_t have = 0;
    while (have < (size_t)st.st_size) {
        ssize_t n = read(fd, out + have, (size_t)st.st_size - have);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { close(fd); return -1; }
        have += (size_t)n;
    }
    close(fd);
    /* strip one trailing newline of a text file */
    if (have && out[have - 1] == '\n') have--;
    out[have] = '\0';
    return (long)have;
}
