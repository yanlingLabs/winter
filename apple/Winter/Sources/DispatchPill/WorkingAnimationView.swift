import SwiftUI

// MARK: - The working animation's model (pure, ticked — `WorkingAnimationTests`)

/// The "rocket" the pill shows while Dispatch works: horizontal particles streaming left-to-right
/// like engine exhaust, with an icon at the centre that cross-fades as the work changes — the
/// running tool's symbol while a tool runs, and a slow rotation of "thinking" symbols between tools.
struct WorkingAnimationModel: Equatable {
    static let particleCount = 8
    /// Seconds for particles to stream left-to-right once.
    static let streamSeconds: Double = 1.2
    /// How long one icon takes to cross-fade into the next.
    static let crossfadeSeconds: Double = 0.35
    /// How long each "thinking" symbol holds before the next one fades in (no tool running).
    static let idleSymbolHoldSeconds: Double = 1.4
    /// The symbols the centre rotates through while the agent is thinking rather than running a tool.
    static let idleSymbols = ["sparkles", "paperplane.fill", "wand.and.stars"]
    /// A frame gap longer than this (the app was suspended, the timeline paused) is treated as this.
    static let maxStep: Double = 0.1

    /// Horizontal position of the particle stream, 0 (right) → 1 (left).
    private(set) var streamPhase: Double = 0
    /// The symbol fading IN (fully shown once `crossfade` reaches 1).
    private(set) var symbol: String
    /// The symbol fading OUT, or nil once the last cross-fade finished.
    private(set) var previousSymbol: String?
    /// 0 → 1 across a cross-fade; 1 when settled.
    private(set) var crossfade: Double = 1
    private(set) var idleIndex = 0
    private(set) var idleElapsed: Double = 0

    init(toolSymbol: String? = nil) {
        symbol = toolSymbol ?? Self.idleSymbols[0]
    }

    /// Advance by `dt` seconds. `toolSymbol` is the running tool's symbol, or nil while thinking.
    mutating func tick(dt rawDt: Double, toolSymbol: String?) {
        let dt = max(0, min(rawDt, Self.maxStep))
        streamPhase = (streamPhase + dt / Self.streamSeconds).truncatingRemainder(dividingBy: 1)

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

    /// Particles streaming horizontally left-to-right (propulsion effect).
    func particles(center: CGPoint, width: CGFloat, headDiameter: CGFloat) -> [WorkingParticle] {
        (0..<Self.particleCount).map { i in
            let fade = 1 - Double(i) / Double(Self.particleCount)
            let x = center.x + (streamPhase - Double(i) / Double(Self.particleCount)) * width
            let clampedX = x.truncatingRemainder(dividingBy: width * 2)
            return WorkingParticle(
                position: CGPoint(x: center.x - width / 2 + clampedX, y: center.y),
                opacity: 0.15 + 0.85 * fade,
                diameter: headDiameter * CGFloat(0.6 + 0.4 * fade)
            )
        }
    }
}

struct WorkingParticle: Equatable {
    let position: CGPoint
    let opacity: Double
    let diameter: CGFloat
}

/// PURE: the SF Symbol for a running tool, by the name the daemon emits (`tool_call.name`, which
/// `OrbStatus.toolRunning` carries). Matched case-insensitively — Winter's own tools are lower-snake
/// (`bash`, `read`, `task_create`) and the runtime's web tools are Claude Code's (`WebFetch`). The
/// daemon's capability servers arrive as `mcp__winter__<key>__<tool>` and are keyed on `<key>`; any
/// other MCP server's action is a connector, drawn as a package. Unknown names get a hammer — never a
/// blank centre.
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

/// The working animation: horizontal particles streaming like rocket exhaust, centre icon cross-fading.
struct WorkingAnimationView: View {
    let toolName: String?
    var diameter: CGFloat = 26
    var tint: Color = .blue
    var iconFont: Font = Typography.caption(.semibold)

    @State private var model = WorkingAnimationModel()
    @State private var lastTick: Date?

    private var toolSymbol: String? { toolName.map(workingToolSymbol(for:)) }

    var body: some View {
        TimelineView(.animation) { timeline in
            ZStack {
                Canvas { context, size in
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let head = max(2, size.width * 0.15)
                    for particle in model.particles(center: center, width: size.width * 1.2, headDiameter: head) {
                        let r = particle.diameter / 2
                        let rect = CGRect(x: particle.position.x - r, y: particle.position.y - r,
                                          width: particle.diameter, height: particle.diameter)
                        context.fill(Path(ellipseIn: rect), with: .color(tint.opacity(particle.opacity)))
                    }
                }
                if let previous = model.previousSymbol {
                    Image(systemName: previous)
                        .opacity(model.previousSymbolOpacity)
                }
                Image(systemName: model.symbol)
                    .opacity(model.symbolOpacity)
            }
            .font(iconFont)
            .foregroundStyle(Color.blue)
            .onChange(of: timeline.date) { _, now in step(now) }
        }
        .frame(width: diameter, height: diameter)
        .accessibilityLabel("Working")
    }

    private func step(_ now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now
        model.tick(dt: dt, toolSymbol: toolSymbol)
    }
}
