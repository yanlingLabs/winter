import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - The state (PURE — `EditorRuntimeTests` drives every row of this without CEF)

/// Everything about a session's editor that anything outside it may read: what phase the page is
/// in, which files it holds, which of them is showing, and which are dirty.
///
/// Deliberately a plain value with no references in it. The whole point of the reducer below is that
/// the editor's lifecycle can be reasoned about — and tested — without a browser, and a state that
/// carried a view or a container would drag CEF back into the suite through the back door.
struct EditorRuntimeState: Equatable {
    /// Where the runtime is in its one-way boot.
    ///
    /// `idle → booting → ready` is the whole happy path; `failed` is reachable from `idle`/`booting`
    /// only, and is TERMINAL — recovery is a teardown and a fresh runtime, never a second `prewarm`
    /// against a browser that may be half-created. Teardown returns any phase to `idle`.
    enum Phase: String, Equatable {
        case idle
        case booting
        case ready
        case failed
    }

    /// One open model. `dirty` is the page's own answer, relayed by `modelDirtyChanged` and NEVER
    /// inferred here: the page computes it as `alternativeVersionId != savedVersionId`, which is the
    /// only definition that survives undo/redo across a save (`EditorBridgeOutbound.markSaved`).
    struct ModelEntry: Equatable {
        var dirty: Bool = false
    }

    var phase: Phase = .idle
    /// The editor browser's `CefBrowser::GetIdentifier()`, or 0 before one exists. What the hub's
    /// registration is keyed on.
    var browserId: Int32 = 0
    /// Absolute path → what the page holds for it.
    var models: [String: ModelEntry] = [:]
    /// The model the editor is showing, or `nil` — which is a REAL state, not a placeholder: closing
    /// the active model leaves the editor showing nothing until Swift activates something else
    /// (drill 9's `9.closeActive`).
    var current: String?
    /// Opens that arrived before the page was ready, in order, deduped. Flushed by `pageReady` and
    /// dropped by a boot failure (they can never land).
    var pendingOpens: [String] = []
    /// Why `phase == .failed`, in words, for whatever renders it (T5's calm error state).
    var failureReason: String?
    /// **editor-product Task 5: why a path has no model — the EXPLICIT signal, and the only honest
    /// one.** `models[path] == nil` is NOT "the file is missing": a queued open, a read still in
    /// flight and a read that failed are all "no model", and only the last of them is something to
    /// tell the user about. A tab that inferred a missing file from an absent model would show
    /// "File not found" for the whole 30 s a slow boot takes.
    ///
    /// Recorded by `openRequested` failing its read (`EditorRuntime.openAndSend`'s catch) and
    /// CLEARED by anything that supersedes it — a fresh `openRequested` for the same path (a retry
    /// must show a spinner, not the stale sentence), the model actually opening, a close, or
    /// teardown. Never set for a path this runtime already holds.
    var openFailures: [String: EditorOpenFailure] = [:]

    /// **editor-product Task 9: what each open file's tab is SAYING, above the editor.**
    ///
    /// Per PATH rather than per tab, because the two things that raise a banner — a watcher event
    /// and a save outcome — are both facts about a file, and because the runtime is the only place
    /// that sees all three save triggers (the page's own ⌘S never passes through a tab at all). The
    /// tab renders it through the mirror it already keeps (`PanelEditorTabModel.runtimeState`), so
    /// no new wire was needed for it to arrive.
    ///
    /// **Absent means `.none`** — `banner(for:)` below is the only reader, and the reducer removes
    /// an entry rather than storing `.none`, so two states that say the same thing are never
    /// unequal.
    var banners: [String: EditorTabBanner] = [:]

    func banner(for path: String) -> EditorTabBanner { banners[path] ?? .none }

    /// How many open models have unsaved edits. The input to "may this runtime be released when the
    /// shell leaves its session" — see `ShellSessionHost.editorRuntimeReleasedOnDeparture`.
    var dirtyCount: Int { models.values.filter(\.dirty).count }
}

/// Everything that can happen to a runtime. The imperative half feeds these; the reducer is the only
/// thing that decides what they mean.
enum EditorRuntimeEvent: Equatable {
    /// "Have an editor ready" — the pre-warm. Idempotent by construction: only `idle` acts on it.
    case prewarmRequested
    /// The answer from `NormaCEFBrowserIdentifierForParent`. **0 means the browser never came up**
    /// and the runtime fails rather than registering — a client registered under 0 would match every
    /// query in the process (`NormaCEF.h`, and `EditorBridgeHub.register`'s own guard).
    case browserIdentified(Int32)
    /// The page's `ready`, arriving through the hub.
    case pageReady
    /// "Open this file." Queued while booting; self-prewarming from `idle`.
    case openRequested(path: String)
    /// An `openModel` reached the page.
    case modelOpened(path: String)
    /// editor-product Task 5: the file could not be turned into a model — the read threw. Carries
    /// WHY, classified once (`editorOpenFailure(for:)`), because "File not found" is a lie for a
    /// file that exists and is a directory, is unreadable, or is not text.
    case openFailed(path: String, failure: EditorOpenFailure)
    case activateRequested(path: String)
    case closeRequested(path: String)
    /// The page's `modelDirtyChanged`.
    case dirtyChanged(path: String, dirty: Bool)
    /// The boot could not proceed — no embedded assets, CEF refused to start, or the page never said
    /// `ready`. Ignored once ready (a late watchdog must not condemn a working editor).
    case bootFailed(reason: String)
    /// The system appearance changed (`EditorRuntime.systemAppearanceChanged()`, wired to `NSApp`'s
    /// own `effectiveAppearance`). A no-op unless the page is actually up to repaint —
    /// editor-product Task 4.
    case appearanceChanged

    // MARK: editor-product Task 9 — the world changing underneath an open model

    /// **The file's bytes moved and it was not us** — the watcher's verdict, already classified
    /// (`editorDiskChange`) and carrying the text the read produced. The reducer decides what that
    /// MEANS: a clean model is reloaded silently, a dirty one gets a banner. The text travels on the
    /// event rather than being re-read by an effect (as `.openModel` does) because the read has
    /// already happened — it is HOW this event came to exist.
    case externalChanged(path: String, text: String)
    /// The file is gone.
    case externalDeleted(path: String)
    /// The banner's Reload, with the bytes a FRESH read produced — never the text the banner was
    /// raised with, which may be minutes old by the time the user answers.
    case reloadApplied(path: String, text: String)
    /// The banner's Keep mine.
    case keepMineChosen(path: String)
    /// The banner's ×.
    case bannerDismissed(path: String)
    /// A transient error's own timer expired (`editorTransientErrorDuration`).
    case transientErrorExpired(path: String)
    /// A save finished, however it finished. `.failed`'s sentence is what the banner shows; `.saved`
    /// RESOLVES a conflict (the file now holds this buffer); `.noModel` says nothing.
    case saveFinished(path: String, outcome: SaveOutcome)

    /// Release everything. Legal from EVERY phase, and the only route back to `idle`.
    case teardownRequested
}

/// What the imperative half must DO about an event. Named after the effect, never after the C call,
/// so the reducer's tests read as claims about the editor rather than about CEF.
enum EditorRuntimeEffect: Equatable {
    case createBrowser
    case registerWithHub(browserId: Int32)
    /// Resolve the current scheme's tokens and send `setTheme` — editor-product Task 4. Carries no
    /// payload: the reducer only decides WHEN (ready, and every later appearance change), never WHAT
    /// — that stays the imperative half's job, the same split `openModel` already draws between
    /// "read the file" (here, at flush time) and "decide to open one" (the reducer).
    case sendTheme
    /// Read the file from disk and send `openModel`. The read happens HERE, at flush time, rather
    /// than when the open was requested — a queued open must carry today's bytes, not the bytes the
    /// file had when a user clicked while the page was still booting.
    case openModel(path: String)
    case activateModel(path: String)
    case closeModel(path: String)
    /// editor-product Task 9: put these bytes in the model, preserving its undo history
    /// (`editor.js`'s `applyExternalContent`, upgraded from `setValue` to a full-range
    /// `pushEditOperations` edit in this task).
    case applyExternalContent(path: String, text: String)
    /// **Start watching this file** — emitted by `modelOpened`, i.e. at the first moment the page
    /// holds the model, which is also the first moment a save of it is possible
    /// (`EditorSaveCoordinator`'s `hasModel` gate reads the very table this event fills). That
    /// ordering is the answer to T8's "arm the watcher before the first save can happen": there is
    /// no window in which a write of this path could produce an event nobody is listening for.
    case watchFile(path: String)
    case unwatchFile(path: String)
    /// Unregister from the hub (if a browser was ever identified) and destroy the browser.
    case teardown(browserId: Int32)
}

/// **The whole lifecycle, as one pure function.** Every claim the plan makes about this runtime —
/// prewarm-once, ready-gates-opens, failed-on-`browserId`-0, teardown-from-every-phase — is a row of
/// `EditorRuntimeTests` driving this directly, with no browser, no window and no run loop.
enum EditorRuntimeReducer {

