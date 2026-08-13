import SwiftUI
import AppKit

/// DIRECT TRANSPLANT of v1 `GlassFieldView`'s COMPOSER PATH (TextField/GlassFieldView.swift) —
/// `composerBody(in:)` (:313-438), `composerMorphedContent(...)` (:440-721), and every helper
/// they use that doesn't depend on a cut subsystem: `composerContent` (:942-986, reduced), the
/// morph geometry helpers (:1014-1269, minus the dashboard variants), the breathing/glow halo
/// (:1299-1370 — DELETED task 3: the fluid orb, `FluidOrbView.swift`, replaces it entirely, both
/// the orb-collapsed and field-expanded glow and the wave-3 unread blink),
/// `GlassForegroundLegibility` (:1285-1291), the nav pill machinery
/// (`NavigationPill` :1835-1893, `SegmentCell` :1916-1959, `NativeGlassCapsuleSurface`
/// :1900-1914), `FieldThinkingPill` (:2563-2595), `FieldIconButton` (:2599-2613),
/// `GlassChromeColor` (:2628-2641). `smoothstep`/`interpolatedRect` are NOT re-declared here — v2
/// already ports both as module-internal free functions (Orb/MorphGeometry.swift), reused as-is.
/// `GlassSurface` is likewise reused from Field/GlassSurface.swift (an existing, already-verbatim
/// v1 port) rather than re-declared. All the "supporting files" the brief mentions ended up in
/// this one file, matching v1's own organization (all of the above live in the single
/// GlassFieldView.swift there too).
///
/// CUT (per the brief): `dashboardBody`/`chatBody` and everything that only exists to feed them
/// (`ChatSurfacePlacement`, dashboard/chat callbacks); every image/screenshot pill
/// (`ImageChipGlassRow`/`ImageChipMorphStrokeRow`/`ImageChipMorphFocusGlowRow`/
/// `ImageChipMorphContentRow` and their shared state — `renderedImageChips`, `composerImages`,
/// `reconcileRenderedImageChips`, etc. — plus the `screenshotOffset` slot `composerFinalRect`
/// used to reserve for them); battery/fan/permissions (`permissions`/`batteryLimiterController`/
/// `fanController`/`privilegedHelperClient` were `GlassFieldWindowController` dependencies, never
/// read inside composerBody itself, so there was nothing here to delete beyond not carrying them
/// forward); tear-out/detach and the chat sidebar.
///
/// GATE r1 FIX (F3): the chat/expand button next to the nav pill was originally cut above (task A
/// assumed "chat" — the detached chat window surface — meant the whole affordance was dead), then
/// re-added task B without it (a corner-overlay chevron on the composer shell itself, see
/// `composerOrResponseContent`'s neighboring overlay below prior to this fix). Live-gate finding
/// F3: the button belongs in the TOP ROW next to the nav pill, exactly where v1 drew it
/// (`chatButtonFinalRect`, `TopRowIconButton`/`TopRowIconFocusGlow`, GlassFieldView.swift:1058-
/// 1066/1759-1774/1742-1755) — "chat" there was never the sidebar, it was this same expand-to-
/// window affordance. Restored verbatim as v1 had it: `chatButtonFinalRect(navFinal:)` (free
/// function below, extracted — see its own doc — for pure-geometry testability), a 34×34 circular
/// glass surface (`NativeGlassCapsuleSurface`, id "chat-button") immediately left of the nav pill,
/// same reveal timing as the nav pill (`sideGlassReveal`/`sideContentReveal`), same
/// `TopRowIconButton` icon/focus-ring look. The corner-overlay chevron this replaces is gone.
///
/// FOCUS COORDINATOR: v1's field panel is permanently mouse-inert (`ignoresMouseEvents = true`),
/// so `FieldFocusCoordinator` exists there to let arrow keys/Enter drive every button via a
/// keyboard-only focus ring. v2's panel is NOT mouse-inert while expanded
/// (`OrbWindowController.expandToField()` sets `panel.ignoresMouseEvents = false`) — buttons are
/// plain clickable SwiftUI `Button`s already (see `Field/FieldView.swift`'s `revealDraftButton`),
/// and Escape is already owned by `OrbWindowController`'s own key monitor calling `onEsc`. There
/// is therefore nothing for a keyboard focus router to do here: `FieldFocusCoordinator` is
/// STUBBED, not ported — every seam it used to serve is instead a plain `Button` wired straight
/// to a `FieldStateAdapter` closure. The focus-glow layers that only existed to paint a
/// keyboard-focus ring (`ComposerSideFocusGlowLayer`, `NavigationFocusGlow`/
/// `NavigationFocusGlowCell`, `TopRowIconFocusGlow`, `FocusGlow`) are cut as a direct consequence
/// of that — meaningless without a keyboard focus concept, not an independent cut.
///
/// appState → adapter rebinds: `appState.modelStatusText`/`.statusText` (`narrationCaption`) →
/// `adapter.statusText`; `appState.presentationMode == .thinking` → `adapter.isThinking`;
/// `appState.composerDisplayText` (read) → `adapter.visibleResponse` (falls back to the draft,
/// see `showsInlineResponse` below) and the draft text itself → `adapter.composerDraft` /
/// `adapter.draftBinding`; `focusCoordinator.onSubmit()` → `adapter.onSubmit(adapter.
/// composerDraft)`; the clear-message button action → `adapter.onClearMessage()`;
/// `focusCoordinator.onCollapse()` (the Esc/collapse seam) → `adapter.onCollapse()`.
/// `appState.visualCustomization` (halo/focus tint) has no v2 equivalent yet — `haloColor` below
/// is a fixed placeholder constant, not a per-user setting; there's no focus-highlight color left
/// to rebind since the focus-glow layers are cut (see above). v1's reset icon
/// ("arrow.counterclockwise", GlassFieldView.swift:946-949) had no backing action in
/// `FieldStateAdapter`'s contract (no context-reset hook in the brief's callback list) — see
/// `composerContent` below for how its layout SLOT is kept without the button.
///
/// INLINE RESPONSE: v1's composerBody never showed a reply inline — the "inline response in the
/// same shell" behavior (`showsInlineResponse`/`showingDraft`/shimmer) is v2's OWN existing
/// design (`Field/FieldView.swift`, wave 2c task 3), ported into v1's real composer chrome here
/// rather than re-invented — this is the "inline response rendering" + "shimmer" the brief asks
/// to keep. Task A simplified relative to `Field/FieldView.swift` by dropping `displayedPrompt`/
/// `historyPositionText` (those read exchange prompt/count directly, which `FieldStateAdapter`'s
/// original spec didn't expose). Task B adds both back onto `FieldStateAdapter` (fed from
/// `exchangeIndex` + `session.state.exchanges`, mirroring the old `Field/FieldView.swift` exactly)
/// and reads them here in `inlineResponse` below.
///
/// COMPOSER CONTENT HEIGHT: v1's `ComposerTextView` reports live text height via
/// `onContentHeightChange`, driving `composerContentHeight` so the pill grows with typed text.
/// Task B ports the same callback onto v2's `ComposerTextView` (`Field/ComposerTextView.swift`)
/// and wires it below, so `composerContentHeight`/`clampedComposerHeight()` (kept verbatim from
/// task A) are now actually driven by the live text measurement instead of sitting fixed.
struct NormaFieldView: View {
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var morph: MorphModel
    /// Task-3 fix wave (review finding, "full-body re-render per tick"): deliberately NOT
    /// `@ObservedObject` — see `FluidModel`'s doc (`FluidOrbView.swift`) for why this view must
    /// never subscribe to the fluid's own publisher (that publisher fires at the sim's ~120Hz
    /// tick rate, and this view's `body` — the whole field's glass geometry, composer/response
    /// content, nav pill — is exactly what the fix wave stops from re-running on every one of
    /// those writes). Held only to hand down to `FluidOrbSlot`, the sole observer, at the mount
    /// site in `composerMorphedContent` below.
    let fluid: FluidModel
    /// Task 6 (2e-iii): the morph window's sidebar wiring, threaded from `OrbWindowController` via
    /// `GlassRootView` down to the `.window` surface's `WindowContentView`. `nil` on paths that
    /// don't wire it (e.g. previews/tests) → the window renders its zero-sidebar layout.
    let sidebars: SidebarWiring?
    @Namespace private var glassNamespace

    @State private var composerContentHeight: CGFloat = 22

    /// Task 7: drives the expand button's amber pulse. `.onChange(of: adapter.interactionNeeded)`
    /// below mirrors `interactionNeeded` onto this local `@State`; the `.animation(value:
    /// chevronPulse)` modifier (scoped to the button's own view chain in `composerMorphedContent`
    /// — GATE r1 FIX F3: relocated from the composer's corner overlay to the top-row button, same
    /// scoping rule either way — v1 LAW: never on an outer/ancestor view) fires a
    /// `.repeatForever(autoreverses: true)` opacity animation on that single false→true
    /// transition, which then keeps autoreversing forever with no further state churn needed —
    /// same local-animation-state convention as `WorkingSpinnerGlyph`/`SheenText` elsewhere in
    /// this file.
    @State private var chevronPulse = false

    /// v1 default halo tint (`appState.visualCustomization.haloNSColor`'s factory default) —
    /// there is no visualCustomization system in v2 yet, so this is a fixed placeholder; a later
    /// wave that adds user customization should rebind this to a real setting.
    private let haloColor = Color.blue

