// editor-plumbing Task 4 — the Monaco host page.
//
// ONE editor instance, a table of models keyed by absolute path, and one entry point Swift calls:
// `window.normaEditor.dispatch(message)`. Swift owns every file on disk; this page owns buffers,
// view state and the dirty flag, and says so over the bridge (`bridge-protocol.js`).

import { OUTBOUND_MESSAGE_TYPES, sendToSwift } from "./bridge-protocol.js";

// Everything Monaco loads hangs off the `assets` host, which is the SAME URL in both layouts this
// page may be served under (see editor.html). The scheme is read off `location` rather than
// written down, so the page never hardcodes its own origin — the one value that does differ if the
// shell moves to `norma-editor://assets/app/editor.html`.
const ASSETS_BASE = window.location.protocol + "//assets/";

const THEME_NAME = "norma";
// `defineTheme` throws "Illegal theme base!" for anything outside this set (measured in the
// vendored editor.main.js, not remembered) — so the base is validated rather than passed through.
const BUILTIN_THEME_BASES = ["vs", "vs-dark", "hc-black", "hc-light"];

// ALL page state, in one object, deliberately: Task 5 adds `normaEditorDebugState()` and this is
// what it reads. `models` maps an absolute path to
// `{ path, model, savedVersionId, viewState, dirty, applyingExternal, lastPull, listener }`.
const page = {
    editor: null,
    models: new Map(),
    currentPath: null
};

// The `monaco` global does not exist until editor.main has loaded; bound once in `boot`.
let monaco = null;

// Installed BEFORE Monaco loads so a message that arrives early is reported rather than thrown:
// Swift's contract is to send nothing before `ready`, and if that is ever broken this is how it
// shows up in a log instead of as a missing-property TypeError inside an injected script.
window.normaEditor = { dispatch: dispatch };

/**
 * Task 5's window onto this page's model table — **data only, and not a bridge message.**
 *
 * `page` is module-scoped, so nothing outside this file can see it; the harness reads this global
 * through CDP `Runtime.evaluate` with `returnByValue`, which is why every value below is a plain
 * string, number, boolean, array or small plain object. Returning `page` itself would hand back
 * Monaco models and disposables that cannot be serialised at all.
 *
 * Deliberately NOT an `EditorBridgeInbound` variant: it answers a question the app never asks
 * (Swift already knows which models it opened), so putting it on the wire would grow the protocol
 * for a debugger's benefit. `dirtyMap` is the page's own `entry.dirty` — the value the tab dot
 * follows — rather than a recomputation, so a harness comparing it against the
 * `modelDirtyChanged` messages it received is comparing two independent witnesses of the same fact.
 *
 * **Task 1 (Stage B hygiene) adds `viewTop`/`position`:** the LIVE editor's `getScrollTop()` and
 * `getPosition()`, not a per-model cache. `activateModel` saves and restores view state PER MODEL
 * (`saveViewState`/`restoreViewState`), but what is actually on screen right now is a property of
 * the editor itself, not of whichever model happens to be current — which is exactly what the
 * harness's view-state drill needs to prove survived a switch-away-and-back round trip.
 */
window.normaEditorDebugState = function () {
    const dirtyMap = {};
    page.models.forEach(function (entry, path) { dirtyMap[path] = entry.dirty; });
    // `page.editor` is null only before `boot()` completes, which is before the first `ready` — no
    // drill ever calls this that early, but reading it this way answers 0/null instead of throwing
    // rather than assume that holds forever.
    const position = page.editor ? page.editor.getPosition() : null;
    return {
        paths: Array.from(page.models.keys()),
        current: page.currentPath,
        dirtyMap: dirtyMap,
        viewTop: page.editor ? page.editor.getScrollTop() : 0,
        position: position ? { lineNumber: position.lineNumber, column: position.column } : null
    };
};

// --- Monaco boot -------------------------------------------------------------------------------

