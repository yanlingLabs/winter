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
        func hasText(_ t: String) -> Bool {
            let want = CUFinder.fold(t)
            guard !want.isEmpty else { return false }
            return nodes.contains { n in
                [n.name, n.isSecure ? nil : n.value].contains { $0.map { CUFinder.fold($0).contains(want) } ?? false }
            }
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

    /// What `wait_timeout` reports as seen.
    static func seen(_ o: Observation) -> String {
        let count = o.roots.reduce(0) { $0 + $1.flattened().count }
        var parts = ["window \"\(o.windowTitle)\"", "\(count) elements"]
        if let f = o.focusedRef { parts.append("focused [\(f)]") }
        return parts.joined(separator: " · ")
    }
}
