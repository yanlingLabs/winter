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

    private let lock = NSLock()
    private var _windowID: UInt32
    private var _windowTitle: String
    var windowID: UInt32 { lock.lock(); defer { lock.unlock() }; return _windowID }
    var windowTitle: String { lock.lock(); defer { lock.unlock() }; return _windowTitle }

    func setWindow(id: UInt32, title: String) {
        lock.lock(); _windowID = id; _windowTitle = title; lock.unlock()
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

    static let keptSnapshots = 8
    static let keptShots = 8

    init(id: String, sessionId: String, pid: pid_t, bundleId: String?, appName: String, isChromium: Bool,
         mirror: Bool, windowID: UInt32, windowTitle: String) {
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
        lock.withLock { _snapshots.removeAll() }
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
