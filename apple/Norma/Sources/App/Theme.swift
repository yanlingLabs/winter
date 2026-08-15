import AppKit
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

    /// Tool-output / approval-card container fill, one step up from the card. Live on Mac since
    /// mac-chat-parity Task 8: the transcript's tool-output blocks, code blocks, interaction cards
    /// and question preview panes all sit on it, one step above the content side's `cardSurface`.
    static let elevatedSurface = Color("ElevatedSurface")

    /// Small-control fill (composer circles, model pills, the transcript's "latest" pill, the
    /// inline-code chip inside prose).
    static let controlSurface = Color("ControlSurface")

    /// The user's own messages — a neutral warm chip grey, deliberately not an accent tint. Live on
    /// Mac since mac-chat-parity Task 8 (`TranscriptUserBubble`).
    static let bubbleUser = Color("BubbleUser")

    /// The composer card's opaque face. Live on Mac since mac-chat-parity Task 5
    /// (`NormaComposerCard`).
    static let composerSurface = Color("ComposerSurface")

    /// The composer's bright hairline; the alpha lives in the asset (0.90 light / 0.08 dark) so
    /// Swift never computes it. **The one mirrored token nothing on Mac names** — the Mac composer
    /// draws its rim with `hairline` instead (`NormaComposerCard`). Kept because `docs/brand.md` § 1
    /// pins eleven shared values and the two catalogs mirror name-for-name; dropping it would break
    /// that, not tidy it.
    static let composerRim = Color("ComposerRim")

    /// The muted warm meta grey — section labels, quiet meta rows, trailing glyphs. `.secondary`
    /// renders cooler and lighter on the warm canvas, which is why this is an asset instead.
    static let textMuted = Color("TextMuted")

    /// The base plane of the OPPOSITE appearance — the primary-action trick (a pill that reads
    /// cream in dark and charcoal in light). Live on Mac in the new-chat page's send glyph
    /// (`NewChatPage`).
    static let inverseCanvas = Color("InverseCanvas")

    /// Brand tint — a muted blue-green teal. It tints prominent controls and glyphs and stays out
    /// of navigation entirely (`docs/brand.md` § 3.2, which is why the sidebar carries no accent
    /// anywhere). On Mac that means the transcript's card selection chrome, its list markers and
    /// quote rules, and the in-progress task/subagent tint — all of them since mac-chat-parity
    /// Task 8, which is when this token first tinted anything here.
    ///
    /// `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` is left UNSET so that naming a colorset
    /// `AccentColor` does not silently retint every system control in the app. **The corollary was
    /// a live bug until Task 8:** with that setting unset, SwiftUI's `Color.accentColor` resolves
    /// to the USER's System Settings accent, not to this. Always name `Theme.accent`;
    /// `TranscriptBrandTests` fails the suite on `accentColor` anywhere in `ChatContent/`.
    static let accent = Color("AccentColor")

    // MARK: - Color: the four Mac-only tokens

    /// The hover fill. Mac-only BY NECESSITY — the phone has no hover state. Interpolated
    /// between `canvas` and `selectionPill` in both appearances, so hover → selected reads as
    /// ONE ramp rather than two unrelated tints.
    static let rowHover = Color("RowHover")

    /// The **shell's** divider — sidebar against content, and rims drawn at the `canvas`/
    /// `cardSurface` plane. Mac-only: the phone has no window-internal divider. A warm value
    /// because the system `separatorColor` is cool and fights the cream.
    ///
    /// It is defined against those two grounds and measures poorly above them; anything drawing a
    /// rule ON a raised surface wants `hairlineElevated` instead.
    static let hairline = Color("Hairline")

    /// The same divider one plane up — a rule drawn ON `elevatedSurface` or `controlSurface`
    /// (a multi-question card's separators, a code block's rim, the transcript's "latest" pill).
    /// Mac-only for the same reason `hairline` is.
    ///
    /// **It exists because `hairline` measured 1.040:1 on `elevatedSurface` in dark** — very nearly
    /// invisible, and a regression the transcript's own brand pass introduced by moving the cards
    /// onto `elevatedSurface` while leaving their rules on the shell's token (mac-chat-parity Task 8
    /// fix round 1). This value measures **1.313:1 light / 1.312:1 dark** on that plane: the same
    /// separation in both appearances by construction, not by coincidence, and stronger than
    /// `hairline` manages even on its own ground (1.175 / 1.236 on `canvas`).
    ///
    /// A separate asset rather than `hairline.opacity(…)`, per `docs/brand.md` § 3.1: a runtime
    /// alpha has no per-appearance tuning, and this token needs its two halves to move in OPPOSITE
    /// directions from `hairline`'s — darker in light, lighter in dark.
    static let hairlineElevated = Color("HairlineElevated")

    /// The face of anything that FLOATS ABOVE content — the search palette it is named for, and
    /// (since mac-chat-parity Task 8) the chat window's slide-in sidebar overlays, which are the
    /// same object: a pane drawn over the transcript rather than beside it. Mac-only; the phone has
    /// no such surface. Brighter than `cardSurface` in both appearances. `elevatedSurface` cannot
    /// serve here: its light value is a retained cool system grey that is DARKER than
    /// `cardSurface` — the wrong direction for something floating.
    static let paletteSurface = Color("PaletteSurface")

    // MARK: - Color: the diff pair (diff-tabs) — two foreground roles, two row washes

    /// The removed-lines role — the `-N` half of the transcript's diff chip, and the removed-side
    /// gutter numbers and `-` markers in the diff tab.
    ///
    /// **FINAL, and measured** (Task 10, superseding Task 9's provisional): light `#B3261E`, dark
    /// `#FF6B70`. Every ratio is published in `docs/brand.md` § 3.6, measured by the method § 3.5
    /// uses. The dark half MOVED during that measurement — the provisional `#F2555A` measured
    /// **4.08:1 on its own wash**, under the 4.5:1 floor for 12.5 pt text, and the wash is exactly
    /// the ground these numbers are drawn on. `#FF6B70` measures 4.97:1 there and 5.89:1 on the
    /// panel's `CardSurface`.
    ///
    /// It is the first colour in this file to carry MEANING rather than surface (§ 3.4 records that
    /// the palette has had no danger or success tone at all, which is why the transcript's failure
    /// lines are set in `.primary` and its status glyphs are shape-only). A diff is the one place
    /// where red and green are not decoration: they are what the two columns of numbers MEAN, and
    /// they are what every other diff surface the user reads uses.
    static let diffRemovedRole = Color("DiffRemoved")

    /// The added-lines role — the `+M` half, and the added-side gutter numbers. FINAL and measured
    /// on the same terms as `diffRemovedRole`: light `#1F7A3D` (5.10:1 on `CardSurface`, 4.70:1 on
    /// its own wash), dark `#4CC38A` (7.36:1 / 5.55:1). Both halves were already clear of the floor,
    /// so this one is unchanged from Task 9's provisional.
    static let diffAddedRole = Color("DiffAdded")

    /// The added row's FULL-ROW background tint — `#22C55E` at 10% (light) / 16% (dark), authored
    /// per appearance rather than as an `.opacity()` on the role (§ 3.1's derived-value rule: a
    /// runtime alpha hack has no dark variant and no way to be tuned per appearance).
    ///
    /// The two alphas differ because the two grounds do: the same wash that reads as a clear tint on
    /// the cream `CardSurface` (1.085:1 against it) all but disappears on the dark one, so dark takes
    /// 16% to reach a comparable 1.326:1. They are DELIBERATELY faint — this is the background of
    /// ordinary code, and every ink that lands on it (`labelColor` at ≥ 9.31:1, both diff roles, the
    /// syntax palette) must stay readable, which § 3.6 records for each.
    static let diffAddedWash = Color("DiffAddedWash")

    /// The removed row's full-row tint — `#EF4444` at 10% / 16%, on the same terms as
    /// `diffAddedWash`.
    static let diffRemovedWash = Color("DiffRemovedWash")

    // MARK: - Color: the five panel-kind tints (diff-tabs Task 12) — Mac-only

    /// **Mac-only**, like `rowHover`/`hairline`/`hairlineElevated`/`paletteSurface` (§ 1): the
    /// panel strip itself has no iOS surface, so there is nothing on the phone for these to
    /// mirror. `docs/brand.md` § 3.7 publishes every measurement below.
    ///
    /// Five soft washes, one per `PanelTabKind`, on the SAME hue at two strengths: a faint pill
    /// fill (`panelKindTint`, this token) and a stronger chip fill (`panelKindChipTint`, derived
    /// below at `panelKindChipTintOpacityMultiplier`× this token's alpha) — never two colorsets
    /// per kind, so `Theme.panelKindTint`'s switch stays the ONE place a kind maps to a hue.
    ///
    /// **Alphas are MEASURED under the pill's LADDER model (user live-gate ruling, 2026-08-15:
    /// "the selected tab should still show in the same color the tabs of that type do, just a
    /// litle stronger; the default accent should be a lil stronger").** The pill no longer wears
    /// `ShellSidebarRowStyle`'s neutral `RowHover` on hover/selected — that opaque fill occluded
    /// the kind's hue exactly when the user was looking at it, and its fixed luminance was the
    /// ceiling that had forced `web` down to a 4.7% light alpha ("browser tabs don't read blue").
    /// Instead the pill paints ONE hue per kind at three strengths — rest (this token's authored
    /// alpha), hover (×`panelKindPillHoverOpacityMultiplier`) and selected
    /// (×`panelKindPillSelectedOpacityMultiplier`) — so every state change stays IN the kind's
    /// color and the old neutral-crossover trade-off no longer exists. Floors, re-measured per
    /// kind in both schemes and published in brand.md § 3.7: rest visibility ≥ 1.05 on
    /// `CardSurface`; rest→hover and hover→selected each ≥ 1.040; `labelColor` ≥ 4.5:1 on the
    /// STRONGEST (selected) composite. Light rest is a flat 12%; dark rest is 19% except `note`
    /// at 17% — the bright ambers lift the selected composite enough that the white label falls
    /// under 4.5:1 at 19%×2.4 (measured 4.22:1); 17% restores 4.73:1. The group CHIP keeps the
    /// shared row style and its 2.0× fill — the stronger base incidentally lifted its light-mode
    /// hover delta from the old documented ~1.00–1.011 trade-off to a measured 1.043–1.212, so
    /// what § 3.7 once recorded as an accepted weakness is now a pinned floor.
    static func panelKindTint(_ kind: PanelTabKind) -> Color {
        switch kind {
        case .web: return Color("PanelKindWebTint")
        case .document: return Color("PanelKindDocumentTint")
        case .code: return Color("PanelKindCodeTint")
        case .note: return Color("PanelKindNoteTint")
        case .diff: return Color("PanelKindDiffTint")
        }
    }

    /// The ONE named exception to "no raw literals" this task's global constraints carve out —
    /// every hue and every alpha stays authored in the colorset (§ 3.1); this only SCALES an
    /// already-authored, already-per-appearance-tuned value by a fixed, named factor. Measured
    /// (not assumed) that `Color.opacity(_:)` MULTIPLIES an already-translucent color's stored
    /// alpha rather than replacing or clamping it: a 0.08-alpha color at `.opacity(2.0)` resolved
    /// to exactly 0.16. That is what makes "one colorset, times a constant" produce the SAME
    /// result in both appearances as authoring a second colorset by hand would have — the brief's
    /// other sanctioned shape — without the second exhaustive switch that shape would have cost.
    static let panelKindChipTintOpacityMultiplier: Double = 2.0

    /// The group chip's stronger tint (Task 11's slot: `PanelTabKindChip`, `ShellPanel.swift`) —
    /// "the same hue at DOUBLE opacity." Derived from `panelKindTint`, never a second switch: one
    /// switch stays the single place a kind names its hue, and this only scales what it returns.
    static func panelKindChipTint(_ kind: PanelTabKind) -> Color {
        panelKindTint(kind).opacity(panelKindChipTintOpacityMultiplier)
    }

    /// The pill's state ladder (live-gate ruling 2026-08-15, doc on `panelKindTint` above): hover
    /// and selected are the SAME authored hue at fixed, named multiples of the rest alpha — the
    /// same one-colorset-times-a-constant mechanism as the chip's 2.0×, for the same reason (the
    /// alpha ladder resolves identically in both appearances because each rung SCALES the
    /// per-appearance authored value). 1.6/2.4 are measured, not round numbers for their own
    /// sake: § 3.7's tables show every adjacent-rung delta clearing the 1.040 floor and the
    /// selected rung holding label legibility in both schemes.
    static let panelKindPillHoverOpacityMultiplier: Double = 1.6
    static let panelKindPillSelectedOpacityMultiplier: Double = 2.4

    /// The ONE fill decision for a panel tab pill — pure on its inputs, exhaustively laddered:
    /// selected beats hover beats rest, mirroring `shellSidebarRowFill`'s precedence so the two
    /// row treatments stay one grammar even though the pill's PAINT is kind-hued rather than
    /// neutral. A selected pill ignores hover (selection is a terminal state; the cursor and the
    /// close box already answer "am I over it").
    static func panelKindPillFill(_ kind: PanelTabKind, isActive: Bool, isHovered: Bool) -> Color {
        if isActive { return panelKindTint(kind).opacity(panelKindPillSelectedOpacityMultiplier) }
        if isHovered { return panelKindTint(kind).opacity(panelKindPillHoverOpacityMultiplier) }
        return panelKindTint(kind)
    }

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
    /// Larger than the wordmark because it is the page's subject rather than its label. 38 pt on
    /// the third measurement — 28 then 34 both read visibly smaller than the reference's line in a
    /// side-by-side, and the greeting is set GREYED rather than near-black, which makes a slightly
    /// larger size read as calm rather than loud.
    static let greeting: Font = .system(size: 38, weight: .regular, design: .serif)

    /// Serif allowlist **binding #4** — assistant prose in the transcript, applied on Mac by
    /// mac-chat-parity Task 8 (it was allowlisted and unapplied from the sidebar-brand pass until
    /// then). The reading face for what Norma *says*: paragraphs, headings, lists and quotes inside
    /// an assistant message. Nothing else — user messages, tool rows, cards and every piece of
    /// chrome stay on the system sans, and inline code / code blocks / maths keep their own faces
    /// inside serif prose.
    ///
    /// An `NSFont`, not a SwiftUI `Font`, because the transcript renders prose through
    /// `MessageTextFormatter`'s `NSAttributedString` pipeline (bold/italic/code runs are per-run
    /// font substitutions), which never sees a `Font`.
    ///
    /// **`NSFontManager.convert(_:toHaveTrait:)` keeps the family**, so bold and italic runs inside
    /// serif prose stay New York rather than silently falling back to SF: measured on this OS,
    /// `.NewYork-Regular` converts to `.NewYork-Semibold` and `.NewYork-RegularItalic`. Pinned by
    /// `TranscriptBrandTests.testSerifProseSurvivesBoldAndItalicConversion` so it stays true.
    ///
    /// Falls back to the sans of the same size and weight if the serif design is ever unavailable —
    /// a `nil` here would otherwise mean unrendered prose, and unstyled prose is the better failure.
    static func assistantProse(size: CGFloat, weight: NSFont.Weight) -> NSFont {
        let sans = NSFont.systemFont(ofSize: size, weight: weight)
        guard let descriptor = sans.fontDescriptor.withDesign(.serif),
              let serif = NSFont(descriptor: descriptor, size: size) else { return sans }
        return serif
    }

    // Everything the serif allowlist does NOT cover — rows, labels, chrome, lists, tool output —
    // stays on the standard system sans (San Francisco), reached ONLY through the named roles in
    // `Typography` (`App/Typography.swift`, the Mac column of `docs/brand.md` § 4.3's role
    // table). Never construct a font at a call site — `TypographyTests` sweeps every app source
    // for exactly that.
    //
    // Bindings #2 and #3 (the pairing gate title, the pairing words) have no Mac surface at all.

    /// Every asset-catalog color name this type names. `SidebarBrandTests` iterates it, so a
    /// typo or a colorset missing from the catalog fails the suite instead of silently rendering
    /// a fallback color at runtime — the one failure mode here that is otherwise invisible.
    static let assetColorNames: [String] = [
        "Canvas", "CardSurface", "SelectionPill", "ElevatedSurface", "ControlSurface",
        "BubbleUser", "ComposerSurface", "ComposerRim", "TextMuted", "InverseCanvas",
        "AccentColor", "RowHover", "Hairline", "HairlineElevated", "PaletteSurface",
        // diff-tabs — the diff pair: two foreground roles, two row washes. FINAL and measured
        // (Task 10); `docs/brand.md` § 3.6 publishes every ratio.
        "DiffRemoved", "DiffAdded", "DiffAddedWash", "DiffRemovedWash",
        // diff-tabs Task 12 — the five panel-kind tints (Mac-only, `panelKindTint`'s switch).
        // FINAL and measured; `docs/brand.md` § 3.7 publishes every ratio.
        "PanelKindWebTint", "PanelKindDocumentTint", "PanelKindCodeTint", "PanelKindNoteTint",
        "PanelKindDiffTint",
    ]
}
