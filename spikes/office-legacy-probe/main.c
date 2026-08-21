/*
 * office-legacy-probe spike (Task 9, Office Stage B legacy-format widening decision).
 *
 * NOT SHIPPED — scratch CLI, sibling to spikes/office-lok-gate (same boot pattern, copied
 * verbatim: lok_init_2() against the vendored program/ tree, documentLoad, and now also saveAs).
 * Answers two empirical questions the T9 brief asks by name against the REAL vendored LOK, never
 * guessed at:
 *
 *   1. "open <install_path> <profile_dir> <doc_path>" — does documentLoad succeed for a candidate
 *      legacy/widened fixture, and if so what getDocumentType()/getParts()/getDocumentSize() does
 *      it report? Mirrors OfficeHelperLiveTests.testSixFormatsOpenWithSaneTypePartsAndSize's own
 *      three facts, for a file this repo does not already have a committed fixture for.
 *
 *   2. "saveas <install_path> <profile_dir> <src_path> <dst_path> <bare_ext>" — does LOK's OWN
 *      internal saveAs, given a BARE EXTENSION never gated by the app's OfficeSaveFormat table,
 *      actually support exporting to a legacy/widened format at all? This is the one that risks
 *      reproducing the OOXML-export SIGABRT class (ooxml-export-investigation.md) — each invocation
 *      is its own process, so a crash here costs one probe run, never the others.
 *
 * Usage mirrors office-lok-gate's own argument order (install_path, profile_dir first) so both
 * spikes can share a driver script without renumbering anything.
 */
#define LOK_USE_UNSTABLE_API
#include "LibreOfficeKit.h"
#include "LibreOfficeKitInit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *file_url(const char *plain_path) {
    size_t len = strlen(plain_path);
    char *url = malloc(len + 8);
    snprintf(url, len + 8, "file://%s", plain_path);
    return url;
}

/* LOK_DOCTYPE_* — LibreOfficeKitEnums.h:22-27, transcribed (that header is not plain-C-safe, see
   office-lok-gate/main.c's own comment on LOK_TILEMODE_* for the identical reason). */
static const char *doctype_name(int n) {
    switch (n) {
        case 0: return "TEXT";
        case 1: return "SPREADSHEET";
        case 2: return "PRESENTATION";
        case 3: return "DRAWING";
        default: return "OTHER";
    }
}

static int run_open(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: %s open <install_path> <profile_dir> <doc_path>\n", argv[0]);
        return 2;
    }
    const char *install_path = argv[2];
    char *profile_url = file_url(argv[3]);
    char *doc_url = file_url(argv[4]);

    LibreOfficeKit *kit = lok_init_2(install_path, profile_url);
    if (!kit) {
        printf("RESULT: FAIL lok_init_2 returned NULL\n");
        return 1;
    }

    LibreOfficeKitDocument *doc = kit->pClass->documentLoad(kit, doc_url);
    if (!doc) {
        char *err = kit->pClass->getError(kit);
        printf("RESULT: FAIL documentLoad failed: %s\n", err ? err : "(no error string)");
        if (err) kit->pClass->freeError(err);
        kit->pClass->destroy(kit);
        return 1;
    }

    doc->pClass->initializeForRendering(doc, NULL);
    int type = doc->pClass->getDocumentType(doc);
    int parts = doc->pClass->getParts(doc);
    long w = 0, h = 0;
    doc->pClass->getDocumentSize(doc, &w, &h);

    printf("DOCTYPE: %d %s\n", type, doctype_name(type));
    printf("PARTS: %d\n", parts);
    printf("SIZE_TWIPS: %ld %ld\n", w, h);

    doc->pClass->destroy(doc);
    kit->pClass->destroy(kit);
    printf("RESULT: OK\n");
    return 0;
}

static int run_saveas(int argc, char **argv) {
    if (argc < 7) {
        fprintf(stderr, "usage: %s saveas <install_path> <profile_dir> <src_path> <dst_path> <bare_ext>\n", argv[0]);
        return 2;
    }
    const char *install_path = argv[2];
    char *profile_url = file_url(argv[3]);
    char *src_url = file_url(argv[4]);
    const char *dst_path = argv[5];
    char *dst_url = file_url(dst_path);
    const char *bare_ext = argv[6];

    LibreOfficeKit *kit = lok_init_2(install_path, profile_url);
    if (!kit) {
        printf("RESULT: FAIL lok_init_2 returned NULL\n");
        return 1;
    }

    LibreOfficeKitDocument *doc = kit->pClass->documentLoad(kit, src_url);
    if (!doc) {
        char *err = kit->pClass->getError(kit);
        printf("RESULT: FAIL source documentLoad failed: %s\n", err ? err : "(no error string)");
        if (err) kit->pClass->freeError(err);
        kit->pClass->destroy(kit);
        return 1;
    }

    fprintf(stderr, "[spike] saveAs(%s, format=%s)\n", dst_url, bare_ext);
    int ok = doc->pClass->saveAs(doc, dst_url, bare_ext, NULL);
    if (!ok) {
        char *err = kit->pClass->getError(kit);
        printf("RESULT: FAIL saveAs failed: %s\n", err ? err : "(no error string)");
        if (err) kit->pClass->freeError(err);
        doc->pClass->destroy(doc);
        kit->pClass->destroy(kit);
        return 1;
    }

    doc->pClass->destroy(doc);
    kit->pClass->destroy(kit);
    printf("RESULT: OK wrote %s\n", dst_path);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s open|saveas ...\n", argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "open") == 0) return run_open(argc, argv);
    if (strcmp(argv[1], "saveas") == 0) return run_saveas(argc, argv);
    fprintf(stderr, "unknown mode %s (expected open|saveas)\n", argv[1]);
    return 2;
}
