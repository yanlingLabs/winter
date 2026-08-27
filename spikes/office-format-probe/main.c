/*
 * office-format-probe spike — the LIVE TEST BENCH for `.superpowers/research/office-formatting.md`'s
 * §8 live-test list (LT-1, LT-4, LT-7, LT-9, LT-11).
 *
 * NOT SHIPPED. Scratch CLI, modelled directly on `spikes/office-lok-gate/main.c` (same vendored
 * headers, same `lok_init_2` + `file://` profile-URL shape, same machine-greppable one-line output
 * contract). It exists because those five tests decide the SHAPE of the `docs format` / `slides
 * format` verbs — above all LT-4, which decides whether `docs format` may honestly say "applied" or
 * must say "posted" — and answering them through the full app (xcodebuild -> NormaAppTests ->
 * OfficeCommandConsumer -> OfficeRuntime -> spawned NormaOfficeHelper -> LOKBridge) would cost a
 * full app build per iteration for questions that are one C call each.
 *
 * Every op below drives the SAME primitives `LOKBridge.swift` drives, in the same order, with the
 * same payloads (the `.uno:ExecuteSearch` argument set is copied verbatim from
 * `LOKBridge.docsSearchArguments`, the Bold payload verbatim from `sheetsFormatOnDedicatedThread`),
 * so a result here transfers to the bridge rather than merely being true of this file.
 *
 * Usage:
 *   office-format-probe <install_path> <profile_dir> <doc_path> <op> [op args...]
 *
 * Ops:
 *   rtf                      LT-4 / LT-7. SelectAll (Writer) or Tab+F2+SelectAll (Impress), then
 *                            getTextSelection("text/plain;charset=utf-8") FIRST — the discriminator
 *                            between "no RTF" and "no selection yet" — then "text/rtf".
 *   findall-bold <lit> <out> LT-1. ExecuteSearch FIND_ALL <lit>, dispatch .uno:Bold {boolean,"true"},
 *                            saveAs <out>. Caller unzips content.xml and counts bold runs.
 *   selectall-bold <out>     Control arm for findall-bold: SelectAll instead of FIND_ALL.
 *   mistype-bold <out>       LT-9b. SelectAll, dispatch .uno:Bold with "type":"string" (H3), saveAs.
 *   noargs-bold <out>        LT-9a. SelectAll, dispatch .uno:Bold with NO arguments (H1), saveAs.
 *   align <cmd> <out>        .uno:LeftPara|CenterPara|RightPara|JustifyPara, no arguments, saveAs.
 *   linespace <cmd> <out>    .uno:SpacePara1|SpacePara115|SpacePara15|SpacePara2, no args, saveAs.
 *   style <name> <out>       .uno:StyleApply Style=<name> FamilyName=ParagraphStyles, saveAs.
 *   styles                   LT-11. getCommandValues(".uno:StyleApply") — the style catalogue.
 *   slides-bold <out>        Impress: Tab+F2+SelectAll then .uno:Bold {boolean,"true"}, saveAs.
 *   slides-align <cmd> <out> Impress: same selection, then the no-args alignment command, saveAs.
 *
 * Prints, one per line, machine-greppable:
 *   DOCTYPE: <int>            (LOK_DOCTYPE_TEXT 0, SPREADSHEET 1, PRESENTATION 2, DRAWING 3)
 *   PLAIN_LEN / PLAIN: ...
 *   RTF_LEN / RTF_NULL / RTF_HEAD: ...
 *   RTF_BOLD_TOKEN: yes|no    (a `\b` control word, syntax-correct — see bold_token_present)
 *   SAVED: <path> / SAVE_FAIL
 *   RESULT: OK|FAIL <reason>
 *
 * Single-threaded, one document per process invocation — LOK is documented not thread-safe, and this
 * spike does not attempt to reinit after destroy() in the same process (same rule the gate spike states).
 */
#define LOK_USE_UNSTABLE_API
#include "LibreOfficeKit.h"
#include "LibreOfficeKitInit.h"

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <limits.h>
#include <unistd.h>
#include <sys/types.h>

/* office-authoring Job 1 — macOS's PRIVATE sandboxing API, declared by hand exactly as
   `Sources/OfficeHelper/Support/OfficeHelperBridge.h` declares it (same signatures, same
   fixed-arity `sandbox_check` form and the same ABI argument that file records). Not in the public
   SDK: <sandbox.h> exposes only the deprecated `sandbox_init` gated to SANDBOX_NAMED, which cannot
   take a custom SBPL text profile. */
int sandbox_init_with_parameters(const char *profile, uint64_t flags, const char *const parameters[], char **errorbuf);
void sandbox_free_error(char *errorbuf);
int sandbox_check(pid_t pid, const char *operation, int type);

/* LibreOfficeKitEnums.h is not plain-C-safe as vendored (two static-inline helpers use
   static_cast<>/nullptr with no __cplusplus guard) — the same finding
   `spikes/office-lok-gate/main.c` and `Support/OfficeHelperBridge.h` both record. The three
   constants below are transcribed from it, not reinvented:
     LibreOfficeKitDocumentType: TEXT=0, SPREADSHEET=1, PRESENTATION=2, DRAWING=3
     LibreOfficeKitKeyEventType: PRESS=0, RELEASE=1
   and the two key codes are `include/vcl/keycodes.hxx`'s KEY_TAB (0x502) / KEY_F2 (0x50D),
   the same integers `OfficeInputCodes.swift` carries on the app side. */
#define LOK_DOCTYPE_TEXT_ 0
#define LOK_DOCTYPE_PRESENTATION_ 2
#define LOK_KEYEVENT_PRESS_ 0
#define LOK_KEYEVENT_RELEASE_ 1
#define KEY_TAB_ 0x502
#define KEY_F2_ 0x50D
#define KEY_ESCAPE_ 0x501
/* SvxSearchCmd, include/svl/srchitem.hxx:36-42 — FIND=0, FIND_ALL=1. */
#define officeSearchCommandFindAllC 1

