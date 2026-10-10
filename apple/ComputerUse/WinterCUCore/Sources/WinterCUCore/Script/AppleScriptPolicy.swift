import Foundation

/// What Winter's AppleScript may do, as pure checks (the runner applies them; tests drive them directly).
///
/// Three layers, because one is not enough:
/// 1. the SOURCE, before it is compiled: the in-process bridges (AppleScriptObjC's `use framework`, script
///    libraries, `current application`'s classes) run Cocoa inside the helper without sending a single Apple
///    Event, so no event check can see them; and naming an app makes AppleScript LAUNCH it to address it,
///    before any event is sent — so only the bound app may be named, literally;
/// 2. the same source check on the compiled script's own (decompiled) text, which undoes continuation and
///    spelling tricks;
/// 3. every Apple Event the script sends (`verdict`): Standard Additions' doors refused wherever they are
///    addressed (`tell application "Finder" to do shell script` runs the shell in FINDER's process), a short
///    allowlist for the script's own process, and the bound app — nothing else.
public enum CUAppleScriptPolicy {
    /// The bound app as a script may name it.
    public struct BoundApp: Sendable, Equatable {
        public var name: String
        public var bundleId: String?
        public var path: String?
        public init(name: String, bundleId: String?, path: String?) {
            self.name = name
            self.bundleId = bundleId
            self.path = path
        }
    }

    // MARK: 1–2. the source

