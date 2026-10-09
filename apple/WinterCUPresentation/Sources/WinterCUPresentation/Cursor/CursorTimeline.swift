import CoreGraphics
import Foundation

/// The agent cursor's state machine. Events (`receive`) are scheduled one after another on a visual timeline, each with
/// a short minimum duration, so the user can follow them even when the helper acts faster; `frame(at:)` evaluates the
/// timeline at any instant. Pure and clock-free: callers pass the time, so every transition and timing is testable.
///
/// States: hidden → appear → (moving · targeting · press/double/right · typing · key · scrolling · dragging) → idle
/// (breathing) → … → done (fade) → hidden. Waiting, refusal, foreground and captions overlay whatever else is going on.
///
/// Catch-up: when events queue more than `maxLag` ahead of real time, new segments run at `catchUpSpeed`; past
/// `flushLag` the queue is cut and the cursor jumps to the present, so it never trails the real work by much.
struct CursorTimeline {
    struct Options: Equatable {
        /// System Reduce Motion: no travel, squash, tilt, shake or sweep — states fade in and out in place.
        var reduceMotion = false
    }

    // MARK: Constants

    enum Timing {
        static let appear: TimeInterval = 0.18
        static let fade: TimeInterval = 0.42
        static let ring: TimeInterval = 0.42
        static let squash: TimeInterval = 0.2
        static let doubleGap: TimeInterval = 0.11
        static let reticleSettle: TimeInterval = 0.2
        static let reticleLead: TimeInterval = 0.12
        static let reticleDwell: TimeInterval = 0.12
        static let reticleFadeOut: TimeInterval = 0.22
        /// A reticle no action consumed goes after this.
        static let reticleUnclaimed: TimeInterval = 1.4
        static let badgeFadeOut: TimeInterval = 0.2
        static let caretBadge: TimeInterval = 1.4
        static let keyBadge: TimeInterval = 1.2
        static let scrollBadge: TimeInterval = 0.8
        static let menuBadge: TimeInterval = 0.8
        static let noBadge: TimeInterval = 0.9
        static let shake: TimeInterval = 0.36
        static let refusalHold: TimeInterval = 0.5
        static let refusalFade: TimeInterval = 0.3
        static let dragPress: TimeInterval = 0.12
        static let dragMin: TimeInterval = 0.3
        static let pathFadeIn: TimeInterval = 0.15
        static let pathFadeOut: TimeInterval = 0.3
        static let converge: TimeInterval = 0.24
        static let captionMin: TimeInterval = 1.2
        /// A caption nobody clears goes on its own after this.
        static let captionAuto: TimeInterval = 2.4
        static let captionFade: TimeInterval = 0.15
        /// A labelled wait earns its caption after this long.
        static let waitCaptionDelay: TimeInterval = 1.2
        static let foregroundCrossfade: TimeInterval = 0.2
        static let breathPeriod: TimeInterval = 3.2
        static let foregroundPulse: TimeInterval = 1.4
        static let caretBlink: TimeInterval = 1.06
        static let scrollFlow: TimeInterval = 0.5
        static let spinnerTurn: TimeInterval = 0.9
        static let maxLag: TimeInterval = 0.6
        static let flushLag: TimeInterval = 1.5
        static let catchUpSpeed: Double = 0.4
    }

    enum Motion {
        /// The largest lean into motion (8°).
        static let maxTilt: CGFloat = 0.14
        /// Horizontal speed (pt/s) that earns the full lean.
        static let tiltSpeed: CGFloat = 2200
        static let squashDepth: CGFloat = 0.14
        static let shakeAmplitude: CGFloat = 3.2
        /// How far a glide bows sideways, as a fraction of its length (capped).
        static let bend: CGFloat = 0.16
        static let maxBend: CGFloat = 56
    }

    /// The glide's duration for `distance` points: grows with the log of the distance (a hand's reach), 0.14–0.55 s.
    static func glideDuration(distance d: CGFloat) -> TimeInterval {
        guard d >= 0.5 else { return 0 }
        let t = 0.10 + 0.075 * log2(1 + Double(d) / 20)
        return min(max(t, 0.14), 0.55)
    }

    /// The easing every glide uses: a quick, confident start and a long, gentle arrival.
    static let glideEasing = CubicTiming(x1: 0.35, y1: 0, x2: 0.15, y2: 1)

    // MARK: State

