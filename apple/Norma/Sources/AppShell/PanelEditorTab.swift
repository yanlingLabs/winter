import AppKit
import Combine
import NormaKit
import SwiftUI

// MARK: - Metrics

/// The gap between the chrome row's parts. Six points, the same figure `PanelDiffChrome` lays its
/// own row out on (`panelDiffGutterGap`) — reached independently rather than borrowed, because a
/// diff GUTTER metric leaking into an editor chrome row would tie two surfaces together at a place
/// they only happen to agree.
let panelEditorChromeGap: CGFloat = 6

/// The unsaved dot. Small enough to read as punctuation next to the path rather than as a control —
/// it is a statement, not a button, and the save button beside it is the thing to click.
let panelEditorDirtyDotSize: CGFloat = 6

// MARK: - Pure decisions

/// PURE: what a code tab can know about its session's working directories.
///
/// **Three answers, and the third is the whole point.** `editorPrewarmTarget` (`ShellSessionHost
/// .swift`, T3) asks the same question of the same `dirs` field and needs only two, because a
/// pre-warm that guesses wrong merely fails to warm something. A TAB that guesses wrong says a
/// SENTENCE to the user — so "the row is not in `rows` yet" (the create-then-navigate race that
/// function's own doc names) must not collapse into "this session has no working directory". Absent
/// data is not evidence of absence, and a calm, confident, wrong sentence is indistinguishable from
/// a true one.
enum EditorTabSessionRoots: Equatable {
    /// No row for this session yet (or no session at all). Renders as a quiet spinner: the answer is
    /// coming, and the rows are `@Published` so it arrives on its own.
    case unknown
    /// A row that carries no directories — `dirs == nil` (chat/dispatch have no working-directory
    /// concept) or `dirs == []` (a genuinely workdir-less session). Both mean the same thing to a
    /// code tab, exactly as they do to the pre-warm.
    case none
    case present
}

/// PURE: `editorTabSessionRoots`, off the WIRE row's `dirs` — never `cwd`, which is the daemon's
/// list-time ALIAS of `dirs[0]?.path` (`SessionSummary.dirs`' own doc, and `handoffDirectory`'s).
///
/// **editor-product Task 7 (Task 6 review reconciliation): the gate is `dirs.first?.path` being
/// genuinely non-empty, not merely `dirs` being a non-empty ARRAY.** Before this fix this function
/// and `resolvedFilePath` (`ShellSessionHost.swift`) asked two DIFFERENT questions of the identical
/// field — this one said `.present` for a degenerate `dirs: [{path: ""}]` row, while
/// `resolvedFilePath` already required a real, non-empty primary path to resolve a relative click
/// against. The gap was real, if narrow: the transcript's row-level gate
/// (`sessionHasWorkingDirectory`, threaded from this function) would render a clickable file-door
/// button for that row, and clicking it minted a tab at a RELATIVE url instead of resolving one
/// (Task 6 review, Minor — graceful but genuine breakage). One predicate now, reused verbatim by
/// both the transcript's gate and the Files tab (`PanelFilesTabModel.roots`).
func editorTabSessionRoots(sessionId: String?, rows: [SessionSummary]) -> EditorTabSessionRoots {
    guard let sessionId, let row = rows.first(where: { $0.sessionId == sessionId }) else {
        return .unknown
    }
    guard let dirs = row.dirs, dirs.first?.path.isEmpty == false else { return .none }
    return .present
}

/// What a code tab draws when it is NOT drawing the editor. Every case is a calm, centred sentence
/// (or a spinner); none of them is an error the user can act on by pressing something, which is why
/// there is no retry anywhere here — the doors that retry are the file tree and the transcript, and
/// they are elsewhere.
enum EditorViewportState: Equatable {
    /// The session's row has not arrived. A spinner, never a claim — see `EditorTabSessionRoots`.
    case resolvingSession
    /// This session has no working directory. The Files tab's own empty state says the same
    /// sentence (design spec, "empty state for dirless sessions"), because it is the same fact.
    case noWorkingDirectory
    /// A code tab pointing at nothing. Unreachable through any shipped door — every producer sets
    /// `url` to the absolute path — and rendered honestly rather than as a blank rectangle.
    case noFile
    /// The editor is coming up. Also what a queued open looks like: from the outside they are the
    /// same wait.
    case booting
    /// **Terminal** (`EditorRuntimeState.Phase`'s own doc): recovery is a teardown and a fresh
    /// runtime, which is the HOST's decision, not this tab's. So the tab renders the sentence and
    /// offers nothing — a retry button here would re-enter a browser that may be half-created.
    case failed(reason: String)
    /// The file could not be read. From an EXPLICIT signal (`EditorRuntimeState.openFailures`),
    /// never inferred from a missing model — see that field's own doc.
    case openFailed(path: String, failure: EditorOpenFailure)
}

