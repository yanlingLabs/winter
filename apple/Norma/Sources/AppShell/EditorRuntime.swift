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
                // Absorbed: a failed runtime holds no page to open anything in.
                return (next, [])
            }

        case .modelOpened(let path):
            guard state.phase == .ready else { return (next, []) }
            if next.models[path] == nil { next.models[path] = EditorRuntimeState.ModelEntry() }
            // `openModel` ends in the page's own `activateModel` (`editor.js`), so the model it just
            // created IS what the editor shows.
            next.current = path
            return (next, [])

        case .activateRequested(let path):
            // An activate for a path this runtime does not hold is NOT turned into an open here: the
            // caller (T5's tab) knows whether it wants a lazy re-read, and guessing would re-read a
            // file the user only asked to look at.
            guard state.phase == .ready, state.models[path] != nil else { return (next, []) }
            next.current = path
            return (next, [.activateModel(path: path)])

        case .closeRequested(let path):
            next.pendingOpens.removeAll { $0 == path }
            guard state.models[path] != nil else { return (next, []) }
            next.models.removeValue(forKey: path)
            // The page DETACHES before it disposes and leaves the editor showing nothing; activating
            // a survivor is the caller's obligation, exercised by drill 9.
            if next.current == path { next.current = nil }
            return (next, [.closeModel(path: path)])

        case .dirtyChanged(let path, let dirty):
            guard next.models[path] != nil else { return (next, []) }
            next.models[path]?.dirty = dirty
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

    /// **T8's two messages, relayed rather than dropped.** The save flow does not exist yet; when it
    /// does, it hangs here rather than inside this object (`EditorSaveCoordinator`). Until then a
    /// `saveRequested` (the page's own ⌘S) and a `contentResponse` have nowhere to go, and silently
    /// swallowing them inside a `switch` with no arm is how a whole flow goes missing unnoticed.
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
    private let readFile: @Sendable (String) throws -> String
    /// What scheme `EditorTheme.tokensJSON`/`cardSurfaceBackgroundARGB` resolve against. Injected —
    /// the same reasoning as every other seam here — so a test can pin a payload's shape against a
    /// KNOWN scheme rather than whatever appearance happens to be active on the machine running the
    /// suite. Production reads AppKit directly (`currentColorScheme()`); nothing about the resolution
    /// itself belongs on the reducer's pure side, which only ever decides WHEN to ask for one.
    /// `@MainActor` (like `BrowserSignals.memoryBytes`/`PanelDiffTab`'s `fetch`): every call site is
    /// already on the actor, and the default value calls a `@MainActor` static method directly.
    private let colorScheme: @MainActor () -> ColorScheme

    private var container = PanelCEFContainerView()
    private var hiddenWindowStorage: NSWindow?
    private var idPoll: Scheduler.Cancellable?
    private var readyWatchdog: Scheduler.Cancellable?
    /// The ONE Combine wire this object holds (`ShellSessionHost.cancellables`'s identical shape and
    /// reasoning) — `NSApp`'s own `effectiveAppearance`, below, so its lifetime is this runtime's own
    /// and no separate teardown is needed (`AnyCancellable.cancel()` fires on deinit).
    private var cancellables = Set<AnyCancellable>()

    init(sessionId: String,
         hub: EditorBridgeHub = .shared,
         driver: CEFDriver = .production,
         scheduler: Scheduler = .production,
         colorScheme: @escaping @MainActor () -> ColorScheme = { EditorRuntime.currentColorScheme() },
         readFile: @escaping @Sendable (String) throws -> String = EditorRuntime.readTextFile) {
        self.sessionId = sessionId
        self.hub = hub
        self.driver = driver
        self.scheduler = scheduler
        self.colorScheme = colorScheme
        self.readFile = readFile
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
                send(.closeModel(path: path))
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
            onSaveRequested?(path)
        case .contentResponse(let path, let seq, let text):
            onContentResponse?(path, seq, text)
        }
    }

    // MARK: Opening

    /// Read the file off the main actor, then hand it to the page.
    ///
    /// A read failure records NO model and logs — the visible "File not found" state belongs to the
    /// tab (T5), which knows whether anything is showing this path at all. Recording a phantom model
    /// here would make the page and Swift disagree about what is open, which is the one disagreement
    /// the whole seq-anchored protocol exists to prevent.
    private func openAndSend(_ path: String) async {
        let reader = readFile
        let text: String
        do {
            text = try await Task.detached(priority: .userInitiated) { try reader(path) }.value
        } catch {
            NSLog("[EditorRuntime] \(sessionId): could not read \(path): \(error)")
            return
        }
        guard state.phase == .ready else { return }
        send(.openModel(path: path, language: editorLanguageHint(forPath: path), text: text)) {
            [weak self] ok in
            guard let self, ok else { return }
            self.perform(self.dispatch(.modelOpened(path: path)))
        }
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
    static func readTextFile(_ path: String) throws -> String {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let text = String(data: data, encoding: .utf8) else {
            throw EditorFileReadError.notUTF8(path: path)
        }
        return text
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

/// Why a file could not become a model.
enum EditorFileReadError: Error, Equatable {
    case notUTF8(path: String)
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
