import AppKit
import SwiftUI

// MARK: - Typography — the Mac half of the type source of truth
//
// `docs/brand.md` § 4 is the governing document: one ROLE table, two platform columns. This file
// is the Mac column made executable — every font the app constructs is named here (or in
// `Theme`, which keeps the three serif-allowlist bindings: `wordmark`, `greeting`,
// `assistantProse`). Nothing outside these two files may construct a font or write a point size
// at a call site: `TypographyTests.testNoFontIsConstructedOutsideTheTokenFiles` sweeps every app
// source, and `testEveryRoleMatchesTheTableInBrandMd` parses the doc's table itself, so a value
// changed in either place alone fails the suite.
//
// The scale below is the app's own measured status quo (the 2026-08-13 inventory: 12 pt ×107,
// 11 pt ×91, 13 pt ×35, 14/10 pt ×14 each, 9 pt ×9 — a clean 8…16 ladder that was always there,
// just unnamed). Tokenising it changed NO rendered output; the disagreement table in the
// mac-chat-parity typography report records the few places a value was reconciled rather than
// transcribed.

enum Typography {
    // MARK: The chrome scale — point sizes

    /// The nine steps every piece of Mac chrome sits on. macOS has no user Dynamic Type; these
    /// are honest fixed points, which is exactly why they must live in one place. iOS expresses
    /// the same roles as semantic text styles (`docs/brand.md` § 4.3) — do NOT copy these numbers
    /// to the phone.
    static let microSize: CGFloat = 8
    static let badgeSize: CGFloat = 9
    static let tinySize: CGFloat = 10
    static let captionSize: CGFloat = 11
    static let labelSize: CGFloat = 12
    static let controlSize: CGFloat = 13
    static let bodySize: CGFloat = 14
    static let bodyLargeSize: CGFloat = 15
    static let headingSize: CGFloat = 16

    // MARK: The chrome scale — sans roles

    /// Path-crumb chevrons and nothing else; below this nothing is legible.
    static func micro(_ weight: Font.Weight = .regular) -> Font { sans(microSize, weight) }
    /// Count badges, checkmarks inside pills, disclosure chevrons on tool rows.
    static func badge(_ weight: Font.Weight = .regular) -> Font { sans(badgeSize, weight) }
    /// Timestamps, micro-labels under rows, the quietest text that is still text.
    static func tiny(_ weight: Font.Weight = .regular) -> Font { sans(tinySize, weight) }
    /// The small-meta workhorse: tool rows, chips, pills, section labels (91 sites at adoption).
    static func caption(_ weight: Font.Weight = .regular) -> Font { sans(captionSize, weight) }
    /// The standard-label workhorse: dashboard body text, sidebar meta (107 sites at adoption).
    static func label(_ weight: Font.Weight = .regular) -> Font { sans(labelSize, weight) }
    /// Rows and controls: sidebar rows, palette rows, composer chrome.
    static func control(_ weight: Font.Weight = .regular) -> Font { sans(controlSize, weight) }
    /// Input and reading text: the composer, the transcript's sans base, header glyphs.
    static func body(_ weight: Font.Weight = .regular) -> Font { sans(bodySize, weight) }
    /// One step of emphasis over `body`: send glyphs, the search palette's input.
    static func bodyLarge(_ weight: Font.Weight = .regular) -> Font { sans(bodyLargeSize, weight) }
    /// The largest chrome step: tile values, the new-chat composer (where the composer is the
    /// page's whole subject — `NewChatPage`'s register, fed to `ComposerTextView` as a size).
    static func heading(_ weight: Font.Weight = .regular) -> Font { sans(headingSize, weight) }

    // MARK: The chrome scale — monospaced roles

    /// Inline paths, ids and hashes at `caption` size.
    static func captionMono(_ weight: Font.Weight = .regular) -> Font { mono(captionSize, weight) }
    /// Field values, URLs, config text at `label` size.
    static func labelMono(_ weight: Font.Weight = .regular) -> Font { mono(labelSize, weight) }
    /// Provider model strings at `control` size.
    static func controlMono(_ weight: Font.Weight = .regular) -> Font { mono(controlSize, weight) }

    // MARK: Display + one-off geometry tokens

