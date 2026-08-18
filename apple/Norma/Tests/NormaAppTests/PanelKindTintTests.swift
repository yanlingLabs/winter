import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// diff-tabs Task 12 — soft per-kind panel tab tints. Same three-tier posture
/// `TranscriptBrandTests`' own file doc states, applied to a new surface:
///
/// 1. **Value pins.** `Theme.panelKindTint`/`panelKindChipTint` route each kind to the right
///    asset and the right derivation — at the `Color` level, never through AppKit bridging of a
///    NAMED/dynamic colour (a risk this file deliberately avoids; see § 1's own note). The
///    ASSETS' hex/alpha values are pinned where every other colorset's are, in
///    `TranscriptBrandTests.documentedPalette` — not duplicated here.
/// 2. **MEASURED pins** (§ 2) — the "measure, don't eyeball" requirement under the LADDER model
///    (live-gate ruling 2026-08-15): every adjacent rung of the pill's rest→hover→selected ramp
///    clears its floor, the ladder is strictly monotone, the chip's neutral hover cue clears its
///    own floor, and text stays legible at the ladder's worst case for each ink.
/// 3. **Wiring pins** (§ 3) — the pill wears its own ladder style with ONE fill home, the chip
///    applies its tint UNDER the shared row style, and the favicon/count glyphs stay off both.
///    Read via source, the same `codeOnly`/`source` convention `TranscriptBrandTests` uses for
///    `ChatContent/` — no view is mounted anywhere in this file, matching `SidebarBrandTests`'
///    own stated house convention.
///
/// What NONE of this covers: whether it LOOKS right. `docs/brand.md` § 3.7 records the numbers;
/// whether a tinted tab reads as "its own kind" at a glance is the live gate, same as every other
/// visual claim in this task family (Task 9/10/11's own reports name the identical limitation).
@MainActor
final class PanelKindTintTests: XCTestCase {
    private let kinds: [PanelTabKind] = [.web, .document, .code, .note, .diff, .files]

    // MARK: - 1. Theme.panelKindTint / panelKindChipTint at value level

    /// The exhaustive switch itself has no test — compilation IS that pin (`Theme.swift`'s own
    /// doc comment: no `default:`, so a sixth `PanelTabKind` case fails the build here). What
    /// compilation CANNOT catch is a kind routed to the WRONG asset (a `.code`/`.note` swap
    /// compiles clean) — this is that pin, at the `Color` level: two `Color("Name")` values
    /// constructed with the same name compare equal, which is what `panelKindTint` returning the
    /// right literal name actually means. Deliberately NOT `NSColor(Theme.panelKindTint(kind))`
    /// resolved and hex-compared — bridging a NAMED/dynamic SwiftUI `Color` through AppKit is an
    /// unproven mechanism this file has no need to lean on when `Color` equality answers the same
    /// question directly. The asset's OWN hex/alpha values are pinned by
    /// `TranscriptBrandTests.documentedPalette`, not re-pinned here.
    func testPanelKindTintNamesTheRightAssetForEveryKind() {
        let expected: [PanelTabKind: String] = [
            .web: "PanelKindWebTint", .document: "PanelKindDocumentTint",
            .code: "PanelKindCodeTint", .note: "PanelKindNoteTint", .diff: "PanelKindDiffTint",
            .files: "PanelKindFilesTint",
        ]
        for (kind, assetName) in expected {
            XCTAssertEqual(Theme.panelKindTint(kind), Color(assetName),
                           "\(kind) does not name \(assetName)")
        }
    }

    /// The multiplier is a NAMED constant with a specific value — "double opacity" per the brief,
    /// not merely "some scale factor". A silent drift to, say, 1.5 would pass every other test in
    /// this file (which only checks the RELATIONSHIP, not the number) without this.
    func testChipTintOpacityMultiplierIsExactlyDouble() {
        XCTAssertEqual(Theme.panelKindChipTintOpacityMultiplier, 2.0)
    }

