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
    ]
}
