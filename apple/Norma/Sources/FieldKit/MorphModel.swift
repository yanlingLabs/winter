import Foundation
import CoreGraphics

/// Gate r7 (same-panel window morph): which body `NormaFieldView` renders off `morph.progress` —
/// the composer/field morph (`.field`, covering both the collapsed orb and the expanded field, one
/// progress dimension) or the large window surface (`.window`). v1 carried the analogous
/// `surface: GlassFieldSurface` (`composer`/`dashboard`/`chat`) on its own `MorphModel`; v2 splits
/// the field↔window render choice onto this dedicated flag so the controller (`OrbWindowController`)
/// can flip it at the same instants it drives the morph, without `NormaFieldView` importing the
/// controller's own `Surface` enum. Set `.window` in `presentWindowSurface()`, back to `.field` in
/// `finishWindowCollapse()`.
enum MorphRenderSurface { case field, window }

/// DIRECT TRANSPLANT of v1's `MorphModel` (TextField/GlassFieldWindow.swift:263-334), the
/// spring-driven single source of truth for the orb → composer morph in v1. Every visual that
/// participates in the morph reads off `progress` (0…1): the glass shape grows from a small
/// bubble at the orb into a full rounded rectangle, content inside fades in late, the breathing
/// halo ramps its glow, and the orb window fades out on the same curve.
///
/// TASK A/B NAME COLLISION, NOW RESOLVED: task A (the additive port) had to name this type
/// `FieldKitMorphModel` and this file `FieldKitMorphModel.swift` because v2's flat "Norma" target
/// (project.yml: one `sources: [Sources]` entry) still declared the OLD thin approximation as
/// `Orb/MorphModel.swift`'s `final class MorphModel` at the time — two top-level types (and two
/// files) named `MorphModel` in one module is a redeclaration error. Task B (this swap) deletes
/// that old approximation, so both the type and this file are renamed back to `MorphModel` /
/// `MorphModel.swift` here, per task A's report.
///
/// CUT vs v1 (dashboard/chat surfaces don't exist post-transplant — only the composer path is
/// ported): `surface: GlassFieldSurface`, `dashboardOrbPoint`, `dashboardFinalRect`,
/// `chatPlacement`, `isChatSidebarCollapsed`, `chatSurfaceMotionBlur`, `dashboardContentSize`,
/// `dashboardWindowSize`, `dashboardCornerRadius` are all dropped — nothing in the composer path
/// (v1 GlassFieldView.composerBody) reads `morph.surface` or any dashboard/chat member (verified
/// by grep: the only reads of `.surface` inside GlassFieldView.swift are in `body`'s dashboard/
/// chat routing, GlassFieldView.swift:299/301, both outside composerBody). `screenshotPillHeight`
/// / `screenshotPillWidth` are also dropped — images/screenshots are cut per the brief.
@MainActor
final class MorphModel: ObservableObject {
    /// 0 = fully orb (tiny bubble centered on the cursor companion),
    /// 1 = fully expanded composer pill docked at the chosen corner. Only the
    /// composer pill (reset icon + text field) participates in this morph —
    /// the nav pill spawns separately as a secondary fade-in.
    @Published var progress: Double = 0
    /// True only for the orb -> field leg. The orb glass tint should not
    /// reappear during field -> orb collapse as progress approaches zero.
    @Published var isOpening: Bool = true
    /// Which corner of the composer pill sits over the orb. Task B (window choreography + edge
    /// fence) pins this at `.topLeft` FOREVER by user directive — v1's per-corner switching
    /// (`FieldCorner.choose`) is replaced by continuously fencing the tracking spring's TARGET
    /// anchor instead (`fenceAnchorForTopLeftCorner`, `FieldKit/FieldCorner.swift`), so the
    /// expanded frame always fits on-screen without ever needing a different corner.
    @Published var corner: FieldCorner = .topLeft
    /// Current height of the composer pill. Starts at a single-line height
    /// and grows as the user types (or wraps). Updated by the SwiftUI view
    /// from the composer's reported content height.
    @Published var composerHeight: CGFloat = 44
    /// Wave-5 gate item 3: natural (unclamped) height of the inline response's own content —
    /// pinned/live prompt + reply + the queued-steer line, whichever are showing — measured live
    /// by `NormaFieldView.inlineResponse`. Drives the shell height while a response is showing
    /// (`NormaFieldView.clampedResponseHeight(in:)`), clamped to the window's own usable vertical
    /// space so the pill never grows past the halo padding — anything taller keeps scrolling
    /// internally, same as before this wave.
    ///
    /// Wave-7 gate fix: the ORIGINAL measurement mechanism (a background `GeometryReader` +
    /// `PreferenceKey`, mirroring `composerContentHeight`'s NSTextView-driven doc above) never
    /// actually worked — confirmed empirically (live daemon run, real long reply): the reported
    /// height latched at its very first measurement (0, from the placeholder "thinking" state)
    /// and never updated again despite the underlying `GeometryReader` continuing to compute
    /// correct, growing values every render (verified via a raw diagnostic log directly in that
    /// closure). No `.onPreferenceChange` attachment point tried — the immediate ancestor, or one
    /// above `GlassForegroundLegibility`'s `.compositingGroup()` — ever saw those updates. Fixed by
    /// replacing the whole `PreferenceKey` plumbing with `.onGeometryChange(for:of:action:)` (the
    /// modern, direct replacement for exactly this pattern — no bubbling required), applied to a
    /// hidden, non-scrolling twin of the response content (see `NormaFieldView.inlineResponse`'s
    /// doc for why a second copy is measured instead of the visible, `ScrollView`-hosted one).
    @Published var responseHeight: CGFloat = 0
    /// Wave-9 gate fix (v1 mechanism port — see `Core/ScrollRedirector.swift` +
    /// `TextField/GlassFieldWindow.swift.scrollComposer` in v1, and the wave-9 report for the
    /// full empirical trail): AppKit's normal hit-test dispatch never reaches
    /// `NormaFieldView.inlineResponse`'s scrollable viewport — `GlassForegroundLegibility`'s
    /// `.compositingGroup()` + `.blendMode(.difference)` (applied over the whole
    /// composer/response content layer) silently breaks the AppKit-level hit-testing a real
    /// `NSScrollView` needs to receive `-scrollWheel:`, confirmed live via synthesized CGEvent
    /// scroll probes posted at the panel's screen position (offset never moved with a plain
    /// SwiftUI `ScrollView` in place; moves reliably once driven through this property instead).
    /// v1 hit the exact same click-through-adjacent problem (its composer was PERMANENTLY
    /// mouse-inert) and solved it the same way: never rely on hit-test dispatch at all — capture
    /// the raw scroll deltas upstream (v1: a session-level `CGEventTap`; here:
    /// `OrbWindowController`'s existing local scroll monitor, which the wave-8 fix already proved
    /// reliably observes every vertical-dominant sample) and drive the scrolled position directly.
    /// v1 drove an AppKit `NSClipView`'s bounds origin (`clipView.scroll(to:)`); this is v2's
    /// equivalent for a plain SwiftUI viewport — `inlineResponse` applies it as a manual
    /// `.offset(y: -responseScrollOffset)` inside a `.clipped()` frame, no `ScrollView` in that
    /// viewport at all. `OrbWindowController.applyResponseScroll(deltaY:)` is the only writer;
    /// `maxResponseScrollOffset`/`clampResponseScrollOffset()` below keep it in
    /// `[0, responseHeight - responseViewportHeight]` from both sides (a new scroll delta, and a
    /// reactive re-clamp whenever `responseHeight` itself changes — e.g. a shorter historical
    /// exchange gets swiped in after scrolling deep into a longer one).
    @Published var responseScrollOffset: CGFloat = 0
    /// Incremented when macOS moves the panel into a new compositor context
    /// (Space/screen changes). Rebuilding the glass subtree forces SwiftUI's
    /// native Liquid Glass backing view to reacquire refraction/shadow state.
    @Published var glassRefreshGeneration = 0

