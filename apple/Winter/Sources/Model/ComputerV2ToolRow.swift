import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 tool rows — the pure half. The tool's host name is `computer_v2` (the plain `ComputerV2`
// is accepted too, like `Browser`/`browser`); its one argument shape is `{code, timeoutMs?, reset?,
// title?}`. `code` is the model's script, so everything here treats it as untrusted text: it is only
// ever scanned, never run, and the scan reads a bounded prefix.
//
// What a row says, in order (R10 — `title` is optional because it slows the model):
//   1. the call's `title`, when it sent one;
//   2. else a label derived from the script — the apps it opens (`apps.open("Notes")`) and the verbs it
//      uses on them, "Notes · click, paste, state";
//   3. else "Using the computer".
// The label rides the ordinary tool `detail` (`SessionReducer.extractToolDetail`); the script rides
// `ActivityItem.scriptCode` so the expanded row can show it in monospace beside the text result.
// -----------------------------------------------------------------------------------------------

/// The names a ComputerV2 call arrives under: the host name the projector strips its server name to,
/// and the plain name the model calls it by.
let computerV2ToolNames: Set<String> = ["computer_v2", "ComputerV2"]

func isComputerV2Tool(_ name: String) -> Bool { computerV2ToolNames.contains(name) }

/// What a row says when the call has no title and its script names nothing recognisable.
let computerV2FallbackLabel = "Using the computer"

/// The longest `title` the tool's schema allows. A longer one (the label is read off the raw arguments,
/// before the daemon validates them) is cut to it.
let computerV2TitleMaxCharacters = 80

/// How much of the script the label derivation reads. A script is model-authored and unbounded; the
/// first screenful names its apps and verbs.
let computerV2LabelScanCharacters = 16_000

/// How much of a script an expanded row keeps. The reducer holds one of these per tool call for the
/// life of the transcript (up to 200 per exchange), so it is capped where it is stored — the same
/// reason `SessionReducer.maxToolOutputCharacters` is.
let computerV2CodeMaxCharacters = 8_000

/// The most apps and verbs a derived label names (the rest are counted or elided), how long one app name
/// may be in it, and how long the whole label may be.
private let computerV2LabelMaxApps = 2
private let computerV2LabelMaxVerbs = 4
private let computerV2LabelMaxAppNameCharacters = 40
private let computerV2LabelMaxCharacters = 100

// MARK: - The label

/// PURE: the row label for one call — `title` if it has one, else what the script reveals, else
/// `computerV2FallbackLabel`. Never empty, never more than one line.
func computerV2Label(title: String?, code: String?) -> String {
    computerV2SpecificLabel(title: title, code: code) ?? computerV2FallbackLabel
}

/// PURE: the title or the derived label — everything `computerV2Label` can say EXCEPT the fallback. This
/// is what the reducer stores as the call's `detail`, so a call with nothing to say has no detail and the
/// row picks the fallback's tense itself (`computerV2CallLabel`).
func computerV2SpecificLabel(title: String?, code: String?) -> String? {
    if let title = computerV2CleanTitle(title) { return title }
    if let code { return computerV2DerivedLabel(code: code) }
    return nil
}

/// PURE: the label to draw for a row's `detail` — which is already the call's label (or nil when the
/// arguments did not parse), with the fallback standing in for a missing one. `running` picks the tense
/// of the fallback only; a real label is the same running or done.
func computerV2CallLabel(detail: String?, running: Bool) -> String {
    if let detail, !detail.isEmpty { return detail }
    return running ? computerV2FallbackLabel : "Used the computer"
}

/// PURE: a `title` as one clean line (whitespace runs collapsed, cut to the schema's maximum), or nil
/// when nothing is left of it.
func computerV2CleanTitle(_ title: String?) -> String? {
    guard let title else { return nil }
    let collapsed = title.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard !collapsed.isEmpty else { return nil }
    return String(collapsed.prefix(computerV2TitleMaxCharacters))
}

/// PURE: "Notes · click, paste, state" from a script, or nil when it names no app and uses no verb.
///
/// - **Apps** are the first argument of each `apps.open(…)` string literal, in first-seen order (a name,
///   a bundle id or an `.app` path, shown as the app's name), plus "Screen" for the whole-screen
///   members. At most two are named; the rest are counted ("Notes, Mail +1").
/// - **Verbs** are the target API's members the script calls (`click`, `paste`, `state`, …), deduped in
///   first-seen order, at most four. `apps.open` itself is not a verb: it is the app part.
/// - A script that uses verbs on an app bound by an EARLIER call (the runtime persists variables) names
///   no app, and reads "Using the computer · click, state" rather than a bare verb list.
func computerV2DerivedLabel(code: String) -> String? {
    let scanned = code.count > computerV2LabelScanCharacters ? String(code.prefix(computerV2LabelScanCharacters)) : code
    let apps = computerV2AppNames(in: scanned)
    let verbs = computerV2Verbs(in: scanned)
    guard !apps.isEmpty || !verbs.isEmpty else { return nil }

    var appText: String?
    if !apps.isEmpty {
        let shown = apps.prefix(computerV2LabelMaxApps).joined(separator: ", ")
        appText = apps.count > computerV2LabelMaxApps ? "\(shown) +\(apps.count - computerV2LabelMaxApps)" : shown
    }
    var verbText: String?
    if !verbs.isEmpty {
        let shown = verbs.prefix(computerV2LabelMaxVerbs).joined(separator: ", ")
        verbText = verbs.count > computerV2LabelMaxVerbs ? shown + ", …" : shown
    }
    let label: String
    switch (appText, verbText) {
    case let (apps?, verbs?): label = "\(apps) · \(verbs)"
    case let (apps?, nil): label = apps
    case let (nil, verbs?): label = "\(computerV2FallbackLabel) · \(verbs)"
    case (nil, nil): return nil
    }
    return label.count > computerV2LabelMaxCharacters ? String(label.prefix(computerV2LabelMaxCharacters - 1)) + "…" : label
}

