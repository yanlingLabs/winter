/*
 * office-lok-gate spike (Task 1, Office Stage A go/no-go gate).
 *
 * NOT SHIPPED. Scratch CLI that proves criteria 2 and 3 of the gate directly against the
 * vendored (or, in the pre-trim run, full) LibreOffice arm64 program/ tree: lok_init_2()
 * accepts it, one document loads, and one tile paints non-blank pixels.
 *
 * Uses the vendored headers verbatim (apple/Norma/Sources/OfficeKit/include/) -- the whole point
 * of "header-only use" per the gate brief. LOK_USE_UNSTABLE_API is required for paintTile /
 * getDocumentSize / getTileMode / initializeForRendering; documentLoad and getVersionInfo are
 * in the always-available (stable) section.
 *
 * Usage:
 *   office-lok-gate <install_path> <profile_dir> <doc_path> <out_png> <out_raw> [tile_twips]
 *
 *   install_path  -- directory containing libmergedlo.dylib (program/Frameworks)
 *   profile_dir   -- plain filesystem path to an EMPTY scratch dir; converted to a file:// URL
 *                    internally (LOK rejects a bare path -- see LibreOfficeKitInit.h's check).
 *   doc_path      -- plain filesystem path to the document to load.
 *   out_png       -- where to write the painted tile as a PNG (CoreGraphics/ImageIO).
 *   out_raw       -- where to dump the raw pixel buffer (RGBA order, post any BGRA->RGBA swap)
 *                    for an external `shasum -a 256` -- keeps crypto linking out of this file.
 *   tile_twips    -- optional, default 3000 (~2.08in square tile from the document origin).
 *
 * Prints, one per line, machine-greppable:
 *   VERSION: <getVersionInfo() JSON>
 *   DOC_SIZE_TWIPS: <w> <h>
 *   TILE_MODE: <0=RGBA|1=BGRA>
 *   DISTINCT_COLORS: <n>
 *   PNG: <path>
 *   RAW: <path>
 *   RESULT: OK|FAIL <reason>
 *
 * Single-threaded, one document per process invocation -- LOK is documented not thread-safe,
 * and this spike does not attempt to reinit after destroy() in the same process.
 */
#define LOK_USE_UNSTABLE_API
#include "LibreOfficeKit.h"
#include "LibreOfficeKitInit.h"

/* LibreOfficeKitEnums.h is deliberately NOT included here: it declares LOK_TILEMODE_RGBA/BGRA
   (among ~150 other enums this spike doesn't need) but is not plain-C-safe as vendored -- its
   lokCallbackTypeToString()/lokMouseEventTypeToString() static-inline helpers use static_cast<>
   and nullptr unconditionally (no #ifdef __cplusplus guard around those two functions
   specifically, unlike the enum declarations above them), so a plain C translation unit fails to
   compile it (confirmed: clang errors at both call sites). Real LOK C++ consumers don't hit
   this; Task 3's Swift/Objective-C++ interop layer should either compile any TU that includes
   this header as Objective-C++, or (simpler) only pull the enum it needs the way this spike
   does. The two values below are LibreOfficeKitEnums.h's own LibreOfficeKitTileMode, transcribed
   -- not reinvented. */
#define LOK_TILEMODE_RGBA_ 0
#define LOK_TILEMODE_BGRA_ 1

#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <CoreFoundation/CoreFoundation.h>

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static char *file_url(const char *plain_path) {
    /* plain_path is always absolute (caller's job) -- "file://" + "/abs/path" = 3 slashes,
       the canonical file: URL form LOK's own check (user_profile_url[0] != '/') requires. */
    size_t len = strlen(plain_path);
    char *url = malloc(len + 8);
    snprintf(url, len + 8, "file://%s", plain_path);
    return url;
}

static int cmp_u32(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return (x > y) - (x < y);
}

static int count_distinct_colors(const unsigned char *rgba, int w, int h) {
    size_t n = (size_t)w * (size_t)h;
    uint32_t *packed = malloc(n * sizeof(uint32_t));
    for (size_t i = 0; i < n; i++) {
        const unsigned char *p = rgba + i * 4;
        packed[i] = ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
    }
    /* simple O(n log n) unique count via qsort -- n is at most a few hundred thousand here,
       comfortably fast, no external dependency. */
    qsort(packed, n, sizeof(uint32_t), cmp_u32);
    int distinct = n > 0 ? 1 : 0;
    for (size_t i = 1; i < n; i++) {
        if (packed[i] != packed[i - 1]) distinct++;
    }
    free(packed);
    return distinct;
}