    /// The empty-state glyph every landing surface shares (34 pt light).
    static let emptyStateGlyph: Font = sans(34, .light)
    /// The pairing sheet's six-digit confirm code (22 pt semibold mono).
    static let pairingCode: Font = mono(22, .semibold)
    /// The pairing sheet's success glyph.
    static let pairingGlyphLarge: Font = sans(36, .regular)
    /// The pairing sheet's device glyph.
    static let pairingGlyphMedium: Font = sans(30, .regular)
    /// The morph window's hand-drawn traffic-light glyphs (8.5 pt bold): one-off geometry inside
    /// a 14 pt circle, measured against the system's own lights — tokenised verbatim, and any
    /// change here is a change to the orb surface, which is gated (`docs/brand.md` § 4.6).
    static let morphTrafficGlyph: Font = sans(8.5, .bold)
    /// The question card's read-only preview pane — monospaced at the system body style.
    static let questionPreviewMono: Font = .system(.body, design: .monospaced)
    /// The composer's attach (+) glyph — 17 pt, one step past `heading`: glyph geometry, not a
    /// text step, and the SAME 17 the iOS composer draws its primary glyphs at.
    static let composerPlusGlyph: Font = sans(17, .medium)

    // MARK: Semantic passthroughs

    /// Dashboard pane titles ("Memory", "Skills", …) — the system headline, unchanged.
    static let paneTitle: Font = .headline
    /// The landing/empty-state title under `emptyStateGlyph`.
    static let emptyStateTitle: Font = .title2
    /// The landing/empty-state subtitle; also the dispatch surface's quiet explainer.
    static let emptyStateSubtitle: Font = .callout
    /// Landing-page body copy (chat/mode landing bullets).
    static let landingBody: Font = .body
    /// Landing-page fine print.
    static let landingCaption: Font = .caption
    /// Chip and status-capsule labels (`ActivityChip`, sidebar count chips).
    static let chipLabel: Font = .caption2

    // MARK: NSFont plumbing — the only NSFont constructors in the app

    /// Sans NSFont at an arbitrary size — for pipelines whose size FLOWS from a token
    /// (`MessageTextFormatter`, `ComposerTextView`). The sweep bans literal numbers as arguments
    /// to this API outside this file (rule R3), so "arbitrary" still means "token-derived".
    static func sansNS(ofSize size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .systemFont(ofSize: size, weight: weight)
    }

    /// Monospaced NSFont at an arbitrary size — same contract as `sansNS`.
    static func monoNS(ofSize size: CGFloat, _ weight: NSFont.Weight = .regular) -> NSFont {
        .monospacedSystemFont(ofSize: size, weight: weight)
    }

    /// `SyntaxHighlighter`'s code face — 12.5 pt mono, between `label` and `control`: code blocks
    /// read one half-step under the transcript's 13.5 pt inline code.
    static let syntaxCodeNS: NSFont = monoNS(ofSize: 12.5)
    /// The orb field's code-block language label.
    static let fieldCodeLabelNS: NSFont = sansNS(ofSize: captionSize, .medium)
    /// The orb field's code-block body.
    static let fieldCodeBlockNS: NSFont = monoNS(ofSize: controlSize)
    /// The orb field's INLINE-code run — 13.5 verbatim, its own token on purpose: it was
    /// briefly derived from the transcript's sans metrics (which happened to compute 13.5),
    /// and the 2026-08-13 ladder unification would have silently shrunk it to 12 through that
    /// coupling. The orb is gated; its values never ride along with transcript rulings.
    static let fieldInlineCodeNS: NSFont = monoNS(ofSize: 13.5)
    /// The shortcut recorder's key-cap legend.
    static let shortcutKeyNS: NSFont = sansNS(ofSize: captionSize)
    /// The web panel's native tab-strip label.
    static let panelTabLabelNS: NSFont = sansNS(ofSize: labelSize)

    /// Bold/italic runs inside formatted prose — `NSFontManager` trait conversion, kept HERE so
    /// the sweep can ban `NSFontManager` everywhere else. It keeps the family (New York stays
    /// New York; pinned by `TranscriptBrandTests.testSerifProseSurvivesBoldAndItalicConversion`).
    static func converted(_ font: NSFont, toHaveTrait trait: NSFontTraitMask) -> NSFont {
        NSFontManager.shared.convert(font, toHaveTrait: trait)
    }

    /// The maths face — a real maths serif when the OS has one, walking the candidate list in
    /// order (moved verbatim from `MessageTextFormatter.mathFont`, 2026-08-13).
    static func mathNS(ofSize size: CGFloat, italic: Bool) -> NSFont {
        let candidates = italic
            ? [
                "STIXTwoText-Italic",
                "STIXGeneral-Italic",
                "TimesNewRomanPS-ItalicMT",
                "Georgia-Italic",
                "NewYork-RegularItalic"
            ]
            : [
                "STIXTwoMath-Regular",
                "STIXGeneral-Regular",
                "TimesNewRomanPSMT",
                "Georgia",
                "NewYork-Regular"
            ]
        for name in candidates {
            if let font = NSFont(name: name, size: size) {
                return font
            }
        }
        let fallback = sansNS(ofSize: size)
        return italic ? converted(fallback, toHaveTrait: .italicFontMask) : fallback
    }