    var options: Options
    /// The end of the last scheduled segment.
    private(set) var busyUntil: TimeInterval = -.infinity
    /// Where the cursor will rest once every scheduled glide has run.
    private(set) var restPosition: CGPoint?
    private var origin: CGPoint = .zero
    private var glides: [Glide] = []
    private var squashes: [Squash] = []
    private var holds: [Interval] = []
    private var rings: [RingEvent] = []
    private var reticles: [ReticleEvent] = []
    private var paths: [PathEvent] = []
    private var badges: [BadgeEvent] = []
    private var shakes: [TimeInterval] = []
    private var refusals: [TimeInterval] = []
    private var waits: [WaitEvent] = []
    private var foregrounds: [Interval] = []
    private var captions: [CaptionEvent] = []
    private var appearAt: TimeInterval?
    private var fadeAt: TimeInterval?
    /// When the last segment's activity ended: breathing starts from here.
    private(set) var settledAt: TimeInterval = 0

    init(options: Options = Options()) {
        self.options = options
    }

    // MARK: Events

    /// Schedules `kind` at `point` (window-local points) on the timeline. Returns the time its segment starts.
    @discardableResult
    mutating func receive(_ kind: CUCursorKind, at point: CGPoint, now: TimeInterval) -> TimeInterval {
        collectGarbage(now: now)
        var start = max(now, busyUntil)
        var speed = 1.0
        if start - now > Timing.flushLag {
            flush(now: now)
            start = now
        } else if start - now > Timing.maxLag {
            speed = Timing.catchUpSpeed
        }
        var end = start

        switch kind {
        case .move:
            end = moveTo(point, at: start, speed: speed)
        case .target(let rect):
            let arrive = moveTo(point, at: start, speed: speed)
            let settle = max(start, arrive - Timing.reticleLead * speed)
            reticles.append(ReticleEvent(rect: rect, start: settle, end: nil, autoEnd: arrive + Timing.reticleUnclaimed))
            end = arrive + Timing.reticleDwell * speed
        case .press:
            let t0 = moveTo(point, at: start, speed: speed)
            tap(at: t0, ring: .click)
            claimReticle(at: t0 + 0.12)
            end = t0 + 0.16 * speed
        case .doubleClick:
            let t0 = moveTo(point, at: start, speed: speed)
            tap(at: t0, ring: .click)
            tap(at: t0 + Timing.doubleGap * speed, ring: .double)
            claimReticle(at: t0 + 0.2)
            end = t0 + (Timing.doubleGap + 0.16) * speed
        case .rightClick:
            let t0 = moveTo(point, at: start, speed: speed)
            tap(at: t0, ring: .context)
            badges.append(BadgeEvent(kind: .menu, start: t0, end: t0 + Timing.menuBadge))
            claimReticle(at: t0 + 0.12)
            end = t0 + 0.16 * speed
        case .type:
            let t0 = moveTo(point, at: start, speed: speed)
            badges.append(BadgeEvent(kind: .caret, start: t0, end: t0 + Timing.caretBadge))
            claimReticle(at: t0 + 0.2)
            end = t0 + 0.12 * speed
        case .key(let combo):
            let t0 = moveTo(point, at: start, speed: speed)
            badges.append(BadgeEvent(kind: .key(KeyComboLabel.format(combo)), start: t0, end: t0 + Timing.keyBadge))
            claimReticle(at: t0 + 0.2)
            end = t0 + 0.12 * speed
        case .scroll:
            let t0 = moveTo(point, at: start, speed: speed)
            badges.append(BadgeEvent(kind: .scroll(nil), start: t0, end: t0 + Timing.scrollBadge))
            claimReticle(at: t0 + 0.12)
            end = t0 + 0.2 * speed
        case .scrollToward(let direction):
            let t0 = moveTo(point, at: start, speed: speed)
            badges.append(BadgeEvent(kind: .scroll(direction), start: t0, end: t0 + Timing.scrollBadge))
            claimReticle(at: t0 + 0.12)
            end = t0 + 0.2 * speed
        case .drag(let to):
            let t0 = moveTo(point, at: start, speed: speed)
            claimReticle(at: t0)
            let from = restPosition ?? point
            let travel = t0 + Timing.dragPress * speed
            let t1 = moveTo(to, at: travel, speed: speed, lengthen: 1.25, minimum: Timing.dragMin * speed)
            holds.append(Interval(start: t0, end: t1))
            squashes.append(Squash(start: t0, kind: .hold))
            rings.append(RingEvent(center: to, start: t1, style: .release))
            paths.append(PathEvent(from: from, to: to, control: Self.control(from: from, to: to), start: t0, end: t1))
            badges.append(BadgeEvent(kind: .grip, start: t0, end: t1 + 0.3))
            end = t1 + 0.1 * speed
        case .wait(.begin(let label)):
            ensureVisible(at: point, start: start)
            waits.append(WaitEvent(start: start, end: nil))
            if let label {
                captions.append(CaptionEvent(text: "Waiting for “\(label)”", start: start + Timing.waitCaptionDelay,
                                             minEnd: start + Timing.waitCaptionDelay + Timing.captionMin,
                                             end: nil, tiedToWait: true))
            }
        case .wait(.end):
            for i in waits.indices where waits[i].end == nil { waits[i].end = start }
            for i in captions.indices where captions[i].tiedToWait && captions[i].end == nil {
                captions[i].end = start // a wait caption that never showed simply never shows
            }
        case .refused:
            ensureVisible(at: point, start: start)
            refusals.append(start)
            if !options.reduceMotion { shakes.append(start) }
            badges.append(BadgeEvent(kind: .no, start: start, end: start + Timing.noBadge))
            end = start + (options.reduceMotion ? 0 : Timing.shake)
        case .foreground(let on):
            ensureVisible(at: point, start: start)
            if on {
                if foregrounds.last?.end != nil || foregrounds.isEmpty {
                    foregrounds.append(Interval(start: start, end: nil))
                    captions.append(CaptionEvent(text: "Using your mouse", start: start, minEnd: start + Timing.captionMin,
                                                 end: nil, tiedToForeground: true))
                }
            } else {
                for i in foregrounds.indices where foregrounds[i].end == nil { foregrounds[i].end = start }
                for i in captions.indices where captions[i].tiedToForeground && captions[i].end == nil {
                    captions[i].end = max(start, captions[i].minEnd)
                }
            }
        case .idle:
            ensureVisible(at: point, start: start)
        case .done:
            guard isShownOrScheduled(after: start) else { break }
            fadeAt = start
            for i in waits.indices where waits[i].end == nil { waits[i].end = start }
            for i in foregrounds.indices where foregrounds[i].end == nil { foregrounds[i].end = start }
            for i in captions.indices where captions[i].end == nil { captions[i].end = start }
            for i in reticles.indices where reticles[i].end == nil { reticles[i].end = start }
            end = start + Timing.fade
        case .caption(let text):
            if let text {
                ensureVisible(at: point, start: start)
                for i in captions.indices where !captions[i].tiedToForeground && (captions[i].end ?? .infinity) > start {
                    captions[i].end = min(captions[i].end ?? .infinity, max(start, captions[i].minEnd))
                }
                captions.append(CaptionEvent(text: text, start: start, minEnd: start + Timing.captionMin,
                                             end: start + Timing.captionAuto))
            } else {
                for i in captions.indices where !captions[i].tiedToForeground && !captions[i].tiedToWait
                    && (captions[i].end ?? .infinity) > start {
                    captions[i].end = min(captions[i].end ?? .infinity, max(start, captions[i].minEnd))
                }
            }
        }

        busyUntil = max(busyUntil, end)
        if end > settledAt { settledAt = end }
        return start
    }

