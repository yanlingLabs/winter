import ApplicationServices
import CoreGraphics
import Foundation

/// A bound app window. Mutable state is only touched on the target pid's serial queue, except the fields
/// the registry lock guards (`windowID`, `windowTitle`), which a cross-queue check may read.
final class CUTarget: @unchecked Sendable {
    let id: String
    let sessionId: String
    let pid: pid_t
    let bundleId: String?
    let appName: String
    let isChromium: Bool
    let mirror: Bool
    /// The bind's private-path choice: may observation reach the window on another Space by remote token?
    let privatePath: Bool

    private let lock = NSLock()
    private var _windowID: UInt32
    private var _windowTitle: String
    var windowID: UInt32 { lock.lock(); defer { lock.unlock() }; return _windowID }
    var windowTitle: String { lock.lock(); defer { lock.unlock() }; return _windowTitle }

    func setWindow(id: UInt32, title: String) {
        lock.lock(); _windowID = id; _windowTitle = title; lock.unlock()
    }

    /// False when the window exposes no accessibility and was bound as capture-plus-coordinates. Guarded, so
    /// `useWindow` to a different window can change it.
    private var _accessible: Bool = true
    var accessible: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _accessible }
        set { lock.lock(); _accessible = newValue; lock.unlock() }
    }

    /// Element identity → ref. Pid-queue only.
    private(set) var refs = CURefCache<AXIdentity>()
    // Guarded by `lock`: the snapshot ring, the shot ring, the action clock.
    private var _snapshots: [CUSnapshot] = []
    private var snapshotSeq = 0
    private var _shots: [CUShotSpace] = []
    private var shotSeq = 0
    private var _lastActionMs: Double?
    private var _lastActReturnedMs: Double?

    /// Recent screenshots' coordinate spaces, oldest first.
    var shots: [CUShotSpace] { lock.lock(); defer { lock.unlock() }; return _shots }
    /// Clock time of the last action the helper performed here (counts as activity for settle).
    var lastActionMs: Double? {
        get { lock.lock(); defer { lock.unlock() }; return _lastActionMs }
        set { lock.lock(); _lastActionMs = newValue; lock.unlock() }
    }
    /// Clock time the last act's RESULT was returned (after its notes, a guardian restore, a background open): the
    /// after-act picture windows run from here — an act whose answer came seconds after its input (the leftover probes,
    /// 2026-10-13: Chrome activated itself and was put back) had its window spent before the next screenshot.
    var lastActReturnedMs: Double? {
        get { lock.lock(); defer { lock.unlock() }; return _lastActReturnedMs }
        set { lock.lock(); _lastActReturnedMs = newValue; lock.unlock() }
    }
    /// When the after-act windows start: the act's result returned, else (no result yet) its input.
    var afterActFromMs: Double? {
        guard let acted = lastActionMs else { return nil }
        return max(acted, lastActReturnedMs ?? acted)
    }

    /// The app's real windows when this target last looked (bind, then each state), to name new ones.
    var knownWindows: Set<UInt32> {
        get { lock.lock(); defer { lock.unlock() }; return _knownWindows }
        set { lock.lock(); _knownWindows = newValue; lock.unlock() }
    }
    private var _knownWindows: Set<UInt32> = []

    /// The last full read of the window and when it was taken, reused by `find` while nothing has changed.
    var lastFullRead: (roots: [CUNode], atMs: Double)? {
        get { lock.lock(); defer { lock.unlock() }; return _lastFullRead }
        set { lock.lock(); _lastFullRead = newValue; lock.unlock() }
    }
    private var _lastFullRead: (roots: [CUNode], atMs: Double)?

    /// Where the agent cursor was last sent (screen points): the place for cursor events that have none of
    /// their own (waits, refusals, captions, done).
    var cursorPoint: CGPoint? {
        get { lock.lock(); defer { lock.unlock() }; return _cursorPoint }
        set { lock.lock(); _cursorPoint = newValue; lock.unlock() }
    }
    private var _cursorPoint: CGPoint?

    /// The element the script last clicked by ref or aimed text at (`into`), and when — the focus fallback
    /// for apps that don't report their focused element (Electron). Pid-queue only.
    private(set) var lastTargeted: (element: AXUIElement, atMs: Double)?
    func noteTargeted(_ e: AXUIElement, at ms: Double) { lastTargeted = (e, ms) }

    /// The selection `select` last set — the element, its range, its value then — which a selection-dependent
    /// menu command acts on: checked again (and put back if a late click moved it) before the menu is
    /// validated. Pid-queue only.
    private(set) var lastSelection: (element: AXUIElement, location: Int, length: Int, value: String?, atMs: Double)?
    func noteSelection(_ e: AXUIElement, location: Int, length: Int, value: String?, at ms: Double) {
        lastSelection = (e, location, length, value, ms)
    }

    /// The bound window's focus as last read (`CUCore.windowFocus`): the act it was read in, when, and what.
    /// Pid-queue only.
    var focusCache: (act: Int, atMs: Double, focus: CUCore.WindowFocus)?
    /// The page (web area URL, window title) read after the last act, and when: the next act's "before".
    /// Pid-queue only.
    var pageAfterLastAct: (atMs: Double, page: CUCore.PageSignature?)?
    /// The page numbering (`CUCore.pageNumber`): the page last numbered and its number. Pid-queue only.
    private var numberedPage: (sig: CUCore.PageSignature, number: Int)?
    func numberPage(isNew: (CUCore.PageSignature?) -> Bool, sig: CUCore.PageSignature) -> Int {
        if isNew(numberedPage?.sig) { numberedPage = (sig, (numberedPage?.number ?? 0) + 1) }
        return numberedPage!.number
    }
    /// The page number the last whole-window state() showed. Pid-queue only.
    var pageNumberAtState: Int?

    /// The page when the last whole-window state was read: a `within` ref gone since then is "the page changed"
    /// only when this differs. Pid-queue only.
    var pageAtSnapshot: CUCore.PageSignature?
    /// The bound window's web area as last found, the window title then, and how long a window found to hold none
    /// is not walked again. Pid-queue only.
    var webArea: AXUIElement?
    var webAreaWindowTitle: String?
    var noWebAreaUntil: Double?
    /// Floor F's dialog scan: the app's window-server windows when it last ran, and its answer (`unreadable`: a dialog
    /// in words Winter could not read, refused fail-closed) — scanned again only when they change (the dialog is a window
    /// of its own). Pid-queue only.
    var remoteDebuggingScan: (windows: Set<UInt32>, shown: Bool, unreadable: Bool)?
    /// Floor F: the windows whose walk ran out of time, and when (walked again only after a while). Pid-queue only.
    var remoteDebuggingSlowWalks: [UInt32: Double] = [:]
    /// The element whose press, sent from another desktop, showed no effect — the desktop visit was offered for it.
    /// The act asked again does not press it again: from another desktop it waits for the visit, and in the visit it is
    /// clicked where it is, once (review of round 11, MEDIUM #5). Pid-queue only.
    var unconfirmedPress: (element: AXIdentity, atMs: Double, before: CUCore.WebPressEvidence?)?
    /// Windows of the app that appeared during the agent's own acts on this target — a menu, a popover, a page's popup it
    /// opened — kept while they are on screen: they belong to the bound window even where another document window of the
    /// app lies between them and it in the z-order (review of round 12, LOW). Pid-queue only.
    var agentPopups: Set<UInt32> = []
    /// When the last act that opened one ended (the list is kept a few seconds across acts that open nothing).
    var agentPopupsAtMs: Double = -.infinity
    /// Under Secure Event Input, the focused element's text as the agent last saw it (its own acts' end): a change since
    /// is the user typing (review of round 13, MEDIUM #6). Under the guardian lock.
    var secureTypingBase: (focus: AXIdentity?, chars: Int?)?
    /// That text changed while the app stayed in front (the refusal's reason, until it leaves). Under the guardian lock.
    var secureTextChanged = false

    /// The focus read after the last act, and when: the next act's "before". Pid-queue only.
    var focusAfterLastAct: (atMs: Double, focus: CUCore.WindowFocus)?

    /// The bound window's focus read INSIDE this act's focus blips (`CUCore.noteBlipFocus`), while the window held
    /// the key focus: where the keys went (the first blip, before its first key) and where they left it (the last,
    /// after its keys were taken). Pid-queue only.
    var blipFocus: (act: Int, start: CUCore.WindowFocus?, end: CUCore.WindowFocus?)?

    /// When this target last had a window-targeted click posted to place the focus or make its window key:
    /// the app may handle it after the act's next accessibility write (a late click moves the caret).
    /// Pid-queue only.
    var lastFocusClickMs: Double?

    /// The last off-screen image of the window (a digest) and when: a later identical one, with input sent in
    /// between, is called stale. Returns the one before this.
    private var _lastOffScreenShot: (digest: Int, atMs: Double, changedAtMs: Double)?
    func noteOffScreenShot(digest: Int, at ms: Double) -> (digest: Int, atMs: Double, changedAtMs: Double)? {
        lock.lock(); defer { lock.unlock() }
        let before = _lastOffScreenShot
        // When the picture last changed: kept while it stays the same.
        let changedAt = before.map { $0.digest == digest ? $0.changedAtMs : ms } ?? ms
        _lastOffScreenShot = (digest, ms, changedAt)
        return before
    }
    /// The last off-screen picture's digest and time, read without noting a new one.
    var lastOffScreenShot: (digest: Int, atMs: Double, changedAtMs: Double)? {
        lock.lock(); defer { lock.unlock() }
        return _lastOffScreenShot
    }

    /// The region and budget of the last off-screen or live shot of the window: a desktop visit's return takes the
    /// window's next baseline picture the same way, so the digests compare.
    private var _lastStill: (region: CGRect?, budget: CUImageBudget)?
    var lastStill: (region: CGRect?, budget: CUImageBudget)? {
        get { lock.lock(); defer { lock.unlock() }; return _lastStill }
        set { lock.lock(); _lastStill = newValue; lock.unlock() }
    }

    /// Actions an app listed for an element but refused (`AXOpen` on Finder's icons), by role: hidden from
    /// state when `action()` has no equivalent to fall back on. Pid-queue only.
    private(set) var refusedActions: [String: Set<String>] = [:]
    func noteRefused(action: String, role: String) { refusedActions[role, default: []].insert(action) }

    // The user-view guard (CUCore+UserView). Guarded by `lock`: a late check reads them from another queue.
    private var _actSeq = 0
    private var _consentedForeground = false
    private var _viewNotes: [String] = []

    private var _actStart: (front: pid_t?, space: UInt64?, at: TimeInterval)?

    /// Starts an act: its number, and no foreground consent used yet.
    func beginAct() -> Int {
        lock.lock(); defer { lock.unlock() }
        _actSeq += 1
        _consentedForeground = false
        return _actSeq
    }
    var actSeq: Int { lock.lock(); defer { lock.unlock() }; return _actSeq }
    /// Where the user was, and when, as the current act began (a key sent with no focus blip, the app in front, is
    /// judged against it).
    var actStart: (front: pid_t?, space: UInt64?, at: TimeInterval)? {
        get { lock.lock(); defer { lock.unlock() }; return _actStart }
        set { lock.lock(); _actStart = newValue; lock.unlock() }
    }
    /// The act brought the app forward on the consented foreground rung (the user agreed to that).
    var consentedForeground: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _consentedForeground }
        set { lock.lock(); _consentedForeground = newValue; lock.unlock() }
    }
    /// What moved the user's view (and what was put back), for the next act result to say.
    func addViewNote(_ note: String) { lock.lock(); _viewNotes.append(note); lock.unlock() }
    func takeViewNotes() -> [String] {
        lock.lock(); defer { lock.unlock() }
        let notes = _viewNotes
        _viewNotes = []
        return notes
    }

    /// Menu commands found disabled in the background and answered with the UI routes that check the item
    /// itself; asking for one of them again asks for the foreground. Pid-queue only.
    var disabledMenuCommands: Set<String> = []

    static let keptSnapshots = 8
    static let keptShots = 8

    init(id: String, sessionId: String, pid: pid_t, bundleId: String?, appName: String, isChromium: Bool,
         mirror: Bool, windowID: UInt32, windowTitle: String, privatePath: Bool = true, accessible: Bool = true) {
        self.privatePath = privatePath
        self._accessible = accessible
        self.id = id
        self.sessionId = sessionId
        self.pid = pid
        self.bundleId = bundleId
        self.appName = appName
        self.isChromium = isChromium
        self.mirror = mirror
        self._windowID = windowID
        self._windowTitle = windowTitle
    }

    /// The bound window changed: refs and the diff base of the old window go (pid queue). New refs continue
    /// above the old ones, so a number is still never reused.
    func resetForNewWindow() {
        refs = CURefCache<AXIdentity>(firstRef: refs.highestRef + 1)
        lastTargeted = nil
        lastSelection = nil
        lock.withLock { _snapshots.removeAll(); _lastFullRead = nil }
    }

    func nextSnapshotId() -> String {
        lock.lock(); defer { lock.unlock() }
        snapshotSeq += 1
        return "\(id).s\(snapshotSeq)"
    }

    func store(_ s: CUSnapshot) {
        lock.lock(); defer { lock.unlock() }
        _snapshots.append(s)
        if _snapshots.count > Self.keptSnapshots { _snapshots.removeFirst(_snapshots.count - Self.keptSnapshots) }
    }

    func snapshot(_ id: String) -> CUSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return _snapshots.last { $0.id == id }
    }

    var snapshotIds: [String] {
        lock.lock(); defer { lock.unlock() }
        return _snapshots.map(\.id)
    }

    func registerShot(anchor: CUShotSpace.Anchor, imageWidth: Int, imageHeight: Int, points: CGSize) -> CUShotSpace {
        lock.lock(); defer { lock.unlock() }
        shotSeq += 1
        let shot = CUShotSpace(id: "\(id).i\(shotSeq)", anchor: anchor, imageWidth: imageWidth, imageHeight: imageHeight,
                               pointsWidth: Double(points.width), pointsHeight: Double(points.height))
        _shots.append(shot)
        if _shots.count > Self.keptShots { _shots.removeFirst(_shots.count - Self.keptShots) }
        return shot
    }

    /// `shotId`, or the latest screenshot when none is named.
    func shot(_ id: String?) throws -> CUShotSpace {
        let shots = self.shots
        if let id {
            guard let s = shots.last(where: { $0.id == id }) else {
                throw CUError.invalidParams("screenshot \(id) is not one of this target's recent screenshots — take a new one")
            }
            return s
        }
        guard let s = shots.last else {
            throw CUError.invalidParams("a point needs a screenshot of this target first — or use a ref")
        }
        return s
    }
}

