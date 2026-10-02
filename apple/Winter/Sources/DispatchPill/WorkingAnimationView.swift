import SwiftUI

// MARK: - The working animation's model (pure, ticked — `WorkingAnimationTests`)

/// What the pill shows while Dispatch works: a sideways rocket plume filling the pill. Flat puffs
/// leave a nozzle at the trailing end (behind the stop button) big, bunched and white-hot, and
/// stream toward the leading end, cooling, spreading out and shrinking away; a few small sparks
/// shoot through faster. Every tool Dispatch uses is THROWN out of the nozzle as a small rounded
/// tile — its symbol on its own colour, or, for the web, each site's favicon on white — and rides the
/// plume down, tumbling and shrinking away like the rest of the exhaust.
///
/// A value type advanced by `tick(dt:thrown:)` rather than SwiftUI implicit animation, so its whole
/// behaviour (the plume's flow, which throws leave and when) is unit-testable without a render loop.
/// The view holds one in `@State` and ticks it off a `TimelineView` — the same local-animation-state
/// convention `DispatchParticleField` and `WinterFieldView`'s spinner follow.
struct WorkingAnimationModel: Equatable {
    /// A frame gap longer than this (the app was suspended, the timeline paused) is treated as this —
    /// the plume never empties or bursts on resume.
    static let maxStep: Double = 0.1
    /// The least time between two throws, so a burst of tool calls leaves the nozzle one by one.
    static let throwSpacing: Double = 0.22
    /// The most throws waiting their turn at the nozzle; past it the oldest waiting are dropped (a
    /// round that is still running repeats its throws anyway, so nothing it found is lost for long).
    static let maxQueuedThrows = 24
    /// While a tool round runs and nothing new is waiting, its throws leave again, one every this.
    static let repeatSpacing: Double = 0.4

    private(set) var plume: PropulsionPlume
    /// Throws seen but not yet launched, oldest first.
    private(set) var queued: [PlumeThrow] = []
    /// Every throw id this plume has seen — launched, queued, or (on the first tick) already done
    /// before the plume appeared.
    private var seen: Set<String> = []
    private var primed = false
    private var sinceLastThrow: Double = .infinity
    private var repeatCursor = 0

    /// The plume starts already full (pre-warmed), so it never visibly "fills up" when the working
    /// pill appears.
    init(seed: UInt64 = PropulsionPlume.defaultSeed) {
        plume = PropulsionPlume(seed: seed, prewarmed: true)
    }

    /// Advance by `dt` seconds. `thrown` is the turn's tool uses so far (`plumeThrows(for:)`); any
    /// not seen before is queued and leaves the nozzle at the next free slot. What was already in the
    /// list on the FIRST tick happened before this plume appeared (the pill was summoned mid-turn),
    /// and is not thrown — no burst of stale tiles. `repeating` is the CURRENT tool round's throws
    /// (`plumeRepeatingThrows(for:)`): while it is non-empty and nothing new waits, they leave again in
    /// turn, so a running round keeps streaming its tools and sites until it ends. `animatesPlume`
    /// false (Reduce Motion) holds the plume still and throws nothing.
    mutating func tick(dt rawDt: Double, thrown incoming: [PlumeThrow] = [], repeating: [PlumeThrow] = [],
                       animatesPlume: Bool = true) {
        let dt = max(0, min(rawDt, Self.maxStep))
        if !primed {
            primed = true
            seen = Set(incoming.map(\.id))
        } else {
            for item in incoming where seen.insert(item.id).inserted { queued.append(item) }
            if queued.count > Self.maxQueuedThrows { queued.removeFirst(queued.count - Self.maxQueuedThrows) }
        }
        guard animatesPlume else { return }
        plume.advance(dt: dt)
        sinceLastThrow += dt
        if !queued.isEmpty {
            guard sinceLastThrow >= Self.throwSpacing else { return }
            plume.launch(queued.removeFirst())
            sinceLastThrow = 0
        } else if !repeating.isEmpty, sinceLastThrow >= Self.repeatSpacing {
            plume.launch(repeating[repeatCursor % repeating.count])
            repeatCursor = (repeatCursor + 1) % repeating.count
            sinceLastThrow = 0
        } else if repeating.isEmpty {
            repeatCursor = 0
        }
    }
}