    // MARK: Frames

    /// The cursor at time `t`.
    func frame(at t: TimeInterval) -> CursorFrame {
        guard let appear = appearAt, t >= appear else { return .hidden }
        if let fadeAt, t >= fadeAt + Timing.fade { return .hidden }
        let rm = options.reduceMotion
        var f = CursorFrame()
        f.visible = true

        // Opacity and scale: appear, fade.
        let a = Self.unit((t - appear) / Timing.appear)
        var opacity = rm ? CGFloat(a) : CGFloat(CubicTiming.easeOut.value(a))
        var scale: CGFloat = rm ? 1 : 0.9 + 0.1 * CGFloat(CubicTiming.easeOut.value(a))
        if let fadeAt, t >= fadeAt {
            let u = Self.unit((t - fadeAt) / Timing.fade)
            opacity *= CGFloat(1 - CubicTiming.easeIn.value(u))
            if !rm { scale *= 1 - 0.08 * CGFloat(u) }
        }
        f.opacity = opacity

        // Position, tilt, shake.
        var tip = position(at: t)
        if !rm, let shake = shakes.last(where: { t >= $0 && t < $0 + Timing.shake }) {
            let u = (t - shake) / Timing.shake
            tip.x += Motion.shakeAmplitude * CGFloat(sin(2 * .pi * 2.5 * u) * (1 - u))
        }
        f.tip = tip
        f.tilt = rm ? 0 : tilt(at: t)

        // Squash.
        if !rm { scale *= squashScale(at: t) }
        f.scale = scale

        // Foreground: the real pointer is in use.
        let warmth = foregroundBlend(at: t)
        f.warmth = warmth
        f.bodyOpacity = 1 - warmth
        if warmth > 0 {
            let pulse = rm ? 0.5 : 0.5 - 0.5 * cos(2 * .pi * (t - (foregrounds.last?.start ?? t)) / Timing.foregroundPulse)
            f.foreground = CursorFrame.ForegroundHalo(center: tip, radius: 15 + 2.5 * CGFloat(pulse), opacity: warmth)
        }

        // Glow: breathing at rest, quiet while moving, a warm pulse in the foreground.
        if warmth > 0 {
            f.glow = rm ? 0.5 : 0.35 + 0.25 * CGFloat(0.5 - 0.5 * cos(2 * .pi * (t - (foregrounds.last?.start ?? t)) / Timing.foregroundPulse))
        } else if isGliding(at: t) {
            f.glow = 0.15
        } else if rm {
            f.glow = 0.35
        } else {
            let since = max(0, t - settledAt)
            let breath = 0.5 - 0.5 * cos(2 * .pi * since / Timing.breathPeriod)
            f.glow = 0.22 + 0.28 * CGFloat(breath)
        }

        // Refusal tint.
        if let r = refusals.last(where: { t >= $0 }) {
            let e = t - r
            if e < 0.08 { f.refusal = CGFloat(e / 0.08) }
            else if e < Timing.refusalHold { f.refusal = 1 }
            else if e < Timing.refusalHold + Timing.refusalFade { f.refusal = CGFloat(1 - (e - Timing.refusalHold) / Timing.refusalFade) }
        }

        f.rings = rings.compactMap { ring(for: $0, at: t, warm: warmth > 0.5) }
        f.reticle = reticle(at: t)
        f.path = path(at: t)
        f.badge = badge(at: t)
        f.caption = caption(at: t)
        return f
    }