/// The sentence shown when `phase == .failed` carries no reason. Should never render — every
/// `.bootFailed` in the runtime supplies one — and exists so that a future path which forgets to
/// still says something true rather than an empty line.
let editorViewportUnknownFailureReason = "the editor stopped before it came up"

/// **The one sentence a dirless session's editor AND its Files tab both show** (design spec:
/// "empty state for dirless sessions" — one requirement covering both surfaces, and
/// `EditorViewportState.noWorkingDirectory`'s own doc already names this as "the same fact"). A
/// shared constant rather than two literals that could drift apart — `PanelFilesTab.swift`
/// (editor-product Task 7) reuses it verbatim for its own `.none` state.
let panelDirlessSessionMessage = "This session has no working directory"

/// **PURE: what a code tab's viewport must do for its file, and what it draws while it cannot.**
///
/// One function, two callers, and they ask it slightly different questions:
///
///   * `PanelEditorContent` (SwiftUI) asks WHAT TO DRAW. It cannot know whether the shared editor
///     view is already in its rectangle — only an `NSView` knows that — so it leaves
///     `isViewportHost` at its default. That default is SAFE rather than a guess: the only case it
///     can cost is `.upToDate`/`.activateOnly` answering as `.adoptAndActivate`, and all three draw
///     the same thing.
///   * `EditorViewportHostView` (AppKit) asks WHAT TO SEND, and passes the real answer
///     (`runtime.viewportHost === self`). That is where the distinction earns its keep: with it,
///     the applier is naturally quiet — `.upToDate` sends nothing — and an unguarded applier would
///     fire one `activateModel` CDP call PER KEYSTROKE, since every `modelDirtyChanged` publishes
///     new state and every publish re-renders the viewport.
///
/// `.activateOnly` is not merely an optimisation over `.adoptAndActivate`: it is the **drift
/// re-assert**, and without it a tab can silently show the wrong file. `openModel` ends in the
/// page's own `activateModel` (`editor.js`), and queued opens flush UNORDERED (T3's carried note),
/// so a slower sibling's read landing after this tab activated steals the editor out from under a
/// mounted viewport. Nothing else would ever correct that: `updateNSView` is empty by contract on
/// the web path, and an attach only fires on mount and on window join.
enum EditorViewportPlan: Equatable {
    /// Put the shared editor view in this viewport and show `path`.
    case adoptAndActivate(path: String)
    /// The view is already here; the page only has to switch models.
    case activateOnly(path: String)
    /// The view is here and the page already shows this file. **Send nothing** — see above.
    case upToDate(path: String)
    /// The runtime holds no model for this file yet. The MODEL performs this (once per runtime per
    /// path); the viewport draws a spinner and never opens anything itself.
    case openThenActivate(path: String)
    /// Nothing to mount and nothing to ask for.
    case renderState(EditorViewportState)
}

/// The decision itself. `state` is `nil` for a session with no editor at all; `roots` is what says
/// whether that means "there is nothing to have one for" or "we do not know yet".
func editorViewportPlan(targetPath: String?,
                        roots: EditorTabSessionRoots,
                        state: EditorRuntimeState?,
                        isViewportHost: Bool = false) -> EditorViewportPlan {
    guard let targetPath, !targetPath.isEmpty else { return .renderState(.noFile) }

    switch roots {
    case .unknown: return .renderState(.resolvingSession)
    case .none: return .renderState(.noWorkingDirectory)
    case .present: break
    }

    // Roots but no runtime: the beat between the rows landing and the model resolving one through
    // the host. A spinner rather than the dirless sentence, for the reason `EditorTabSessionRoots`
    // gives — this is "not yet", not "never".
    guard let state else { return .renderState(.resolvingSession) }

    switch state.phase {
    case .failed:
        return .renderState(.failed(reason: state.failureReason ?? editorViewportUnknownFailureReason))

    case .idle:
        // **An open is its own pre-warm** (the reducer's `openRequested` from `.idle`), so a tab on
        // a cold runtime ASKS rather than waits. This is the restored-tab path: the panel's reveal
        // pre-warm is not exhaustive by design (T3's note 4 — a hop onto a session while the panel
        // is already open fires no reveal), and this is what covers it.
        return .openThenActivate(path: targetPath)

    case .booting:
        // Already queued → wait. Not queued (a runtime the panel reveal pre-warmed, which knows
        // nothing about which files any tab wants) → ask now; the reducer queues it and `pageReady`
        // flushes it.
        return state.pendingOpens.contains(targetPath)
            ? .renderState(.booting)
            : .openThenActivate(path: targetPath)

    case .ready:
        // **A model wins over a failure entry**, matching the reducer's own invariant (`openFailed`
        // is refused for a path that has a model, and `modelOpened` clears any entry): a file that
        // opened is not a file that could not be opened, whatever a stale read decided.
        if state.models[targetPath] != nil {
            guard isViewportHost else { return .adoptAndActivate(path: targetPath) }
            return state.current == targetPath
                ? .upToDate(path: targetPath)
                : .activateOnly(path: targetPath)
        }
        if let failure = state.openFailures[targetPath] {
            return .renderState(.openFailed(path: targetPath, failure: failure))
        }
        return .openThenActivate(path: targetPath)
    }
}