    var body: some View {
        GeometryReader { geo in
            // Gate r7 (same-panel window morph): the field/composer body and the large window
            // surface are two body branches off the SAME `morph.progress`, chosen by
            // `morph.renderSurface` (v1 routed `dashboardBody`/`chatBody`/`composerBody` off its own
            // `morph.surface` the same way). The controller flips `renderSurface` at the same
            // instants it drives the morph — `.window` in `presentWindowSurface()`, `.field` in
            // `finishWindowCollapse()`.
            switch morph.renderSurface {
            case .field:
                composerBody(in: geo.size)
            case .window:
                WindowSurfaceView(
                    adapter: adapter, morph: morph, fluid: fluid,
                    namespace: glassNamespace, windowSize: geo.size,
                    sidebars: sidebars,
                    onClose: { adapter.onWindowClose() },
                    onMinimize: { adapter.onWindowDetach() },
                    onZoom: { adapter.onWindowZoom() }
                )
            }
        }
        // GATE-3 FIX (F1, root cause #2): was `morph.windowSize` (the fixed 480×440 EXPANDED
        // size) unconditionally — see `MorphModel.activeWindowSize`'s doc for why that silently
        // grew the AppKit panel back to 480×440 even while collapsed (an `NSHostingView` internal
        // auto-resize-to-content-size behavior, confirmed live via a symbolicated stack trace).
        // `activeWindowSize` tracks whichever size `OrbWindowController` actually has the panel
        // set to, flipping at the exact same two instants (`expandToField()`/`finishCollapse()`)
        // — the composer's own visible geometry already morphs off `progress` independent of this
        // outer frame (see the corner-pinned `.topLeft` geometry helpers below, none of which
        // depend on this size for that corner), so this has no effect on the morph animation
        // itself, only on what physical AppKit frame size NSHostingView converges the window to.
        .frame(width: morph.activeWindowSize.width, height: morph.activeWindowSize.height)
    }

    // MARK: - composerBody (v1 GlassFieldView.swift:313-438, verbatim minus dashboard/chat/image)

    @ViewBuilder
    private func composerBody(in windowSize: CGSize) -> some View {
        // Wave-5 gate item 3: the shell's target height now follows whichever content is
        // actually occupying it — the response's own measured height (prompt + reply + queued
        // line) while `showsInlineResponse`, else the composer's live-typed-text height exactly
        // as before. Both are clamped, but to different caps: the composer's cap is a fixed
        // constant (`composerMaxHeight`); the response's is the window's own remaining vertical
        // room (`clampedResponseHeight(in:)`) since a reply can legitimately want to fill nearly
        // the whole field before its internal ScrollView takes over.
        let composerTargetHeight = showsInlineResponse
            ? clampedResponseHeight(in: windowSize)
            : clampedComposerHeight()
        // Wave-7 gate item 1 empirical evidence hook: NORMA_ORB_DEBUG=1 traces the shell-height
        // CONSUMER every render, paired with `inlineResponse`'s measurement-site hook below — this
        // pair of log lines is what proved the growth bug live (`responseHeight` latched at 0
        // forever) and now proves the fix (`responseHeight` tracks the reply and `shell height`
        // follows it up to `maxShellHeight`).
        let _ = OrbDebug.log("shell height: \(composerTargetHeight) (showsInlineResponse=\(showsInlineResponse), responseHeight=\(morph.responseHeight), windowSize=\(windowSize), maxShellHeight=\(maxShellHeight(in: windowSize)))")
        let composerFinal = composerFinalRect(in: windowSize, height: composerTargetHeight)
        let orbPoint = morph.corner.orbAnchorInWindow(
            windowSize: windowSize,
            morph: morph
        )
        let composerShape = morphedComposerRect(
            orbPoint: orbPoint,
            finalRect: composerFinal,
            progress: morph.progress
        )
        let navFinal = navPillFinalRect(
            in: windowSize,
            composerFinal: composerFinal
        )

        // Content reveals late in the morph so the expanding bubble reads
        // as "the empty glass shell still inflating" rather than as a
        // stretched-out pill with chrome visible at tiny sizes.
        let contentReveal = smoothstep(0.45, 0.74, morph.progress)
        // Fix B (anim-fidelity restore, v1 GlassFieldView.swift:735-736 verbatim — the
        // dashboard/chat bodies' "content focus-pull"): a soft blur + gentle scale-up on the
        // composer's content layer, easing out as the morph finishes, so the content reads as
        // pulling into sharp focus rather than just fading in flat. Ported onto the composer
        // content group (v1's own composerBody never carried this, only `contentReveal`'s
        // opacity fade — the fidelity investigation calls for porting the SAME formula here).
        let contentBlur = CGFloat((1 - smoothstep(0.44, 1.0, morph.progress)) * 18)
        let contentScale = 0.985 + CGFloat(smoothstep(0.40, 1.0, morph.progress)) * 0.015
        // Two distinct morph phases:
        // 1) 0.00...0.48: orb -> composer only.
        // 2) 0.50...1.00: top row splits out of composer.
        // On collapse this reverses naturally: side glass retracts first,
        // then the composer shrinks back into the orb.
        let glassSplitProgress = smoothstep(0.50, 1.0, morph.progress)
        let sideGlassReveal = smoothstep(0.50, 0.66, morph.progress)
        let sideGlassMaterialScale: CGFloat = sideGlassReveal > 0 ? 1 : 0
        let sideContentReveal = smoothstep(0.66, 1.0, morph.progress)
        let sideContentContainedReveal = sideContentReveal * smoothstep(0.94, 1.0, glassSplitProgress)
        let rendersSideGlass = morph.progress >= 0.48
        let collapsedCenter = CGPoint(x: composerShape.midX, y: composerShape.midY)
        // GATE-3 FIX (F3): the deleted pre-transplant `OrbView` showed its status pill whenever
        // `pillText != nil` (disconnected / needs-approval / n-of-m-working), NOT only while a
        // turn was actively running — gating this on `adapter.isThinking` (turnRunning) instead
        // meant the collapsed orb showed NO pill at all while disconnected or awaiting approval
        // (both states with `turnRunning == false`). `adapter.statusText` is now `""` exactly
        // when there's truly nothing to report (see its doc), so gating on non-emptiness here
        // restores that pill for every `OrbStatus`, matching v1's own reveal rule too
        // (`GlassFieldView.swift:273`: `if !appState.statusText.isEmpty { return
        // appState.statusText }`). Kept as `thinkingReveal` (not renamed) since it still drives
        // the SAME fade-in curve, now for "has a status pill" rather than strictly "is thinking."
        // Interrupt-feedback gate polish: `showStoppedFlash` must reveal the pill even though the
        // turn has already ended (`adapter.statusText` is `""` the instant `turn_completed`
        // clears `turnRunning` — see its own doc) — otherwise the "⏹ stopped" caption below would
        // never actually appear, since the box it lives in only renders while `thinkingReveal > 0`.
        let hasStatusPill = !adapter.statusText.isEmpty || adapter.showStoppedFlash
        let thinkingReveal = hasStatusPill
            ? 1 - smoothstep(0.04, 0.22, morph.progress)
            : 0
        let thinkingDirection: CGFloat = morph.corner.isLeft ? 1 : -1
        // GATE-4 FIX (item 1): this used to be a fixed CENTER point 66pt from the orb, so as
        // the caption text grew ("Reticulating…" → "Reticulating… ☑ n/m" — wave-6's whimsical
        // verb, formerly "thinking…" → "☑ n/m working…"/a tool name) the label expanded EQUALLY
        // in both directions — including back toward the orb it sits beside,
        // visually crowding it as text lengthened. Pin the ORB-ADJACENT (near) edge instead, a
        // fixed gap outside the collapsed orb's own bubble radius, and let growth extend only
        // toward the FAR edge — away from the orb. `morph.corner` is permanently `.topLeft`
        // (`isLeft` always true) per `MorphModel`'s own doc, so `thinkingDirection` is always
        // `+1` today and growth is always rightward; the general (direction-aware) form below
        // still pins correctly if that ever changes.
        let thinkingEdgeGap: CGFloat = morph.orbBubbleSize / 2 + 10

        // Gate polish: split verb and count into separate chips on opposite sides of the orb.
        // VERB (right side): pin the leading edge a fixed gap to the right of the orb center.
        let verbNearEdgeX = collapsedCenter.x + thinkingDirection * thinkingEdgeGap
        let verbBoxCenter = CGPoint(
            x: verbNearEdgeX + thinkingDirection * FieldThinkingPill.maxWidth / 2,
            y: collapsedCenter.y
        )
        let verbAlignment: Alignment = thinkingDirection > 0 ? .leading : .trailing

        // COUNT (left side): pin the trailing edge a fixed gap to the left of the orb center.
        // For .topLeft corner (isLeft=true, thinkingDirection=+1), the count goes to the LEFT
        // (negative direction), so we negate the direction for the left-side chip.
        let countEdgeGap: CGFloat = morph.orbBubbleSize / 2 + 10
        let countDirection: CGFloat = -thinkingDirection // opposite side
        let countNearEdgeX = collapsedCenter.x + countDirection * countEdgeGap
        let countBoxCenter = CGPoint(
            x: countNearEdgeX + countDirection * FieldCountChip.maxWidth / 2,
            y: collapsedCenter.y
        )
        let countAlignment: Alignment = countDirection > 0 ? .leading : .trailing

        // For backwards compatibility in the tree-building code below
        let thinkingNearEdgeX = verbNearEdgeX
        let thinkingBoxCenter = verbBoxCenter
        let thinkingAlignment = verbAlignment
        let navOrbRect = CGRect(
            x: navFinal.minX,
            y: navFinal.midY - morph.orbBubbleSize / 2,
            width: morph.orbBubbleSize,
            height: morph.orbBubbleSize
        )
        let navGlassRect = interpolatedRect(
            from: navOrbRect,
            to: navFinal,
            progress: glassSplitProgress
        )
        // GATE r1 FIX (F3): restored top-row expand button geometry — v1's
        // `chatButtonFinalRect(navFinal:)` (GlassFieldView.swift:1058-1066), a square button sized
        // to the nav pill's own height, sitting `interPillGap` to its left. Extracted as a free
        // function (see its own doc) rather than an instance method so it's directly testable.
        let chatButtonFinal = chatButtonFinalRect(navFinal: navFinal, interPillGap: morph.interPillGap)
        let chatButtonOrbRect = CGRect(
            x: chatButtonFinal.midX - morph.orbBubbleSize / 2,
            y: chatButtonFinal.midY - morph.orbBubbleSize / 2,
            width: morph.orbBubbleSize,
            height: morph.orbBubbleSize
        )
        let chatButtonGlassRect = interpolatedRect(
            from: chatButtonOrbRect,
            to: chatButtonFinal,
            progress: glassSplitProgress
        )

        ZStack {
            composerMorphedContent(
                windowSize: windowSize,
                composerFinal: composerFinal,
                composerShape: composerShape,
                navFinal: navFinal,
                contentReveal: contentReveal,
                contentBlur: contentBlur,
                contentScale: contentScale,
                glassSplitProgress: glassSplitProgress,
                sideGlassReveal: sideGlassReveal,
                sideGlassMaterialScale: sideGlassMaterialScale,
                sideContentReveal: sideContentContainedReveal,
                rendersSideGlass: rendersSideGlass,
                collapsedCenter: collapsedCenter,
                thinkingReveal: thinkingReveal,
                thinkingBoxCenter: thinkingBoxCenter,
                thinkingAlignment: thinkingAlignment,
                countBoxCenter: countBoxCenter,
                countAlignment: countAlignment,
                navGlassRect: navGlassRect,
                chatButtonFinal: chatButtonFinal,
                chatButtonGlassRect: chatButtonGlassRect,
                haloColor: haloColor
            )
        }
        .frame(width: windowSize.width, height: windowSize.height)
        .onChange(of: adapter.isThinking) { _, running in
            // v2 "inline response" addition (not v1): a NEW turn starting is the only reliable
            // "the draft reveal is done" signal — mirrors Field/FieldView.swift's identical rule.
            if running {
                adapter.showingDraft = false
            }
        }
    }