    /// How much redrawing `frame(at:)` needs around `t`.
    func animationNeed(at t: TimeInterval) -> CursorAnimationNeed {
        guard let appear = appearAt else { return .none }
        if t < appear { return .full } // something is scheduled
        if let fadeAt, t >= fadeAt + Timing.fade { return .none }
        if t < busyUntil || t < appear + Timing.appear || fadeAt.map({ t >= $0 }) == true { return .full }
        if rings.contains(where: { t < $0.start + Timing.ring }) { return .full }
        if reticles.contains(where: { reticleState($0, at: t) != nil && reticleIsChanging($0, at: t) }) { return .full }
        if paths.contains(where: { t < $0.end + Timing.pathFadeOut }) { return .full }
        if let b = badge(at: t), b.animated || b.opacity < 1 { return .full }
        if refusals.contains(where: { t < $0 + Timing.refusalHold + Timing.refusalFade }) { return .full }
        if captions.contains(where: { t >= $0.start - 0.01 && t < ($0.end ?? .infinity) + Timing.captionFade && t < $0.start + Timing.captionFade })
            || captions.contains(where: { $0.end.map { t >= $0 && t < $0 + Timing.captionFade } ?? false }) { return .full }
        if foregroundBlend(at: t) > 0 { return options.reduceMotion ? .none : .full }
        return options.reduceMotion ? .none : .low
    }

    /// True once the cursor has faded out (or never appeared) and nothing is scheduled.
    func isHidden(at t: TimeInterval) -> Bool {
        guard let appear = appearAt else { return true }
        if t < appear { return false }
        if let fadeAt { return t >= fadeAt + Timing.fade }
        return false
    }

    var isFadingOrHidden: Bool { appearAt == nil || fadeAt != nil }

    // MARK: Position

