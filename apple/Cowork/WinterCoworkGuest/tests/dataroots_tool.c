/* Drives init/dataroots.c for test_filechannel.py: `dataroots WORKSPACE GID SOURCE... [-- GID SOURCE...]` builds a set of one or two conversations and prints the result. Runs as the
 * invoking user (the "root" of the directories it makes), with the real fchown. */
#define _GNU_SOURCE
#include "../init/dataroots.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* DATAROOTS_LOG: every fchown request ("uid:gid") is appended to that file. A request for an id this (non-root) user cannot give is recorded and then done as the user itself:
 * the tool uid of a conversation (41001, 41002) is never the invoking user's. `stored` tells the code under test that this is what the file system will now report. DATAROOTS_REAL_IDS
 * (needs root) does the real chown and no mapping. */
static int real_chown(int fd, uid_t uid, gid_t gid, void *ctx) {
    (void)ctx;
    const char *log = getenv("DATAROOTS_LOG");
    if (log) { FILE *f = fopen(log, "a"); if (f) { fprintf(f, "%u:%u\n", (unsigned)uid, (unsigned)gid); fclose(f); } }
    if (getenv("DATAROOTS_REAL_IDS")) return fchown(fd, uid, gid);
    return fchown(fd, uid >= 41000 ? getuid() : uid, gid >= 41000 ? getgid() : gid);
}
static void stored_ids(uid_t *uid, gid_t *gid, void *ctx) { (void)ctx; if (*uid >= 41000) *uid = getuid(); if (*gid >= 41000) *gid = getgid(); }
static int noop_chown(int fd, uid_t uid, gid_t gid, void *ctx) { (void)fd; (void)uid; (void)gid; (void)ctx; return 0; }

int main(int argc, char **argv) {
    if (argc < 4 || strcmp(argv[1], "dataroots") != 0) return 2;
    static struct wg_conversation_set set;
    memset(&set, 0, sizeof set);
    unsigned conversation = 0;
    for (int i = 3; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) {
            if (i + 1 >= argc || conversation + 1 >= WG_CONVERSATIONS_MAX) return 2;
            conversation++;
            set.workspace_gid[conversation] = (uint32_t)strtoul(argv[++i], NULL, 10);
            continue;
        }
        if (i == 3) { set.workspace_gid[0] = (uint32_t)strtoul(argv[i], NULL, 10); continue; }
        if (set.root_count[conversation] >= WG_ROOTS_MAX || strlen(argv[i]) > WG_ROOT_SOURCE_MAX) return 2;
        strcpy(set.root_source[conversation][set.root_count[conversation]++], argv[i]);
    }
    set.count = conversation + 1;
    /* The conversations are named conv-0001, conv-0002 (the plan view of a conversation is under its own id). */
    for (unsigned i = 0; i < set.count; i++) { snprintf(set.session_id[i], sizeof set.session_id[i], "conv-%04u", i + 1); set.tool_uid[i] = 41001u + i; }
    /* DATAROOTS_PARENT_OWNER makes the directories above a root look foreign (a non-root test cannot chown them to someone else). */
    const char *foreign = getenv("DATAROOTS_PARENT_OWNER");
    /* DATAROOTS_OWNER / DATAROOTS_NOOP_CHOWN: the root the directories should belong to, and a chown that reports success and changes nothing (the check of the result is then
     * the only thing that can notice). */
    const char *wanted = getenv("DATAROOTS_OWNER");
    struct wg_dataroots_ops ops = { NULL, getenv("DATAROOTS_NOOP_CHOWN") ? noop_chown : real_chown, wanted ? (uid_t)strtoul(wanted, NULL, 10) : getuid(), foreign ? (uid_t)strtoul(foreign, NULL, 10) : getuid(), getenv("DATAROOTS_REAL_IDS") ? NULL : stored_ids };
    /* DATAROOTS_PLAN_ONLY: wg_make_plan_views (a workspace without a browse uid) instead of every root. */
    printf("%d\n", getenv("DATAROOTS_PLAN_ONLY") ? wg_make_plan_views(argv[2], &set, &ops) : wg_make_data_roots(argv[2], &set, &ops));
    return 0;
}