// The workers cannot be `new Worker("norma-editor://assets/...")` from this origin, so Monaco's own
// documented shim is used: a blob: bootstrap that sets the worker's loader baseUrl and then
// importScripts the real worker. This mirrors, deliberately, the blob editor.main.js builds for
// itself in `defaultWorkerFactory` — the `Worker` is created from the blob, and everything after
// that is a same-scheme load.
//
// baseUrl is the PARENT of `vs/`, with the trailing slash: workerMain.js does
// `const n = MonacoEnvironment.baseUrl ...; require.config({ baseUrl: n }); ... n + "vs/loader.js"`.
// Pointing it at `.../vs` would make every nested worker module resolve to `.../vs/vs/...`.
window.MonacoEnvironment = {
    getWorkerUrl: function () {
        const bootstrap =
            "self.MonacoEnvironment = { baseUrl: " + JSON.stringify(ASSETS_BASE) + " };\n" +
            "importScripts(" + JSON.stringify(ASSETS_BASE + "vs/base/worker/workerMain.js") + ");\n";
        return URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
    }
};

// NO `baseUrl` here, and that is load-bearing. The loader's own
// `isAbsolutePath = /^((http:\/\/)|(https:\/\/)|(file:\/\/)|(\/))/` does not recognise a
// norma-editor: URL as absolute, so it would PREPEND baseUrl to the already-absolute path this
// rule produces — every module would be fetched from
// `norma-editor://assets/vs/norma-editor://assets/vs/...`. baseUrl defaults to "" and stays inert
// (the loader only appends a slash to it when its length is non-zero).
window.require.config({ paths: { vs: ASSETS_BASE + "vs" } });
window.require(["vs/editor/editor.main"], boot, function (error) {
    console.error("normaEditor: Monaco failed to load", error);
});

function boot() {
    monaco = window.monaco;
    page.editor = monaco.editor.create(document.getElementById("editor"), {
        automaticLayout: true,
        model: null
    });
    // Save is Swift's: the page asks, never writes. With no model open this is a no-op rather than
    // a save of "".
    page.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
        if (!page.currentPath) {
            return;
        }
        sendToSwift("saveRequested", { path: page.currentPath });
    });
    sendToSwift("ready");
}

// --- Swift -> page -----------------------------------------------------------------------------

/**
 * The single Swift-facing entry point. `message` is the object `EditorBridgeOutbound.javascript`
 * renders — `{ type, ...fields }` — never code: this function reads members off it and nothing
 * here evaluates anything.
 *
 * It NEVER throws. Swift injects `window.normaEditor.dispatch(<json>)` with no catch around it, so
 * one bad message must not take the bridge down with it.
 */
function dispatch(message) {
    const type = message && typeof message === "object" ? message.type : null;
    if (OUTBOUND_MESSAGE_TYPES.indexOf(type) < 0) {
        console.error("normaEditor: unknown message type:", type);
        return;
    }
    if (!page.editor) {
        console.error("normaEditor: " + type + " arrived before the editor was ready — dropped");
        return;
    }
    try {
        switch (type) {
            case "openModel":
                openModel(message.path, message.language, message.text);
                break;
            case "activateModel":
                activateModel(message.path);
                break;
            case "closeModel":
                closeModel(message.path);
                break;
            case "pullContent":
                pullContent(message.path, message.seq);
                break;
            case "applyExternalContent":
                applyExternalContent(message.path, message.text);
                break;
            case "setTheme":
                setTheme(message.tokens);
                break;
            case "markSaved":
                markSaved(message.path, message.seq);
                break;
        }
    } catch (error) {
        console.error("normaEditor: " + type + " failed", error);
    }
}

/**
 * Open a file as a model.
 *
 * ## The EOL contract (editor-product Task 8 — the spec's "CRLF ruling needed")
 *
 * **The file's own dominant line ending is what the editor keeps, and a mixed file unifies to it.**
 * That is Monaco's own rule, not a policy this page invents: `PieceTreeTextBufferBuilder` normalises
 * line endings while it BUILDS the buffer, by strict majority, with a tie going to LF —
 *
 * ```js
 * _getEOL(_){const b=this._cr+this._lf+this._crlf,p=this._cr+this._crlf;
 *            return b===0?_===1?"\n":"\r\n":p>b/2?"\r\n":"\n"}                 // vendored, verbatim
 * ```
 *
 * — and rewrites every terminator to that answer whenever the text disagrees with it. So a
 * uniformly-CRLF file round-trips byte for byte, a CRLF-majority file comes back all-CRLF, and an
 * LF-majority file comes back all-LF. The ruling is: **accept that normalisation**, because it
 * preserves what the file actually is, and say so in one place.
 *
 * `setEOL` below is that saying-so, and it is honest about being a GUARD rather than a behaviour:
 * on this vendored build it changes nothing, because the buffer has already picked CRLF by the same
 * rule and `TextModel.setEOL` early-returns on a match (`if(this._buffer.getEOL()===$)return;`,
 * vendored). It is here so that the page states the rule it depends on rather than inheriting it
 * silently — if a future Monaco changed `defaultEOL` or that normalisation, a CRLF file would keep
 * its endings anyway instead of being rewritten on its first save.
 *
 * **Two placement rules, both load-bearing if the guard ever does fire:**
 *
 *   1. BEFORE `savedVersionId` is read. A `setEOL` that changes anything bumps the model's version
 *      id and emits a content-changed event — snapshotting the saved point first would make a
 *      freshly-opened file report itself dirty, with nothing the user could do to make it clean.
 *   2. ONLY on a model this call created. The `getModel(uri)` branch hands back a model whose text
 *      is NOT `text` (the argument is dropped there), so deciding its EOL from bytes it does not
 *      hold would rewrite somebody else's buffer on a hunch.
 */
