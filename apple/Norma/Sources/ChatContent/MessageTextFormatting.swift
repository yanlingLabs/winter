import AppKit
import SwiftUI

struct FormattedMessageBlock: Identifiable {
    enum Kind {
        case text(String)
        case code(language: String?, code: String)
    }

    let id = UUID()
    let kind: Kind

    static func parse(_ text: String) -> [FormattedMessageBlock] {
        var blocks: [FormattedMessageBlock] = []
        var cursor = text.startIndex

        while let fenceStart = text[cursor...].range(of: "```") {
            appendText(String(text[cursor..<fenceStart.lowerBound]), to: &blocks)

            let infoStart = fenceStart.upperBound
            guard let firstLineEnd = text[infoStart...].firstIndex(of: "\n") else {
                appendText(String(text[fenceStart.lowerBound...]), to: &blocks)
                return blocks
            }

            let language = cleanLanguage(String(text[infoStart..<firstLineEnd]))
            let codeStart = text.index(after: firstLineEnd)
            guard let fenceEnd = text[codeStart...].range(of: "```") else {
                appendCode(String(text[codeStart...]), language: language, to: &blocks)
                return blocks
            }

            appendCode(String(text[codeStart..<fenceEnd.lowerBound]), language: language, to: &blocks)
            cursor = fenceEnd.upperBound
        }

        appendText(String(text[cursor...]), to: &blocks)
        return blocks.isEmpty ? [FormattedMessageBlock(kind: .text(text))] : blocks
    }

    private static func appendText(_ raw: String, to blocks: inout [FormattedMessageBlock]) {
        let cleaned = raw.trimmingCharacters(in: .newlines)
        guard !cleaned.isEmpty else { return }
        blocks.append(FormattedMessageBlock(kind: .text(cleaned)))
    }

    private static func appendCode(_ raw: String, language: String?, to blocks: inout [FormattedMessageBlock]) {
        var code = raw
        while code.hasSuffix("\n") || code.hasSuffix("\r") {
            code.removeLast()
        }
        guard !code.isEmpty else { return }
        blocks.append(FormattedMessageBlock(kind: .code(language: language, code: code)))
    }

    private static func cleanLanguage(_ raw: String) -> String? {
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned.lowercased()
    }
}

struct FormattedMarkdownBlock: Identifiable {
    enum Kind {
        case paragraph(String)
        case heading(level: Int, text: String)
        case bullet(String)
        case numbered(marker: String, text: String)
        case quote(String)
        case math(String)
    }

    let id = UUID()
    let kind: Kind

    static func parse(_ text: String) -> [FormattedMarkdownBlock] {
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [FormattedMarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0

        func flushParagraph() {
            let joined = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                blocks.append(FormattedMarkdownBlock(kind: .paragraph(joined)))
            }
            paragraph.removeAll()
        }

        while index < lines.count {
            let raw = lines[index]
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                flushParagraph()
                index += 1
                continue
            }

            if trimmed.hasPrefix("$$") {
                flushParagraph()
                var math = String(trimmed.dropFirst(2))
                if math.hasSuffix("$$"), math.count >= 2 {
                    math = String(math.dropLast(2))
                    blocks.append(FormattedMarkdownBlock(kind: .math(math.trimmingCharacters(in: .whitespacesAndNewlines))))
                    index += 1
                    continue
                }
                index += 1
                while index < lines.count {
                    let next = lines[index].trimmingCharacters(in: .whitespacesAndNewlines)
                    if next.hasSuffix("$$") {
                        let content = String(next.dropLast(2))
                        if !content.isEmpty {
                            math += "\n" + content
                        }
                        break
                    }
                    math += "\n" + lines[index]
                    index += 1
                }
                blocks.append(FormattedMarkdownBlock(kind: .math(math.trimmingCharacters(in: .whitespacesAndNewlines))))
                index += 1
                continue
            }

            if let heading = heading(in: trimmed) {
                flushParagraph()
                blocks.append(FormattedMarkdownBlock(kind: .heading(level: heading.level, text: heading.text)))
                index += 1
                continue
            }

            if let bullet = bullet(in: trimmed) {
                flushParagraph()
                blocks.append(FormattedMarkdownBlock(kind: .bullet(bullet)))
                index += 1
                continue
            }

            if let numbered = numbered(in: trimmed) {
                flushParagraph()
                blocks.append(FormattedMarkdownBlock(kind: .numbered(marker: numbered.marker, text: numbered.text)))
                index += 1
                continue
            }

            if let quote = quote(in: trimmed) {
                flushParagraph()
                blocks.append(FormattedMarkdownBlock(kind: .quote(quote)))
                index += 1
                continue
            }

            paragraph.append(raw)
            index += 1
        }

