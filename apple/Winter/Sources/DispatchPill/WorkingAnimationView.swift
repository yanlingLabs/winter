import SwiftUI

// MARK: - The working animation's model (pure, ticked — `WorkingAnimationTests`)

/// What the pill shows while Dispatch works: a sideways rocket plume. Flat blue puffs leave a nozzle
/// at the trailing end (behind the stop button) big, bunched and white-hot, and stream toward the
/// leading end, cooling to deep blue, spreading out and shrinking away; a few small sparks shoot
/// through faster. At the leading end, the running tool's icon cross-fades as the work changes, and
/// a slow rotation of "thinking" symbols shows between tools.
///
/// A value type advanced by `tick(dt:toolSymbol:)` rather than SwiftUI implicit animation, so its
/// whole behaviour (the plume's flow, the cross-fade timing, the idle rotation) is unit-testable
/// without a render loop. The view holds one in `@State` and ticks it off a `TimelineView` — the same
/// local-animation-state convention `DispatchParticleField` and `WinterFieldView`'s spinner follow.
struct WorkingAnimationModel: Equatable {
    /// How long one icon takes to cross-fade into the next.
    static let crossfadeSeconds: Double = 0.35
    /// How long each "thinking" symbol holds before the next one fades in (no tool running).
    static let idleSymbolHoldSeconds: Double = 1.4
    /// The symbols the leading icon rotates through while the agent is thinking rather than running
    /// a tool.
    static let idleSymbols = ["sparkles", "paperplane.fill", "wand.and.stars"]
    /// A frame gap longer than this (the app was suspended, the timeline paused) is treated as this —
    /// the plume never empties or bursts on resume.
    static let maxStep: Double = 0.1

    private(set) var plume: PropulsionPlume
    /// The symbol fading IN (fully shown once `crossfade` reaches 1).
    private(set) var symbol: String
    /// The symbol fading OUT, or nil once the last cross-fade finished.
    private(set) var previousSymbol: String?
    /// 0 → 1 across a cross-fade; 1 when settled.
    private(set) var crossfade: Double = 1
    private(set) var idleIndex = 0
    private(set) var idleElapsed: Double = 0

    /// The plume starts already full (pre-warmed), so it never visibly "fills up" when the working
    /// pill appears.
    init(toolSymbol: String? = nil, seed: UInt64 = PropulsionPlume.defaultSeed) {
        symbol = toolSymbol ?? Self.idleSymbols[0]
        plume = PropulsionPlume(seed: seed, prewarmed: true)
    }

    /// Advance by `dt` seconds. `toolSymbol` is the running tool's symbol (`workingToolSymbol(for:)`),
    /// or nil while the agent is thinking between tools. `animatesPlume` false (Reduce Motion) holds
    /// the plume still and keeps only the icon's cross-fade.
    mutating func tick(dt rawDt: Double, toolSymbol: String?, animatesPlume: Bool = true) {
        let dt = max(0, min(rawDt, Self.maxStep))
        if animatesPlume { plume.advance(dt: dt) }

        let target: String
        if let toolSymbol {
            target = toolSymbol
            idleElapsed = 0
        } else {
            idleElapsed += dt
            if idleElapsed >= Self.idleSymbolHoldSeconds {
                idleElapsed -= Self.idleSymbolHoldSeconds
                idleIndex = (idleIndex + 1) % Self.idleSymbols.count
            }
            target = Self.idleSymbols[idleIndex]
        }

        if target != symbol {
            // A change mid-fade restarts the fade from the symbol that was arriving: the one leaving
            // is whatever was most visible, never a symbol that had already gone.
            previousSymbol = symbol
            symbol = target
            crossfade = 0
        } else if crossfade < 1 {
            crossfade = min(1, crossfade + dt / Self.crossfadeSeconds)
            if crossfade >= 1 { previousSymbol = nil }
        }
    }

    /// The arriving symbol's opacity.
    var symbolOpacity: Double { crossfade }
    /// The leaving symbol's opacity (0 once it has gone).
    var previousSymbolOpacity: Double { previousSymbol == nil ? 0 : 1 - crossfade }
}