    // MARK: - composerMorphedContent (v1 GlassFieldView.swift:440-721, minus image/chat/dashboard)

    @ViewBuilder
    private func composerMorphedContent(
        windowSize: CGSize,
        composerFinal: CGRect,
        composerShape: CGRect,
        navFinal: CGRect,
        contentReveal: Double,
        contentBlur: CGFloat,
        contentScale: CGFloat,
        glassSplitProgress: Double,
        sideGlassReveal: Double,
        sideGlassMaterialScale: CGFloat,
        sideContentReveal: Double,
        rendersSideGlass: Bool,
        collapsedCenter: CGPoint,
        thinkingReveal: Double,
        thinkingBoxCenter: CGPoint,
        thinkingAlignment: Alignment,
        countBoxCenter: CGPoint,
        countAlignment: Alignment,
        navGlassRect: CGRect,
        chatButtonFinal: CGRect,
        chatButtonGlassRect: CGRect,
        haloColor: Color
    ) -> some View {
        ZStack {
            GlassEffectContainer(spacing: 6) {
                ZStack {
                    let composerCornerRadius = morphedCornerRadius(for: composerShape)
                    let composerGlassShape = RoundedRectangle(
                        cornerRadius: composerCornerRadius,
                        style: .continuous
                    )
                    composerGlassShape
                        .fill(Color.clear)
                        .frame(width: composerShape.width, height: composerShape.height)
                        .glassEffect(.regular, in: composerGlassShape)
                        .glassEffectID("composer-shell", in: glassNamespace)
                        .glassEffectTransition(.matchedGeometry)
                        .position(x: composerShape.midX, y: composerShape.midY)

                    if !navSegments.isEmpty {
                        NativeGlassCapsuleSurface(
                            id: "top-row",
                            namespace: glassNamespace,
                            width: navGlassRect.width * sideGlassMaterialScale,
                            height: navGlassRect.height * sideGlassMaterialScale
                        )
                        .position(x: navGlassRect.midX, y: navGlassRect.midY)
                        .allowsHitTesting(false)
                    }

                    // GATE r1 FIX (F3): the expand/chat button's own glass surface — NOT gated on
                    // `!navSegments.isEmpty` (unlike "top-row" above): the button is an
                    // independent top-row affordance, not a nav segment, so it renders even while
                    // `navSegments` is empty (see that property's own doc). Reuses
                    // `NativeGlassCapsuleSurface` exactly as v1 did for "chat-button" — a Capsule
                    // with equal width/height renders as a circle (corner radius = min(w,h)/2).
                    NativeGlassCapsuleSurface(
                        id: "chat-button",
                        namespace: glassNamespace,
                        width: chatButtonGlassRect.width * sideGlassMaterialScale,
                        height: chatButtonGlassRect.height * sideGlassMaterialScale
                    )
                    .position(x: chatButtonGlassRect.midX, y: chatButtonGlassRect.midY)
                    .allowsHitTesting(false)

                    // GATE-4 FIX (item 3): the status label used to have a matching glass-only
                    // "ghost" layer in here (invisible text, `drawsGlass: true`) purely so its
                    // Liquid Glass material could morph alongside the composer/nav-pill glass in
                    // this same `GlassEffectContainer`. De-pilling the label (bare text, no
                    // capsule chrome at all — see `FieldThinkingPill`) removes the glass surface
                    // it was ghosting for, so there's nothing left to render here.
                }
            }
            .id(morph.glassRefreshGeneration)

            // Task 3 (fluid orb): the liquid renders INSIDE the glass — layered on top of the
            // translucent glass material above, but below the stroke/foreground layers just
            // below (both wrapped in `GlassForegroundLegibility`'s difference blend, which would
            // invert the fluid's literal blue/amber tint if it were applied here too). Replaces
            // the wave-3 unread blink outright (`FluidOrbSlot`'s doc) — the amber fluid IS the
            // unread signal now. Sized/positioned to the collapsed orb bubble exactly (not
            // `composerShape`, which grows through the morph) and hard-clipped to a circle by
            // `FluidOrbView` itself.
            //
            // Task-3 fix wave: mounted UNCONDITIONALLY — `FluidOrbSlot` (observing `FluidModel`,
            // never this view) owns the visible/empty decision internally, so `NormaFieldView`
            // never needs to react to the fluid's own state to decide whether to include it in
            // the tree at all (see `FluidModel`'s doc).
            //
            // Task-3 fix wave (review finding, "no progress fade"): the fluid is an ORB-state
            // visual — the deleted BreathingHalo faded via this exact
            // `1 - smoothstep(0.0, 0.28, progress)` curve as the field expanded; without it the
            // fluid would sit visible at the expanded panel's center with no fade at all. Reads
            // `morph.progress`, which this view already observes, so this adds no new
            // invalidation source. The slot's `TimelineView` still ticks while the field is
            // expanded (opacity 0 doesn't unmount it) — acceptable: D9 (idle = zero draw cost)
            // concerns true idle (state == .idle AND drained), not "field open." Gating the MOUNT
            // itself on progress too was considered and rejected — mount stays driven purely by
            // fluidState/level (`FluidOrbSlot`'s own doc) so drain-visibility doesn't depend on
            // which surface happens to be showing.
            FluidOrbSlot(fluid: fluid, state: adapter.fluidState, isStoppedFlash: adapter.showStoppedFlash, isHeld: adapter.isHoldingWork, actionNeeded: adapter.interactionNeeded)
                .frame(width: morph.orbBubbleSize, height: morph.orbBubbleSize)
                .position(x: collapsedCenter.x, y: collapsedCenter.y)
                .opacity(1 - smoothstep(0.0, 0.28, morph.progress))

            RoundedRectangle(
                cornerRadius: morphedCornerRadius(for: composerShape),
                style: .continuous
            )
            .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
            .frame(width: composerShape.width, height: composerShape.height)
            .position(x: composerShape.midX, y: composerShape.midY)
            .modifier(GlassForegroundLegibility())
            .allowsHitTesting(false)

            if rendersSideGlass, !navSegments.isEmpty {
                Capsule(style: .continuous)
                    .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
                    .frame(width: navGlassRect.width, height: navGlassRect.height)
                    .position(x: navGlassRect.midX, y: navGlassRect.midY)
                    .opacity(sideGlassReveal)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }

            // GATE r1 FIX (F3): chat-button stroke, mirroring v1's Circle stroke
            // (GlassFieldView.swift:577-585) — not gated on `!navSegments.isEmpty` for the same
            // reason the glass fill above isn't.
            if rendersSideGlass {
                Circle()
                    .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
                    .frame(width: chatButtonGlassRect.width, height: chatButtonGlassRect.height)
                    .position(x: chatButtonGlassRect.midX, y: chatButtonGlassRect.midY)
                    .opacity(sideGlassReveal)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }

            // v1's ComposerSideFocusGlowLayer (keyboard-focus ring on the reset/clear icons) is
            // cut here — see the file header's FOCUS COORDINATOR note.

            // Wave-8 gate fix (item 1): `inlineResponse`'s hidden measurement twin
            // (`responseContentBody.fixedSize(horizontal: false, vertical: true)`, used to drive
            // `morph.responseHeight` — see that property's doc) reports its own natural/ideal
            // height upward regardless of what size its ancestors propose, which inflates the
            // reported size of the `ZStack` wrapping it (`inlineResponse` itself) whenever a long
            // reply's natural height exceeds the shell's clamped `composerFinal.height`. A bare
            // `.frame(width:height:)` only PROPOSES that size to the child and REPORTS it
            // upward to `.position(...)` for centering — it does not clip an oversized child's
            // actual paint, so that overflow rendered past the shell's rounded-rect edge on both
            // the top AND bottom (the `.position(...)` below centers the oversized content on the
            // frame's midpoint, so the extra height spills both ways) — exactly the screenshot
            // symptom (reply text visible above/below the glass, over the desktop). `.clipShape`
            // right after `.frame(...)` clips to that frame's reported bounds — same corner
            // radius the glass shell itself is drawn with (`morphedCornerRadius(for:
            // composerShape)`, this function's own shell-shape formula) — so the content layer
            // can never paint outside the shell's rounded-rect regardless of what any interior
            // measurement-only child reports. (`composerContent`, the composer branch, has no
            // equivalent risk: `ComposerTextView` is a real `NSScrollView`/`NSTextView` that clips
            // its document view natively at the AppKit level — see that file's own doc — and its
            // SwiftUI frame height is already clamped to `morph.composerMaxHeight`, never
            // `.fixedSize()`-driven.)
            //
            // Wave-10 gate fix (root cause of "reply shows its middle band, can't scroll to the
            // top, huge empty space at the bottom" — see `inlineResponse`'s geometry-trace doc
            // below for the live measurement that proves this): wave-8 clipped the OVERFLOW so it
            // could never paint past the shell's rounded-rect, but never addressed WHICH slice of
            // the oversized content that clip window shows. This `.frame(width:height:)` had no
            // `alignment:` — SwiftUI defaults to `.center` — so the (still-oversized, per the
            // wave-8 doc above) `inlineResponse` ZStack is centered inside the true, clamped shell
            // box before `.clipShape` crops it: for a reply taller than the shell, that exposes the
            // content's vertical MIDDLE, not its top, and the manual scroll offset
            // (`morph.responseScrollOffset`, wave-9) only slides content within a viewport that a
            // sibling measurement view has ALREADY inflated to the content's own full height (see
            // `inlineResponse`'s `GeometryReader` — SwiftUI proposes a stack's own FINAL resolved
            // size back down to every child once a fixedSize sibling forces that stack larger than
            // it was asked to be, confirmed live: `proxy.size` there reads the full reply height,
            // not the shell's), so scrolling only pans which slice of that fixed, centered crop is
            // shown — it can reach neither the true top (the clamp floors at 0, short of the
            // negative offset centering would require) nor stop the tail from running out before
            // the exposed window does (the "huge empty space" at the bottom). `alignment: .top`
            // aligns that same oversized content's TOP edge to the shell's top instead — at rest
            // (`responseScrollOffset == 0`) the exposed slice is the content's own top (line one),
            // and the existing scroll clamp (`MorphModel.maxResponseScrollOffset` — already
            // correct, verified in the wave-9 gate) now lands the reply's last line exactly flush
            // with the shell's bottom edge at max offset. Same fix also un-hides
            // `revealDraftButton`/`historyPositionText` below (topTrailing-anchored inside the same
            // ZStack) for any reply long enough to trigger this — they were centered off-screen
            // above the shell right along with the reply text.
            composerOrResponseContent
                .frame(width: composerFinal.width, height: composerFinal.height, alignment: showsInlineResponse ? .top : .center)
                // Wave-10 gate fix: names this frame's own box as the ground-truth "what the user
                // actually sees" viewport (see `inlineResponse`'s `.onGeometryChange` below) so the
                // reply content's rendered position can be measured relative to it regardless of
                // how many frames/ZStacks sit in between — this is what proved the centering above
                // and (re-run after the fix) proves the reply now rests at the top.
                // Wave-10b fix: conditional alignment — `.top` pins reply to the shell's top edge
                // (required for scrollable viewport semantics), while `.center` restores the
                // composer's single-line vertical centering within the shell. Multi-line composer
                // growth (composerHeight-driven) keeps working: centered content expands downward
                // from center is correct for that case too.
                .coordinateSpace(.named("normaResponseShellTrace"))
                .clipShape(
                    RoundedRectangle(
                        cornerRadius: morphedCornerRadius(for: composerShape),
                        style: .continuous
                    )
                )
                // Fix B (anim-fidelity restore, v1 GlassFieldView.swift:781-782 verbatim): the
                // content focus-pull — blurred/slightly-shrunk early in the morph, sharpening and
                // scaling up to its true size as the shell finishes forming. Placed BEFORE
                // `.position(...)`/`.opacity(...)`/`GlassForegroundLegibility` — same layering v1
                // uses (content transform first, then place, then fade, then the legibility
                // difference-blend wraps everything) — no `.drawingGroup()` (v1 LAW).
                .scaleEffect(contentScale, anchor: .center)
                .blur(radius: contentBlur)
                .position(x: composerFinal.midX, y: composerFinal.midY)
                .opacity(contentReveal)
                .modifier(GlassForegroundLegibility())
            // NOTE: no `.allowsHitTesting(false)` here, unlike v1 — this layer holds the actual
            // interactive text view / buttons and v2's field is NOT mouse-inert while expanded
            // (see the file header's FOCUS COORDINATOR note), so it must stay hit-testable.

            // v1's NavigationFocusGlow (keyboard-focus ring on nav pill segments) is cut here —
            // same reason as ComposerSideFocusGlowLayer above.

            // GATE r1 FIX (F3): expand/chat button, restored to the TOP ROW exactly where v1 drew
            // it (`TopRowIconButton`, GlassFieldView.swift:1759-1774), immediately left of the nav
            // pill at `chatButtonFinal` — this REPLACES the corner-overlay chevron that used to
            // live here, pinned to `composerFinal`'s top-trailing corner (deleted; that overlay
            // also overlapped `historyPositionText`/`revealDraftButton` while browsing history —
            // a recorded minor this restore resolves as a side effect). Reveal timing now matches
            // the nav pill's own icon layer exactly (`sideContentReveal`, not the old `contentReveal`
            // gate — that one was tied to the composer/response content fading in beneath the
            // corner overlay; this button lives in the top row alongside the nav pill instead, so
            // it fades with THAT row's content, same as `NavigationPill` above).
            //
            // Task 6 (FieldFocus) / Task 7 (interaction-needed pulse) seams are unchanged, only
            // relocated: keyboard-first focus ring (`adapter.focusedElement == .expandChevron` —
            // spec §3, the difference blend breaks reliable hit-testing at this small a target, so
            // click stays best-effort via `.onTapGesture`) and the amber `chevronPulse` pulse while
            // `adapter.interactionNeeded` (v1 LAW: the `repeatForever` `.animation` stays scoped to
            // THIS view alone, value-keyed on the local `chevronPulse` `@State`, never hoisted onto
            // an outer/ancestor view).
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(Typography.label(.semibold))
                .foregroundStyle(adapter.interactionNeeded ? Color(red: 1.0, green: 0.72, blue: 0.30) : .white)
                .frame(width: chatButtonFinal.width, height: chatButtonFinal.height)
                .contentShape(Circle())
                .onTapGesture { adapter.onExpandToWindow() }
                .opacity(sideContentReveal)
                .opacity(chevronPulse ? 1.0 : 0.45)
                .animation(adapter.interactionNeeded
                    ? .easeInOut(duration: 0.5).repeatForever(autoreverses: true)
                    : .default, value: chevronPulse)
                .onChange(of: adapter.interactionNeeded, initial: true) { _, needed in chevronPulse = needed }
                .position(x: chatButtonFinal.midX, y: chatButtonFinal.midY)
                .modifier(GlassForegroundLegibility())

            // Gate r2: the focus ring lives OUTSIDE the difference-blend scope so its Norma-blue
            // hue stays TRUE instead of inverting against the wallpaper (white ring read as just
            // another chrome stroke; selection needs its own stable color).
            Circle()
                .stroke(
                    Color(red: 0.45, green: 0.75, blue: 1.0)
                        .opacity(adapter.focusedElement == .expandChevron ? 0.95 : 0.0),
                    lineWidth: 2.0
                )
                .frame(width: chatButtonFinal.width, height: chatButtonFinal.height)
                .opacity(sideContentReveal)
                .allowsHitTesting(false)
                .position(x: chatButtonFinal.midX, y: chatButtonFinal.midY)

            // Dispatch (Phase 7), Task 8: one circle per in-flight child session, laid RIGHT-to-
            // LEFT starting immediately left of the expand button (`chatButtonFinal.minX`) — the
            // first child (i=0) sits nearest the expand circle, each later one growing further
            // leftward. Capped at `FieldStateAdapter.maxVisibleDispatchChildren` visible circles
            // (v1: no "+N" overflow badge — a 6th+ child simply doesn't render its own circle yet;
            // Task 9 review hoisted the cap out of an inline `.prefix(5)` here into
            // `adapter.visibleDispatchChildren`, a testable seam — see FieldStateAdapter). Same
            // reveal timing / legibility wrap as the expand button just above
            // (`sideContentReveal`/`GlassForegroundLegibility`) — a v1 ("acceptable v1", per the
            // brief) fade rather than its own morph interpolation.
            ForEach(Array(adapter.visibleDispatchChildren.enumerated()), id: \.element.id) { i, child in
                let d = chatButtonFinal.height * 0.62
                let cx = chatButtonFinal.minX - CGFloat(i + 1) * (d + 6) - d / 2
                Circle()
                    .strokeBorder(childRingColor(child.status), lineWidth: 1.5)
                    .background(Circle().fill(childRingColor(child.status).opacity(0.25)))
                    .frame(width: d, height: d)
                    .position(x: cx, y: chatButtonFinal.midY)
                    .contentShape(Circle())
                    .onTapGesture { adapter.onOpenChild(child.sessionId) }
                    .opacity(sideContentReveal)
                    .modifier(GlassForegroundLegibility())
                    .modifier(childPulse(active: child.status == "running"))
                    .help(child.title)
            }

            if !navSegments.isEmpty {
                NavigationPill(
                    segments: navSegments,
                    focusedID: nil,
                    activeFill: haloColor.opacity(0.18),
                    drawsGlass: false,
                    drawsBorder: false,
                    surfaceSize: navGlassRect.size
                )
                .fixedSize()
                .opacity(sideContentReveal)
                .clipShape(Capsule(style: .continuous))
                .position(x: navGlassRect.midX, y: navGlassRect.midY)
                .modifier(GlassForegroundLegibility())
                .allowsHitTesting(false)
            }

            // Gate polish: task count chip on the LEFT (grows leftward from the orb)
            if thinkingReveal > 0 && !adapter.countText.isEmpty {
                Color.clear
                    .frame(width: FieldCountChip.maxWidth, height: FieldCountChip.height)
                    .overlay(alignment: countAlignment) {
                        FieldCountChip(
                            caption: adapter.countText,
                            contentOpacity: thinkingReveal
                        )
                    }
                    .position(x: countBoxCenter.x, y: countBoxCenter.y)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }

            if thinkingReveal > 0 {
                // GATE-4 FIX (item 1 + 3): an invisible box, sized to `FieldThinkingPill`'s own
                // width cap and pinned at `thinkingBoxCenter`, with the label aligned to its
                // near (orb-adjacent) edge via `thinkingAlignment` — this is what makes the
                // label's near edge stay fixed while it only grows toward the far edge (see
                // `thinkingBoxCenter`'s doc above, in `composerBody`). The label itself is bare
                // text (no glass/stroke chrome — item 3); legibility comes from
                // `GlassForegroundLegibility`'s difference blend below, same as every other label
                // in this file.
                // Gate polish: now shows just the verb text (with animated spinner/sheen if working);
                // the count chip is rendered separately to the left above.
                //
                // Interrupt-feedback gate polish: `showStoppedFlash` REPLACES the verb text with
                // "⏹ stopped" for 2s after an Esc-interrupt — the verb is gone anyway by then
                // (the turn already ended, so `adapter.verbText` reads `""`), so this is never
                // fighting the normal verb display for the same slot, just filling the gap it
                // leaves with an explicit confirmation instead of a silent blank. Plain,
                // unanimated text (`animated: false`) — same convention as the other static
                // override pills (disconnected/needs approval), not the working-verb sheen.
                Color.clear
                    .frame(width: FieldThinkingPill.maxWidth, height: FieldThinkingPill.height)
                    .overlay(alignment: thinkingAlignment) {
                        FieldThinkingPill(
                            caption: adapter.showStoppedFlash ? "⏹ stopped" : adapter.verbText,
                            contentOpacity: thinkingReveal,
                            animated: adapter.showStoppedFlash ? false : adapter.isWorkingVerb
                        )
                    }
                    .position(x: thinkingBoxCenter.x, y: thinkingBoxCenter.y)
                    .modifier(GlassForegroundLegibility())
                    .allowsHitTesting(false)
            }
        }
    }

