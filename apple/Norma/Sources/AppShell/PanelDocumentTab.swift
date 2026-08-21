import AppKit
import Combine
import SwiftUI

// MARK: - Metrics

/// The bottom sheet-tab strip's own height, and the left slide-rail's own width — sized off the
/// same `panelChromeButtonSize`/`panelEditorChromeGap` vocabulary every other chrome row in this
/// panel uses, so a document tab's strip reads as part of the same system rather than a new one.
let officePartStripBottomHeight: CGFloat = 32
let officePartStripRailWidth: CGFloat = 40
let officePartStripItemSpacing: CGFloat = 2

// MARK: - Pure: the failure sentence

/// Should never render — `OfficeRuntimeState.Phase.failed` is always accompanied by a
/// `failureReason` (`OfficeRuntimeReducer`'s `.helperDied`/`.helperUnavailable` cases both set one)
/// — kept so a future path that forgets to still says something true. Mirrors
/// `editorViewportUnknownFailureReason`'s own reasoning.
let officeDocumentUnknownFailureReason = "the office helper stopped before it came up"

// MARK: - Pure: the viewport plan

/// Every not-the-canvas state a `.document` tab can be in. Each is a calm sentence (or a spinner);
/// `.failed` is the only one with an action (obligation 5's "Reopen" affordance) — `.openFailed` has
/// none, mirroring `EditorViewportState.openFailed`'s own posture (retry lives at the door that
/// opened it, `openDocumentTab`'s `retryOpen`, not in the tab itself).
enum OfficeDocumentViewportState: Equatable {
    /// A document tab pointing at nothing. Unreachable through any shipped door — `openDocumentTab`
    /// always sets an absolute path — rendered honestly rather than as a blank rectangle, mirroring
    /// `EditorViewportState.noFile`.
    case noFile
    /// No runtime yet, or a runtime still starting/ready-but-not-yet-opened, or — obligation 5's own
    /// case — a `.failed` runtime THIS TAB has not yet asked anything of (the over-delivery window:
    /// a fresh runtime can arrive already `.failed` from another session's shared-helper failure
    /// before this tab's own deferred open ever ran). All read the same: a quiet wait.
    case booting
    /// The shared helper is down, AND this tab has genuinely asked it for something before (
    /// `hasRequestedOpen` — see `PanelDocumentTabModel`'s own doc for why state alone cannot tell
    /// this apart from the pristine case above). Offers the Reopen affordance.
    case failed(reason: String)
    /// This one document refused to open — the helper is fine; the file was not
    /// (`OfficeRuntimeState.openFailures`).
    case openFailed(path: String, reason: String)
}

/// What a `.document` tab must show: the canvas, or one of the calm states above. Mirrors
/// `EditorViewportPlan`'s split exactly.
enum OfficeDocumentViewportPlan: Equatable {
    case showCanvas(path: String, docId: String, type: OfficeDocumentKind, parts: Int,
                    sizeTwips: OfficeDocumentSize, activePart: Int)
    case renderState(OfficeDocumentViewportState)
}

/// **The decision itself.** `state` is `nil` for a session with no office runtime at all (the beat
/// before `PanelDocumentTabModel.refresh` resolves one — there is no `EditorTabSessionRoots`
/// equivalent here: unlike a code tab, a document tab's `path` is already absolute by the time the
/// tab exists (`openDocumentTab` resolves it once, at open time, exactly as `.code`'s `tab.url`
/// already is) — reads carry no path fence (CLAUDE.md, "Reads unrestricted"), so there is no
/// "this session has no working directory" question to ask before opening one.
///
/// **A model wins over every failure entry** (mirrors `editorViewportPlan`'s identical precedence
/// rule): checked FIRST, even though the reducer's own `.helperDied`/`.helperUnavailable` handling
/// always wipes `documents` in the same transition that sets `.failed` — so the two cannot actually
/// coexist for the SAME runtime today. Kept as an explicit, tested precedence anyway: a future
/// reducer change that ever let them coexist must not silently start hiding an open document behind
/// a stale failure sentence.
///
/// **`hasRequestedOpen`, not the reducer's own `documents`/`pendingOpens` fields, is what tells a
/// genuine failure apart from the pristine over-delivery window** (obligation 5). The literal fields
/// cannot do it: `OfficeRuntimeReducer`'s `.helperDied`/`.helperUnavailable` arms return `var fresh =
/// OfficeRuntimeState()` — `documents.isEmpty && pendingOpens.isEmpty` holds for EVERY `.failed`
/// state, freshly-arrived or long-lived, so reading them alone cannot distinguish "this runtime has
/// never been asked to open anything by anyone" from "this runtime just lost a document it had open
/// for an hour." `hasRequestedOpen` is local, per-model, per-runtime-instance bookkeeping instead:
/// true only once THIS tab's own deferred `open()` call has actually reached the runtime (see
/// `PanelDocumentTabModel.requestOpenIfNeeded`) — which is also exactly the ask whose own retry
/// (carry 4: `.failed` retries like `.idle`) makes the pristine case self-heal within one run-loop
/// turn, matching the T5 review's own "self-heals" framing of the underlying over-delivery race.
func officeDocumentViewportPlan(path: String?, state: OfficeRuntimeState?,
                                hasRequestedOpen: Bool) -> OfficeDocumentViewportPlan {
    guard let path, !path.isEmpty else { return .renderState(.noFile) }
    guard let state else { return .renderState(.booting) }

    if let doc = state.documents[path] {
        return .showCanvas(path: path, docId: doc.docId, type: doc.type, parts: doc.parts,
                           sizeTwips: doc.sizeTwips, activePart: doc.activePart)
    }
    if state.phase == .failed {
        guard hasRequestedOpen else { return .renderState(.booting) }
        return .renderState(.failed(reason: state.failureReason ?? officeDocumentUnknownFailureReason))
    }
    if let reason = state.openFailures[path] {
        return .renderState(.openFailed(path: path, reason: reason))
    }
    return .renderState(.booting)
}