function openModel(path, language, text) {
    if (page.models.has(path)) {
        // Not an error worth refusing, but never a re-create: `createModel` THROWS on a URI that is
        // already registered, and silently replacing the buffer would discard unsaved edits.
        // Swift's way of saying "replace the text" is applyExternalContent.
        console.warn("normaEditor: openModel for an already-open path — activating instead:", path);
        activateModel(path);
        return;
    }
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    if (!model) {
        model = monaco.editor.createModel(text, resolveLanguage(path, language), uri);
        if (dominantEOLIsCRLF(text)) {
            model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
        }
    }
    const entry = {
        path: path,
        model: model,
        savedVersionId: model.getAlternativeVersionId(),
        viewState: null,
        dirty: false,
        applyingExternal: false,
        // `{ seq, versionId }` of the most recent `pullContent` answered for this model — what
        // `markSaved` clears the dirty flag TO. See `pullContent` for why only the latest is kept.
        lastPull: null,
        listener: null
    };
    entry.listener = model.onDidChangeContent(function () {
        refreshDirty(entry);
    });
    page.models.set(path, entry);
    activateModel(path);
}

function activateModel(path) {
    const entry = page.models.get(path);
    if (!entry) {
        console.error("normaEditor: activateModel for a path that is not open:", path);
        return;
    }
    if (page.currentPath === path) {
        return;
    }
    const outgoing = page.currentPath ? page.models.get(page.currentPath) : null;
    if (outgoing) {
        // Cursor, selection, scroll and folds, per model — saved on the way out, restored on the
        // way in, so a tab round-trip lands where the user left it.
        outgoing.viewState = page.editor.saveViewState();
    }
    page.editor.setModel(entry.model);
    page.currentPath = path;
    if (entry.viewState) {
        page.editor.restoreViewState(entry.viewState);
    }
}

function closeModel(path) {
    const entry = page.models.get(path);
    if (!entry) {
        console.error("normaEditor: closeModel for a path that is not open:", path);
        return;
    }
    if (entry.listener) {
        entry.listener.dispose();
    }
    page.models.delete(path);
    // Detach BEFORE disposing — an editor left holding a disposed model is a broken editor, not an
    // empty one.
    if (page.currentPath === path) {
        page.editor.setModel(null);
        page.currentPath = null;
    }
    entry.model.dispose();
}

