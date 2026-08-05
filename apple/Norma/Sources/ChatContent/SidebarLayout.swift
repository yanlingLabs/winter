/// 2e-iii: pure width engine for the chat window's two sidebars. Thresholds derive from three
/// constants; BELOW the both-fit width AT MOST ONE sidebar is visible (user rule: opening one via
/// its chevron collapses the other), with the RIGHT side winning ties (right-first reveal).
///
/// Overlays are TAP-ONLY (fix: expanded-but-unfit collapses to a chevron, never auto-overlays —
/// SPEC: "when a sidebar doesn't fit, its edge chevron stays visible and TAPPING it slides the
/// sidebar OVER the content temporarily"). The `expanded` flags are an INLINE-visibility preference
/// only; an OVERLAY appears solely from an explicit `overlayOpen` request while that side does not
/// fit inline. See `resolveSidebars`.
let sidebarLeftWidth: CGFloat = 220
let sidebarRightWidth: CGFloat = 260
let sidebarContentMinWidth: CGFloat = 520

/// gate-feedback-1 FIX C: the edge-chevron affordances (`WindowContentView.sidebarChevron`) used
/// to render their glyph vertically CENTERED across the full column height, which read oddly next
/// to the top-aligned header/sidebars. Now top-anchored: the glyph sits this many points below the
/// content's `topInset` (roughly level with the header row, `chatWindowHeaderHeight` = 30 —
/// `WindowSurfaceView.swift`). Visual-only — the hit target itself is unchanged (still the FULL
/// column height via `.frame(maxHeight: .infinity)`; only the glyph's position within it moves),
/// same horizontal edges (left chevron on the left edge, right chevron on the right edge).
let sidebarChevronTopOffset: CGFloat = 14

struct EffectiveSidebars: Equatable {
    var leftVisible: Bool
    var rightVisible: Bool
    var leftOverlay: Bool
    var rightOverlay: Bool
}

/// The FOUR raw sidebar flags the view holds and the chevron/dismiss helpers transform. Kept as one
/// value so a single `@State` drives the whole layout and the pure helpers can be unit-tested
/// end-to-end (`SidebarRelocationTests`). `expanded` = INLINE-visibility preference; `overlayOpen` =
/// an explicit tap-open overlay request (honored only while that side doesn't fit inline).
struct SidebarState: Equatable {
    var leftExpanded: Bool
    var rightExpanded: Bool
    var leftOverlayOpen: Bool
    var rightOverlayOpen: Bool
}

/// Resolves the two sidebars' EFFECTIVE state from the measured width plus the four raw flags.
///
/// - `leftExpanded`/`rightExpanded` — the INLINE-visibility preference ONLY. A side that's expanded
///   but too narrow to sit inline collapses to a CHEVRON; it NEVER auto-opens as an overlay.
/// - `leftOverlayOpen`/`rightOverlayOpen` — an EXPLICIT (chevron-tap) overlay request, honored ONLY
///   while that side does NOT fit inline (an overlay never appears where the side could be inline).
///
/// Below the both-fit width AT MOST ONE side is visible (mutual exclusion, RIGHT wins ties), and a
/// visible OVERLAY there also excludes the other side entirely. Overlays: at most one, right wins
/// ties. `leftVisible`/`rightVisible` count an overlay as visible (the relocation/never-duplicate
/// gate reads them).
func resolveSidebars(width: CGFloat,
                     leftExpanded: Bool,
                     rightExpanded: Bool,
                     leftOverlayOpen: Bool = false,
                     rightOverlayOpen: Bool = false) -> EffectiveSidebars {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let rightAloneFits = width >= sidebarContentMinWidth + sidebarRightWidth
    let leftAloneFits = width >= sidebarContentMinWidth + sidebarLeftWidth

    // --- Inline: expanded ∧ fits. Below both-fit, mutual exclusion with the right winning ties.
    //     An expanded side that doesn't fit inline shows NOTHING here (a chevron in the view).
    var leftInline = false
    var rightInline = false
    if bothFit {
        leftInline = leftExpanded
        rightInline = rightExpanded
    } else if rightExpanded && rightAloneFits { // right wins ties — right-first reveal
        rightInline = true
    } else if leftExpanded && leftAloneFits {
        leftInline = true
    }

    // --- Overlay: explicit tap-open ∧ does NOT fit inline. At most one; right wins ties.
    let rightOverlay = rightOverlayOpen && !rightAloneFits
    var leftOverlay = leftOverlayOpen && !leftAloneFits
    if rightOverlay { leftOverlay = false } // right wins ties

    // Below both-fit, a visible overlay excludes the other side entirely (mutual exclusion).
    if !bothFit {
        if rightOverlay { leftInline = false }
        if leftOverlay { rightInline = false }
    }

    return EffectiveSidebars(
        leftVisible: leftInline || leftOverlay,
        rightVisible: rightInline || rightOverlay,
        leftOverlay: leftOverlay,
        rightOverlay: rightOverlay
    )
}

/// app-shell T3: the raw flags a SURFACE's configuration is allowed to express, applied before
/// `resolveSidebars` ever sees them. Today there is exactly one axis — whether this surface hosts
/// the LEFT session switcher at all (`SidebarWiring.showsSessionSwitcher`) — and exactly two
/// configurations: the pre-existing both-sidebars one, and the shell's right-only one.
///
/// A MASK rather than a second width engine, deliberately. The right column's own thresholds,
/// mutual exclusion, tie-breaking and tap-only overlays are all `resolveSidebars`' rules, and a
/// right-only surface must obey exactly the same ones — feeding it `leftExpanded: false` is what
/// makes that true by construction instead of by a parallel implementation that drifts. With the
/// left flags cleared, `resolveSidebars`' below-both-fit branch reduces to "the right shows inline
/// whenever content+right fits", which is precisely the right-only layout.
///
/// `showsSessionSwitcher: true` returns the state UNCHANGED — the identity every pre-existing
/// surface gets (see `SidebarWiring`'s own doc comment), pinned by `SidebarLayoutTests`.
func sidebarStateForConfiguration(_ state: SidebarState, showsSessionSwitcher: Bool) -> SidebarState {
    guard !showsSessionSwitcher else { return state }
    var out = state
    out.leftExpanded = false
    out.leftOverlayOpen = false
    return out
}

/// Chevron tap semantics: below both-fit, EXPANDING one side collapses the other (never two);
/// collapsing a side never force-opens the other. At both-fit widths the sides are independent.
func toggleLeftSidebar(leftExpanded: Bool, rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let newLeft = !leftExpanded
    return (newLeft, (bothFit || !newLeft) ? rightExpanded : false)
}

func toggleRightSidebar(leftExpanded: Bool, rightExpanded: Bool, width: CGFloat) -> (left: Bool, right: Bool) {
    let bothFit = width >= sidebarContentMinWidth + sidebarLeftWidth + sidebarRightWidth
    let newRight = !rightExpanded
    return ((bothFit || !newRight) ? leftExpanded : false, newRight)
}