    /// The pill ladder's two rungs are likewise NAMED, MEASURED constants (live-gate ruling
    /// 2026-08-15; § 3.7's tables were computed at exactly these values) — and the ladder must
    /// stay strictly ordered under the chip's own rung, which sits between hover and selected by
    /// design (chip 2.0× reads stronger than a hovered pill, quieter than the selected one).
    func testPillLadderMultipliersAreTheMeasuredValuesInStrictOrder() {
        XCTAssertEqual(Theme.panelKindPillHoverOpacityMultiplier, 1.6)
        XCTAssertEqual(Theme.panelKindPillSelectedOpacityMultiplier, 2.4)
        XCTAssertLessThan(Theme.panelKindPillHoverOpacityMultiplier,
                          Theme.panelKindChipTintOpacityMultiplier)
        XCTAssertLessThan(Theme.panelKindChipTintOpacityMultiplier,
                          Theme.panelKindPillSelectedOpacityMultiplier)
    }

    /// `panelKindPillFill`'s precedence, pinned at the `Color` level exactly like the chip's
    /// derivation test: selected beats hover beats rest, and each state resolves to the base
    /// tint at the named multiplier — never a third mechanism.
    func testPillFillResolvesTheLadderWithSelectedBeatingHover() {
        for kind in kinds {
            XCTAssertEqual(Theme.panelKindPillFill(kind, isActive: false, isHovered: false),
                           Theme.panelKindTint(kind))
            XCTAssertEqual(Theme.panelKindPillFill(kind, isActive: false, isHovered: true),
                           Theme.panelKindTint(kind).opacity(Theme.panelKindPillHoverOpacityMultiplier))
            XCTAssertEqual(Theme.panelKindPillFill(kind, isActive: true, isHovered: false),
                           Theme.panelKindTint(kind).opacity(Theme.panelKindPillSelectedOpacityMultiplier))
            XCTAssertEqual(Theme.panelKindPillFill(kind, isActive: true, isHovered: true),
                           Theme.panelKindPillFill(kind, isActive: true, isHovered: false),
                           "\(kind): selection is terminal — hover must not restyle an active pill")
        }
    }

    /// `panelKindChipTint` is DERIVED — the same switch, scaled — never a second exhaustive
    /// switch that could name a different asset for the same kind. Proven by comparing against an
    /// INDEPENDENTLY-constructed expected value (via the public API, not by reading the
    /// implementation's source), so a real bug — wrong kind, multiplier applied twice, multiplier
    /// dropped — would still be caught.
    func testChipTintIsDerivedFromThePillTintAtTheNamedMultiplier() {
        for kind in kinds {
            XCTAssertEqual(Theme.panelKindChipTint(kind),
                           Theme.panelKindTint(kind).opacity(Theme.panelKindChipTintOpacityMultiplier),
                           "\(kind): the chip tint must be the pill tint, scaled — nothing else")
        }
    }

    /// **The mechanism the whole "one colorset + a multiplier" design depends on**, proven on a
    /// LITERAL colour rather than a named/dynamic one (no asset-catalog or appearance dependency —
    /// the narrowest possible proof of the AppKit/SwiftUI boundary this task leans on).
    /// `Color.opacity(_:)` must MULTIPLY an already-translucent colour's stored alpha rather than
    /// replacing or clamping it, or "double opacity" would not mean what the brief says it means.
    /// Measured directly: 0.08 → 0.16 (ratio exactly 2), which is what makes the colorset's own
    /// per-appearance-authored alpha (§ 1's anti-rule) survive the scale intact in both schemes.
    func testColorOpacityMultipliesAnAlreadyTranslucentAlphaRatherThanReplacingIt() {
        let base = Color(NSColor(srgbRed: 0.2, green: 0.5, blue: 0.8, alpha: 0.08))
        let doubled = NSColor(base.opacity(2.0)).usingColorSpace(.sRGB)!
        XCTAssertEqual(doubled.alphaComponent, 0.16, accuracy: 0.001,
                       "Color.opacity(_:) must multiply stored alpha, not replace or clamp it")
    }

    // MARK: - 2. MEASURED: the pill's kind-hued ladder, the chip's hover cue, text legibility