    // MARK: - Gate r7: window surface (same-panel window morph)

    /// Which body renders off `progress` — the field/composer morph or the large window surface.
    /// See `MorphRenderSurface`'s doc.
    @Published var renderSurface: MorphRenderSurface = .field
    /// The window shell's FINAL (settled, progress=1) rect in window-LOCAL SwiftUI coords (y-down),
    /// computed once by `presentWindowSurface()` via `windowSurfaceLayout`. `nil` while `.field`.
    /// The window branch (`WindowSurfaceView`) and the mouse gate
    /// (`OrbWindowController.updateWindowMouseGate`) both read this.
    ///
    /// **INVARIANT: non-nil for exactly as long as `OrbWindowController.surface == .window`.**
    /// Both transitions are ordered to preserve it at every observable instant — set BEFORE
    /// entering (`presentWindowSurface`), cleared AFTER leaving (`collapseWindowToOrb`). Reversing
    /// either opens a window where an observer sees `.window` with no layout, which is a real
    /// intermittent failure and not a test artefact (it read as an environmental flake three times
    /// before being traced).
    @Published var windowFinalRect: CGRect?
    /// The orb end of the window morph in window-LOCAL SwiftUI coords — where the shell shrinks to
    /// at progress 0 (the locked open anchor, mapped into the window frame). `nil` while `.field`.
    @Published var windowOrbPoint: CGPoint?

