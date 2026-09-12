import SwiftUI

/// Task-3 fix wave (review finding, "full-body re-render per tick"): the fluid's own physics state
/// used to live on the SHARED `MorphModel` (`morph.fluid` + `morph.fluidAcceleration`), observed
/// by both this view AND `WinterFieldView` (the whole field body — glass geometry, composer/
/// response content, nav pill…). Since the sim advances on every render tick (~120/s while a turn
/// is active), every one of those `@Published` writes re-ran `WinterFieldView`'s entire body too —
/// a full-body re-render for a change nothing but this bubble needed to see, and a direct
/// violation of this file's own local-animation-state convention (cf. `WorkingSpinnerGlyph`/
/// `SheenText` in `WinterFieldView.swift`, which each scope their own animation state to
/// themselves, never an ancestor). `FluidModel` is a dedicated, narrowly-scoped `ObservableObject`
/// for exactly this state; the only things that ever observe it are `FluidOrbSlot` and
/// `FluidOrbView` below — `WinterFieldView` holds a plain, non-`@ObservedObject` reference just to
/// pass one down (see that file's mount site, and its own new progress-fade comment).
@MainActor
final class FluidModel: ObservableObject {
    /// The fluid orb's own physics state (`Orb/FluidSim.swift`, Task 1) — the render tick (Task 3,
    /// `FluidOrbView.step`) owns advancing this every frame via
    /// `.step(dt:acceleration:targetLevel:)` and reads it back out for the bubble's tilt/wave/level
    /// rendering. Lives here (rather than on the view) so it survives across `FluidOrbView`
    /// remounts, the same reason `MorphModel.progress` etc. live on a model rather than a view.
    @Published var sim: FluidSim = .rest
    /// `OrbFollower`'s per-tick tracking-spring acceleration tap ((velocity − lastVelocity) / dt,
    /// see `OrbFollower.tick()`) — the lateral/vertical "kick" the fluid sim's tilt/wave terms
    /// react to. Written every display-link tick regardless of which surface is showing.
    /// Deliberately NOT `@Published`: `FluidOrbView.step` is the sole reader, and it already reads
    /// `sim` fresh every tick of its own — there is no view left to invalidate by publishing this
    /// too, only wasted Combine traffic on every follower tick (up to 120/s).
    ///
    /// Final-review Important-2 (D9 settled-tick freeze, unpause path (b)): this `didSet` is the
    /// ONE exception to "nobody publishes off this" — while `FluidOrbView`'s tick is paused
    /// (`isPausedForTick == true`, set by the view itself, see `FluidOrbView.body`), a fresh kick
    /// above `fluidPauseAccelThreshold` needs to wake the (non-ticking) view back up somehow, and
    /// the view can't poll a non-`@Published` var while paused (nothing re-invokes it). `wasExcited`
    /// edge-detects so this only trips `excitationPulse` on the calm→excited transition, never on
    /// every one of the up to 120 ticks/sec a sustained motion burst spans — preserving the whole
    /// point of `acceleration` being unpublished (avoiding 120Hz `@Published` traffic) for the
    /// overwhelmingly common case (tick NOT paused, i.e. actively animating already).
    var acceleration: CGVector = .zero {
        didSet {
            guard isPausedForTick else { wasExcited = false; return }
            let magnitude = hypot(acceleration.dx, acceleration.dy)
            let excited = magnitude > fluidPauseAccelThreshold
            if excited && !wasExcited {
                excitationPulse += 1
            }
            wasExcited = excited
        }
    }

    /// Mirrors whether `FluidOrbView`'s `TimelineView` tick is currently paused — written by the
    /// view itself (`.onChange(of: paused)`) every time its local `@State paused` flips. Plain
    /// ivar, not `@Published`: nothing needs to react to this changing on its own, it only gates
    /// whether `acceleration`'s `didSet` above is worth doing any work at all.
    var isPausedForTick: Bool = false

    /// Edge-detection memory for `acceleration`'s `didSet` — see its doc.
    private var wasExcited = false