    // MARK: Composer content (v1 GlassFieldView.swift:942-986, reduced) vs inline response
    // (v2's OWN design, ported into v1's chrome — see file header's INLINE RESPONSE note)

    /// v1 parity: the inline response occupies the shell whenever there's something to show,
    /// unless the user asked to see the draft again (`adapter.showingDraft`) — or a fresh summon
    /// forced it (see `FieldStateAdapter.showingDraft`'s doc + `GlassRootView`'s `.field` case).
    private var showsInlineResponse: Bool { hasReply && !adapter.showingDraft }

    private var hasReply: Bool {
        adapter.isThinking || !(adapter.visibleResponse?.isEmpty ?? true)
    }

    /// Turn running, nothing streamed yet — the shimmer-only "thinking" state.
    private var isThinkingOnly: Bool {
        adapter.isThinking && (adapter.visibleResponse?.isEmpty ?? true)
    }

    private var replyText: String { adapter.visibleResponse ?? "" }

    @ViewBuilder
    private var composerOrResponseContent: some View {
        if showsInlineResponse {
            inlineResponse
        } else {
            composerContent
        }
    }

    // MARK: Shared composer/response insets (gate wave-3 text-alignment fix)
    //
    // v1 canonical composerContent padding (GlassFieldView.swift:943-986): 12pt horizontal / 6pt
    // vertical around an HStack(spacing: 8) whose leading column is a fixed 26pt icon slot. Before
    // this fix, `inlineResponse` used a DIFFERENT, uniform 12pt padding on every side with no
    // leading reservation for that icon column — reply text started ~34pt to the LEFT of where
    // composer text actually starts (12 + 26 + 8) and 6pt lower, so the composer↔response swap
    // visibly jumped both horizontally and vertically (user report: "just need to align it
    // properly"). Both branches now share these same named constants instead of each hardcoding
    // its own magic numbers.
    private static let contentHorizontalPadding: CGFloat = 12
    private static let contentVerticalPadding: CGFloat = 6
    private static let iconColumnWidth: CGFloat = 26
    private static let iconColumnSpacing: CGFloat = 8
    /// Where composer TEXT starts, measured from the shell's leading edge — `inlineResponse`
    /// mirrors this exactly so reply text starts at the same x as composer text.
    private static let textLeadingInset: CGFloat =
        contentHorizontalPadding + iconColumnWidth + iconColumnSpacing

