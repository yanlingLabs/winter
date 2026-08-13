import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// The 2026-08-13 typography pass — `docs/brand.md` § 4 is the type source of truth and this
/// suite is its enforcement, three fences deep:
///
/// 1. **The doc is parsed, not transcribed** (`testEveryRoleMatchesTheTableInBrandMd`): every
///    role row in § 4's tables is read from the markdown itself and asserted against the live
///    tokens, both directions, with minimum-row floors so a table-format change cannot green it
///    vacuously. Editing the doc alone reds; editing a token alone reds. (Stronger than the § 1
///    palette pattern, which transcribes by hand — the doc lives in this repo, so we can afford
///    to read it.)
/// 2. **The sweep** (`testNoFontIsConstructedOutsideTheTokenFiles`): no app source outside
///    `App/Typography.swift` + `App/Theme.swift` constructs a font, names a text style inside
///    `.font(...)`, or passes a numeric literal to the token API. Recursive over `Sources/`.
///    The standalone twin lives in the mac-chat-parity typography report directory; logic is
///    identical. Known blind spots are documented in brand.md § 4.8 — each one checked, none
///    present in the app today.
/// 3. **The construction-count pin** (`testTokenFileConstructionCountIsPinned`): the token files
///    themselves cannot quietly grow an unrecorded font — adding one moves a pinned count, and
///    the failure message routes you to § 4.7's add-a-role checklist.
///
/// What NONE of this covers: whether any of it LOOKS right — that is the user's live gate.
@MainActor
final class TypographyTests: XCTestCase {
    // MARK: - 1. The doc's role tables, parsed

    /// What a parsed Mac cell must match. `sizeOnly` for roles whose weight varies at call
    /// sites (the scale); `font`/`nsFont` for baked tokens, compared against the SAME SPELLING
    /// the token file uses (SwiftUI `Font` equality is construction-based, not resolution-based).
    private enum MacExpectation {
        case sizeOnly(CGFloat)
        case font(Font)
        case nsFont(NSFont)
        case derived
    }

    /// The live-token map — every doc role whose Mac cell is NOT `—`, bound to the token it
    /// documents. Values reference the LIVE tokens (never copied numbers), so a code change
    /// diverging from the doc reds here.
    private static let macRoles: [String: MacExpectation] = [
        // Content roles
        "assistantProse": .sizeOnly(transcriptProseMetrics(.assistant).bodySize),
        "userBubble": .sizeOnly(transcriptProseMetrics(.sans).bodySize),
        "codeBlock": .sizeOnly(Typography.syntaxCodeNS.pointSize),
        "toolPhrase": .sizeOnly(Typography.captionSize),
        "toolOutputMono": .sizeOnly(Typography.captionSize),
        "transcriptError": .sizeOnly(Typography.captionSize),
        "jumpPill": .sizeOnly(Typography.captionSize),
        // Question card
        "questionText": .derived,
        "questionOption": .sizeOnly(QuestionCardType.option),
        "questionSecondary": .sizeOnly(QuestionCardType.secondary),
        "questionPill": .sizeOnly(QuestionCardType.pill),
        "questionPillCheck": .sizeOnly(Typography.badgeSize),
        "questionPreviewMono": .font(Typography.questionPreviewMono),
        // Composer
        "composerField": .derived,
        "composerPlusGlyph": .font(Typography.composerPlusGlyph),
        "composerModelPill": .sizeOnly(Typography.controlSize),
        "composerSend": .sizeOnly(Typography.bodyLargeSize),
        // The Mac chrome scale
        "micro": .sizeOnly(Typography.microSize),
        "badge": .sizeOnly(Typography.badgeSize),
        "tiny": .sizeOnly(Typography.tinySize),
        "caption": .sizeOnly(Typography.captionSize),
        "label": .sizeOnly(Typography.labelSize),
        "control": .sizeOnly(Typography.controlSize),
        "body": .sizeOnly(Typography.bodySize),
        "bodyLarge": .sizeOnly(Typography.bodyLargeSize),
        "heading": .sizeOnly(Typography.headingSize),
        "captionMono": .sizeOnly(Typography.captionSize),
        "labelMono": .sizeOnly(Typography.labelSize),
        "controlMono": .sizeOnly(Typography.controlSize),
        // Display + one-offs (weight baked → full Font equality, token-file spelling)
        "emptyStateGlyph": .font(Typography.emptyStateGlyph),
        "pairingCode": .font(Typography.pairingCode),
        "pairingGlyphLarge": .font(Typography.pairingGlyphLarge),
        "pairingGlyphMedium": .font(Typography.pairingGlyphMedium),
        "morphTrafficGlyph": .font(Typography.morphTrafficGlyph),
        // Semantic passthroughs
        "paneTitle": .font(Typography.paneTitle),
        "emptyStateTitle": .font(Typography.emptyStateTitle),
        "emptyStateSubtitle": .font(Typography.emptyStateSubtitle),
        "landingBody": .font(Typography.landingBody),
        "landingCaption": .font(Typography.landingCaption),
        "chipLabel": .font(Typography.chipLabel),
        // NSFont pipeline tokens
        "fieldCodeLabelNS": .nsFont(Typography.fieldCodeLabelNS),
        "fieldCodeBlockNS": .nsFont(Typography.fieldCodeBlockNS),
        "fieldInlineCodeNS": .derived,
        "fieldUserMessage": .derived,
        "fieldAssistantMessage": .derived,
        "shortcutKeyNS": .nsFont(Typography.shortcutKeyNS),
        "panelTabLabelNS": .nsFont(Typography.panelTabLabelNS),
        // The serif registers (Theme)
        "Theme.wordmark": .font(Theme.wordmark),
        "Theme.greeting": .font(Theme.greeting),
        "Theme.assistantProse": .derived,
    ]