    private mutating func moveTo(_ p: CGPoint, at start: TimeInterval, speed: Double,
                                 lengthen: Double = 1, minimum: TimeInterval = 0) -> TimeInterval {
        guard let from = restPosition, !isHiddenAfterFade(at: start) else {
            appear(at: p, start: start)
            return start
        }
        let d = hypot(p.x - from.x, p.y - from.y)
        guard d >= 0.5 else { return start }
        var duration = options.reduceMotion || foregroundActive(at: start) ? 0 : Self.glideDuration(distance: d) * lengthen
        if duration > 0 { duration = max(duration, minimum) * speed }
        glides.append(Glide(from: from, to: p, control: Self.control(from: from, to: p), start: start, duration: duration))
        restPosition = p
        return start + duration
    }

    private mutating func appear(at p: CGPoint, start: TimeInterval) {
        restPosition = p
        origin = p
        glides.removeAll()
        appearAt = start
        fadeAt = nil
    }

    private mutating func ensureVisible(at p: CGPoint, start: TimeInterval) {
        if restPosition == nil || isHiddenAfterFade(at: start) { appear(at: p, start: start) }
    }

    private func isHiddenAfterFade(at t: TimeInterval) -> Bool {
        guard let fadeAt else { return false }
        return t >= fadeAt
    }

    private func isShownOrScheduled(after t: TimeInterval) -> Bool {
        appearAt != nil && fadeAt == nil
    }

    private func foregroundActive(at t: TimeInterval) -> Bool {
        foregrounds.contains { t >= $0.start && t < ($0.end ?? .infinity) }
    }

    func position(at t: TimeInterval) -> CGPoint {
        guard let glide = glides.last(where: { $0.start <= t }) else {
            return glides.first?.from ?? origin
        }
        guard glide.duration > 0, t < glide.start + glide.duration else { return glide.to }
        let u = Self.glideEasing.value((t - glide.start) / glide.duration)
        return Self.bezier(glide.from, glide.control, glide.to, CGFloat(u))
    }

    private func isGliding(at t: TimeInterval) -> Bool {
        glides.contains { $0.duration > 0 && t >= $0.start && t < $0.start + $0.duration }
    }

    private func tilt(at t: TimeInterval) -> CGFloat {
        guard isGliding(at: t) else { return 0 }
        let dt = 1.0 / 240
        let a = position(at: t - dt), b = position(at: t + dt)
        let vx = (b.x - a.x) / CGFloat(2 * dt)
        return max(-1, min(1, vx / Motion.tiltSpeed)) * Motion.maxTilt
    }

    /// The control point of a glide's quadratic Bézier: it bows the path gently to one side, like a wrist's arc.
    static func control(from a: CGPoint, to b: CGPoint) -> CGPoint {
        let dx = b.x - a.x, dy = b.y - a.y
        let d = hypot(dx, dy)
        guard d > 0 else { return a }
        let bend = min(d * Motion.bend, Motion.maxBend)
        // The normal on the "upper" side for rightward travel, mirrored for leftward, so arcs read as one hand.
        let sign: CGFloat = dx >= 0 ? -1 : 1
        let nx = -dy / d * sign, ny = dx / d * sign
        return CGPoint(x: (a.x + b.x) / 2 + nx * bend, y: (a.y + b.y) / 2 + ny * bend)
    }

    static func bezier(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint, _ u: CGFloat) -> CGPoint {
        let v = 1 - u
        return CGPoint(x: v * v * a.x + 2 * v * u * c.x + u * u * b.x,
                       y: v * v * a.y + 2 * v * u * c.y + u * u * b.y)
    }

    // MARK: Press, rings, reticle, path, badges, captions

    private mutating func tap(at t0: TimeInterval, ring style: CursorFrame.RingStyle) {
        squashes.append(Squash(start: t0, kind: .tap))
        rings.append(RingEvent(center: restPosition ?? origin, start: t0, style: style))
    }

    private func squashScale(at t: TimeInterval) -> CGFloat {
        if let hold = holds.last(where: { t >= $0.start && t <= ($0.end ?? .infinity) + Timing.squash }) {
            let held: CGFloat = 1 - Motion.squashDepth * 0.7
            if t <= (hold.end ?? .infinity) {
                let u = Self.unit((t - hold.start) / 0.08)
                return 1 - (1 - held) * CGFloat(CubicTiming.easeOut.value(u))
            }
            // Release: spring back from the held pose.
            let u = Self.unit((t - (hold.end ?? t)) / Timing.squash)
            return held + (1 - held) * Self.springBack(u)
        }
        guard let s = squashes.last(where: { $0.kind == .tap && t >= $0.start && t < $0.start + Timing.squash }) else {
            return 1
        }
        let u = (t - s.start) / Timing.squash
        // Down fast (first 35%), then back up with a small overshoot.
        if u < 0.35 {
            return 1 - Motion.squashDepth * CGFloat(CubicTiming.easeOut.value(u / 0.35))
        }
        let low = 1 - Motion.squashDepth
        return low + (1 - low) * Self.springBack((u - 0.35) / 0.65)
    }