/* No-op sink — see the registration site. Prints nothing by default (a real LOK document emits
   hundreds of callbacks); set OFP_TRACE to see the raw types. */
static void probe_callback(int nType, const char *pPayload, void *pData) {
    (void)pData;
    if (getenv("OFP_TRACE"))
        fprintf(stderr, "[cb] type=%d payload=%.120s\n", nType, pPayload ? pPayload : "");
}

static char *file_url(const char *plain_path) {
    size_t len = strlen(plain_path);
    char *url = malloc(len + 8);
    snprintf(url, len + 8, "file://%s", plain_path);
    return url;
}

/*
 * The bold-token check, written to NOT be blind to its own failure mode.
 *
 * A bare strstr(rtf, "\\b") is a VACUOUS drill: RTF is full of control words that merely START with
 * `b` — `\bin`, `\brdrs`, `\bullet`, `\blue` — so it matches on a document with no bold anywhere.
 * RTF control-word syntax (spec: a backslash, ASCII letters, then an optional signed integer
 * delimiter, terminated by any non-alphanumeric) means the bold word is exactly `\b` followed by a
 * NON-LETTER: `\b ` (space delimiter), `\b0`/`\b1` (numeric parameter), `\b\` (next control word),
 * or a brace/newline. That is what this matches.
 *
 * `\b0` is bold-OFF and `\b`/`\b1` are bold-ON, so the caller gets both counts: an "on" count of
 * zero with a non-zero "off" count is a real and different answer from no bold markup at all.
 *
 * The control arm is `seeds/plain.fodt`, which has no bold run: it must report on=0.
 */
static void count_bold_tokens(const char *rtf, int *on_count, int *off_count) {
    *on_count = 0;
    *off_count = 0;
    for (const char *p = rtf; (p = strchr(p, '\\')) != NULL; p++) {
        if (p[1] != 'b') continue;
        char delim = p[2];
        if (delim >= 'a' && delim <= 'z') continue; /* \bin, \brdrs, \bullet — not the bold word */
        if (delim >= 'A' && delim <= 'Z') continue;
        if (delim == '0') (*off_count)++;
        else (*on_count)++;              /* `\b`, `\b1`, `\b ` — all bold ON */
    }
}

/* The pump `LOKBridge.pumpDedicatedThreadForPendingDispatch` performs, transcribed: a throwaway
   64x64 paintPartTile. `postUnoCommand`'s effect lands on a deferred internal queue — this repo has
   been burned by that three times (`.uno:GoToCell`, the SelectAll empty-read, the Tab-selection
   retry loop) — so nothing downstream may assume a dispatch has taken effect without one. */
static void pump(LibreOfficeKitDocument *doc, int part) {
    static unsigned char buf[64 * 64 * 4];
    /* office-authoring — OFP_PUMPS lets a caller pump more than once. A `.uno:` dispatch on the
       agent view is asynchronous and has no completion callback (correction C3), so "one pump was
       not enough" and "the command did nothing" are different diagnoses that a single-pump bench
       cannot tell apart. Default stays 1, so every pre-existing op is byte-identical. */
    const char *n = getenv("OFP_PUMPS");
    int pumps = n ? atoi(n) : 1;
    if (pumps < 1) pumps = 1;
    for (int i = 0; i < pumps; i++)
        doc->pClass->paintPartTile(doc, buf, part, 0, 64, 64, 0, 0, 3000, 3000);
}

/* `getCommandValues(".uno:UndoCount")` -> a bare decimal scalar (office-formatting research §6.5:
   `getUndoOrRedoCount`, init.cxx, handled BEFORE the supportsCommand gate so it is reachable for
   every document type). -1 means "this engine could not tell me", which a caller must never read as
   "zero actions" — the difference between those two is the whole point of the check. */
static int undo_count(LibreOfficeKitDocument *doc) {
    char *raw = doc->pClass->getCommandValues(doc, ".uno:UndoCount");
    if (!raw) return -1;
    int value = -1;
    if (raw[0] >= '0' && raw[0] <= '9') value = atoi(raw);
    free(raw);
    return value;
}

static void uno(LibreOfficeKitDocument *doc, const char *cmd, const char *args) {
    doc->pClass->postUnoCommand(doc, cmd, args, true);
}

static void key(LibreOfficeKitDocument *doc, int code) {
    doc->pClass->postKeyEvent(doc, LOK_KEYEVENT_PRESS_, 0, code);
    doc->pClass->postKeyEvent(doc, LOK_KEYEVENT_RELEASE_, 0, code);
}

/* `LOKBridge.docsSearchArguments`, verbatim — including the two corrections this project paid for
   (correction C2: `TransliterateFlags: 0`, and `AlgorithmType2` as `{"short", 1}`). The ONLY change
   is `SearchItem.Command`, which the caller supplies: 0 = FIND, 1 = FIND_ALL, 3 = REPLACE_ALL
   (`include/svl/srchitem.hxx:36-42`). A PARTIALLY-populated SearchItem is a release-build null
   dereference (docs research L1) and `s_pSrchItem` is a process-global static shared across every
   Writer document (L2), so this payload is built TOTALLY or not at all. */
static char *search_args(const char *needle, int command) {
    static char buf[4096];
    snprintf(buf, sizeof buf,
        "{"
        "\"SearchItem.SearchString\":{\"type\":\"string\",\"value\":\"%s\"},"
        "\"SearchItem.ReplaceString\":{\"type\":\"string\",\"value\":\"\"},"
        "\"SearchItem.Command\":{\"type\":\"long\",\"value\":%d},"
        "\"SearchItem.Backward\":{\"type\":\"boolean\",\"value\":false},"
        "\"SearchItem.Pattern\":{\"type\":\"boolean\",\"value\":false},"
        "\"SearchItem.Content\":{\"type\":\"boolean\",\"value\":false},"
        "\"SearchItem.AsianOptions\":{\"type\":\"boolean\",\"value\":false},"
        "\"SearchItem.SearchFlags\":{\"type\":\"long\",\"value\":0},"
        "\"SearchItem.TransliterateFlags\":{\"type\":\"long\",\"value\":0},"
        "\"SearchItem.AlgorithmType2\":{\"type\":\"short\",\"value\":1},"
        "\"Quiet\":{\"type\":\"boolean\",\"value\":true}"
        "}", needle, command);
    return buf;
}