    /// The expected SPELLING for each `.font`/`.nsFont` expectation, keyed by role — what the
    /// doc's cell means, constructed the way the token file constructs it. Split from `macRoles`
    /// so the assertion reads `live == documented-meaning` rather than `live == live`.
    private static let fontMeanings: [String: Font] = [
        "questionPreviewMono": .system(.body, design: .monospaced),
        "composerPlusGlyph": .system(size: 17, weight: .medium),
        "emptyStateGlyph": .system(size: 34, weight: .light),
        "pairingCode": .system(size: 22, weight: .semibold, design: .monospaced),
        "pairingGlyphLarge": .system(size: 36, weight: .regular),
        "pairingGlyphMedium": .system(size: 30, weight: .regular),
        "morphTrafficGlyph": .system(size: 8.5, weight: .bold),
        "paneTitle": .headline,
        "emptyStateTitle": .title2,
        "emptyStateSubtitle": .callout,
        "landingBody": .body,
        "landingCaption": .caption,
        "chipLabel": .caption2,
        "Theme.wordmark": .system(size: 20, weight: .semibold, design: .serif),
        "Theme.greeting": .system(size: 38, weight: .regular, design: .serif),
    ]

    private static let nsFontMeanings: [String: NSFont] = [
        "fieldCodeLabelNS": .systemFont(ofSize: 11, weight: .medium),
        "fieldCodeBlockNS": .monospacedSystemFont(ofSize: 13, weight: .regular),
        "shortcutKeyNS": .systemFont(ofSize: 11, weight: .regular),
        "panelTabLabelNS": .systemFont(ofSize: 12, weight: .regular),
    ]

    /// One parsed doc row: the backticked role name and its Mac cell, raw.
    private struct DocRow { let name: String; let mac: String; let line: Int }