    /// Refuses a source that reaches past the Apple Event check, or names an app other than the bound one.
    public static func checkSource(_ source: String, bound: BoundApp) throws {
        let (code, strings) = lex(source)
        let text = normalize(code)
        let bridges: [(String, String)] = [
            ("use framework", "AppleScriptObjC (`use framework`) runs Cocoa inside Winter's helper, past every check"),
            ("use script", "script libraries (`use script`) load code from outside the script"),
            ("current application", "`current application` is Winter's helper itself, not the bound app"),
            ("«class oc", "Objective-C objects (`«class ocid»`) are not scriptable here"),
            ("<<class oc", "Objective-C objects (`<<class ocid>>`) are not scriptable here"),
            ("«class capp»", "address the app as `application \"\(bound.name)\"`"),
            ("<<class capp>>", "address the app as `application \"\(bound.name)\"`"),
        ]
        for (phrase, why) in bridges where text.contains(phrase) {
            throw CUError.notAllowed("applescript", "the script was not run: \(why)")
        }
        // A `javascript:` URL runs JavaScript in a page in ANY browser it is handed to (Safari's `URL of tab`, a
        // Chromium `URL` …): refused as a literal, the way a browser reads a scheme — case aside, whitespace and control
        // characters ignored.
        for literal in strings where isJavaScriptURL(literal) {
            throw CUError.notAllowed("applescript", "the script was not run: it holds a javascript: URL, which would run JavaScript in a page — read the page with state() or find()")
        }
        // Every application specifier must be a literal naming the bound app: naming another launches it.
        let pattern = #"\b(?:application|app)\b\s*(id\s+)?(\S+)"#
        let regex = try! NSRegularExpression(pattern: pattern)
        let ns = text as NSString
        for m in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let byId = m.range(at: 1).location != NSNotFound
            let next = ns.substring(with: m.range(at: 2))
            if next.hasPrefix("file") { continue }  // Finder's `application file` class
            if next.hasPrefix("process") {
                throw CUError.notAllowed("applescript", "the script was not run: application processes belong to System Events, which Winter's AppleScript doesn't drive — only \(bound.name)")
            }
            guard let literal = literalIndex(next), literal < strings.count else {
                throw CUError.notAllowed("applescript", "the script was not run: name the app with a literal — application \"\(bound.name)\" — so Winter can tell it is the bound app")
            }
            let named = strings[literal]
            guard names(named, byId: byId, bound) else {
                throw CUError.notAllowed("applescript", "the script was not run: it names \(byId ? "the app id " : "")“\(named)”, but only the bound app, \(bound.name), may be scripted (naming an app launches it)")
            }
        }
    }

    /// Does this string literal begin with the `javascript:` scheme, read as a browser reads it (case-insensitive, every
    /// whitespace and control character dropped)?
    static func isJavaScriptURL(_ literal: String) -> Bool {
        let kept = literal.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.controlCharacters.contains($0) }
        return String(String.UnicodeScalarView(kept)).lowercased().hasPrefix("javascript:")
    }

    /// Whether a literal names the bound app: its bundle id (for `application id`), else its name (with or
    /// without ".app"), bundle id or path.
    static func names(_ literal: String, byId: Bool, _ bound: BoundApp) -> Bool {
        let l = literal.lowercased()
        if let id = bound.bundleId?.lowercased(), l == id { return true }
        if byId { return false }
        let name = bound.name.lowercased()
        if l == name || l == name + ".app" { return true }
        if let path = bound.path?.lowercased(), l == path || l == path + "/" { return true }
        return false
    }

    /// The source with string literals replaced by `\0<n>\0` markers (their contents returned in order) and
    /// comments removed (`-- …`, `# …`, nested `(* … *)`), so a phrase inside a string or a comment counts for
    /// nothing and a literal is read exactly.
    static func lex(_ source: String) -> (code: String, strings: [String]) {
        var code = ""
        var strings: [String] = []
        let chars = Array(source)
        var i = 0
        func at(_ k: Int) -> Character? { k < chars.count ? chars[k] : nil }
        while i < chars.count {
            let c = chars[i]
            if c == "\"" {
                var s = ""
                i += 1
                while i < chars.count, chars[i] != "\"" {
                    if chars[i] == "\\", let n = at(i + 1) { s.append(n); i += 2; continue }
                    s.append(chars[i]); i += 1
                }
                i += 1
                code += "\u{0}\(strings.count)\u{0}"
                strings.append(s)
            } else if c == "(", at(i + 1) == "*" {
                var depth = 1
                i += 2
                while i < chars.count, depth > 0 {
                    if chars[i] == "(", at(i + 1) == "*" { depth += 1; i += 2 } else if chars[i] == "*", at(i + 1) == ")" { depth -= 1; i += 2 } else { i += 1 }
                }
                code += " "
            } else if (c == "-" && at(i + 1) == "-") || c == "#" {
                while i < chars.count, !chars[i].isNewline { i += 1 }
            } else {
                code.append(c)
                i += 1
            }
        }
        return (code, strings)
    }

    /// Continuations joined, whitespace collapsed, lowercased.
    static func normalize(_ code: String) -> String {
        var s = code.replacingOccurrences(of: "¬\r\n", with: " ").replacingOccurrences(of: "¬\n", with: " ")
            .replacingOccurrences(of: "¬\r", with: " ")
        s = s.lowercased()
        return s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// `\0<n>\0` → n.
    static func literalIndex(_ token: String) -> Int? {
        guard token.first == "\u{0}" else { return nil }
        let digits = token.dropFirst().prefix { $0.isNumber }
        return Int(digits)
    }

    // MARK: 3. each Apple Event

    public enum Verdict: Equatable, Sendable {
        case allow
        case refuse(String)
    }

    /// Standard Additions run in the process an event is addressed to, so these are refused wherever they go.
    static let refusedAnywhere: [String: String] = [
        "syso/exec": "`do shell script` runs a shell",
        "syso/dsct": "`run script` runs code the check never saw",
        "syso/load": "`load script` loads code from outside the script",
        "syso/stor": "`store script` writes scripts to disk",
        "syso/dlog": "`display dialog` puts a dialog in front of the user",
        "syso/disA": "`display alert` puts an alert in front of the user",
        "syso/notf": "`display notification` speaks for the user's apps",
        "syso/ttos": "`say` speaks out loud",
        "syso/beep": "`beep` sounds on the user's Mac",
        "syso/stdf": "`choose file` puts a dialog in front of the user",
        "syso/nfo4": "`info for` reads files outside the bound app",
        "fndr/gstl": "`system attribute` reads the helper's environment",
        "GURL/GURL": "`open location` opens a link in whichever app handles it, in front of the user",
        "ears/lfdr": "`list folder` reads the file system outside the bound app",
        "misc/actv": "`activate` would bring the app in front of the user's work — scripts run in the background",
        "aevt/rapp": "`reopen` would bring the app in front of the user's work",
        "aevt/oapp": "`run` would bring the app in front of the user's work",
        "sfri/dojs": "Safari's `do JavaScript` isn't allowed — read the page with state() or find()",
        // The Chromium family's `execute … javascript` (Chrome's sdef, `CrSuExJa`; Chromium's own dictionary, which
        // Edge, Brave, Vivaldi and Opera ship too). Any other app's JavaScript door is refused per run, by its
        // dictionary (`CUScriptingDictionary.javaScriptDoorRefusals`).
        "CrSu/ExJa": "the browser's `execute … javascript` isn't allowed — read the page with state() or find()",
        "ascr/psbr": "the Objective-C bridge runs Cocoa inside Winter's helper",
    ]
    /// Whole classes refused wherever they go: the rest of Standard Additions, file reads and writes, the
    /// clipboard, and System Events' processes (UI scripting and keystrokes anywhere).
    static let refusedClasses: [String: String] = [
        "syso": "a Standard Additions command",
        "rdwr": "file reading and writing (`read`, `write`, `open for access`)",
        "Jons": "the clipboard",
        "prcs": "System Events' UI scripting and keystrokes",
    ]
    /// Events the script may send to its own process: the language's harmless helpers.
    static let ownProcessAllowed: Set<String> = [
        "misc/curd",  // current date
        "syso/rond", "syso/rand", "syso/offs", "syso/ntoc", "syso/GMT ", "syso/locS",  // round, random number, offset, ASCII character, time to GMT, localized string
        "ascr/cmnt",  // log
        "ears/ffdr",  // path to
    ]

    /// Is this event (`"clas/id"`) refused wherever it is sent — one door, or its whole class?
    public static func refusesEverywhere(_ key: String) -> Bool {
        refusedAnywhere[key] != nil || refusedClasses[String(key.prefix(4))] != nil
    }

    /// One event's verdict. `targetPid`: the process it is addressed to (nil when that can't be told). `alsoRefused`:
    /// this run's own refusals (the bound app's JavaScript doors, read from its dictionary).
    public static func verdict(eventClass: String, eventID: String, targetPid: pid_t?, ownPid: pid_t, boundPid: pid_t,
                               boundName: String, alsoRefused: [String: String] = [:]) -> Verdict {
        let key = "\(eventClass)/\(eventID)"
        guard let targetPid else { return .refuse("an Apple Event (\(key)) whose target app can't be told") }
        let own = targetPid == ownPid
        if let why = refusedAnywhere[key] ?? alsoRefused[key] { return .refuse("\(why) (\(key))") }
        if own, ownProcessAllowed.contains(key) { return .allow }
        if let what = refusedClasses[eventClass] { return .refuse("\(what) isn't run from Winter's AppleScript (\(key))") }
        if own { return .refuse("an Apple Event to Winter's helper itself (\(key)) — only the language's own helpers run there") }
        guard targetPid == boundPid else {
            return .refuse("an Apple Event for another app (\(key)) — only the bound app, \(boundName), may be scripted")
        }
        return .allow
    }
}
