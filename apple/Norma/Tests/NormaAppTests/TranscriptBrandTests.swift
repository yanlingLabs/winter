import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// mac-chat-parity Task 8 — the transcript wears the brand.
///
/// Three kinds of pin live here, and they are NOT of equal weight:
///
/// 1. **Value pins.** Every `Theme` token is measured against the hex `docs/brand.md` § 1 publishes,
///    in both appearances. Transcribed from that document's tables by hand — never from
///    `Theme.swift`'s doc comments, which is exactly the mistake brand.md § 6 records the iOS side
///    making (two of its comments quote hexes their own assets no longer carry).
/// 2. **Behavioural pins.** What a prose role actually renders as: a real `NSFont`, and the fonts a
///    real `AttributedString` comes out carrying. These carry the weight of the serif claim.
/// 3. **Wiring pins**, labelled as such where they appear — they say "this call site declares that
///    role", which is nearly a restatement of the code. Kept because they are what a mutation trips,
///    not counted as coverage.
///
/// What NONE of this covers: whether any of it LOOKS right. Serif size and rhythm, how prominent the
/// activity rows now read, whether the accent chrome is too strong — those are the user's live gate,
/// and no assertion here should be read as standing in for it.
@MainActor
final class TranscriptBrandTests: XCTestCase {
    // MARK: - 1. The palette, at value level

    /// `docs/brand.md` § 1, transcribed. Light, dark, and alpha (only `ComposerRim` carries one).
    private static let documentedPalette: [String: (light: String, dark: String, lightAlpha: CGFloat, darkAlpha: CGFloat)] = [
        // The eleven mirrored from iOS
        "Canvas": ("F5F4F0", "181816", 1, 1),
        "CardSurface": ("F9F9F7", "20201F", 1, 1),
        "SelectionPill": ("E8E6E1", "0B0B0B", 1, 1),
        "ElevatedSurface": ("F2F2F7", "272726", 1, 1),
        "ControlSurface": ("F0EFEC", "32322F", 1, 1),
        "BubbleUser": ("F0EFEC", "32322F", 1, 1),
        "ComposerSurface": ("F9F9F7", "272726", 1, 1),
        "ComposerRim": ("FFFFFF", "FFFFFF", 0.90, 0.08),
        "TextMuted": ("7A7974", "9E9D96", 1, 1),
        "InverseCanvas": ("2A2A27", "FAF9F5", 1, 1),
        "AccentColor": ("2E9484", "2E9484", 1, 1),
        // The three Mac-only tokens
        "RowHover": ("EFEDE8", "101010", 1, 1),
        "Hairline": ("E5E2DC", "2A2A28", 1, 1),
        "HairlineElevated": ("D8D5CF", "3A3A38", 1, 1),
        "PaletteSurface": ("FFFFFF", "272726", 1, 1),
        // diff-tabs — the diff pair (two foreground roles, two row washes). Task 9 landed the roles
        // PROVISIONALLY; Task 10 measured them and this table is now transcribed from
        // `docs/brand.md` § 3.6 like every row above it. The dark red MOVED in that measurement
        // (`F2555A` → `FF6B70`): the provisional measured 4.08:1 on its own wash, under the 4.5:1
        // floor, and the wash is exactly the ground those numbers are drawn on.
        // The washes are the second and third rows in this table to carry an alpha at all.
        "DiffRemoved": ("B3261E", "FF6B70", 1, 1),
        "DiffAdded": ("1F7A3D", "4CC38A", 1, 1),
        "DiffAddedWash": ("22C55E", "22C55E", 0.10, 0.16),
        "DiffRemovedWash": ("EF4444", "EF4444", 0.10, 0.16),
        // diff-tabs Task 12 — the five panel-kind tints (Mac-only: the panel strip has no iOS
        // surface). Same hue both appearances; only the alpha differs. The dark alpha is the
        // brief's uniform 14% provisional, unchanged, for all five. The LIGHT alpha is the
        // brief's uniform 8% provisional ONLY for `document`/`note` — `web`/`code`/`diff` were
        // measured to drown `RowHover`'s hover cue at 8% (as low as 1.009:1) and are tuned down
        // to where the hover delta and the wash's own visibility against `CardSurface` are equal,
        // the best either can do given those two tokens are fixed. `docs/brand.md` § 3.7
        // publishes every ratio and the identity behind the floor.
        // Ladder retune, live-gate ruling 2026-08-15 (brand.md § 3.7): rest alphas — light a flat
        // 0.12, dark 0.19 except note's 0.17 (the label-legibility ceiling at the selected rung).
        "PanelKindWebTint": ("3B82F6", "3B82F6", 0.12, 0.19),
        "PanelKindDocumentTint": ("F59E0B", "F59E0B", 0.12, 0.19),
        "PanelKindCodeTint": ("8B5CF6", "8B5CF6", 0.12, 0.19),
        "PanelKindNoteTint": ("EAB308", "EAB308", 0.12, 0.17),
        "PanelKindDiffTint": ("22C55E", "22C55E", 0.12, 0.19),
        // editor-product Task 2 — the sixth panel-kind tint, added under the SAME ladder model
        // (this task shipped after the live-gate ruling, never saw the old RowHover-occlusion
        // model at all). Slate, at the same flat 0.12 / 0.19 rest alphas as web/document/code/diff
        // — measured to clear every § 3.7 floor with margin at those values, no note-style
        // exception needed.
        "PanelKindFilesTint": ("64748B", "64748B", 0.12, 0.19),
    ]

