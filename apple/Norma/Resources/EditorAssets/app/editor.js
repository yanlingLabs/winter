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
// `{ path, model, savedVersionId, viewState, dirty, applyingExternal, listener }`.
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
                markSaved(message.path);
                break;
        }
    } catch (error) {
        console.error("normaEditor: " + type + " failed", error);
    }
}

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
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(text, resolveLanguage(path, language), uri);
    const entry = {
        path: path,
        model: model,
        savedVersionId: model.getAlternativeVersionId(),
        viewState: null,
        dirty: false,
        applyingExternal: false,
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
    // `seq` is echoed exactly as it arrived: it is the pull's own number, and Swift uses it to tell
    // a late answer to a superseded pull from the current one.
    sendToSwift("contentResponse", { path: path, seq: seq, text: entry.model.getValue() });
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
    refreshDirty(entry);
}

/**
 * Swift wrote this model's content to disk: the saved point moves to the text the model has RIGHT
 * NOW, and the dirty flag clears through the ordinary transition machinery (so a `modelDirtyChanged`
 * with `dirty: false` follows, exactly as it would after an undo back to the saved text).
 *
 * It touches nothing else — not the buffer, not the undo stack, not the view state, not the content
 * listener. That is the whole reason this message exists rather than Swift acking a save with
 * `applyExternalContent`: that route goes through `setValue`, whose `_setValueFromTextBuffer` clears
 * the model's command manager, so every save would silently destroy the user's undo history.
 */
function markSaved(path) {
    const entry = page.models.get(path);
    if (!entry) {
        console.warn("normaEditor: markSaved for a path that is not open:", path);
        return;
    }
    entry.savedVersionId = entry.model.getAlternativeVersionId();
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