    /// Final-review Important-2 (D9 settled-tick freeze, unpause path (b)): a trip wire, not a
    /// value — `FluidOrbView` (already `@ObservedObject`-observing this model for `sim`) reacts to
    /// this incrementing by clearing its own `paused` state. An `Int` counter (not a `Bool`
    /// toggle) so two rapid pulses can never coalesce into a single `onChange` firing (SwiftUI's
    /// `.onChange` only fires on an actual value change; a `Bool` flipped true→false→true within
    /// one render pass could in principle collapse to a no-op diff, an `Int` that only ever
    /// increments cannot).
    @Published var excitationPulse: Int = 0
}

/// Final-review Important-2 (D9 settled-tick freeze): acceleration magnitude (pt/s²) below which
/// the cursor counts as "calm" for the pause/unpause decision — shared by `shouldPauseFluidTick`
/// and `FluidModel.acceleration`'s `didSet` so the two can never disagree about what "calm" means.
/// Well below the ~600-5000 magnitudes `FluidSimTests` uses to excite waves/tilt, so a genuinely
/// still cursor pauses while a slow deliberate drift still counts as motion.
let fluidPauseAccelThreshold: Double = 5.0

/// PURE extraction (final-review Important-2/D9 fix) of the settled-tick-freeze decision — no
/// SwiftUI `@State`, no view lifecycle, so the logic has direct unit coverage
/// (`FluidTickPauseTests`). Pausing requires ALL of: the fluid is currently HOLDING work between
/// turns (`isHeld` — never true for `.unread`'s synthetic breathing or an actively-`turnRunning`
/// working fill, both of which must keep animating regardless of how calm/settled they look, see
/// `FieldStateAdapter.isHoldingWork`'s doc), the sim has actually settled to `targetLevel`
/// (`FluidSim.isSettled`), and the cursor is calm (`accelMagnitude` below `threshold` — a moving
/// cursor's tilt/wave excitation would un-settle the sim again on the very next real step, so
/// pausing while still excited would visibly freeze a moving bubble mid-motion).
func shouldPauseFluidTick(sim: FluidSim, targetLevel: Double, isHeld: Bool, accelMagnitude: Double, actionNeeded: Bool, threshold: Double = fluidPauseAccelThreshold) -> Bool {
    guard !actionNeeded else { return false }
    guard isHeld, accelMagnitude < threshold else { return false }
    return sim.isSettled(targetLevel: targetLevel)
}

/// Task 7: action-needed pulse — sharper and faster than unread's calm breathing (sin(t*1.5)*30,
/// see `FluidOrbView.step`'s `.unread` branch) so the two are unmistakable at a glance (spec §3:
/// ≥3× frequency, ≥2× amplitude). Pure for tests (`ActionPulseTests`).
func actionNeededAccelBoost(t: TimeInterval) -> Double {
    sin(t * 5.0) * 80
}

/// Task 3 (fluid orb): the liquid rendered inside the orb bubble — a `Canvas`-drawn fill whose
/// surface tilts with cursor motion and ripples with excitement (`Orb/FluidSim.swift`, Task 1's
/// pure physics), tinted `workingTint` while the agent is working and `unreadTint` while a
/// finished reply sits unread. Mounted ONLY while the fluid is visible — `FluidOrbSlot` below is
/// the sole owner of that decision — so this view's own `TimelineView` tick stops entirely the
/// instant it unmounts (D9: idle = zero draw cost; this is what replaces the always-animating
/// breathing/glow halo view, deleted this task).
///
/// TICK MECHANISM (per the task-3 brief's open question — two candidates were on the table):
/// (a) read `timeline.date` directly inside the `Canvas` drawing closure and step the sim there,
/// or (b) attach `.onChange(of: timeline.date)` to the `Canvas` and step there instead. Went with
/// (b), matching the brief's own sketch. Reasoning: `Canvas`'s content closure is a pure
/// `(inout GraphicsContext, CGSize) -> Void` draw callback invoked mid-render — mutating
/// `@Published` state from inside it is the textbook "modifying state during view update"
/// anti-pattern SwiftUI's runtime purple-warns about (and risks re-entrant/AttributeGraph-cycle
/// behavior, since the mutation would itself invalidate the view being rendered). `.onChange`
/// callbacks, by contrast, run as a view-update SIDE EFFECT (same category as `.onAppear`/
/// `.task`/`.onReceive`) — an approved place to mutate observable state. Verified live (see the
/// task-3 report): `TimelineView(.animation)` re-invokes its content closure — and therefore
/// re-diffs this `Canvas` + `.onChange` pair — every frame while mounted, so `.onChange` fires
/// once per rendered frame; `OrbDebug` logging at the `step()` call site showed ticks landing at
/// ~60/s while `.working`, and the view stops ticking entirely once unmounted (confirmed via the
/// same log going silent).
struct FluidOrbView: View {
    @ObservedObject var fluid: FluidModel
    /// The turn/unread/idle state driving this tick. `.idle` is passed here on EVERY drain (a turn
    /// finishing, or an unread reply getting cleared) — not a rare defensive corner case: `step
    /// (at:)` below feeds it `targetLevel: 0` for as long as the bubble takes to visibly empty
    /// out, and `FluidOrbSlot` keeps this view mounted for exactly that long (see its own doc).
    let state: FluidState