/// The plume itself: puffs (and sparks) born at the nozzle, aging until they reach the tail. Kept in
/// normalised terms — age, a vertical lane, a size factor — and laid out into a rect only when drawn
/// (`circles(in:emitterX:tailX:)`), so the same plume draws at any size: the pill, the full-screen
/// header, a child pill.
struct PropulsionPlume: Equatable {
    struct Puff: Equatable {
        var age: Double
        let lifetime: Double
        /// Where across the plume it drifts to, -1 (top) … 1 (bottom).
        let lane: Double
        /// This puff's own size, as a share of the nozzle's.
        let size: Double
        /// A spark: small, hot, and quicker down the plume than a puff.
        let spark: Bool
    }

    static let defaultSeed: UInt64 = 0x9E37_79B9_7F4A_7C15
    static let puffsPerSecond: Double = 34
    static let sparksPerSecond: Double = 6
    static let puffLifetime: ClosedRange<Double> = 0.95...1.3
    static let sparkLifetime: ClosedRange<Double> = 0.45...0.65
    static let puffSize: ClosedRange<Double> = 0.78...1.0
    /// The nozzle's puff diameter, as a share of the plume's height.
    static let nozzleDiameterShare: Double = 0.9
    static let sparkDiameterShare: Double = 0.14
    /// How much of its size a puff has lost by the time it reaches the tail.
    static let shrinkAlongPlume: Double = 0.62
    /// The last share of a puff's life over which it shrinks away to nothing (never a pop).
    static let vanishShare: Double = 0.16
    /// How sharply a puff speeds up down the plume: >1 is slow at the nozzle (where they bunch) and
    /// fast at the tail (where they thin out) — what reads as thrust.
    static let travelExponent: Double = 1.7

    private(set) var puffs: [Puff] = []
    private var puffDebt: Double = 0
    private var sparkDebt: Double = 0
    private var rng: SplitMix64

    init(seed: UInt64 = Self.defaultSeed, prewarmed: Bool = false) {
        rng = SplitMix64(seed: seed)
        guard prewarmed else { return }
        // Long enough that the oldest puff alive has reached the tail: a steady-state plume.
        for _ in 0..<Int(Self.puffLifetime.upperBound * 60) + 1 { advance(dt: 1.0 / 60.0) }
    }

    mutating func advance(dt: Double) {
        guard dt > 0 else { return }
        for i in puffs.indices { puffs[i].age += dt }
        puffs.removeAll { $0.age >= $0.lifetime }
        puffDebt += dt * Self.puffsPerSecond
        while puffDebt >= 1 {
            puffDebt -= 1
            // Born part-way through the step, so a frame's puffs never leave in a clump.
            spawn(age: puffDebt / Self.puffsPerSecond, spark: false)
        }
        sparkDebt += dt * Self.sparksPerSecond
        while sparkDebt >= 1 {
            sparkDebt -= 1
            spawn(age: sparkDebt / Self.sparksPerSecond, spark: true)
        }
    }

    private mutating func spawn(age: Double, spark: Bool) {
        let lifetime = rng.next(in: spark ? Self.sparkLifetime : Self.puffLifetime)
        let lane = rng.next(in: -1...1)
        let size = spark ? 1 : rng.next(in: Self.puffSize)
        puffs.append(Puff(age: min(age, lifetime * 0.5), lifetime: lifetime, lane: lane, size: size, spark: spark))
    }