/// `waitFor`'s condition check over one observation (pure). All given parts must hold.
enum CUWaitEvaluator {
    struct Observation {
        var roots: [CUNode]
        var windowTitle: String
        var focusedRef: Int?
    }

    static func met(_ c: CUWaitCondition, _ o: Observation) -> Bool {
        let nodes = o.roots.flatMap { $0.flattened() }
        var runs: [CUFinder.TextRun]?
        func hasText(_ t: String) -> Bool {
            let want = norm(t)
            guard !want.isEmpty else { return false }
            if nodes.contains(where: { n in
                [n.name, n.isSecure ? nil : n.value].contains { $0.map { norm($0).contains(want) } ?? false }
            }) { return true }
            if runs == nil { runs = CUFinder.textRuns(nodes) }
            return runs!.contains { $0.contains(want) }
        }
        if let t = c.text, !hasText(t) { return false }
        if let r = c.ref, !nodes.contains(where: { $0.ref == r }) { return false }
        if let g = c.gone {
            switch g {
            case .ref(let r): if nodes.contains(where: { $0.ref == r }) { return false }
            case .text(let t): if hasText(t) { return false }
            }
        }
        if let t = c.title, !CUFinder.fold(o.windowTitle).contains(CUFinder.fold(t)) { return false }
        return c.text != nil || c.ref != nil || c.gone != nil || c.title != nil
    }

