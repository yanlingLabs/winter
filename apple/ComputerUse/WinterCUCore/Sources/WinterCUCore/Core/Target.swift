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

    /// Recent screenshots' coordinate spaces, oldest first.
    var shots: [CUShotSpace] { lock.lock(); defer { lock.unlock() }; return _shots }
    /// Clock time of the last action the helper performed here (counts as activity for settle).
    var lastActionMs: Double? {
        get { lock.lock(); defer { lock.unlock() }; return _lastActionMs }
        set { lock.lock(); _lastActionMs = newValue; lock.unlock() }
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
    /// The bound window's web area as last found, the window title then, and how long a window found to hold none
    /// is not walked again. Pid-queue only.
    var webArea: AXUIElement?
    var webAreaWindowTitle: String?
    var noWebAreaUntil: Double?

    /// The focus read after the last act, and when: the next act's "before". Pid-queue only.
    var focusAfterLastAct: (atMs: Double, focus: CUCore.WindowFocus)?

    /// When this target last had a window-targeted click posted to place the focus or make its window key:
    /// the app may handle it after the act's next accessibility write (a late click moves the caret).
    /// Pid-queue only.
    var lastFocusClickMs: Double?

    /// The last off-screen image of the window (a digest) and when: a later identical one, with input sent in
    /// between, is called stale. Returns the one before this.
    private var _lastOffScreenShot: (digest: Int, atMs: Double)?
    func noteOffScreenShot(digest: Int, at ms: Double) -> (digest: Int, atMs: Double)? {
        lock.lock(); defer { lock.unlock() }
        let before = _lastOffScreenShot
        _lastOffScreenShot = (digest, ms)
        return before
    }

    /// Actions an app listed for an element but refused (`AXOpen` on Finder's icons), by role: hidden from
    /// state when `action()` has no equivalent to fall back on. Pid-queue only.
    private(set) var refusedActions: [String: Set<String>] = [:]
    func noteRefused(action: String, role: String) { refusedActions[role, default: []].insert(action) }

    // The user-view guard (CUCore+UserView). Guarded by `lock`: a late check reads them from another queue.
    private var _actSeq = 0
    private var _consentedForeground = false
    private var _viewNotes: [String] = []

    /// Starts an act: its number, and no foreground consent used yet.
    func beginAct() -> Int {
        lock.lock(); defer { lock.unlock() }
        _actSeq += 1
        _consentedForeground = false
        return _actSeq
    }
    var actSeq: Int { lock.lock(); defer { lock.unlock() }; return _actSeq }
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