    // swiftlint:disable:next cyclomatic_complexity
    static func reduce(_ state: EditorRuntimeState,
                       _ event: EditorRuntimeEvent) -> (EditorRuntimeState, [EditorRuntimeEffect]) {
        var next = state

        switch event {

        case .prewarmRequested:
            // **Prewarm-once.** A second call while booting or ready is deliberately nothing at all,
            // not a second `NormaCEFCreateBrowser` — a second browser in the same container is one
            // nothing would ever close (`BrowserRuntime.create`'s own double-create guard, for the
            // identical reason). `failed` is terminal: recovery is teardown + a fresh runtime.
            guard state.phase == .idle else { return (next, []) }
            next.phase = .booting
            return (next, [.createBrowser])

        case .browserIdentified(let browserId):
            guard state.phase == .booting else { return (next, []) }
            guard browserId != 0 else {
                next.phase = .failed
                next.failureReason = "the editor browser never reported an id"
                next.pendingOpens = []
                return (next, [])
            }
            next.browserId = browserId
            // **Registration happens HERE, not on `ready` — and the ordering is load-bearing.**
            // `ready` IS a bridge query: it arrives through the hub, and the hub refuses a query from
            // a browser nobody registered. The page logs that refusal and never retries
            // (`bridge-protocol.js`'s `sendToSwift` — `onFailure` only logs), so a runtime that waited
            // for `ready` before registering would eat its own boot signal and stay `booting` forever.
            return (next, [.registerWithHub(browserId: browserId)])

        case .pageReady:
            guard state.phase == .booting else { return (next, []) }
            next.phase = .ready
            let queued = next.pendingOpens
            next.pendingOpens = []
            // **`.sendTheme` first.** The brand belongs on the editor before any file's first paint,
            // not raced against it — and ordering it ahead of the flushed opens costs nothing, since
            // `setTheme` and `openModel` land in the page independently of one another.
            return (next, [.sendTheme] + queued.map { .openModel(path: $0) })

        case .appearanceChanged:
            // Booting/idle/failed all have somewhere better for this to happen: a runtime still
            // booting sends the CURRENT scheme's theme the moment `pageReady` fires anyway (read
            // fresh, not cached), and `failed`/`idle` hold no page to repaint. Only `ready` acts.
            guard state.phase == .ready else { return (next, []) }
            return (next, [.sendTheme])

        case .openRequested(let path):
            // editor-product Task 5: a new ask SUPERSEDES the last failure for that path, before any
            // phase decides anything. The door that retries is real — T6's tree click on a file the
            // agent has just created, or a user who fixed the permissions — and a tab that kept
            // rendering "File not found" over an in-flight re-read would be lying for the whole
            // duration of the fix. The `.failed` arm below deliberately returns the UNTOUCHED state:
            // nothing acts there, so nothing may change either.
            next.openFailures.removeValue(forKey: path)
            switch state.phase {
            case .idle:
                // **An open is its own pre-warm.** The reveal hook is not the only way a runtime can
                // be wanted (a hop onto a session while the panel is already open fires no reveal),
                // and an open that silently did nothing because nobody pre-warmed would be the
                // "click that does nothing" class this repo keeps killing.
                next.phase = .booting
                next.pendingOpens = [path]
                return (next, [.createBrowser])
            case .booting:
                if !next.pendingOpens.contains(path) { next.pendingOpens.append(path) }
                return (next, [])
            case .ready:
                // Already open → activate it. The page refuses a second `openModel` for a path it
                // holds (it would discard unsaved edits) and activates instead; asking for the
                // activate directly keeps Swift's model of the page true either way.
                if state.models[path] != nil {
                    next.current = path
                    return (next, [.activateModel(path: path)])
                }
                return (next, [.openModel(path: path)])
            case .failed:
                // Absorbed: a failed runtime holds no page to open anything in. `state`, not `next`
                // — an absorbed event must not even clear a failure entry (see the note above).
                return (state, [])
            }

        case .modelOpened(let path):
            guard state.phase == .ready else { return (next, []) }
            if next.models[path] == nil { next.models[path] = EditorRuntimeState.ModelEntry() }
            // A model that opened cannot also be a file that could not be opened.
            next.openFailures.removeValue(forKey: path)
            // Nor can it still be saying anything about a PREVIOUS life of this path: a re-open
            // re-read the file, so whatever conflict or failure the last one ended on is answered.
            next.banners.removeValue(forKey: path)
            // `openModel` ends in the page's own `activateModel` (`editor.js`), so the model it just
            // created IS what the editor shows.
            next.current = path
            // editor-product Task 9 — the watch starts here, and only here (see `.watchFile`).
            return (next, [.watchFile(path: path)])

        case .activateRequested(let path):
            // An activate for a path this runtime does not hold is NOT turned into an open here: the
            // caller (T5's tab) knows whether it wants a lazy re-read, and guessing would re-read a
            // file the user only asked to look at.
            guard state.phase == .ready, state.models[path] != nil else { return (next, []) }
            next.current = path
            return (next, [.activateModel(path: path)])

        case .openFailed(let path, let failure):
            // **Gated on `.ready`, like every other arm that records what the page did.** The read
            // runs off the actor and can land after a teardown; recording a failure into the fresh
            // state a teardown just produced would make an idle runtime claim a missing file, and
            // nothing would ever clear it. A path this runtime already holds is likewise ignored:
            // that is a stale read racing a live model, and the model is the newer truth.
            guard state.phase == .ready, next.models[path] == nil else { return (next, []) }
            next.openFailures[path] = failure
            return (next, [])

        case .closeRequested(let path):
            next.pendingOpens.removeAll { $0 == path }
            // Whether or not there is a model to drop, a closed tab's failure — and anything its
            // banner was saying — goes with it: the path is no longer anybody's to render.
            next.openFailures.removeValue(forKey: path)
            next.banners.removeValue(forKey: path)
            guard state.models[path] != nil else { return (next, []) }
            next.models.removeValue(forKey: path)
            // The page DETACHES before it disposes and leaves the editor showing nothing; activating
            // a survivor is the caller's obligation, exercised by drill 9.
            if next.current == path { next.current = nil }
            // The watch goes with the model, so "a watcher exists exactly while a model does" is an
            // invariant of the reducer rather than a discipline the imperative half has to keep.
            return (next, [.closeModel(path: path), .unwatchFile(path: path)])

        case .dirtyChanged(let path, let dirty):
            guard next.models[path] != nil else { return (next, []) }
            next.models[path]?.dirty = dirty
            return (next, [])

        // MARK: editor-product Task 9

        case .externalChanged(let path, let text):
            // **Gated on the MODEL, like every other arm that describes the page's contents.** The
            // read runs off the actor and can land after a close or a teardown; reloading a model
            // that is not there would send the page a message it answers with a console error, and
            // bannering one would leave a sentence nothing can dismiss.
            guard let entry = next.models[path] else { return (next, []) }
            setBanner(&next, path, .externalChange(dirty: entry.dirty))
            // **Clean → silent reload; dirty → the banner and NOTHING else.** Never both: an
            // auto-reload of a dirty model is the data loss this whole task exists to prevent.
            return (next, entry.dirty ? [] : [.applyExternalContent(path: path, text: text)])

        case .externalDeleted(let path):
            guard next.models[path] != nil else { return (next, []) }
            setBanner(&next, path, .externalDeleted)
            return (next, [])

        case .reloadApplied(let path, let text):
            // The user chose Reload, so the apply happens whatever the dirty flag says — that is
            // precisely what "discard mine" means, and it is the ONE path that overwrites a dirty
            // buffer from disk.
            guard next.models[path] != nil else { return (next, []) }
            setBanner(&next, path, .reloadChosen)
            return (next, [.applyExternalContent(path: path, text: text)])

        case .keepMineChosen(let path):
            guard next.models[path] != nil else { return (next, []) }
            setBanner(&next, path, .keepChosen)
            return (next, [])

        case .bannerDismissed(let path):
            guard next.models[path] != nil else { return (next, []) }
            setBanner(&next, path, .dismissed)
            return (next, [])

        case .transientErrorExpired(let path):
            guard next.models[path] != nil else { return (next, []) }
            setBanner(&next, path, .transientErrorExpired)
            return (next, [])

        case .saveFinished(let path, let outcome):
            // A save awaits a pull and a write, so this arrives long after it was asked for: the
            // model may have closed and the runtime may have been torn down and rebuilt underneath
            // it. A path with no model has no banner to carry the news.
            guard next.models[path] != nil else { return (next, []) }
            switch outcome {
            case .saved:
                setBanner(&next, path, .saveSucceeded)
            case .failed(let message):
                setBanner(&next, path, .saveFailed(message))
            case .noModel:
                // Not a failure and never a banner (`SaveOutcome.noModel`'s own doc) — nothing
                // happened, and a red row for nothing is a lie.
                break
            }
            return (next, [])

        case .bootFailed(let reason):
            // A late watchdog must never condemn a page that came up.
            guard state.phase == .idle || state.phase == .booting else { return (next, []) }
            next.phase = .failed
            next.failureReason = reason
            next.pendingOpens = []
            return (next, [])

        case .teardownRequested:
            // **From every phase, including `idle`.** The effect is emitted unconditionally so the
            // imperative half has one path to run (it is idempotent), and so "teardown from anywhere
            // releases the slot" is a claim the tests can make about the reducer alone.
            return (EditorRuntimeState(), [.teardown(browserId: state.browserId)])
        }
    }