    /// Interrupt-feedback gate polish: while true, the fluid renders `stoppedTint` regardless of
    /// what `state`/`tint` would otherwise say — a 2s muted beat confirming the Esc-interrupt was
    /// received (`FieldStateAdapter.showStoppedFlash`'s doc). Deliberately checked ONLY inside
    /// `tint` below, never inside `lastTint`'s `.onChange(of: state)` tracker — that tracker keeps
    /// following the REAL state the whole time, so the instant this flag clears — 2s later, OR on
    /// the next `turn_started` (final-review fix: `FieldStateAdapter`'s `session.$state` sink now
    /// force-clears `showStoppedFlash` the moment `turnRunning` flips true, so an Esc-then-resubmit
    /// within the 2s window can't leave this flag stuck true over a live, working orb) — `tint`
    /// falls straight back to whatever `state` actually is (holding-blue if tasks are still
    /// incomplete, amber if unread, or draining) with no stale slate residue.
    let isStoppedFlash: Bool

    /// Task 7: true while `FieldStateAdapter.interactionNeeded` — the daemon is waiting on a
    /// human (approval/question/plan). Threaded exactly like `isStoppedFlash` above: adds a hot
    /// amber tint blend (see `tint` below, `isStoppedFlash` wins if both are somehow set) and an
    /// extra lateral acceleration kick in `step(at:)` (`actionNeededAccelBoost`) so the bubble
    /// pulses noticeably faster/harder than `.unread`'s calm breathing. Also feeds
    /// `shouldPauseFluidTick`'s new guard — the tick must never freeze while this is true, since a
    /// paused `TimelineView` would silently kill the pulse animation.
    let actionNeeded: Bool

    /// Final-review Important-2 (D9 settled-tick freeze): true when the fluid is holding its
    /// level between turns (`FieldStateAdapter.isHoldingWork`'s doc) — the ONLY state `paused`
    /// below is ever allowed to go true for; `.unread`'s synthetic breathing and an actively-
    /// `turnRunning` working fill must always keep ticking regardless of how calm/settled they
    /// momentarily look, so `shouldPauseFluidTick` gates on this first.
    let isHeld: Bool

    /// Final-review Important-2 (D9 settled-tick freeze): true once the held sim has settled AND
    /// the cursor is calm — while true, `TimelineView` below stops scheduling frames entirely
    /// (`paused:` binding), which is what actually stops the redraw-forever violation (merely
    /// deciding NOT to call `step` would still cost a `Canvas` re-render every frame; pausing the
    /// schedule itself costs zero). See `shouldPauseFluidTick` (set from `step(at:)`) for the
    /// pause decision, and `body`'s `.onChange` handlers below for every unpause path.
    @State private var paused = false

    /// Winter blue — the working tint (task-level fill while a turn is running). A literal,
    /// undistorted color: this view renders OUTSIDE `GlassForegroundLegibility`'s difference
    /// blend (see `WinterFieldView.composerMorphedContent`), so what's declared here is exactly
    /// what's drawn.
    ///
    /// Finding-4 (gate 2, "brighter fluid"): bumped noticeably more luminous from
    /// `(0.35, 0.62, 1.0)`. GATE-TUNING KNOB — this + `unreadTint` + the fill-gradient opacities
    /// in `body` are the four constants to nudge if the liquid reads too bright/too dim on device.
    private static let workingTint = Color(red: 0.45, green: 0.75, blue: 1.0)
    /// Warm amber — the unread tint (a finished reply is waiting, unseen). Replaces wave-3's
    /// unread-blink overlay pulse; the amber fluid itself IS the unread signal now.
    ///
    /// Finding-4: brightened from `(1.0, 0.72, 0.30)` (GATE-TUNING KNOB, see `workingTint`).
    private static let unreadTint = Color(red: 1.0, green: 0.80, blue: 0.35)

