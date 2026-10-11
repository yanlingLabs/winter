import Foundation

// The desktop-switch prompt (user ruling 2026-10-10): when an act can't land, or a live picture can't be had,
// without taking the user to another desktop, they are asked — on their CURRENT desktop, by a panel that never
// takes focus and never appears in a capture — with a countdown. The daemon asks the same question on the
// session's own card; the first answer from either door resolves both, and the daemon is the authority on the
// outcome (it treats this panel's `expired` as its own timeout-allow). Nothing here moves the user anywhere.

/// What the user answered on the panel.
public enum CUDesktopPromptAnswer: String, Sendable, Equatable {
    /// "Switch now".
    case switchNow = "switch"
    /// "Don't switch".
    case refuse
    /// The countdown ran out with no answer.
    case expired
}

/// One prompt to show: the daemon's `prompt.desktopVisit`.
public struct CUDesktopPromptRequest: Sendable, Equatable {
    public let promptId: String
    public let sessionId: String
    public let app: String
    public let bundleId: String
    /// The model's reason (the daemon's sanitized one; sanitized again here).
    public let reason: String
    /// The fallback countdown, when there is no `expiresAt`.
    public let timeoutMs: Int
    /// The session card's own deadline (epoch ms): the countdown runs to it.
    public let expiresAt: Int?

    public init(promptId: String, sessionId: String, app: String, bundleId: String, reason: String, timeoutMs: Int,
                expiresAt: Int? = nil) {
        self.promptId = promptId
        self.sessionId = sessionId
        self.app = app
        self.bundleId = bundleId
        self.reason = reason
        self.timeoutMs = timeoutMs
        self.expiresAt = expiresAt
    }
}

/// The prompt's words and its answer-once state. Pure.
public struct CUDesktopPromptModel: Sendable, Equatable {
    public static let reasonMax = 200
    public static let nameMax = 80
    /// A countdown is never shorter or longer than this, whatever was asked.
    public static let timeoutRange: ClosedRange<Int> = 1_000...600_000

    public let promptId: String
    public let sessionId: String
    /// "Switch to Safari's desktop?"
    public let title: String
    /// "Safari (com.apple.Safari)" — the bundle id is part of it, so a look-alike app cannot borrow a trusted name.
    public let appLine: String
    /// The model's reason, one sanitized line ("" when none).
    public let reason: String
    public let backLine = "Winter will bring you back right after."
    /// When the countdown runs out (the clock's seconds).
    public let deadline: TimeInterval
    public private(set) var answer: CUDesktopPromptAnswer?

    /// `now`: the controller's (monotonic) clock; `wallMs`: the wall clock in epoch ms, against which `expiresAt` —
    /// the card's own deadline — is turned into time left (so both doors end together).
    public init(_ r: CUDesktopPromptRequest, now: TimeInterval, wallMs: Double = Date().timeIntervalSince1970 * 1000) {
        promptId = r.promptId
        sessionId = r.sessionId
        let app = Self.sanitize(r.app, max: Self.nameMax)
        let name = app.isEmpty ? "the app" : app
        title = "Switch to \(name)'s desktop?"
        let bundle = Self.sanitize(r.bundleId, max: Self.nameMax)
        appLine = bundle.isEmpty ? name : "\(name) (\(bundle))"
        reason = Self.sanitize(r.reason, max: Self.reasonMax)
        let ms: Double
        if let expiresAt = r.expiresAt {
            ms = min(max(Double(expiresAt) - wallMs, 0), Double(Self.timeoutRange.upperBound))
        } else {
            ms = Double(min(max(r.timeoutMs, Self.timeoutRange.lowerBound), Self.timeoutRange.upperBound))
        }
        deadline = now + ms / 1000
    }

    /// Whole seconds left, rounded up (0 once it ran out).
    public func secondsLeft(now: TimeInterval) -> Int { max(0, Int((deadline - now).rounded(.up))) }

    /// "Switching in 42 s" — what happens with no answer.
    public func countdown(now: TimeInterval) -> String {
        let s = secondsLeft(now: now)
        return s > 0 ? "Switching in \(s) s" : "Switching…"
    }

    /// The user clicked a button: the first answer wins. True when this one did.
    @discardableResult
    public mutating func answer(_ a: CUDesktopPromptAnswer) -> Bool {
        guard answer == nil else { return false }
        answer = a
        return true
    }

    /// The countdown ran out with no answer: `expired`, once. True when it just did.
    @discardableResult
    public mutating func tick(now: TimeInterval) -> Bool {
        guard answer == nil, now >= deadline else { return false }
        answer = .expired
        return true
    }

    /// One display line: control, format and bidi-override characters become spaces, runs of white space one
    /// space, trimmed, cut to `max` characters with an ellipsis. Pure.
    public static func sanitize(_ s: String, max: Int) -> String {
        var out = ""
        out.reserveCapacity(min(s.count, max * 2))
        for scalar in s.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
                out.unicodeScalars.append(" ")
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        let line = out.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard line.count > max else { return line }
        return String(line.prefix(Swift.max(0, max - 1))) + "…"
    }
}

