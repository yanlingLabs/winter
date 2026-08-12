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
        "PaletteSurface": ("FFFFFF", "272726", 1, 1),
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

    /// The transcription is TOTAL — a token added to `Theme` without a row above would otherwise be
    /// silently unpinned by the loop, which only walks what it was given.
    func testTheDocumentedPaletteCoversEveryTokenThemeNames() {
        XCTAssertEqual(Set(Self.documentedPalette.keys), Set(Theme.assetColorNames),
                       "every Theme token needs a brand.md-transcribed row here, and vice versa")
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

    /// **Why the serif register is 15.5 pt and not 14.** New York's x-height is ~9% shorter than San
    /// Francisco's at equal size, so serif-at-14 would make Norma's reply read visibly smaller than
    /// the user's own message directly above it. The ladder is scaled until the x-heights agree.
    /// This is the measurement itself, kept executable — a future size tune that broke the match
    /// would be changing the thing the number was chosen for.
    func testTheSerifBodyIsSizedToMatchTheSansBodyItSitsBeside() {
        let serifBody = transcriptProseFont(.assistant, size: transcriptProseMetrics(.assistant).bodySize,
                                            weight: .regular)
        let sansBody = transcriptProseFont(.sans, size: transcriptProseMetrics(.sans).bodySize,
                                           weight: .regular)
        XCTAssertEqual(serifBody.xHeight, sansBody.xHeight, accuracy: sansBody.xHeight * 0.02,
                       "the two bodies must read as the same size (within 2%)")
        XCTAssertGreaterThan(serifBody.pointSize, sansBody.pointSize,
                             "…which takes MORE points, since New York is the shorter face")
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
        let banned = ["Material", ".tertiary", ".quaternary", "Color(red:",
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
        XCTAssertGreaterThan(scanned, 10, "the scan must actually be walking the directory")
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

    /// The sans register is the donor's ladder, unchanged — the user's own bubble and both plan cards
    /// render exactly as they did before this task. Pinned against the literal figures because
    /// "nothing moved for the sans role" is the claim; the serif ladder is a derivation of it.
    func testTheSansLadderIsTheDonorsAndDidNotMove() {
        let sans = transcriptProseMetrics(.sans)
        XCTAssertEqual(sans.bodySize, 14)
        XCTAssertEqual(sans.quoteSize, 13.5)
        XCTAssertEqual(sans.lineSpacing, 3)
        XCTAssertEqual([1, 2, 3, 4].map(sans.headingSize), [20, 17, 15.5, 14.5])
        XCTAssertEqual(sans.codeSize(for: 14), 13.5, "the donor's inline-code size for body text")
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

    /// The two drops exist so inline code reads as the same size against either face — SF Mono has
    /// to sit lower against New York than against SF. At the shipped ladders both land on the 13.5 pt
    /// this surface has always used for body-text code, which is the check: not that the drops are
    /// equal (they are not), but that what the reader SEES is.
    func testInlineCodeLandsOnOneSizeAcrossBothFaces() {
        let assistant = transcriptProseMetrics(.assistant)
        let sans = transcriptProseMetrics(.sans)
        XCTAssertEqual(assistant.codeSize(for: assistant.bodySize),
                       sans.codeSize(for: sans.bodySize))
        XCTAssertNotEqual(assistant.codeSizeDrop, sans.codeSizeDrop,
                          "…and it takes two different drops to get there")
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
        try FileManager.default
            .contentsOfDirectory(at: sourceRoot().appendingPathComponent("Sources/ChatContent"),
                                 includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
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