    /// One path's banner, moved by the pure conflict reducer (`EditorConflictReducer`) and stored
    /// NORMALISED: `.none` removes the entry rather than writing it, so two states that say the same
    /// thing compare equal — this whole value is `Equatable` and the tests compare it whole.
    private static func setBanner(_ state: inout EditorRuntimeState,
                                  _ path: String,
                                  _ event: EditorBannerEvent) {
        let next = EditorConflictReducer.reduce(state.banner(for: path), event)
        if next == .none {
            state.banners.removeValue(forKey: path)
        } else {
            state.banners[path] = next
        }
    }
}

// MARK: - The viewport seam (T5 mounts through this)

/// Where the ONE editor view goes. Implemented by the code tab's viewport (T5): the runtime hands
/// its container over and the host puts it on screen; a `nil` host means the view goes back to the
/// runtime's own hidden window, which is what keeps the browser alive with no tab showing it.
@MainActor
protocol EditorViewportHost: AnyObject {
    func adoptEditorView(_ view: NSView)
}

// MARK: - The runtime

/// editor-product Task 3 — **one hidden Monaco per session, and everything that has to happen for
/// there to be one.**
///
/// It owns a browser the way `BrowserRuntime` owns a web tab's: created through the CEF layer
/// directly, parked in a window that is never ordered in, and **deliberately outside
/// `BrowserSignals`/`BrowserLifecycleEngine`** (spec's non-goals: "web-tab lifecycle integration for
/// the editor browser"). A browser folded into that engine would be planned over, parked, stopped
/// and re-created underneath the user's unsaved edits.
///
/// What differs from `BrowserRuntime`, and why this is its own object rather than a tab kind:
///
///   * **one browser per SESSION, not per tab** — every code tab is a viewport onto this one page,
///     and a code→code switch is an `activateModel`, not a view move;
///   * **it speaks the editor bridge**, which means it must hold a hub registration keyed on a
///     `browserId` that does not exist until CEF says so (see `.browserIdentified`);
///   * **it holds unsaved user work**, which is why teardown is a decision (`ShellSessionHost`'s
///     departure policy) rather than a lifecycle plan's output.
///
/// The lifecycle itself is NOT here — it is `EditorRuntimeReducer`, pure and tested without CEF.
/// This half performs effects and relays what the page says.
@MainActor
final class EditorRuntime: ObservableObject {

    /// `norma-editor://app/editor.html` — the shell host, with Monaco on the sibling `assets` host.
    /// **Written once, here**, now that the product creates editor browsers too: two places writing
    /// it is two places for the scheme's URL shape to drift from the one the asset root serves.
    static let pageURL = "norma-editor://app/editor.html"

    /// The clock and the two ways this file defers work, borrowed wholesale from `BrowserRuntime`
    /// rather than copied — a second `Scheduler` with the same three members would be a second thing
    /// to keep in step for no gain.
    typealias Scheduler = BrowserRuntime.Scheduler

    // MARK: The injected seams

    /// **Every CEF call this file makes.** Same constraint, same shape and same reasoning as
    /// `BrowserRuntime.CEFDriver`: nothing CEF-shaped is callable under XCTest, so the runtime's
    /// logic has to be reachable without it.
    struct CEFDriver {
        /// The embedded editor assets, or `nil` when this build never ran the embed phase. Checked
        /// for the two files the page cannot boot without, exactly as the harness's setup step does.
        var assetRoot: () -> String?
        var registerAssetRoot: (String) -> Void
        var ensureInitialized: @MainActor () -> Bool
        var failureReason: @MainActor () -> String?
        /// editor-product Task 4: the third argument is the browser's OWN background at creation,
        /// `0xAARRGGBB` (`NormaCEF.h`'s `backgroundColorARGB`) — `EditorTheme.cardSurfaceBackgroundARGB`,
        /// always fully opaque here (unlike `BrowserRuntime`'s ordinary web tabs, which pass `0` —
        /// "no override" — since an arbitrary site has no brand to anticipate).
        var createBrowser: (PanelCEFContainerView, String, UInt32) -> Void
        var browserIdentifier: (PanelCEFContainerView) -> Int32
        var closeBrowser: (PanelCEFContainerView) -> Void
        var executeCDP: (PanelCEFContainerView, String, String?, @escaping (Bool, String) -> Void) -> Void

        static let production = CEFDriver(
            assetRoot: {
                guard let resources = Bundle.main.resourceURL?
                    .appendingPathComponent("EditorAssets", isDirectory: true),
                      FileManager.default.fileExists(
                        atPath: resources.appendingPathComponent("app/editor.html").path),
                      FileManager.default.fileExists(
                        atPath: resources.appendingPathComponent("vs/loader.js").path) else {
                    return nil
                }
                return resources.path
            },
            registerAssetRoot: { NormaCEFRegisterEditorAssetRoot($0) },
            ensureInitialized: { NormaCEFRuntime.ensureInitialized() },
            failureReason: {
                if case .failed(let reason) = NormaCEFRuntime.state { return reason }
                return nil
            },
            createBrowser: { NormaCEFCreateBrowser($0, $1, $2) },
            browserIdentifier: { NormaCEFBrowserIdentifierForParent($0) },
            closeBrowser: { NormaCEFCloseBrowser($0) },
            executeCDP: { NormaCEFRuntime.executeCDP(in: $0, method: $1, paramsJSON: $2, completion: $3) })
    }

    /// How often the browser's id is asked for after creation, and for how long.
    ///
    /// **A poll rather than a callback, because there is no callback to have**: `CreateBrowser` does
    /// not block (`NormaCEF.mm` says so in as many words) and the id exists only once CEF's
    /// `OnAfterCreated` has run. The cadence is set against the ONE deadline that matters — the
    /// page's `ready`, measured at 234 ms in the Stage-A harness, and `ready` cannot be sent before
    /// the page has even been navigated to, which is itself after `OnAfterCreated`. 25 ms leaves an
    /// order of magnitude of headroom.
    static let browserIdPollInterval: TimeInterval = 0.025
    static let browserIdPollAttempts = 400 // 10 s

    /// How long the page has to say `ready` once its browser exists. Generous: this covers Chromium
    /// creating a renderer, the scheme handler serving ~4 MiB of Monaco and the AMD loader booting
    /// it. A miss is a genuine failure worth surfacing rather than a spinner forever.
    static let readyDeadline: TimeInterval = 30

    // MARK: Identity and state

    let sessionId: String

    /// The published state. `stateSnapshot` is the same value under the name the plan's interface
    /// names it by — SwiftUI observes the property, and non-view callers read the snapshot.
    @Published private(set) var state = EditorRuntimeState()
    var stateSnapshot: EditorRuntimeState { state }

    /// **T8's two messages, now ROUTED as well as relayed.** Both go to `saveCoordinator` — the
    /// page's own ⌘S (`saveRequested`) starts a save, and a `contentResponse` answers the pull one is
    /// waiting on. These hooks remain beside that routing as pure observation, which is what T3's
    /// relay pin drives: a message swallowed by a `switch` arm that does nothing is how a whole flow
    /// goes missing unnoticed, and the pin is what keeps saying so.
    var onSaveRequested: ((String) -> Void)?
    var onContentResponse: ((_ path: String, _ seq: UInt64, _ text: String) -> Void)?

    /// Where the editor view is mounted right now. **Weak** — the host is a view owned by SwiftUI,
    /// and a strong reference here would outlive the tab that made it. Setting it moves the ONE
    /// container; setting it to `nil` parks the container back in the hidden window, which is what
    /// keeps the browser (and every unsaved buffer in it) alive with nothing on screen.
    weak var viewportHost: EditorViewportHost? {
        didSet { mountEditorView() }
    }

    private let hub: EditorBridgeHub
    private let driver: CEFDriver
    private let scheduler: Scheduler
    private let readFile: @Sendable (String) throws -> EditorFileContents
    /// What scheme `EditorTheme.tokensJSON`/`cardSurfaceBackgroundARGB` resolve against. Injected —
    /// the same reasoning as every other seam here — so a test can pin a payload's shape against a
    /// KNOWN scheme rather than whatever appearance happens to be active on the machine running the
    /// suite. Production reads AppKit directly (`currentColorScheme()`); nothing about the resolution
    /// itself belongs on the reducer's pure side, which only ever decides WHEN to ask for one.
    /// `@MainActor` (like `BrowserSignals.memoryBytes`/`PanelDiffTab`'s `fetch`): every call site is
    /// already on the actor, and the default value calls a `@MainActor` static method directly.
    private let colorScheme: @MainActor () -> ColorScheme
    /// editor-product Task 9: how an open model gets its watch. Injected on the same terms as every
    /// other seam here — the real one holds two kernel event sources and a debounce timer, none of
    /// which a unit test may own — and the double a test substitutes fires `onChange` on demand,
    /// which is what makes the whole conflict flow drivable without a filesystem.
    private let makeWatcher: EditorFileWatcherFactory