    /// Folded, with every run of whitespace one space (`CUFinder.norm`).
    static func norm(_ s: String) -> String { CUFinder.norm(s) }

    /// What `wait_timeout` reports as seen: the window, its element count, the focus — and, when a dialog is open, the
    /// dialog by its words and that the page behind it may be hidden from accessibility while it is open (measured on
    /// the Chrome Web Store dashboard, 2026-10-14: with its "Success" dialog up, Chrome's web area held only the
    /// dialog, so a wait for the status text behind it timed out with "62 elements" and nothing said why).
    static func seen(_ o: Observation) -> String {
        let count = o.roots.reduce(0) { $0 + $1.flattened().count }
        var parts = ["window \"\(o.windowTitle)\"", "\(count) elements"]
        if let f = o.focusedRef { parts.append("focused [\(f)]") }
        var s = parts.joined(separator: " · ")
        if let d = dialogNote(o.roots, focusedRef: o.focusedRef) { s += " — " + d }
        return s
    }

    /// Subroles of a dialog: AppKit's, and the one Chromium and WebKit give a page's `role="dialog"` / `alertdialog`.
    static let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog", "AXApplicationDialog", "AXApplicationAlertDialog"]

    /// "a dialog "Success" is open ("Your publish request was submitted"; button "OK") — …" for the first dialog in the
    /// tree below its roots: an element with a dialog subrole, a sheet — or, said as only looking like one, a web area whose
    /// only content is one named group (not a landmark) with a dialog-like name and a button or the focus, or small (under 12 elements) holding a
    /// button and the keyboard focus and no field to type into (how Chrome's tree read live while a page's modal dialog
    /// was up: it printed as a group, the page left out). Nil when none. Pure.
    static func dialogNote(_ roots: [CUNode], focusedRef: Int?) -> String? {
        // Never a root: a bound window that is itself a dialog (or an open menu read beside it) is what is being read.
        let nodes = roots.flatMap { $0.flattened().dropFirst() }
        func plainGroup(_ n: CUNode) -> Bool {
            guard n.role == "AXGroup", let name = n.name, !name.isEmpty,
                  !(n.subrole.map { $0.hasPrefix("AXLandmark") || $0.hasPrefix("AXDocument") || $0 == "AXTabPanel" } ?? false)
            else { return false }
            let inside = n.flattened()
            let button = inside.dropFirst().contains { $0.role == "AXButton" }
            let focus = focusedRef.map { f in inside.contains { $0.ref == f } } == true
            // A dialog-like name with something of a dialog's: a button or the focus (the name alone is a heading's).
            if dialogLikeName(name) { return button || focus }
            // A small group holding a button and the focus, and nothing to type into: a login or search form wrapped in
            // a named group is no dialog (the review of this branch).
            return inside.count < shapeMaxElements
                && button && focus
                && !inside.contains { entryRoles.contains($0.role) || $0.isSecure }
        }
        var dialog: CUNode?
        var pageHidden = false
        var byKind = true
        if let d = nodes.first(where: { n in
            (n.subrole.map(dialogSubroles.contains) ?? false) || n.role == "AXSheet"
        }) {
            dialog = d
            pageHidden = nodes.contains { w in w.role == "AXWebArea" && soleContent(w)?.ref == d.ref }
        } else if let w = nodes.first(where: { w in w.role == "AXWebArea" && soleContent(w).map(plainGroup) == true }) {
            dialog = soleContent(w)
            byKind = false
        }
        guard let d = dialog else { return nil }
        func cut(_ s: String) -> String {
            let t = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            return t.count > 80 ? String(t.prefix(79)) + "…" : t
        }
        let inside = d.flattened().dropFirst()
        let name = d.name.flatMap { $0.isEmpty ? nil : cut($0) }
        var texts: [String] = []
        for n in inside where n.role == "AXStaticText" && !n.isSecure {
            guard let t = (n.name ?? n.value).map(cut), !t.isEmpty, t != name, !texts.contains(t) else { continue }
            texts.append(t)
            if texts.count == 2 { break }
        }
        let buttons = inside.filter { $0.role == "AXButton" }.compactMap { $0.name.flatMap { $0.isEmpty ? nil : cut($0) } }.prefix(3)
        var what: [String] = []
        if !texts.isEmpty { what.append(texts.map { "\"\($0)\"" }.joined(separator: ", ")) }
        if !buttons.isEmpty { what.append((buttons.count == 1 ? "button " : "buttons ") + buttons.map { "\"\($0)\"" }.joined(separator: ", ")) }
        let says = what.isEmpty ? "" : " (" + what.joined(separator: "; ") + ")"
        let label = name.map { " \"\($0)\"" } ?? ""
        if !byKind {
            return "the page shows only \(d.roleWords)\(label) [\(d.ref)]\(says) — it looks like a dialog: while a page's dialog is open the browser leaves the page behind it out of the accessibility tree, so what you wait for may be behind it; answer or close it, then wait again"
        }
        let behind = pageHidden
            ? "the page behind it is not in the accessibility tree while it is open"
            : "what is behind it may be hidden from accessibility while it is open"
        return "a dialog\(label) [\(d.ref)] is open\(says) — \(behind), so what you wait for may be behind it: answer or close the dialog, then wait again"
    }

    /// The shape rule's size bound: the measured "Success" dialog is 6 elements.
    static let shapeMaxElements = 12
    /// Roles a person types into: a group holding one is a form, not the shape rule's dialog.
    static let entryRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

    /// A name that says dialog: "… dialog", "Alert", "Confirm …", "… modal".
    static func dialogLikeName(_ name: String) -> Bool {
        let words = CUFinder.fold(name).split(whereSeparator: { !$0.isLetter }).map(String.init)
        return words.contains { ["dialog", "alert", "modal", "confirm", "confirmation"].contains($0) }
    }

    /// A web area's only content: its one child that is not an empty, childless group. Nil with none or several.
    static func soleContent(_ w: CUNode) -> CUNode? {
        let content = w.children.filter { c in
            !(c.role == "AXGroup" && (c.name ?? "").isEmpty && (c.value ?? "").isEmpty && c.children.isEmpty)
        }
        return content.count == 1 ? content[0] : nil
    }
}