function pullContent(path, seq) {
    const entry = page.models.get(path);
    if (!entry) {
        // Deliberately NO answer. A fabricated `contentResponse` with empty text is indistinguishable
        // from "the file is empty", and Swift's save would then truncate a real file. A pull for a
        // path this page does not have is a bug on the Swift side; silence is the safe failure, and
        // Task 5 reads this line.
        console.error("normaEditor: pullContent for a path that is not open — no answer sent:", path);
        return;
    }
    // Superseded FIRST, before anything below that can throw: a second pull supersedes the first
    // the instant it STARTS, not only once it manages to finish. `getValue()` throws on a model past
    // Monaco's heap ceiling — if the clear happened after it, a throwing pull would leave the PRIOR
    // pull's anchor in place, and a late `markSaved` for that stale seq would wrongly find a match
    // instead of failing closed. Clearing here means a throw leaves `lastPull` null — the same
    // fail-closed state an unanswered pull already gets — rather than a stale one that outlives it.
    entry.lastPull = null;
    // The text and the version id that text belongs to are read as ONE step — no `await` between
    // them, so nothing can edit the buffer in between — and the pair is remembered under this
    // pull's `seq`. That pair is the whole point: `markSaved` clears the dirty flag to THIS id
    // rather than to whatever the buffer holds when the acknowledgement arrives, so keystrokes made
    // while Swift was writing leave the file dirty instead of being marked saved and lost.
    const text = entry.model.getValue();
    const versionId = entry.model.getAlternativeVersionId();
    // ONLY THE LATEST PULL PER MODEL is remembered, and that bound is deliberate rather than
    // economical: the save flow issues one pull per file and waits for its answer, so a second pull
    // means the first is superseded — true even when this line never runs, per the clear above.
    // An acknowledgement for a `seq` this model no longer remembers fails closed (`markSaved` below
    // warns and clears nothing) — never a guess.
    entry.lastPull = { seq: seq, versionId: versionId };
    // `seq` is echoed exactly as it arrived: it is the pull's own number, and Swift uses it to tell
    // a late answer to a superseded pull from the current one.
    sendToSwift("contentResponse", { path: path, seq: seq, text: text });
}

function applyExternalContent(path, text) {
    const entry = page.models.get(path);
    if (!entry) {
        console.error("normaEditor: applyExternalContent for a path that is not open:", path);
        return;
    }
    // The suppression flag is not belt-and-braces: `setValue` fires the content listener, which
    // would compute dirty against the OLD saved id and emit `dirty: true` an instant before the new
    // id makes it false again. One external write, two spurious transitions, and a tab dot that
    // blinks. (Safe either way if Monaco ever fired that event asynchronously: by then the saved id
    // is already the new one, so the recompute answers "clean" on its own.)
    entry.applyingExternal = true;
    entry.model.setValue(text);
    entry.savedVersionId = entry.model.getAlternativeVersionId();
    entry.applyingExternal = false;
    // Any pull still awaiting acknowledgement described text that no longer exists in this buffer,
    // so it is forgotten: a late `markSaved` for it must warn rather than drag the saved point back
    // to a superseded version and make a model that IS on disk look dirty.
    entry.lastPull = null;
    refreshDirty(entry);
}

/**
 * Swift wrote the content of pull `seq` to disk. The saved point moves to **the version that pull
 * answered with**, and the dirty flag is recomputed through the ordinary transition machinery — so
 * a `modelDirtyChanged { dirty: false }` follows when the buffer has not moved since.
 *
 * **The contract, in three lines, because no test in this repo can execute it:**
 *
 *   1. `pullContent` stores `{ seq, versionId }` — the id of the exact text it handed to Swift.
 *   2. `markSaved` clears the saved point to THAT STORED id, never to the buffer's current one.
 *   3. A buffer that moved past the pull therefore stays DIRTY: its current alternative id no longer
 *      equals the saved point, which is the correct answer — those keystrokes are not on disk.
 *
 * Anchoring to the pull is what closes a race Swift cannot see from its side. Swift reads
 * `contentResponse`, writes the file, then sends this; if the user types in that window, a
 * path-only acknowledgement would clear the dot against a buffer that no longer matches disk, and
 * the trailing edits would be lost at the next close-without-prompt. Swift cannot detect it either:
 * a keystroke on an already-dirty model emits nothing, because transitions are all this page
 * reports.
 *
 * An unknown or superseded `seq` clears NOTHING and says so. Fail closed: guessing here is the data
 * loss this whole mechanism exists to prevent.
 *
 * It touches nothing else — not the buffer, not the undo stack, not the view state, not the content
 * listener. That is the other reason this message exists rather than Swift acking a save with
 * `applyExternalContent`: that route goes through `setValue`, whose `_setValueFromTextBuffer` clears
 * the model's command manager, so every save would silently destroy the user's undo history.
 */
function markSaved(path, seq) {
    // Both branches below log with console.warn, not console.error: a markSaved for a path that
    // already closed or a seq that is superseded is a benign RACE — a saved-ack landing after
    // close/supersede — not a bug to alert on.
    const entry = page.models.get(path);
    if (!entry) {
        console.warn("normaEditor: markSaved for a path that is not open:", path);
        return;
    }
    const pull = entry.lastPull;
    if (!pull || pull.seq !== seq) {
        console.warn("normaEditor: markSaved for an unknown or superseded pull — nothing cleared:",
                     path, seq);
        return;
    }
    // Idempotent on purpose: a duplicate acknowledgement re-applies the same id and changes nothing
    // (`refreshDirty` only speaks on a transition). A duplicate must be a safe no-op; silence must
    // not be.
    entry.savedVersionId = pull.versionId;
    refreshDirty(entry);
}