    /// The catalog IS the palette brand.md publishes. `SidebarBrandTests` already pins that every
    /// name resolves; this pins what each one resolves TO — the failure a name check cannot see,
    /// which is a value quietly drifting away from the document that governs both platforms.
    func testEveryTokenMatchesTheHexDocumentedInBrandMd() {
        for (name, expected) in Self.documentedPalette {
            guard let color = NSColor(named: name) else {
                XCTFail("\(name) is missing from Assets.xcassets"); continue
            }
            assertColor(color, name: name, appearance: .aqua,
                        hex: expected.light, alpha: expected.lightAlpha)
            assertColor(color, name: name, appearance: .darkAqua,
                        hex: expected.dark, alpha: expected.darkAlpha)
        }
    }

    /// The transcription is TOTAL — a token added without a row above would otherwise be silently
    /// unpinned by the loop, which only walks what it was given.
    ///
    /// Fix round 1 (review M4): this compared two HAND-MAINTAINED lists (`documentedPalette` against
    /// `Theme.assetColorNames`), so a colorset added to the catalog and named by neither stayed
    /// invisible to it. The **catalog on disk** is the third party that settles it.
    func testTheDocumentedPaletteCoversEveryColorsetInTheCatalog() throws {
        let catalog = try FileManager.default
            .contentsOfDirectory(at: sourceRoot().appendingPathComponent("Assets.xcassets"),
                                 includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "colorset" }
            .map { $0.deletingPathExtension().lastPathComponent }
        XCTAssertFalse(catalog.isEmpty, "the scan must actually be reading the catalog")
        XCTAssertEqual(Set(catalog), Set(Self.documentedPalette.keys),
                       "every colorset needs a brand.md-transcribed row here, and vice versa")
        XCTAssertEqual(Set(catalog), Set(Theme.assetColorNames),
                       "…and a name in Theme, or nothing in Swift can reach it")
    }