        flushParagraph()
        return blocks.isEmpty ? [FormattedMarkdownBlock(kind: .paragraph(text))] : blocks
    }

    private static func heading(in line: String) -> (level: Int, text: String)? {
        var level = 0
        var cursor = line.startIndex
        while cursor < line.endIndex, line[cursor] == "#", level < 6 {
            level += 1
            cursor = line.index(after: cursor)
        }
        guard level > 0, cursor < line.endIndex, line[cursor].isWhitespace else { return nil }
        let text = line[cursor...].trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : (level, text)
    }

    private static func bullet(in line: String) -> String? {
        guard line.count > 2 else { return nil }
        let marker = line[line.startIndex]
        guard marker == "-" || marker == "*" || marker == "+" else { return nil }
        let afterMarker = line.index(after: line.startIndex)
        guard line[afterMarker].isWhitespace else { return nil }
        let text = line[afterMarker...].trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private static func numbered(in line: String) -> (marker: String, text: String)? {
        var cursor = line.startIndex
        var sawDigit = false
        while cursor < line.endIndex, line[cursor].isNumber {
            sawDigit = true
            cursor = line.index(after: cursor)
        }
        guard sawDigit, cursor < line.endIndex, line[cursor] == "." || line[cursor] == ")" else { return nil }
        let marker = String(line[line.startIndex...cursor])
        cursor = line.index(after: cursor)
        guard cursor < line.endIndex, line[cursor].isWhitespace else { return nil }
        let text = line[cursor...].trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : (marker, text)
    }

    private static func quote(in line: String) -> String? {
        guard line.hasPrefix(">") else { return nil }
        let text = line.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

enum MessageTextFormatter {
    static func chatMarkdownBlocks(_ text: String) -> [FormattedMarkdownBlock] {
        FormattedMarkdownBlock.parse(text)
    }

    /// A named asset-catalog colour, resolved for an EXPLICIT appearance rather than the ambient
    /// one (mac-chat-parity Task 8).
    ///
    /// The explicit resolve is why `chatInlineAttributedString` still takes a `colorScheme` at all.
    /// A dynamic `NSColor` inside an `NSAttributedString` resolves against whatever appearance is
    /// current when it is DRAWN, and a SwiftUI view can be forced to a scheme its window is not in
    /// (`.preferredColorScheme`, `.environment(\.colorScheme, …)`) — so handing the string a dynamic
    /// colour would quietly make this one attribute ignore the caller's scheme while every other
    /// value in the same string honoured it. Resolving here keeps the whole string on one appearance:
    /// the caller's.
    ///
    /// `.clear` on a miss — a missing colorset means no chip background, which is a cosmetic loss;
    /// `SidebarBrandTests.testEveryThemeColorResolvesInTheAssetCatalog` is what actually stops a
    /// name from going missing.
    static func themeColor(_ name: String, colorScheme: ColorScheme) -> NSColor {
        guard let named = NSColor(named: name) else { return .clear }
        var resolved = named
        let appearance = NSAppearance(named: colorScheme == .dark ? .darkAqua : .aqua)
        appearance?.performAsCurrentDrawingAppearance {
            resolved = named.usingColorSpace(.sRGB) ?? named
        }
        return resolved
    }

    static func chatInlineAttributedString(
        _ text: String,
        colorScheme: ColorScheme,
        baseFont: NSFont = Typography.sansNS(ofSize: transcriptProseMetrics(.sans).bodySize),
        codeFont: NSFont = Typography.monoNS(ofSize: transcriptProseMetrics(.sans).codeSize(for: transcriptProseMetrics(.sans).bodySize)),
        lineSpacing: CGFloat = 0
    ) -> AttributedString {
        // mac-chat-parity Task 8: the inline-code chip's fill is the brand's `ControlSurface` — its
        // token for small controls, which is what a code chip inside a run of prose is. It replaced a
        // `colorScheme`-branched white/black alpha, i.e. a hex in code by another name
        // (`docs/brand.md` § 3.1). `ElevatedSurface` is deliberately NOT used here even though it is
        // the block-level code fill: measured against `CardSurface` it is 1.06:1, which as a
        // TEXT-RUN background would be invisible.
        let codeBackground = themeColor("ControlSurface", colorScheme: colorScheme)
        let attributed = inlineAttributedString(
            text,
            baseFont: baseFont,
            codeFont: codeFont,
            foregroundColor: .labelColor,
            codeForegroundColor: .labelColor,
            codeBackgroundColor: codeBackground,
            lineSpacing: lineSpacing
        )
        return AttributedString(attributed)
    }

    static func chatMathAttributedString(
        _ text: String,
        baseFont: NSFont? = nil
    ) -> AttributedString {
        let font = baseFont ?? Typography.mathDefaultNS(italic: true)
        return AttributedString(
            NSAttributedString(
                string: renderMathExpression(text),
                attributes: baseAttributes(
                    font: font,
                    foregroundColor: .labelColor,
                    lineSpacing: 2
                )
            )
        )
    }

    static func fieldAttributedString(
        _ text: String,
        baseFont: NSFont,
        foregroundColor: NSColor
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let separatorAttributes = baseAttributes(
            font: baseFont,
            foregroundColor: foregroundColor,
            lineSpacing: 3
        )

        for (index, block) in FormattedMessageBlock.parse(text).enumerated() {
            if index > 0 {
                result.append(NSAttributedString(string: "\n\n", attributes: separatorAttributes))
            }

            switch block.kind {
            case .text(let content):
                result.append(
                    inlineAttributedString(
                        fieldDisplayText(content),
                        baseFont: baseFont,
                        codeFont: Typography.fieldInlineCodeNS,
                        foregroundColor: foregroundColor,
                        codeForegroundColor: foregroundColor,
                        codeBackgroundColor: foregroundColor.withAlphaComponent(0.16),
                        lineSpacing: 3
                    )
                )
            case .code(let language, let code):
                appendFieldCodeBlock(
                    language: language,
                    code: code,
                    to: result,
                    foregroundColor: foregroundColor
                )
            }
        }

        return result
    }

    static func plainAttributedString(
        _ text: String,
        font: NSFont,
        foregroundColor: NSColor
    ) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: baseAttributes(
                font: font,
                foregroundColor: foregroundColor,
                lineSpacing: 0
            )
        )
    }

    private static func appendFieldCodeBlock(
        language: String?,
        code: String,
        to result: NSMutableAttributedString,
        foregroundColor: NSColor
    ) {
        if let language, !language.isEmpty {
            result.append(
                NSAttributedString(
                    string: "\(language)\n",
                    attributes: [
                        .font: Typography.fieldCodeLabelNS,
                        .foregroundColor: foregroundColor.withAlphaComponent(0.72)
                    ]
                )
            )
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = 1

        result.append(
            NSAttributedString(
                string: code,
                attributes: [
                    .font: Typography.fieldCodeBlockNS,
                    .foregroundColor: foregroundColor,
                    .backgroundColor: foregroundColor.withAlphaComponent(0.13),
                    .paragraphStyle: paragraph
                ]
            )
        )
    }

    private static func inlineAttributedString(
        _ text: String,
        baseFont: NSFont,
        codeFont: NSFont,
        foregroundColor: NSColor,
        codeForegroundColor: NSColor,
        codeBackgroundColor: NSColor?,
        lineSpacing: CGFloat = 0
    ) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let base = baseAttributes(
            font: baseFont,
            foregroundColor: foregroundColor,
            lineSpacing: lineSpacing
        )
        let code = codeAttributes(
            font: codeFont,
            foregroundColor: codeForegroundColor,
            backgroundColor: codeBackgroundColor,
            lineSpacing: lineSpacing
        )
        let math = codeAttributes(
            font: Typography.mathNS(ofSize: baseFont.pointSize + 0.5, italic: true),
            foregroundColor: foregroundColor,
            backgroundColor: nil,
            lineSpacing: lineSpacing
        )
        let bold = inlineAttributes(
            font: Typography.converted(baseFont, toHaveTrait: .boldFontMask),
            foregroundColor: foregroundColor,
            lineSpacing: lineSpacing
        )
        let italic = inlineAttributes(
            font: Typography.converted(baseFont, toHaveTrait: .italicFontMask),
            foregroundColor: foregroundColor,
            lineSpacing: lineSpacing
        )
        var strike = base
        strike[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        var link = base
        link[.foregroundColor] = NSColor.linkColor
        link[.underlineStyle] = NSUnderlineStyle.single.rawValue

        var cursor = text.startIndex
        var plainStart = cursor
        while cursor < text.endIndex {
            if let token = inlineToken(in: text, at: cursor) {
                result.append(NSAttributedString(string: String(text[plainStart..<cursor]), attributes: base))
                let attributes: [NSAttributedString.Key: Any]
                switch token.kind {
                case .code:
                    attributes = code
                case .math:
                    attributes = math
                case .bold:
                    attributes = bold
                case .italic:
                    attributes = italic
                case .strike:
                    attributes = strike
                case .link:
                    attributes = link
                }
                let content = token.kind == .math
                    ? renderMathExpression(token.content)
                    : token.content
                result.append(NSAttributedString(string: content, attributes: attributes))
                cursor = token.end
                plainStart = cursor
            } else {
                cursor = text.index(after: cursor)
            }
        }

        result.append(NSAttributedString(string: String(text[plainStart...]), attributes: base))
        return result
    }

    private enum InlineTokenKind {
        case code
        case math
        case bold
        case italic
        case strike
        case link
    }

    private struct InlineToken {
        let kind: InlineTokenKind
        let content: String
        let end: String.Index
    }

    private static func inlineToken(in text: String, at index: String.Index) -> InlineToken? {
        guard !isEscaped(index, in: text) else { return nil }

        if hasPrefix("\\(", in: text, at: index),
           let token = pairedToken(kind: .math, openingMarker: "\\(", closingMarker: "\\)", in: text, at: index) {
            return token
        }

        if hasPrefix("\\[", in: text, at: index),
           let token = pairedToken(kind: .math, openingMarker: "\\[", closingMarker: "\\]", in: text, at: index) {
            return token
        }

        if text[index] == "`" {
            let contentStart = text.index(after: index)
            guard let closing = nextUnescapedBacktick(in: text, from: contentStart),
                  contentStart < closing else {
                return nil
            }
            return InlineToken(kind: .code, content: String(text[contentStart..<closing]), end: text.index(after: closing))
        }

        if text[index] == "[" {
            guard let labelEnd = text[index...].firstIndex(of: "]") else { return nil }
            let parenStart = text.index(after: labelEnd)
            guard parenStart < text.endIndex, text[parenStart] == "(",
                  let parenEnd = text[parenStart...].firstIndex(of: ")") else {
                return nil
            }
            let labelStart = text.index(after: index)
            guard labelStart < labelEnd else { return nil }
            return InlineToken(kind: .link, content: String(text[labelStart..<labelEnd]), end: text.index(after: parenEnd))
        }

        if hasPrefix("**", in: text, at: index),
           let token = pairedToken(kind: .bold, marker: "**", in: text, at: index) {
            return token
        }

        if hasPrefix("__", in: text, at: index),
           let token = pairedToken(kind: .bold, marker: "__", in: text, at: index) {
            return token
        }

        if hasPrefix("~~", in: text, at: index),
           let token = pairedToken(kind: .strike, marker: "~~", in: text, at: index) {
            return token
        }

        if hasPrefix("$$", in: text, at: index),
           let token = pairedToken(kind: .math, marker: "$$", in: text, at: index) {
            return token
        }

        if text[index] == "$", !hasPrefix("$$", in: text, at: index),
           let token = pairedToken(kind: .math, marker: "$", in: text, at: index) {
            return token
        }

        if text[index] == "*", !hasPrefix("**", in: text, at: index),
           let token = pairedToken(kind: .italic, marker: "*", in: text, at: index) {
            return token
        }

        if text[index] == "_", !hasPrefix("__", in: text, at: index),
           let token = pairedToken(kind: .italic, marker: "_", in: text, at: index) {
            return token
        }

        return nil
    }

    private static func pairedToken(
        kind: InlineTokenKind,
        marker: String,
        in text: String,
        at index: String.Index
    ) -> InlineToken? {
        pairedToken(kind: kind, openingMarker: marker, closingMarker: marker, in: text, at: index)
    }

    private static func pairedToken(
        kind: InlineTokenKind,
        openingMarker: String,
        closingMarker: String,
        in text: String,
        at index: String.Index
    ) -> InlineToken? {
        let contentStart = text.index(index, offsetBy: openingMarker.count)
        guard let closing = nextUnescapedMarker(closingMarker, in: text, from: contentStart),
              contentStart < closing else {
            return nil
        }
        let end = text.index(closing, offsetBy: closingMarker.count)
        return InlineToken(kind: kind, content: String(text[contentStart..<closing]), end: end)
    }

    private static func baseAttributes(
        font: NSFont,
        foregroundColor: NSColor,
        lineSpacing: CGFloat
    ) -> [NSAttributedString.Key: Any] {
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: foregroundColor
        ]

        if lineSpacing > 0 {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            paragraph.lineSpacing = lineSpacing
            attributes[.paragraphStyle] = paragraph
        }

        return attributes
    }

    private static func codeAttributes(
        font: NSFont,
        foregroundColor: NSColor,
        backgroundColor: NSColor?,
        lineSpacing: CGFloat
    ) -> [NSAttributedString.Key: Any] {
        var attributes = baseAttributes(
            font: font,
            foregroundColor: foregroundColor,
            lineSpacing: lineSpacing
        )
        if let backgroundColor {
            attributes[.backgroundColor] = backgroundColor
        }
        return attributes
    }

    private static func inlineAttributes(
        font: NSFont,
        foregroundColor: NSColor,
        lineSpacing: CGFloat
    ) -> [NSAttributedString.Key: Any] {
        baseAttributes(font: font, foregroundColor: foregroundColor, lineSpacing: lineSpacing)
    }

    // `styledFont` and `mathFont` MOVED to `App/Typography.swift` (2026-08-13 typography pass)
    // as `Typography.converted(_:toHaveTrait:)` / `Typography.mathNS(ofSize:italic:)` — this
    // pipeline constructs no fonts of its own; every face flows in from the token file.

    private static func fieldDisplayText(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
            .map { line in
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if let heading = FormattedMarkdownBlock.parse(trimmed).first,
                   case .heading(_, let text) = heading.kind {
                    return text
                }
                if let bullet = strippedPrefix(in: trimmed, prefixes: ["- ", "* ", "+ "]) {
                    return bullet
                }
                if let numbered = strippedNumberedPrefix(in: trimmed) {
                    return numbered
                }
                if trimmed.hasPrefix(">") {
                    return trimmed.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines)
                }
                return line
            }
            .joined(separator: "\n")
    }

    private static func renderMathExpression(_ raw: String) -> String {
        var parser = MathExpressionParser(raw)
        return normalizeMathSpacing(parser.parse())
    }

    private struct MathExpressionParser {
        let text: String
        var cursor: String.Index

        init(_ raw: String) {
            let normalized = raw
                .replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\r", with: "\n")
            self.text = normalized
            self.cursor = normalized.startIndex
        }

        mutating func parse(until closing: Character? = nil) -> String {
            var output = ""
            while cursor < text.endIndex {
                let character = text[cursor]
                if let closing, character == closing {
                    cursor = text.index(after: cursor)
                    break
                }

                switch character {
                case "\\":
                    parseCommand(into: &output)
                case "{":
                    cursor = text.index(after: cursor)
                    output += parse(until: "}")
                case "^":
                    cursor = text.index(after: cursor)
                    output += MessageTextFormatter.superscript(parseScriptArgument())
                case "_":
                    cursor = text.index(after: cursor)
                    output += MessageTextFormatter.subscriptText(parseScriptArgument())
                default:
                    output.append(character)
                    cursor = text.index(after: cursor)
                }
            }
            return output
        }

        private mutating func parseCommand(into output: inout String) {
            cursor = text.index(after: cursor)
            guard cursor < text.endIndex else { return }

            let character = text[cursor]
            if character == "," || character == ";" || character == ":" || character == " " {
                output += " "
                cursor = text.index(after: cursor)
                return
            }
            if character == "!" {
                cursor = text.index(after: cursor)
                return
            }
            if character == "\\" {
                output += "\n"
                cursor = text.index(after: cursor)
                return
            }
            if character == "(" || character == ")" || character == "[" || character == "]" {
                cursor = text.index(after: cursor)
                return
            }
            if character == "{" || character == "}" || character == "|" {
                output.append(character)
                cursor = text.index(after: cursor)
                return
            }
            guard character.isLetter else {
                output.append(character)
                cursor = text.index(after: cursor)
                return
            }

            let commandStart = cursor
            while cursor < text.endIndex, text[cursor].isLetter {
                cursor = text.index(after: cursor)
            }
            let command = String(text[commandStart..<cursor])
            append(command: command, to: &output)
        }

        private mutating func append(command: String, to output: inout String) {
            switch command {
            case "frac", "dfrac", "tfrac":
                skipSpaces()
                let numerator = parseRequiredGroup()
                skipSpaces()
                let denominator = parseRequiredGroup()
                output += MessageTextFormatter.formattedFraction(numerator: numerator, denominator: denominator)
            case "sqrt":
                skipSpaces()
                if cursor < text.endIndex, text[cursor] == "[" {
                    cursor = text.index(after: cursor)
                    _ = parse(until: "]")
                }
                let body = parseRequiredGroup()
                output += "√" + MessageTextFormatter.wrappedRadicand(body)
            case "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr":
                return
            case "quad", "qquad", "space", "thinspace", "medspace", "thickspace", "enspace", "hspace":
                output += " "
            case "mathrm", "text", "operatorname":
                skipSpaces()
                output += parseRequiredGroup()
            case "sin", "cos", "tan", "ln", "log", "lim", "min", "max":
                MessageTextFormatter.appendFunction(command, to: &output)
            default:
                if let replacement = MessageTextFormatter.mathCommandReplacement(command) {
                    output += replacement
                } else {
                    output += command
                }
            }
        }

        private mutating func parseRequiredGroup() -> String {
            skipSpaces()
            guard cursor < text.endIndex else { return "" }
            if text[cursor] == "{" {
                cursor = text.index(after: cursor)
                return parse(until: "}")
            }
            return parseScriptArgument()
        }

        private mutating func parseScriptArgument() -> String {
            skipSpaces()
            guard cursor < text.endIndex else { return "" }
            if text[cursor] == "{" {
                cursor = text.index(after: cursor)
                return parse(until: "}")
            }
            if text[cursor] == "\\" {
                var output = ""
                parseCommand(into: &output)
                return output
            }
            let character = text[cursor]
            cursor = text.index(after: cursor)
            return String(character)
        }

        private mutating func skipSpaces() {
            while cursor < text.endIndex, text[cursor].isWhitespace {
                cursor = text.index(after: cursor)
            }
        }
    }

    private static func mathCommandReplacement(_ command: String) -> String? {
        [
            "int": "∫",
            "sum": "∑",
            "prod": "∏",
            "neq": "≠",
            "ne": "≠",
            "leq": "≤",
            "le": "≤",
            "geq": "≥",
            "ge": "≥",
            "times": "×",
            "cdot": "·",
            "pm": "±",
            "mp": "∓",
            "approx": "≈",
            "sim": "∼",
            "equiv": "≡",
            "infty": "∞",
            "to": "→",
            "rightarrow": "→",
            "leftarrow": "←",
            "Rightarrow": "⇒",
            "alpha": "α",
            "beta": "β",
            "gamma": "γ",
            "delta": "δ",
            "epsilon": "ε",
            "theta": "θ",
            "lambda": "λ",
            "mu": "μ",
            "pi": "π",
            "rho": "ρ",
            "sigma": "σ",
            "phi": "φ",
            "omega": "ω",
            "Delta": "Δ",
            "Theta": "Θ",
            "Lambda": "Λ",
            "Pi": "Π",
            "Sigma": "Σ",
            "Phi": "Φ",
            "Omega": "Ω"
        ][command]
    }

    private static func appendFunction(_ function: String, to output: inout String) {
        if let last = output.last,
           last.isLetter || last.isNumber || last == ")" || last == "|" {
            output += " "
        }
        output += function
    }

    private static func formattedFraction(numerator: String, denominator: String) -> String {
        let numerator = normalizeMathSpacing(numerator)
        let denominator = normalizeMathSpacing(denominator)
        return "\(wrappedFractionPart(numerator))/\(wrappedFractionPart(denominator))"
    }

    private static func wrappedFractionPart(_ text: String) -> String {
        guard text.rangeOfCharacter(from: CharacterSet(charactersIn: " +-=")) != nil else {
            return text
        }
        return "(\(text))"
    }

    private static func wrappedRadicand(_ text: String) -> String {
        let normalized = normalizeMathSpacing(text)
        guard normalized.count == 1 else { return "(\(normalized))" }
        return normalized
    }

    private static func superscript(_ text: String) -> String {
        scriptText(
            text,
            map: [
                "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
                "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
                "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
                "n": "ⁿ", "i": "ⁱ"
            ],
            fallbackPrefix: "^"
        )
    }

    private static func subscriptText(_ text: String) -> String {
        scriptText(
            text,
            map: [
                "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
                "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
                "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
                "a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
                "k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
                "p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
                "v": "ᵥ", "x": "ₓ"
            ],
            fallbackPrefix: "_"
        )
    }

    private static func scriptText(
        _ text: String,
        map: [Character: String],
        fallbackPrefix: String
    ) -> String {
        let normalized = normalizeMathSpacing(text)
        var output = ""
        for character in normalized {
            guard let replacement = map[character] else {
                return normalized.count == 1
                    ? "\(fallbackPrefix)\(normalized)"
                    : "\(fallbackPrefix){\(normalized)}"
            }
            output += replacement
        }
        return output
    }

    private static func normalizeMathSpacing(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\u{00A0}", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: " ,", with: ",")
            .replacingOccurrences(of: "( ", with: "(")
            .replacingOccurrences(of: " )", with: ")")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func strippedPrefix(in text: String, prefixes: [String]) -> String? {
        for prefix in prefixes where text.hasPrefix(prefix) {
            return String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func strippedNumberedPrefix(in text: String) -> String? {
        var cursor = text.startIndex
        var sawDigit = false
        while cursor < text.endIndex, text[cursor].isNumber {
            sawDigit = true
            cursor = text.index(after: cursor)
        }
        guard sawDigit, cursor < text.endIndex, text[cursor] == "." || text[cursor] == ")" else { return nil }
        cursor = text.index(after: cursor)
        guard cursor < text.endIndex, text[cursor].isWhitespace else { return nil }
        return text[cursor...].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func hasPrefix(_ prefix: String, in text: String, at index: String.Index) -> Bool {
        guard let end = text.index(index, offsetBy: prefix.count, limitedBy: text.endIndex) else { return false }
        return text[index..<end] == prefix
    }

    private static func nextUnescapedMarker(_ marker: String, in text: String, from start: String.Index) -> String.Index? {
        var cursor = start
        while cursor < text.endIndex {
            if hasPrefix(marker, in: text, at: cursor), !isEscaped(cursor, in: text) {
                return cursor
            }
            cursor = text.index(after: cursor)
        }
        return nil
    }

    private static func nextUnescapedBacktick(in text: String, from start: String.Index) -> String.Index? {
        var cursor = start
        while cursor < text.endIndex {
            guard text[cursor] == "`" else {
                cursor = text.index(after: cursor)
                continue
            }
            if !isEscaped(cursor, in: text) {
                return cursor
            }
            cursor = text.index(after: cursor)
        }
        return nil
    }

    private static func isEscaped(_ index: String.Index, in text: String) -> Bool {
        guard index > text.startIndex else { return false }

        var cursor = text.index(before: index)
        var slashCount = 0
        while true {
            guard text[cursor] == "\\" else { break }
            slashCount += 1
            guard cursor > text.startIndex else { break }
            cursor = text.index(before: cursor)
        }
        return slashCount % 2 == 1
    }
}

enum SyntaxHighlighter {
    static func highlighted(_ code: String, language: String?, colorScheme: ColorScheme) -> AttributedString {
        let attributed = NSMutableAttributedString(
            string: code,
            attributes: [
                .font: Typography.syntaxCodeNS,
                .foregroundColor: NSColor.labelColor
            ]
        )

        let normalized = normalizedLanguage(language)
        apply(pattern: keywordPattern(for: normalized), color: palette.keyword, to: attributed)
        apply(pattern: numberPattern, color: palette.number, to: attributed)
        apply(pattern: stringPattern(for: normalized), color: palette.string, to: attributed)
        apply(pattern: commentPattern(for: normalized), color: palette.comment, to: attributed)
        apply(pattern: tagPattern(for: normalized), color: palette.keyword, to: attributed)

        return AttributedString(attributed)
    }

    private static var palette: (keyword: NSColor, string: NSColor, number: NSColor, comment: NSColor) {
        (
            keyword: NSColor.systemBlue,
            string: NSColor.systemGreen,
            number: NSColor.systemPurple,
            comment: NSColor.secondaryLabelColor
        )
    }

    private static let numberPattern = #"(?<![\w.])\d+(?:\.\d+)?(?![\w.])"#

    private static func normalizedLanguage(_ language: String?) -> String {
        switch language?.lowercased() {
        case "js", "jsx": return "javascript"
        case "ts", "tsx": return "typescript"
        case "py": return "python"
        case "sh", "zsh", "bash": return "shell"
        case "htm": return "html"
        default: return language?.lowercased() ?? ""
        }
    }

    private static func keywordPattern(for language: String) -> String? {
        let words: [String]
        switch language {
        case "swift":
            words = ["actor", "as", "async", "await", "break", "case", "catch", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "false", "for", "func", "guard", "if", "import", "in", "init", "let", "nil", "private", "protocol", "public", "return", "self", "static", "struct", "switch", "throw", "throws", "true", "try", "var", "where", "while"]
        case "python":
            words = ["and", "as", "async", "await", "break", "class", "continue", "def", "elif", "else", "except", "False", "finally", "for", "from", "if", "import", "in", "is", "lambda", "None", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"]
        case "javascript", "typescript":
            words = ["async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else", "export", "extends", "false", "finally", "for", "from", "function", "if", "import", "in", "interface", "let", "new", "null", "return", "switch", "throw", "true", "try", "type", "undefined", "var", "while"]
        case "json":
            words = ["true", "false", "null"]
        case "html", "xml", "css":
            return nil
        default:
            words = ["false", "nil", "null", "true"]
        }
        return #"\b("# + words.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|") + #")\b"#
    }

    private static func stringPattern(for language: String) -> String? {
        switch language {
        case "python":
            return #"(?s)("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')"#
        default:
            return #""(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#
        }
    }

    private static func commentPattern(for language: String) -> String? {
        switch language {
        case "python", "shell":
            return #"(?m)#.*$"#
        case "html", "xml":
            return #"(?s)<!--[\s\S]*?-->"#
        case "json":
            return nil
        default:
            return #"(?m)//.*$|(?s)/\*[\s\S]*?\*/"#
        }
    }

    private static func tagPattern(for language: String) -> String? {
        switch language {
        case "html", "xml":
            return #"</?[A-Za-z][^>]*?>"#
        default:
            return nil
        }
    }

    private static func apply(pattern: String?, color: NSColor, to attributed: NSMutableAttributedString) {
        guard let pattern else { return }
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
        let fullRange = NSRange(location: 0, length: attributed.string.utf16.count)
        regex.enumerateMatches(in: attributed.string, range: fullRange) { match, _, _ in
            guard let match else { return }
            attributed.addAttribute(.foregroundColor, value: color, range: match.range)
        }
    }
}