/// PURE: what the CHROME row calls the file — the last two path components, `fileDiffChipDisplayPath`
/// verbatim rather than a second implementation of the same rule. It is the same rule for the same
/// reason (design spec §3's "like the `norma v2/core` example": enough to disambiguate the dozen
/// `index.ts`es a real project has, short enough for one row), and two copies of it would drift the
/// moment one of them learned about `~`.
///
/// The tab's own title is the fallback — never an empty row, and never a lie: `panelTabDisplayTitle`
/// answers "Code" for a code tab that carries no title of its own.
func editorTabDisplayPath(path: String?, fallbackTitle: String) -> String {
    guard let path, !path.isEmpty else { return fallbackTitle }
    return fileDiffChipDisplayPath(path)
}

/// PURE: does the chrome show the unsaved dot? Read from the runtime's state — which is the PAGE's
/// own answer (`modelDirtyChanged`, computed as `alternativeVersionId != savedVersionId`), relayed
/// and never inferred here. A path with no model is not dirty; neither is a session with no editor.
func editorTabIsDirty(state: EditorRuntimeState?, path: String?) -> Bool {
    guard let state, let path else { return false }
    return state.models[path]?.dirty == true
}

/// PURE: the headline for a file that could not be opened. "File not found" is the spec's own
/// wording for the missing case and must not be shown for any other — a file that is there but
/// unreadable would send the user looking for something that never moved.
func editorOpenFailureTitle(_ failure: EditorOpenFailure) -> String {
    switch failure {
    case .notFound: return "File not found"
    case .unreadable: return "This file can't be opened"
    }
}

// MARK: - The per-tab model

/// editor-product Task 5: what a `.code` tab KNOWS. One per tab id, held by `PanelEditorTabModels`
/// rather than by the view, for the reason `PanelDiffTabModel` and `PanelWebTabModel` are: the
/// content slot carries `.id(tabId)`, so switching tabs and switching back REBUILDS the view, and
/// anything the view owned would be reborn with it — here that would mean re-reading the file from
/// disk on every visit, and losing the guard that stops it happening twice.
///
/// **It is also the one observable both slots read.** The chrome's dirty dot and the content's
/// viewport describe the same editor, and an editor is an OPTIONAL object (a chat session has
/// none) that SwiftUI cannot observe optionally. Mirroring the runtime's `@Published state` here
/// gives both slots one non-optional thing to watch, and makes "the chrome and the content can
/// never disagree" structural rather than careful.
@MainActor
final class PanelEditorTabModel: ObservableObject {
    let tabId: String
    /// **A code tab's `url` IS its absolute file path** — the wire fact since Stage A, not a
    /// convention this file invented. `nil` for a code tab nothing ever pointed at a file.
    let path: String?

    private(set) var sessionId: String?
    /// **Weak, and re-asked rather than remembered.** Every runtime this object touches is resolved
    /// through this host at the moment it is used: T3 releases a session's runtime on a clean
    /// departure and mints a FRESH one on return, so a tab holding the old object would speak to a
    /// browser that was torn down — silently, and for as long as the tab lives.
    private weak var host: ShellSessionHost?

    /// **T8's slot.** The save flow (pull → atomic write → `markSaved`) is `EditorSaveCoordinator`'s,
    /// which does not exist yet; when it does, it fills this in. Until then the chrome's save button
    /// renders as a placeholder (`ShellTitlebarButton.isPlaceholder`) — it hovers, it clicks, and it
    /// honestly does nothing, which is the treatment this app already uses for a control that is not
    /// wired rather than pretending to be disabled.
    var onSaveRequested: (() -> Void)?

    @Published private(set) var roots: EditorTabSessionRoots = .unknown
    /// The session editor's state, mirrored. `nil` = this session has no editor.
    @Published private(set) var runtimeState: EditorRuntimeState?

    /// The resolved runtime, weak — see `host`. Never read to make a DECISION about which runtime a
    /// session has (that is always `refresh`, through the host); only to speak to the one this pass
    /// resolved.
    private weak var runtimeRef: EditorRuntime?
    var runtime: EditorRuntime? { runtimeRef }

    private var runtimeSink: AnyCancellable?
    private var directorySink: AnyCancellable?
    private var activateScheduled = false
    /// Set once, by `deactivate()` — this tab is gone from the panel and this object must never act
    /// again. Read by the two doors that could otherwise wake it (`activate`, `refresh`).
    private var isRetired = false