/// Shows and closes desktop-switch prompts. The shell's `prompt.desktopVisit` drives it.
@MainActor public protocol CUDesktopPrompting: AnyObject {
    /// Shows the prompt. `onAnswer` is called exactly once — `switchNow`, `refuse` or `expired` — unless the prompt is
    /// closed first. A second `show` for an open `promptId` is ignored (false).
    @discardableResult
    func show(_ request: CUDesktopPromptRequest, onAnswer: @escaping @MainActor (CUDesktopPromptAnswer) -> Void) -> Bool
    /// Closes the prompt at once (the card was answered elsewhere, or the request was cancelled). No answer is sent.
    func close(promptId: String)
}

/// One prompt's panel. Implemented by AppKit in the app; by a recorder in tests.
@MainActor protocol DesktopPromptSurface: AnyObject {
    var onSwitch: (() -> Void)? { get set }
    var onRefuse: (() -> Void)? { get set }
    /// Shows (or updates) it with this countdown, in stack `slot` (0 = the top one).
    func show(countdown: String, slot: Int)
    func close()
}

@MainActor protocol DesktopPromptSurfaceFactory {
    func make(_ model: CUDesktopPromptModel) -> DesktopPromptSurface
}

/// The live prompts: one panel each, stacked from the top of the user's screen (two sessions may ask at once),
/// each counting down on its own and answering its own `promptId`.
@MainActor public final class CUDesktopPromptController: CUDesktopPrompting {
    private struct Live {
        var model: CUDesktopPromptModel
        let surface: DesktopPromptSurface
        let onAnswer: @MainActor (CUDesktopPromptAnswer) -> Void
    }

    private let surfaces: DesktopPromptSurfaceFactory
    private let clock: CUClock
    private let ticker: CUTicker
    /// The wall clock in epoch ms (a prompt's `expiresAt` is one).
    private let wallMs: () -> Double
    private var prompts: [String: Live] = [:]
    private var order: [String] = []
    /// How often the countdowns are redrawn and checked.
    static let tickInterval: TimeInterval = 0.25

    init(surfaces: DesktopPromptSurfaceFactory, clock: CUClock, ticker: CUTicker,
         wallMs: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.surfaces = surfaces
        self.clock = clock
        self.ticker = ticker
        self.wallMs = wallMs
    }

    /// The live controller: AppKit panels, the system clock, a run-loop ticker. Draws nothing until `show`.
    public static func live() -> CUDesktopPromptController {
        CUDesktopPromptController(surfaces: AppKitDesktopPromptFactory(), clock: SystemClock(), ticker: RunLoopTicker())
    }

    /// The prompts open now, top first.
    public var openPromptIds: [String] { order }

    @discardableResult
    public func show(_ request: CUDesktopPromptRequest, onAnswer: @escaping @MainActor (CUDesktopPromptAnswer) -> Void) -> Bool {
        guard prompts[request.promptId] == nil else { return false }
        let model = CUDesktopPromptModel(request, now: clock.now, wallMs: wallMs())
        let surface = surfaces.make(model)
        let id = request.promptId
        surface.onSwitch = { [weak self] in self?.finish(id, .switchNow) }
        surface.onRefuse = { [weak self] in self?.finish(id, .refuse) }
        prompts[id] = Live(model: model, surface: surface, onAnswer: onAnswer)
        order.append(id)
        PresentationLog.notice("desktop prompt \(id): shown for \(model.appLine) (\(model.secondsLeft(now: clock.now)) s)")
        layout()
        if !ticker.isRunning {
            ticker.start(interval: Self.tickInterval) { [weak self] in self?.tick() }
        }
        return true
    }

    public func close(promptId: String) {
        guard let live = prompts.removeValue(forKey: promptId) else { return }
        order.removeAll { $0 == promptId }
        live.surface.close()
        PresentationLog.notice("desktop prompt \(promptId): closed (answered elsewhere, or cancelled)")
        afterRemoval()
    }

    /// Redraws every countdown and expires the ones that ran out. The ticker calls it; tests call it by hand.
    func tick() {
        let now = clock.now
        for id in order {
            guard var live = prompts[id] else { continue }
            if live.model.tick(now: now) {
                prompts[id] = live
                // At the deadline: "Switching…", then the answer.
                live.surface.show(countdown: live.model.countdown(now: now), slot: order.firstIndex(of: id) ?? 0)
                finish(id, .expired)
            } else {
                live.surface.show(countdown: live.model.countdown(now: now), slot: order.firstIndex(of: id) ?? 0)
            }
        }
    }

    private func finish(_ id: String, _ answer: CUDesktopPromptAnswer) {
        guard var live = prompts[id] else { return }
        // The first answer wins: a click racing the countdown's end, or a second click, does nothing more.
        if answer != .expired { guard live.model.answer(answer) else { return } }
        prompts[id] = nil
        order.removeAll { $0 == id }
        live.surface.close()
        PresentationLog.notice("desktop prompt \(id): \(answer.rawValue)")
        afterRemoval()
        live.onAnswer(answer)
    }

    private func afterRemoval() {
        layout()
        if prompts.isEmpty { ticker.stop() }
    }

    private func layout() {
        let now = clock.now
        for (slot, id) in order.enumerated() {
            guard let live = prompts[id] else { continue }
            live.surface.show(countdown: live.model.countdown(now: now), slot: slot)
        }
    }
}
