import AppKit
import QuartzCore

/// Cursor-following spring driver. Wave 2 (v1 morph+follow engine) repurposed this to drive the
/// WINDOW ORIGIN of the orb/field panel, using `.tracking` (v1 GlassFieldWindow.swift:1950-1975).
/// Task B (v1 field transplant, window choreography + edge fence): the panel is no longer a
/// single fixed size — it's `morphModel.collapsedWindowSize` (240×140) while
/// `OrbWindowController.surface == .orb` and `morphModel.windowSize` (480×440) while `== .field`
/// (`isExpanded` below mirrors that exactly, set by the controller at the same instants it
/// actually resizes the panel) — so the target-origin math now goes through `FieldCorner`
/// (always `.topLeft`, per user directive) instead of the old fixed-size `fieldFrame` clamp.
/// EDGE FENCE (replaces v1's per-corner switching, `FieldCorner.choose`): the raw anchor (cursor
/// + baseOffset, or a sticky magnetic target) is fenced by `fenceAnchorForTopLeftCorner` so the
/// EXPANDED frame always fits on-screen from wherever the anchor ends up, even while collapsed —
/// the orb visibly stops at the fence while the cursor keeps going past it, v1's "pin" behavior.
/// ONE display-link loop total; it runs THROUGHOUT both surfaces (the "always-following" panel),
/// not just while collapsed. v1 differences kept from wave 1: (1) Timer → CADisplayLink with a
/// 30-120 preferred range, PAUSED when settled (D9: 0 fps); (2) commandedTarget (agent
/// move_pointer) not ported — Phase 5 (see phase-2-carryover.md).
@MainActor
final class OrbFollower {
    private let cursorTracker = CursorTracker()
    private let morphModel: MorphModel
    /// Task-3 fix wave: the fluid orb's own dedicated model (split off `MorphModel` — see
    /// `FluidModel`'s doc, `FieldKit/FluidOrbView.swift`) — `tick()` now writes the per-tick
    /// acceleration tap directly onto this instead of onto `morphModel.fluidAcceleration`
    /// (removed: publishing it there re-rendered the WHOLE field body on every tick).
    private let fluidModel: FluidModel
    private var link: CADisplayLink?
    private var lastUpdate = CACurrentMediaTime()
    private var spring = SpringState(position: .zero, velocity: .zero)
    private var magneticTarget: CGPoint?
    private var lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
    private let baseOffset = CGPoint(x: 24, y: -24) // v1
    private let config = SpringConfig.tracking
    private var lastCursorSampleTime = CACurrentMediaTime()
    /// Task 2 (fluid orb acceleration tap): the tracking spring's velocity as of the PREVIOUS
    /// tick — `tick()` diffs against this to get `fluidModel.acceleration`. Reset to `.zero`
    /// alongside every place `spring.velocity` itself gets reset (`start()`/`snapWindowOrigin`)
    /// so a fresh spring never reports a one-tick phantom acceleration spike computed against a
    /// stale velocity left over from before the reset.
    private var lastVelocity = CGPoint.zero
    /// Wave-3 gate item 2b: gates the answer-arrival auto-expand — see `CursorCalmTracker`'s doc
    /// and `isCursorCalm(at:)` below.
    private var calmTracker = CursorCalmTracker()

    /// Mirrors `OrbWindowController.surface == .field`: `true` from the instant an expand STARTS
    /// (before the panel even resizes) until a collapse fully SETTLES — exactly when the real
    /// AppKit panel is actually sized `morphModel.windowSize` rather than
    /// `morphModel.collapsedWindowSize`. The follower only ever calls `setFrameOrigin` (it never
    /// resizes the panel itself), so it must always target the origin math for whichever size
    /// the panel ACTUALLY is right now, or the two would fight every frame.
    var isExpanded = false

    /// Fix E/F (anim-fidelity restore, v1 parity — `isCollapsing`, GlassFieldWindow.swift:1908/
    /// 1927/1933): mirrors `OrbWindowController.morphTarget == 0`, set by the controller at the
    /// single seam its own target actually changes (`startMorph(target:)`, plus a reset in
    /// `finishCollapse()` for the natural-settle completion that call doesn't itself observe).
    /// Note this is true for the WHOLE collapse — from `collapseToOrb()`'s call until either the
    /// morph settles or a retarget reverses it — even though `isExpanded` ALSO stays true for
    /// that same span (it only flips at `finishCollapse()`); `tick()` below needs both to tell
    /// "still mid-expand, not yet formed" (Fix E: freeze) apart from "collapsing" (Fix F: snap,
    /// unconditionally, v1's own bypass of the freeze).
    var isCollapsing = false