/// One thing thrown out of the plume: a tool's tile, or a site's favicon. `id` is stable across
/// renders (the tool call's id, plus the host for a site), so each is thrown exactly once.
struct PlumeThrow: Equatable, Hashable {
    enum Kind: Equatable, Hashable {
        /// A tool: its SF Symbol (`workingToolSymbol(for:)`) on its own colour (`plumeToolTileColor`).
        case tool(symbol: String)
        /// A website the agent read or found: its favicon on white. `iconURL` is the icon the TOOL
        /// reported for it (`tool_result.siteIcons` — Exa's `favicon`, or the fetched page's own
        /// declared icon); nil when none was reported, and `FaviconCache` then tries the host's
        /// `/favicon.ico` once.
        case site(host: String, iconURL: String? = nil)
    }
    let id: String
    let kind: Kind
}

/// PURE: what an exchange's tool uses throw, in order. Each tool call throws its tile when it is
/// made; a web tool then throws the sites in its RESULT when the result arrives — a search up to
/// `plumeSitesPerSearch` of them, a fetch its one page (a failed fetch, none). A site is drawn from
/// the icon the result's `siteIcons` names for it; a result without them (an older daemon or
/// runtime, a source Exa had no favicon for) falls back to the hosts in the output (a search) or the
/// fetched url (a fetch), with no icon url. A fetch's site waits for its result because that is when
/// the page — and the icon it declares — arrives; thrown at the call, its tile would be gone long
/// before. The last `plumeThrowWindow` only — older ones were thrown long ago.
func plumeThrows(for exchange: Exchange?) -> [PlumeThrow] {
    guard let exchange else { return [] }
    return Array(plumeThrows(in: exchange.activity, from: 0).suffix(plumeThrowWindow))
}

/// PURE: the CURRENT tool round's throws — every tool call from the earliest one still running to
/// the end of the exchange, with whatever its finished calls found — or nothing once every call has
/// returned. A round of twenty searches therefore keeps streaming its sites for as long as any of
/// them is still out, and stops when the round is over.
func plumeRepeatingThrows(for exchange: Exchange?) -> [PlumeThrow] {
    guard let exchange,
          let start = exchange.activity.firstIndex(where: {
              if case let .tool(_, _, _, output, _, _, _) = $0.kind { return output == nil }
              return false
          }) else { return [] }
    return Array(plumeThrows(in: exchange.activity, from: start).suffix(plumeThrowWindow))
}

private func plumeThrows(in activity: [ActivityItem], from start: Int) -> [PlumeThrow] {
    var out: [PlumeThrow] = []
    for (index, item) in activity.enumerated() where index >= start {
        guard case let .tool(name, detail, callId, output, isError, _, siteIcons) = item.kind else { continue }
        let base = callId ?? "activity-\(index)"
        let lowered = name.lowercased()
        out.append(PlumeThrow(id: base, kind: .tool(symbol: workingToolSymbol(for: name))))
        guard let output else { continue }
        var sites = plumeSites(siteIcons)
        if plumeFetchToolNames.contains(lowered) {
            guard !isError else { continue }
            if sites.isEmpty, let host = detail.flatMap(plumeHosts(in:))?.first { sites = [(host, nil)] }
            sites = Array(sites.prefix(1))
        } else if plumeIsSearchTool(lowered) {
            // Every source the output names, in order, each with its reported icon when there is
            // one (Exa omits `favicon` for some); then any reported site the text did not name.
            let reported = sites
            let named = plumeHosts(in: output)
            sites = named.map { host in (host, reported.first { $0.host == host }?.iconURL) }
                + reported.filter { site in !named.contains(site.host) }
        } else {
            continue
        }
        for site in sites.prefix(plumeSitesPerSearch) {
            out.append(PlumeThrow(id: base + "#" + site.host, kind: .site(host: site.host, iconURL: site.iconURL)))
        }
    }
    return out
}

/// PURE: a result's `siteIcons` as plume sites — one per public page host, in order. An icon url
/// that is not https to a public host is dropped (the site then falls back to `/favicon.ico`).
func plumeSites(_ icons: [SiteIconRef]) -> [(host: String, iconURL: String?)] {
    var seen: Set<String> = []
    var out: [(host: String, iconURL: String?)] = []
    for icon in icons {
        guard let host = URL(string: icon.url)?.host?.lowercased(), plumeFaviconHostAllowed(host),
              seen.insert(host).inserted else { continue }
        out.append((host, plumeIconURLAllowed(icon.iconUrl) ? icon.iconUrl : nil))
    }
    return out
}