    /// **The measured requirement, under the ladder model** (live-gate ruling 2026-08-15: the
    /// selected tab keeps its kind's color, a little stronger — so hover and selected are now the
    /// SAME hue at `Theme.panelKindPillHoverOpacityMultiplier`/`…SelectedOpacityMultiplier` times
    /// the rest alpha, and "distinguishable" means each adjacent RUNG of that ladder clears a
    /// contrast floor against the previous one). The old model's neutral-`RowHover`-over-tint
    /// crossover — and the telescoping-identity ceiling it imposed, which had forced `web` down
    /// to a 4.7% light alpha — no longer applies to pills at all.
    ///
    /// FLOORS, not the published figures (Task 10's precedent — `docs/brand.md` § 3.7 records the
    /// measurements; floors gate them so a deliberate retune doesn't red this suite for no
    /// reason): every adjacent rung ≥ 1.040 in both schemes. Worst measured: light `note`
    /// rest→hover 1.045; dark `files` rest→hover 1.150 (editor-product Task 2 — slightly under
    /// the old dark worst, `code`'s 1.163, still comfortably clear of the floor); everything else
    /// clears with more margin still.
    func testEveryAdjacentRungOfThePillLadderStaysDistinguishable() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
            for kind in kinds {
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let rest = composite(tint, over: cardSurface)
                let hover = composite(tint, alphaScale: Theme.panelKindPillHoverOpacityMultiplier,
                                      over: cardSurface)
                let selected = composite(tint, alphaScale: Theme.panelKindPillSelectedOpacityMultiplier,
                                         over: cardSurface)
                XCTAssertGreaterThanOrEqual(
                    contrast(rest, hover), 1.040,
                    "\(kind) in \(appearance.rawValue): hover rung drowns into rest — § 3.7")
                XCTAssertGreaterThanOrEqual(
                    contrast(hover, selected), 1.040,
                    "\(kind) in \(appearance.rawValue): selected rung drowns into hover — § 3.7")
            }
        }
    }

    /// The ladder must actually be a ladder: each rung moves the composite strictly FURTHER from
    /// the bare surface, in every scheme, for every kind — the property that makes
    /// rest → hover → selected read as one ramp of the same hue rather than three unrelated
    /// tints. (This replaces the old model's telescoping/reinforcing identity proofs, which were
    /// facts about `RowHover` occlusion — a mechanism pills no longer use.)
    func testTheLadderIsMonotoneAgainstTheBareSurface() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
            for kind in kinds {
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let rest = contrast(composite(tint, over: cardSurface), cardSurface)
                let hover = contrast(composite(tint, alphaScale: Theme.panelKindPillHoverOpacityMultiplier,
                                               over: cardSurface), cardSurface)
                let selected = contrast(composite(tint, alphaScale: Theme.panelKindPillSelectedOpacityMultiplier,
                                                  over: cardSurface), cardSurface)
                XCTAssertGreaterThanOrEqual(rest, 1.05,
                                            "\(kind) in \(appearance.rawValue): rest wash invisible against CardSurface")
                XCTAssertGreaterThan(hover, rest,
                                     "\(kind) in \(appearance.rawValue): hover must sit above rest")
                XCTAssertGreaterThan(selected, hover,
                                     "\(kind) in \(appearance.rawValue): selected must sit above hover")
            }
        }
    }

    /// **The chip kept the OLD model on purpose** (`PanelTabKindChip` still wears
    /// `ShellSidebarRowStyle`, whose hover fill is opaque neutral `RowHover` over the 2.0× tint —
    /// it has no selected state, so there was no occlusion complaint to fix). What § 3.7 once
    /// recorded as an accepted ~1.00–1.011 light-mode trade-off is now a pinned floor: the
    /// stronger rest base lifted the chip's measured light deltas to 1.043–1.212 as a side
    /// effect of the ladder retune.
    func testChipHoverFillStaysDistinguishableFromEveryChipAtRest() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
            let rowHover = srgb(NSColor(named: "RowHover")!, appearance)
            let floor: CGFloat = appearance == .aqua ? 1.040 : 1.30
            for kind in kinds {
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let chip = composite(tint, alphaScale: Theme.panelKindChipTintOpacityMultiplier,
                                     over: cardSurface)
                XCTAssertGreaterThanOrEqual(
                    contrast(rowHover, chip), floor,
                    "\(kind) in \(appearance.rawValue): the chip's neutral hover cue drowns — § 3.7")
            }
        }
    }

    /// Text legibility on the tinted pill — the title (`.primary`, i.e. `labelColor`) and the
    /// meta/icon ink (`Theme.textMuted`), on every tint, both schemes. `NSColor.labelColor` is
    /// NOT opaque (measured: 84.7% alpha both appearances) — the naive `contrast(labelColor,
    /// ground)` overstates by ~30% (18.x instead of ~14.x); this composites it over its real
    /// ground first, the SAME rule § 3.5/3.6 already apply to a wash, now applied to a
    /// translucent system ink. Verified against `docs/brand.md` § 3.6's own published figure:
    /// `labelColor` on plain `CardSurface` reproduces 14.35 / 11.99 EXACTLY with this method.
    ///
    /// FLOORS, on the ladder's WORST case for each ink: `labelColor` is checked on the SELECTED
    /// (strongest, 2.4×) composite and held to the 4.5:1 body floor — this is the ladder's real
    /// ceiling-setter: dark `note` had to keep a 17% rest alpha (19% measured 4.65:1 at the
    /// selected rung — see `docs/brand.md` § 3.7's stale-ink footnote: originally recorded as a
    /// 4.22 fail, which was the reason for the exception, now obsolete though the alpha itself is
    /// unchanged; 17% restores 5.16:1), and the worst passing value (`document` dark, 4.97)
    /// is why the floor is the body floor itself rather than something generous. `TextMuted` is
    /// checked on the REST wash (its actual home — the favicon and meta ink render on unselected
    /// pills too) against § 3.5's OWN quiet-meta register (4.14 light / 5.99 dark baseline), not
    /// the body floor: the tint may cost some contrast, as any wash does, but not collapse it.
    func testTintedTextStaysLegibleAcrossTheLadder() {
        let labelLight = srgb(.labelColor, .aqua)
        let labelDark = srgb(.labelColor, .darkAqua)
        let textMutedLight = srgb(NSColor(named: "TextMuted")!, .aqua)
        let textMutedDark = srgb(NSColor(named: "TextMuted")!, .darkAqua)
        for kind in kinds {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let selected = composite(tint, alphaScale: Theme.panelKindPillSelectedOpacityMultiplier,
                                         over: cardSurface)
                let label = appearance == .aqua ? labelLight : labelDark
                let labelOnSelected = composite(label, over: selected)
                XCTAssertGreaterThanOrEqual(contrast(labelOnSelected, selected), 4.5,
                                            "\(kind) in \(appearance.rawValue): title ink fell under the body floor on the SELECTED rung")
                let rest = composite(tint, over: cardSurface)
                let textMuted = appearance == .aqua ? textMutedLight : textMutedDark
                let floor: CGFloat = appearance == .aqua ? 3.5 : 4.0
                XCTAssertGreaterThanOrEqual(contrast(textMuted, rest), floor,
                                            "\(kind) in \(appearance.rawValue): meta/icon ink (TextMuted) dropped below its own established register")
            }
        }
    }

    // MARK: - 3. Wiring: the pill/chip source really applies the tint, and only there

    /// **The pill's fill decision has exactly one home** (ladder model, live-gate ruling
    /// 2026-08-15): `PanelTabPill` wears `PanelTabPillStyle`, and that style's body is the only
    /// place `Theme.panelKindPillFill` is named in this file — the same read-the-real-source
    /// proof style as before, retargeted from the old under-the-row-style z-order (a mechanism
    /// pills no longer use) to the new single-fill-source invariant.
    func testThePillWearsItsOwnLadderStyleAndTheFillHasOneHome() throws {
        let code = try loadCodeOnly("Sources/AppShell/ShellPanel.swift")
        XCTAssertTrue(code.contains("PanelTabPillStyle(kind: tab.kind, isActive: isActive)"),
                      "PanelTabPill must wear PanelTabPillStyle")
        XCTAssertEqual(code.components(separatedBy: "Theme.panelKindPillFill(").count - 1, 1,
                       "panelKindPillFill must be named exactly once — inside PanelTabPillStyle")
        XCTAssertFalse(code.contains("ShellSidebarRowStyle(isSelected: isActive"),
                       "the pill must no longer wear the neutral row style — its ladder IS the state paint")
    }

    /// The chip's identical wiring, Task 11's slot finally filled — same z-order proof.
    func testChipTintIsWiredBeforeTheRowStyleSoItLandsBehindIt() throws {
        let lines = try codeLines("Sources/AppShell/ShellPanel.swift")
        try assertAppliedBeforeItsRowStyle(marker: "Theme.panelKindChipTint(kind)", lines: lines,
                                           label: "PanelTabKindChip")
    }

    /// **The regression this task must not invite**: "finishing the job" by also tinting the
    /// favicon glyph or the chip's count digit ("the tint is the surface, not the icon" — at chip
    /// opacity the wash measures ~1.2:1 as literal ink, illegible). Proven by an exact COUNT of
    /// every tint accessor this file may name: the chip's one `.background` site
    /// (`panelKindChipTint`) plus the pill style's one fill site (`panelKindPillFill`), and the
    /// base `panelKindTint(` never named directly (the ladder and the chip both derive from it in
    /// `Theme`, not here). A third site — a glyph, a text run — moves a count and reds this.
    func testTheTintIsNamedNowhereElseInThisFile() throws {
        let code = try loadCodeOnly("Sources/AppShell/ShellPanel.swift")
        XCTAssertEqual(code.components(separatedBy: "Theme.panelKindChipTint(").count - 1, 1,
                       "panelKindChipTint must be named at exactly the chip's .background site")
        XCTAssertEqual(code.components(separatedBy: "Theme.panelKindPillFill(").count - 1, 1,
                       "panelKindPillFill must be named at exactly the pill style's fill site")
        XCTAssertEqual(code.components(separatedBy: "Theme.panelKindTint(").count - 1, 0,
                       "the base tint accessor must not be named directly here — Theme derives every use")
    }

    /// Both favicons (pill, chip) explicitly keep `Theme.textMuted` — the pill's rule extended to
    /// the chip on purpose (this file's own `PanelTabKindChip` doc comment), not merely untouched
    /// by accident.
    func testBothFaviconsStillNameTheNeutralInk() throws {
        let code = try loadCodeOnly("Sources/AppShell/ShellPanel.swift")
        for favicon in ["panelTabFaviconSystemImage(tab.kind)", "panelTabFaviconSystemImage(kind)"] {
            guard let range = code.range(of: favicon) else {
                return XCTFail("favicon call site \(favicon) not found — did it move or get renamed?")
            }
            // The window between the Image line and the next `Image`/`.background`/`Button(` is
            // exactly the favicon's own modifier chain — narrow enough that a foregroundStyle
            // found in it can only belong to this glyph.
            let after = code[range.upperBound...]
            let window = after.prefix(200)
            XCTAssertTrue(window.contains(".foregroundStyle(Theme.textMuted)"),
                          "favicon \(favicon) no longer names Theme.textMuted nearby: \(window)")
        }
    }

    // MARK: - Helpers (mirrors TranscriptBrandTests' § 3.5-method helpers; private to each file
    // by Swift's own rule, so duplicated rather than shared — same posture that file's own
    // duplication of SidebarBrandTests' brightness helper already established)

    private func assetName(_ kind: PanelTabKind) -> String {
        switch kind {
        case .web: return "PanelKindWebTint"
        case .document: return "PanelKindDocumentTint"
        case .code: return "PanelKindCodeTint"
        case .note: return "PanelKindNoteTint"
        case .diff: return "PanelKindDiffTint"
        case .files: return "PanelKindFilesTint"
        }
    }

    private func assertAppliedBeforeItsRowStyle(marker: String, lines: [Substring], label: String,
                                                file: StaticString = #filePath, line: UInt = #line) throws {
        guard let tintLine = lines.firstIndex(where: { $0.contains(marker) }) else {
            XCTFail("\(label): \(marker) not found — the tint wiring moved or was removed", file: file, line: line)
            return
        }
        guard let styleLine = lines[tintLine...].firstIndex(where: { $0.contains(".buttonStyle(ShellSidebarRowStyle(") }) else {
            XCTFail("\(label): no ShellSidebarRowStyle application found after its tint", file: file, line: line)
            return
        }
        XCTAssertGreaterThan(styleLine, tintLine,
                             "\(label): the row style must apply AFTER the tint (so its fill lands on top)",
                             file: file, line: line)
        // Locality, by STRUCTURE rather than a raw line count — this file's own doc comments run
        // well past a dozen lines (a fixed small threshold failed here on exactly that: 13 lines
        // of pre-existing `panel-shell T13` commentary sit between `PanelTabPill`'s tint and its
        // `.buttonStyle`, and that gap is entirely legitimate). What actually distinguishes "the
        // tint's own style" from "some unrelated match further down the file" is whether a NEW
        // type starts in between — if it does, the match escaped `PanelTabPill`/`PanelTabKindChip`
        // into whatever comes after it.
        let between = lines[(tintLine + 1)..<styleLine]
        XCTAssertFalse(between.contains(where: { $0.contains("struct ") }),
                       "\(label): a new type starts between the tint and the matched row style — likely the wrong call site",
                       file: file, line: line)
    }

    private func codeLines(_ relative: String) throws -> [Substring] {
        try loadCodeOnly(relative).split(separator: "\n", omittingEmptySubsequences: false)
    }

    /// Loads `relative` and strips it to code-only in one step — a distinct name from `codeOnly`
    /// below (not an overload differing only in `throws`) so which one applies at a call site is
    /// never left to inference.
    private func loadCodeOnly(_ relative: String) throws -> String {
        codeOnly(try source(relative))
    }

    /// Identical to `TranscriptBrandTests.codeOnly` — strips lines whose first non-space
    /// characters are `//`, so a doc comment mentioning these call sites in prose (this very file
    /// does, extensively) cannot masquerade as a second real one.
    private func codeOnly(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
            .joined(separator: "\n")
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: sourceRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    private func sourceRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func luminance(_ color: NSColor) -> CGFloat {
        func linear(_ v: CGFloat) -> CGFloat { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(color.redComponent)
             + 0.7152 * linear(color.greenComponent)
             + 0.0722 * linear(color.blueComponent)
    }

    /// WCAG relative-contrast — `docs/brand.md` § 3.5's method, identical formula to
    /// `TranscriptBrandTests.contrast`.
    private func contrast(_ a: NSColor, _ b: NSColor) -> CGFloat {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// Alpha-composite `top` over an opaque `bottom` — identical to
    /// `TranscriptBrandTests.composite`; how a wash (or a translucent system ink, § 2 above)
    /// actually reaches the eye.
    private func composite(_ top: NSColor, over bottom: NSColor) -> NSColor {
        composite(top, alphaScale: 1, over: bottom)
    }

    /// The ladder/chip variant: the SAME hue at `scale ×` its authored alpha — exactly what
    /// `Color.opacity(multiplier)` produces at render time (§ 1's measured multiply-not-replace
    /// fact), so § 2's measurements are of the literal painted composites.
    private func composite(_ top: NSColor, alphaScale scale: Double, over bottom: NSColor) -> NSColor {
        let a = min(top.alphaComponent * CGFloat(scale), 1)
        return NSColor(srgbRed: top.redComponent * a + bottom.redComponent * (1 - a),
                       green: top.greenComponent * a + bottom.greenComponent * (1 - a),
                       blue: top.blueComponent * a + bottom.blueComponent * (1 - a), alpha: 1)
    }

    private func srgb(_ color: NSColor, _ appearance: NSAppearance.Name) -> NSColor {
        var resolved = color
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB) ?? color
        }
        return resolved
    }
}