    @ViewBuilder
    private var composerContent: some View {
        HStack(alignment: .center, spacing: Self.iconColumnSpacing) {
            VStack(alignment: .center, spacing: 6) {
                // v1's reset icon ("arrow.counterclockwise", GlassFieldView.swift:946-949) has no
                // backing action in FieldStateAdapter's contract (no context-reset hook in the
                // brief's enumerated callback list) — kept as an equally-sized empty spacer so
                // this column doesn't reflow when a real action is wired in later; only the clear
                // button below is actually live.
                Color.clear.frame(width: Self.iconColumnWidth, height: Self.iconColumnWidth)
                if showsClearButton {
                    Button(action: adapter.onClearMessage) {
                        FieldIconButton(icon: "xmark", isFocused: false)
                    }
                    .buttonStyle(.plain)
                }
            }

            ComposerTextView(
                text: adapter.draftBinding,
                onSubmit: { adapter.onSubmit(adapter.composerDraft) },
                onContentHeightChange: { height in composerContentHeight = height },
                // HELD at the chrome body size, deliberately NOT the bound composerFieldSize
                // (2026-08-13): this pill's height is measured from the text content, so the
                // bound 15.5 would move the resting field by +1 pt (line 17 -> 18, measured) —
                // and the field's geometry is ruled stable. Recorded in brand.md § 4.6 as the
                // open question; change ONLY with that ruling. TypographyTests pins this hold.
                fontSize: Typography.bodySize,
                onFocusKey: { key, first, last in
                    let r = resolveFieldFocusKey(current: adapter.focusedElement, key: key,
                                                 caretAtFirstLine: first, caretAtLastLine: last)
                    adapter.focusedElement = r.element
                    if r.activatesExpand { adapter.onExpandToWindow() }
                    return r.consumed
                },
                onTypingRefocus: {
                    // Guard against a redundant @Published fire on every keystroke when focus
                    // is already `.composer` (the common case while typing).
                    if adapter.focusedElement != .composer { adapter.focusedElement = .composer }
                }
            )
            .overlay(alignment: .topLeading) {
                if adapter.composerDraft.isEmpty {
                    // Offset by the SAME textContainerInset/lineFragmentPadding the real
                    // NSTextView renders its glyphs at (`ComposerTextView.textContainerInset`) —
                    // without this the placeholder sat flush at (0,0) while the caret/first
                    // glyph render ~2pt right / 4pt down from there, so the placeholder visibly
                    // overlapped the caret (user report: "placeholder overlapping the caret").
                    Text("Ask Norma…")
                        .font(Typography.body())  // matches the HELD composer size above
                        .foregroundStyle(.white.opacity(0.5)) // difference-blend-safe placeholder
                        .padding(.leading, ComposerTextView.textContainerInset.width
                            + ComposerTextView.lineFragmentPadding)
                        .padding(.top, ComposerTextView.textContainerInset.height)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: max(22, min(composerContentHeight, morph.composerMaxHeight - 22)))
        }
        .padding(.horizontal, Self.contentHorizontalPadding)
        .padding(.vertical, Self.contentVerticalPadding)
    }

    private var showsClearButton: Bool {
        let hasText = !adapter.composerDraft
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
        return hasText && composerContentHeight >= 55
    }

    /// v2's inline-response shell (`Field/FieldView.swift`'s `inlineResponse`), ported into v1's
    /// composer chrome. Task B adds back `displayedPrompt`/`historyPositionText` (dropped by task
    /// A — see the file header's INLINE RESPONSE note): a swipe-pinned historical exchange now
    /// shows its own prompt small above the reply, plus an "n/m" position readout next to the
    /// draft-reveal chevron, exactly like the pre-transplant `Field/FieldView.swift` did.
    private var inlineResponse: some View {
        ZStack(alignment: .topTrailing) {
            // Wave-7 gate fix (item 1 root cause, two compounding bugs found empirically, in
            // order):
            //
            // (1) A `GeometryReader`/`PreferenceKey` measuring background that lives INSIDE a
            // `ScrollView`'s own content does not reliably re-fire once the ScrollView has
            // completed its first layout pass — confirmed empirically (live daemon run, real long
            // reply): the reported height latched at 0 (the very first "isThinkingOnly" placeholder
            // measurement) and never updated again even once a genuine multi-line reply replaced
            // it — `morph.responseHeight` stayed 0 forever, so the shell never grew past its floor.
            // First fix attempt: measure a hidden, NON-scrolling twin of the same content instead
            // (below) — confirmed via a raw diagnostic log directly inside the measuring
            // `GeometryReader`'s closure that this DOES correctly report a true, growing height on
            // every re-render (140 → 156 → 172… as a streamed reply grew).
            //
            // (2) But routing that correct, changing value through `.preference(key:value:)` +
            // an ancestor `.onPreferenceChange` never worked, at ANY ancestor tried (the immediate
            // `ZStack` below, and — a second attempt — `composerOrResponseContent`'s call site
            // above `GlassForegroundLegibility`'s `.compositingGroup()`): `onPreferenceChange`
            // fired exactly once per mount, always reporting the key's `defaultValue` (0), and
            // never again despite the producer visibly recomputing correct, changing values the
            // whole time (same raw-log evidence as above). This reproduces regardless of the
            // ScrollView entirely — the PreferenceKey plumbing itself is the unreliable part in
            // this view tree, not just the ScrollView-nested case from (1).
            //
            // FIX: bypass `PreferenceKey`/`onPreferenceChange` entirely and use `.onGeometryChange`
            // (the modern, direct replacement for this exact pattern) on the hidden twin — it reads
            // the view's own resolved geometry and invokes the action closure whenever the derived
            // value changes, with no bubbling required. This is measured live: log evidence below
            // confirms `morph.responseHeight` now tracks the growing reply and the shell grows with it.
            responseContentBody
                .frame(width: morph.composerWidth, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { newHeight in
                    OrbDebug.log("response content measured: \(newHeight)")
                    morph.responseHeight = newHeight
                    // Wave-9 gate fix: a changed height can shrink `maxResponseScrollOffset`
                    // below wherever the user had manually scrolled to (shorter swiped-in
                    // exchange, or — defensively — a reply that shrinks) — re-clamp from this
                    // side too, not just from `applyResponseScroll`'s own clamp on each delta.
                    morph.clampResponseScrollOffset()
                }
                .opacity(0)
                .accessibilityHidden(true)
                .allowsHitTesting(false)

            // Wave-9 gate fix (root cause — see `MorphModel.responseScrollOffset`'s doc): a plain
            // SwiftUI `ScrollView` here never actually scrolled — `GlassForegroundLegibility`'s
            // `.compositingGroup()` + `.blendMode(.difference)` (applied to the whole
            // composer/response layer, `composerMorphedContent` above) silently breaks the
            // AppKit-level hit-testing a real `NSScrollView` needs to receive `-scrollWheel:`,
            // confirmed live via synthesized CGEvent scroll probes (`OrbWindowController`'s local
            // scroll monitor logged every sample reaching it — proven in wave 8 — yet the
            // ScrollView's own offset never moved). Ported v1's fix instead of chasing the hit-test
            // gap: `OrbWindowController.applyResponseScroll(deltaY:)` now drives
            // `morph.responseScrollOffset` directly from the same scroll monitor, and this is a
            // manual, non-scrolling viewport that just renders wherever that offset points —
            // `.offset` + `.clipped()` are both pure SwiftUI rendering, unaffected by the
            // compositingGroup above them. `GeometryReader` still hands down the viewport's own
            // (== composerFinal's) height so short replies center instead of pinning to the top,
            // exactly as the `ScrollView` version did.
            GeometryReader { proxy in
                responseContentBody
                    // Wave-10 gate fix: geometry-trace hook (paired with the fix's doc on
                    // `composerOrResponseContent`'s frame above) — the content's ACTUAL rendered
                    // top edge relative to `normaResponseShellTrace` (the real on-screen shell
                    // viewport named there). A centered oversized child reads
                    // minY == -(content height − shell height) / 2 at rest; top-aligned reads
                    // minY == 0. Logged post-layout (`onGeometryChange`), so it reflects every
                    // frame/offset in this chain, not just this one node — this is the live
                    // measurement that proved the wave-10 root cause (`proxy.size.height` here
                    // reads the FULL reply height, not the shell's, once the fixedSize measurement
                    // twin above forces `inlineResponse`'s ZStack larger than the shell — SwiftUI
                    // then re-proposes that larger, final resolved size back down to this
                    // `GeometryReader` too) and (re-run after the fix) proves it's resolved.
                    .onGeometryChange(
                        for: CGFloat.self,
                        of: { $0.frame(in: .named("normaResponseShellTrace")).minY }
                    ) { minY in
                        OrbDebug.log(
                            "response content minY vs shell viewport: \(minY) "
                            + "(shellHeight=\(proxy.size.height), responseHeight=\(morph.responseHeight), "
                            + "offset=\(morph.responseScrollOffset))"
                        )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Short content centers within the available pill height; long content
                    // (natural height already >= proxy.size.height) is unaffected here and instead
                    // scrolls via the offset below, top-anchored, exactly as before.
                    .frame(minHeight: proxy.size.height, alignment: .center)
                    .offset(y: -morph.responseScrollOffset)
                    .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                    .clipped()
            }

            HStack(spacing: 6) {
                if let historyPositionText = adapter.historyPositionText {
                    Text(historyPositionText)
                        .font(Typography.tiny(.medium))
                        .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .modifier(GlassSurface(drawsBorder: false))
                }
                revealDraftButton
            }
            .padding(6)
        }
    }

    /// Wave-7 gate fix: the inline response's actual textual content (prompt + reply + shimmer/
    /// working-verb row + queued line), extracted so BOTH the hidden measurement twin and the
    /// real, visible `ScrollView` render the IDENTICAL view — see `inlineResponse`'s doc for why
    /// a second, non-scrolling copy is what actually measures the natural height now.
    @ViewBuilder
    private var responseContentBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let prompt = adapter.displayedPrompt {
                Text(prompt)
                    // Bound to the transcript's USER-message size (2026-08-13 orb ruling) —
                    // the echo of what you asked reads at the size the bubble renders.
                    .font(Typography.fieldUserMessage(.medium))
                    .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !replyText.isEmpty {
                Text(replyText)
                    // Bound to the transcript's ASSISTANT size (2026-08-13 orb ruling).
                    .font(Typography.fieldAssistantMessage())
                    // GATE-3 F6b: under GlassForegroundLegibility's difference blend,
                    // .primary is BLACK in Light mode -> |0 - bg| = bg -> invisible.
                    // Pure white is the only correct foreground here (same rule as the
                    // composer text and thinking pill; see the F2 comment below).
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if isThinkingOnly {
                shimmerRow
            }
            // Wave-5 gate item 2: a message sent mid-turn is folded silently into the
            // prompt above — this line is the only visible confirmation it was
            // actually accepted and is waiting for the next round boundary, not lost.
            if let queuedText = adapter.queuedText {
                Text("⧗ \(queuedText)")
                    .font(Typography.caption())
                    .foregroundStyle(.white.opacity(0.5)) // difference-blend-safe, dimmed
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // Same leading/trailing/vertical insets as `composerContent` (see the shared
        // constants above the type header) — `textLeadingInset` reserves the exact
        // same 12+26+8 gutter the composer's icon column occupies, so this text's
        // leading edge lands on the SAME x as composer text; the trailing/vertical
        // paddings mirror the composer's outer 12h/6v exactly.
        .padding(.leading, Self.textLeadingInset)
        .padding(.trailing, Self.contentHorizontalPadding)
        .padding(.vertical, Self.contentVerticalPadding)
    }

    /// v1's `onTextFieldRightEdge` seam (see file header), ported as a visible trailing chevron
    /// rather than a caret-position-triggered key handler (there is no caret-navigation surface
    /// left to trigger it — see FOCUS COORDINATOR note).
    private var revealDraftButton: some View {
        Button {
            adapter.showingDraft = true
        } label: {
            Image(systemName: "chevron.left")
                .font(Typography.label(.semibold))
                .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
    }

    /// Wave-7 gate item 2: the collapsed orb's status pill (`FieldThinkingPill`) shows the
    /// CC-style whimsical working verb ("Reticulating…") — this expanded-shell counterpart used
    /// to show a bare, static "…" regardless, never the actual verb. Now shows the SAME animated
    /// treatment (leading star spinner + sweeping sheen, `adapter.isWorkingVerb`-gated exactly
    /// like the collapsed pill) so the verb reads consistently whichever surface is showing it.
    /// v1 LAW (PointerRenderer.swift:28-39): `WorkingSpinnerGlyph`/`SheenText` each scope their
    /// own animation state INSIDE their own view, not on an outer view here, so neither gets
    /// canceled by an unrelated transaction (e.g. the reply text arriving). No `.drawingGroup()`
    /// anywhere in this file either — that would rasterize and freeze them.
    private var shimmerRow: some View {
        HStack(spacing: 4) {
            if adapter.isWorkingVerb {
                WorkingSpinnerGlyph(font: Typography.control(.semibold))
                SheenText(text: adapter.statusText, font: Typography.control(.semibold))
                    .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
            } else {
                // Override pills (disconnected/needs approval) or an edge-case empty caption:
                // plain, unanimated text — same convention as `FieldThinkingPill`'s `animated`
                // gate.
                Text(adapter.statusText.isEmpty ? "…" : adapter.statusText)
                    .font(Typography.control(.semibold))
                    .foregroundStyle(.white.opacity(0.65)) // difference-blend-safe secondary
            }
        }
    }

    // MARK: Nav pill segments (v1 GlassFieldView.swift:988-1009 read settings/autoRaise/
    // keepAwake feature toggles that don't exist in v2 yet — see the file header's CUT note)

    /// v1's segments all read `appState` feature toggles that don't exist in v2 — the nav pill's
    /// CHROME (`NavigationPill`/`SegmentCell`/`NativeGlassCapsuleSurface`, and the split-phase
    /// morph driving it above) is kept verbatim so a later wave can populate real segments; there
    /// is simply nothing to show yet, so this is empty and the pill doesn't render (see the
    /// `!navSegments.isEmpty` guards above).
    private var navSegments: [NavigationPill.Segment] { [] }

    // MARK: Layout helpers (v1 GlassFieldView.swift:1014-1119, minus dashboard/image variants)

    /// Clamp the content-measured text height into the composer pill range.
    private func clampedComposerHeight() -> CGFloat {
        let chromeHeight: CGFloat = 22 // vertical padding on the HStack
        let pillHeight = composerContentHeight + chromeHeight
        return min(morph.composerMaxHeight,
                   max(morph.composerMinHeight, pillHeight))
    }

    /// Wave-5 gate item 3: the window's own remaining vertical room for the shell's content —
    /// window height minus `haloPadding` on both the top and bottom edges (the breathing halo's
    /// clearance, see `MorphModel.haloPadding`'s doc) minus the nav pill + inter-pill gap reserved
    /// above it (mirrors `composerFinalRect`'s own `P + navOffset` top reservation for `.topLeft`,
    /// the only corner in play — see `MorphModel.corner`'s doc). This is the response shell's
    /// growth ceiling; anything the content wants beyond it keeps scrolling internally instead
    /// (the `ScrollView` in `inlineResponse` already handles that, unchanged by this wave).
    private func maxShellHeight(in windowSize: CGSize) -> CGFloat {
        let reserved = 2 * morph.haloPadding + morph.navPillHeight + morph.interPillGap
        return max(morph.composerMinHeight, windowSize.height - reserved)
    }

    /// Clamp the live-measured response content height (`morph.responseHeight`, fed by
    /// `inlineResponse`'s background `GeometryReader` — see that property's doc) into the pill
    /// range: never smaller than the composer's own minimum (so the shell doesn't shrink below
    /// the standard pill height for a one-line reply), never taller than `maxShellHeight(in:)`.
    private func clampedResponseHeight(in windowSize: CGSize) -> CGFloat {
        min(maxShellHeight(in: windowSize), max(morph.composerMinHeight, morph.responseHeight))
    }

    /// Final (settled) composer rectangle in window SwiftUI coords. The composer is always
    /// sandwiched under the nav pill (above) — v1 also reserved a screenshot-pill slot below for
    /// bottom corners (GlassFieldView.swift:1037-1041); that reservation is gone since images are
    /// cut, so bottom corners now just sit flush against the window bottom.
    private func composerFinalRect(in windowSize: CGSize, height: CGFloat) -> CGRect {
        let width = morph.composerWidth
        let P = morph.haloPadding
        let navOffset = morph.navPillHeight + morph.interPillGap
        let x: CGFloat = morph.corner.isLeft ? P : (windowSize.width - P - width)
        let y: CGFloat
        if morph.corner.composerOnTop {
            // Orb is at composer's top corner; nav pill sits above it.
            y = P + navOffset
        } else {
            // Orb is at composer's bottom corner; composer sits at the window bottom.
            y = windowSize.height - P - height
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Nav pill rectangle in window SwiftUI coords. Always sits ABOVE the
    /// composer (smaller SwiftUI y), aligned to the same horizontal edge.
    private func navPillFinalRect(in windowSize: CGSize, composerFinal: CGRect) -> CGRect {
        let width = min(morph.navPillMaxWidth, composerFinal.width - 40)
        let height = morph.navPillHeight
        let x: CGFloat = morph.corner.isLeft
            ? composerFinal.minX + height + morph.interPillGap
            : composerFinal.maxX - width
        let y = composerFinal.minY - morph.interPillGap - height
        return CGRect(x: x, y: y, width: width, height: height)
    }

    // MARK: Morph geometry (v1 GlassFieldView.swift:1204-1262, dashboard variants dropped)

    /// The current composer rectangle for the given morph progress. At
    /// progress=0 it's a small bubble centered on the orb; at progress=1 it's
    /// the final composer rect docked at the chosen corner.
    private func morphedComposerRect(
        orbPoint: CGPoint,
        finalRect: CGRect,
        progress: Double
    ) -> CGRect {
        let p = max(0, min(1, progress))
        let bubbleSize = morph.orbBubbleSize
        let heightProgress = CGFloat(smoothstep(0.0, 0.42, p))
        let widthProgress = CGFloat(smoothstep(0.10, 0.48, p))
        let travelProgress = CGFloat(smoothstep(0.08, 0.48, p))

        let width = bubbleSize + (finalRect.width - bubbleSize) * widthProgress
        let height = bubbleSize + (finalRect.height - bubbleSize) * heightProgress

        let centerX = orbPoint.x + (finalRect.midX - orbPoint.x) * travelProgress
        let centerY = orbPoint.y + (finalRect.midY - orbPoint.y) * travelProgress

        return CGRect(
            x: centerX - width / 2,
            y: centerY - height / 2,
            width: width,
            height: height
        )
    }

    /// Corner radius is circular at bubble size; transitions into the fixed
    /// pill radius as the shape grows.
    private func morphedCornerRadius(for rect: CGRect) -> CGFloat {
        let shorter = min(rect.width, rect.height)
        let circleRadius = shorter / 2
        let pillRadius = min(shorter / 2, 22)
        let t = min(1, max(0, (shorter - 48) / 60))
        return circleRadius * (1 - t) + pillRadius * t
    }
}

// MARK: - Chat/expand button geometry (GATE r1 FIX F3)

/// v1's `chatButtonFinalRect(navFinal:)` (GlassFieldView.swift:1058-1066), verbatim math: a
/// square button sized to the nav pill's own height, sitting `interPillGap` to its left at the
/// same y. `navPillFinalRect(in:composerFinal:)` (`NormaFieldView`, private above) already
/// reserves this exact gap on its `corner.isLeft` branch (`composerFinal.minX + height +
/// interPillGap`) — that's what v1 did too (GlassFieldView.swift:1051-1052) — so on that branch
/// this rect lands flush with `composerFinal`'s own left edge, still fully inside the window. On
/// the `!corner.isLeft` branch `navPillFinalRect` doesn't reserve the gap (its nav pill hugs
/// `composerFinal.maxX` directly), but with the default `MorphModel` constants the nav pill's own
/// width cap (`min(navPillMaxWidth, composerFinal.width - 40)` = 300, short of the composer's
/// 360pt width by 60pt) leaves 60pt of slack between the nav pill's leading edge and
/// `composerFinal.minX` — comfortably more than this button's `size + gap` (34 + 8 = 42pt) — see
/// `ChatButtonGeometryTests`, so the button still lands inside `composerFinal` — and therefore
/// inside the window — on both corner variants. `morph.corner` is pinned at `.topLeft` forever
/// (`isLeft` always true) per `MorphModel.corner`'s own doc, so only the first branch is live
/// today; this stays correct for the dormant branch too, matching v1's own single, corner-agnostic
/// formula (no explicit `isLeft` check inside `chatButtonFinalRect` itself, there or here — the
/// corner-awareness is entirely inherited from whichever `navFinal` the caller passes in).
///
/// Extracted as a free, top-level function (rather than a private `NormaFieldView` method, unlike
/// `navPillFinalRect`) so it's directly unit-testable without constructing a full
/// `NormaFieldView`/`FieldStateAdapter`/`FluidModel` — same convention as `fenceAnchorForTopLeftCorner`
/// (`FieldKit/FieldCorner.swift`) and `followerTargetOrigin` (`Orb/OrbFollower.swift`).
func chatButtonFinalRect(navFinal: CGRect, interPillGap: CGFloat) -> CGRect {
    let size = navFinal.height
    return CGRect(
        x: navFinal.minX - interPillGap - size,
        y: navFinal.minY,
        width: size,
        height: size
    )
}

// MARK: - Child-status circles (Dispatch, Phase 7, Task 8)

/// Ring/fill color for one child circle — attention accent for a child waiting on the human
/// (matches `adapter.interactionNeeded`'s own amber, `NormaFieldView.swift:584`, since a mirrored
/// child approval/question surfaces through the exact same pending-interaction path), an error
/// tint for a child that blew up, plain white (same default as every other foreground glyph in
/// this file) for a running/queued child — no separate color for "running"; `childPulse` below is
/// what distinguishes it instead.
private func childRingColor(_ status: String) -> Color {
    switch status {
    case "awaiting_approval", "awaiting_input": return Color(red: 1.0, green: 0.72, blue: 0.30)
    case "error": return Color(red: 1.0, green: 0.35, blue: 0.35)
    default: return .white
    }
}

/// A running child's ring breathes so it reads as "actively working" among its static siblings.
/// Mirrors `chevronPulse`'s own convention exactly (`NormaFieldView.swift:104-113`'s doc — v1 LAW:
/// a `repeatForever` animation's state stays scoped to the view chain that owns it, never hoisted
/// onto an outer/ancestor view) rather than a raw `withAnimation` call at the ForEach call site,
/// which would hoist the animation's state onto `NormaFieldView` itself and, worse, fire it fresh
/// on every one of the field's own high-frequency re-renders (the adapter republishes on every
/// session-state change while a turn runs — see `FieldStateAdapter.init`'s doc) instead of once
/// per child on its own false→true transition. Scoped as a private `ViewModifier` with its own
/// `@State` (one instance per `ForEach` row, keyed off `child.id` — same identity the ForEach
/// already establishes) so each child's pulse starts/stops independently of its siblings and of
/// the field's own re-renders.
private struct ChildPulse: ViewModifier {
    let active: Bool
    @State private var pulseOn = false

    func body(content: Content) -> some View {
        content
            .opacity(pulseOn ? 1.0 : 0.55)
            .animation(
                active ? .easeInOut(duration: 1.2).repeatForever(autoreverses: true) : .default,
                value: pulseOn
            )
            .onChange(of: active, initial: true) { _, isActive in pulseOn = isActive }
    }
}

private func childPulse(active: Bool) -> some ViewModifier {
    ChildPulse(active: active)
}

// MARK: - GlassForegroundLegibility (v1 GlassFieldView.swift:1285-1291, verbatim)

/// Inverts the foreground (icons, text, strokes) against whatever is
/// behind the field window using `.blendMode(.difference)`. With a pure
/// white source — see `GlassChromeColor` and its foreground colors —
/// `white − bg = inverse(bg)` per channel, so the chrome reads as the
/// inverse of the glass surface beneath it.
///
/// `.compositingGroup()` flattens the wrapped subtree first so internal
/// stacking (icon over its focus pill, text in a cell with a divider
/// next to it) doesn't difference-blend against itself. Without it, the
/// blend would compose layer-by-layer inside the subtree and produce
/// odd colour stacking instead of one clean inversion.
private struct GlassForegroundLegibility: ViewModifier {
    func body(content: Content) -> some View {
        content
            .compositingGroup()
            .blendMode(.difference)
    }
}

// MARK: - Nav pill (v1 GlassFieldView.swift:1900-1959, `Segment.id` retyped — see below)

/// GlassEffectID has to live on the actual view receiving `.glassEffect`.
/// Keeping these material-only shapes inside GlassEffectContainer lets the
/// system morph the glass while the foreground text/icons stay above it.
private struct NativeGlassCapsuleSurface: View {
    let id: String
    let namespace: Namespace.ID
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Capsule(style: .continuous)
            .fill(Color.clear)
            .frame(width: width, height: height)
            .glassEffect(.regular, in: Capsule(style: .continuous))
            .glassEffectID(id, in: namespace)
            .glassEffectTransition(.matchedGeometry)
    }
}

/// v1's `NavigationPill` (GlassFieldView.swift:1835-1893), verbatim except `Segment.id`: v1 typed
/// it `FieldFocusCoordinator.Target` (the keyboard-focus target enum); with that coordinator
/// stubbed (see file header), there is no such type here, so `id` is a plain `String`.
private struct NavigationPill: View {
    struct Segment: Identifiable {
        let id: String
        let icon: String
        let label: String
        let isOn: Bool
        var showsLabel: Bool = true
    }

    let segments: [Segment]
    let focusedID: String?
    var activeFill: Color = Color.white.opacity(0.18)
    var drawsGlass: Bool = true
    var contentOpacity: Double = 1
    var drawsBorder: Bool = true
    var surfaceSize: CGSize?

    @ViewBuilder
    var body: some View {
        if drawsGlass {
            sizedContent
                .modifier(GlassSurface(cornerRadius: 22, drawsBorder: drawsBorder))
        } else {
            sizedContent
                .overlay(borderOverlay)
        }
    }

    private var sizedContent: some View {
        content
            .frame(width: surfaceSize?.width, height: surfaceSize?.height)
    }

    private var content: some View {
        HStack(spacing: 0) {
            ForEach(segments) { segment in
                SegmentCell(
                    icon: segment.icon,
                    label: segment.label,
                    isOn: segment.isOn,
                    isFocused: focusedID == segment.id,
                    showsLabel: segment.showsLabel,
                    activeFill: activeFill
                )
            }
        }
        .opacity(contentOpacity)
        .padding(.horizontal, 3)
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private var borderOverlay: some View {
        if drawsBorder {
            Capsule(style: .continuous)
                .strokeBorder(Color.white.opacity(0.5), lineWidth: 1)
        }
    }
}

private struct SegmentCell: View {
    let icon: String
    let label: String
    let isOn: Bool
    let isFocused: Bool
    let showsLabel: Bool
    let activeFill: Color
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(Typography.caption(.medium))
            if showsLabel {
                Text(label)
                    .font(Typography.caption(.medium))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .foregroundStyle(foregroundColor)
        .accessibilityLabel(label)
        .padding(.horizontal, showsLabel ? 10 : 8)
        .padding(.vertical, 5)
        .background(
            Capsule(style: .continuous)
                .fill(backgroundFill)
        )
        .contentShape(Rectangle())
    }

    private var foregroundColor: Color {
        if isFocused { return GlassChromeColor.focusedForeground }
        if isOn { return GlassChromeColor.accent }
        return GlassChromeColor.secondaryForeground(for: colorScheme)
    }

    private var backgroundFill: Color {
        if isOn {
            return activeFill
        }
        return .clear
    }
}

// MARK: - FieldThinkingPill (GATE-4 item 3: de-pilled — was v1 GlassFieldView.swift:2563-2595,
// a Capsule with glass/stroke chrome behind the caption; now bare text, no chrome at all)

/// The collapsed-orb status readout ("thinking…", "☑ n/m working…", "disconnected", …). No
/// longer a literal pill — GATE-4 item 3 removes the capsule glass/stroke chrome v1 drew behind
/// this text; a floating label reads better next to the (also chrome-free) orb than a second
/// small chip would. Legibility comes entirely from `GlassForegroundLegibility`'s difference
/// blend at the call site (pure white in, inverted against whatever's behind the field — see
/// that modifier's doc), the same mechanism every other label in this file relies on.
private struct FieldThinkingPill: View {
    /// Cap on the label's width before `lineLimit`/`truncationMode` kick in. Also the width of
    /// the fixed (invisible) alignment box `NormaFieldView.composerMorphedContent` pins this to
    /// (see `thinkingBoxCenter`'s doc in `composerBody`) — sizing that box to the same cap means
    /// a long caption grows only toward the box's far edge, never back past the pinned near edge.
    static let maxWidth: CGFloat = 220
    /// Height of that same fixed alignment box. Purely a layout constant (this view has no
    /// visible chrome to size) — keeps the label vertically centered on the same row the old
    /// capsule occupied.
    static let height: CGFloat = 28

    var caption: String = "thinking..."
    var contentOpacity: Double = 1
    /// Wave-7 gate item 2: true exactly while `caption` is the CC-style working-verb composition
    /// (`FieldStateAdapter.isWorkingVerb`) — gates the animated leading star spinner + sweeping
    /// sheen text. The override pills (`disconnected`/`needs approval`) pass `false` and keep the
    /// original plain, unanimated text.
    var animated: Bool = false

    var body: some View {
        // White (not .primary) so the outer GlassForegroundLegibility
        // wrap produces a clean inversion. `.primary` resolves to
        // black in light mode and white in dark mode, which is
        // already the inverse of the typical glass background —
        // diff-blending it would yield near-white in both modes.
        HStack(spacing: 4) {
            if animated {
                WorkingSpinnerGlyph(font: Typography.caption(.medium))
                SheenText(text: caption, font: Typography.caption(.medium))
                    .foregroundStyle(.white)
            } else {
                Text(caption)
                    .font(Typography.caption(.medium))
                    .foregroundStyle(.white)
            }
        }
        .lineLimit(1)
        .truncationMode(.tail)
        .opacity(contentOpacity)
        // `alignment: .leading` (not the frame default `.center`) so the text itself hugs
        // this view's own leading edge rather than centering inside the width cap below —
        // paired with the fixed leading-aligned box at the call site, this is what makes a
        // SHORT caption sit flush at the pinned near-edge anchor instead of floating
        // somewhere in the middle of unused width.
        .frame(maxWidth: Self.maxWidth, alignment: .leading)
        .fixedSize(horizontal: true, vertical: true)
    }
}

// MARK: - FieldCountChip (gate polish: task-count chip for the left side of the orb)

/// The task-count chip positioned to the left of the collapsed orb ("☑ 1/4", "☑ 3/5", etc.).
/// Bare text, no chrome, same legibility mechanism as `FieldThinkingPill`.
private struct FieldCountChip: View {
    /// Cap on the label's width before `lineLimit`/`truncationMode` kick in.
    static let maxWidth: CGFloat = 80
    /// Height of the alignment box. Keeps the chip vertically centered on the orb row.
    static let height: CGFloat = 28

    var caption: String = ""
    var contentOpacity: Double = 1

    var body: some View {
        Text(caption)
            .font(Typography.caption(.medium))
            .foregroundStyle(.white)
            .lineLimit(1)
            .truncationMode(.tail)
            .opacity(contentOpacity)
            // Align to the trailing edge so the chip grows leftward (away from the orb).
            .frame(maxWidth: Self.maxWidth, alignment: .trailing)
            .fixedSize(horizontal: true, vertical: true)
    }
}

// MARK: - WorkingSpinnerGlyph / SheenText (wave-7 gate item 2: CC-style animated working verb)

/// Claude Code's own terminal spinner cycles through this exact star-frame sequence at roughly
/// 8fps. `TimelineView(.periodic(from:by:))` derives the current frame purely from wall-clock
/// time — no `@State` counter, no `withAnimation` — so the spinner pauses/stops the instant this
/// view is removed from the tree (both call sites are already condition-gated on
/// `adapter.isWorkingVerb`/`isThinkingOnly`, so it disappears the moment the turn ends), matching
/// the "stop when the turn ends" requirement with no extra plumbing needed.
private struct WorkingSpinnerGlyph: View {
    static let frames: [String] = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
    static let frameInterval: TimeInterval = 1.0 / 8.0

    var font: Font

    var body: some View {
        TimelineView(.periodic(from: .now, by: Self.frameInterval)) { context in
            let tick = Int(context.date.timeIntervalSinceReferenceDate / Self.frameInterval)
            let index = ((tick % Self.frames.count) + Self.frames.count) % Self.frames.count
            Text(Self.frames[index])
                .font(font)
                .foregroundStyle(.white) // difference-blend-safe, same convention as every glyph here
        }
    }
}

/// v1's sweeping-sheen mechanism — ported from the pre-transplant `Orb/OrbView.swift`'s
/// `statusPill(_:)` ("v1 thinking pill with the sweeping sheen, generalized to any status text"),
/// the "old thinking pill" this wave's brief points at. A `LinearGradient` masked to the text's
/// own glyphs sweeps across, driven by a repeating `sweep` state var, blended `.plusLighter` so it
/// only ever brightens — difference-blend-safe (white family only), matching the outer
/// `GlassForegroundLegibility` convention every other label in this file already follows.
/// v1 LAW (PointerRenderer.swift:28-39): the animation lives INSIDE this Group, not on an outer
/// view, so an unrelated transaction (e.g. the reply text arriving) never cancels it. No
/// `.drawingGroup()` either — would rasterize and freeze the sweep.
private struct SheenText: View {
    var text: String
    var font: Font

    @State private var sweep = 0.0

    var body: some View {
        Group {
            Text(text)
                .font(font)
                .overlay(
                    GeometryReader { proxy in
                        let w = proxy.size.width
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.85), .clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: w * 0.55)
                        .offset(x: -w * 0.55 + w * 1.1 * sweep)
                        .blendMode(.plusLighter)
                    }
                    .mask(Text(text).font(font))
                )
        }
        .onAppear {
            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                sweep = 1.0
            }
        }
    }
}

// MARK: - FieldIconButton (v1 GlassFieldView.swift:2599-2613, verbatim)

private struct FieldIconButton: View {
    var icon: String
    var isFocused: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Image(systemName: icon)
            .font(Typography.control(.medium))
            .foregroundStyle(isFocused ? GlassChromeColor.focusedForeground : GlassChromeColor.secondaryForeground(for: colorScheme))
            .frame(width: 26, height: 26)
            .background(
                Circle().fill(Color.clear)
            )
    }
}

// MARK: - GlassChromeColor (v1 GlassFieldView.swift:2628-2641, verbatim)

/// Shared foreground/accent palette for all controls drawn on top of the
/// Liquid Glass surfaces. Composer text uses the same all-white source as
/// this palette (`Field/ComposerTextView.swift`'s `textColor`/typing
/// attributes) — GATE-3 FIX (F2): an earlier revision of this comment
/// claimed `ComposerTextView` used `.labelColor` because it "isn't drawn
/// through `GlassForegroundLegibility`'s difference blend"; that premise was
/// false — `composerOrResponseContent` above (which hosts `ComposerTextView`
/// while composing) IS wrapped in `.modifier(GlassForegroundLegibility())`
/// just like every other layer here, so `.labelColor` washed out to
/// near-invisible text under the difference blend (the exact "washed-out
/// full white symptom" the paragraph below describes). Fixed to `.white`.
///
/// Every glyph/label colour here is **pure white** — no light/dark-mode
/// branching. The chrome is rendered through `GlassForegroundLegibility`
/// (`.blendMode(.difference)`), and difference inverts cleanly only when
/// the source is white (`white − bg = inverse(bg)` per channel). Any
/// non-white source would push the result toward muddy mid-tones in one
/// of the two appearances. Colour-coded states survive through separate
/// normal-colour glow/fill layers underneath this foreground subtree.
private enum GlassChromeColor {
    static let focusedForeground = Color.white
    /// White so the "on" label/icon stays readable after the difference
    /// blend. The active capsule underneath carries the user accent.
    static let accent = Color.white
    static let divider = Color(nsColor: .systemGray).opacity(0.28)

    /// White in both appearances. The `colorScheme` parameter is kept
    /// in the signature so call sites that pass `@Environment(\.colorScheme)`
    /// don't have to be touched if we ever reintroduce a per-mode tint.
    static func secondaryForeground(for colorScheme: ColorScheme) -> Color {
        Color.white
    }
}