    /// 0 → 1 with one small, damped overshoot (about 8% of the range, near the middle).
    static func springBack(_ u: Double) -> CGFloat {
        let c = min(max(u, 0), 1)
        return CGFloat(1 - pow(1 - c, 3) * cos(c * .pi * 1.6))
    }

    private func ring(for event: RingEvent, at t: TimeInterval, warm: Bool) -> CursorFrame.Ring? {
        guard t >= event.start, t < event.start + Timing.ring else { return nil }
        let u = (t - event.start) / Timing.ring
        let maxRadius: CGFloat
        switch event.style {
        case .click: maxRadius = 18
        case .double: maxRadius = 13
        case .context: maxRadius = 16
        case .release: maxRadius = 14
        }
        if options.reduceMotion {
            return CursorFrame.Ring(center: event.center, radius: maxRadius * 0.7, opacity: CGFloat(1 - u),
                                    style: event.style, warm: warm)
        }
        let radius = 3 + (maxRadius - 3) * CGFloat(CubicTiming.easeOut.value(u))
        return CursorFrame.Ring(center: event.center, radius: radius, opacity: CGFloat(pow(1 - u, 1.5)),
                                style: event.style, warm: warm)
    }

    private mutating func claimReticle(at t: TimeInterval) {
        guard let i = reticles.lastIndex(where: { $0.end == nil }) else { return }
        reticles[i].end = max(t, reticles[i].start + Timing.reticleSettle)
    }

    private func reticleState(_ r: ReticleEvent, at t: TimeInterval) -> (outset: CGFloat, opacity: CGFloat)? {
        let end = min(r.end ?? .infinity, r.autoEnd)
        guard t >= r.start, t < end + Timing.reticleFadeOut else { return nil }
        var opacity: CGFloat
        var outset: CGFloat = 0
        let u = Self.unit((t - r.start) / Timing.reticleSettle)
        if options.reduceMotion {
            opacity = CGFloat(min(1, (t - r.start) / 0.12))
        } else {
            opacity = CGFloat(CubicTiming.easeOut.value(u))
            outset = 8 * (1 - CGFloat(CubicTiming.easeOut.value(u)))
        }
        if t >= end { opacity *= CGFloat(1 - (t - end) / Timing.reticleFadeOut) }
        return (outset, opacity)
    }

    private func reticleIsChanging(_ r: ReticleEvent, at t: TimeInterval) -> Bool {
        let end = min(r.end ?? .infinity, r.autoEnd)
        return t < r.start + Timing.reticleSettle || t >= end
    }

    private func reticle(at t: TimeInterval) -> CursorFrame.Reticle? {
        for r in reticles.reversed() {
            if let s = reticleState(r, at: t) {
                return CursorFrame.Reticle(rect: r.rect, outset: s.outset, opacity: s.opacity)
            }
        }
        return nil
    }

    private func path(at t: TimeInterval) -> CursorFrame.DragPath? {
        guard let p = paths.last(where: { t >= $0.start && t < $0.end + Timing.pathFadeOut }) else { return nil }
        var opacity = CGFloat(min(1, (t - p.start) / Timing.pathFadeIn))
        if t >= p.end { opacity *= CGFloat(1 - (t - p.end) / Timing.pathFadeOut) }
        return CursorFrame.DragPath(from: p.from, control: p.control, to: p.to, opacity: opacity)
    }