/// PURE: the key a site tile's favicon is filed under for one frame — the url actually fetched for it
/// (`faviconRequestURL`), so two tiles for one host with different reported icons never swap.
func plumeFaviconKey(host: String, iconURL: String?) -> String {
    faviconRequestURL(host: host, iconURL: iconURL)?.absoluteString ?? host
}

/// PURE: an icon url the pill may fetch — https, to a public name (`plumeFaviconHostAllowed`).
func plumeIconURLAllowed(_ string: String) -> Bool {
    guard let url = URL(string: string), url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased() else { return false }
    return plumeFaviconHostAllowed(host)
}

/// Every source a search names is thrown — the cap only bounds a pathological result (`siteIcons`
/// itself is capped at 10; a `Search` cites up to 20).
let plumeSitesPerSearch = 20
let plumeThrowWindow = 200
let plumeFetchToolNames: Set<String> = ["webfetch", "web_fetch", "readpage"]

/// `search` is the agent SDK's `Search` built-in (Exa answer mode) since 2026-10-01; an old transcript's
/// row for the daemon's retired copy may still carry its MCP name, `mcp__winter__research__Search`.
func plumeIsSearchTool(_ lowered: String) -> Bool {
    ["websearch", "web_search", "search"].contains(lowered) || lowered.hasPrefix("mcp__winter__research__")
}

/// PURE: the distinct hosts of the http(s) urls in `text`, in order of first appearance — only
/// public-looking names (`plumeFaviconHostAllowed`), since each one is asked for its favicon.
func plumeHosts(in text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #"https?://([A-Za-z0-9.-]+)"#) else { return [] }
    var seen: Set<String> = []
    var hosts: [String] = []
    let range = NSRange(text.startIndex..., in: text)
    for match in regex.matches(in: text, range: range) {
        guard let r = Range(match.range(at: 1), in: text) else { continue }
        let host = text[r].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard plumeFaviconHostAllowed(host), seen.insert(host).inserted else { continue }
        hosts.append(host)
    }
    return hosts
}

/// Name suffixes that conventionally stay on the user's own network (mDNS, home routers, corporate
/// split-horizon DNS). Matched by name only — the pill resolves nothing itself. Kept in step with the
/// agent SDK's `isPublicName` (`tools/impl/_site-icons.ts`).
let plumePrivateNameSuffixes = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".private"]