    /// Gate r7 (same-panel window morph): while the window surface is open the panel is a large,
    /// LOCKED frame — THIS follower must NOT spring it toward the cursor (its own tracking spring is
    /// scoped to the small orb/field frame's `FieldCorner` geometry, a different shape entirely).
    /// Distinct from `stop()`: the display link stays alive (paused) and the spring/cursor state is
    /// preserved, so `OrbWindowController.finishWindowCollapse()` can resume tracking from a snapped
    /// origin once the collapse settles. Set true by `presentWindowSurface()`, back to false by
    /// `finishWindowCollapse()`.
    ///
    /// Gate r8: this does NOT mean the panel is motionless throughout — while COLLAPSING (`surface
    /// == .window`, morph target 0), `OrbWindowController.morphTick()` rides the panel origin toward
    /// the live cursor itself, each tick, via a SEPARATE path (`rideWindowCollapseToCursor()`,
    /// `panel.setFrame` directly) that bypasses this follower entirely — reusing `rawGlassAnchor()`
    /// below for the same cursor-anchor convention, but none of this follower's own spring/fence
    /// math (wrong geometry for the window's centered-content layout). `windowStationary` staying
    /// true for that whole span is exactly what's wanted: THIS follower's link must stay paused so
    /// the two mechanisms never fight over the same panel frame.
    var windowStationary = false {
        didSet {
            guard windowStationary != oldValue else { return }
            if windowStationary {
                link?.isPaused = true
            } else {
                wake()
            }
        }
    }

    /// Gate r8: the raw (un-fenced) glass-anchor target this follower's own tracking spring chases
    /// — cursor + `baseOffset`, or the sticky magnetic target if one is set (the same precedence
    /// `targetOrigin()` below uses, factored out so it's reachable without also pulling in that
    /// method's `FieldCorner`/fence mapping, which is scoped to the small orb/field frame's own
    /// geometry). Exposed (not `private`) so `OrbWindowController`'s window-collapse cursor-ride
    /// (gate r8, `rideWindowCollapseToCursor()`) can converge on the SAME anchor convention the
    /// follower resumes tracking from at settle (`finishWindowCollapse()` wakes this follower right
    /// after) — no offset mismatch at the handoff.
    func rawGlassAnchor() -> CGPoint {
        magneticTarget ?? CGPoint(x: cursorLocation.x + baseOffset.x, y: cursorLocation.y + baseOffset.y)
    }

    var onCursorLocationChange: ((CGPoint) -> Void)?
    /// Renamed from wave 1's `onOrbCenterChange`: the published value is now the panel's
    /// window origin, not an orb center.
    var onWindowOriginChange: ((CGPoint) -> Void)?
    /// v1 fast-flick (GlassFieldWindow.swift:1584-1597): fires on every raw cursor sample whose
    /// dt-normalized speed or displacement clears `shouldCollapseFastFlick`'s thresholds. The
    /// controller wires this to `collapseToOrb()`, which is already a guarded no-op while the
    /// field isn't expanded — so this fires unconditionally and lets the guard decide.
    var onFastFlick: (() -> Void)?
    private(set) var cursorLocation = NSEvent.mouseLocation
    var currentWindowOrigin: CGPoint { spring.position }

    init(morphModel: MorphModel, fluidModel: FluidModel) {
        self.morphModel = morphModel
        self.fluidModel = fluidModel
    }

    /// Snaps the tracking spring directly onto `origin` with zero velocity — called by the
    /// controller right after it manually resizes the panel (`expandToField()`/
    /// `finishCollapse()`) so the spring doesn't visibly "catch up" from its pre-resize position
    /// on the next tick. v1 parity: `show()`/`showCollapsedOrb()`/`settleCollapsedOrb()` all
    /// reset `originPos`/`targetOrigin`/`velocity` the same way (GlassFieldWindow.swift:
    /// 581-583/742-746/1504-1506).
    func snapWindowOrigin(to origin: CGPoint) {
        spring = SpringState(position: origin, velocity: .zero)
        lastVelocity = .zero
        lastPublished = origin
    }