// MARK: - Pure: the part navigation strip kind

/// Stage A's part-navigation shape, per document kind (brief: "sheets = bottom sheet-tab strip,
/// slides = left slide rail (numbers only), docs = none").
enum OfficePartStripKind: Equatable {
    case none
    case bottomSheetTabs
    case leftSlideRail
}

func officePartStripKind(for type: OfficeDocumentKind) -> OfficePartStripKind {
    switch type {
    case .spreadsheet: return .bottomSheetTabs
    case .presentation: return .leftSlideRail
    case .text, .drawing, .other: return .none
    }
}

// MARK: - Pure: what a document-door click does

/// The two things a document-door click can ask for — mirrors `PanelFileTabAction` exactly
/// (dedupe/activate semantics "identical to `openFileTab`", the T6 interface note's own words),
/// including the retry obligation: an existing tab whose path currently sits in the runtime's
/// `openFailures` has no document to show, so activating it alone would re-surface the same failure
/// sentence forever.
enum PanelDocumentTabAction: Equatable {
    case activate(tabId: String, retryOpen: Bool)
    case mint(title: String)
}

/// PURE: dedupe a document-door click against a session's folded tab list, over `.document` tabs, by
/// PATH — `panelFileTabAction`'s own doc explains why the kind filter is load-bearing (`url` is a
/// field every tab kind carries).
func panelDocumentTabAction(tabs: [PanelTab], path: String, openFailures: Set<String>) -> PanelDocumentTabAction {
    if let open = tabs.first(where: { $0.kind == .document && $0.url == path }) {
        return .activate(tabId: open.tabId, retryOpen: openFailures.contains(path))
    }
    return .mint(title: (path as NSString).lastPathComponent)
}

// MARK: - Office Stage B Task 2: saving

/// PURE: the app's ⌘S menu item's document-tab leg — mirrors `editorSaveMenuTarget`
/// (`PanelEditorTab.swift`) exactly, filtered to `.document` instead of `.code`. Lives here, not
/// there, because THIS file is document-tab territory (`panelDocumentTabAction`'s own precedent one
/// section up: the `.document`-kind filter is this file's own recurring idiom, never borrowed).
func officeSaveMenuTarget(tabs: [PanelTab], activeTabId: String?) -> PanelTab? {
    guard let activeTabId, let tab = tabs.first(where: { $0.tabId == activeTabId }) else { return nil }
    guard tab.kind == .document, let url = tab.url, !url.isEmpty else { return nil }
    return tab
}

/// PURE: does the chrome show the unsaved dot? Mirrors `editorTabIsDirty` exactly — read from the
/// runtime's state (`documents[path].dirty`, driven purely by LOK's own `.uno:ModifiedStatus`
/// callback, via `OfficeRuntime.handle(documentEvent:docId:)` — never inferred here). A path with no
/// open document is not dirty; neither is a session with no runtime.
func officeDocumentIsDirty(state: OfficeRuntimeState?, path: String?) -> Bool {
    guard let state, let path else { return false }
    return state.documents[path]?.dirty == true
}

// MARK: - The canvas host door

/// **office-plumbing Task 6: how a part-strip click reaches the canvas that owns viewport math.**
///
/// Not a `@Published` command on the model (a design considered and dropped): clearing a published
/// "pending part" from `NSViewRepresentable.updateNSView` is the publishing-from-view-updates trap
/// this codebase documents twice already (`PanelEditorTabModel.bind`'s own header,
/// `EditorViewportHostView.applyAfterUpdate`'s own header) — deferring the clear one more turn would
/// only add a second small state machine to answer the same question this protocol answers directly.
///
/// The canvas — not the model — owns scroll position and zoom, and therefore owns what "switch to
/// part N" actually DOES (reset scroll, recompute the viewport at the canvas's own current zoom, and
/// resubscribe immediately): the model has no accurate viewport to compute one from. Registered by
/// the mounted `OfficeTileCanvasView` and explicitly nil'd on dismantle — mirrors
/// `EditorRuntime.viewportHost`'s own weak-zeroing discipline (T3's obligation 1: weak zeroing does
/// not run `didSet`), but lives on the TAB'S model rather than the runtime: each `.document` tab
/// owns its own canvas (no shared-page concept the way the editor's one CEF browser is), so "which
/// view is showing this" is a per-tab fact here, not a per-runtime one.
@MainActor
protocol OfficeDocumentCanvasHost: AnyObject {
    func setActivePart(_ part: Int)
}