function setTheme(tokens) {
    const data = tokens && typeof tokens === "object" ? tokens : {};
    // Every field is normalised because `defineTheme` reads all four unconditionally and throws on
    // a base it does not know. The tokens are Swift-authored (Task 3 rules them trusted), so this
    // is not input validation — it is the difference between a wrong colour and a dead theme call.
    monaco.editor.defineTheme(THEME_NAME, {
        base: BUILTIN_THEME_BASES.indexOf(data.base) >= 0 ? data.base : "vs",
        inherit: data.inherit !== false,
        rules: Array.isArray(data.rules) ? data.rules : [],
        colors: data.colors && typeof data.colors === "object" ? data.colors : {}
    });
    monaco.editor.setTheme(THEME_NAME);
}

// --- Dirty tracking ----------------------------------------------------------------------------

/**
 * The tab's modified dot follows this and nothing else, so it is emitted ONLY on a transition —
 * a `modelDirtyChanged` per keystroke would be the same message a hundred times over.
 *
 * `getAlternativeVersionId` rather than `getVersionId` on purpose: it is the id Monaco rewinds when
 * the user undoes back to a previous state, so undoing to the last saved text reports CLEAN, which
 * `getVersionId` (monotonic) never would.
 */
function refreshDirty(entry) {
    if (entry.applyingExternal) {
        return;
    }
    const dirty = entry.model.getAlternativeVersionId() !== entry.savedVersionId;
    if (dirty === entry.dirty) {
        return;
    }
    entry.dirty = dirty;
    sendToSwift("modelDirtyChanged", { path: entry.path, dirty: dirty });
}

// --- Line endings ------------------------------------------------------------------------------

/**
 * Is CRLF this text's dominant line ending? **The vendored builder's rule, mirrored exactly**
 * (`_getEOL`, quoted in `openModel` above), and mirrored a third time on the Swift side
 * (`MonacoTextBuffer.terminatorCounts` / `opensWithCRLF`) so the save flow's expectation is computed
 * from the same arithmetic the page runs on.
 *
 * Counting is by TERMINATOR, not by character: a CRLF is one terminator, not a CR plus an LF, which
 * is what makes a uniformly-CRLF file count as 100% CR-bearing rather than 50%.
 *
 * `> total / 2`, never `>=`: **a tie goes to LF**, because the vendored rule is `p > b / 2`. One
 * CRLF against one LF is not a CRLF file.
 */
function dominantEOLIsCRLF(text) {
    let carriageBearing = 0;
    let total = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code === 13) {
            // CR, or the CR of a CRLF — one terminator either way, and both are CR-bearing.
            if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) {
                index++;
            }
            carriageBearing++;
            total++;
        } else if (code === 10) {
            total++;
        }
    }
    return total > 0 && carriageBearing * 2 > total;
}

// --- Language ----------------------------------------------------------------------------------

/**
 * Swift's explicit language wins; otherwise the answer comes from Monaco's OWN registry rather than
 * a hand-written extension table — which is also what makes extension-less names (Dockerfile,
 * Makefile) resolve. `plaintext` when nothing matches: a wrong highlighter is worse than none.
 */
function resolveLanguage(path, language) {
    if (typeof language === "string" && language.length > 0) {
        return language;
    }
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    // `dot > 0`, not `>= 0`: a dotfile like `.gitignore` is a NAME, not an extension.
    const extension = dot > 0 ? name.slice(dot) : "";
    const languages = monaco.languages.getLanguages();
    for (let i = 0; i < languages.length; i++) {
        const candidate = languages[i];
        const filenames = candidate.filenames || [];
        if (filenames.some(function (each) { return each.toLowerCase() === name; })) {
            return candidate.id;
        }
        const extensions = candidate.extensions || [];
        if (extension && extensions.some(function (each) { return each.toLowerCase() === extension; })) {
            return candidate.id;
        }
    }
    return "plaintext";
}