    /// **The lazy-open guard, keyed on the RUNTIME as well as the path.** A `Set<String>` alone
    /// would suppress the re-read a fresh runtime needs — the spec's reattach rule is that a
    /// restored code tab re-reads its file on first activation, and after a clean departure released
    /// the old runtime the new one holds no models at all. A tab that remembered "I already asked"
    /// would then sit on a spinner forever.
    ///
    /// Weak rather than an `ObjectIdentifier`: a torn-down runtime is deallocated, and a fresh
    /// allocation can land on the same address — an identifier could therefore falsely MATCH the new
    /// runtime and suppress exactly the open this guard exists to allow. A weak reference is nil by
    /// then, so the comparison below fails and the paths reset, which is the behaviour wanted.
    private weak var openRequestedRuntime: EditorRuntime?
    private var openRequestedPaths: Set<String> = []

    init(tabId: String, path: String?) {
        self.tabId = tabId
        self.path = path
    }

    /// Re-point at a host/session. Called from `panelTabContent` on EVERY render pass, so it must be
    /// idempotent and cheap — and **it must not publish**: it runs inside `ShellPanel`'s own `body`,
    /// where a `@Published` mutation is SwiftUI's "publishing changes from within view updates".
    /// (`PanelDiffTabModel.bind` avoids the same trap by touching nothing observable.)
    ///
    /// So it only records, drops the old session's wires, and schedules the work. `activate()` — a
    /// hop off the current pass, and the views' own `onAppear` — is what actually publishes.
    func bind(host: ShellSessionHost?, sessionId: String?) {
        guard self.host !== host || self.sessionId != sessionId else { return }
        self.host = host
        self.sessionId = sessionId
        directorySink = nil
        runtimeSink = nil
        runtimeRef = nil
        scheduleActivate()
    }

    private func scheduleActivate() {
        guard !activateScheduled else { return }
        activateScheduled = true
        Task { @MainActor [weak self] in
            self?.activateScheduled = false
            self?.activate()
        }
    }

    /// Subscribe and resolve. Idempotent — called by both slots' `onAppear` and by `bind`'s hop.
    ///
    /// The directory subscription is what keeps `roots` from going stale: `SessionDirectory.rows` is
    /// `@Published`, a fresh session's row lands AFTER the panel can already be showing its tabs
    /// (the create-then-navigate race), and nothing else would ever re-ask. Combine replays the
    /// current value on subscribe, so this doubles as the first refresh.
    func activate() {
        guard !isRetired else { return }
        guard directorySink == nil, let directory = host?.directory else {
            refresh()
            return
        }
        directorySink = directory.$rows.sink { [weak self] rows in self?.refresh(rows: rows) }
    }

    /// **Drop every live wire — this tab is no longer anywhere the user can see it** (fix round 1).
    ///
    /// Without this a model outlives its tab with a live `SessionDirectory.$rows` subscription, and
    /// the visible-gated 5 s `session.list` poll alone is enough to RESURRECT a departed session's
    /// editor: `refresh` mints through `editorRuntimeForCodeTab`, the open guard resets because the
    /// runtime is new, and a hidden Chromium plus a disk re-read appear for a session the user left —
    /// which nothing then releases, since the shell only ever releases the DEPARTING session, once.
    /// (Measured, not theorised: one `directory.refresh()` after a departure produced a created
    /// browser and a second mint.)
    ///
    /// It drops the wires rather than merely leaving the registry, because a view can still hold this
    /// object for a beat after the registry has let go — the wires, not the dictionary entry, are
    /// what act.
    ///
    /// **One-way**, and that is the point: this model is retired, not paused. `activate()` and
    /// `refresh()` both refuse afterwards, so no lingering `onAppear` from a view being torn down can
    /// re-subscribe it. Nothing is lost — a genuine return to the session gets a FRESH model from the
    /// registry (the retired one is no longer in it), which mints and re-reads exactly as a first
    /// visit does.
    func deactivate() {
        isRetired = true
        directorySink = nil
        runtimeSink = nil
        runtimeRef = nil
    }

    private func refresh(rows: [SessionSummary]? = nil) {
        // **The one choke point that mints, so the one place retirement has to hold.** Every other
        // door into this object (the rows sink, `activate`, the test seam) arrives here.
        guard !isRetired else { return }
        let rows = rows ?? host?.directory.rows ?? []
        let resolvedRoots = editorTabSessionRoots(sessionId: sessionId, rows: rows)
        if roots != resolvedRoots { roots = resolvedRoots }

        // **Through the host, every time.** `editorRuntimeForCodeTab` is the one door that may MINT
        // one, and it refuses for a session with no directories — so "a dirless session never
        // stands a hidden Chromium up" is enforced in one place rather than trusted to each caller.
        let resolved = host?.editorRuntimeForCodeTab(sessionId: sessionId)
        if resolved !== runtimeRef {
            runtimeRef = resolved
            guard let resolved else {
                runtimeSink = nil
                runtimeState = nil
                return
            }
            // `@Published` delivers the NEW value (it fires on `willSet`), so the mirror is never a
            // beat behind — and it replays the current one on subscribe, which seeds it.
            runtimeSink = resolved.$state.sink { [weak self] state in
                guard let self else { return }
                self.runtimeState = state
                self.requestOpenIfNeeded()
            }
        }
        requestOpenIfNeeded()
    }