// MARK: - The per-tab model

/// office-plumbing Task 6: what a `.document` tab knows. One per tab id, held by
/// `PanelDocumentTabModels` — mirrors `PanelEditorTabModel`'s own reason for existing (the content
/// slot carries `.id(tabId)`, so switching tabs and back rebuilds the view; anything the view owned
/// would be reborn with it).
///
/// **Smaller than `PanelEditorTabModel` by one whole axis**: no `EditorTabSessionRoots` mirror, no
/// directory subscription — see `officeDocumentViewportPlan`'s own doc for why a document tab needs
/// no "does this session have working directories" gate at all.
@MainActor
final class PanelDocumentTabModel: ObservableObject {
    let tabId: String
    /// A document tab's `url` IS its absolute file path — the same wire fact `.code`'s `path` rests
    /// on. `nil` for a tab nothing ever pointed at a file (unreachable through any shipped door).
    let path: String?

    private(set) var sessionId: String?
    /// Weak, re-asked every time it is used — mirrors `PanelEditorTabModel.host`'s own reasoning: a
    /// departure releases a session's office runtime and mints a fresh one on return.
    private weak var host: ShellSessionHost?

    /// See `OfficeDocumentCanvasHost`'s own header.
    weak var canvasHost: OfficeDocumentCanvasHost?

    @Published private(set) var runtimeState: OfficeRuntimeState?

    private weak var runtimeRef: OfficeRuntime?
    var runtime: OfficeRuntime? { runtimeRef }

    private var runtimeSink: AnyCancellable?
    private var activateScheduled = false
    private var isRetired = false

    /// The lazy-open guard — keyed on the RUNTIME as well as the path, mirroring
    /// `PanelEditorTabModel.openRequestedRuntime`/`.openRequestedPaths` exactly (see that property's
    /// own doc for why `Set<String>` alone would suppress the re-open a fresh runtime needs).
    private weak var openRequestedRuntime: OfficeRuntime?
    private var openRequestedPaths: Set<String> = []
    /// **The failed-vs-idle gate's own local proof** — see `officeDocumentViewportPlan`'s doc. Reset
    /// in lockstep with `openRequestedRuntime`/`openRequestedPaths`: a fresh runtime instance has
    /// been asked nothing by this model yet. Set INSIDE the deferred open `Task`, immediately before
    /// the call it guards — never synchronously in `requestOpenIfNeeded` itself, which is what
    /// leaves the one-beat "asked but not yet landed" window rendering `.booting` rather than
    /// flashing a failure if a stale broadcast is sitting in `runtimeState` from before this tab's
    /// own ask went out.
    private(set) var hasRequestedOpen = false

    init(tabId: String, path: String?) {
        self.tabId = tabId
        self.path = path
    }