    /// Every table row in brand.md § 4 whose first cell is a backticked role name.
    private func parseDocRows() throws -> [DocRow] {
        let url = repoRoot().appendingPathComponent("docs/brand.md")
        let text = try String(contentsOf: url, encoding: .utf8)
        guard let sectionStart = text.range(of: "\n## 4. Type"),
              let sectionEnd = text.range(of: "\n## 5.", range: sectionStart.upperBound..<text.endIndex) else {
            XCTFail("brand.md no longer has a § 4 Type … § 5 structure — update this parser WITH the doc")
            return []
        }
        let section = text[sectionStart.upperBound..<sectionEnd.lowerBound]
        var rows: [DocRow] = []
        for (index, rawLine) in section.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("| `") else { continue }
            // Keep interior empties (a row may have an EMPTY notes cell) and drop exactly the
            // two artifacts of the outer pipes — filtering ALL empties silently dropped every
            // noteless row on this suite's first run.
            var cells = line.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            if cells.first == "" { cells.removeFirst() }
            if cells.last == "" { cells.removeLast() }
            // Role tables are 4 columns (Role | iOS | Mac | notes); the 3-column transcript
            // LADDER table's `lineSpacing` row is metrics, not a role — pinned by
            // TranscriptBrandTests — and must not leak in here.
            guard cells.count >= 4 else { continue }
            let name = cells[0].trimmingCharacters(in: CharacterSet(charactersIn: "`"))
            // Column order everywhere in § 4.3/§ 4.6: Role | iOS | Mac | notes.
            rows.append(DocRow(name: name, mac: cells[2], line: index + 1))
        }
        return rows
    }

    /// The Mac-cell grammar (brand.md § 4.3 states it): points [`mono`] [weight] — with any
    /// trailing prose ignored — or a backticked `.style` [mono], or `derived`, or `—`.
    private enum ParsedCell: Equatable {
        /// `—` in the doc. NOT named `none`: in the `ParsedCell?` return position, `.none`
        /// resolves to Optional.none — the parser would return nil and every dash row would
        /// red as unparseable (watched happen on this suite's first run).
        case noMacSurface
        case derived
        case points(CGFloat, mono: Bool, weight: String?, serif: Bool)
        case style(String, mono: Bool)
    }

    private func parseMacCell(_ cell: String) -> ParsedCell? {
        if cell == "—" { return .noMacSurface }
        if cell.hasPrefix("derived") { return .derived }
        if cell.hasPrefix("`.") {
            guard let close = cell.dropFirst().firstIndex(of: "`") else { return nil }
            let style = String(cell[cell.index(cell.startIndex, offsetBy: 1)..<close])
            let rest = cell[cell.index(after: close)...]
            return .style(style, mono: rest.contains("mono"))
        }
        let tokens = cell.split(whereSeparator: { $0 == " " || $0 == "," })
        guard let first = tokens.first, let size = Double(first) else { return nil }
        var mono = false, serif = false
        var weight: String?
        for token in tokens.dropFirst() {
            switch token {
            case "mono": mono = true
            case "serif": serif = true
            case "light", "regular", "medium", "semibold", "bold": weight = String(token)
            default: return .points(CGFloat(size), mono: mono, weight: weight, serif: serif)
            }
        }
        return .points(CGFloat(size), mono: mono, weight: weight, serif: serif)
    }

    /// § 4's tables, against the live tokens — both directions, floors against vacuous green.
    func testEveryRoleMatchesTheTableInBrandMd() throws {
        let rows = try parseDocRows()
        XCTAssertGreaterThanOrEqual(rows.count, 75,
            "the parse found too few role rows — a doc format change has blinded it")

        var macValued: Set<String> = []
        var dashed: Set<String> = []
        for row in rows {
            guard let cell = parseMacCell(row.mac) else {
                XCTFail("\(row.name): Mac cell '\(row.mac)' does not parse — § 4.3 states the grammar")
                continue
            }
            switch cell {
            case .noMacSurface:
                dashed.insert(row.name)
            case .derived:
                macValued.insert(row.name)
                guard case .derived = Self.macRoles[row.name] else {
                    XCTFail("\(row.name) is documented as derived but not mapped as a derivation")
                    continue
                }
                // The derivation itself is pinned by InteractionCardTests; presence is enough here.
            case .points(let size, _, _, _):
                macValued.insert(row.name)
                switch Self.macRoles[row.name] {
                case .sizeOnly(let live):
                    XCTAssertEqual(live, size, "\(row.name): doc says \(size), live token is \(live)")
                case .font:
                    let meaning = try XCTUnwrap(Self.fontMeanings[row.name],
                                                "\(row.name) needs a fontMeanings entry")
                    XCTAssertEqual(fontPointSize(meaning), size,
                                   "\(row.name): the documented meaning's size drifted from the doc cell")
                    assertFontRole(row.name)
                case .nsFont:
                    let meaning = try XCTUnwrap(Self.nsFontMeanings[row.name])
                    XCTAssertEqual(meaning.pointSize, size)
                    assertNSFontRole(row.name)
                case .derived:
                    XCTFail("\(row.name): doc gives points but the map says derived")
                case nil:
                    XCTFail("\(row.name) has a Mac value in the doc but no live-token mapping here — "
                            + "add the token AND the mapping (brand.md § 4.7)")
                }
            case .style(let style, let mono):
                macValued.insert(row.name)
                let expected: [String: Font] = [
                    ".headline": .headline, ".title2": .title2, ".callout": .callout,
                    ".body": mono ? .system(.body, design: .monospaced) : .body,
                    ".caption": .caption, ".caption2": .caption2,
                ]
                guard let want = expected[style] else {
                    XCTFail("\(row.name): unknown style \(style) in the doc"); continue
                }
                switch Self.macRoles[row.name] {
                case .font(let live):
                    XCTAssertEqual(live, want, "\(row.name): live token != documented \(style)")
                default:
                    XCTFail("\(row.name): doc gives a style but the map does not carry a Font")
                }
            }
        }

        XCTAssertGreaterThanOrEqual(macValued.count, 40,
            "too few Mac-valued roles parsed — the tables have been restructured; fix the parser too")
        // Totality, both directions. (§ 4.6's divergence table repeats three § 4.3 roles with
        // consistent values — sets, not bags, is the right arithmetic.)
        XCTAssertEqual(macValued, Set(Self.macRoles.keys),
            "doc rows and live-token map disagree — missing: "
            + "\(Set(Self.macRoles.keys).subtracting(macValued).sorted()), "
            + "undocumented: \(macValued.subtracting(Self.macRoles.keys).sorted())")
        for name in dashed {
            XCTAssertNil(Self.macRoles[name],
                "\(name) is documented as having NO Mac surface (—) but has a live-token mapping")
        }
    }

    /// The `.font` expectations, asserted against the documented meaning — same spelling as the
    /// token file, per the construction-based-equality caution in the suite doc.
    private func assertFontRole(_ name: String) {
        guard case .font(let live)? = Self.macRoles[name],
              let meaning = Self.fontMeanings[name] else {
            XCTFail("\(name): missing font mapping"); return
        }
        XCTAssertEqual(live, meaning, "\(name): the live token no longer means what § 4.3 documents")
    }

    private func assertNSFontRole(_ name: String) {
        guard case .nsFont(let live)? = Self.macRoles[name],
              let meaning = Self.nsFontMeanings[name] else {
            XCTFail("\(name): missing NSFont mapping"); return
        }
        XCTAssertEqual(live, meaning, "\(name): the live token no longer means what § 4.3 documents")
    }

    /// Best-effort point size of a documented Font meaning — used only to cross-check the doc's
    /// numeric cell against the meaning table, so the two halves of this test cannot drift apart.
    private func fontPointSize(_ font: Font) -> CGFloat? {
        // The meanings table is built from fixed-size constructions only where the doc cell is
        // numeric; resolve via NSFont where possible.
        let probes: [(Font, CGFloat)] = [
            (.system(size: 8.5, weight: .bold), 8.5), (.system(size: 17, weight: .medium), 17),
            (.system(size: 34, weight: .light), 34),
            (.system(size: 22, weight: .semibold, design: .monospaced), 22),
            (.system(size: 36, weight: .regular), 36), (.system(size: 30, weight: .regular), 30),
            (.system(size: 20, weight: .semibold, design: .serif), 20),
            (.system(size: 38, weight: .regular, design: .serif), 38),
        ]
        for (probe, size) in probes where probe == font { return size }
        return nil
    }

    // MARK: - 2. The sweep

    private static let tokenFileSuffixes = ["App/Typography.swift", "App/Theme.swift"]

    private static let standaloneBanned = [
        "Font(", "NSFont(", "UIFont(", "NSFontManager",
        "Font.system", "Font.custom",
        "Font.largeTitle", "Font.title", "Font.headline", "Font.subheadline", "Font.body",
        "Font.callout", "Font.footnote", "Font.caption",
    ]

    private static let dottedBanned = [
        ".system(size:", ".system(.", ".systemFont(", ".monospacedSystemFont(",
        ".monospacedDigitSystemFont(", ".boldSystemFont(", ".italicSystemFont(",
        ".preferredFont(", ".custom(", ".fontDesign(", ".fontWeight(", ".fontWidth(",
        ".bold()", ".italic()", ".monospaced()", ".monospacedDigit()",
        ".smallCaps(", ".lowercaseSmallCaps(", ".uppercaseSmallCaps(", ".textScale(",
    ]

    private static let regionBannedCalls = [".system(", ".custom("]
    private static let regionBannedStyles = [
        ".largeTitle", ".title2", ".title3", ".title", ".headline", ".subheadline",
        ".body", ".callout", ".footnote", ".caption2", ".caption",
    ]

    private static let allowedQualifiers: Set<String> = ["Typography", "Theme"]

    private func isIdentifierChar(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_"
    }

    private func identifierBefore(_ chars: [Character], _ i: Int) -> String {
        var j = i - 1, out = ""
        while j >= 0, isIdentifierChar(chars[j]) {
            out.insert(chars[j], at: out.startIndex); j -= 1
        }
        return out
    }

    private func occurrences(of needle: String, in line: String) -> [Int] {
        var result: [Int] = []
        var search = line.startIndex
        while let r = line.range(of: needle, range: search..<line.endIndex) {
            result.append(line.distance(from: line.startIndex, to: r.lowerBound))
            search = r.upperBound
        }
        return result
    }

    private func sweepViolations(in source: String, file: String) -> [String] {
        var violations: [String] = []
        for (index, raw) in source.components(separatedBy: "\n").enumerated() {
            let trimmed = raw.drop(while: { $0 == " " || $0 == "\t" })
            if trimmed.hasPrefix("//") { continue }
            let line = raw
            let chars = Array(line)
            func report(_ rule: String) {
                violations.append("\(file):\(index + 1): \(rule) — \(line.trimmingCharacters(in: .whitespaces))")
            }
            for token in Self.standaloneBanned {
                for pos in occurrences(of: token, in: line) {
                    if pos > 0, isIdentifierChar(chars[pos - 1]) { continue }
                    report("construction `\(token)`")
                }
            }
            for token in Self.dottedBanned {
                for pos in occurrences(of: token, in: line) {
                    if Self.allowedQualifiers.contains(identifierBefore(chars, pos)) { continue }
                    report("construction `\(token)`")
                }
            }
            for pos in occurrences(of: ".font(", in: line) {
                let regionStart = pos + ".font(".count
                let region = String(chars[regionStart...])
                let regionChars = Array(region)
                if region.trimmingCharacters(in: .whitespaces).isEmpty {
                    report("`.font(` with its argument on the next line — keep it single-line")
                    continue
                }
                for token in Self.regionBannedCalls {
                    for rpos in occurrences(of: token, in: region) {
                        if Self.allowedQualifiers.contains(identifierBefore(regionChars, rpos)) { continue }
                        report("implicit `\(token)` inside `.font(...)`")
                    }
                }
                for token in Self.regionBannedStyles {
                    for rpos in occurrences(of: token, in: region) {
                        if !identifierBefore(regionChars, rpos).isEmpty { continue }
                        let after = rpos + token.count
                        if after < regionChars.count, isIdentifierChar(regionChars[after]) { continue }
                        report("bare text style `\(token)` inside `.font(...)`")
                    }
                }
            }
            // Numeric literals into the token API — sizes live in the token file.
            for qualifier in Self.allowedQualifiers {
                for pos in occurrences(of: qualifier + ".", in: line) {
                    if pos > 0, isIdentifierChar(chars[pos - 1]) { continue }
                    var j = pos + qualifier.count + 1
                    while j < chars.count, isIdentifierChar(chars[j]) { j += 1 }
                    guard j < chars.count, chars[j] == "(" else { continue }
                    j += 1
                    while j < chars.count, chars[j] == " " { j += 1 }
                    var k = j
                    while k < chars.count, isIdentifierChar(chars[k]) { k += 1 }
                    if k < chars.count, chars[k] == ":" {
                        j = k + 1
                        while j < chars.count, chars[j] == " " { j += 1 }
                    }
                    if j < chars.count, chars[j].isNumber {
                        report("numeric literal passed to \(qualifier) API")
                    }
                }
            }
            for token in ["Font = .init(", "NSFont = .init(", "UIFont = .init("] where line.contains(token) {
                report("implicit-member `.init` construction")
            }
        }
        return violations
    }

    /// Every app source, recursively. The floor pins that the walk is actually walking.
    func testNoFontIsConstructedOutsideTheTokenFiles() throws {
        var scanned = 0
        var all: [String] = []
        for url in try appSources() {
            let relative = url.path.replacingOccurrences(of: sourceRoot().path + "/", with: "")
            if Self.tokenFileSuffixes.contains(where: { relative.hasSuffix($0) }) { continue }
            scanned += 1
            all.append(contentsOf: sweepViolations(in: try String(contentsOf: url, encoding: .utf8),
                                                   file: relative))
        }
        XCTAssertGreaterThanOrEqual(scanned, 120,
            "the sweep is scanning suspiciously few files — is the walk still recursive?")
        for violation in all.prefix(25) {
            XCTFail("route this font through a named role (brand.md § 4.7): \(violation)")
        }
        if all.count > 25 { XCTFail("…and \(all.count - 25) more") }
    }

    /// The token files cannot quietly grow an unrecorded font: this count moves with every added
    /// construction. On failure: add the doc row and the live-token mapping FIRST (brand.md
    /// § 4.7), then bump the pin.
    func testTokenFileConstructionCountIsPinned() throws {
        var count = 0
        for url in try appSources() {
            let relative = url.path.replacingOccurrences(of: sourceRoot().path + "/", with: "")
            guard Self.tokenFileSuffixes.contains(where: { relative.hasSuffix($0) }) else { continue }
            let code = try String(contentsOf: url, encoding: .utf8)
                .components(separatedBy: "\n")
                .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
                .joined(separator: "\n")
            for token in ["Font(", ".system(", "systemFont(", "monospacedSystemFont("] {
                count += code.components(separatedBy: token).count - 1
            }
        }
        XCTAssertEqual(count, 22,
            "the token files' font-construction count moved — if you added a role, § 4.7's "
            + "checklist first (doc row + mapping in TypographyTests), then update this pin")
    }

    // MARK: - 4. The 2026-08-13 binding rulings

    /// Ruling 1: the composer TYPES at the user-message size, as a live derivation — and
    /// ruling 2: the orb field's message text derives from the transcript roles. Both pinned
    /// against the metrics they must follow, so "bound" stays structural: un-derive either
    /// side (a literal, the old chrome size, the retired 16) and this reds.
    func testComposerAndOrbMessageTextAreBoundToTheTranscript() throws {
        // The component's DEFAULT is the bound size — every home that does not explicitly
        // override types at the user-message size.
        XCTAssertEqual(ComposerTextView(text: .constant(""), onSubmit: {}).fontSize,
                       transcriptProseMetrics(.sans).bodySize,
                       "the composer's default must derive from the user-message metrics")
        XCTAssertEqual(Typography.composerFieldSize, transcriptProseMetrics(.sans).bodySize)
        XCTAssertEqual(Typography.composerField(), .system(size: transcriptProseMetrics(.sans).bodySize,
                                                           weight: .regular))
        // The orb's message roles derive from the transcript roles — and the reply takes the
        // transcript's FACE as well as its size (final 2026-08-13 ruling: "font style and
        // size"): Theme.assistantProse serif, same spelling as the token builds.
        XCTAssertEqual(Typography.fieldUserMessage(.medium),
                       .system(size: transcriptProseMetrics(.sans).bodySize, weight: .medium))
        XCTAssertEqual(Typography.fieldAssistantMessage(),
                       Font(Theme.assistantProse(size: transcriptProseMetrics(.assistant).bodySize,
                                                 weight: .regular)))
        // …and the face is REALLY the serif (the Font-equality above is a wiring pin; this is
        // the behavioural half — the same NSFont the token wraps resolves to the serif family).
        XCTAssertTrue(Theme.assistantProse(size: transcriptProseMetrics(.assistant).bodySize,
                                           weight: .regular).fontName.contains("NewYork"),
                      "the field reply's face must be the transcript's New York serif")
        // The inline-code re-coupling was a WIRING change with zero rendered delta — both
        // halves stated: derived AND still the 13.5 this surface always drew.
        XCTAssertEqual(Typography.fieldInlineCodeNS.pointSize,
                       transcriptProseMetrics(.sans).codeSize(for: transcriptProseMetrics(.sans).bodySize))
        XCTAssertEqual(Typography.fieldInlineCodeNS.pointSize, 13.5)

        // The hold-at-14 this test briefly pinned is RETIRED (final 2026-08-13 ruling: the
        // orb types at the bound size too, +1 pt resting consequence accepted). The pin's
        // replacement asserts the retirement: the orb passes NO fontSize override at all —
        // the component's bound default is what reaches the pill — and its placeholder
        // renders at the same bound role.
        let fieldSource = try String(
            contentsOf: sourceRoot().appendingPathComponent("FieldKit/NormaFieldView.swift"),
            encoding: .utf8)
        let fieldCode = fieldSource.components(separatedBy: "\n")
            .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertEqual(fieldCode.components(separatedBy: "fontSize:").count - 1, 0,
                       "the orb composer must take the BOUND default — an override reopens the "
                       + "hold the final 2026-08-13 ruling retired (brand.md § 4.6)")
        XCTAssertEqual(fieldCode.components(separatedBy: "Typography.composerField()").count - 1, 1,
                       "the orb placeholder must render at the bound composer role")
        // The clear-button threshold derives from the live face — the drift fence on its
        // formula, so the next ladder change moves it WITH the text it measures.
        XCTAssertEqual(ComposerTextView.twoLineContentHeight,
                       NSLayoutManager().defaultLineHeight(
                           for: Typography.sansNS(ofSize: Typography.composerFieldSize)) * 2
                           + ComposerTextView.textContainerInset.height * 2)
    }

    /// Rewritten for the final 2026-08-13 ruling, honestly rather than weakened: the PANEL
    /// half survives intact — the frame clamps and everything on the window-geometry side
    /// (MorphModel, WindowSurfaceGeometry, all of Orb/) never reference a type token or a
    /// font metric (source scan, comments stripped; `.xHeight`-style members are matched with
    /// their dot so `composerMaxHeight` cannot false-positive), and the clamps text lays out
    /// INSIDE are literals, value-pinned. The TYPING surface's content height, by contrast,
    /// is now DELIBERATELY type-derived — the ruling accepted the +1 pt resting-field
    /// consequence — and that is pinned as a positive assertion in
    /// `testComposerAndOrbMessageTextAreBoundToTheTranscript` (the bound default, the bound
    /// placeholder, and the threshold formula that moves with the ladder), not exempted here
    /// with no replacement.
    func testOrbGeometryIsIndependentOfTheTypeSystem() throws {
        let geometryFiles = try appSources().filter { url in
            url.path.contains("/Orb/")
                || url.path.hasSuffix("FieldKit/MorphModel.swift")
                || url.path.hasSuffix("FieldKit/WindowSurfaceGeometry.swift")
        }
        XCTAssertGreaterThanOrEqual(geometryFiles.count, 10,
                                    "the geometry-side scan lost its files")
        let banned = ["Typography.", "Theme.", "transcriptProseMetrics", "NSFont",
                      ".pointSize", ".xHeight", ".capHeight", "defaultLineHeight", "boundingRect"]
        for url in geometryFiles {
            let code = try String(contentsOf: url, encoding: .utf8)
                .components(separatedBy: "\n")
                .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
                .joined(separator: "\n")
            for token in banned where code.contains(token) {
                XCTFail("\(url.lastPathComponent) references the type system (`\(token)`) — "
                        + "orb geometry is ruled independent of text size (brand.md § 4.5)")
            }
        }
        // The clamps themselves — literals, by value.
        let morph = MorphModel()
        XCTAssertEqual(morph.composerWidth, 360)
        XCTAssertEqual(morph.composerMinHeight, 44)
        XCTAssertEqual(morph.composerMaxHeight, 240)
    }

    // MARK: - Source access

    private func sourceRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
    }

    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    private func appSources() throws -> [URL] {
        var files: [URL] = []
        let walker = FileManager.default.enumerator(at: sourceRoot(), includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            files.append(url)
        }
        XCTAssertFalse(files.isEmpty, "the source walk found nothing at all")
        return files.sorted { $0.path < $1.path }
    }
}