    /// Block maths' default size is the assistant-prose body — a DERIVATION, because display
    /// maths sits inside Norma's reply and must read as part of that prose.
    static func mathDefaultNS(italic: Bool) -> NSFont {
        mathNS(ofSize: transcriptProseMetrics(.assistant).bodySize, italic: italic)
    }

    // MARK: Private constructors

    private static func sans(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        .system(size: size, weight: weight)
    }

    private static func mono(_ size: CGFloat, _ weight: Font.Weight) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// MARK: - The prose register (mac-chat-parity Task 8; moved here from
// `ChatContent/TranscriptMessageViews.swift` by the 2026-08-13 typography pass — same symbols,
// same values, one home)

/// Which face a block of formatted prose is set in.
///
/// TWO roles, because `docs/brand.md` § 4's serif allowlist has exactly ONE transcript binding
/// (#4, assistant prose) and everything else on this surface stays sans.
///
/// It is a REQUIRED parameter — never a default — on the three views that TAKE one
/// (`TranscriptAssistantMessage` and the two private renderers beside it), because the dangerous
/// direction is a new call site *inheriting* serif: a card, a placeholder, a future summary panel
/// silently putting chrome into Norma's speaking voice. A `let` with no initial value is a required
/// parameter of Swift's memberwise initialiser, so omitting it does not compile — demonstrated by
/// mutation (`error: missing argument for parameter 'role'`), not assumed. (The distinction this
/// plan learned the hard way at Task 6: an *optional* `var` gets an implicit `nil` default and
/// gives no such protection at all.)
///
/// `TranscriptUserBubble` is the one view that DECLARES its role rather than taking one: it renders
/// exactly one thing — the user's own words — so there is nothing for a caller to decide.
enum TranscriptProseRole: Equatable {
    /// Serif allowlist binding #4 — what Norma *says*, in the transcript, in its own voice.
    case assistant
    /// Everything else that goes through this same markdown renderer: the user's own message, and a
    /// plan card's body. A card is chrome around a decision, so it stays sans even though its text
    /// was written by the model — `docs/brand.md` § 4 allowlists the *transcript reply*, not
    /// model-authored text wherever it appears.
    case sans
}

/// The type metrics one prose role renders at.
///
/// **One ladder, two faces, two rhythms — by ruling (2026-08-13: "the iOS here is source of
/// truth. the Mac should follow it").** iOS sets the user bubble and the serif assistant prose
/// at the SAME nominal style (`.body`), and the Mac now mirrors that relationship: both roles
/// share every size below; only the FACE (serif vs sans, chosen by `transcriptProseFont`) and
/// the LEADING differ — iOS's own distinction (`lineSpacing(6)` on serif markdown, nothing on
/// the bubble).
///
/// The x-height measurement that used to size the sans ladder lower is still TRUE as a fact and
/// is retained as an **accepted property**, not a rule: New York's x-height is ~9% shorter than
/// San Francisco's at equal point size (measured on this OS: 6.713 vs 7.369 at 14 pt), so at the
/// shared size the serif reply reads ~10% optically lighter than the sans bubble. Known, chosen.
/// `TranscriptBrandTests` pins both halves: the shared sizes AND the accepted property.
struct TranscriptProseMetrics: Equatable {
    /// Paragraph, bullet and numbered-item size.
    let bodySize: CGFloat
    /// Block quotes, one step down from `bodySize`.
    let quoteSize: CGFloat
    /// Added to the font's own line height. Sans keeps 3; serif takes 5, a wider rhythm for a
    /// reading face over long desktop line lengths — short of iOS's 1.59 pitch/size ratio
    /// (`AssistantMarkdown.swift`), which is tuned for a phone's line width. The ONE remaining
    /// divergence between the two roles' metrics, deliberately (see the type doc above).
    let lineSpacing: CGFloat
    /// How far BELOW its block's size an inline monospaced code run is set. One shared drop
    /// since the 2026-08-13 unification ruling: both roles land inline code on 13.5 pt for body
    /// text, which is exactly what this surface has always used.
    let codeSizeDrop: CGFloat
    /// Heading sizes for levels 1…4; level 5+ takes the last entry, as the donor's ladder did.
    let headingSizes: [CGFloat]

