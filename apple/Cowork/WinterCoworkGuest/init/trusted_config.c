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
        if ((strcmp(runtime_key, "hostQueryRuntime") != 0 && strcmp(runtime_key, "hostQueryGuidedRuntime") != 0) ||
            !wg_json_text_shape(runtime_artifacts, runtime_artifacts_length, '{', WG_CONFIG_RUNTIME_ARTIFACTS_MAX))
            return WG_CONFIG_RUNTIME_SHAPE;
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
    if (fchmod(fd, 0400) != 0 || fsync(fd) != 0) { close(fd); unlink(path); return -1; }
    close(fd);
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