    // MARK: - Task 2/3: fluid orb — MOVED OFF this model (task-3 fix wave)

    // Task-3 fix wave (review finding, "full-body re-render per tick"): `fluid`/`fluidAcceleration`
    // used to live here as `@Published` properties, advanced every render tick (~120/s while a
    // turn is active). Because `NormaFieldView` (the WHOLE field body — glass geometry, composer/
    // response content, nav pill…) also observes this `MorphModel`, every one of those writes
    // re-ran that entire body for a change nothing but the fluid bubble needed to see — a direct
    // violation of this codebase's own local-animation-state convention (cf.
    // `NormaFieldView.WorkingSpinnerGlyph`/`SheenText`, each scoping their own animation state to
    // themselves via `@State`, never an ancestor). Both fields now live on their own dedicated
    // `FluidModel` (`FieldKit/FluidOrbView.swift`), observed ONLY by `FluidOrbSlot`/`FluidOrbView`
    // — `NormaFieldView` holds a plain, non-`@ObservedObject` reference solely to pass one down.
    // `OrbFollower` writes the acceleration tap onto that `FluidModel` directly instead of onto
    // this model now.

    /// Outer window size. Sized to fit nav pill + composer + screenshot pill
    /// slot + generous halo padding on every side so the breathing glow never
    /// hits the window edge and hard-cuts. Task B: this is the AppKit panel's
    /// real frame size while `OrbWindowController.surface == .field` (from the
    /// instant an expand starts until a collapse fully settles) — see
    /// `OrbWindowController.expandToField()`/`finishCollapse()`.
    let windowSize = CGSize(width: 480, height: 440)
    /// Compact panel size used while the UI is collapsed to the cursor orb.
    /// The same SwiftUI glass remains alive; only the AppKit container
    /// shrinks so the idle state is not a full-screen-sized transparent panel.
    /// Task B: this is the AppKit panel's real frame size whenever
    /// `OrbWindowController.surface == .orb`.
    let collapsedWindowSize = CGSize(width: 240, height: 140)

