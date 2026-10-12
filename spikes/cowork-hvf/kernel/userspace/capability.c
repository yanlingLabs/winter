/* SPDX-License-Identifier: GPL-2.0-or-later */
/* No device path, volume key, formatting, activation or benchmark operation. */
#include <libcryptsetup.h>
#include <stdio.h>
#include <string.h>

static void discard_log(int level, const char *message, void *context) {
    (void)level; (void)message; (void)context;
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) return 64;
    struct crypt_device *context = NULL;
    crypt_set_log_callback(NULL, discard_log, NULL);
    int initialized = crypt_init(&context, NULL);
    if (initialized < 0 || context == NULL) return 70;
    const struct crypt_pbkdf_type *defaults = crypt_get_pbkdf_default(CRYPT_LUKS2);
    struct crypt_pbkdf_type requested = {
        .type = CRYPT_KDF_PBKDF2, .hash = "sha256", .iterations = 1000,
        .time_ms = 0, .max_memory_kb = 0, .parallel_threads = 0,
        .flags = CRYPT_PBKDF_NO_BENCHMARK,
    };
    int bounded = crypt_set_pbkdf_type(context, &requested);
    const struct crypt_pbkdf_type *resolved = crypt_get_pbkdf_type(context);
    int valid = bounded == 0 && resolved && resolved->iterations == 1000 &&
        (resolved->flags & CRYPT_PBKDF_NO_BENCHMARK) &&
        strcmp(resolved->type, CRYPT_KDF_PBKDF2) == 0 &&
        strcmp(resolved->hash, "sha256") == 0;
    printf("{\"libcryptsetupVersion\":\"2.8.8\",\"defaultLuks2Pbkdf\":\"%s\","
        "\"boundedPbkdf2SettingsAccepted\":%s,\"iterations\":1000,"
        "\"benchmarkExecuted\":false,\"keyConsumed\":false,"
        "\"deviceOpened\":false,\"kernelCipherAvailabilityChecked\":false,"
        "\"formatOrActivationExecuted\":false}\n",
        defaults ? defaults->type : "unknown", valid ? "true" : "false");
    crypt_free(context);
    return valid ? 0 : 70;
}