    /// **The fix-round-1 pin (review IMPORTANT-1).** `Theme.hairline` is defined against the shell's
    /// planes and measures **1.040:1 on `ElevatedSurface` in dark** — a rule that is very nearly not
    /// drawn. Moving the transcript's cards onto `ElevatedSurface` put three rules on that ground
    /// (a multi-question card's separators, a code block's rim — which inside a plan card has the
    /// IDENTICAL fill either side of it — and the "latest" pill), so the plane got its own token.
    ///
    /// This asserts the property the token exists for, not its hex (§ 1's pin already does that):
    /// it must beat the shell hairline on the elevated plane, in BOTH appearances, by a margin that
    /// is actually visible. 1.25 is the floor, chosen as "at least what `hairline` achieves on its
    /// own defined ground" (1.175 light / 1.236 dark on `Canvas`).
    func testTheElevatedHairlineActuallySeparatesOnItsOwnPlane() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let ground = srgb(NSColor(named: "ElevatedSurface")!, appearance)
            let elevated = contrast(srgb(NSColor(named: "HairlineElevated")!, appearance), ground)
            let shell = contrast(srgb(NSColor(named: "Hairline")!, appearance), ground)
            XCTAssertGreaterThan(elevated, 1.25,
                                 "HairlineElevated is invisible on its own plane in \(appearance.rawValue)")
            XCTAssertGreaterThan(elevated, shell,
                                 "…and it must beat the shell hairline there, or it has no reason to exist")
        }
    }

    /// The two halves move in OPPOSITE directions from `Hairline`'s — darker in light, lighter in
    /// dark — which is exactly why it is an authored asset and not `hairline.opacity(…)`
    /// (`docs/brand.md` § 3.1). A future tune that made it a uniform darkening would silently
    /// reintroduce the dark-mode hole this token was minted to close.
    func testTheElevatedHairlineDivergesFromTheShellHairlineInBothDirections() {
        let lightElevated = luminance(srgb(NSColor(named: "HairlineElevated")!, .aqua))
        let lightShell = luminance(srgb(NSColor(named: "Hairline")!, .aqua))
        let darkElevated = luminance(srgb(NSColor(named: "HairlineElevated")!, .darkAqua))
        let darkShell = luminance(srgb(NSColor(named: "Hairline")!, .darkAqua))
        XCTAssertLessThan(lightElevated, lightShell, "darker than the shell hairline in light")
        XCTAssertGreaterThan(darkElevated, darkShell, "…and lighter in dark")
    }

    private func luminance(_ color: NSColor) -> CGFloat {
        func linear(_ v: CGFloat) -> CGFloat { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(color.redComponent)
             + 0.7152 * linear(color.greenComponent)
             + 0.0722 * linear(color.blueComponent)
    }

    /// WCAG relative-contrast, the same formula `docs/brand.md` § 3.5's table was measured with.
    private func contrast(_ a: NSColor, _ b: NSColor) -> CGFloat {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// The one plane relationship this task introduced inside the transcript: cards and tool-output
    /// blocks sit on `ElevatedSurface`, one step above the content side's `CardSurface`. "One step"
    /// has a direction — in light it is *darker* (a retained cool system grey, which is why brand.md
    /// § 1 says it cannot serve as `PaletteSurface`) and in dark it is *lighter*. Either way it must
    /// DIFFER, or the cards read as unbounded text.
    func testElevatedSurfaceIsDistinctFromTheContentPlaneInBothAppearances() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let card = srgb(NSColor(named: "CardSurface")!, appearance)
            let elevated = srgb(NSColor(named: "ElevatedSurface")!, appearance)
            XCTAssertNotEqual(hexString(card), hexString(elevated),
                              "ElevatedSurface must not equal CardSurface in \(appearance.rawValue)")
        }
    }

    /// **The pin that would have caught the value this task had to change** (diff-tabs Task 10).
    ///
    /// A diff role is TEXT — the gutter numbers, the ± markers, the chip's `-N +M` — so it owes the
    /// 4.5:1 body floor, and it owes it on every ground it is actually drawn on. Three, and the
    /// second is the one that bites: `CardSurface` (the panel's own plane, and the transcript's),
    /// **its own wash** (an added row's numbers sit on the added tint), and `ControlSurface` (the
    /// transcript chip's capsule fill). Task 9's provisional dark red measured 4.83:1 on the panel
    /// and 4.08:1 on its own wash — passing the obvious check and failing the real one.
    ///
    /// Ratios are asserted against a FLOOR rather than pinned to the published figures: § 3.6's
    /// table is what records the measurements, and pinning them twice would make a deliberate tune
    /// fail here for no reason. What must not change is that they clear the floor.
    func testTheDiffRolesClearTheBodyTextFloorOnEveryGroundTheyAreDrawnOn() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let card = srgb(NSColor(named: "CardSurface")!, appearance)
            let control = srgb(NSColor(named: "ControlSurface")!, appearance)
            for (role, wash) in [("DiffAdded", "DiffAddedWash"), ("DiffRemoved", "DiffRemovedWash")] {
                let ink = srgb(NSColor(named: role)!, appearance)
                let tint = srgb(NSColor(named: wash)!, appearance)
                for (groundName, ground) in [("CardSurface", card), ("ControlSurface", control),
                                             ("its own wash", composite(tint, over: card))] {
                    XCTAssertGreaterThanOrEqual(
                        contrast(ink, ground), 4.5,
                        "\(role) on \(groundName) in \(appearance.rawValue) is under the 4.5:1 body "
                            + "floor — brand.md § 3.6 publishes the measurement")
                }
            }
        }
    }

    /// The washes must actually be VISIBLE against the plane they tint, in both appearances — a
    /// full-row tint nobody can see is a feature that silently is not there. The floor is
    /// deliberately low (`Hairline` manages 1.175:1 on its own ground): this is a background tint
    /// under code, not a border.
    func testTheDiffWashesAreVisibleAgainstThePanelPlane() {
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let card = srgb(NSColor(named: "CardSurface")!, appearance)
            for wash in ["DiffAddedWash", "DiffRemovedWash"] {
                let ground = composite(srgb(NSColor(named: wash)!, appearance), over: card)
                XCTAssertGreaterThan(contrast(ground, card), 1.05,
                                     "\(wash) is invisible on CardSurface in \(appearance.rawValue)")
                // …and still a WASH: a tint this heavy would be a highlight, and the code on it
                // would be reading against a colour rather than against the panel.
                XCTAssertLessThan(contrast(ground, card), 1.6,
                                  "\(wash) has stopped being a wash in \(appearance.rawValue)")
            }
        }
    }

    /// Alpha-composite `top` over an opaque `bottom` — how a wash actually reaches the eye, and the
    /// only honest ground to measure text contrast against on a tinted row.
    private func composite(_ top: NSColor, over bottom: NSColor) -> NSColor {
        let a = top.alphaComponent
        return NSColor(srgbRed: top.redComponent * a + bottom.redComponent * (1 - a),
                       green: top.greenComponent * a + bottom.greenComponent * (1 - a),
                       blue: top.blueComponent * a + bottom.blueComponent * (1 - a), alpha: 1)
    }

    private func assertColor(_ color: NSColor, name: String, appearance: NSAppearance.Name,
                             hex: String, alpha: CGFloat,
                             file: StaticString = #filePath, line: UInt = #line) {
        let resolved = srgb(color, appearance)
        XCTAssertEqual(hexString(resolved), hex,
                       "\(name) in \(appearance.rawValue) — brand.md § 1 says #\(hex)",
                       file: file, line: line)
        XCTAssertEqual(resolved.alphaComponent, alpha, accuracy: 0.005,
                       "\(name)'s alpha in \(appearance.rawValue)", file: file, line: line)
    }

    private func srgb(_ color: NSColor, _ appearance: NSAppearance.Name) -> NSColor {
        var resolved = color
        NSAppearance(named: appearance)!.performAsCurrentDrawingAppearance {
            resolved = color.usingColorSpace(.sRGB) ?? color
        }
        return resolved
    }

    private func hexString(_ color: NSColor) -> String {
        String(format: "%02X%02X%02X",
               Int(color.redComponent * 255 + 0.5),
               Int(color.greenComponent * 255 + 0.5),
               Int(color.blueComponent * 255 + 0.5))
    }

    // MARK: - 2. Serif assistant prose (brand.md § 4, allowlist binding #4)

    /// The claim in one assertion: what Norma SAYS is set in a serif, and nothing else on this
    /// surface is. Pinned on the resolved `NSFont`, not on the enum case that asked for it — a role
    /// that silently fell back to the system sans (the `guard` in `Theme.assistantProse`) would
    /// still satisfy any check written against the case.
    ///
    /// Serif-ness is read off the FAMILY rather than `symbolicTraits`: measured on this OS, the
    /// system serif reports symbolic traits of `0x0`, identical to the system sans — the serif class
    /// bits are simply not set on it, so a trait check would pass on either face and prove nothing.
    func testAssistantProseIsSerifAndTheSansRoleIsNot() {
        let assistant = transcriptProseFont(.assistant, size: 15.5, weight: .regular)
        let sans = transcriptProseFont(.sans, size: 14, weight: .regular)

        XCTAssertTrue(isSerif(assistant),
                      "assistant prose must resolve to a serif face, got \(assistant.fontName)")
        XCTAssertFalse(isSerif(sans), "the sans role must NOT be serif, got \(sans.fontName)")
        XCTAssertEqual(sans, NSFont.systemFont(ofSize: 14, weight: .regular),
                       "the sans role is the plain system font, by doing nothing to it")
        XCTAssertNotEqual(assistant.familyName, sans.familyName,
                          "the two roles must be visibly different faces")
        XCTAssertFalse(assistant.fontDescriptor.symbolicTraits.contains(.monoSpace))
    }

    /// The serif is New York — the system serif brand.md § 4 names, no bundled font file. Pinned by
    /// name because "which serif" is the instruction; a different serif substituted later would
    /// satisfy every family comparison above while changing the product's voice. Same convention
    /// `SidebarBrandTests` uses for the sidebar's SF Symbols.
    func testTheSerifIsNewYork() {
        XCTAssertTrue(transcriptProseFont(.assistant, size: 15.5, weight: .regular)
            .fontName.contains("NewYork"),
                      "brand.md § 4 names New York as the system serif")
    }

    /// The family the system's own serif design resolves to, computed once so every serif check
    /// below compares against a real font rather than a hardcoded internal family name.
    private func isSerif(_ font: NSFont) -> Bool {
        let reference = NSFont.systemFont(ofSize: 14)
        guard let descriptor = reference.fontDescriptor.withDesign(.serif),
              let serif = NSFont(descriptor: descriptor, size: 14) else {
            XCTFail("this OS has no system serif design at all"); return false
        }
        return font.familyName == serif.familyName
    }

    /// The failure this catches is invisible and would ruin the effect: `NSFontManager.convert` is
    /// how `MessageTextFormatter` builds every **bold** and *italic* run, and it is free to fall back
    /// to a different family when the requested trait is unavailable. If it did, every emphasis in a
    /// serif paragraph would render in SF mid-sentence. Measured to hold on this OS; pinned so it
    /// stays measured rather than assumed.
    func testSerifProseSurvivesBoldAndItalicConversion() {
        let serif = transcriptProseFont(.assistant, size: 15.5, weight: .regular)
        for trait in [NSFontTraitMask.boldFontMask, .italicFontMask] {
            let converted = NSFontManager.shared.convert(serif, toHaveTrait: trait)
            XCTAssertTrue(isSerif(converted),
                          "a \(trait == .boldFontMask ? "bold" : "italic") run left the serif family "
                          + "(became \(converted.fontName))")
            XCTAssertEqual(converted.pointSize, serif.pointSize, "…and it must not resize either")
        }
    }

    /// **The parity pin, rewritten by ruling (2026-08-13: "the iOS here is source of truth. the
    /// Mac should follow it").** Until that ruling this test asserted the OPPOSITE — x-height
    /// (optical) parity, with the serif taking more points — encoding the measurement as law.
    /// The ruling retired the measurement's rule-status: iOS sets both prose roles at one nominal
    /// style, so the Mac's two roles now share ONE ladder, and this pins that sharing in both
    /// directions — every size equal, the faces distinct, the serif leading strictly wider (iOS's
    /// own lineSpacing(6)-on-serif-only distinction).
    ///
    /// The old measurement survives as the ACCEPTED PROPERTY (brand.md § 4.1): at the shared size
    /// the serif genuinely reads ~10% optically lighter. Pinned as a fact so the doc's claim
    /// stays measured — if the OS ever changed the faces until it stopped being true, the doc
    /// would be wrong and this would say so.
    func testTheTwoProseRolesShareOneNominalSizeByRuling() {
        let serif = transcriptProseMetrics(.assistant)
        let sans = transcriptProseMetrics(.sans)
        XCTAssertEqual(serif.bodySize, sans.bodySize, "one body size, by ruling")
        XCTAssertEqual(serif.quoteSize, sans.quoteSize, "one quote size")
        XCTAssertEqual(serif.headingSizes, sans.headingSizes, "one heading run")
        XCTAssertEqual(serif.codeSizeDrop, sans.codeSizeDrop, "one inline-code drop")
        XCTAssertGreaterThan(serif.lineSpacing, sans.lineSpacing,
                             "leading is the ONE metric the roles keep distinct — serif wider")

        let serifBody = transcriptProseFont(.assistant, size: serif.bodySize, weight: .regular)
        let sansBody = transcriptProseFont(.sans, size: sans.bodySize, weight: .regular)
        XCTAssertEqual(serifBody.pointSize, sansBody.pointSize, "the same nominal size, rendered")
        XCTAssertNotEqual(serifBody.familyName, sansBody.familyName,
                          "…in two visibly different faces")
        // The accepted property, kept measured: New York's shorter x-height means the serif
        // reads optically lighter at the shared size (~10% on this OS).
        XCTAssertLessThan(serifBody.xHeight, sansBody.xHeight,
                          "brand.md § 4.1's accepted property stopped being true on this OS")
    }

    /// The renderer is where the face actually lands: `MessageTextFormatter` builds an
    /// `AttributedString` whose every run carries its own font, so this asserts the shipped pipeline
    /// rather than the helper feeding it. Code runs stay monospaced in BOTH roles — a serif code
    /// span would be its own defect.
    func testTheMarkdownRendererCarriesTheRolesFaceAndKeepsCodeMonospaced() {
        for (role, wantSerif) in [(TranscriptProseRole.assistant, true), (.sans, false)] {
            let metrics = transcriptProseMetrics(role)
            let string = MessageTextFormatter.chatInlineAttributedString(
                "plain **bold** and `code`",
                colorScheme: .light,
                baseFont: transcriptProseFont(role, size: metrics.bodySize, weight: .regular),
                codeFont: .monospacedSystemFont(ofSize: metrics.codeSize(for: metrics.bodySize),
                                                weight: .regular),
                lineSpacing: metrics.lineSpacing)

            let fonts = fontsByRun(string)
            XCTAssertGreaterThanOrEqual(fonts.count, 3,
                                        "\(role): plain / bold / code are three distinct runs")
            let proseFonts = fonts.filter { !$0.fontDescriptor.symbolicTraits.contains(.monoSpace) }
            XCTAssertFalse(proseFonts.isEmpty, "\(role) produced no prose runs")
            for font in proseFonts {
                XCTAssertEqual(isSerif(font), wantSerif,
                               "\(role): a prose run rendered as \(font.fontName)")
            }
            XCTAssertTrue(fonts.contains { $0.fontDescriptor.symbolicTraits.contains(.monoSpace) },
                          "\(role): the `code` span must stay monospaced")
        }
    }

    private func fontsByRun(_ string: AttributedString) -> [NSFont] {
        let ns = NSAttributedString(string)
        var fonts: [NSFont] = []
        ns.enumerateAttribute(.font, in: NSRange(location: 0, length: ns.length)) { value, _, _ in
            if let font = value as? NSFont { fonts.append(font) }
        }
        return fonts
    }

    /// Fix round 1 (review M5): the report calls `themeColor`'s `colorScheme` parameter
    /// "load-bearing" — this is what makes that a checked claim rather than a described one. If the
    /// resolve ever stopped honouring the caller's scheme (a dynamic `NSColor` handed straight into
    /// an `NSAttributedString` resolves against whatever appearance is current when it is DRAWN),
    /// both branches would return the same colour and the inline-code chip would silently ignore a
    /// view forced to the other scheme.
    func testThemeColorResolvesForTheCallersSchemeNotTheAmbientOne() {
        let light = MessageTextFormatter.themeColor("ControlSurface", colorScheme: .light)
        let dark = MessageTextFormatter.themeColor("ControlSurface", colorScheme: .dark)
        XCTAssertNotEqual(hexString(light), hexString(dark),
                          "colorScheme is not reaching the resolve")
        XCTAssertEqual(hexString(light), Self.documentedPalette["ControlSurface"]!.light)
        XCTAssertEqual(hexString(dark), Self.documentedPalette["ControlSurface"]!.dark)
    }

    // MARK: - 3. Which surface takes which role

    /// **A WIRING PIN, NOT COVERAGE** — the same species as `ModelPickerTests.swift:767`. It restates
    /// the declaration next door; it is here because it is what a mutation of that declaration trips,
    /// and because "the user's own words are not set in Norma's voice" deserves to be written down as
    /// an assertion. The real weight is `testAssistantProseIsSerifAndTheSansRoleIsNot` above.
    func testTheUserBubbleDeclaresTheSansRole() {
        XCTAssertEqual(TranscriptUserBubble(text: "hi", tint: .blue).proseRole, .sans)
    }

    /// The call sites, scanned — the only way to reach them, since `TranscriptAssistantMessage`'s
    /// role is consumed inside a `body` no test here renders.
    ///
    /// It matters in BOTH directions and the two files say opposite things: the transcript's replies
    /// are allowlist binding #4 and must be `.assistant`; a plan CARD composes the very same view and
    /// must be `.sans`, because a card is chrome around a decision and brand.md § 4 allowlists the
    /// transcript reply, not model-authored text wherever it appears. A serif plan card is precisely
    /// the regression a role-parameter refactor invites, and no other assertion could see it.
    func testEveryAssistantMessageCallSiteDeclaresTheRightRole() throws {
        let expectations: [(file: String, role: String)] = [
            ("Sources/ChatContent/TranscriptView.swift", "role: .assistant"),
            ("Sources/ChatContent/PendingCards.swift", "role: .sans"),
        ]
        var total = 0
        for (file, role) in expectations {
            let lines = codeOnly(try source(file)).split(separator: "\n", omittingEmptySubsequences: false)
            let sites = lines.filter { $0.contains("TranscriptAssistantMessage(") }
            XCTAssertFalse(sites.isEmpty, "\(file) no longer constructs TranscriptAssistantMessage")
            for site in sites {
                XCTAssertTrue(site.contains(role),
                              "\(file): every call site must pass \(role) — found: \(site.trimmingCharacters(in: .whitespaces))")
            }
            total += sites.count
        }
        // Nothing else in the app may construct it: a third consumer would be an unreviewed decision
        // about whose voice it speaks in.
        XCTAssertEqual(total, try countAcrossSources("TranscriptAssistantMessage("),
                       "a new call site appeared outside the two files this pin knows about")
    }

    // MARK: - 4. No raw material, system grey, or literal colour survives in ChatContent/

    /// `docs/brand.md` § 3.1's anti-rule, enforced on the directory this task owns: colours are named
    /// asset entries or a reuse of a system SEMANTIC colour — never a hex, never an alpha derived
    /// off something else, never a blur standing in for a colour nobody chose.
    ///
    /// What is banned, and why each one:
    /// - `Material` — on an opaque window a material is a blur of whatever happens to be behind it.
    /// - `.tertiary` / `.quaternary` — the system hierarchy's faint levels. `.tertiary` composited on
    ///   `CardSurface` measures **1.86:1**, below every legibility floor; `TextMuted` is 4.14:1.
    /// - `Color(red:` / `Color.black` / `Color.white` / `NSColor.black` / `NSColor.white` — literal
    ///   colours: a hex by another name, with no light and dark halves to author.
    /// - `accentColor` — SwiftUI's app accent resolves to the **user's System Settings accent**,
    ///   because brand.md § 3.2 deliberately leaves `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`
    ///   unset. Every use of it was drawing in a colour Norma did not pick. `Theme.accent` is the
    ///   brand teal.
    ///
    /// What is NOT banned, deliberately: `.primary`/`.secondary` (system semantic, sanctioned by
    /// § 3.1), `.green`/`.red` (ditto — brand.md has no success or danger tone to reach for, § 3.4),
    /// and `NSColor.systemBlue`/`systemGreen`/`systemPurple`/`labelColor`/`linkColor`, which are the
    /// SyntaxHighlighter's code-colouring scheme rather than UI chrome.
    ///
    /// Comment lines are stripped first, so writing down the reason a value was removed is not
    /// itself a violation — `ComposerChromeTests`/`InteractionCardTests`' own convention.
    func testNoRawMaterialOrFaintSystemGreyOrLiteralColourSurvivesInChatContent() throws {
        // Fix round 1 (review M2/M3): the literal-colour ban used to catch ONE spelling. Every
        // other constructor that takes raw components — `Color(.sRGB, red:…)`, `Color(white:)`,
        // `NSColor(red:green:blue:alpha:)`, `Color(nsColor:)` wrapping one — walked straight past
        // it. Matching the constructors by their argument labels closes that; `Color(named:` and
        // `NSColor(named:` are the sanctioned spellings and contain none of these labels.
        //
        // `.opacity(` is NOT banned even though § 3.1 forbids derivation by name, because three
        // survivors are deliberate and defended in place: the accent's selection fill (an
        // appearance-INVARIANT token, so an alpha over it loses no per-appearance tuning), the code
        // block's hover rim, and the quote rule. A ban would have to carry three exemptions, which
        // is a worse fence than none; the review recorded it, and so does this comment.
        let banned = ["Material", ".tertiary", ".quaternary",
                      "(red:", "(white:", "(hue:", "(nsColor:", "(calibratedRed:", "#colorLiteral",
                      "Color.black", "Color.white", "NSColor.black", "NSColor.white", "accentColor"]
        var scanned = 0
        for file in try chatContentSources() {
            var code = codeOnly(try String(contentsOf: file, encoding: .utf8))
            // The ONE exemption, and it is not a colour: a full-frame `Color.black.opacity(0.001)`
            // behind an open sidebar overlay, whose entire job is to hit-test tap-to-dismiss without
            // visibly dimming anything. Substituting `Color.clear` there would be a behaviour change
            // to a dismissal path with no test on it, made for a lint's benefit.
            let scrim = "Color.black.opacity(0.001)"
            if file.lastPathComponent == "WindowContentView.swift" {
                XCTAssertEqual(code.components(separatedBy: scrim).count - 1, 1,
                               "the exempted scrim must still be exactly one line")
                code = code.replacingOccurrences(of: scrim, with: "")
            }
            for (index, line) in code.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                for token in banned where line.contains(token) {
                    XCTFail("\(file.lastPathComponent):\(index + 1) still uses \(token) — \(line.trimmingCharacters(in: .whitespaces))")
                }
            }
            scanned += 1
        }
        // Exact, not a floor (fix round 1, review M3): `> 10` against 12 files quietly tolerated
        // deleting two of them, which would have made the ban pass by scanning less.
        XCTAssertEqual(scanned, try chatContentSources().count)
        XCTAssertEqual(scanned, 12, "ChatContent's file count changed — confirm the new file is scanned")
    }

    /// **The fence on IMPORTANT-1's fix itself.** The two pins above prove `HairlineElevated` is a
    /// good value; neither proves anything USES it — reverting all three sites to the shell hairline
    /// would leave both of them green, which is precisely the mutation that reopens a 1.040:1
    /// separator in dark.
    ///
    /// The rule is absolute and so is the check: **`ChatContent/` draws no rule at the shell's
    /// plane.** Every rule on this surface is inside something raised — a card's separator, a code
    /// block's rim, a floating pill — so `Theme.hairline` has no legitimate site here at all. That
    /// makes this a one-token ban rather than a per-site whitelist, which is the version that
    /// survives someone adding a fourth rule.
    ///
    /// Matched by exclusion of the longer name, since `Theme.hairlineElevated` has `Theme.hairline`
    /// as a literal prefix — a naive `contains` would ban the very token this is enforcing.
    func testChatContentDrawsNoRuleAtTheShellHairlinePlane() throws {
        var elevatedSites = 0
        for file in try chatContentSources() {
            let code = codeOnly(try String(contentsOf: file, encoding: .utf8))
            for (index, line) in code.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                var rest = Substring(line)
                while let hit = rest.range(of: "Theme.hairline") {
                    let after = rest[hit.upperBound...]
                    if after.hasPrefix("Elevated") {
                        elevatedSites += 1
                    } else {
                        XCTFail("\(file.lastPathComponent):\(index + 1) draws a rule with the SHELL "
                                + "hairline — on this surface that measures 1.040:1 in dark. Use "
                                + "Theme.hairlineElevated: \(line.trimmingCharacters(in: .whitespaces))")
                    }
                    rest = rest[hit.upperBound...]
                }
            }
        }
        XCTAssertEqual(elevatedSites, 6,
                       "the question separator, the code-block rim, the latest pill, the "
                       + "interaction card's own rim, the pending box's option separators and its "
                       + "header pills — all six, or this pin is passing because the rules stopped "
                       + "being drawn at all")
    }

    /// The other half: the directory does not merely AVOID raw values, it reaches for the tokens.
    /// A file that stopped drawing anything would pass the ban above trivially.
    func testTheTranscriptSurfaceActuallyNamesBrandTokens() throws {
        for name in ["TranscriptMessageViews.swift", "PendingCards.swift", "TranscriptView.swift",
                     "WindowContentView.swift", "SessionSidebar.swift"] {
            let code = codeOnly(try source("Sources/ChatContent/\(name)"))
            XCTAssertTrue(code.contains("Theme."), "\(name) names no brand token at all")
        }
    }

    // MARK: - 5. The two type ladders

    /// **A DRIFT FENCE, NOT COVERAGE** — it restates the constants next door, so mutating either
    /// side moves both; kept because the ladder's VALUES are a claim worth writing down. Until
    /// the 2026-08-13 ruling this pinned the donor's 14-pt sans ladder ("did not move"); the
    /// ruling MOVED it — iOS is the source of truth, its two prose roles share one nominal size,
    /// and the Mac's sans ladder unified onto the assistant's figures. The unification itself
    /// (equal to the serif role, leading apart) is `testTheTwoProseRolesShareOneNominalSizeByRuling`'s
    /// job; this pins what the shared figures ARE.
    func testTheUnifiedLadderCarriesTheRuledValues() {
        let sans = transcriptProseMetrics(.sans)
        XCTAssertEqual(sans.bodySize, 15.5)
        XCTAssertEqual(sans.quoteSize, 15)
        XCTAssertEqual(sans.lineSpacing, 3, "the sans keeps its own tighter leading")
        XCTAssertEqual([1, 2, 3, 4].map(sans.headingSize), [22, 19, 17, 16])
        XCTAssertEqual(sans.codeSize(for: sans.bodySize), 13.5,
                       "inline code still lands where this surface always set it")
    }

    /// Both ladders must be internally ordered — a heading that is smaller than the body it heads,
    /// or a quote larger than the prose around it, is a layout bug the eye catches long after a
    /// number was nudged.
    func testBothLaddersDescendAndStayAboveTheBody() {
        for role in [TranscriptProseRole.assistant, .sans] {
            let m = transcriptProseMetrics(role)
            let headings = [1, 2, 3, 4].map(m.headingSize)
            XCTAssertEqual(headings, headings.sorted(by: >), "\(role): headings must descend")
            XCTAssertGreaterThan(headings.last!, m.bodySize, "\(role): H4 must still outrank body")
            XCTAssertLessThan(m.quoteSize, m.bodySize, "\(role): a quote is one step down")
            XCTAssertGreaterThan(m.lineSpacing, 0)
        }
    }

    /// `headingSize` is TOTAL: markdown levels 5 and 6 exist, and a malformed `level` must not trap.
    /// The donor's own rule — everything past 4 takes the last entry.
    func testHeadingSizeIsTotalOverEveryLevel() {
        for role in [TranscriptProseRole.assistant, .sans] {
            let m = transcriptProseMetrics(role)
            XCTAssertEqual(m.headingSize(6), m.headingSize(4))
            XCTAssertEqual(m.headingSize(99), m.headingSize(4))
            XCTAssertEqual(m.headingSize(0), m.headingSize(1), "a nonsense level takes H1, not a crash")
            XCTAssertEqual(m.headingSize(-3), m.headingSize(1))
        }
    }

    /// Inline code never shrinks below the donor's readability floor, however deep the heading.
    func testInlineCodeNeverShrinksBelowTheFloor() {
        for role in [TranscriptProseRole.assistant, .sans] {
            XCTAssertEqual(transcriptProseMetrics(role).codeSize(for: 11), 11.5)
            XCTAssertEqual(transcriptProseMetrics(role).codeSize(for: 4), 11.5)
        }
    }

    /// Inline code lands on ONE size (13.5 for body text) against either face. Before the
    /// 2026-08-13 unification the two roles got there by two DIFFERENT drops (0.5 sans, 2 serif —
    /// bodies differed, drops compensated) and this test asserted that inequality; the ruling
    /// unified the bodies, so one shared drop now does it by construction, and the inequality
    /// half is retired WITH its reason recorded rather than deleted silently.
    func testInlineCodeLandsOnOneSizeAcrossBothFaces() {
        let assistant = transcriptProseMetrics(.assistant)
        let sans = transcriptProseMetrics(.sans)
        XCTAssertEqual(assistant.codeSize(for: assistant.bodySize),
                       sans.codeSize(for: sans.bodySize))
        XCTAssertEqual(assistant.codeSize(for: assistant.bodySize), 13.5,
                       "the size this surface has always used for body-text code")
        XCTAssertEqual(assistant.codeSizeDrop, sans.codeSizeDrop,
                       "one shared drop since the ladders unified")
    }

    // MARK: - Source access (the ComposerChromeTests convention)

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: sourceRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    private func sourceRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func chatContentSources() throws -> [URL] {
        // Recursive since the 2026-08-13 typography pass: `contentsOfDirectory` was a latent
        // hole — a file added under a ChatContent/ SUBDIRECTORY would have been invisible to
        // every scan in this suite (the directory has no subdirectories today, so this changes
        // nothing yet; it stops being wrong later).
        var files: [URL] = []
        let walker = FileManager.default.enumerator(
            at: sourceRoot().appendingPathComponent("Sources/ChatContent"),
            includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            files.append(url)
        }
        return files.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// How many times a token appears across EVERY app source file, comments stripped.
    private func countAcrossSources(_ token: String) throws -> Int {
        let root = sourceRoot().appendingPathComponent("Sources")
        var count = 0
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let code = codeOnly(try String(contentsOf: url, encoding: .utf8))
            count += code.components(separatedBy: token).count - 1
        }
        return count
    }

    /// Comment lines stripped, so a doc comment naming the thing being forbidden is not a false
    /// positive — without it the check punishes writing the reason down.
    private func codeOnly(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
            .joined(separator: "\n")
    }
}