/// `apps.open("Notes")`, `apps.open('com.apple.Notes')`, ``apps.open(`Notes`)``. Every alternative is a
/// bounded, non-nested character class, so a hostile script cannot make the match backtrack.
private let appsOpenPattern = try! NSRegularExpression(
    pattern: #"\bapps\s*\.\s*open\s*\(\s*(?:"([^"\\\n]{1,120})"|'([^'\\\n]{1,120})'|`([^`\\\n$]{1,120})`)"#)

/// `screen.screenshot(` / `screen.windows(` / `screen.appAt(` — the look-only whole-screen members.
private let screenMemberPattern = try! NSRegularExpression(pattern: #"\bscreen\s*\.\s*(?:screenshot|windows|appAt)\s*\("#)

/// A call of one of the target API's members. `waitForIdle` precedes `waitFor` so the longer name wins.
private let verbPattern = try! NSRegularExpression(
    pattern: #"\.\s*(state|find|screenshot|click|setValue|type|paste|key|scroll|drag|select|action|waitForIdle|waitFor|menu|windows|useWindow)\s*\("#)

/// PURE: the apps a script opens, in the order it opens them, as names a person would say.
func computerV2AppNames(in code: String) -> [String] {
    let whole = NSRange(code.startIndex..., in: code)
    var found: [(offset: Int, name: String)] = []
    for match in appsOpenPattern.matches(in: code, range: whole) {
        for group in 1...3 {
            let range = match.range(at: group)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: code) else { continue }
            if let name = computerV2AppDisplayName(String(code[swiftRange])) {
                found.append((match.range.location, name))
            }
        }
    }
    if let screen = screenMemberPattern.firstMatch(in: code, range: whole) {
        found.append((screen.range.location, "Screen"))
    }
    var seen: Set<String> = []
    return found.sorted { $0.offset < $1.offset }.map(\.name).filter { seen.insert($0.lowercased()).inserted }
}

/// PURE: an `apps.open` argument as an app's name — "com.apple.Notes" → "Notes", "/Applications/Notes.app"
/// → "Notes", a plain name as it is. Nil for an empty or interpolated one.
func computerV2AppDisplayName(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.contains("${") else { return nil }
    func shortened(_ name: String) -> String {
        name.count > computerV2LabelMaxAppNameCharacters ? String(name.prefix(computerV2LabelMaxAppNameCharacters - 1)) + "…" : name
    }
    if trimmed.hasSuffix(".app") {
        let base = ((trimmed as NSString).lastPathComponent as NSString).deletingPathExtension
        return base.isEmpty ? nil : shortened(base)
    }
    // A reverse-DNS bundle id: three or more dotted labels, no spaces. "Notes" and "Final Cut Pro" are
    // names; "com.apple.Notes" is not.
    let labels = trimmed.split(separator: ".", omittingEmptySubsequences: false)
    let isBundleId = labels.count >= 3 && labels.allSatisfy { label in
        !label.isEmpty && label.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
    if isBundleId, let last = labels.last { return shortened(String(last)) }
    return shortened(trimmed)
}

/// PURE: the target-API members a script calls, deduped, in first-seen order.
func computerV2Verbs(in code: String) -> [String] {
    var seen: Set<String> = []
    var verbs: [String] = []
    for match in verbPattern.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
        guard let range = Range(match.range(at: 1), in: code) else { continue }
        let verb = String(code[range])
        if seen.insert(verb).inserted { verbs.append(verb) }
    }
    return verbs
}

// MARK: - The script

/// PURE: the call's `code` argument as the expanded row shows it — the whole script up to
/// `computerV2CodeMaxCharacters`, with a note saying so when it was cut. Nil when the arguments do not
/// parse or carry no code.
func computerV2Code(argsJson: String) -> String? {
    guard let data = argsJson.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let code = object["code"] as? String, !code.isEmpty else { return nil }
    return computerV2CappedCode(code)
}

/// PURE: `code` cut to `computerV2CodeMaxCharacters`, ending in a marker that says how much was kept.
func computerV2CappedCode(_ code: String) -> String {
    guard code.count > computerV2CodeMaxCharacters else { return code }
    return String(code.prefix(computerV2CodeMaxCharacters))
        + "\n[… truncated at \(computerV2CodeMaxCharacters) characters]"
}

/// PURE: the first line of an expanded call — "<tool> <detail>" for every tool, but a ComputerV2 call's
/// label already says what it is, so it stands alone ("Notes · click, paste, state", never
/// "computer_v2 Notes · …").
func toolCallLineText(name: String, detail: String?) -> String {
    if isComputerV2Tool(name) { return computerV2CallLabel(detail: detail, running: true) }
    return detail.map { "\(name) \($0)" } ?? name
}