    /// Interrupt-feedback gate polish: muted, desaturated slate — the "stopped" beat's tint,
    /// deliberately unlike either working-blue or unread-amber so an Esc-interrupt reads as its
    /// own distinct, quieter event rather than a variant of either normal state.
    private static let stoppedTint = Color(red: 0.62, green: 0.66, blue: 0.72)

    /// Task 7: hot amber — blended 50/50 into the active tint while `actionNeeded` is true (see
    /// `tint` below). Deliberately hotter/more saturated than `unreadTint` so the action pulse
    /// reads as a distinct, more urgent signal than a merely-unread reply.
    private static let actionNeededTint = Color(red: 1.0, green: 0.62, blue: 0.20)

    /// Task-3 fix wave (review finding, "drain snaps amber → blue"): `FluidState.idle` carries no
    /// color of its own — without this, a dismissed-unread drain would snap the bubble from amber
    /// straight to the (semantically meaningless, for a drain) working blue for its entire
    /// fade-out. Kept current by the `onChange` in `body` below whenever `state` reports an active
    /// (non-`.idle`) tint; the `.idle` branch of `tint` reuses whatever this last held.
    @State private var lastTint: Color = workingTint

    /// Wall-clock time of the previous tick — `step(at:)` advances by REAL elapsed time between
    /// ticks (not an assumed 1/60 frame rate), so the on-screen liquid tracks the display's
    /// actual refresh cadence. `nil` on the very first tick after mount (no previous sample to
    /// diff against): falls back to a nominal 1/60 there, itself well inside
    /// `FluidSim.step(dt:)`'s own [1/240, 1/20] internal clamp, so it's a safe no-op default
    /// rather than a magic frame-rate assumption driving every subsequent tick.
    @State private var lastTick: Date?

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: paused)) { timeline in
            Canvas { ctx, size in
                let sim = fluid.sim
                let r = min(size.width, size.height) / 2
                var path = Path()
                // Surface line across the bubble, in bubble coordinates.
                let surfaceY = size.height * (1 - sim.level)
                let steps = 24
                path.move(to: CGPoint(x: 0, y: size.height))
                path.addLine(to: CGPoint(x: 0, y: surfaceY + r * sim.surfaceOffset(atX: -1)))
                for i in 1...steps {
                    let x = Double(i) / Double(steps) * 2 - 1 // -1...1
                    let px = (x + 1) / 2 * size.width
                    let py = surfaceY + r * sim.surfaceOffset(atX: x)
                    path.addLine(to: CGPoint(x: px, y: py))
                }
                path.addLine(to: CGPoint(x: size.width, y: size.height))
                path.closeSubpath()
                // Finding-4 (gate 2): raised fill opacities from 0.85/0.55 for a more luminous,
                // less washed-out liquid (GATE-TUNING KNOB — see `workingTint`'s doc).
                ctx.fill(path, with: .linearGradient(
                    Gradient(colors: [tint.opacity(0.95), tint.opacity(0.7)]),
                    startPoint: CGPoint(x: size.width / 2, y: surfaceY),
                    endPoint: CGPoint(x: size.width / 2, y: size.height)
                ))
            }
            .onChange(of: timeline.date) { _, newDate in
                step(at: newDate)
            }
        }
        // Task-3 fix wave: keeps `lastTint` current, including for the very first frame
        // (`initial: true`) so a fresh mount that happens to start on `.unread` (rather than
        // `.working`) doesn't fall back to the wrong default if it drains to `.idle` before ever
        // observing a "change".
        .onChange(of: state, initial: true) { _, newState in
            if let active = Self.activeTint(for: newState) {
                lastTint = active
            }
        }
        // Final-review Important-2, UNPAUSE path (a): `state` changing means the slot re-rendered
        // on an adapter publish — e.g. a task finished (level target moved), the turn resumed
        // (`isHeld` about to flip false), or the reply became unread. Any of those invalidates
        // whatever settled/calm reading justified the current pause, so unconditionally clear it
        // and let `step` re-earn the pause on its own next tick if it's still warranted.
        .onChange(of: state) { _, _ in
            paused = false
        }
        // UNPAUSE path (c), re-review hardening: path (a) only fires on a state VALUE change, but
        // a resubmit with identical task counts re-derives the same `.working(level)` — `isHeld`
        // flips false with no `state` diff and no cursor motion for path (b), leaving `paused`
        // true during a running turn. Invisible today (a settled `.working` sim renders
        // identically frozen or ticking) but violates `paused`'s held-only invariant; clear it
        // whenever the hold ends.
        .onChange(of: isHeld) { _, held in
            if !held { paused = false }
        }
        // UNPAUSE path (b), half 1: mirror `paused` onto the model so its `acceleration.didSet`
        // (the other half, in `FluidModel`) knows whether tripping `excitationPulse` is even
        // worth doing right now.
        .onChange(of: paused) { _, newValue in
            fluid.isPausedForTick = newValue
        }
        // UNPAUSE path (b), half 2: a fresh kick while paused trips `excitationPulse` (see
        // `FluidModel.acceleration`'s `didSet`) — clear `paused` in response so the next real
        // frame resumes ticking. `fluid` is already `@ObservedObject`, so this `@Published`
        // increment is the only thing that can wake a paused view without polling.
        .onChange(of: fluid.excitationPulse) { _, _ in
            paused = false
        }
        .clipShape(Circle())
        .allowsHitTesting(false)
    }

    /// The tint for an active (non-`.idle`) state; `nil` for `.idle`, which carries no color of
    /// its own — see `lastTint`'s doc.
    private static func activeTint(for state: FluidState) -> Color? {
        switch state {
        case .working: return workingTint
        case .unread: return unreadTint
        case .idle: return nil
        }
    }

    /// Task 7: 50/50 RGB blend toward `actionNeededTint` — `Color.resolve(in:)` (macOS 14+) is the
    /// only way to read a plain literal `Color`'s components back out; a fresh default
    /// `EnvironmentValues()` is fine here since these are opaque sRGB literals, not dynamic/
    /// asset colors whose resolution would actually depend on the environment.
    private static func blend(_ a: Color, toward b: Color, amount: Double) -> Color {
        let ra = a.resolve(in: EnvironmentValues())
        let rb = b.resolve(in: EnvironmentValues())
        return Color(
            .sRGB,
            red: Double(ra.red) * (1 - amount) + Double(rb.red) * amount,
            green: Double(ra.green) * (1 - amount) + Double(rb.green) * amount,
            blue: Double(ra.blue) * (1 - amount) + Double(rb.blue) * amount,
            opacity: Double(ra.opacity) * (1 - amount) + Double(rb.opacity) * amount
        )
    }

    private var tint: Color {
        if isStoppedFlash { return Self.stoppedTint }
        let base = Self.activeTint(for: state) ?? lastTint
        if actionNeeded { return Self.blend(base, toward: Self.actionNeededTint, amount: 0.5) }
        return base
    }

    private func step(at now: Date) {
        let dt = lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60.0)
        lastTick = now

        let target: Double
        var acceleration = fluid.acceleration
        switch state {
        case .working(let level):
            target = max(0.15, level) // never invisible while working
        case .unread(let level):
            target = max(0.15, level)
            // Unread breathing: the cursor (and therefore the real tracking-spring acceleration)
            // is usually sitting still while a reply waits unread, so without this the liquid
            // would freeze flat. A tiny synthetic lateral wobble keeps it gently alive —
            // `Date()`/wall-clock time is fine HERE (view-layer ambiance); the pure sim
            // (`Orb/FluidSim.swift`) never touches wall-clock time itself.
            let t = Date().timeIntervalSinceReferenceDate
            acceleration.dx += sin(t * 1.5) * 30
        case .idle:
            target = 0 // draining — see `state`'s doc
        }
        // Task 7: action-needed pulse — layered on top of whatever the state switch above
        // already contributed (independent of `.unread`'s own wobble; both can be active at once
        // in principle, though `interactionNeeded` and `hasUnread` are not expected to co-occur in
        // practice). Sharper/faster than `.unread`'s breathing so the two read as distinct signals
        // (see `actionNeededAccelBoost`'s doc).
        if actionNeeded {
            let t = Date().timeIntervalSinceReferenceDate
            acceleration.dx += actionNeededAccelBoost(t: t)
        }
        fluid.sim = fluid.sim.step(dt: dt, acceleration: acceleration, targetLevel: target)
        OrbDebug.log("FluidOrbView.step dt=\(String(format: "%.4f", dt)) level=\(String(format: "%.3f", fluid.sim.level)) target=\(String(format: "%.2f", target))")

        // Final-review Important-2 (D9 settled-tick freeze): decide AFTER this tick's step, using
        // the fresh sim state it just produced — `fluid.acceleration` (the raw tracking-spring
        // tap, not the `.unread` branch's synthetic wobble local var above) is the same signal
        // `FluidModel.acceleration`'s `didSet` watches for the unpause kick, so pause/unpause agree
        // on what "calm" means.
        let accelMagnitude = hypot(fluid.acceleration.dx, fluid.acceleration.dy)
        if shouldPauseFluidTick(sim: fluid.sim, targetLevel: target, isHeld: isHeld, accelMagnitude: accelMagnitude, actionNeeded: actionNeeded) {
            paused = true
        }
    }
}