    /// What the save flow does to the world, or `nil` to build the real thing from this runtime on
    /// first use. Injected only by tests — the same seam-shaped reason every other member of this
    /// section is injected: the whole flow speaks to a Chromium page and writes to disk.
    private let saveEditorOverride: EditorSaveCoordinator.Editor?

    private var container = PanelCEFContainerView()
    private var hiddenWindowStorage: NSWindow?
    private var idPoll: Scheduler.Cancellable?
    private var readyWatchdog: Scheduler.Cancellable?

    // MARK: editor-product Task 9 — the watch tables

    /// One live watch per open model. Kept in step with `state.models` by the reducer's own
    /// `.watchFile`/`.unwatchFile` effects rather than by discipline here.
    private var watchers: [String: FileTreeWatching] = [:]
    /// **The generation of the read in flight for each path — the stale-read guard.**
    ///
    /// The handler reads off the main actor, so two debounced fires for one path can overlap and the
    /// OLDER read can resume last, comparing bytes that are already superseded against a baseline
    /// the newer read has moved. That is a false "changed on disk" out of thin air. Every read takes
    /// a number before it starts and drops itself on resume if a later one has begun; the later read
    /// describes the same file, so nothing is lost by dropping the earlier one.
    private var watchGenerations: [String: Int] = [:]
    /// The transient error's own 5 s timer, per path (`editorTransientErrorDuration`), paired with
    /// the banner value it is standing FOR. Armed and cancelled by `syncBannerTimer(path:)`, which
    /// is called after every banner-moving dispatch — a conflict raised over a transient error takes
    /// its timer down with it, and (wave-8 item 3) a dispatch that leaves the SAME `.transientError`
    /// standing leaves this timer's deadline alone rather than re-arming a fresh window under it —
    /// see that method's own doc. The paired banner is what makes "the same" checkable at all.
    private var bannerTimers: [String: (banner: EditorTabBanner, timer: Scheduler.Cancellable)] = [:]
    /// The ONE Combine wire this object holds (`ShellSessionHost.cancellables`'s identical shape and
    /// reasoning) — `NSApp`'s own `effectiveAppearance`, below, so its lifetime is this runtime's own
    /// and no separate teardown is needed (`AnyCancellable.cancel()` fires on deinit).
    private var cancellables = Set<AnyCancellable>()

    init(sessionId: String,
         hub: EditorBridgeHub = .shared,
         driver: CEFDriver = .production,
         scheduler: Scheduler = .production,
         colorScheme: @escaping @MainActor () -> ColorScheme = { EditorRuntime.currentColorScheme() },
         readFile: @escaping @Sendable (String) throws -> EditorFileContents = EditorRuntime.readTextFile,
         saveEditor: EditorSaveCoordinator.Editor? = nil,
         // An inline closure LITERAL rather than a reference to a named static, for the reason
         // `FileTreeModel.init` documents empirically: a default-argument expression is not
         // evaluated in a context Swift treats as already on the main actor, and a literal runs
         // nothing at creation time so the question never arises.
         makeWatcher: @escaping EditorFileWatcherFactory = { path, onChange in
             DispatchSourceFileWatcher(path: path, onChange: onChange)
         }) {
        self.sessionId = sessionId
        self.hub = hub
        self.driver = driver
        self.scheduler = scheduler
        self.colorScheme = colorScheme
        self.readFile = readFile
        self.saveEditorOverride = saveEditor
        self.makeWatcher = makeWatcher
        // editor-product Task 4 — the app's first reactor to appearance change that is NOT a
        // SwiftUI view: grepped, nothing else in this codebase observes `effectiveAppearance`,
        // because every other surface adapts automatically through `Color`/`Image`'s own machinery,
        // which a Chromium page has none of. Fires once, synchronously, on subscribe (Combine's KVO
        // publisher replays the current value) — a harmless no-op here, exactly like
        // `ShellSessionHost.init`'s own `directory.$rows` subscription: this runtime is `.idle` the
        // moment it is constructed, and the reducer's `.appearanceChanged` case only acts when
        // `.ready`.
        NSApp.publisher(for: \.effectiveAppearance)
            .sink { [weak self] _ in self?.systemAppearanceChanged() }
            .store(in: &cancellables)
    }

    /// What `colorScheme`'s production default reads: AppKit's own answer to "is the system in dark
    /// mode right now", the same `bestMatch(from:)` idiom drawing code uses to resolve a dynamic
    /// color — there is no SwiftUI `\.colorScheme` environment to read here, since nothing about this
    /// object is a view.
    static func currentColorScheme() -> ColorScheme {
        NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? .dark : .light
    }

    // MARK: The doors

    /// Have an editor ready for this session. Idempotent (the reducer's `prewarm-once` row), and
    /// cheap to call from anywhere that thinks the user is about to want one.
    func prewarm() {
        perform(dispatch(.prewarmRequested))
    }

    /// Open a file: read it from disk, hand the bytes to the page, and let the page show it.
    ///
    /// `async` all the way to the read, which happens off the main actor — the one genuinely
    /// blocking thing in this object. An open requested before the page is ready is QUEUED and this
    /// returns immediately; the read then happens at flush time, against the file as it is then.
    ///
    /// **wave-8 item 6: fire-and-forget past the read.** The `.openModel` message's own completion
    /// (`openAndSend`'s `send(...)` callback, which is what actually dispatches `.modelOpened` and
    /// makes `state.models[path]` exist) is never awaited here — this function's `await` spans only
    /// the disk read, so it can and does return before the page has acknowledged the open at all. A
    /// caller doing `await runtime.openFile(path)` and then reading `stateSnapshot.models[path]`
    /// immediately after may find nothing there yet. Never sequence off this await — observe
    /// published state (`state`/`stateSnapshot`) instead, the way every real caller already does.
    func openFile(_ absolutePath: String) async {
        for effect in dispatch(.openRequested(path: absolutePath)) {
            if case .openModel(let path) = effect {
                await openAndSend(path)
            } else {
                perform([effect])
            }
        }
    }

    /// Bring an already-open model to the front. A path this runtime does not hold is a no-op — see
    /// the reducer's `activateRequested` for why it is not silently turned into an open.
    func activate(_ path: String) {
        perform(dispatch(.activateRequested(path: path)))
    }

    /// Drop a model. **Says nothing about saving**: a dirty model closed here loses its edits, which
    /// is why T10's close gate asks first. This is the mechanism, not the policy.
    func close(_ path: String) {
        perform(dispatch(.closeRequested(path: path)))
    }

    /// Release everything: the hub registration, the browser, the hidden window and the timers.
    /// Legal from every phase and safe twice. Synchronous by contract — the quit path (T10) and the
    /// shell's departure policy both need it to have HAPPENED when they return.
    func teardown() {
        perform(dispatch(.teardownRequested))
    }

    /// The system's light/dark appearance changed. **The testable seam** (editor-product Task 4):
    /// wired to `NSApp`'s own KVO in `init`, above, but a test calls this directly rather than
    /// flipping the real OS appearance — the same posture the whole file already takes toward CEF
    /// (drive the door, never the framework underneath it).
    func systemAppearanceChanged() {
        perform(dispatch(.appearanceChanged))
    }

    // MARK: - editor-product Task 8: saving

    /// **The save flow, owned here** (`EditorSaveCoordinator`) — one per runtime, because the seq
    /// counter, the outstanding pull and the coalescing table are all facts about ONE page.
    ///
    /// `lazy` rather than built in `init` so its seam can close over a fully-initialised `self`
    /// without the dance a stored property would need; weak in every closure, since this object owns
    /// the coordinator and the coordinator would otherwise own it back.
    private(set) lazy var saveCoordinator = EditorSaveCoordinator(
        sessionId: sessionId,
        editor: saveEditorOverride ?? EditorSaveCoordinator.Editor(
            hasModel: { [weak self] path in self?.state.models[path] != nil },
            pull: { [weak self] path, seq in self?.send(.pullContent(path: path, seq: seq)) },
            markSaved: { [weak self] path, seq in self?.send(.markSaved(path: path, seq: seq)) },
            noteExpectedWrite: { [weak self] path in self?.noteExpectedWrite(path: path) },
            withdrawExpectedWrite: { [weak self] path in self?.withdrawExpectedWrite(path: path) },
            write: { [weak self] path, text in
                // **The BOM the read swallowed, put back** (fix round 1) — see `pathsWithBOM`.
                let withBOM = self?.pathsWithBOM.contains(path) ?? false
                // Off the main actor, like `openAndSend`'s read and for the same reason: a save must
                // not stall the shell on a slow or network volume.
                try await Task.detached(priority: .userInitiated) {
                    try EditorSaveCoordinator.writeAtomically(text, to: path, withBOM: withBOM)
                }.value
                // editor-product Task 9: the write LANDED, so Swift now knows exactly what the file
                // holds — see `noteWriteLanded`. Only on success; a throw propagates from the line
                // above and the coordinator withdraws its own note.
                self?.noteWriteLanded(path: path, text: text)
            }),
        scheduler: scheduler)

