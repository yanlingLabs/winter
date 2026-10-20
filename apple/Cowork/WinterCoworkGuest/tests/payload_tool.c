/* Reads one extended 'C' payload (hex on argv) with the gated wg_parse_conversation_payload and prints what PID 1 would act on, for test_filechannel.py:
 * `browse|gid0|root0;root1;...|items` or `refused`. */
#define _GNU_SOURCE
#include "../init/boot.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    size_t length = strlen(argv[1]) / 2;
    uint8_t *bytes = malloc(length + 1);
    for (size_t i = 0; i < length; i++) { unsigned v; sscanf(argv[1] + 2 * i, "%2x", &v); bytes[i] = (uint8_t)v; }
    static struct wg_conversation_set set;
    if (wg_parse_conversation_payload(bytes, length, &set) != 0) { printf("refused\n"); return 0; }
    printf("%u|%u|%u|", set.profile, set.browse_uid, set.count);
    for (unsigned i = 0; i < set.count; i++) {
        printf("%s%s:%u:%u:", i ? ";" : "", set.session_id[i], set.runtime_uid[i], set.workspace_gid[i]);
        for (unsigned r = 0; r < set.root_count[i]; r++) printf("%s%s", r ? "," : "", set.root_source[i][r]);
    }
    printf("|%.*s\n", (int)set.json_length, set.json);
    free(bytes);
    return 0;
}
