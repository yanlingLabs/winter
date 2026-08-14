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
/// 2. **MEASURED pins** (§ 2) — the brief's explicit "measure, don't eyeball" requirement: the
///    hover-vs-tinted-rest contrast every tint must clear, and the identity that explains WHY the
///    floor is what it is rather than an arbitrary number, plus text legibility on every tint.
/// 3. **Wiring pins** (§ 3) — the pill/chip source really applies the token, UNDER the row
///    style's own fill, and the favicon/count glyphs stay off it. Read via source, the same
///    `codeOnly`/`source` convention `TranscriptBrandTests` uses for `ChatContent/` — no view is
///    mounted anywhere in this file, matching `SidebarBrandTests`' own stated house convention.
///
/// What NONE of this covers: whether it LOOKS right. `docs/brand.md` § 3.7 records the numbers;
/// whether a tinted tab reads as "its own kind" at a glance is the live gate, same as every other
/// visual claim in this task family (Task 9/10/11's own reports name the identical limitation).
@MainActor
final class PanelKindTintTests: XCTestCase {
    private let kinds: [PanelTabKind] = [.web, .document, .code, .note, .diff]

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

    // MARK: - 2. MEASURED: the hover-vs-tinted-rest floor, its identity, and text legibility

    /// **The measured requirement itself** (the brief, verbatim: "selected/hover states must
    /// remain clearly distinguishable on every tint in both schemes"). `ShellSidebarRowStyle`'s
    /// own fill is `.clear` at rest and OPAQUE `Theme.rowHover` on hover/selected (`PanelTabPill`
    /// wires `selectedUsesHoverTone: true`, so the two states share one token) — the row style's
    /// background paints OVER this task's tint (`ShellPanel.swift`'s own doc comment on the
    /// `.background` sites walks the z-order), so the two flat colours being compared here are
    /// exactly what a user sees: the tinted pill at rest, and opaque `RowHover` the instant it
    /// isn't.
    ///
    /// FLOORS, not the published figures (Task 10's own precedent — `docs/brand.md` § 3.6/3.7
    /// record measurements; floors gate them so a later deliberate retune doesn't red this suite
    /// for no reason). The floor is NOT an arbitrary WCAG number: `testLightHoverDeltaAnd…`
    /// below proves `hoverDelta × visibility` is FIXED at `contrast(RowHover, CardSurface)` in
    /// light — so neither term can individually clear √1.10988 ≈ 1.0535 by construction. 1.040 is
    /// comfortably under that hard ceiling with room for the worst-measured kind (`document`,
    /// 1.0477) while staying far above the un-tuned provisional's actual failures (1.009–1.016).
    /// Dark has no such ceiling (proven in the same test): 1.30 is comfortably under every
    /// measured dark value (1.357 worst case) with real margin.
    func testHoverFillStaysDistinguishableFromEveryTintedPillAtRest() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
            let rowHover = srgb(NSColor(named: "RowHover")!, appearance)
            let floor: CGFloat = appearance == .aqua ? 1.040 : 1.30
            for kind in kinds {
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let tinted = composite(tint, over: cardSurface)
                let hoverDelta = contrast(rowHover, tinted)
                XCTAssertGreaterThanOrEqual(
                    hoverDelta, floor,
                    "\(kind) in \(appearance.rawValue): hover fill drowns into the tinted rest "
                        + "fill (\(hoverDelta):1) — docs/brand.md § 3.7 records the floor's derivation")
            }
        }
    }

    /// **Why the floor above is what it is — a proof, not a claim.** In LIGHT, the tinted pill's
    /// luminance always falls BETWEEN `RowHover`'s and `CardSurface`'s (every hue here darkens
    /// `CardSurface` toward, but not past, `RowHover` at these alphas), so the two ratios
    /// TELESCOPE exactly: `contrast(RowHover, tinted) × contrast(tinted, CardSurface) ==
    /// contrast(RowHover, CardSurface)`. That product is FIXED by two tokens this task does not
    /// own, so the best any alpha can do is split it evenly — neither ratio can exceed its square
    /// root. This is the fact that turned "pick a floor" into "solve for the alpha that reaches
    /// the ceiling", per kind (`docs/brand.md` § 3.7's table).
    func testLightHoverDeltaTimesVisibilityEqualsTheFixedRowHoverCardSurfaceContrast() {
        let cardSurface = srgb(NSColor(named: "CardSurface")!, .aqua)
        let rowHover = srgb(NSColor(named: "RowHover")!, .aqua)
        let baseline = contrast(rowHover, cardSurface)
        let ceiling = sqrt(baseline)
        for kind in kinds {
            let tint = srgb(NSColor(named: assetName(kind))!, .aqua)
            let tinted = composite(tint, over: cardSurface)
            let hoverDelta = contrast(rowHover, tinted)
            let visibility = contrast(tinted, cardSurface)
            XCTAssertEqual(hoverDelta * visibility, baseline, accuracy: 0.01,
                           "\(kind): the telescoping identity broke — the floor's derivation no longer holds")
            XCTAssertLessThanOrEqual(hoverDelta, ceiling + 0.01, "\(kind): hover delta exceeded the proven ceiling")
            XCTAssertLessThanOrEqual(visibility, ceiling + 0.01, "\(kind): visibility exceeded the proven ceiling")
        }
    }

    /// **The mirror fact that explains why DARK needed no retuning at all.** In dark, `CardSurface`
    /// sits BETWEEN the tinted composite and `RowHover` (every hue here, at these alphas, pushes
    /// the composite past `CardSurface` toward black rather than stopping short of `RowHover`),
    /// so the two ratios REINFORCE instead of trading off: `contrast(RowHover, tinted) ==
    /// contrast(RowHover, CardSurface) × contrast(tinted, CardSurface)`. Raising alpha in dark
    /// only helps the hover delta — there is no ceiling to solve for, which is why every kind kept
    /// the brief's provisional 14%.
    func testDarkHoverDeltaEqualsTheFixedBaselineTimesVisibility() {
        let cardSurface = srgb(NSColor(named: "CardSurface")!, .darkAqua)
        let rowHover = srgb(NSColor(named: "RowHover")!, .darkAqua)
        let baseline = contrast(rowHover, cardSurface)
        for kind in kinds {
            let tint = srgb(NSColor(named: assetName(kind))!, .darkAqua)
            let tinted = composite(tint, over: cardSurface)
            let hoverDelta = contrast(rowHover, tinted)
            let visibility = contrast(tinted, cardSurface)
            XCTAssertEqual(hoverDelta, baseline * visibility, accuracy: 0.01,
                           "\(kind): the reinforcing identity broke in dark")
            XCTAssertGreaterThan(hoverDelta, baseline,
                                 "\(kind): dark tinting must only IMPROVE the hover delta over the untinted baseline")
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
    /// FLOORS, generous on both inks: `labelColor` never comes close to the 4.5:1 body floor on a
    /// wash this faint (worst measured: 9.29:1), so 8.0 only guards against a real regression.
    /// `TextMuted` is § 3.5's OWN established "quiet meta" register — never held to 4.5:1 even on
    /// the plain surface (4.14 light / 5.99 dark baseline) — so its floor here is relative to
    /// THAT baseline, not the body floor: the tint may cost some contrast, as any wash does
    /// (§ 3.6's own precedent: "at most 0.31 of a ratio point" for the diff washes), but not
    /// collapse it.
    func testTintedTextStaysLegibleOnEveryPillTint() {
        let labelLight = srgb(.labelColor, .aqua)
        let labelDark = srgb(.labelColor, .darkAqua)
        let textMutedLight = srgb(NSColor(named: "TextMuted")!, .aqua)
        let textMutedDark = srgb(NSColor(named: "TextMuted")!, .darkAqua)
        for kind in kinds {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                let cardSurface = srgb(NSColor(named: "CardSurface")!, appearance)
                let tint = srgb(NSColor(named: assetName(kind))!, appearance)
                let tinted = composite(tint, over: cardSurface)
                let label = appearance == .aqua ? labelLight : labelDark
                let labelOnTint = composite(label, over: tinted)
                XCTAssertGreaterThanOrEqual(contrast(labelOnTint, tinted), 8.0,
                                            "\(kind) in \(appearance.rawValue): title ink (labelColor) weakened badly")
                let textMuted = appearance == .aqua ? textMutedLight : textMutedDark
                let floor: CGFloat = appearance == .aqua ? 3.5 : 4.0
                XCTAssertGreaterThanOrEqual(contrast(textMuted, tinted), floor,
                                            "\(kind) in \(appearance.rawValue): meta/icon ink (TextMuted) dropped below its own established register")
            }
        }
    }

    // MARK: - 3. Wiring: the pill/chip source really applies the tint, and only there

    /// **The z-order the brief specifically asks for** ("layers UNDER the existing
    /// ShellSidebarRowStyle hover/selected treatment") — proven the same way this codebase already
    /// proves "this call site declares that role" (`TranscriptBrandTests
    /// .testEveryAssistantMessageCallSiteDeclaresTheRightRole`): by reading the real source, not by
    /// mounting a view. In SwiftUI, `.background` attached to a `Button` BEFORE `.buttonStyle` sits
    /// BEHIND everything the style itself draws (the style wraps the button's ORIGINAL label
    /// through the environment; a modifier applied earlier in the chain wraps around that whole
    /// result) — so "before, in file order" and "behind, on screen" are the same fact here.
    func testPillTintIsWiredBeforeTheRowStyleSoItLandsBehindIt() throws {
        let lines = try codeLines("Sources/AppShell/ShellPanel.swift")
        try assertAppliedBeforeItsRowStyle(marker: "Theme.panelKindTint(tab.kind)", lines: lines,
                                           label: "PanelTabPill")
    }

    /// The chip's identical wiring, Task 11's slot finally filled — same z-order proof.
    func testChipTintIsWiredBeforeTheRowStyleSoItLandsBehindIt() throws {
        let lines = try codeLines("Sources/AppShell/ShellPanel.swift")
        try assertAppliedBeforeItsRowStyle(marker: "Theme.panelKindChipTint(kind)", lines: lines,
                                           label: "PanelTabKindChip")
    }

    /// **The regression this task must not invite**: "finishing the job" by also tinting the
    /// favicon glyph or the chip's count digit. The brief is explicit ("the tint is the surface,
    /// not the icon") and `PanelTabKindChip`'s own doc comment names the concrete reason — at 2×
    /// opacity the wash measures ~1.1–1.2:1 as literal ink, illegible. Proven by an exact COUNT:
    /// the only two places `Theme.panelKindTint(`/`Theme.panelKindChipTint(` may appear in this
    /// file's real code are the two `.background` sites the tests above already found — a third
    /// call site (a glyph, a text run) moves this count to 3.
    func testTheTintIsNamedNowhereElseInThisFile() throws {
        let code = try loadCodeOnly("Sources/AppShell/ShellPanel.swift")
        let sites = code.components(separatedBy: "Theme.panelKindTint(").count - 1
            + code.components(separatedBy: "Theme.panelKindChipTint(").count - 1
        XCTAssertEqual(sites, 2,
                       "Theme.panelKind(Chip)Tint must be named at exactly the two .background sites")
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
        let a = top.alphaComponent
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