    /// **The lazy read, at most once per (runtime, path).**
    ///
    /// Driven from the model rather than from a view branch's `onAppear`: which SwiftUI branch is on
    /// screen is a rendering detail, and a restored tab's file must be read because the tab exists,
    /// not because a particular `Group` arm happened to be built. The plan is what decides there is
    /// anything to do at all — a failed open renders its sentence and asks for nothing more, so this
    /// cannot become a read loop against a file that is not there.
    func requestOpenIfNeeded() {
        guard let runtime = runtimeRef, let path, !path.isEmpty else { return }
        guard case .openThenActivate = editorViewportPlan(targetPath: path, roots: roots,
                                                          state: runtimeState) else { return }
        if openRequestedRuntime !== runtime {
            openRequestedRuntime = runtime
            openRequestedPaths = []
        }
        guard openRequestedPaths.insert(path).inserted else { return }
        // Never synchronous: this can run from inside the runtime's own `@Published` `willSet`, i.e.
        // in the middle of a reducer step. `openFile` is `async` anyway, and the hop is what keeps
        // that re-entry impossible rather than merely unlikely. Weak, like the runtime's own
        // deferred effects: a runtime released before the hop lands has nothing left to open into.
        Task { @MainActor [weak runtime] in await runtime?.openFile(path) }
    }

    /// What the chrome asks. A model with no runtime, or a runtime with no model for this path, is
    /// not dirty.
    var isDirty: Bool { editorTabIsDirty(state: runtimeState, path: path) }

    /// What the content asks, with `isViewportHost` at its safe default — see `editorViewportPlan`.
    ///
    /// The mirror is only as true as the object it mirrors: a runtime released by a clean departure
    /// deallocates, `runtimeRef` (weak) goes `nil`, and the last state it published is then a
    /// description of something that no longer exists. Reading them TOGETHER is what stops a tab
    /// asking a dead editor to activate a file — the next `refresh` (a rebuild's `onAppear`, or the
    /// rows publishing) resolves whatever the session has now.
    var plan: EditorViewportPlan {
        editorViewportPlan(targetPath: path, roots: roots,
                           state: runtimeRef == nil ? nil : runtimeState)
    }

    /// Test seam: drive one refresh cycle synchronously, the way `activate()` does, without a view.
    func refreshForTesting() { refresh() }
}

/// One model per tab id, mirroring `PanelDiffTabModels`/`PanelWebTabModels` — including their reason
/// for existing: the content factory runs on every render pass, so a model born there would be
/// reborn there.
@MainActor
enum PanelEditorTabModels {
    private static var models: [String: PanelEditorTabModel] = [:]

    /// The cached model for this tab, or a fresh one.
    ///
    /// **A cached model whose `path` disagrees with the tab's is REPLACED**, not re-bound — the same
    /// discipline `PanelDiffTabModels` applies to `diffId`, for the same reason: a tab confidently
    /// showing another file's buffer is the kind of wrong nobody notices. (It cannot happen today —
    /// a code tab's `url` is set when the tab is minted and no producer navigates one — which is
    /// exactly why the alternative behaviour must be decided here rather than discovered later.)
    static func model(for tab: PanelTab, host: ShellSessionHost?, sessionId: String?) -> PanelEditorTabModel {
        if let cached = models[tab.tabId], cached.path == tab.url {
            cached.bind(host: host, sessionId: sessionId)
            return cached
        }
        let fresh = PanelEditorTabModel(tabId: tab.tabId, path: tab.url)
        models[tab.tabId] = fresh
        fresh.bind(host: host, sessionId: sessionId)
        return fresh
    }

    /// Dropped when the user closes the tab (`ShellSessionHost.closePanelTab`).
    ///
    /// **It does not close the runtime's model, deliberately.** A dirty buffer dropped here would
    /// lose the user's work with no warning, which is the whole reason T10 owns a close gate; until
    /// that exists, a closed code tab leaves its model open in the page, where it costs memory and
    /// nothing else.
    static func discard(tabId: String) {
        // Deactivate FIRST: a view can outlive the registry entry by a beat, and a model that is
        // merely forgotten still holds the subscriptions that act. See `deactivate`.
        models.removeValue(forKey: tabId)?.deactivate()
    }