    /// Save one open file. **The one path all three triggers land in** — the app's ⌘S menu item, the
    /// code tab's save button and the page's own ⌘S (`saveRequested`, routed in `receive` below).
    @discardableResult
    func save(_ path: String) async -> SaveOutcome {
        let outcome = await saveCoordinator.save(path: path)
        // **editor-product Task 9: every save's outcome lands in the tab's banner from HERE**, which
        // is the only place all three triggers meet — the page's own ⌘S never passes through a tab
        // at all, so a banner fed from the tab's save button would stay silent for it. Coalesced
        // callers both arrive with the SAME outcome, and re-reducing it is idempotent.
        perform(dispatch(.saveFinished(path: path, outcome: outcome)))
        syncBannerTimer(path: path)
        return outcome
    }

    /// **The watcher-suppression seam T9 consumes.**
    ///
    /// A save writes the file the editor is watching, so the watcher T9 installs per open model will
    /// see an event for a change it already knows about. `EditorSaveCoordinator` files a note here
    /// immediately BEFORE its rename; T9's watcher calls `consumeExpectedWrite(path:)` when an event
    /// arrives and treats a `true` answer as "this was us" — silently, with no reload and no banner.
    ///
    /// **A counted bag, not a set** — the brief's word was "set", and one save per file is the
    /// ordinary case, but "one event per note" is multiset arithmetic: two saves of the same file in
    /// quick succession are two renames and two events, and a set would suppress only the first.
    ///
    /// **The obligation this hands T9**: a note is consumed by an EVENT, so a note that never gets
    /// one lingers, and the next genuine external change to that file would be swallowed by it. The
    /// two ways that happens are already closed here — a write that throws withdraws its own note
    /// (`EditorSaveCoordinator.performSave`), and teardown drops the whole bag — but the third is
    /// T9's to rule on: a rename whose event the watcher misses because the watcher is not installed
    /// yet (a save on a model whose watcher T9 arms lazily). T9 should either arm the watcher before
    /// the first save can happen or bound a note's lifetime; it must not assume the bag drains.
    ///
    /// **The SECOND obligation this hands T9 (fix round 1): compare POST-STRIP text.** A BOM'd file's
    /// model holds the text WITHOUT its three leading bytes (`readTextFile` below), so a clean/dirty
    /// comparator that diffs raw disk bytes against the model's text finds a difference on every
    /// BOM'd file from the moment it opens — a phantom "changed on disk" banner over a file nobody
    /// touched. Strip the BOM from the disk bytes before comparing (`pathsWithBOM` says which files
    /// have one), exactly as the save path re-adds it after.
    private var pendingExpectedWrites: [String: Int] = [:]

    func noteExpectedWrite(path: String) {
        pendingExpectedWrites[path, default: 0] += 1
    }

    func withdrawExpectedWrite(path: String) {
        guard let count = pendingExpectedWrites[path] else { return }
        if count <= 1 {
            pendingExpectedWrites.removeValue(forKey: path)
        } else {
            pendingExpectedWrites[path] = count - 1
        }
    }

    /// T9's door: was the change at `path` one of ours? Consumes ONE note per call.
    func consumeExpectedWrite(path: String) -> Bool {
        guard pendingExpectedWrites[path] != nil else { return false }
        withdrawExpectedWrite(path: path)
        return true
    }

    /// How many of this runtime's own writes at `path` are still unaccounted for.
    func expectedWriteCount(for path: String) -> Int {
        return pendingExpectedWrites[path] ?? 0
    }

    /// **editor-product Task 9's answer to the obligation above: a note's lifetime ends when its
    /// WRITE does, not when an event happens to arrive.**
    ///
    /// The hazard T8 handed over is that a note is consumed by an EVENT, and events can fail to
    /// arrive (a debounce coalescing two renames into one fire; the measured re-arm race in
    /// `DispatchSourceFileWatcher`'s own doc) — after which the bag's leftovers silently swallow the
    /// next GENUINE external change. That is closed here rather than by a timer, and the bound is
    /// provable rather than generous:
    ///
    ///   * `EditorSaveCoordinator` coalesces saves **per path**, so at most one write per path is
    ///     ever in flight (`save(path:)`'s `inFlight` table, entered and left with no suspension
    ///     point in between);
    ///   * therefore, at the instant one write lands, every note standing for that path belongs to a
    ///     write that has already landed — including its own;
    ///   * so the bag for that path can be emptied outright, and the file's known contents set to
    ///     exactly what was written.
    ///
    /// The consequence that makes it worth doing: an external change arriving immediately AFTER one
    /// of our saves is correctly external, because the note that would have swallowed it no longer
    /// exists. The counted bag survives as the belt for the one window this cannot cover — the
    /// rename has landed and this continuation has not run yet, where the watcher's read sees bytes
    /// the baseline has not caught up with, and `editorDiskChange` answers `.ours`.
    private func noteWriteLanded(path: String, text: String) {
        // wave-8 item 7d HAZARD, closed: clear the bag UNCONDITIONALLY. A naive
        // `guard state.models[path] != nil else { return }` at the top of this function would ALSO
        // skip this line for a path closed mid-save — `EditorSaveCoordinator.performSave` checks
        // `hasModel` only ONCE, before the pull, and never again before the write, so a close that
        // lands after the pull answers does not stop the write, and this function still runs.
        // `.closeRequested`'s own effect (`.closeModel`) already clears `diskBaseline`/`pathsWithBOM`
        // for the path, but it does NOT touch this bag — so a skipped clear here would leave a
        // lingering expected-write note that silently swallows the FIRST genuine external change on
        // a later re-open of the same path, misread as "ours" when it never was. Only the baseline
        // re-insert below is gated on the model still existing: a path closed mid-save has nothing
        // left that should remember new bytes for it, but its accounting must still settle either way.
        pendingExpectedWrites.removeValue(forKey: path)
        guard state.models[path] != nil else { return }
        diskBaseline[path] = text
    }

    /// **What Swift last knew the file at each open path to contain**, BOM already stripped — the
    /// primary suppressor, and the comparator T8's seam doc demands (post-strip text, never raw
    /// bytes: a BOM'd file's model holds the text without its three leading bytes, so a raw compare
    /// would report a phantom change on every one of them from the moment of open).
    ///
    /// Set in exactly three places, all of which are "somebody observed the file": the read at open
    /// (`openAndSend`), a write that landed (`noteWriteLanded`), and every watcher read that decided
    /// anything (`fileChangedOnDisk`). **Its lifecycle is `pathsWithBOM`'s, deliberately** — both are
    /// facts about the BYTES of one open file, both are re-answered by every read, and both are
    /// dropped by the same close and the same teardown. They are declared next to each other so that
    /// stays true.
    private var diskBaseline: [String: String] = [:]

    /// Test seam: what this runtime believes is on disk for `path`. Read by the tests that pin the
    /// suppression, and by nothing else.
    func knownDiskText(for path: String) -> String? { diskBaseline[path] }

    /// **Which open files began with a UTF-8 BOM** (fix round 1 — the Important).
    ///
    /// `String(data:encoding: .utf8)` — the decoder `readTextFile` uses, and the only decoder in this
    /// path — SILENTLY STRIPS a leading `EF BB BF`. Measured, not assumed: bytes
    /// `[0xEF, 0xBB, 0xBF, 0x6C]` decode to a `String` whose first scalar is `U+006C`. That makes the
    /// deletion invisible end to end: the read drops three bytes, so the page never receives them, so
    /// `getValue()` cannot return them, so the write cannot restore them — and `performSave` has no
    /// dirty gate, so a plain ⌘S on an UNTOUCHED Visual-Studio-authored file would rewrite it three
    /// bytes shorter, silently, the first time anybody pressed it.
    ///
    /// **The ruling is PRESERVE**, and it is this task's own sentence applied verbatim: a uniformly
    /// CRLF Windows file is not turned into an LF file by being opened, and neither is a BOM'd file
    /// turned into a BOM-less one (VS Code preserves it too). So the fact is remembered HERE, at the
    /// one place that ever sees the bytes, and re-emitted by the write
    /// (`EditorSaveCoordinator.writeAtomically(_:to:withBOM:)`).
    ///
    /// **The page stays BOM-blind, deliberately.** It holds text, not files; a `U+FEFF` handed to
    /// Monaco would show up as an invisible character in the buffer, in the undo stack and in every
    /// `getValue()` — which is precisely the kind of thing the editor should never have to know
    /// about. The BOM is a property of the FILE, and the file is Swift's.
    private var pathsWithBOM: Set<String> = []

    /// Will a save of `path` re-emit a UTF-8 BOM? Read by the write seam; exposed for the tests that
    /// pin the memory itself.
    func fileHadBOM(_ path: String) -> Bool { pathsWithBOM.contains(path) }

    // MARK: The reducer, driven

    /// Reduce synchronously, publish, and hand the effects back. **Every door goes through here and
    /// the state moves before anything asynchronous can begin** — which is what makes `prewarm()`
    /// twice in one turn create exactly one browser.
    private func dispatch(_ event: EditorRuntimeEvent) -> [EditorRuntimeEffect] {
        let (next, effects) = EditorRuntimeReducer.reduce(state, event)
        state = next
        return effects
    }