static int write_png(const char *path, unsigned char *rgba, int w, int h) {
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        rgba, w, h, 8, w * 4, cs,
        kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
    if (!ctx) { CGColorSpaceRelease(cs); return 1; }
    CGImageRef img = CGBitmapContextCreateImage(ctx);
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        NULL, (const UInt8 *)path, (CFIndex)strlen(path), false);
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, NULL);
    int ok = 0;
    if (dest && img) {
        CGImageDestinationAddImage(dest, img, NULL);
        ok = CGImageDestinationFinalize(dest) ? 0 : 1;
    } else {
        ok = 1;
    }
    if (dest) CFRelease(dest);
    if (url) CFRelease(url);
    if (img) CGImageRelease(img);
    CGContextRelease(ctx);
    CGColorSpaceRelease(cs);
    return ok;
}

int main(int argc, char **argv) {
    if (argc < 6) {
        fprintf(stderr,
            "usage: %s <install_path> <profile_dir> <doc_path> <out_png> <out_raw> [tile_twips]\n",
            argv[0]);
        return 2;
    }
    const char *install_path = argv[1];
    const char *profile_dir = argv[2];
    const char *doc_path = argv[3];
    const char *out_png = argv[4];
    const char *out_raw = argv[5];
    int tile_twips = argc > 6 ? atoi(argv[6]) : 3000;

    char *profile_url = file_url(profile_dir);
    char *doc_url = file_url(doc_path);

    fprintf(stderr, "[spike] lok_init_2(%s, %s)\n", install_path, profile_url);
    LibreOfficeKit *kit = lok_init_2(install_path, profile_url);
    if (!kit) {
        printf("RESULT: FAIL lok_init_2 returned NULL (see stderr from LOK's own lok_dlopen)\n");
        return 1;
    }

    char *version = kit->pClass->getVersionInfo(kit);
    printf("VERSION: %s\n", version ? version : "(null)");
    /* Deliberately not freed: getVersionInfo's ownership/free contract isn't specified by the
       header the way getError's is (freeError exists for that one), and this is a one-shot CLI
       that exits immediately after -- not worth guessing at a free() that could double-free. */

    fprintf(stderr, "[spike] documentLoad(%s)\n", doc_url);
    LibreOfficeKitDocument *doc = kit->pClass->documentLoad(kit, doc_url);
    if (!doc) {
        char *err = kit->pClass->getError(kit);
        printf("RESULT: FAIL documentLoad failed: %s\n", err ? err : "(no error string)");
        if (err) kit->pClass->freeError(err);
        kit->pClass->destroy(kit);
        return 1;
    }

    doc->pClass->initializeForRendering(doc, NULL);

    long doc_w = 0, doc_h = 0;
    doc->pClass->getDocumentSize(doc, &doc_w, &doc_h);
    printf("DOC_SIZE_TWIPS: %ld %ld\n", doc_w, doc_h);

    int tile_mode = doc->pClass->getTileMode(doc);
    printf("TILE_MODE: %d\n", tile_mode); /* 0 = LOK_TILEMODE_RGBA, 1 = LOK_TILEMODE_BGRA */

    const int W = 512, H = 512;
    unsigned char *buf = malloc((size_t)W * H * 4);
    memset(buf, 0, (size_t)W * H * 4);

    fprintf(stderr, "[spike] paintTile(%dx%d canvas, tile %dx%d twips from origin)\n", W, H, tile_twips, tile_twips);
    doc->pClass->paintTile(doc, buf, W, H, 0, 0, tile_twips, tile_twips);

    /* Canonicalize to RGBA in memory regardless of reported tile mode, so the PNG and the raw
       dump are both unambiguous -- swap R/B in place if the library reported BGRA. */
    if (tile_mode == LOK_TILEMODE_BGRA_) {
        for (size_t i = 0; i < (size_t)W * H; i++) {
            unsigned char *p = buf + i * 4;
            unsigned char t = p[0];
            p[0] = p[2];
            p[2] = t;
        }
    }

    int distinct = count_distinct_colors(buf, W, H);
    printf("DISTINCT_COLORS: %d\n", distinct);

    FILE *rawf = fopen(out_raw, "wb");
    if (rawf) {
        fwrite(buf, 1, (size_t)W * H * 4, rawf);
        fclose(rawf);
        printf("RAW: %s\n", out_raw);
    } else {
        fprintf(stderr, "[spike] warning: could not open %s for raw dump\n", out_raw);
    }

    int png_rc = write_png(out_png, buf, W, H);
    if (png_rc == 0) {
        printf("PNG: %s\n", out_png);
    } else {
        fprintf(stderr, "[spike] warning: PNG write failed for %s\n", out_png);
    }

    free(buf);
    doc->pClass->destroy(doc);
    kit->pClass->destroy(kit);

    if (distinct <= 1) {
        printf("RESULT: FAIL tile is blank (%d distinct color(s))\n", distinct);
        return 1;
    }
    if (png_rc != 0) {
        printf("RESULT: FAIL PNG write failed\n");
        return 1;
    }
    printf("RESULT: OK\n");
    return 0;
}