    private func badge(at t: TimeInterval) -> CursorFrame.Badge? {
        let rm = options.reduceMotion
        // A wait's spinner takes the badge slot while it lasts, then closes in.
        if let w = waits.last(where: { t >= $0.start && t < ($0.end ?? .infinity) + Timing.converge }) {
            let phase = rm ? 0 : CGFloat(((t - w.start) / Timing.spinnerTurn).truncatingRemainder(dividingBy: 1))
            var badge = CursorFrame.Badge(kind: .spinner, opacity: 1, phase: phase, animated: !rm)
            badge.opacity = CGFloat(min(1, (t - w.start) / 0.12))
            if let end = w.end, t >= end {
                let u = (t - end) / Timing.converge
                badge.converge = CGFloat(u)
                badge.opacity *= CGFloat(1 - u)
            }
            return badge
        }
        guard let b = badges.last(where: { t >= $0.start && t < $0.end + Timing.badgeFadeOut }) else { return nil }
        var opacity = CGFloat(min(1, (t - b.start) / 0.1))
        if t >= b.end { opacity *= CGFloat(1 - (t - b.end) / Timing.badgeFadeOut) }
        let elapsed = t - b.start
        var phase: CGFloat = 0
        var animated = false
        switch b.kind {
        case .caret:
            animated = !rm
            phase = rm ? 0 : CGFloat((elapsed / Timing.caretBlink).truncatingRemainder(dividingBy: 1))
        case .scroll:
            animated = !rm
            phase = rm ? 0 : CGFloat((elapsed / Timing.scrollFlow).truncatingRemainder(dividingBy: 1))
        default:
            break
        }
        return CursorFrame.Badge(kind: b.kind, opacity: opacity, phase: phase, animated: animated)
    }

    private func caption(at t: TimeInterval) -> CursorFrame.Caption? {
        guard let c = captions.last(where: { t >= $0.start && t < ($0.end ?? .infinity) + Timing.captionFade
            && ($0.end ?? .infinity) > $0.start }) else { return nil }
        var opacity = CGFloat(min(1, (t - c.start) / Timing.captionFade))
        if let end = c.end, t >= end { opacity *= CGFloat(1 - (t - end) / Timing.captionFade) }
        return CursorFrame.Caption(text: c.text, opacity: opacity)
    }

    private func foregroundBlend(at t: TimeInterval) -> CGFloat {
        guard let fg = foregrounds.last(where: { t >= $0.start }) else { return 0 }
        var v = CGFloat(min(1, (t - fg.start) / Timing.foregroundCrossfade))
        if let end = fg.end, t >= end {
            v *= CGFloat(max(0, 1 - (t - end) / Timing.foregroundCrossfade))
        }
        return v
    }

    // MARK: Housekeeping

    /// Cuts everything scheduled after `now` so the cursor can jump to the present.
    private mutating func flush(now: TimeInterval) {
        let here = position(at: now)
        glides.removeAll { $0.start > now }
        if let i = glides.indices.last, glides[i].start + glides[i].duration > now {
            glides[i].duration = 0
            glides[i].to = here
        }
        restPosition = here
        rings.removeAll { $0.start > now }
        squashes.removeAll { $0.start > now }
        badges.removeAll { $0.start > now }
        paths.removeAll { $0.start > now }
        reticles.removeAll { $0.start > now }
        busyUntil = now
    }

    /// Drops events that ended long ago, so the lists stay short on a long session.
    private mutating func collectGarbage(now: TimeInterval) {
        let horizon = now - 3
        let lastGlide = glides.last
        glides.removeAll { $0.start + $0.duration < horizon && $0 != lastGlide }
        squashes.removeAll { $0.start + Timing.squash < horizon }
        holds.removeAll { ($0.end ?? .infinity) + Timing.squash < horizon }
        rings.removeAll { $0.start + Timing.ring < horizon }
        reticles.removeAll { min($0.end ?? .infinity, $0.autoEnd) + Timing.reticleFadeOut < horizon }
        paths.removeAll { $0.end + Timing.pathFadeOut < horizon }
        badges.removeAll { $0.end + Timing.badgeFadeOut < horizon }
        shakes.removeAll { $0 + Timing.shake < horizon }
        refusals.removeAll { $0 + Timing.refusalHold + Timing.refusalFade < horizon }
        waits.removeAll { ($0.end ?? .infinity) + Timing.converge < horizon }
        foregrounds.removeAll { ($0.end ?? .infinity) + Timing.foregroundCrossfade < horizon }
        captions.removeAll { ($0.end ?? .infinity) + Timing.captionFade < horizon }
    }

    static func unit(_ v: Double) -> Double { min(max(v, 0), 1) }

    // MARK: Event records

    private struct Glide: Equatable {
        var from: CGPoint
        var to: CGPoint
        var control: CGPoint
        var start: TimeInterval
        var duration: TimeInterval
    }