/// Task-3 fix wave: the ONLY thing that observes `FluidModel` other than `FluidOrbView` itself.
/// `WinterFieldView` mounts this unconditionally (see its call site) and never touches `FluidModel`
/// at all — re-renders of THIS view are driven by `fluid.sim` changing (the ~120Hz tick, while
/// active) and stay fully scoped to this leaf; `WinterFieldView`'s own body never re-runs because
/// of them, which is the whole point of this split (see `FluidModel`'s doc above).
struct FluidOrbSlot: View {
    @ObservedObject var fluid: FluidModel
    let state: FluidState
    /// Interrupt-feedback gate polish: threaded straight through to `FluidOrbView`'s tint override
    /// — this slot's own mount/drain decision below is unchanged by it (still driven purely by
    /// `state`/fill level, per this type's existing doc), since the flash is a TINT beat, not a
    /// visibility one; the common case (Esc mid-turn with incomplete tasks) already holds the
    /// fluid visible via `FluidState.working`, which is what actually carries the flash on screen.
    let isStoppedFlash: Bool
    /// Final-review Important-2: threaded straight through to `FluidOrbView`'s settled-tick pause
    /// decision — true when the fluid is holding its level between turns
    /// (`FieldStateAdapter.isHoldingWork`'s doc). This slot's own mount/drain decision below is
    /// unchanged by it (still driven purely by `state`/fill level) — held-work is itself an
    /// always-`state != .idle` case, so it was already keeping this view mounted; this flag only
    /// affects whether the mounted view's tick is allowed to freeze once settled.
    let isHeld: Bool
    /// Task 7: threaded straight through to `FluidOrbView`'s action-pulse tint/acceleration boost
    /// and the pause guard — exactly the same threading pattern as `isStoppedFlash` above. This
    /// slot's own mount/drain decision is unchanged by it: `interactionNeeded` co-occurs with
    /// `.approvalNeeded`, which folds into `OrbStatus` (not `FluidState`) — a turn can be
    /// `.working`/`.unread` independently, so there's no new mount case to add here.
    let actionNeeded: Bool

    var body: some View {
        // `state != .idle`: an active turn or an unread reply — always show. The second clause
        // keeps the drain itself VISIBLE after `state` has already gone `.idle` (`FluidOrbView`
        // keeps ticking `targetLevel: 0` — see its doc) instead of hard-cutting to invisible the
        // instant the turn/unread state clears. Once the drain settles under 0.01 this renders
        // `EmptyView()`, which removes `FluidOrbView` — and with it its `TimelineView` — from the
        // tree entirely: no more ticks, no more `@Published` writes, truly quiescent (D9) until
        // the next `.working`/`.unread`.
        if state != .idle || fluid.sim.level > 0.01 {
            FluidOrbView(fluid: fluid, state: state, isStoppedFlash: isStoppedFlash, actionNeeded: actionNeeded, isHeld: isHeld)
        } else {
            EmptyView()
        }
    }
}