    func start() {
        guard link == nil else { return }
        cursorTracker.onLocationChange = { [weak self] location in
            guard let self else { return }
            let previous = cursorLocation
            let now = CACurrentMediaTime()
            let dt = max(now - lastCursorSampleTime, 0.001)
            let displacement = hypot(location.x - previous.x, location.y - previous.y)
            let speed = displacement / dt

            cursorLocation = location
            lastCursorSampleTime = now
            calmTracker.record(speed: speed, at: now)

            // Fast-flick: don't bail before updating state above — the tracking spring's
            // target is computed fresh from `cursorLocation` every tick, so simply having
            // updated it here already satisfies v1's "still forward the cursor into the
            // tracking spring" rule (the ghost-circle fix) with no extra bookkeeping.
            if shouldCollapseFastFlick(speed: speed, displacement: displacement) {
                onFastFlick?()
            }

            onCursorLocationChange?(location)
            wake()
        }
        cursorTracker.start()

        cursorLocation = NSEvent.mouseLocation
        lastCursorSampleTime = CACurrentMediaTime()
        spring = SpringState(position: targetOrigin(), velocity: .zero)
        lastVelocity = .zero
        publish(spring.position)

        let l = (NSScreen.main ?? NSScreen.screens[0]).displayLink(target: self, selector: #selector(tick))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
        lastUpdate = CACurrentMediaTime()
    }

    func stop() {
        link?.invalidate()
        link = nil
        cursorTracker.stop()
        spring.velocity = .zero
        magneticTarget = nil
        lastPublished = CGPoint(x: CGFloat.greatestFiniteMagnitude, y: CGFloat.greatestFiniteMagnitude)
        calmTracker = CursorCalmTracker()
    }

    /// Wave-3 gate item 2b: "has the cursor been calm (no fast movement) for the last ~0.4s?" —
    /// `GlassRootView` checks this the instant a turn completes with a reply, deciding between
    /// auto-expanding into the answer (calm) or marking the collapsed orb unread instead (not
    /// calm — an unsolicited expand would visually snap open under a moving cursor).
    func isCursorCalm(at time: TimeInterval = CACurrentMediaTime()) -> Bool {
        calmTracker.isCalm(at: time)
    }

    /// Stickiness (Task 7) publishes its sticky element center here; nil clears it. Treated as
    /// the glass anchor DIRECTLY (no cursor offset added) — same contract as wave 1 had for the
    /// orb-center spring.
    func setMagneticTarget(_ point: CGPoint?) {
        magneticTarget = point
        wake()
    }

    @objc private func tick() {
        // Gate r7: the window surface is stationary — the link is paused while `windowStationary`,
        // so this normally won't fire at all; belt against a stray tick moving the locked frame.
        if windowStationary { return }
        let now = CACurrentMediaTime()
        let dt = now - lastUpdate
        lastUpdate = now

        // Fix E (anim-fidelity restore, v1 parity — GlassFieldWindow.swift:1927's gate `progress >
        // 0.85 || isCollapsing`): while the field is mid-EXPAND (not collapsing) and hasn't mostly
        // formed yet, hold the window at wherever `expandToField()`'s `snapWindowOrigin(to:)`
        // already put it, instead of springing toward the live cursor — springing this early
        // visibly fights the morph (the glass shape is still inflating from the orb; a
        // simultaneously drifting panel reads as the shape "sliding" mid-grow). `isCollapsing`
        // bypasses this unconditionally (v1's own bypass, same gate) — Fix F below takes over
        // instead, keeping the shrinking bubble glued to the cursor the whole way down.
        if isExpanded, !isCollapsing, morphModel.progress < 0.85 {
            return
        }

        let target = targetOrigin()
        let next: SpringState
        let tier: SpringTier
        if isCollapsing {
            // Fix F (v1 parity, GlassFieldWindow.swift:1933-1945): no 75/18 spring lag while
            // collapsing — pin the tracking spring's position DIRECTLY onto the target every
            // tick, velocity zeroed, so the shrinking bubble stays glued to the cursor instead of
            // trailing behind on the lagged spring (visible before this fix as a "ghost circle"
            // detaching from the cursor mid-collapse).
            next = SpringState(position: target, velocity: .zero)
            tier = .active
        } else {
            (next, tier) = springStep(spring, target: target, dt: dt, config: config)
        }

        // Task 2 (fluid orb acceleration tap): (velocity - lastVelocity) / dt, this tick's real
        // dt — the same one just fed to `springStep` above. Clamped to [1/240, config.dtClampMax]
        // (the same range the spring integration uses), so both computations share a time base.
        // Task-3 fix wave: written onto `fluidModel` (NOT `@Published`, see `FluidModel`'s doc) —
        // this used to be `morphModel.fluidAcceleration`, an `@Published` write on every tick that
        // re-rendered the whole field body.
        let accelDt = max(1.0 / 240.0, min(dt, config.dtClampMax))
        let v = next.velocity
        fluidModel.acceleration = CGVector(dx: (v.x - lastVelocity.x) / accelDt, dy: (v.y - lastVelocity.y) / accelDt)
        lastVelocity = v

        spring = next
        publish(spring.position)

        switch tier {
        case .settled:
            link?.isPaused = true // D9: 0 fps until the next wake()
        case .glide:
            link?.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
        case .active:
            link?.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
        }
    }

    private func wake() {
        // Gate r7: cursor samples keep arriving while the window is open — never let them un-pause
        // the link and start moving the locked window frame.
        guard !windowStationary else { return }
        guard let link else { return }
        if link.isPaused {
            lastUpdate = CACurrentMediaTime() // don't integrate the paused gap
            link.isPaused = false
        }
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 120)
    }