    /// Re-point at a host/session. Called on every render pass (`panelTabContent`) — idempotent, and
    /// must not publish (runs inside `ShellPanel`'s own `body`; see `PanelEditorTabModel.bind`'s own
    /// header for the exact trap this avoids).
    func bind(host: ShellSessionHost?, sessionId: String?) {
        guard self.host !== host || self.sessionId != sessionId else { return }
        self.host = host
        self.sessionId = sessionId
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
    func activate() {
        guard !isRetired else { return }
        refresh()
    }

    /// Drop every live wire — mirrors `PanelEditorTabModel.deactivate`'s own one-way discipline
    /// (`activate`/`refresh` both refuse afterwards). `canvasHost` is left alone: a live canvas
    /// clears it itself on dismantle, and a model retired before its canvas tears down must not race
    /// that explicit nil with one of its own.
    func deactivate() {
        isRetired = true
        runtimeSink = nil
        runtimeRef = nil
    }

    private func refresh() {
        guard !isRetired, let sessionId else { return }
        let resolved = host?.officeRuntime(for: sessionId)
        if resolved !== runtimeRef {
            runtimeRef = resolved
            guard let resolved else {
                runtimeSink = nil
                runtimeState = nil
                return
            }
            runtimeSink = resolved.$state.sink { [weak self] state in
                guard let self else { return }
                self.runtimeState = state
                self.requestOpenIfNeeded()
            }
        }
        requestOpenIfNeeded()
    }

    /// The lazy open, at most once per (runtime, path) — mirrors
    /// `PanelEditorTabModel.requestOpenIfNeeded` in shape. The gate is simpler than the editor's own
    /// (`editorViewportPlan`'s `.openThenActivate`): open exactly when there is neither a document
    /// nor a recorded per-path failure yet — a recorded failure means SOMETHING already tried and
    /// this must not silently auto-retry it (obligation 5: retry is a user action, never automatic).
    func requestOpenIfNeeded() {
        guard let runtime = runtimeRef, let path, !path.isEmpty else { return }
        guard let state = runtimeState else { return }
        guard state.documents[path] == nil, state.openFailures[path] == nil else { return }
        if openRequestedRuntime !== runtime {
            openRequestedRuntime = runtime
            openRequestedPaths = []
            hasRequestedOpen = false
        }
        guard openRequestedPaths.insert(path).inserted else { return }
        // Never synchronous — this can run from inside the runtime's own `@Published` `willSet`
        // (the state sink above), i.e. in the middle of a reducer step; the hop is what keeps that
        // re-entry impossible. `open` is NOT `async` (unlike `EditorRuntime.openFile`) but the same
        // discipline still applies to the CALL, not just an await.
        Task { @MainActor [weak self, weak runtime] in
            self?.hasRequestedOpen = true
            runtime?.open(path)
        }
    }

    /// **Obligation 5's Reopen affordance** — a genuine, user-triggered retry once `phase ==
    /// .failed`. `open(_:)` retries exactly like `.idle` (carry 4, `OfficeRuntimeReducer`'s own
    /// doc), clearing `failureReason` the moment it dispatches — there is no second method to write,
    /// only this door to it.
    func retryOpen() {
        guard let runtime = resolvedRuntime(), let path else { return }
        runtime.open(path)
    }

    /// The part-strip's own door — routed to whichever canvas is currently mounted. A no-op with no
    /// canvas mounted (the strip does not render without `.showCanvas` in the first place, so this
    /// is defensive, not a real path).
    func selectPart(_ part: Int) {
        canvasHost?.setActivePart(part)
    }

    /// Resolved through the host at fire time, never through a remembered runtime — mirrors
    /// `PanelEditorTabModel.resolvedRuntime`'s own reasoning: a button pressed on a tab whose
    /// session has departed must reach nothing, not a torn-down runtime.
    private func resolvedRuntime() -> OfficeRuntime? {
        guard !isRetired, let path, !path.isEmpty else { return nil }
        return sessionId.flatMap { host?.existingOfficeRuntime(for: $0) } ?? runtimeRef
    }

    /// What the content asks. The mirror is only as true as the object it mirrors — a runtime
    /// released by a clean departure deallocates, `runtimeRef` (weak) goes `nil`, and `runtimeState`
    /// is then a description of something gone; `plan` reads them together for the same reason
    /// `PanelEditorTabModel.plan` does.
    var plan: OfficeDocumentViewportPlan {
        officeDocumentViewportPlan(path: path, state: runtimeRef == nil ? nil : runtimeState,
                                   hasRequestedOpen: hasRequestedOpen)
    }

    /// office-plumbing Task 8: this tab's own banner text, or `nil` — mirrors `PanelEditorTabModel
    /// .banner`'s door (`OfficeRuntimeState.documentBanners`, single source, read directly — the T5
    /// review's "emitBanner is a relay" note stands), except there is no dismiss/reload/keep-mine
    /// choice to route: Stage A's one banner reason answers itself (the file reappearing and
    /// reopening clears it — `OfficeRuntimeReducer.opened`'s own doc), so unlike `EditorTabBanner`
    /// this is a plain optional `String`, not an enum with buttons.
    var banner: String? {
        guard let path else { return nil }
        return runtimeState?.documentBanners[path]
    }

    /// Office Stage B Task 2 — the chrome's dirty dot, mirroring `PanelEditorTabModel.isDirty`'s own
    /// door onto `editorTabIsDirty` exactly.
    var isDirty: Bool { officeDocumentIsDirty(state: runtimeState, path: path) }

    /// Office Stage B Task 2b — the conflict banner's own source, read directly like `banner` above
    /// (`OfficeRuntimeState.documentConflicts`, single source). **Deliberately a SEPARATE optional
    /// from `banner`, not folded into one enum the way `EditorTabBanner` unifies the editor's two
    /// sources**: `documentBanners`/`documentConflicts` are two different dictionaries on the
    /// runtime's own state (kept apart there so the protected Stage A tripwire reading
    /// `documentBanners[path]` never has to change shape) — the VIEW layer is what decides
    /// precedence between them (`PanelDocumentContent.body`: a conflict, when present, wins).
    var conflict: OfficeConflictKind? {
        guard let path else { return nil }
        return runtimeState?.documentConflicts[path]
    }

    /// **"Reload from disk"** — discards the in-memory edits and re-stages fresh content under a new
    /// docId, the SAME machinery a clean document's silent external-change path already uses.
    func reloadFromDisk() {
        guard let runtime = resolvedRuntime(), let path else { return }
        runtime.reloadFromDisk(path)
    }

    /// **"Keep my version"** — dismisses the conflict with no other effect; the document stays
    /// exactly as it is, still dirty, still showing its in-memory edits. The brief's own words: "the
    /// next ⌘S overwrites."
    func keepMyVersion() {
        guard let runtime = resolvedRuntime(), let path else { return }
        runtime.keepMyVersion(path)
    }

    /// **"Close"** — the dirty-deletion conflict's own second action: this document is gone from
    /// disk and the user does not want it back, so there is nothing left to reload TO (unlike
    /// `.changed`, which always offers Reload) — closing the tab is the only other choice.
    ///
    /// **Office Stage B Task 3 fix round 1 (task review, IMPORTANT-1)**: this used to call
    /// `ShellSessionHost.closePanelTab` directly, on the (pre-Task-3-accurate, now-false) claim
    /// that it "reuses the SAME door the ordinary tab-close control already calls." Task 3 gave the
    /// ordinary `×` control a gate (`requestCloseTab`) that shows the dirty-close sheet before ever
    /// reaching `closePanelTab` — but left THIS caller pointed at the ungated door underneath it.
    /// `.deleted` conflicts are raised only on an already-dirty document (`OfficeRuntimeReducer
    /// .externalDeleted`'s own `guard doc.dirty` — a clean deletion never reaches `documentConflicts`
    /// at all, it goes silent-banner instead), so this button was **always** one click from silently
    /// discarding unsaved edits — precisely the ×-sheets/banner-doesn't inconsistency the review
    /// caught. Routes through the gate now: a dirty (always true here) `.deleted`-conflict document
    /// raises the SAME dirty-close sheet the `×` does, Discard/Save/Cancel and all.
    func closeTab() {
        host?.requestCloseTab(tabId)
    }

    /// Test seam: drive one refresh cycle synchronously, without a view.
    func refreshForTesting() { refresh() }
}

/// One model per tab id — mirrors `PanelEditorTabModels`/`PanelFilesTabModels` exactly, including
/// `discardAll(except:)`'s join into `ShellSessionHost.prunePanelTabModelsOnSessionChange` (the
/// T5-resurrection lesson: a model outliving its tab keeps a live `OfficeRuntime.$state`
/// subscription, which is a lighter leak than editor's hidden Chromium but the identical CLASS of
/// bug — a session hop must not leave a departed session's document tab quietly re-subscribing to
/// tile pushes that nobody is looking at).
@MainActor
enum PanelDocumentTabModels {
    private static var models: [String: PanelDocumentTabModel] = [:]

