import Foundation

/// office-format review F-2/F-3 — RTF scoping, kept as PURE STRING LOGIC in the shared wire module
/// rather than inside `LOKBridge`.
///
/// Two reasons, and the second is load-bearing. It has no LibreOffice dependency — string in, string
/// out. And `LOKBridge.swift` is deliberately excluded from the app target (it links LOK; only a
/// spawned process ever runs it), so anything living there can be exercised **only** through a real
/// engine. That is exactly how the defect this file fixes survived five live arms and a forced red:
/// the document shapes that expose it are awkward to produce live and trivial to pin as bytes. Here,
/// `OfficeRtfScopeTests` asserts against real captured `getTextSelection` output in milliseconds,
/// with no engine in the loop.
public enum OfficeRtfScope {

    /// **Strips RTF DESTINATION GROUPS, so a containment check sees the SELECTION and not the
    /// document.** This is the whole fix for the review's two Criticals, and the bug it closes is
    /// worth stating plainly because five live arms passed while it was there.
    ///
    /// `getTextSelection("text/rtf")` does not return a fragment. It returns a **complete RTF
    /// document**: header, font table, colour table, and a `{\stylesheet …}` group describing the
    /// WHOLE DOCUMENT'S style table — and only then the selected body. Scanning the whole string for
    /// `\b` or `\i` therefore finds control words that never came from the selection:
    ///
    ///  - **Every Writer document** carries the stock `caption` paragraph style, emitted as
    ///    `{\s16…\ai\ltrch\fs24\i caption;}`. So an unscoped check answered `italic = true` on a
    ///    document with no italic anywhere — measured on this branch's own pristine fixture. The
    ///    check was a constant function of the requested value.
    ///  - **Any document with a bold NAMED PARAGRAPH STYLE** emits `\b` in the stylesheet
    ///    (`\b BoldHead;`), so selecting a plain word elsewhere still answered `bold = true` —
    ///    including on a document this very verb had just produced via `style:"heading1"`.
    ///
    /// **Why the original arms could not see it.** Both LT-4 fixtures carried bold on an *automatic
    /// character style*, which RTF inlines per-run **inside the body** — the one carrier where the
    /// leak structurally cannot appear. Sound proof, run on the single document shape incapable of
    /// exposing the defect.
    ///
    /// Validated before being written, against six real engine dumps (`spikes/office-format-probe`,
    /// `OFP_RTF_OUT`): the leak goes to zero on the pristine, bold-named-style and underline dumps,
    /// and every TRUE positive survives — genuine bold, italic and underline are all still found. A
    /// fix that only killed false positives would have traded them for false negatives, which is why
    /// the true-positive arms are part of the validation rather than an afterthought.
    ///
    /// `\*` covers every ignorable destination (`\listtable`, `\generator`, `\pgdsctbl`, …) in one
    /// rule. Brace matching honours RTF's own escapes, so a literal `\{` or `\}` in the text can
    /// never unbalance the scan.
    public static func officeRtfBody(_ rtf: String) -> String {
        let chars = Array(rtf)
        var out = String()
        out.reserveCapacity(chars.count)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "\\" {
                // An escape (`\{`, `\}`, `\\`, `\'xx`) or a control word — copied verbatim, and
                // never allowed to affect nesting.
                if i + 1 < chars.count, !chars[i + 1].isLetter {
                    out.append(chars[i]); out.append(chars[i + 1]); i += 2; continue
                }
                let end = controlWordEnd(chars, i)
                out.append(contentsOf: chars[i..<end]); i = end; continue
            }
            if c == "{" {
                var j = i + 1
                // **`isWhitespace`, not a hand-listed set — and the difference is a real bug this
                // file shipped for one commit.** The hand-listed version read
                // `== " " || == "\n" || == "\r" || == "\t"` and still failed on CRLF, because in
                // Swift `"\r\n"` is a SINGLE Character (one grapheme cluster) that equals neither
                // `"\r"` nor `"\n"`. A stylesheet group preceded by a Windows line ending was
                // therefore not stripped, and the leak came back. Caught by the very pin added to
                // cover the TAB case; `isWhitespace` handles every cluster correctly.
                //
                // LibreOffice emits these groups tightly, so none of this has been observed from
                // the engine — but "today's producer happens to be tidy" is a property of the
                // producer, not of the RTF format.
                while j < chars.count, chars[j].isWhitespace { j += 1 }
                if j < chars.count, chars[j] == "\\" {
                    let word = controlWord(chars, j)
                    if word == "*" || destinations.contains(word) {
                        i = skipGroup(chars, i)      // drop the whole group
                        continue
                    }
                }
                out.append(c); i += 1; continue
            }
            out.append(c); i += 1
        }
        return out
    }

    /// Is `word` present as a REAL control word — and, if it takes a numeric parameter, is that
    /// parameter non-zero?
    ///
    /// **Deliberately not `rtf.contains("\\b")`, and the difference is the whole value of the
    /// check.** RTF control-word syntax is a backslash, ASCII letters, then an optional signed
    /// integer, terminated by any non-alphanumeric — so a bare substring test for `\b` also matches
    /// `\bin`, `\brdrs`, `\bullet` and `\blue`, and would report BOLD on a document containing none.
    /// The rule enforced here is: the character after `word` must not be a letter.
    ///
    /// A trailing `0` is the OFF form (`\b0`, `\i0`), so it does not count as present. `\ulnone` —
    /// underline's own off switch — is excluded for free by the not-a-letter rule, since `n` is a
    /// letter; that property is load-bearing, not incidental, and must survive any edit here.
    public static func officeRtfHasControlWord(_ rtf: String, _ word: String) -> Bool {
        let needle = "\\" + word
        var searchStart = rtf.startIndex
        while let found = rtf.range(of: needle, range: searchStart..<rtf.endIndex) {
            searchStart = found.upperBound
            guard found.upperBound < rtf.endIndex else { return true } // ends the payload: a bare word
            let next = rtf[found.upperBound]
            if next.isLetter { continue }        // \bin, \brdrs, \ulnone — a DIFFERENT control word
            if next == "0" {
                // The OFF form — but only when the parameter really is zero, so `\b0` is off while
                // `\b01` (a leading-zero 1) is not mistaken for it.
                let afterZero = rtf.index(after: found.upperBound)
                if afterZero >= rtf.endIndex || !rtf[afterZero].isNumber { continue }
            }
            return true
        }
        return false
    }

    /// Destinations whose CONTENT describes the document rather than the selection.
    private static let destinations: Set<String> = [
        "stylesheet", "fonttbl", "colortbl", "info", "listtable", "listoverridetable",
        "pgdsctbl", "revtbl", "generator", "latentstyles", "listtext", "pntext",
        "xmlnstbl", "themedata", "datastore", "rsidtbl", "protusertbl", "userprops", "filetbl",
    ]

    /// The control word starting at `chars[i] == "\"`. `"*"` for the ignorable-destination marker.
    private static func controlWord(_ chars: [Character], _ i: Int) -> String {
        let start = i + 1
        if start < chars.count, chars[start] == "*" { return "*" }
        var k = start
        while k < chars.count, chars[k].isLetter { k += 1 }
        return String(chars[start..<k])
    }

    private static func controlWordEnd(_ chars: [Character], _ i: Int) -> Int {
        var j = i + 1
        if j < chars.count, chars[j] == "*" { return j + 1 }
        while j < chars.count, chars[j].isLetter { j += 1 }
        return j
    }

    /// `chars[i] == "{"`. Returns the index just past the matching `}`.
    private static func skipGroup(_ chars: [Character], _ i: Int) -> Int {
        var depth = 0
        var k = i
        while k < chars.count {
            let c = chars[k]
            if c == "\\" {
                k = (k + 1 < chars.count && !chars[k + 1].isLetter) ? k + 2 : controlWordEnd(chars, k)
                continue
            }
            if c == "{" { depth += 1 }
            else if c == "}" {
                depth -= 1
                if depth == 0 { return k + 1 }
            }
            k += 1
        }
        return chars.count
    }
}