    /// **Every model whose tab is no longer on screen, deactivated and dropped** (fix round 1).
    ///
    /// Driven by the panel's own session change (`ShellSessionHost.init`'s `panelStore.$tabs` sink),
    /// which is the moment — and the only moment — a whole session's worth of code tabs stops being
    /// anywhere the user can see. `discard(tabId:)` covers the other door (one tab, closed
    /// deliberately); between them the registry is bounded by what the panel is actually showing
    /// rather than by everything it has ever shown.
    ///
    /// `except` is the tab set the panel now publishes, so a switch BACK to a session whose tabs are
    /// still cached keeps their models rather than churning them.
    static func discardAll(except tabIds: Set<String>) {
        for (tabId, model) in models where !tabIds.contains(tabId) {
            model.deactivate()
            models.removeValue(forKey: tabId)
        }
    }

    /// Test seam only — `models` is process-global state.
    static func removeAllForTesting() {
        models.removeAll()
    }
}

// MARK: - The tab

/// editor-product Task 5: the `.code` implementation of `PanelTabContent`, replacing the Stage-A-era
/// placeholder the factory routed here.
///
/// **A viewport, not an editor.** The session has ONE editor (`EditorRuntime`, T3) — one hidden
/// Chromium holding every open file as a Monaco model — and a code tab is a rectangle that borrows
/// its view. That is what makes a code→code switch a `setModel` swap rather than a page load, and it
/// is why nothing in this file creates, configures or destroys a browser.
struct PanelEditorTab: PanelTabContent {
    let tab: PanelTab
    /// Shared by both slots, so the chrome's dirty dot and the content's viewport can never describe
    /// two different editors. Looked up once, in `panelTabContent(for:host:sessionId:)`.
    let model: PanelEditorTabModel

    var kind: PanelTabKind { .code }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.code)) }

    func makeChrome() -> AnyView { AnyView(PanelEditorChrome(model: model, tab: tab)) }
    func makeContent() -> AnyView { AnyView(PanelEditorContent(model: model)) }
}

// MARK: - The chrome row

/// Path, unsaved dot, save. **No navigation** — a code tab has exactly one destination and it is
/// already there, the same shape `PanelDiffChrome` takes for the same reason.
struct PanelEditorChrome: View {
    @ObservedObject var model: PanelEditorTabModel
    let tab: PanelTab