    private func perform(_ effects: [EditorRuntimeEffect]) {
        for effect in effects {
            switch effect {
            case .createBrowser:
                startBrowser()
            case .registerWithHub(let browserId):
                registerWithHub(browserId)
            case .sendTheme:
                sendTheme()
            case .openModel(let path):
                Task { @MainActor [weak self] in await self?.openAndSend(path) }
            case .activateModel(let path):
                send(.activateModel(path: path))
            case .closeModel(let path):
                // A closed model's BOM answer goes with it: the next open re-reads the file and
                // re-answers, and a stale `true` would put three bytes in front of a file that no
                // longer has any (fix round 1). Its known contents go with it for the same reason
                // and at the same moment — see `diskBaseline`.
                pathsWithBOM.remove(path)
                diskBaseline.removeValue(forKey: path)
                send(.closeModel(path: path))
            case .applyExternalContent(let path, let text):
                send(.applyExternalContent(path: path, text: text))
            case .watchFile(let path):
                startWatching(path)
            case .unwatchFile(let path):
                stopWatching(path)
            case .teardown(let browserId):
                performTeardown(browserId: browserId)
            }
        }
    }

    // MARK: Boot

    private func startBrowser() {
        guard let root = driver.assetRoot() else {
            perform(dispatch(.bootFailed(reason: "this build embeds no editor assets")))
            return
        }
        // FIRST, and before any browser exists: until this runs the scheme handler answers 404 to
        // everything, which is the fail-closed default rather than "the working directory".
        // Idempotent and process-global — every runtime registers the same root.
        driver.registerAssetRoot(root)

        // NOT synchronous, for the reason `BrowserRuntime.startBrowser` documents: `CefInitialize`
        // stands up a process tree, runs `OnContextInitialized` re-entrantly and starts a run-loop
        // timer, and this can be reached from inside a SwiftUI update or an event fold.
        scheduler.mainAsync { [weak self] in
            guard let self, self.state.phase == .booting else { return }
            guard self.driver.ensureInitialized() else {
                let reason = self.driver.failureReason() ?? "CEF did not start"
                self.perform(self.dispatch(.bootFailed(reason: reason)))
                return
            }
            // The container is born in the hidden window at a plausible viewport, NOT at 1×1:
            // `CreateBrowserNow` reads `[parent bounds]` exactly once, at creation, so a browser
            // created into an unsized container lays out at zero for as long as nothing attaches it
            // (`BrowserRuntime.parkingWindow`'s measured note). A pre-warmed editor that is never
            // opened would otherwise boot Monaco against a viewport nobody could ever see.
            self.parkEditorView()
            // editor-product Task 4, white-flash fix (half 1 of 2): the scheme active AT CREATION,
            // baked into the browser's own background before anything — the asset load, the AMD
            // bootstrap, Monaco's construction — has painted a single pixel. A LATER appearance
            // change does not revisit this: by then `editor.html`'s body is transparent (half 2) and
            // Monaco's own theme (kept live by `.appearanceChanged`, above) is what is actually
            // showing through it.
            self.driver.createBrowser(self.container, Self.pageURL,
                                      EditorTheme.cardSurfaceBackgroundARGB(for: self.colorScheme()))
            self.pollForBrowserId(attempt: 0)
            self.armReadyWatchdog()
        }
    }

    /// Ask CEF for the browser's id until it has one. Exhaustion feeds `browserIdentified(0)` — the
    /// same "0 means refuse" reading the header demands, arrived at by asking rather than assumed.
    private func pollForBrowserId(attempt: Int) {
        guard state.phase == .booting else { return }
        let browserId = driver.browserIdentifier(container)
        guard browserId == 0 else {
            perform(dispatch(.browserIdentified(browserId)))
            return
        }
        guard attempt < Self.browserIdPollAttempts else {
            perform(dispatch(.browserIdentified(0)))
            return
        }
        idPoll = scheduler.timer(scheduler.now().addingTimeInterval(Self.browserIdPollInterval)) {
            [weak self] in
            self?.pollForBrowserId(attempt: attempt + 1)
        }
    }

    private func armReadyWatchdog() {
        readyWatchdog = scheduler.timer(scheduler.now().addingTimeInterval(Self.readyDeadline)) {
            [weak self] in
            guard let self else { return }
            self.perform(self.dispatch(.bootFailed(reason: "the editor page never reported ready")))
        }
    }

    private func registerWithHub(_ browserId: Int32) {
        hub.register(browserId: browserId) { [weak self] message, respond in
            // **Answer BEFORE acting.** Acting can re-enter this object (a `ready` flushes queued
            // opens, which sends JavaScript into the page), and an entry still awaiting an answer
            // across that re-entry is one a later failure could strand.
            respond(true, "{}")
            self?.receive(message)
        }
    }

    /// Resolve the CURRENT scheme's tokens and send `setTheme` — the reducer's `.sendTheme` effect,
    /// performed. Resolved fresh on every call rather than cached: an appearance change asks again
    /// through the exact same door (`.appearanceChanged`'s effect is the identical `.sendTheme`), so
    /// there is nowhere a stale value could be read from even if one existed.
    private func sendTheme() {
        send(.setTheme(tokensJSON: EditorTheme.tokensJSON(for: colorScheme())))
    }

    private func receive(_ message: EditorBridgeInbound) {
        switch message {
        case .ready:
            idPoll?.cancel()
            idPoll = nil
            readyWatchdog?.cancel()
            readyWatchdog = nil
            perform(dispatch(.pageReady))
        case .modelDirtyChanged(let path, let dirty):
            perform(dispatch(.dirtyChanged(path: path, dirty: dirty)))
        case .saveRequested(let path):
            // **Trigger 3 of 3** (editor-product Task 8): Monaco's own ⌘S, landing in the same
            // coordinator the menu item and the tab's save button use. Not awaited — the page asked
            // for a save, it is not waiting for an answer, and the outcome reaches the user through
            // the dirty dot the page itself recomputes.
            Task { @MainActor [weak self] in _ = await self?.save(path) }
            onSaveRequested?(path)
        case .contentResponse(let path, let seq, let text):
            saveCoordinator.deliverContentResponse(path: path, seq: seq, text: text)
            onContentResponse?(path, seq, text)
        }
    }

    // MARK: Opening

    /// Read the file off the main actor, then hand it to the page.
    ///
    /// A read failure records NO model — the visible "File not found" state belongs to the tab (T5),
    /// which knows whether anything is showing this path at all. Recording a phantom model here
    /// would make the page and Swift disagree about what is open, which is the one disagreement the
    /// whole seq-anchored protocol exists to prevent.
    ///
    /// editor-product Task 5: it does record the FAILURE, though (`.openFailed` → `openFailures`),
    /// because the tab cannot infer one. Still logged as well — the reason string a user sees is
    /// deliberately short, and the log is where the underlying error survives in full.
    private func openAndSend(_ path: String) async {
        let reader = readFile
        let contents: EditorFileContents
        do {
            contents = try await Task.detached(priority: .userInitiated) { try reader(path) }.value
        } catch {
            NSLog("[EditorRuntime] \(sessionId): could not read \(path): \(error)")
            perform(dispatch(.openFailed(path: path, failure: editorOpenFailure(for: error))))
            return
        }
        guard state.phase == .ready else { return }
        // **Recorded before the text leaves for the page** (fix round 1): from here on this path's
        // three leading bytes exist nowhere else — see `pathsWithBOM`. A re-read of a file that lost
        // (or gained) its BOM re-answers the question rather than trusting the first answer, which is
        // why this ASSIGNS rather than only inserts.
        if contents.hadBOM { pathsWithBOM.insert(path) } else { pathsWithBOM.remove(path) }
        // editor-product Task 9: and this is the FIRST thing Swift knows about the file's contents —
        // the baseline every later watcher event is measured against (see `diskBaseline`).
        diskBaseline[path] = contents.text
        let text = contents.text
        // wave-8 item 6: this callback — not `openAndSend`'s own `async` return — is what actually
        // makes the model exist (`.modelOpened` is what flips `state.models[path]` in). It runs on
        // its own later turn, decoupled from `openFile`'s `await`, which already returned once this
        // `send` call was MADE. Never sequence off that await; observe published state instead.
        send(.openModel(path: path, language: editorLanguageHint(forPath: path), text: text)) {
            [weak self] ok in
            guard let self, ok else { return }
            self.perform(self.dispatch(.modelOpened(path: path)))
        }
    }

    // MARK: - editor-product Task 9: the world changing underneath an open model

    /// Start watching `path`. Called by the reducer's `.watchFile` effect, which `modelOpened`
    /// emits — so the watch is live from the first instant the page holds the model, which is also
    /// the first instant a save of it is possible.
    ///
    /// A factory that answers `nil` (the directory could not be opened) leaves the model unwatched:
    /// it shows what it was opened with, and it is never wrong about anything. Logged, because a
    /// file quietly not tracking disk is worth one line.
    private func startWatching(_ path: String) {
        guard watchers[path] == nil else { return }
        guard let watcher = makeWatcher(path, { [weak self] in
            // The watcher's own debounce has already coalesced the burst; this hop is what carries
            // the read off the main actor and back. Weak throughout: a fire racing a teardown must
            // find nothing rather than resurrect a runtime.
            Task { @MainActor [weak self] in await self?.fileChangedOnDisk(path) }
        }) else {
            NSLog("[EditorRuntime] \(sessionId): could not watch \(path) — the file will not "
                  + "reload if it changes on disk")
            return
        }
        watchers[path] = watcher
    }