    private struct Squash {
        enum Kind { case tap, hold }
        var start: TimeInterval
        var kind: Kind
    }

    private struct Interval {
        var start: TimeInterval
        var end: TimeInterval?
    }

    private struct RingEvent {
        var center: CGPoint
        var start: TimeInterval
        var style: CursorFrame.RingStyle
    }

    private struct ReticleEvent {
        var rect: CGRect
        var start: TimeInterval
        var end: TimeInterval?
        var autoEnd: TimeInterval
    }

    private struct PathEvent {
        var from: CGPoint
        var to: CGPoint
        var control: CGPoint
        var start: TimeInterval
        var end: TimeInterval
    }

    private struct BadgeEvent {
        var kind: CursorFrame.BadgeKind
        var start: TimeInterval
        var end: TimeInterval
    }

    private struct WaitEvent {
        var start: TimeInterval
        var end: TimeInterval?
    }

    private struct CaptionEvent {
        var text: String
        var start: TimeInterval
        var minEnd: TimeInterval
        var end: TimeInterval?
        var tiedToWait = false
        var tiedToForeground = false
    }
}

/// A CSS-style cubic-Bézier timing curve, solved for y at a given x (progress) by Newton's method with a bisection
/// fallback.
struct CubicTiming: Equatable {
    var x1: Double, y1: Double, x2: Double, y2: Double

    static let easeOut = CubicTiming(x1: 0.215, y1: 0.61, x2: 0.355, y2: 1)
    static let easeIn = CubicTiming(x1: 0.55, y1: 0.055, x2: 0.675, y2: 0.19)

    func value(_ x: Double) -> Double {
        let p = min(max(x, 0), 1)
        if p == 0 || p == 1 { return p }
        let s = solveT(p)
        return sample(s, y1, y2)
    }

    private func sample(_ t: Double, _ a: Double, _ b: Double) -> Double {
        let v = 1 - t
        return 3 * v * v * t * a + 3 * v * t * t * b + t * t * t
    }

    private func derivative(_ t: Double, _ a: Double, _ b: Double) -> Double {
        let v = 1 - t
        return 3 * v * v * a + 6 * v * t * (b - a) + 3 * t * t * (1 - b)
    }

    private func solveT(_ x: Double) -> Double {
        var t = x
        for _ in 0..<8 {
            let err = sample(t, x1, x2) - x
            if abs(err) < 1e-7 { return t }
            let d = derivative(t, x1, x2)
            if abs(d) < 1e-6 { break }
            t -= err / d
        }
        var lo = 0.0, hi = 1.0
        t = x
        for _ in 0..<40 {
            let v = sample(t, x1, x2)
            if abs(v - x) < 1e-7 { break }
            if v < x { lo = t } else { hi = t }
            t = (lo + hi) / 2
        }
        return t
    }
}

/// Key-combo text for the key badge: "cmd+shift+s" → "⇧⌘S", "return" → "↩".
enum KeyComboLabel {
    static func format(_ combo: String) -> String {
        let parts = combo.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        var mods = ""
        var keys: [String] = []
        // macOS's canonical modifier order: ⌃ ⌥ ⇧ ⌘.
        let order = ["ctrl", "control", "alt", "option", "opt", "shift", "cmd", "command", "meta", "super"]
        let glyph: [String: String] = ["ctrl": "⌃", "control": "⌃", "alt": "⌥", "option": "⌥", "opt": "⌥",
                                       "shift": "⇧", "cmd": "⌘", "command": "⌘", "meta": "⌘", "super": "⌘"]
        for mod in order where parts.contains(mod) {
            if let g = glyph[mod], !mods.contains(g) { mods += g }
        }
        let named: [String: String] = [
            "return": "↩", "enter": "↩", "escape": "esc", "esc": "esc", "tab": "⇥", "space": "space",
            "delete": "⌫", "backspace": "⌫", "forwarddelete": "⌦", "up": "↑", "down": "↓", "left": "←", "right": "→",
            "home": "↖", "end": "↘", "pageup": "⇞", "pagedown": "⇟",
        ]
        for part in parts where glyph[part] == nil && !part.isEmpty {
            keys.append(named[part] ?? (part.count == 1 ? part.uppercased() : part.capitalized))
        }
        let label = mods + keys.joined(separator: " ")
        return label.isEmpty ? combo : label
    }
}