/// PURE: a host whose favicon the pill may fetch — a dotted DNS name, never an IP literal, never
/// `localhost` or a name under `plumePrivateNameSuffixes`: the pill must not go poking the user's own
/// network because a url appeared in a tool's output.
func plumeFaviconHostAllowed(_ host: String) -> Bool {
    guard host.contains("."), host.count <= 253, !host.hasPrefix("-") else { return false }
    if host == "localhost" || plumePrivateNameSuffixes.contains(where: { host.hasSuffix($0) }) { return false }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard let tld = labels.last, tld.contains(where: \.isLetter) else { return false } // 10.0.0.1 and friends
    return labels.allSatisfy { !$0.isEmpty && $0.count <= 63 }
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
    /// How much of its size a puff has lost by the time it reaches the tail. The shrink is by
    /// DISTANCE travelled, so it is the same rate the whole way down the pill (shrinking by age, plus a
    /// last-moment vanish, made puffs collapse in the final stretch, where they move fastest).
    static let shrinkAlongPlume: Double = 0.5
    /// How far past the plume's leading edge its tail lies, as a share of its height — far enough that
    /// every puff and thrown item has wholly left the pill before it is dropped, so nothing ever pops
    /// out of sight in view.
    static let tailOvershootShare: Double = 0.32

    /// The tail for a plume this high whose leading edge is at x = 0.
    static func tailX(height: CGFloat) -> CGFloat { -height * CGFloat(tailOvershootShare) }
    /// How sharply a puff speeds up down the plume: >1 is slow at the nozzle (where they bunch) and
    /// fast at the tail (where they thin out) — what reads as thrust.
    static let travelExponent: Double = 1.7

    /// A thrown item riding the plume (`launch(_:)`).
    struct Token: Equatable {
        var age: Double
        let lifetime: Double
        let lane: Double
        let item: PlumeThrow
    }

    static let tokenLifetime: ClosedRange<Double> = 1.6...1.9
    /// A thrown item's diameter at the nozzle, as a share of the plume's height.
    static let tokenSideShare: Double = 0.56
    /// How much of its size a TOOL puff has lost by the tail (a site keeps its size the whole way).
    static let tokenShrinkAlongPlume: Double = 0.5
    /// The first share of its life over which an item grows out of the nozzle.
    static let tokenEmergeShare: Double = 0.08
    /// Thrown items slow at the nozzle like the puffs, but less — they are flung, not blown.
    static let tokenTravelExponent: Double = 1.35

    private(set) var puffs: [Puff] = []
    private(set) var tokens: [Token] = []
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
        for i in tokens.indices { tokens[i].age += dt }
        tokens.removeAll { $0.age >= $0.lifetime }
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

    /// Throw `item` out of the nozzle now.
    mutating func launch(_ item: PlumeThrow) {
        tokens.append(Token(age: 0, lifetime: rng.next(in: Self.tokenLifetime), lane: rng.next(in: -0.85...0.85),
                            item: item))
    }

    /// Every riding tile laid out in `rect`, oldest first (the newest, nearest the nozzle, on top).
    func tiles(in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> [PlumeTile] {
        tokens.map { Self.tile(for: $0, in: rect, emitterX: emitterX, tailX: tailX) }.filter { $0.side > 0.5 }
    }

    /// PURE: one thrown item's disc. Both kinds grow out of the nozzle over `tokenEmergeShare` of their
    /// life and drift to their lane. A TOOL is a puff of the plume itself — it shrinks (by distance,
    /// like the exhaust) and cools. A SITE keeps its size the whole way. Both ride out past the pill's
    /// leading edge (`tailX`), which clips them, before they are dropped.
    static func tile(for token: Token, in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> PlumeTile {
        let p = min(max(token.age / token.lifetime, 0), 1)
        let travel = pow(p, tokenTravelExponent)
        let x = Double(emitterX) - travel * Double(emitterX - tailX)
        let height = Double(rect.height)
        var side = height * tokenSideShare * min(1, 0.35 + 0.65 * p / tokenEmergeShare)
        if case .tool = token.item.kind {
            side *= 1 - tokenShrinkAlongPlume * travel
        }
        let slack = max(0, (height - side) / 2)
        let y = Double(rect.midY) + token.lane * slack * min(1, p * 2.5)
        return PlumeTile(center: CGPoint(x: x, y: y), side: CGFloat(max(0, side)), heat: 1 - p, item: token.item)
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
        let diameter = puff.spark
            ? height * sparkDiameterShare * (1 - 0.5 * travel)
            : height * nozzleDiameterShare * puff.size * (1 - shrinkAlongPlume * travel)
        // Free room either side of the mid line, used more the further the puff has travelled.
        let slack = max(0, (height - diameter) / 2)
        let y = Double(rect.midY) + puff.lane * slack * min(1, p * 3)
        return PlumeCircle(center: CGPoint(x: x, y: y), diameter: CGFloat(max(0, diameter)),
                           heat: puff.spark ? 1 : 1 - p, spark: puff.spark)
    }
}

/// A thrown item's disc, laid out: centre, diameter (`side`), and how hot it still is (1 at the
/// nozzle, 0 at the tail) — a tool puff cools like the exhaust around it.
struct PlumeTile: Equatable {
    let center: CGPoint
    let side: CGFloat
    let heat: Double
    let item: PlumeThrow
}

struct PlumeCircle: Equatable {
    let center: CGPoint
    let diameter: CGFloat
    /// 1 at the nozzle (white-hot), 0 at the tail (deep blue).
    let heat: Double
    let spark: Bool
}

/// A plume's three colour stops: deep at the tail, vivid through the body, near-white at the nozzle.
/// Dispatch's own plume is `.blue`; each child session's pill gets one of `childPalettes`, so the
/// row above the pill reads as separate engines at a glance.
struct PlumePalette: Equatable {
    typealias RGB = (red: Double, green: Double, blue: Double)
    let tail: RGB
    let body: RGB
    let hot: RGB

    static func == (a: PlumePalette, b: PlumePalette) -> Bool {
        a.tail == b.tail && a.body == b.body && a.hot == b.hot
    }

    static let blue = PlumePalette(tail: (0.05, 0.33, 1.0), body: (0.16, 0.55, 1.0), hot: (0.80, 0.93, 1.0))
    static let violet = PlumePalette(tail: (0.36, 0.12, 0.92), body: (0.64, 0.40, 1.0), hot: (0.93, 0.87, 1.0))
    static let mint = PlumePalette(tail: (0.0, 0.50, 0.46), body: (0.15, 0.84, 0.70), hot: (0.82, 1.0, 0.94))
    static let rose = PlumePalette(tail: (0.82, 0.08, 0.40), body: (1.0, 0.36, 0.60), hot: (1.0, 0.87, 0.92))
    static let ember = PlumePalette(tail: (0.88, 0.30, 0.0), body: (1.0, 0.60, 0.12), hot: (1.0, 0.94, 0.72))
    static let lime = PlumePalette(tail: (0.28, 0.58, 0.0), body: (0.58, 0.88, 0.18), hot: (0.92, 1.0, 0.78))
    static let gold = PlumePalette(tail: (0.72, 0.50, 0.0), body: (1.0, 0.82, 0.16), hot: (1.0, 0.97, 0.80))
    static let orchid = PlumePalette(tail: (0.62, 0.0, 0.66), body: (0.90, 0.30, 0.92), hot: (1.0, 0.86, 1.0))

    /// The children's palettes, in the order the row hands them out — none of them Dispatch's blue,
    /// enough that a wide row (`childPillLayout` at the typing pill's width) never repeats one.
    static let childPalettes: [PlumePalette] = [.violet, .mint, .rose, .ember, .lime, .gold, .orchid]

    /// The palette for the child at `index` in the dispatch session's roster (spawn order): the row's
    /// visible pills never share a colour.
    static func child(at index: Int) -> PlumePalette {
        childPalettes[((index % childPalettes.count) + childPalettes.count) % childPalettes.count]
    }

    var bodyColor: Color { Color(red: body.red, green: body.green, blue: body.blue) }
}

/// PURE: the plume's colour for a heat — the palette's tail at 0, its body through the middle, its
/// near-white hot stop at the nozzle.
func plumeColorComponents(heat: Double, palette: PlumePalette = .blue) -> (red: Double, green: Double, blue: Double) {
    let stops: [(Double, (Double, Double, Double))] = [
        (0.0, palette.tail),
        (0.55, palette.body),
        (1.0, palette.hot),
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
        case "browser": return "safari"
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
    // A GLOBE is reserved for a website the plume throws whose favicon is missing — no tool wears
    // one, or a search's own puff reads as one of its sites (the user's mix-up, 2026-10-02).
    case "websearch", "web_search", "search": return "magnifyingglass"
    case "browser": return "safari"
    case "computer": return "cursorarrow.rays"
    case "lsp": return "chevron.left.forwardslash.chevron.right"
    case "task_create", "task_update", "task_list", "todowrite": return "checklist"
    case "spawn_agent", "task", "agent": return "person.2.fill"
    // The daemon's sessions tools arrive under their host names (`session_spawn`, …); the plain names
    // the model calls them by since 2026-10-01 (`SpawnSession`, …) are accepted too.
    case "session_spawn", "spawnsession": return "paperplane.fill"
    case "list_sessions", "listsessions", "manage_session", "managesession": return "person.2.fill"
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
/// trailing button the height of the frame, which is where the pill's stop button sits) all the way
/// to the leading end, and `thrown` items leave the nozzle as tiles riding it.
struct WorkingAnimationView: View {
    var thrown: [PlumeThrow] = []
    /// The current tool round's throws (`plumeRepeatingThrows`), streamed again while it runs.
    var repeating: [PlumeThrow] = []
    var emitterInset: CGFloat?
    var palette: PlumePalette = .blue

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model: WorkingAnimationModel
    @State private var lastTick: Date?

    /// `initialModel` starts the plume from a model already run forward (offscreen renders); the app
    /// never passes one.
    init(thrown: [PlumeThrow] = [], repeating: [PlumeThrow] = [], emitterInset: CGFloat? = nil,
         palette: PlumePalette = .blue, initialModel: WorkingAnimationModel? = nil) {
        self.thrown = thrown
        self.repeating = repeating
        self.emitterInset = emitterInset
        self.palette = palette
        _model = State(initialValue: initialModel ?? WorkingAnimationModel())
    }

    var body: some View {
        TimelineView(.animation) { timeline in
            plume
                .onChange(of: timeline.date) { _, now in step(now) }
        }
        .accessibilityElement()
        .accessibilityLabel("Working")
    }

    private var plume: some View {
        let model = self.model
        let emitterInset = self.emitterInset
        let palette = self.palette
        // Favicons are looked up HERE, on the main actor, for the tiles riding right now; the
        // Canvas below only draws what it is handed.
        var favicons: [String: NSImage] = [:]
        for token in model.plume.tokens {
            if case .site(let host, let iconURL) = token.item.kind,
               let image = FaviconCache.shared.image(host: host, iconURL: iconURL) {
                favicons[plumeFaviconKey(host: host, iconURL: iconURL)] = image
            }
        }
        return Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            let emitterX = size.width - (emitterInset ?? size.height / 2)
            // Past the pill's leading edge: the exhaust runs the whole length and out (the pill's shape
            // clips it), never stopping short.
            let tailX = PropulsionPlume.tailX(height: size.height)
            let circles = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)

            // A soft glow under everything, added rather than painted, so the bunched nozzle
            // blooms brightest.
            context.drawLayer { glow in
                glow.addFilter(.blur(radius: size.height * 0.22))
                glow.blendMode = .plusLighter
                glow.opacity = 0.55
                for circle in circles where !circle.spark {
                    glow.fill(Self.disc(circle, scale: 1.15), with: .color(Self.color(heat: circle.heat, palette)))
                }
            }
            // The puffs themselves — flat colour, no outline.
            for circle in circles where !circle.spark {
                context.fill(Self.disc(circle), with: .color(Self.color(heat: circle.heat, palette)))
            }
            for circle in circles where circle.spark {
                context.fill(Self.disc(circle), with: .color(Self.color(heat: 1, palette).opacity(0.95)))
            }
            // The thrown tiles ride on top of the exhaust.
            for tile in model.plume.tiles(in: rect, emitterX: emitterX, tailX: tailX) {
                Self.draw(tile, palette: palette, favicons: favicons, in: &context)
            }
        }
    }

    /// One tile: a rounded square, turned by its tumble — a tool's white symbol on its own colour, or
    /// a site's favicon on white (a globe until the favicon has loaded, or if it never does).
    /// One thrown item, a disc like everything else in the plume: a TOOL is a puff in the plume's own
    /// colours (cooling as it goes) carrying its white symbol; a SITE is a white disc holding its
    /// favicon (a globe until the favicon has loaded, or if it never does).
    private static func draw(_ tile: PlumeTile, palette: PlumePalette, favicons: [String: NSImage],
                             in context: inout GraphicsContext) {
        let side = tile.side
        let disc = CGRect(x: tile.center.x - side / 2, y: tile.center.y - side / 2, width: side, height: side)
        let shape = Path(ellipseIn: disc)
        switch tile.item.kind {
        case .tool(let symbol):
            context.fill(shape, with: .color(color(heat: 0.35 + 0.65 * tile.heat, palette)))
            drawSymbol(symbol, color: .white, in: disc.insetBy(dx: side * 0.25, dy: side * 0.25), context: &context)
        case .site(let host, let iconURL):
            context.fill(shape, with: .color(.white))
            let inner = disc.insetBy(dx: side * 0.18, dy: side * 0.18)
            if let image = favicons[plumeFaviconKey(host: host, iconURL: iconURL)] {
                var clipped = context
                clipped.clip(to: Path(ellipseIn: inner.insetBy(dx: -side * 0.04, dy: -side * 0.04)))
                clipped.draw(Image(nsImage: image).resizable(), in: inner)
            } else {
                drawSymbol("globe", color: Color(white: 0.45), in: inner.insetBy(dx: side * 0.03, dy: side * 0.03), context: &context)
            }
        }
    }

    private static func drawSymbol(_ symbol: String, color: Color, in box: CGRect, context: inout GraphicsContext) {
        var image = context.resolve(Image(systemName: symbol))
        image.shading = .color(color)
        let natural = image.size
        guard natural.width > 0, natural.height > 0 else { return }
        let scale = min(box.width / natural.width, box.height / natural.height)
        let size = CGSize(width: natural.width * scale, height: natural.height * scale)
        context.draw(image, in: CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2,
                                       width: size.width, height: size.height))
    }

    private static func disc(_ circle: PlumeCircle, scale: CGFloat = 1) -> Path {
        let d = circle.diameter * scale
        return Path(ellipseIn: CGRect(x: circle.center.x - d / 2, y: circle.center.y - d / 2, width: d, height: d))
    }

    private static func color(heat: Double, _ palette: PlumePalette) -> Color {
        let c = plumeColorComponents(heat: heat, palette: palette)
        return Color(red: c.red, green: c.green, blue: c.blue)
    }

    private func step(_ now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now
        model.tick(dt: dt, thrown: thrown, repeating: repeating, animatesPlume: !reduceMotion)
    }
}