    /// Every puff laid out in `rect`: born at `emitterX` (the nozzle, on the rect's mid line),
    /// dying at `tailX`. Oldest first, so the newest — biggest, hottest, at the nozzle — draws on
    /// top, and sparks after all the puffs of their age.
    func circles(in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> [PlumeCircle] {
        puffs.map { Self.circle(for: $0, in: rect, emitterX: emitterX, tailX: tailX) }
            .filter { $0.diameter > 0.25 }
    }

    /// PURE: one puff's circle. `progress` (age / lifetime) drives everything: how far down the plume
    /// it is, how big, how far it has spread from the mid line, how hot.
    static func circle(for puff: Puff, in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> PlumeCircle {
        let p = min(max(puff.age / puff.lifetime, 0), 1)
        let travel = puff.spark ? p : pow(p, travelExponent)
        let x = Double(emitterX) - travel * Double(emitterX - tailX)
        let height = Double(rect.height)
        var diameter = puff.spark
            ? height * sparkDiameterShare * (1 - 0.5 * p)
            : height * nozzleDiameterShare * puff.size * (1 - shrinkAlongPlume * p)
        diameter *= min(1, (1 - p) / vanishShare)
        // Free room either side of the mid line, used more the further the puff has travelled.
        let slack = max(0, (height - diameter) / 2)
        let y = Double(rect.midY) + puff.lane * slack * min(1, p * 3)
        return PlumeCircle(center: CGPoint(x: x, y: y), diameter: CGFloat(max(0, diameter)),
                           heat: puff.spark ? 1 : 1 - p, spark: puff.spark)
    }
}

struct PlumeCircle: Equatable {
    let center: CGPoint
    let diameter: CGFloat
    /// 1 at the nozzle (white-hot), 0 at the tail (deep blue).
    let heat: Double
    let spark: Bool
}

/// PURE: the plume's colour for a heat — three stops, deep vivid blue at the tail, the system's
/// bright blue through the body, a near-white blue at the nozzle.
func plumeColorComponents(heat: Double) -> (red: Double, green: Double, blue: Double) {
    let stops: [(Double, (Double, Double, Double))] = [
        (0.0, (0.05, 0.33, 1.0)),
        (0.55, (0.16, 0.55, 1.0)),
        (1.0, (0.80, 0.93, 1.0)),
    ]
    let h = min(max(heat, 0), 1)
    for (a, b) in zip(stops, stops.dropFirst()) where h <= b.0 {
        let t = (h - a.0) / (b.0 - a.0)
        return (a.1.0 + (b.1.0 - a.1.0) * t,
                a.1.1 + (b.1.1 - a.1.1) * t,
                a.1.2 + (b.1.2 - a.1.2) * t)
    }
    return stops[stops.count - 1].1
}

/// A tiny deterministic generator, so a plume (and its tests) are reproducible from a seed.
struct SplitMix64: Equatable {
    private var state: UInt64
    init(seed: UInt64) { state = seed }

    mutating func nextUInt64() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Uniform in `range`.
    mutating func next(in range: ClosedRange<Double>) -> Double {
        let unit = Double(nextUInt64() >> 11) / Double(1 << 53)
        return range.lowerBound + unit * (range.upperBound - range.lowerBound)
    }
}

/// PURE: the SF Symbol for a running tool, by the name the daemon emits (`tool_call.name`, which
/// `OrbStatus.toolRunning` carries). Matched case-insensitively — Winter's own tools are lower-snake
/// (`bash`, `read`, `task_create`) and the runtime's web tools are Claude Code's (`WebFetch`). The
/// daemon's capability servers arrive as `mcp__winter__<key>__<tool>` and are keyed on `<key>`; any
/// other MCP server's action is a connector, drawn as a package. Unknown names get a hammer — never a
/// blank icon.
func workingToolSymbol(for rawName: String) -> String {
    let name = rawName.lowercased()
    if name.hasPrefix("mcp__") {
        let parts = name.components(separatedBy: "__")
        guard parts.count >= 3, parts[1] == "winter" else { return "shippingbox" }
        switch parts[2] {
        case "browser": return "globe"
        case "computer": return "cursorarrow.rays"
        case "office": return "doc.text"
        case "sessions": return "person.2.fill"
        case "research": return "magnifyingglass"
        case "lsp": return "chevron.left.forwardslash.chevron.right"
        default: return "shippingbox"
        }
    }
    switch name {
    case "bash": return "terminal"
    case "read", "ls": return "doc.text"
    case "write", "edit", "multiedit", "notebook_edit": return "pencil"
    case "glob", "grep": return "text.magnifyingglass"
    case "webfetch", "web_fetch", "readpage": return "safari"
    case "websearch", "web_search", "search", "browser": return "globe"
    case "computer": return "cursorarrow.rays"
    case "lsp": return "chevron.left.forwardslash.chevron.right"
    case "task_create", "task_update", "task_list", "todowrite": return "checklist"
    case "spawn_agent", "task", "agent": return "person.2.fill"
    case "session_spawn": return "paperplane.fill"
    case "workflow": return "bolt.fill"
    case "ask_user", "askquestion": return "questionmark.bubble"
    case "skill", "toolsearch": return "wand.and.stars"
    default: return "hammer.fill"
    }
}

/// The running tool's name off the session status, or nil while thinking (or idle).
func workingToolName(_ status: OrbStatus) -> String? {
    if case .toolRunning(let name) = status { return name }
    return nil
}

// MARK: - The view

/// The working animation, filling whatever frame it is given: the plume streams from a nozzle
/// `emitterInset` in from the trailing edge (by default half the height — the centre of a round
/// trailing button the height of the frame, which is where the pill's stop button sits) toward the
/// leading end, where the tool icon cross-fades (`showsIcon`). `toolName` nil means "thinking".
struct WorkingAnimationView: View {
    let toolName: String?
    var showsIcon = true
    var emitterInset: CGFloat?
    var iconFont: Font = Typography.label(.semibold)

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = WorkingAnimationModel()
    @State private var lastTick: Date?

    private var toolSymbol: String? { toolName.map(workingToolSymbol(for:)) }

    var body: some View {
        TimelineView(.animation) { timeline in
            GeometryReader { proxy in
                let height = proxy.size.height
                ZStack(alignment: .leading) {
                    plume
                    if showsIcon {
                        icon.frame(width: height, height: height)
                    }
                }
            }
            .onChange(of: timeline.date) { _, now in step(now) }
        }
        .accessibilityElement()
        .accessibilityLabel("Working")
    }

    private var plume: some View {
        let model = self.model
        let showsIcon = self.showsIcon
        let emitterInset = self.emitterInset
        return Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            let emitterX = size.width - (emitterInset ?? size.height / 2)
            let tailX = showsIcon ? size.height * 1.15 : size.height * 0.3
            let circles = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)

            // A soft glow under everything, added rather than painted, so the bunched nozzle
            // blooms brightest.
            context.drawLayer { glow in
                glow.addFilter(.blur(radius: size.height * 0.22))
                glow.blendMode = .plusLighter
                glow.opacity = 0.55
                for circle in circles where !circle.spark {
                    glow.fill(Self.disc(circle, scale: 1.15), with: .color(Self.color(heat: circle.heat)))
                }
            }
            // The puffs themselves — flat colour, no outline.
            for circle in circles where !circle.spark {
                context.fill(Self.disc(circle), with: .color(Self.color(heat: circle.heat)))
            }
            for circle in circles where circle.spark {
                context.fill(Self.disc(circle), with: .color(Self.color(heat: 1).opacity(0.95)))
            }
        }
    }

    private var icon: some View {
        ZStack {
            if let previous = model.previousSymbol {
                Image(systemName: previous)
                    .opacity(model.previousSymbolOpacity)
            }
            Image(systemName: model.symbol)
                .opacity(model.symbolOpacity)
        }
        .font(iconFont)
        .foregroundStyle(Color.white.opacity(0.92))
    }

    private static func disc(_ circle: PlumeCircle, scale: CGFloat = 1) -> Path {
        let d = circle.diameter * scale
        return Path(ellipseIn: CGRect(x: circle.center.x - d / 2, y: circle.center.y - d / 2, width: d, height: d))
    }

    private static func color(heat: Double) -> Color {
        let c = plumeColorComponents(heat: heat)
        return Color(red: c.red, green: c.green, blue: c.blue)
    }

    private func step(_ now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now
        model.tick(dt: dt, toolSymbol: toolSymbol, animatesPlume: !reduceMotion)
    }
}