    /// A cached model whose `path` disagrees with the tab's is REPLACED, not re-bound — mirrors
    /// `PanelEditorTabModels.model(for:host:sessionId:)`'s own discipline (unreachable today, since
    /// no producer navigates a `.document` tab's `url`, but the alternative must still be a decision
    /// made here rather than discovered later).
    static func model(for tab: PanelTab, host: ShellSessionHost?, sessionId: String?) -> PanelDocumentTabModel {
        if let cached = models[tab.tabId], cached.path == tab.url {
            cached.bind(host: host, sessionId: sessionId)
            return cached
        }
        let fresh = PanelDocumentTabModel(tabId: tab.tabId, path: tab.url)
        models[tab.tabId] = fresh
        fresh.bind(host: host, sessionId: sessionId)
        return fresh
    }

    /// Dropped when the user closes the tab. **It does not close the runtime's document itself** —
    /// `ShellSessionHost.closePanelTab` does that directly (Stage A documents are never dirty, so
    /// there is no gate to route through the way `.code`'s `requestCloseTab` is — see that method's
    /// own comment for the disclosed choice).
    static func discard(tabId: String) {
        models.removeValue(forKey: tabId)?.deactivate()
    }

    /// Every model whose tab is no longer on screen, deactivated and dropped — the session-change
    /// prune. `except` is the tab set the panel now publishes.
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

/// office-plumbing Task 6: the `.document` implementation of `PanelTabContent`, replacing the
/// Stage-A-era placeholder `panelTabContent(for:)` routed here (`PanelWebTab.swift`'s
/// `.document, .note:` arm, now `.note:` alone).
struct PanelDocumentTab: PanelTabContent {
    let tab: PanelTab
    let model: PanelDocumentTabModel

    var kind: PanelTabKind { .document }
    var title: String { panelTabDisplayTitle(tab) }
    var icon: Image { Image(systemName: panelTabFaviconSystemImage(.document)) }

