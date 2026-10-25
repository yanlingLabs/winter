/* Drives init/dataroots.c for test_filechannel.py: `dataroots WORKSPACE GID SOURCE... [-- GID SOURCE...]` builds a set of one or two conversations and prints the result. Runs as the
 * invoking user (the "root" of the directories it makes), with the real fchown. */
#define _GNU_SOURCE
#include "../init/dataroots.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* The test build renames dataroots.c's fchmod to wg_tool_fchmod (-Dfchmod=wg_tool_fchmod, which also renames the header's declaration). DATAROOTS_FCHMOD_LIE: the call reports
 * success but leaves other bits than the ones asked for (a file system that ignores or filters a chmod): only a read-back of the mode from the descriptor can notice.
 *   "1" / "bits": a permission bit is flipped on every call; "leaf": the same, but only for a data root's own mode (02770), as a filter aimed at the setgid root would do;
 *   "special": the sticky bit is added to every call (a mask without the special bits misses it). */
#undef fchmod
extern int fchmod(int fd, mode_t mode);
int wg_tool_fchmod(int fd, mode_t mode) {
    const char *lie = getenv("DATAROOTS_FCHMOD_LIE");
    if (lie && (strcmp(lie, "1") == 0 || strcmp(lie, "bits") == 0)) mode ^= 0020;
    else if (lie && strcmp(lie, "leaf") == 0 && mode == 02770) mode ^= 0020;
    else if (lie && strcmp(lie, "special") == 0) mode |= 01000;
    return fchmod(fd, mode);
}

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
/* DATAROOTS_STORED_UID / DATAROOTS_STORED_GID: what the code under test is told the file system will report for a tool uid / group, instead of the invoking user's own: the check of the
 * result must then notice that the directory is not that. */
static void stored_ids(uid_t *uid, gid_t *gid, void *ctx) {
    (void)ctx;
    const char *u = getenv("DATAROOTS_STORED_UID"), *g = getenv("DATAROOTS_STORED_GID");
    if (*uid >= 41000) *uid = u ? (uid_t)strtoul(u, NULL, 10) : getuid();
    if (*gid >= 41000) *gid = g ? (gid_t)strtoul(g, NULL, 10) : getgid();
}
/* DATAROOTS_READDIR_FAIL: the epoch scan's read fails (EIO) before any entry; DATAROOTS_STALE_ERRNO: it reads fine but errno holds an old error (the end of a directory is no error). */
static struct dirent *reader(DIR *directory, void *ctx) {
    (void)ctx;
    if (getenv("DATAROOTS_READDIR_FAIL")) { errno = EIO; return NULL; }
    return readdir(directory);
}
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
    struct wg_dataroots_ops ops = { NULL, getenv("DATAROOTS_NOOP_CHOWN") ? noop_chown : real_chown, wanted ? (uid_t)strtoul(wanted, NULL, 10) : getuid(), foreign ? (uid_t)strtoul(foreign, NULL, 10) : getuid(), getenv("DATAROOTS_REAL_IDS") ? NULL : stored_ids, reader, getgid() };
    if (getenv("DATAROOTS_STALE_ERRNO")) errno = EACCES;
    /* DATAROOTS_PLAN_ONLY: wg_make_plan_views (a workspace without a browse uid) instead of every root. */
    printf("%d\n", getenv("DATAROOTS_PLAN_ONLY") ? wg_make_plan_views(argv[2], &set, &ops) : wg_make_data_roots(argv[2], &set, &ops));
    return 0;
}