    /// The tracking spring's target: the glass anchor (magnetic target, or cursor + baseOffset),
    /// fenced so the ACTIVE frame (whichever size the panel is currently sized to —
    /// `collapsedWindowSize` while `.orb`, `windowSize` while `.field`) always fits on-screen
    /// (`fenceAnchorForTopLeftCorner` — replaces v1's per-corner switching), then mapped to a
    /// window origin via `FieldCorner` (always `.topLeft`).
    ///
    /// GATE-3 FIX (F1): this used to fence against `morphModel.windowSize` (the EXPANDED
    /// 480×440 frame) UNCONDITIONALLY, even while collapsed. Because `.topLeft`'s anchor sits
    /// near the WINDOW'S TOP with the frame growing ~338pt downward from it (`haloPadding` +
    /// `navOffset` above, the rest below — see `fenceAnchorForTopLeftCorner`'s own derivation),
    /// that fence forced `anchor.y >= bounds.minY + 338` at all times — a constraint sized for
    /// the 440pt-tall expanded frame, not the 140pt-tall collapsed one. The COLLAPSED orb was
    /// therefore clamped out of roughly the bottom third of every screen regardless of cursor
    /// position: it rode too high and never followed the cursor down into that band (measured:
    /// on expand the fence is correctly protective; while merely collapsed it was needlessly
    /// fencing against a frame size the panel isn't even using). Fencing against `activeSize`
    /// instead lets the collapsed orb track the cursor almost anywhere on screen (only a small
    /// ~38pt margin near the very edges, sized to the ACTUAL 140pt-tall collapsed frame), while
    /// still fully protecting the expanded field once `isExpanded` flips true.
    private func targetOrigin() -> CGPoint {
        let activeSize = isExpanded ? morphModel.windowSize : morphModel.collapsedWindowSize
        return followerTargetOrigin(
            cursorLocation: cursorLocation,
            magneticTarget: magneticTarget,
            baseOffset: baseOffset,
            activeSize: activeSize,
            morphModel: morphModel,
            visibleFrame: currentVisibleFrame()
        )
    }

    /// The visible frame of whichever screen currently contains the cursor — v1 resolved the
    /// clamp screen the same cursor-relative way (FieldCorner.choose's screenFrame lookup).
    private func currentVisibleFrame() -> CGRect {
        let screen = NSScreen.screens.first { $0.frame.contains(cursorLocation) } ?? NSScreen.main ?? NSScreen.screens.first
        return screen?.visibleFrame ?? .zero
    }

    private func publish(_ point: CGPoint) {
        if hypot(point.x - lastPublished.x, point.y - lastPublished.y) < 0.25 { return } // v1 threshold
        lastPublished = point
        onWindowOriginChange?(point)
    }
}

/// PURE extraction of `OrbFollower.targetOrigin()`'s math (gate-3 fix F1) — no CADisplayLink, no
/// live cursor tracker, no screen enumeration beyond the passed-in `visibleFrame` — so the
/// corrected fence-sizing behavior (fence against `activeSize`, not always the expanded frame)
/// has direct unit coverage without needing a running app/display link.
@MainActor
func followerTargetOrigin(
    cursorLocation: CGPoint,
    magneticTarget: CGPoint?,
    baseOffset: CGPoint,
    activeSize: CGSize,
    morphModel: MorphModel,
    visibleFrame: CGRect
) -> CGPoint {
    let raw = magneticTarget ?? CGPoint(x: cursorLocation.x + baseOffset.x, y: cursorLocation.y + baseOffset.y)
    let anchor = fenceAnchorForTopLeftCorner(
        raw,
        expandedSize: activeSize,
        haloPadding: morphModel.haloPadding,
        navOffset: morphModel.navPillHeight + morphModel.interPillGap,
        visibleFrame: visibleFrame
    )
    return morphModel.corner.windowOrigin(
        glassAnchor: anchor,
        morph: morphModel,
        windowSize: activeSize,
        surface: .composer
    )
}