    func makeChrome() -> AnyView { AnyView(PanelDocumentChrome(model: model, tab: tab)) }
    func makeContent() -> AnyView { AnyView(PanelDocumentContent(model: model)) }
}

// MARK: - office-plumbing Task 7: the open-with escape hatch

/// The chrome button's label AND tooltip — "Open in Numbers", never a bundle id or a raw path. A
/// LIVE LaunchServices read (the same class `NSWorkspace.shared.frontmostApplication` already is
/// elsewhere in this app, e.g. `ExternalFocusSnapshot.swift`) rather than a cached fact, so a newly
/// installed app is reflected the very next time this renders, with nothing to invalidate.
///
/// Falls back to a generic sentence when LaunchServices names nothing (no app installed claims the
/// type) — the button still fires `NSWorkspace.shared.open` either way; macOS owns what happens next
/// (its own "choose an application" affordance) when nothing claims the type. `nil`/empty path
/// (unreachable through any shipped door, per `PanelDocumentTabModel.path`'s own doc) reads the same
/// as "no app found" rather than constructing an empty `URL`.
func officeOpenWithLabel(forFileAt path: String?) -> String {
    guard let path, !path.isEmpty,
          let appURL = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: path))
    else {
        return "Open in Default App"
    }
    return "Open in \(FileManager.default.displayName(atPath: appURL.path))"
}

// MARK: - The chrome row

/// Path, the dirty dot, plus the open-with escape hatch. **Office Stage B Task 2 narrows this
/// file's own Stage-A claim**: documents are no longer purely view-only, so the dirty dot now
/// applies — `PanelEditorChrome`'s own visual precedent, reused directly (`Theme.accent` +
/// `panelEditorDirtyDotSize`, same as there). Still no SAVE BUTTON, deliberately: unlike the code
/// tab, a document tab's own chrome row has no obvious second trigger the way `PanelEditorChrome`'s
/// button is one of three (menu ⌘S, button, the page's own ⌘S) — ⌘S alone is this tab's one save
/// door for now; a button can follow if a live gate asks for one. Reuses `editorTabDisplayPath`
/// verbatim — despite its name, the function is generic path-shortening, and a second copy of "last
/// two path components" would drift the moment one of them learned about `~`.
struct PanelDocumentChrome: View {
    @ObservedObject var model: PanelDocumentTabModel
    let tab: PanelTab
    /// Wave fix (T7-F2) — hoisted out of `body`: `officeOpenWithLabel` does a LIVE LaunchServices
    /// lookup (`NSWorkspace.shared.urlForApplication`), measured at ~0.112ms/call, and `body` can
    /// re-evaluate up to 60Hz during scroll — calling it inline there was up to ~0.7% of a frame
    /// spent on a lookup whose only input, `model.path`, is a `let` that never changes for this
    /// model's lifetime (Stage A has no rename/move). Computed once, at construction.
    private let openWithLabel: String

    init(model: PanelDocumentTabModel, tab: PanelTab) {
        self.model = model
        self.tab = tab
        self.openWithLabel = officeOpenWithLabel(forFileAt: model.path)
    }

    var body: some View {
        HStack(spacing: panelEditorChromeGap) {
            Text(editorTabDisplayPath(path: model.path, fallbackTitle: panelTabDisplayTitle(tab)))
                .font(Typography.captionMono())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)

            if model.isDirty {
                // Office Stage B Task 2 — the editor's own visual precedent (`PanelEditorChrome`'s
                // identical dot), reusing its exact size token and the brand accent rather than a
                // second literal: this is the one place in the row that is about STATE, not text.
                Circle()
                    .fill(Theme.accent)
                    .frame(width: panelEditorDirtyDotSize, height: panelEditorDirtyDotSize)
                    .accessibilityLabel("Unsaved changes")
            }

            Spacer(minLength: panelEditorChromeGap)

            // office-plumbing Task 7: the open-with escape hatch — Stage A documents are view-only,
            // so this is the ONE trailing action a document tab offers. `ShellTitlebarButton`, the
            // SAME "one chrome-button treatment" every other chrome row's trailing action already
            // wears (`PanelEditorChrome`'s Save, `PanelFilesChrome`'s Refresh) — ONE visible button,
            // not a ⌘-click on the tab title (considered and rejected: an undiscoverable gesture is
            // not an affordance, and Stage A has nothing else competing for ⌘-click on this tab
            // anyway). Closes no tab and pre-warms nothing — it only ever launches a SEPARATE app via
            // NSWorkspace, so it cannot go stale the way a close door reaching a bound-but-unattached
            // session's runtime could (the T6 review's N5 note, never a shipped door here).
            ShellTitlebarButton(systemImage: "arrow.up.forward.app",
                                label: openWithLabel,
                                size: panelChromeButtonSize) {
                guard let path = model.path, !path.isEmpty else { return }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }
}

// MARK: - The content

/// The canvas plus its calm states.
struct PanelDocumentContent: View {
    @ObservedObject var model: PanelDocumentTabModel