/* Impress text-edit selection — `LOKBridge.readSelectedShapeTextOnDedicatedThread`'s own sequence,
   which T6 live-proved (its deletion-red run removed the SelectAll and every read came back empty
   while position verification still passed). Escape, N x Tab, F2, pump, SelectAll, pump. */
static void select_slide_text(LibreOfficeKitDocument *doc, int part, int tab_count) {
    doc->pClass->setPart(doc, part);
    key(doc, KEY_ESCAPE_);
    for (int i = 0; i < tab_count; i++) { key(doc, KEY_TAB_); pump(doc, part); }
    key(doc, KEY_F2_);
    pump(doc, part);
    uno(doc, ".uno:SelectAll", "{}");
    pump(doc, part);
}

/*
 * Pump until a selection actually EXISTS, and report whether it ever did.
 *
 * This is not a convenience — it is the load-bearing guard the whole verb needs, and the probe
 * found it the hard way. `.uno:ExecuteSearch` is dispatched through `postUnoCommand`, whose effect
 * lands on a deferred internal queue; the first LT-1 attempt pumped once, got no selection, and
 * dispatched `.uno:Bold` into a document with nothing selected. Every layer reported success and
 * the saved bytes were untouched — a silent no-op reported as a completed format.
 *
 * `text/rtf` is used as the liveness probe rather than `text/plain;charset=utf-8` because it
 * measured as the MORE reliable of the two here (LT-4 §1.3: in 3/3 null-RTF runs the plain read was
 * also null, but the converse was common — plain was null while RTF returned correct scoped bytes).
 * That inverts the natural assumption that plain is the dependable flavour.
 *
 * Returns the RTF (caller frees) or NULL if no selection ever appeared.
 */
static char *ensure_selection(LibreOfficeKitDocument *doc, int part, int max_attempts, int *attempts_out) {
    char *rtf = NULL;
    int n = 0;
    while (n < max_attempts) {
        n++;
        /* The PLAIN read is not diagnostic noise — it is load-bearing, and the probe measured that
           the hard way. Reading `text/rtf` alone in a pump loop failed to produce a selection in
           2/2 runs, while the identical search followed by plain reads interleaved with pumps
           produced one in ~2/3. Kept in this order because it is what measured as working. */
        char *plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
        rtf = doc->pClass->getTextSelection(doc, "text/rtf", NULL);
        if (getenv("OFP_VERBOSE"))
            fprintf(stderr, "[sel] attempt %d plain=%s(%zu) rtf=%s(%zu)\n", n,
                    plain ? "ok" : "NULL", plain ? strlen(plain) : 0,
                    rtf ? "ok" : "NULL", rtf ? strlen(rtf) : 0);
        if (plain) free(plain);
        if (rtf) break;
        pump(doc, part);
    }
    if (attempts_out) *attempts_out = n;
    return rtf;
}