    var body: some View {
        HStack(spacing: panelEditorChromeGap) {
            Text(editorTabDisplayPath(path: model.path, fallbackTitle: panelTabDisplayTitle(tab)))
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                // Middle, like the diff chrome's own path and the transcript chip's: the tail is the
                // filename and the head is the folder; the middle is the part nobody reads.
                .truncationMode(.middle)

            if model.isDirty {
                // The brand's accent, never a literal — this is the one place in the row that is
                // about STATE rather than about text, and it wears the same colour every other
                // "this is live" affordance in the shell does.
                Circle()
                    .fill(Theme.accent)
                    .frame(width: panelEditorDirtyDotSize, height: panelEditorDirtyDotSize)
                    .accessibilityLabel("Unsaved changes")
            }

            Spacer(minLength: panelEditorChromeGap)

            // The app's ONE chrome-button treatment (hover, highlight and hit box all from
            // `ShellSidebarRowStyle`), and its `isPlaceholder` honesty: T8 fills `onSaveRequested`,
            // and until it does the button reads one step quieter while still hovering and clicking.
            ShellTitlebarButton(systemImage: "arrow.down.doc",
                                label: "Save",
                                isPlaceholder: model.onSaveRequested == nil,
                                size: panelChromeButtonSize) {
                model.onSaveRequested?()
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }
}

// MARK: - The content

/// The viewport, or one of the calm states.
struct PanelEditorContent: View {
    @ObservedObject var model: PanelEditorTabModel

    var body: some View {
        Group {
            switch model.plan {
            case .adoptAndActivate(let path), .activateOnly(let path), .upToDate(let path):
                if let runtime = model.runtime {
                    // `current` and `hasModel` are carried as stored properties **so that SwiftUI's
                    // own update channel fires when they change** — that is what delivers the drift
                    // re-assert (`editorViewportPlan`'s `.activateOnly`) to `updateNSView`.
                    EditorViewportView(runtime: runtime,
                                       path: path,
                                       current: model.runtimeState?.current,
                                       hasModel: model.runtimeState?.models[path] != nil)
                } else {
                    // The plan said mount and the runtime went away between the two reads. One
                    // frame, and the next refresh resolves it.
                    EditorViewportStateView(state: .resolvingSession)
                }
            case .openThenActivate:
                // The read is the MODEL's (`requestOpenIfNeeded`, once per runtime per path). The
                // viewport deliberately does not mount here: the page is still showing whatever was
                // last active, and a flash of another file's text is a lie about which file this is.
                EditorViewportStateView(state: .booting)
            case .renderState(let state):
                EditorViewportStateView(state: state)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }
}

/// Every not-the-editor state, in the shell's own empty-state vocabulary (`PanelDiffContent`'s
/// unavailable state is the in-repo shape this follows).
struct EditorViewportStateView: View {
    let state: EditorViewportState

    var body: some View {
        Group {
            switch state {
            case .resolvingSession, .booting:
                // Quiet: an editor coming up is not an event, and a large spinner in an empty panel
                // reads as something having gone wrong.
                ProgressView().controlSize(.small)
            case .noWorkingDirectory:
                message(panelDirlessSessionMessage)
            case .noFile:
                message("This tab has no file")
            case .failed(let reason):
                message("The editor couldn't start", detail: reason)
            case .openFailed(let path, let failure):
                message(editorOpenFailureTitle(failure), path: path, detail: failureDetail(failure))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failureDetail(_ failure: EditorOpenFailure) -> String? {
        if case .unreadable(let reason) = failure { return reason }
        return nil
    }

    /// Title, then the file, then the reason. The path is shown IN FULL here (middle-truncated),
    /// unlike the chrome's two-component form: this is the state where the exact path is the thing
    /// the user needs in order to work out what happened.
    private func message(_ title: String, path: String? = nil, detail: String? = nil) -> some View {
        VStack(spacing: panelEditorChromeGap) {
            Text(title)
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(.primary)
            if let path {
                Text(path)
                    .font(Typography.captionMono())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let detail {
                Text(detail)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, panelTabPillInset)
    }
}

// MARK: - The viewport onto the session's one editor

/// The SwiftUI seam — the same posture `PanelViewport` takes for a web tab: **a viewport, not an
/// owner**. It creates nothing, destroys nothing and speaks to no browser; it offers a rectangle,
/// and the runtime puts its container in it.
struct EditorViewportView: NSViewRepresentable {
    let runtime: EditorRuntime
    let path: String
    /// Carried ONLY so SwiftUI notices when they change and calls `updateNSView` — see
    /// `PanelEditorContent`. Nothing reads them here; the applier re-reads the live snapshot.
    let current: String?
    let hasModel: Bool

    func makeNSView(context: Context) -> EditorViewportHostView {
        let host = EditorViewportHostView(runtime: runtime, path: path)
        host.applyAfterUpdate()
        return host
    }

    /// **Not empty, unlike the web path's** — and the difference is not an inconsistency. That one
    /// must do nothing because loading a URL there would close a navigate → report → fold → update
    /// loop. Here the update carries no destination at all: it re-asks the plan, which answers
    /// `.upToDate` (i.e. nothing) unless the page has genuinely drifted onto another file.
    func updateNSView(_ nsView: EditorViewportHostView, context: Context) {
        nsView.applyAfterUpdate()
    }

    /// **Obligation 1 (T3's review, binding): the host is nil'd EXPLICITLY.**
    ///
    /// `EditorRuntime.viewportHost` is `weak`, and weak zeroing does NOT run `didSet` — so a
    /// viewport that merely deallocated would leave the runtime believing its view is still mounted
    /// in a rectangle that no longer exists, and the container would never go back to the hidden
    /// window. The next code tab would then adopt from nowhere.
    static func dismantleNSView(_ nsView: EditorViewportHostView, coordinator: ()) {
        nsView.detachFromRuntime()
    }
}

/// The rectangle the runtime mounts its editor into — **a hole in the SwiftUI view tree**, exactly
/// as `PanelViewportHostView` is for a web tab. It owns no CEF state and no container of its own.
final class EditorViewportHostView: NSView, EditorViewportHost {
    let runtime: EditorRuntime
    let path: String

    /// Set by `detachFromRuntime`. SwiftUI is finished with a dismantled host view, so a late
    /// re-attach (a window join racing the dismantle) must not take the editor away from whatever
    /// viewport holds it now.
    private var isDismantled = false
    /// The container the runtime handed over, weak — the runtime owns it, and it may be parked or
    /// adopted elsewhere without this view hearing about it.
    private weak var adopted: NSView?
    private var applyScheduled = false

    init(runtime: EditorRuntime, path: String) {
        self.runtime = runtime
        self.path = path
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("EditorViewportHostView is never unarchived") }

    // MARK: The plan, applied

    /// **The apply, one run-loop turn later — and this is not a style choice.**
    ///
    /// `makeNSView` and `updateNSView` run INSIDE SwiftUI's update pass, and `apply` can call
    /// `runtime.activate`, which mutates the runtime's `@Published state` — which
    /// `PanelEditorTabModel` mirrors and both of this tab's slots observe. Publishing from inside an
    /// update is SwiftUI's "Publishing changes from within view updates is not allowed", the same
    /// trap `PanelEditorTabModel.bind` documents from the other side. The turn is invisible: the
    /// container move and the `activateModel` both land before the next frame.
    ///
    /// Coalesced (`applyScheduled`) because a mount is several calls — `makeNSView`, the window
    /// join, and the first update usually arrive together — and dropped entirely once dismantled.
    func applyAfterUpdate() {
        guard !isDismantled, !applyScheduled else { return }
        applyScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.applyScheduled = false
            self.apply()
        }
    }

    /// Ask what to do and do it. Called a turn after every SwiftUI touch (above), on window join,
    /// and directly by the tests that pin this decision.
    ///
    /// `roots: .present` is a statement of fact rather than an assumption: this view is only ever
    /// built from `PanelEditorContent`'s mounting arms, which are unreachable for any other answer.
    func apply() {
        guard !isDismantled else { return }
        switch editorViewportPlan(targetPath: path,
                                  roots: .present,
                                  state: runtime.stateSnapshot,
                                  isViewportHost: runtime.viewportHost === self) {
        case .adoptAndActivate(let path):
            // Setting the host IS the move: `didSet` → `mountEditorView` → `adoptEditorView` below.
            runtime.viewportHost = self
            runtime.activate(path)
        case .activateOnly(let path):
            runtime.activate(path)
        case .upToDate:
            break
        case .openThenActivate, .renderState:
            // Neither is this view's to perform: opens belong to `PanelEditorTabModel` (guarded once
            // per runtime per path), and a render state means the content slot is about to replace
            // this view with a sentence.
            break
        }
    }

    /// `EditorViewportHost`. The runtime hands the ONE container over; putting it on screen — the
    /// move, the size and the keyboard — is this view's job.
    ///
    /// One `addSubview`, never `removeFromSuperview` first, then the frame: spike Facts 5 and 4, the
    /// same two `BrowserRuntime.mountViewport` is built on (`PanelCEFContainerView.resizeSubviews`
    /// is what carries the size through to Chromium's own view).
    func adoptEditorView(_ view: NSView) {
        guard !isDismantled else { return }
        addSubview(view)
        view.frame = bounds
        view.autoresizingMask = [.width, .height]
        adopted = view
        restoreEditorFirstResponder()
    }

    /// **The third responder door**, for the reason `PanelViewportHostView.viewDidMoveToWindow`
    /// documents: SwiftUI runs `makeNSView` BEFORE the view it returns joins a window, so the first
    /// restore always lands on the "container is in no window yet" exit. Without this the editor
    /// renders perfectly and accepts no keystrokes.
    ///
    /// The restore runs unconditionally, not only when `apply()` re-adopts: an `apply()` that
    /// answers `.upToDate` moves nothing, and moving nothing is precisely the case where the
    /// responder still needs restoring.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        // Deferred for the same reason the SwiftUI touches are — a window join happens inside the
        // update pass that produced it. The restore is NOT deferred: it touches AppKit only, and it
        // is the whole point of this door.
        applyAfterUpdate()
        restoreEditorFirstResponder()
    }

    /// SwiftUI is done with this view. See `EditorViewportView.dismantleNSView` for why this is an
    /// explicit `nil` and not a hope.
    func detachFromRuntime() {
        isDismantled = true
        adopted = nil
        // **Only if we are still the host.** SwiftUI does not promise to dismantle the outgoing view
        // before building the incoming one, so the next code tab's viewport may already have adopted
        // the editor — nilling then would park a container the user is looking at.
        guard runtime.viewportHost === self else { return }
        runtime.viewportHost = nil
    }

    // MARK: The keyboard

    /// **Spike Fact 2's obligation, one layer up.** A reparent destroys first-responder status and
    /// attaching does not restore it, so this must — and it reuses `BrowserRuntime`'s own SEARCH
    /// rather than re-deriving one, because that is the part the spike insisted must not be guessed
    /// ("find it by identity, not by depth"; the two obvious candidates both ACCEPT first responder
    /// and then deliver nothing, which looks green from every angle).
    ///
    /// What is not shared is the logging around it: the subject here is a session's editor, not a
    /// tabId, and a browser runtime that logged about editors would be a second thing to keep true.
    private func restoreEditorFirstResponder() {
        guard let adopted else { return }
        let found = BrowserRuntime.findKeyboardResponder(in: adopted)
        if found.count != 1 {
            // Zero: nobody can type in this editor (CEF may simply not have parented its view yet —
            // creation is asynchronous, and the window-join call above is the retry). More than one:
            // the choice is a guess. Both are worth saying out loud; neither is a reason to refuse.
            NSLog("[EditorViewport] \(runtime.sessionId): first-responder search found "
                  + "\(found.count) candidates (matched by \(found.matchedBy.rawValue)) — expected 1")
        }
        guard let view = found.view else { return }
        guard let window = adopted.window else {
            NSLog("[EditorViewport] \(runtime.sessionId): the editor is in no window yet — first "
                  + "responder not restored (nothing can take a keystroke until it is)")
            return
        }
        if !window.makeFirstResponder(view) {
            NSLog("[EditorViewport] \(runtime.sessionId): "
                  + "\(NSStringFromClass(type(of: view))) refused first responder — the editor will "
                  + "take no keyboard input")
        }
    }
}