    var body: some View {
        VStack(spacing: 0) {
            // office-plumbing Task 8 — above everything, including the calm states: mirrors
            // `PanelEditorContent.body`'s identical placement and identical reasoning (a file that
            // was deleted while its tab was showing something else still has something to say, and a
            // banner that only rendered over the canvas would be invisible exactly when it matters).
            // Office Stage B Task 2b: a conflict, when present, WINS over the plain banner — the two
            // are mutually exclusive in practice (the reducer never sets both for the same path: a
            // conflict clears `documentBanners` the instant it is raised, `.opened`/`.saveSucceeded`
            // clear `documentConflicts` the instant either resolves it), but the view layer's own
            // precedence is the tie-break of record, matching `PanelDocumentTabModel.conflict`'s own
            // header.
            if let conflict = model.conflict {
                OfficeConflictBannerView(kind: conflict, onReload: { model.reloadFromDisk() },
                                         onKeepMine: { model.keepMyVersion() }, onClose: { model.closeTab() })
            } else if let banner = model.banner {
                OfficeDocumentBannerView(text: banner)
            }
            viewport
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.activate() }
    }

    private var viewport: some View {
        Group {
            switch model.plan {
            case .showCanvas(let path, let docId, let type, let parts, let sizeTwips, let activePart):
                if let runtime = model.runtime {
                    OfficeDocumentSurface(model: model, runtime: runtime, path: path, docId: docId,
                                          type: type, parts: parts, sizeTwips: sizeTwips,
                                          activePart: activePart)
                } else {
                    // The plan said show-canvas and the runtime went away between the two reads
                    // (weak `runtimeRef`, a clean departure raced this render). One frame; the next
                    // refresh resolves whatever the session has now — mirrors
                    // `PanelEditorContent.viewport`'s identical fallback arm.
                    OfficeDocumentViewportStateView(state: .booting, onReopen: {})
                }
            case .renderState(let state):
                OfficeDocumentViewportStateView(state: state, onReopen: { model.retryOpen() })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - office-plumbing Task 8: the banner

/// **One row above the canvas, ONE source, no buttons.** The look reuses `EditorBannerView`'s exact
/// vocabulary (`PanelEditorTab.swift`'s own header explains the tokens: `Theme.elevatedSurface` +
/// `Theme.hairline`, `.primary` text, no danger tone — this palette has none) rather than inventing a
/// second one; the shape is smaller because the CONTENT is smaller — Stage A has exactly one banner
/// reason, it persists (nothing to lose, per the brief), and there is nothing to choose between, so
/// there are no action buttons at all, dismiss included.
struct OfficeDocumentBannerView: View {
    let text: String

    var body: some View {
        HStack(spacing: panelEditorBannerGap) {
            Text(text)
                .font(Typography.caption(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: panelEditorBannerGap)
        }
        .padding(.horizontal, panelTabPillInset)
        .padding(.vertical, panelEditorBannerVerticalPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.elevatedSurface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
    }
}

// MARK: - Office Stage B Task 2b: the conflict banner (a dirty document's own, two actions)

/// **The same row, wearing `EditorBannerView`'s exact vocabulary** (`EditorBannerView`'s own header
/// explains the tokens this reuses verbatim: `Theme.elevatedSurface` + `Theme.hairline`, `.primary`
/// sentence / `Theme.textMuted` detail, `ShellSidebarRowStyle` text buttons, no danger tone) — unlike
/// the editor's OWN `.conflict(.deleted)` arm, which offers a single dismiss button because there is
/// nothing else editor-side to choose, Office's brief names TWO actions for EVERY conflict kind
/// (`.changed`: Reload from disk / Keep my version; `.deleted`: Keep my version / Close) — there is
/// no bare-dismiss case here at all, so unlike `EditorBannerView` this view never needs an
/// `onDismiss`.
struct OfficeConflictBannerView: View {
    let kind: OfficeConflictKind
    let onReload: () -> Void
    let onKeepMine: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: panelEditorBannerGap) {
            Text(sentence)
                .font(Typography.caption(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .truncationMode(.middle)
                .fixedSize(horizontal: false, vertical: true)

            if let detail {
                Text(detail)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: panelEditorBannerGap)

            switch kind {
            case .changed:
                // Reload first, Keep mine second — the destructive one (discards the in-memory
                // edits) answers the sentence's own question first; mirrors
                // `EditorBannerView.body`'s identical ordering and identical reasoning.
                action(officeConflictReloadTitle, onReload)
                action(officeConflictKeepTitle, onKeepMine)
            case .deleted:
                // No Reload — there is nothing left on disk to reload TO (`officeConflictDeletedDetail`
                // says as much). Keep mine first (the non-destructive choice, and the one that leaves
                // the tab open) so Close — the one that ends this tab — reads last.
                action(officeConflictKeepTitle, onKeepMine)
                action(officeConflictCloseTitle, onClose)
            }
        }
        .padding(.horizontal, panelTabPillInset)
        .padding(.vertical, panelEditorBannerVerticalPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.elevatedSurface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.hairline).frame(height: 1)
        }
    }

    private var sentence: String {
        switch kind {
        case .changed: return officeConflictChangedMessage
        case .deleted: return officeConflictDeletedMessage
        }
    }

    private var detail: String? {
        guard kind == .deleted else { return nil }
        return officeConflictDeletedDetail
    }

    /// Identical to `EditorBannerView`'s own private `action` helper — the panel's ONE text-button
    /// treatment, not reinvented here.
    private func action(_ title: String, _ perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(title)
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, panelEditorBannerGap)
                .frame(height: panelChromeButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .accessibilityLabel(title)
    }
}

/// The canvas plus its part-navigation strip, laid out per `officePartStripKind` (obligation 10):
/// sheets get a bottom row, slides get a left rail, docs get neither.
struct OfficeDocumentSurface: View {
    @ObservedObject var model: PanelDocumentTabModel
    let runtime: OfficeRuntime
    let path: String
    let docId: String
    let type: OfficeDocumentKind
    let parts: Int
    let sizeTwips: OfficeDocumentSize
    let activePart: Int

    var body: some View {
        let stripKind = officePartStripKind(for: type)
        HStack(spacing: 0) {
            if stripKind == .leftSlideRail {
                OfficeSlideRail(parts: parts, activePart: activePart, onSelect: model.selectPart)
            }
            VStack(spacing: 0) {
                OfficeTileCanvasRepresentable(model: model, runtime: runtime, path: path, docId: docId,
                                              sizeTwips: sizeTwips, activePart: activePart)
                if stripKind == .bottomSheetTabs {
                    OfficeSheetTabStrip(parts: parts, activePart: activePart, onSelect: model.selectPart)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Part navigation strips (custom-drawn, `ShellSidebarRowStyle` tones — obligation 10)

func officeSheetTabTitle(_ index: Int) -> String { "Sheet \(index + 1)" }

/// Spreadsheets: a bottom row of sheet-tab pills, one per part, numbered from 1.
struct OfficeSheetTabStrip: View {
    let parts: Int
    let activePart: Int
    let onSelect: (Int) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: officePartStripItemSpacing) {
                ForEach(0..<max(parts, 0), id: \.self) { index in
                    Button(action: { onSelect(index) }) {
                        Text(officeSheetTabTitle(index))
                            .font(Typography.caption(.medium))
                            .foregroundStyle(index == activePart ? Color.primary : Theme.textMuted)
                            .padding(.horizontal, panelEditorChromeGap)
                            .frame(height: officePartStripBottomHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellSidebarRowStyle(isSelected: index == activePart))
                    .accessibilityLabel(officeSheetTabTitle(index))
                }
            }
            .padding(.horizontal, panelTabPillInset)
        }
        .frame(height: officePartStripBottomHeight)
        .background(Theme.elevatedSurface)
        .overlay(alignment: .top) { Rectangle().fill(Theme.hairline).frame(height: 1) }
    }
}

/// Presentations: a left rail of slide numbers, Stage A's "numbers only" reading of the brief —
/// thumbnails are a later stage's problem.
struct OfficeSlideRail: View {
    let parts: Int
    let activePart: Int
    let onSelect: (Int) -> Void

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: officePartStripItemSpacing) {
                ForEach(0..<max(parts, 0), id: \.self) { index in
                    Button(action: { onSelect(index) }) {
                        Text("\(index + 1)")
                            .font(Typography.caption(.medium))
                            .foregroundStyle(index == activePart ? Color.primary : Theme.textMuted)
                            .frame(width: officePartStripRailWidth - 8, height: officePartStripRailWidth - 8)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellSidebarRowStyle(isSelected: index == activePart))
                    .accessibilityLabel("Slide \(index + 1)")
                }
            }
            .padding(.vertical, panelEditorChromeGap)
        }
        .frame(width: officePartStripRailWidth)
        .background(Theme.elevatedSurface)
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.hairline).frame(width: 1) }
    }
}

// MARK: - The calm states

/// Every not-the-canvas state, in the shell's own empty-state vocabulary
/// (`EditorViewportStateView`'s the in-repo shape this follows).
struct OfficeDocumentViewportStateView: View {
    let state: OfficeDocumentViewportState
    let onReopen: () -> Void

    var body: some View {
        Group {
            switch state {
            case .noFile:
                message("This tab has no file")
            case .booting:
                ProgressView().controlSize(.small)
            case .failed(let reason):
                VStack(spacing: panelEditorChromeGap) {
                    Text("The office helper stopped")
                        .font(Typography.emptyStateSubtitle)
                        .foregroundStyle(.primary)
                    Text(reason)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .multilineTextAlignment(.center)
                    reopenButton
                }
                .padding(.horizontal, panelTabPillInset)
            case .openFailed(let path, let reason):
                message("This document couldn't be opened", path: path, detail: reason)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var reopenButton: some View {
        Button(action: onReopen) {
            Text("Reopen")
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textMuted)
                .padding(.horizontal, panelEditorBannerGap)
                .frame(height: panelChromeButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(ShellSidebarRowStyle(isSelected: false))
        .accessibilityLabel("Reopen")
    }

    /// Mirrors `EditorViewportStateView.message` — title, then the file (shown in full, middle
    /// truncated), then the reason.
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