    /// Stop watching, and forget everything that only made sense while we were.
    private func stopWatching(_ path: String) {
        watchers.removeValue(forKey: path)?.stop()
        // A read in flight for this path resumes into a runtime that no longer holds the model; the
        // generation bump makes it drop itself rather than rely on that check alone.
        //
        // **wave-8 item 7c: BUMP, never REMOVE the entry — pruning it here is UNSAFE, not merely
        // untidy.** If close deleted `watchGenerations[path]` outright, a later re-open of the SAME
        // path would start counting from `(nil ?? 0) + 1 == 1` again — the identical sequence a
        // FRESH runtime starts from. A stale in-flight read from the PREVIOUS lifetime that resumes
        // after the re-open would then carry a generation number that can collide with the new
        // lifetime's own count at the exact same value, passing both the generation guard AND the
        // model-exists guard (`fileChangedOnDisk`'s `watchGenerations[path] == generation,
        // state.models[path] != nil`) and dispatching bytes from a read nobody asked for into the
        // reopened model. Monotonically incrementing instead — never resetting — means a stale read
        // from any earlier lifetime always carries a generation strictly behind the current one, so
        // it can never pass the guard by coincidence. The table is not unbounded: every path's entry
        // is finite in number (bumped, not grown) and the whole table is dropped at `teardown()`
        // (`watchGenerations.removeAll()`), which is this runtime's true, bounded lifetime.
        watchGenerations[path] = (watchGenerations[path] ?? 0) + 1
        bannerTimers.removeValue(forKey: path)?.timer.cancel()
    }

    /// **The watcher's handler — one debounced fire, one read, one decision.** `async` and
    /// internal-by-default deliberately: it is the door the conflict tests drive, so that the whole
    /// flow (suppression, clean reload, dirty banner, deletion) is reachable with a fake watcher and
    /// a real temp file, with nothing to wait for and no run loop to spin.
    func fileChangedOnDisk(_ path: String) async {
        guard state.models[path] != nil else { return }
        let generation = (watchGenerations[path] ?? 0) + 1
        watchGenerations[path] = generation

        let reader = readFile
        var contents: EditorFileContents?
        var readFailure: Error?
        do {
            contents = try await Task.detached(priority: .utility) { try reader(path) }.value
        } catch {
            readFailure = error
        }

        // **Both guards, and both matter.** The generation is the stale-read guard (see
        // `watchGenerations`); the model check is the same "the page may have moved on" rule every
        // other post-await site here keeps.
        guard watchGenerations[path] == generation, state.models[path] != nil else { return }

        if let readFailure {
            // **Only a MISSING file is a deletion.** A permissions flap, a device error or a file
            // that has stopped being UTF-8 are all "we could not look right now" — keeping the
            // baseline and saying nothing is the honest answer, and a banner claiming the file was
            // deleted because a network volume hiccuped would be a lie the user acts on.
            guard case .notFound = editorOpenFailure(for: readFailure) else {
                NSLog("[EditorRuntime] \(sessionId): could not re-read \(path) after a change: "
                      + "\(readFailure) — the editor keeps what it has")
                return
            }
            // Swift knows nothing about the contents of a file that is not there. Clearing this is
            // what makes the file COMING BACK a change again, even if it comes back byte-identical
            // (a `git checkout` of a deleted file must clear the banner it raised).
            diskBaseline.removeValue(forKey: path)
        } else if let contents {
            // Re-answered on every read, exactly as `openAndSend` does: a file that lost or gained a
            // BOM externally re-decides, and the next save re-emits whatever it has NOW.
            if contents.hadBOM { pathsWithBOM.insert(path) } else { pathsWithBOM.remove(path) }
        }

        switch editorDiskChange(diskText: contents?.text,
                                baseline: diskBaseline[path],
                                expectedWrites: expectedWriteCount(for: path)) {
        case .unchanged:
            // The common answer, and it says nothing: our own completed save, a sibling's change
            // reaching the directory source, a `touch`.
            return

        case .ours:
            // The narrow window `noteWriteLanded`'s doc names: the rename has landed and the write's
            // own continuation has not run yet. Consume ONE note (T8's contract, verbatim) and treat
            // the bytes as known.
            _ = consumeExpectedWrite(path: path)
            diskBaseline[path] = contents?.text ?? diskBaseline[path]

        case .external(let text):
            // Recorded BEFORE the dispatch: whatever the reducer decides — silent reload or banner —
            // this is what the file now holds, and the next event must be measured against it.
            diskBaseline[path] = text
            perform(dispatch(.externalChanged(path: path, text: text)))
            syncBannerTimer(path: path)

        case .deleted:
            perform(dispatch(.externalDeleted(path: path)))
            syncBannerTimer(path: path)
        }
    }

    /// **The banner's Reload — discard mine, take what is on disk.**
    ///
    /// It re-READS rather than applying the text the banner was raised with: a banner can sit on
    /// screen for as long as the user takes to answer it, and applying minute-old bytes would
    /// discard the user's edits in favour of a version of the file that no longer exists either.
    func reloadFromDisk(_ path: String) async {
        guard state.models[path] != nil else { return }
        let reader = readFile
        let contents: EditorFileContents
        do {
            contents = try await Task.detached(priority: .userInitiated) { try reader(path) }.value
        } catch {
            NSLog("[EditorRuntime] \(sessionId): reload of \(path) could not read it: \(error)")
            // The file went away between the banner and the answer. Say THAT rather than leaving a
            // Reload button that does nothing.
            if case .notFound = editorOpenFailure(for: error) {
                diskBaseline.removeValue(forKey: path)
                perform(dispatch(.externalDeleted(path: path)))
                syncBannerTimer(path: path)
            }
            return
        }
        guard state.models[path] != nil else { return }
        if contents.hadBOM { pathsWithBOM.insert(path) } else { pathsWithBOM.remove(path) }
        diskBaseline[path] = contents.text
        perform(dispatch(.reloadApplied(path: path, text: contents.text)))
        syncBannerTimer(path: path)
    }

    /// **The banner's Keep mine.** The banner goes; nothing else moves. The baseline stays at what
    /// the watcher last saw, which is what makes the next ⌘S an ordinary overwrite (its own event
    /// resolves against the text it wrote) and a FURTHER external change a fresh conflict.
    func keepMine(_ path: String) {
        perform(dispatch(.keepMineChosen(path: path)))
        syncBannerTimer(path: path)
    }

    /// The banner's ×.
    func dismissBanner(_ path: String) {
        perform(dispatch(.bannerDismissed(path: path)))
        syncBannerTimer(path: path)
    }

    /// Arm, re-arm or cancel one path's transient-error timer to match the banner it now has.
    ///
    /// Called after every banner-moving dispatch rather than only after a failure, which is what
    /// makes two rules structural: a conflict raised over a transient error takes that timer down
    /// with it (a fire that arrived later could only clear the conflict, which is exactly what must
    /// not happen — the reducer refuses it too, and this is the belt); and (wave-8 item 3) a
    /// dispatch that leaves the SAME `.transientError` standing — byte-identical to what was already
    /// showing — leaves this timer's deadline exactly where it was, rather than cancelling and
    /// re-arming a fresh `editorTransientErrorDuration` window under it.
    ///
    /// **The bug this closes**: every call here used to unconditionally cancel-then-rearm whenever
    /// the RESULTING banner was any `.transientError`, whether or not the dispatch actually changed
    /// what was on screen. A clean external touch on a path already showing a save failure — the
    /// shape a background agent's own edit traffic makes, and it can repeat indefinitely — reduces to
    /// `clearingConflict`, which leaves a standing `.transientError` untouched
    /// (`EditorConflictReducer`); but this method could not tell "untouched" from "freshly raised"
    /// and rearmed either way, so the same sentence's countdown kept getting pushed out and the
    /// banner could be pinned open forever. A genuinely NEW or DIFFERENT failure (a fresh
    /// `.saveFailed` message) still gets a fresh window below — the comparison is on the banner
    /// VALUE, which is what "the same" or "different" actually means here, not on which event
    /// produced it.
    private func syncBannerTimer(path: String) {
        let banner = state.banner(for: path)
        guard case .transientError = banner else {
            bannerTimers.removeValue(forKey: path)?.timer.cancel()
            return
        }
        // A live timer already owns this EXACT standing banner — nothing moved, so its deadline
        // doesn't either.
        if let existing = bannerTimers[path], existing.banner == banner { return }
        bannerTimers.removeValue(forKey: path)?.timer.cancel()
        let deadline = scheduler.now().addingTimeInterval(editorTransientErrorDuration)
        let armed = scheduler.timer(deadline) { [weak self] in
            guard let self else { return }
            self.bannerTimers.removeValue(forKey: path)
            self.perform(self.dispatch(.transientErrorExpired(path: path)))
        }
        bannerTimers[path] = (banner: banner, timer: armed)
    }