static int save_as(LibreOfficeKitDocument *doc, const char *out_path, const char *format) {
    char *url = file_url(out_path);
    int ok = doc->pClass->saveAs(doc, url, format, NULL);
    free(url);
    if (ok) printf("SAVED: %s\n", out_path);
    else printf("SAVE_FAIL: %s\n", out_path);
    return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: %s <install_path> <profile_dir> <doc_path> <op> [args...]\n", argv[0]);
        return 2;
    }
    /* UNBUFFERED stdout, and it is not a nicety. LOK aborts inside its own static-destructor
       teardown on exit (the crash trace `spikes/office-lok-gate` also prints, and the reason
       `LOKBridge` notes `lok_init_2` uses `_exit`), and a block-buffered stdout — which is what a
       pipe gives you — LOSES every line written before the abort. The first run of this probe
       printed nothing at all but "Unspecified Application Error" for exactly that reason, which
       reads like a boot failure and is not one. */
    setvbuf(stdout, NULL, _IONBF, 0);

    const char *install_path = argv[1];
    const char *profile_dir = argv[2];
    const char *doc_path = argv[3];
    const char *op = argv[4];

    /* office-authoring Job 1 — THE SEATBELT ARM.
     *
     * This project has twice shipped an engine path that worked everywhere except inside the
     * helper's seatbelt (the missing `libmswordlo.dylib` and `libsal_textenclo.dylib` cases), so a
     * mechanism proven only by an UNSANDBOXED probe has not been proven for production at all.
     *
     * This replicates `Sources/OfficeHelper/main.swift`'s own boot sequence EXACTLY — same
     * `sandbox_init_with_parameters(profileText, 0, params)` call, same profile text read from the
     * checked-in `office-helper.sb`, the same two parameters (`STATE_PATH`, `TMPDIR`) in the same
     * order, applied BEFORE `lok_init_2` — and then makes the same `sandbox_check` self-assertion
     * the helper makes, so a profile that silently failed to apply can never be mistaken for one
     * that applied and permitted everything. That last point is the whole reason the check is here:
     * without it this arm would be blind to its own failure mode (an unapplied sandbox looks
     * identical to a permissive one — every op simply passes).
     *
     * Opt-in via OFP_SANDBOX_PROFILE + OFP_SANDBOX_STATE so every pre-existing op keeps its
     * current, unsandboxed behaviour untouched and the two arms are directly comparable. */
    const char *sb_profile_path = getenv("OFP_SANDBOX_PROFILE");
    const char *sb_state_path = getenv("OFP_SANDBOX_STATE");
    if (sb_profile_path && sb_state_path) {
        FILE *pf = fopen(sb_profile_path, "rb");
        if (!pf) { printf("RESULT: FAIL sandbox profile unreadable: %s\n", sb_profile_path); return 1; }
        fseek(pf, 0, SEEK_END); long plen = ftell(pf); fseek(pf, 0, SEEK_SET);
        char *ptext = malloc((size_t)plen + 1);
        if (fread(ptext, 1, (size_t)plen, pf) != (size_t)plen) {
            printf("RESULT: FAIL sandbox profile short read\n"); return 1;
        }
        ptext[plen] = '\0';
        fclose(pf);
        const char *tmpdir = getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp";
        /* main.swift canonicalizes both values before substitution (the profile's own header:
           the kernel checks REAL paths, so a symlinked value makes every `(subpath (param ...))`
           rule match nothing). `realpath` is that same canonicalization. */
        char state_real[PATH_MAX], tmp_real[PATH_MAX];
        if (!realpath(sb_state_path, state_real)) snprintf(state_real, sizeof state_real, "%s", sb_state_path);
        if (!realpath(tmpdir, tmp_real)) snprintf(tmp_real, sizeof tmp_real, "%s", tmpdir);
        const char *params[] = { "STATE_PATH", state_real, "TMPDIR", tmp_real, NULL };
        char *sberr = NULL;
        int sbrc = sandbox_init_with_parameters(ptext, 0, params, &sberr);
        if (sbrc != 0) {
            printf("RESULT: FAIL sandbox_init_with_parameters rc=%d: %s\n",
                   sbrc, sberr ? sberr : "(no error string)");
            if (sberr) sandbox_free_error(sberr);
            return 1;
        }
        /* The helper's own self-assertion, verbatim in intent: refuse to report anything at all
           unless the process is GENUINELY sandboxed. Without this, "sandboxed run passed" would be
           unfalsifiable. */
        if (sandbox_check(getpid(), NULL, 0) == 0) {
            printf("RESULT: FAIL sandbox_init reported success but sandbox_check says unsandboxed\n");
            return 1;
        }
        printf("SANDBOX: applied (STATE_PATH=%s)\n", state_real);
    } else {
        printf("SANDBOX: none\n");
    }

    char *profile_url = file_url(profile_dir);
    /* office-authoring Job 1 — a `private:` URL must reach `documentLoad` VERBATIM. `file_url`
       would turn `private:factory/swriter` into `file://private:factory/swriter`, which is a
       perfectly well-formed file URL naming a path that does not exist — i.e. the probe would
       report "documentLoad failed" and I would have measured my own string concatenation rather
       than the engine. Any argument with a scheme LO already understands is passed through. */
    char *doc_url = (strncmp(doc_path, "private:", 8) == 0) ? strdup(doc_path) : file_url(doc_path);

    LibreOfficeKit *kit = lok_init_2(install_path, profile_url);
    if (!kit) { printf("RESULT: FAIL lok_init_2 returned NULL\n"); return 1; }

    LibreOfficeKitDocument *doc = kit->pClass->documentLoad(kit, doc_url);
    if (!doc) {
        char *err = kit->pClass->getError(kit);
        printf("RESULT: FAIL documentLoad: %s\n", err ? err : "(none)");
        return 1;
    }
    doc->pClass->initializeForRendering(doc, NULL);

    int doctype = doc->pClass->getDocumentType(doc);
    printf("DOCTYPE: %d\n", doctype);
    bool is_impress = (doctype == LOK_DOCTYPE_PRESENTATION_);

    /* A no-op callback on the document. LOK builds its per-view `CallbackFlushHandler` machinery
       only when a callback is registered, and a good deal of dispatch completion queues through it
       — so a bench with no callback is not merely missing diagnostics, it may be missing the pump
       that completes an attribute dispatch. Registered before the agent view is minted so the
       handler exists for both views. */
    if (getenv("OFP_CALLBACK")) {
        doc->pClass->registerCallback(doc, probe_callback, NULL);
        printf("CALLBACK: registered\n");
    }

    /* The AGENT VIEW. Every agent-facing verb in LOKBridge runs on a second view created with
       createView + setView, so the user's own caret and selection are untouched (docs ruling 4:
       Writer's caret and selection ARE per-view). Probing on the default view instead would measure
       a configuration the product never uses. */
    int agent_view = doc->pClass->createView(doc);
    doc->pClass->setView(doc, agent_view);
    printf("AGENT_VIEW: %d\n", agent_view);

    /* office-authoring — isolate "the verb does not work" from "the verb does not work ON THE
       AGENT VIEW". Correction C3 (docs-lok-research) established that `doc_postUnoCommand`
       resolves `nView` via `SfxLokHelper::getViewId`, which `setView` has moved to the front of
       the shell list — so a dispatch always lands on the agent view, which registers no callback.
       OFP_PRIMARY_VIEW=1 puts the probe back on the primary view as the control arm. */
    if (getenv("OFP_PRIMARY_VIEW")) {
        doc->pClass->setView(doc, 0);
        printf("VIEW: switched back to primary (0)\n");
    }

    /* office-authoring — the CANDIDATE CURE for the InsertGraphic race, tested rather than assumed.
       Correction C3's mechanism: `bNotifyWhenFinished:true` only forces `SfxCallMode::SYNCHRON` if
       a `DispatchResultListener` is constructed, and that happens only when
       `mpCallbackFlushHandlers.count(nView)` is non-zero — i.e. only when THE VIEW THE DISPATCH
       RESOLVES TO has a registered callback. Every agent verb asserts the agent view, and
       `createAgentView` never registers one, so every agent dispatch is async. Registering here —
       AFTER the setView above, so it binds to the agent view rather than the primary one the
       existing OFP_CALLBACK knob covers — is the direct test of whether that restores synchrony. */
    if (getenv("OFP_CALLBACK_AGENT")) {
        doc->pClass->registerCallback(doc, probe_callback, NULL);
        printf("CALLBACK: registered on the CURRENT (agent) view\n");
    }

    int rc = 0;

    if (strcmp(op, "rtf") == 0) {
        /* Probe BOTH views. The agent view is what the product uses; the primary view is the
           control that tells a "RTF is unavailable" answer apart from "this view is not wired up".
           `argv[5]`, when given, forces one: "agent" or "primary". */
        const char *which = argc > 5 ? argv[5] : "both";
        int views[2] = { agent_view, 0 };
        const char *names[2] = { "AGENT", "PRIMARY" };
        for (int v = 0; v < 2; v++) {
            if (strcmp(which, "agent") == 0 && v != 0) continue;
            if (strcmp(which, "primary") == 0 && v != 1) continue;
            doc->pClass->setView(doc, views[v]);
            if (is_impress) select_slide_text(doc, 0, 1);
            else uno(doc, ".uno:SelectAll", "{}");

            /* PLAIN FIRST — the discriminator, with the SAME retry-on-empty budget
               `LOKBridge.docsReadTextOnDedicatedThread` carries (read first, then up to five
               pumps). `postUnoCommand` lands on a deferred internal queue, so a null RTF read
               alongside a null PLAIN read is a timing/selection artifact, not a verdict about RTF.
               Only a non-empty plain read makes the RTF answer mean anything at all. */
            char *plain = NULL;
            int attempts = 1;
            plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
            while ((!plain || plain[0] == '\0') && attempts < 6) {
                if (plain) free(plain);
                pump(doc, 0);
                plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
                attempts++;
            }
            printf("%s_PLAIN_ATTEMPTS: %d\n", names[v], attempts);
            if (!plain) printf("%s_PLAIN_NULL\n", names[v]);
            else {
                printf("%s_PLAIN_LEN: %zu\n", names[v], strlen(plain));
                printf("%s_PLAIN: %.200s\n", names[v], plain);
                free(plain);
            }

            char *rtf = doc->pClass->getTextSelection(doc, "text/rtf", NULL);
            if (!rtf) {
                printf("%s_RTF_NULL\n", names[v]);
            } else {
                /* Raw dump, so the containment check can be developed and validated OFFLINE against
                   real engine output instead of guessed at. OFP_RTF_OUT names the file. */
                const char *dumpPath = getenv("OFP_RTF_OUT");
                if (dumpPath) {
                    FILE *f = fopen(dumpPath, "wb");
                    if (f) { fwrite(rtf, 1, strlen(rtf), f); fclose(f); printf("%s_RTF_DUMP: %s\n", names[v], dumpPath); }
                }
                printf("%s_RTF_LEN: %zu\n", names[v], strlen(rtf));
                printf("%s_RTF_HEAD: %.300s\n", names[v], rtf);
                int on = 0, off = 0;
                count_bold_tokens(rtf, &on, &off);
                printf("%s_RTF_BOLD_ON: %d\n", names[v], on);
                printf("%s_RTF_BOLD_OFF: %d\n", names[v], off);
                printf("%s_RTF_BOLD_TOKEN: %s\n", names[v], on > 0 ? "yes" : "no");
                /* The alignment/style tokens the honest v1 containment check would look at. */
                printf("%s_RTF_QL: %d QC: %d QR: %d QJ: %d\n", names[v],
                       strstr(rtf, "\\ql") ? 1 : 0, strstr(rtf, "\\qc") ? 1 : 0,
                       strstr(rtf, "\\qr") ? 1 : 0, strstr(rtf, "\\qj") ? 1 : 0);
                free(rtf);
            }
            /* A second mime spelling, in case the clipboard-id table maps RTF differently. The
               research could not confirm the exact string — `sot` was not among the fetched
               subtrees — and `getFromTransferable` fails CLEANLY on an unknown flavour, so probing
               spellings is safe. */
            const char *alts[] = { "text/richtext", "application/rtf", "text/html" };
            for (int i = 0; i < 3; i++) {
                char *a = doc->pClass->getTextSelection(doc, alts[i], NULL);
                printf("%s_ALT[%s]: %s\n", names[v], alts[i], a ? "non-null" : "NULL");
                if (a) { printf("%s_ALT_LEN[%s]: %zu\n", names[v], alts[i], strlen(a)); free(a); }
            }
        }

    } else if (strcmp(op, "rtf-scope") == 0) {
        /* THE DECISIVE TEST for the verification story, and the reason it exists: on the plain
           fixture, `getTextSelection("text/plain;charset=utf-8")` returned NULL after six pumps
           while `"text/rtf"` returned 3678 bytes in the same run. If the RTF flavour ignores the
           selection and always serializes the WHOLE DOCUMENT, then "re-select the target range and
           check the RTF" is a check BLIND TO ITS OWN FAILURE MODE — it would report bold-present
           for bold anywhere in the document, including bold the verb did not apply.
           `argv[5]` is the literal to FIND; `argv[6]` a string that must NOT appear if the RTF is
           really scoped to the match. */
        if (argc < 7) { fprintf(stderr, "rtf-scope needs <findLiteral> <outsideMarker>\n"); return 2; }
        /* F-5: the SEARCH COMMAND is now an argument, defaulting to FIND_ALL(1) — the command the
           bridge actually dispatches. The original arms used FIND(0) and therefore measured a
           different path than production. */
        int scopeCmd = argc > 7 ? atoi(argv[7]) : officeSearchCommandFindAllC;
        printf("FIND_SEARCH_CMD: %d\n", scopeCmd);
        uno(doc, ".uno:ExecuteSearch", search_args(argv[5], scopeCmd));
        pump(doc, 0);
        char *plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
        int at = 1;
        while ((!plain || plain[0] == '\0') && at < 6) {
            if (plain) free(plain);
            pump(doc, 0);
            plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
            at++;
        }
        printf("FIND_PLAIN_ATTEMPTS: %d\n", at);
        printf("FIND_PLAIN: %s\n", plain ? plain : "(null)");
        /* Retry-on-null, with the SAME bounded pump budget the bridge already uses for every other
           deferred-dispatch read. Measured need, not ceremony: a single unconditional read was
           correct 9 times out of 10 and returned NULL the tenth — a verification that fails 10% of
           the time on CORRECT work is a false-failure generator, which is worse than no
           verification at all. `rtf_attempts` is reported so the budget stays measured. */
        char *rtf = doc->pClass->getTextSelection(doc, "text/rtf", NULL);
        int rat = 1;
        while (!rtf && rat < 6) {
            pump(doc, 0);
            rtf = doc->pClass->getTextSelection(doc, "text/rtf", NULL);
            rat++;
        }
        printf("FIND_RTF_ATTEMPTS: %d\n", rat);
        if (!rtf) { printf("FIND_RTF_NULL\n"); }
        else {
            const char *dumpPath = getenv("OFP_RTF_OUT");
            if (dumpPath) {
                FILE *f = fopen(dumpPath, "wb");
                if (f) { fwrite(rtf, 1, strlen(rtf), f); fclose(f); printf("FIND_RTF_DUMP: %s\n", dumpPath); }
            }
            printf("FIND_RTF_LEN: %zu\n", strlen(rtf));
            printf("FIND_RTF_HAS_NEEDLE: %d\n", strstr(rtf, argv[5]) ? 1 : 0);
            printf("FIND_RTF_HAS_OUTSIDE: %d\n", strstr(rtf, argv[6]) ? 1 : 0);
            int on = 0, off = 0;
            count_bold_tokens(rtf, &on, &off);
            printf("FIND_RTF_BOLD_ON: %d\n", on);
            free(rtf);
        }
        if (plain) free(plain);

    } else if (strcmp(op, "rtf-noselect") == 0) {
        /* The other half of the same question: with NO selection command dispatched at all, does
           `"text/rtf"` still return a document? A non-null answer here proves the flavour is
           unconditional and the containment check cannot be a verification of anything. */
        char *plain = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
        printf("NOSEL_PLAIN: %s\n", plain ? (plain[0] ? plain : "(empty)") : "(null)");
        if (plain) free(plain);
        char *rtf = doc->pClass->getTextSelection(doc, "text/rtf", NULL);
        if (!rtf) printf("NOSEL_RTF_NULL\n");
        else {
            printf("NOSEL_RTF_LEN: %zu\n", strlen(rtf));
            printf("NOSEL_RTF_HAS_BODY: %d\n", strstr(rtf, "BOLDTEXT") ? 1 : 0);
            int on = 0, off = 0;
            count_bold_tokens(rtf, &on, &off);
            printf("NOSEL_RTF_BOLD_ON: %d\n", on);
            free(rtf);
        }

    } else if (strcmp(op, "saveonly") == 0) {
        /* The DELETION-RED control arm for every saved-bytes drill below: the identical open ->
           save round trip with NO command dispatched at all. Any assertion that also passes here is
           an assertion about the fixture, not about the verb — the arc's #1 defect class. */
        if (argc < 6) { fprintf(stderr, "saveonly needs <out>\n"); return 2; }
        rc = save_as(doc, argv[5], "odt");

    } else if (strcmp(op, "findall-noop") == 0) {
        /* LT-1's own control: FIND_ALL runs, the Bold dispatch does NOT. Separates "FIND_ALL
           selected three ranges" from "the format reached three ranges". */
        if (argc < 7) { fprintf(stderr, "findall-noop needs <literal> <out>\n"); return 2; }
        uno(doc, ".uno:ExecuteSearch", search_args(argv[5], 1 /* FIND_ALL */));
        pump(doc, 0);
        int sat = 0;
        char *sel = ensure_selection(doc, 0, 12, &sat);
        printf("SELECT_ATTEMPTS: %d\n", sat);
        printf("SELECTED_RTF_LEN: %zu\n", sel ? strlen(sel) : 0);
        if (sel) free(sel);
        rc = save_as(doc, argv[6], "odt");

    } else if (strcmp(op, "styles") == 0) {
        char *v = doc->pClass->getCommandValues(doc, ".uno:StyleApply");
        if (!v) printf("STYLES_NULL\n");
        else { printf("STYLES_LEN: %zu\nSTYLES: %s\n", strlen(v), v); free(v); }

    } else if (strcmp(op, "findall-bold") == 0 || strcmp(op, "selectall-bold") == 0
               || strcmp(op, "mistype-bold") == 0 || strcmp(op, "noargs-bold") == 0) {
        const char *out = NULL;
        if (strcmp(op, "findall-bold") == 0) {
            if (argc < 7) { fprintf(stderr, "findall-bold needs <literal> <out> [searchCmd]\n"); return 2; }
            /* `searchCmd` defaults to FIND_ALL (1); pass 0 to compare against a plain FIND.
               `include/svl/srchitem.hxx:36-42`: FIND=0, FIND_ALL=1, REPLACE=2, REPLACE_ALL=3. */
            int scmd = argc > 7 ? atoi(argv[7]) : 1;
            printf("SEARCH_CMD: %d\n", scmd);
            uno(doc, ".uno:ExecuteSearch", search_args(argv[5], scmd));
            pump(doc, 0);
            out = argv[6];
        } else {
            if (argc < 6) { fprintf(stderr, "%s needs <out>\n", op); return 2; }
            uno(doc, ".uno:SelectAll", "{}");
            pump(doc, 0);
            out = argv[5];
        }
        int sat = 0;
        char *sel = ensure_selection(doc, 0, 12, &sat);
        printf("SELECT_ATTEMPTS: %d\n", sat);
        if (!sel) {
            /* Refuse rather than format nothing and report success — the exact silent no-op this
               probe produced on its first LT-1 attempt. */
            printf("RESULT: FAIL no selection after %d attempts\n", sat);
            return 1;
        }
        printf("SELECTED_RTF_LEN: %zu\n", strlen(sel));
        { int bon = 0, boff = 0; count_bold_tokens(sel, &bon, &boff);
          printf("PRE_BOLD_ON: %d PRE_BOLD_OFF: %d\n", bon, boff); }
        free(sel);

        if (strcmp(op, "mistype-bold") == 0) {
            /* H3 — `SvxWeightItem::PutValue` NEVER rejects a value: `Any2Bool` coerces a string Any
               to `false`. So this "set bold" payload, with one wrong type tag, UN-BOLDS while every
               layer reports success. The saved bytes are the only witness. */
            uno(doc, ".uno:Bold", "{\"Bold\":{\"type\":\"string\",\"value\":\"true\"}}");
        } else if (strcmp(op, "noargs-bold") == 0) {
            /* H1 — with no item at all, `SfxBindings::Execute_Impl` runs the TOGGLE machinery
               (`Toggle = TRUE` on the slot) and flips against current state. */
            uno(doc, ".uno:Bold", "{}");
        } else {
            uno(doc, ".uno:Bold", "{\"Bold\":{\"type\":\"boolean\",\"value\":\"true\"}}");
        }
        pump(doc, 0);
        rc = save_as(doc, out, "odt");

    } else if (strcmp(op, "align") == 0 || strcmp(op, "linespace") == 0) {
        if (argc < 7) { fprintf(stderr, "%s needs <unoName> <out>\n", op); return 2; }
        uno(doc, ".uno:SelectAll", "{}");
        { int sat = 0; char *sel = ensure_selection(doc, 0, 12, &sat);
          printf("SELECT_ATTEMPTS: %d\n", sat);
          if (!sel) { printf("RESULT: FAIL no selection\n"); return 1; }
          free(sel); }
        char cmd[128];
        snprintf(cmd, sizeof cmd, ".uno:%s", argv[5]);
        uno(doc, cmd, "{}");   /* argument-free BY DESIGN — research §3.2/§3.3 */
        pump(doc, 0);
        rc = save_as(doc, argv[6], "odt");

    } else if (strcmp(op, "style") == 0) {
        if (argc < 7) { fprintf(stderr, "style needs <programmaticName> <out>\n"); return 2; }
        uno(doc, ".uno:SelectAll", "{}");
        { int sat = 0; char *sel = ensure_selection(doc, 0, 12, &sat);
          printf("SELECT_ATTEMPTS: %d\n", sat);
          if (!sel) { printf("RESULT: FAIL no selection\n"); return 1; }
          free(sel); }
        char args[512];
        snprintf(args, sizeof args,
                 "{\"Style\":{\"type\":\"string\",\"value\":\"%s\"},"
                 "\"FamilyName\":{\"type\":\"string\",\"value\":\"ParagraphStyles\"}}", argv[5]);
        uno(doc, ".uno:StyleApply", args);
        pump(doc, 0);
        rc = save_as(doc, argv[6], "odt");

    } else if (strcmp(op, "slides-bold") == 0) {
        if (argc < 6) { fprintf(stderr, "slides-bold needs <out>\n"); return 2; }
        select_slide_text(doc, 0, 1);
        char *sel = doc->pClass->getTextSelection(doc, "text/plain;charset=utf-8", NULL);
        printf("SELECTED_LEN: %zu\n", sel ? strlen(sel) : 0);
        if (sel) { printf("SELECTED: %.200s\n", sel); free(sel); }
        uno(doc, ".uno:Bold", "{\"Bold\":{\"type\":\"boolean\",\"value\":\"true\"}}");
        pump(doc, 0);
        key(doc, KEY_ESCAPE_);
        pump(doc, 0);
        rc = save_as(doc, argv[5], "odp");

    } else if (strcmp(op, "slides-align") == 0) {
        if (argc < 7) { fprintf(stderr, "slides-align needs <unoName> <out>\n"); return 2; }
        select_slide_text(doc, 0, 1);
        char cmd[128];
        snprintf(cmd, sizeof cmd, ".uno:%s", argv[5]);
        uno(doc, cmd, "{}");
        pump(doc, 0);
        key(doc, KEY_ESCAPE_);
        pump(doc, 0);
        rc = save_as(doc, argv[6], "odp");

    /* office-authoring Job 1 — "a write to a path that does not exist creates the document".
       Load whatever `doc_path` names (in practice `private:factory/swriter|scalc|simpress`) and
       `saveAs` it to argv[5] with the bare-extension format token argv[6]. `save_as` already
       prints SAVED/SAVE_FAIL, and the DOCTYPE line above is what proves the factory URL produced
       the KIND asked for rather than some default — a create that silently produced a Writer doc
       for `scalc` would still "save fine" to a .xlsx name and be wrong. */
    } else if (strcmp(op, "create") == 0) {
        if (argc < 7) { fprintf(stderr, "create needs <out_path> <format_ext>\n"); return 2; }
        rc = save_as(doc, argv[5], argv[6]);

    /* office-authoring Job 2 — `.uno:InsertGraphic`.
     *
     * Slot: `svx/sdi/svx.sdi:4928-4929`
     *   SfxVoidItem InsertGraphic SID_INSERT_GRAPHIC
     *   (SfxStringItem FileName    SID_INSERT_GRAPHIC,
     *    SfxStringItem FilterName  FN_PARAM_FILTER,
     *    SfxBoolItem   AsLink      FN_PARAM_1,
     *    SfxStringItem Style       FN_PARAM_2)
     * All SIMPLE items, so bare argument names (no dotted member path).
     *
     * `AsLink` is deliberately NEVER sent. Both engines gate a BLOCKING `SvxLinkWarningDialog`
     * `.run()` on it being true (`sd/source/ui/func/fuinsert.cxx:202-207`,
     * `sw/source/uibase/uiview/view2.cxx:544-553`) — the wedge class. Omitted, both default to
     * false and that branch is unreachable.
     *
     * The three arms are the point:
     *   insert-graphic          correct args      — does it land?
     *   insert-graphic-noargs   `{}`              — THE HAZARD. Impress's else-branch
     *                                              (`fuinsert.cxx:151-162`) constructs an
     *                                              `SvxOpenGraphicDialog` and calls the BLOCKING
     *                                              `.Execute()`, with no headless guard. Writer's
     *                                              (`view2.cxx:420`) IS guarded by
     *                                              `!Application::IsHeadlessModeEnabled()`.
     *   insert-graphic-badarg   `FileNam`         — per FMT §0, a wrong argument name and NO
     *                                              arguments are the same state by the time the
     *                                              Execute handler runs, so this must behave
     *                                              identically to -noargs. If it does not, that
     *                                              premise is wrong and everything built on it
     *                                              needs re-deriving.
     * Run the two hazard arms under an external timeout — a wedge is a hang, and the whole
     * question is whether it hangs. */
    /* office-authoring — THE CONTAINED CURE for the insert race, as an experiment.
     *
     * The race is "saveAs runs before the async dispatch has executed." The global fix (registering
     * a callback on the agent view, which makes dispatches SYNCHRON) works but regresses Impress.
     * This is the other shape: dispatch ONCE, then WAIT for it to land before saving.
     *
     * ⚠️ It is a WAIT, not a retry. Re-dispatching `.uno:InsertGraphic` on a late-landing first
     * attempt would insert the image TWICE — the non-idempotent-write hazard this repo already
     * carries as a hard rule for timed-out office writes. Nothing here re-dispatches.
     *
     * The signal is `getCommandValues(".uno:UndoCount")`, which the formatting research established
     * returns a bare decimal scalar and is reachable for every document type. A +1 delta proves a
     * mutation was RECORDED — it cannot say what was recorded, which is why the saved-bytes check
     * still decides. */
    } else if (strcmp(op, "insert-graphic-wait") == 0) {
        if (argc < 8) { fprintf(stderr, "needs <image_path> <out_path> <format_ext>\n"); return 2; }
        char *img_url = file_url(argv[5]);
        char args[2048];
        snprintf(args, sizeof args, "{\"FileName\":{\"type\":\"string\",\"value\":\"%s\"}}", img_url);
        int before = undo_count(doc);
        printf("UNDOCOUNT_BEFORE: %d\n", before);
        uno(doc, ".uno:InsertGraphic", args);
        int landed = 0, i;
        for (i = 0; i < 40; i++) {
            pump(doc, 0);
            int now = undo_count(doc);
            if (before >= 0 && now > before) { landed = 1; break; }
        }
        printf("UNDOCOUNT_AFTER: %d  waited=%d  landed=%d\n", undo_count(doc), i, landed);
        free(img_url);
        rc = save_as(doc, argv[6], argv[7]);

    } else if (strcmp(op, "insert-graphic") == 0 || strcmp(op, "insert-graphic-badarg") == 0) {
        if (argc < 8) { fprintf(stderr, "needs <image_path> <out_path> <format_ext>\n"); return 2; }
        char *img_url = file_url(argv[5]);
        char args[2048];
        snprintf(args, sizeof args, "{\"%s\":{\"type\":\"string\",\"value\":\"%s\"}}",
                 strcmp(op, "insert-graphic-badarg") == 0 ? "FileNam" : "FileName", img_url);
        printf("DISPATCH: .uno:InsertGraphic %s\n", args);
        uno(doc, ".uno:InsertGraphic", args);
        printf("RETURNED: postUnoCommand\n");
        pump(doc, 0);
        printf("PUMPED\n");
        free(img_url);
        rc = save_as(doc, argv[6], argv[7]);

    } else if (strcmp(op, "insert-graphic-noargs") == 0) {
        if (argc < 7) { fprintf(stderr, "needs <out_path> <format_ext>\n"); return 2; }
        printf("DISPATCH: .uno:InsertGraphic {}\n");
        uno(doc, ".uno:InsertGraphic", "{}");
        printf("RETURNED: postUnoCommand\n");
        pump(doc, 0);
        printf("PUMPED\n");
        rc = save_as(doc, argv[5], argv[6]);

    /* office-authoring Job 3 — `.uno:InsertTable`, Writer only.
     *
     * Slot: `sw/sdi/swriter.sdi:3749-3750`
     *   SfxUInt16Item InsertTable FN_INSERT_TABLE
     *   (SfxStringItem TableName FN_INSERT_TABLE, SfxUInt16Item Columns SID_ATTR_TABLE_COLUMN,
     *    SfxUInt16Item Rows SID_ATTR_TABLE_ROW, SfxInt32Item Flags FN_PARAM_1,
     *    SfxStringItem AutoFormat FN_PARAM_2)
     *
     * Handler `sw/source/uibase/shells/basesh.cxx:3237` gates the args branch on
     * `pArgs->Count() >= 2` — at least TWO items — and falls back to a dialog at :3282 when
     * either count is zero. That fallback uses `weld::DialogController::runAsync` (:3288), which
     * per FMT's own wedge discriminator (`.run()` = wedge, async = survivable) is NOT the wedge
     * class — measured here rather than trusted. */
    } else if (strcmp(op, "insert-table") == 0) {
        if (argc < 9) { fprintf(stderr, "needs <cols> <rows> <out_path> <format_ext>\n"); return 2; }
        char args[1024];
        snprintf(args, sizeof args,
                 "{\"Columns\":{\"type\":\"unsigned short\",\"value\":%s},"
                 "\"Rows\":{\"type\":\"unsigned short\",\"value\":%s}}", argv[5], argv[6]);
        printf("DISPATCH: .uno:InsertTable %s\n", args);
        uno(doc, ".uno:InsertTable", args);
        printf("RETURNED: postUnoCommand\n");
        pump(doc, 0);
        printf("PUMPED\n");
        rc = save_as(doc, argv[7], argv[8]);

    } else if (strcmp(op, "insert-table-noargs") == 0) {
        if (argc < 7) { fprintf(stderr, "needs <out_path> <format_ext>\n"); return 2; }
        printf("DISPATCH: .uno:InsertTable {}\n");
        uno(doc, ".uno:InsertTable", "{}");
        printf("RETURNED: postUnoCommand\n");
        pump(doc, 0);
        printf("PUMPED\n");
        rc = save_as(doc, argv[5], argv[6]);

    } else {
        printf("RESULT: FAIL unknown op %s\n", op);
        return 2;
    }

    printf("RESULT: %s\n", rc == 0 ? "OK" : "FAIL save");
    return rc;
}