    /// GATE-3 FIX (F1, root cause #2): which of `collapsedWindowSize`/`windowSize` the AppKit
    /// panel is ACTUALLY sized to right now — `NormaFieldView.body` requests this as its outer
    /// `.frame(...)`, instead of unconditionally requesting `windowSize`. Root cause: `
    /// NSHostingView` resizes its own window to match its SwiftUI content's requested frame on
    /// every `windowDidLayout` (confirmed live via a symbolicated stack trace —
    /// `NSHostingView.windowDidLayout()` → `updateAnimatedWindowSize(_:)` →
    /// `-[NSWindow _setFrameCommon:display:fromServer:]`; this fires unconditionally, it is NOT
    /// gated by `NSHostingView.sizingOptions`). With the outer frame permanently requesting the
    /// full 480×440 `windowSize`, that mechanism silently grew the panel back to 480×440 on the
    /// very first layout pass — even at boot, before any expand was ever triggered — undoing the
    /// 240×140 `contentRect` `OrbWindowController.init` constructs the panel with and every later
    /// `panel.setFrame(..., size: collapsedWindowSize)` call (`finishCollapse()`). Since the
    /// composer's visible geometry already morphs off `progress` independent of this outer frame
    /// (see `NormaFieldView`'s own doc — the frame only changes at the two hard resize instants,
    /// never mid-morph), keeping this in lockstep with `OrbWindowController`'s own two
    /// `panel.setFrame` calls (`expandToField()`/`finishCollapse()`) makes NSHostingView's
    /// auto-resize AGREE with our explicit sizing instead of fighting it.
    @Published var activeWindowSize: CGSize = CGSize(width: 240, height: 140)
    /// Composer pill width. Height is dynamic (`composerHeight`).
    let composerWidth: CGFloat = 360
    /// Initial / minimum composer height — matches a single line of text
    /// plus the wrapping pill chrome.
    let composerMinHeight: CGFloat = 44
    /// Collapsed glass bubble size used for the orb end of the morph.
    /// Kept separate from composerMinHeight so the resting orb can be
    /// smaller without making the text field too short.
    let orbBubbleSize: CGFloat = 20
    /// Hard cap on composer height before internal scrolling kicks in, so
    /// the pill never grows past its slot in the window.
    let composerMaxHeight: CGFloat = 240
    /// Nav pill final size. Width is intrinsic (shrinkwrap around its
    /// contents) but we keep a max so the layout stays tidy.
    let navPillMaxWidth: CGFloat = 300
    let navPillHeight: CGFloat = 34
    /// Space between the composer pill and the nav pill.
    let interPillGap: CGFloat = 8
    /// Gap between the glass elements and the window edge — reserved for
    /// the breathing halo to bloom into without clipping.
    let haloPadding: CGFloat = 60

    // MARK: - Wave-9 gate fix: manual response-scroll clamp (see `responseScrollOffset`'s doc)

    /// Same formula as `NormaFieldView.maxShellHeight(in:)` (window height minus halo padding on
    /// both edges, minus the nav pill's reserved slot) — duplicated rather than shared because
    /// that method takes a caller-supplied `windowSize` for `GeometryReader` flexibility, while
    /// this is only ever consulted from `OrbWindowController` while `surface == .field`, at which
    /// point the panel is always sized to `windowSize` exactly (the outer frame never changes
    /// mid-morph — see `activeWindowSize`'s doc).
    var responseViewportHeight: CGFloat {
        let reserved = 2 * haloPadding + navPillHeight + interPillGap
        return max(composerMinHeight, windowSize.height - reserved)
    }

    /// How far `responseScrollOffset` can travel before the reply's bottom edge reaches the
    /// viewport's bottom edge. Zero (nothing to scroll) whenever the reply fits without it.
    var maxResponseScrollOffset: CGFloat {
        max(0, responseHeight - responseViewportHeight)
    }

    /// Re-clamps `responseScrollOffset` into `[0, maxResponseScrollOffset]` from whichever side
    /// changed — a new scroll delta (`OrbWindowController.applyResponseScroll(deltaY:)`) or a
    /// changed `responseHeight` (streamed reply growing/shrinking, or a swiped-in exchange with a
    /// different length).
    func clampResponseScrollOffset() {
        responseScrollOffset = min(max(responseScrollOffset, 0), maxResponseScrollOffset)
    }
}

/// Wave-9 gate fix: pure delta-application + clamp math, extracted so it's directly unit-testable
/// without an `OrbWindowController`/AppKit panel — same convention as `ExchangeNavigation.swift`'s
/// `navigateExchange` (the AppKit-adjacent caller, `OrbWindowController.applyResponseScroll
/// (deltaY:)`, stays a thin wrapper around this). See `MorphModel.responseScrollOffset`'s doc for
/// the sign convention (`current - deltaY`, matching v1's AppKit clip-origin convention).
func clampedResponseScrollOffset(current: CGFloat, deltaY: CGFloat, maxOffset: CGFloat) -> CGFloat {
    min(max(current - deltaY, 0), max(0, maxOffset))
}