    func headingSize(_ level: Int) -> CGFloat {
        guard level >= 1 else { return headingSizes[0] }
        return headingSizes[min(level, headingSizes.count) - 1]
    }

    /// The floor is the donor's: below ~11.5 pt monospaced text stops being readable at all, so a
    /// deep heading's code run never shrinks past it.
    func codeSize(for blockSize: CGFloat) -> CGFloat {
        max(11.5, blockSize - codeSizeDrop)
    }
}

func transcriptProseMetrics(_ role: TranscriptProseRole) -> TranscriptProseMetrics {
    switch role {
    case .sans:
        // Unified onto the assistant's sizes by the 2026-08-13 ruling (iOS canonical: its user
        // bubble and serif prose share `.body`). Only the leading stays the sans register's own.
        // Until the ruling this was the donor's 14 / 13.5 / drop 0.5 / [20, 17, 15.5, 14.5].
        return TranscriptProseMetrics(bodySize: 15.5, quoteSize: 15, lineSpacing: 3,
                                      codeSizeDrop: 2, headingSizes: [22, 19, 17, 16])
    case .assistant:
        return TranscriptProseMetrics(bodySize: 15.5, quoteSize: 15, lineSpacing: 5,
                                      codeSizeDrop: 2, headingSizes: [22, 19, 17, 16])
    }
}

/// The face itself. `Theme.assistantProse` is where the serif binding lives (`docs/brand.md` § 4);
/// everything else is the system sans by doing nothing to it.
func transcriptProseFont(_ role: TranscriptProseRole, size: CGFloat, weight: NSFont.Weight) -> NSFont {
    switch role {
    case .assistant: return Theme.assistantProse(size: size, weight: weight)
    case .sans: return Typography.sansNS(ofSize: size, weight)
    }
}

/// The same face as a SwiftUI `Font`, for the view layer — call sites never bridge
/// `Font(NSFont)` themselves (the sweep bans `Font(` construction outside the token files).
func transcriptProseSwiftUIFont(_ role: TranscriptProseRole, size: CGFloat,
                                weight: NSFont.Weight) -> Font {
    Font(transcriptProseFont(role, size: size, weight: weight))
}

// MARK: - The question card's type ladder (ported from iOS by RATIO, 2026-08-13; moved here from
// `ChatContent/PendingCards.swift` by the typography pass — same symbols, same values)

/// iOS sets a question at the transcript's own prose size and steps everything under it down from
/// there; the Mac had the whole card a register lower, with the question at 14 — which is the
/// USER's message size, not Norma's. So her question was set in the user's register while wearing
/// her serif face, the one place the two crossed.
///
/// Ported as RATIOS against `.body` (17 at the default Dynamic Type size), not as point values:
/// copying 17/16/13/12 onto a 15.5 pt Mac ladder would have made the card larger than the prose
/// around it. Rounded to the half points this codebase already uses.
enum QuestionCardType {
    /// **Derived, not written down**: the question IS the transcript's assistant prose size (iOS
    /// ratio 1.00). Reading it from `transcriptProseMetrics` is what makes that an invariant rather
    /// than two constants that happen to agree today — change the prose ladder and this follows.
    static var question: CGFloat { transcriptProseMetrics(.assistant).bodySize }
    /// iOS `.callout`, 16/17 = 0.94 → 14.5. The option label and a frozen card's answer row.
    static let option: CGFloat = 14.5
    /// iOS `.footnote`, 13/17 = 0.76 → 12. Option descriptions and notes.
    static let secondary: CGFloat = 12
    /// iOS `.caption`, 12/17 = 0.71 → 11. Header chips and pills — already this value.
    static let pill: CGFloat = 11
}

extension Typography {
    /// The question's own text — serif, because the question is Norma ASKING, in her voice
    /// (`QuestionCardType.question` derives from the assistant prose ladder; see its doc).
    static func questionSerif() -> Font {
        Font(Theme.assistantProse(size: QuestionCardType.question, weight: .regular))
    }

    /// The question card's option labels and a frozen card's answer row.
    static func questionOption(_ weight: Font.Weight = .regular) -> Font {
        .system(size: QuestionCardType.option, weight: weight)
    }

    /// Option descriptions, notes, and the "Other…" affordance.
    static func questionSecondary(_ weight: Font.Weight = .regular) -> Font {
        .system(size: QuestionCardType.secondary, weight: weight)
    }

    /// The card's header chips and progress pills.
    static func questionPill(_ weight: Font.Weight = .regular) -> Font {
        .system(size: QuestionCardType.pill, weight: weight)
    }
}