    // MARK: Speaking to the page

    /// One outbound message, rendered by the codec and injected as the one call the page exposes.
    /// The bridge is inbound-only by design, so CDP's `Runtime.evaluate` is the ONLY way Swift can
    /// speak to the editor — the same door the harness uses.
    private func send(_ message: EditorBridgeOutbound, _ done: ((Bool) -> Void)? = nil) {
        let params: [String: Any] = [
            "expression": message.javascript,
            "returnByValue": true,
            "awaitPromise": false,
            "userGesture": true
        ]
        driver.executeCDP(container, "Runtime.evaluate", Self.jsonString(params)) { [weak self] ok, payload in
            guard let self else { return }
            let object = Self.jsonObject(payload)
            // CEF's door does not distinguish a protocol refusal from a JavaScript exception; both
            // mean the message did not take, and both are worth a line rather than silence.
            if let exception = object?["exceptionDetails"] as? [String: Any] {
                let text = (exception["exception"] as? [String: Any])?["description"] as? String
                    ?? exception["text"] as? String ?? "a JavaScript exception"
                NSLog("[EditorRuntime] \(self.sessionId): \(message.wireType) threw in the page: \(text)")
                done?(false)
                return
            }
            if !ok {
                let reason = (object?["message"] as? String) ?? "the CDP call failed"
                NSLog("[EditorRuntime] \(self.sessionId): \(message.wireType) was not delivered: \(reason)")
            }
            done?(ok)
        }
    }

    // MARK: The view

    /// The container is never in a window the user can see until a tab adopts it. Never ordered in —
    /// the shape `BrowserRuntime.parkingWindow` measured as indistinguishable from ordered-out and
    /// offscreen, so the simplest wins.
    private var hiddenWindow: NSWindow {
        if let existing = hiddenWindowStorage { return existing }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Norma editor (hidden)"
        hiddenWindowStorage = window
        return window
    }

    /// Testable laziness: a session that never opens an editor must not build a window for one.
    var hasHiddenWindow: Bool { hiddenWindowStorage != nil }

    private func mountEditorView() {
        guard let host = viewportHost else {
            parkEditorView()
            return
        }
        host.adoptEditorView(container)
    }

    private func parkEditorView() {
        guard let content = hiddenWindow.contentView else { return }
        content.addSubview(container)
        // Sized only when it has no size of its own — an attached container that comes back keeps
        // the panel's geometry rather than being resized underneath a live page (`BrowserRuntime.
        // park`'s live-gate fix B: parking must move a container, not resize it).
        if container.frame.isEmpty { container.frame = content.bounds }
    }

    // MARK: Teardown

    private func performTeardown(browserId: Int32) {
        // **The watchers die FIRST, and that ordering is what makes the line below safe** (T8's
        // teardown note, stated at the site it depends on). Clearing the bag mid-save would
        // otherwise be a real hazard: a save's rename can land after this runs, and a note that had
        // been dropped would leave that rename looking like somebody else's edit. It is harmless
        // only because nothing is left to notice it — every watch this runtime owned is stopped
        // here, and a fresh runtime re-reads every file it opens, so the first thing the next one
        // knows about any of these files is today's bytes.
        for (_, watcher) in watchers { watcher.stop() }
        watchers.removeAll()
        watchGenerations.removeAll()
        for (_, entry) in bannerTimers { entry.timer.cancel() }
        bannerTimers.removeAll()
        // The page these described is going away, and a note that outlived it could only ever
        // suppress a change made by somebody else (see `pendingExpectedWrites`). The BOM answers and
        // the known contents go with it for the same reason.
        pendingExpectedWrites.removeAll()
        pathsWithBOM.removeAll()
        diskBaseline.removeAll()
        idPoll?.cancel()
        idPoll = nil
        readyWatchdog?.cancel()
        readyWatchdog = nil
        if browserId != 0 { hub.unregister(browserId: browserId) }
        driver.closeBrowser(container)
        container.removeFromSuperview()
        // A fresh container for any later prewarm: `NormaCEFCloseBrowser` leaves this one empty, and
        // re-using a view that has hosted a closed browser buys nothing over a new one.
        container = PanelCEFContainerView()
        hiddenWindowStorage?.close()
        hiddenWindowStorage = nil
    }

    // MARK: Plumbing

    /// Read a text file, refusing bytes that are not UTF-8 rather than mangling them. A binary file
    /// opened in the editor would round-trip through `String` lossily and be written back CORRUPTED
    /// by the first save — the one failure mode of this whole feature that destroys data.
    ///
    /// **It answers with the BOM question as well as the text** (fix round 1), because this is the
    /// only place the bytes exist: `String(data:encoding: .utf8)` strips a leading `EF BB BF` and
    /// nothing downstream can tell that it did. See `pathsWithBOM`.
    static func readTextFile(_ path: String) throws -> EditorFileContents {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let text = String(data: data, encoding: .utf8) else {
            throw EditorFileReadError.notUTF8(path: path)
        }
        return EditorFileContents(text: text, hadBOM: data.starts(with: EditorFileContents.utf8BOM))
    }

    private static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object,
                                                     options: [.withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }

    private static func jsonObject(_ text: String?) -> [String: Any]? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

/// **What a read of a text file yields** (fix round 1): the text the editor gets, and the one fact
/// about the bytes that the text cannot carry.
///
/// A `String` cannot answer "did this file begin with a UTF-8 BOM?" — Foundation's UTF-8 decoder
/// strips one and says nothing — so the reader answers it here instead. `text` is always BOM-free,
/// which is what the page must hold; `hadBOM` is what the save path puts back.
struct EditorFileContents: Equatable {
    /// `EF BB BF`.
    static let utf8BOM: [UInt8] = [0xEF, 0xBB, 0xBF]

    var text: String
    var hadBOM: Bool = false
}

/// Why a file could not become a model.
enum EditorFileReadError: Error, Equatable {
    case notUTF8(path: String)
}

/// **editor-product Task 5: the two answers a tab can honestly give for a file it cannot show.**
///
/// Two rather than one because the copy differs and the difference matters: "File not found" for a
/// file that exists but is a directory, is unreadable, or holds bytes that are not text would send
/// the user looking for something that is right where they left it.
///
/// It is a value on the runtime's state (`EditorRuntimeState.openFailures`) rather than an `Error`
/// because it has to survive the read that produced it — the tab renders it minutes later, on a
/// render pass that has no relationship to the `catch` block it came from.
enum EditorOpenFailure: Equatable {
    /// Nothing at that path.
    case notFound
    /// It is there and could not be read as text. The reason is shown VERBATIM under the title, so
    /// it must be a sentence a person can act on, not a symbol name.
    case unreadable(reason: String)
}

/// PURE: which of the two a thrown read is (`EditorRuntime.openAndSend`'s catch, and `T5`'s tests
/// drive it directly with constructed errors).
///
/// `Data(contentsOf:)` reports a missing file as `NSCocoaErrorDomain` 260
/// (`NSFileReadNoSuchFileError`); 4 (`NSFileNoSuchFileError`) is the same fact from the older
/// file-manager paths, and both are matched rather than one, because which of them arrives is
/// Foundation's business and not a promise anybody made. Everything else — a directory (258/259), a
/// permission refusal (257), a device error, and this runtime's own `notUTF8` — is honestly
/// "unreadable", with the system's own sentence carried through.
func editorOpenFailure(for error: Error) -> EditorOpenFailure {
    if case EditorFileReadError.notUTF8 = error {
        return .unreadable(reason: "This file isn't UTF-8 text.")
    }
    let cocoa = error as NSError
    if cocoa.domain == NSCocoaErrorDomain,
       cocoa.code == NSFileReadNoSuchFileError || cocoa.code == NSFileNoSuchFileError {
        return .notFound
    }
    return .unreadable(reason: cocoa.localizedDescription)
}

/// **What language Swift claims for a path — deliberately nothing.**
///
/// `EditorBridgeOutbound.openModel` carries a `language` field and the page treats a non-empty value
/// as authoritative, so whatever this returns OVERRIDES the page's own resolution. That resolution
/// is `monaco.languages.getLanguages()` (`editor.js`'s `resolveLanguage`): Monaco's complete
/// registry, matching by whole filename first (`Dockerfile`, `Makefile`) and extension second, with
/// `plaintext` as the floor. A Swift-side extension table could only ever be a SMALLER copy of it,
/// and every gap in the copy would silently downgrade a file the editor already knew how to
/// highlight.
///
/// So the answer is the empty string, and the page decides — which is not an untested path: drill 9
/// opens `fixture-c.json` with exactly this value and the JSON language worker booted, fetched its
/// own nested modules and reported markers on it.
///
/// It is a named function rather than a literal at the call site because it is a real decision with
/// a real reason, and because a future need to override one language (a Norma-specific file type the
/// page's Monaco build does not register) has an obvious place to live.
func editorLanguageHint(forPath path: String) -> String {
    _ = path
    return ""
}
