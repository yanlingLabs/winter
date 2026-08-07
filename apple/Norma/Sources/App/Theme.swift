import SwiftUI

/// The Mac half of Norma's brand palette and type register — the sibling of
/// `norma-ios/Norma/App/Theme.swift`, which it mirrors name-for-name.
///
/// Canonical values and the reasoning behind them live in `docs/brand.md`. Per that document's
/// anti-rule (carried from the iOS design gallery), Swift NEVER hardcodes a hex literal for UI
/// chrome: colors are named asset-catalog entries (`Assets.xcassets`, light + dark authored
/// there) or a reuse of a system semantic color. `Theme` only ever *names* a color; it never
/// computes one.
///
/// The eleven mirrored values were transcribed from the iOS **asset JSON**, never from that
/// file's doc comments — some of those have drifted from the assets they describe (its
/// `SelectionPill` comment says light `#EDEBE6`; the asset is `#E8E6E1`). `docs/brand.md` § 6
/// records the full drift and names the asset JSON as canonical.
enum Theme {
    // MARK: - Color: the eleven mirrored from iOS

    /// The base plane — warm cream in light, warm charcoal in dark. On the Mac this backs the
    /// SIDEBAR: the sidebar is the base plane and the content is the raised card above it,
    /// exactly the phone's reveal-shell relationship (`docs/brand.md` § the plane mapping).
    static let canvas = Color("Canvas")

    /// The raised plane above `canvas` — on the Mac, the CONTENT side of the shell. Brighter
    /// than `canvas` in BOTH appearances; that difference IS the sidebar/content separation, and
    /// the hairline is only secondary. Pinned by `SidebarBrandTests`.
    static let cardSurface = Color("CardSurface")

    /// The selected row's fill. NOTE it is DARKER than the pane in dark mode (#0B0B0B on
    /// #181816) — Claude's measured semantics, which iOS adopted deliberately (a semantic system
    /// fill cannot express "darker than background", which is exactly why it is an asset). This
    /// is intentional, and differs from ChatGPT, whose selected row is lighter than its pane.
    static let selectionPill = Color("SelectionPill")

    /// Tool-output / approval-card container fill, one step up from the card.
    /// NOT YET USED on Mac — ported for the chat-surface pass.
    static let elevatedSurface = Color("ElevatedSurface")

    /// Small-control fill (composer circles, model pills). NOT YET USED on Mac.
    static let controlSurface = Color("ControlSurface")

    /// The user's own messages — a neutral warm chip grey, deliberately not an accent tint.
    /// NOT YET USED on Mac.
    static let bubbleUser = Color("BubbleUser")

    /// The composer card's opaque face. NOT YET USED on Mac.
    static let composerSurface = Color("ComposerSurface")

    /// The composer's bright hairline; the alpha lives in the asset (0.90 light / 0.08 dark) so
    /// Swift never computes it. NOT YET USED on Mac.
    static let composerRim = Color("ComposerRim")

    /// The muted warm meta grey — section labels, quiet meta rows, trailing glyphs. `.secondary`
    /// renders cooler and lighter on the warm canvas, which is why this is an asset instead.
    static let textMuted = Color("TextMuted")

    /// The base plane of the OPPOSITE appearance — the primary-action trick (a pill that reads
    /// cream in dark and charcoal in light). NOT YET USED on Mac.
    static let inverseCanvas = Color("InverseCanvas")

    /// Brand tint — a muted blue-green teal. **Deliberately tints nothing in this pass**: the
    /// iOS ruling is that the accent stays out of the sidebar, and
    /// `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` is left UNSET so that naming a colorset
    /// `AccentColor` does not silently retint every system control in the app.
    static let accent = Color("AccentColor")

    // MARK: - Color: the three Mac-only tokens

    /// The hover fill. Mac-only BY NECESSITY — the phone has no hover state. Interpolated
    /// between `canvas` and `selectionPill` in both appearances, so hover → selected reads as
    /// ONE ramp rather than two unrelated tints.
    static let rowHover = Color("RowHover")

    /// The sidebar/content divider. Mac-only — the phone has no window-internal divider. A warm
    /// value because the system `separatorColor` is cool and fights the cream.
    static let hairline = Color("Hairline")

    /// The search palette's floating face. Mac-only — the phone has no such surface. Brighter
    /// than `cardSurface` in both appearances (the palette floats ABOVE content).
    /// `elevatedSurface` cannot serve here: its light value is a retained cool system grey that
    /// is DARKER than `cardSurface` — the wrong direction.
    static let paletteSurface = Color("PaletteSurface")

    // MARK: - Type

    /// The wordmark register — New York (the system serif, `Font.Design.serif`), Norma's ONE
    /// serif accent. This is the Mac's instance of the iOS serif allowlist's **binding #1** (the
    /// drawer wordmark). Pinned at 20 pt rather than the phone's 25 pt: the phone's figure was
    /// measured against Claude's iOS drawer, and in a 272 pt Mac sidebar it overpowers the row
    /// block — 20 pt is what the ChatGPT desktop reference measures. Same binding, platform size
    /// register; `docs/brand.md` records both and why they differ.
    ///
    /// A pinned size is the deliberate exception for a LOGO LOCKUP, not text.
    static let wordmark: Font = .system(size: 20, weight: .semibold, design: .serif)

    /// The new-chat page's greeting — serif allowlist **binding #5**, added 2026-08-07.
    ///
    /// Not a fifth binding invented on a whim: the iOS gallery's typography file already names
    /// "the home greeting" as a sanctioned serif moment alongside the wordmark, so this is that
    /// moment finally having a surface on the Mac. It is a genuine editorial beat — one line, once
    /// per empty page — which is exactly the restraint the allowlist exists to enforce.
    ///
    /// Larger than the wordmark because it is the page's subject rather than its label.
    static let greeting: Font = .system(size: 28, weight: .regular, design: .serif)

    // Everything the serif allowlist does NOT cover — rows, labels, chrome, lists, tool output —
    // stays on the standard system sans (San Francisco): a plain `Font` with no design override.
    // There is nothing to wrap here; reach for `.font(.system(size:weight:))` directly.
    //
    // Allowlist binding #4 (assistant prose in the transcript) is real on Mac but belongs to the
    // chat-surface pass — allowlisted, not yet applied. Bindings #2 and #3 (the pairing gate
    // title, the pairing words) have no Mac surface at all.

    /// Every asset-catalog color name this type names. `SidebarBrandTests` iterates it, so a
    /// typo or a colorset missing from the catalog fails the suite instead of silently rendering
    /// a fallback color at runtime — the one failure mode here that is otherwise invisible.
    static let assetColorNames: [String] = [
        "Canvas", "CardSurface", "SelectionPill", "ElevatedSurface", "ControlSurface",
        "BubbleUser", "ComposerSurface", "ComposerRim", "TextMuted", "InverseCanvas",
        "AccentColor", "RowHover", "Hairline", "PaletteSurface",
    ]
}
