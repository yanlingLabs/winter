import AppKit
import ApplicationServices
import Carbon
import Foundation

/// `target.applescript` and `target.scriptingDictionary`, and the menu commands done through AppleScript when
/// the app keeps them disabled in the background. An extra door beside the UI, never a replacement: only the
/// bound app, no shell, no dialogs, never `activate` (`CUAppleScriptPolicy`), and the user-view guard checks
/// every run like an act.
extension CUCore {
    /// The bound app as a script may name it.
    func boundApp(_ t: CUTarget) -> CUAppleScriptPolicy.BoundApp {
        CUAppleScriptPolicy.BoundApp(name: t.appName, bundleId: t.bundleId,
                                     path: NSRunningApplication(processIdentifier: t.pid)?.bundleURL?.path)
    }

    /// Runs a checked script (replaceable by tests: nothing there may run AppleScript).
    func runAppleScript(_ source: String, _ t: CUTarget, timeoutMs: Int) throws -> String? {
        if let o = appleScriptOverride { return try o(source, t) }
        return try CUAppleScriptRunner.run(source, bound: boundApp(t), boundPid: t.pid, timeoutMs: timeoutMs,
                                           alsoRefused: javaScriptDoorRefusals(t))
    }

    /// The bound app's own JavaScript doors, from its (static) dictionary: refused for every script run against it,
    /// whatever their event code — a browser this helper has no fixed entry for included.
    func javaScriptDoorRefusals(_ t: CUTarget) -> [String: String] {
        let model: CUScriptingDictionary.Model?
        if let o = scriptingDictionaryOverride { model = o(t) } else {
            model = NSRunningApplication(processIdentifier: t.pid)?.bundleURL.flatMap {
                CUScriptingDictionary.isDynamic(appURL: $0) ? nil : CUScriptingDictionary.model(appURL: $0)
            }
        }
        return model.map(CUScriptingDictionary.javaScriptDoorRefusals) ?? [:]
    }

    /// A bound app's bundle path and `CFBundleShortVersionString` (helper 1.8.0's `target.bind` `app.path`/`app.version`).
    static func bundleFacts(_ running: NSRunningApplication?) -> (path: String?, version: String?) {
        guard let url = running?.bundleURL else { return (nil, nil) }
        return (url.path, Bundle(url: url)?.infoDictionary?["CFBundleShortVersionString"] as? String)
    }

    /// May the helper send Apple Events to the app, never asking (replaceable by tests): noErr granted,
    /// -1744 macOS would ask the user, -1743 the user said no.
    func automationPermission(_ t: CUTarget) -> OSStatus {
        if let o = automationPermissionOverride { return o(t.pid) }
        return CUAppleScriptRunner.automationPermission(pid: t.pid)
    }

    static let appleScriptMaxSource = 64_000
    static let appleScriptMaxResult = 64_000

    public func targetAppleScript(_ p: TargetAppleScriptParams) async throws -> TargetAppleScriptResult {
        let t = try target(p.targetId)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try await ensureAlive(t, token: token)
        guard (p.language ?? "applescript").lowercased() == "applescript" else {
            throw CUError(code: "refused",
                          message: "JavaScript for Automation isn't run: its Objective-C bridge runs Cocoa inside Winter's helper, where no Apple Event check can see it — write the script in AppleScript",
                          data: ["reason": .string("applescript")])
        }
        guard !p.source.isEmpty, p.source.utf8.count <= Self.appleScriptMaxSource else {
            throw CUError.invalidParams("applescript() takes a script of 1 to \(Self.appleScriptMaxSource) bytes")
        }
        try token.check()
        do {
            try CUAppleScriptPolicy.checkSource(p.source, bound: boundApp(t))
        } catch let e as CUError {
            throw CUError(code: "refused", message: e.message, data: ["reason": .string("applescript")])
        }
        if let b = t.bundleId, CUFloors.systemSettingsBundleIds.contains(b) {
            try await queues.run(t.pid) { [self] in try floorCheckPrivacy(t) }
        }
        var notes: [String] = []
        var timeout = min(max(p.timeoutMs ?? 10_000, 500), 120_000)
        switch automationPermission(t) {
        case OSStatus(noErr):
            break
        case OSStatus(errAEEventNotPermitted):
            throw CUError(code: "refused",
                          message: "the user has not allowed Winter Computer Use to control \(t.appName) (System Settings › Privacy & Security › Automation) — use the UI routes, or ask the user",
                          data: ["reason": .string("automation_denied")])
        case OSStatus(errAEEventWouldRequireUserConsent):
            // The first event raises macOS's own question; the run waits for the user's answer.
            timeout += 60_000
            notes.append("macOS asked the user to let Winter Computer Use control \(t.appName)")
        default:
            break
        }
        let before = userView()
        let result: String?
        do {
            result = try runAppleScript(p.source, t, timeoutMs: timeout)
        } catch let e as CUError {
            _ = viewNoteAfterBind(before, app: t.appName, pid: t.pid, route: "a failed applescript")
            CULog.act.notice("applescript in \(t.appName, privacy: .public) failed: \(e.code, privacy: .public)")
            if e.code == "not_allowed" { throw CUError(code: "refused", message: e.message, data: ["reason": .string("applescript")]) }
            throw e
        }
        if let note = viewNoteAfterBind(before, app: t.appName, pid: t.pid, route: "applescript") { notes.append(note) }
        t.lastActionMs = clock.nowMs()
        CULog.act.notice("applescript in \(t.appName, privacy: .public): ran (\(p.source.utf8.count, privacy: .public) bytes)")
        let capped = result.map { $0.utf8.count > Self.appleScriptMaxResult ? String($0.prefix(Self.appleScriptMaxResult)) + "… (cut)" : $0 }
        return TargetAppleScriptResult(result: capped, detail: notes.isEmpty ? nil : notes.joined(separator: "; "))
    }

    public func targetScriptingDictionary(_ p: TargetScriptingDictionaryParams) async throws -> TargetScriptingDictionaryResult {
        let t = try target(p.targetId)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try await ensureAlive(t, token: token)
        let model: CUScriptingDictionary.Model?
        if let o = scriptingDictionaryOverride { model = o(t) } else {
            model = NSRunningApplication(processIdentifier: t.pid)?.bundleURL.flatMap { CUScriptingDictionary.model(appURL: $0) }
        }
        guard let model else { return TargetScriptingDictionaryResult(scriptable: false) }
        let (text, truncated) = CUScriptingDictionary.render(model, app: t.appName, search: p.search)
        return TargetScriptingDictionaryResult(scriptable: true, text: text, truncated: truncated)
    }

    /// `target.scriptingCommands`: the bound app's dictionary commands, structured (for the daemon's typed wrappers).
    /// Read from the app's files and cached like `target.scriptingDictionary`; an app whose dictionary is DYNAMIC (it
    /// must be asked for it) is left unread — reading it would send it an Apple Event, and this runs at every bind.
    public func targetScriptingCommands(_ p: TargetScriptingCommandsParams) async throws -> TargetScriptingCommandsResult {
        let t = try target(p.targetId)
        let token = cancels.begin(p.callId)
        defer { cancels.end(p.callId) }
        try await ensureAlive(t, token: token)
        let url = NSRunningApplication(processIdentifier: t.pid)?.bundleURL
        let bundleVersion = url.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleVersion"] as? String }
        let model: CUScriptingDictionary.Model?
        if let o = scriptingDictionaryOverride {
            model = o(t)
        } else if let url {
            if CUScriptingDictionary.isDynamic(appURL: url) {
                CULog.act.notice("scriptingCommands for \(t.appName, privacy: .public): a dynamic dictionary — not read")
                return TargetScriptingCommandsResult(scriptable: true, bundleVersion: bundleVersion, commands: [])
            }
            model = CUScriptingDictionary.model(appURL: url)
        } else {
            model = nil
        }
        guard let model else { return TargetScriptingCommandsResult(scriptable: false, bundleVersion: bundleVersion) }
        let (commands, truncated) = CUScriptingDictionary.commands(model, search: p.search)
        return TargetScriptingCommandsResult(scriptable: true, bundleVersion: bundleVersion, commands: commands, truncated: truncated ? true : nil)
    }

    // MARK: menu commands through AppleScript

    /// A menu command the app keeps disabled in the background, done through the app's own scripting instead —
    /// only for a short list of known equivalents, and only when the user ALREADY allowed Winter to control the
    /// app (this never raises macOS's question on its own). Nil: no known equivalent, no grant, or the script
    /// failed (nothing was done; the caller answers with the UI routes).
    func menuThroughAppleScript(_ path: [String], title: String, _ t: CUTarget) -> ActOutcome? {
        guard let known = knownMenuScript(path, t) else { return nil }
        guard automationPermission(t) == OSStatus(noErr) else {
            CULog.act.notice("menu in \(t.appName, privacy: .public): an AppleScript equivalent exists, but Automation is not granted — not asked")
            return nil
        }
        do {
            try CUAppleScriptPolicy.checkSource(known.source, bound: boundApp(t))
            _ = try runAppleScript(known.source, t, timeoutMs: 8_000)
        } catch {
            CULog.act.notice("menu in \(t.appName, privacy: .public): the AppleScript equivalent failed — \((error as? CUError)?.code ?? "error", privacy: .public)")
            return nil
        }
        CULog.act.notice("menu in \(t.appName, privacy: .public): done through AppleScript (\(known.what, privacy: .public))")
        return ActOutcome(rung: .accessibility,
                          detail: "“\(title)” is disabled while \(t.appName) is in the background, so it was done through AppleScript (\(known.what))")
    }

    struct KnownScript: Equatable {
        var source: String
        var what: String
    }

    /// The known equivalents. Each one names exactly what the bound window shows — Finder's folder (its
    /// `AXDocument`) and the items selected in it, Safari's window by its id — so it can never act on another
    /// window's selection; when that can't be read, there is no equivalent.
    func knownMenuScript(_ path: [String], _ t: CUTarget) -> KnownScript? {
        let key = path.map(CUMenuWalker.normalize).joined(separator: " › ")
        switch t.bundleId {
        case "com.apple.finder"?:
            guard let window = try? windowElement(t), let folder = Self.folderPath(ax.string(window, "AXDocument")) else { return nil }
            let at = "folder (POSIX file \(Self.quoted(folder)) as alias)"
            switch key {
            case "file › move to trash":
                // Open is NOT here: Finder's Open is routed to a background NSWorkspace open (finderOpenRoute),
                // never a Finder open event (which would bring the opener to the front).
                let names = selectedNames(in: window)
                guard !names.isEmpty else { return nil }
                let list = "{" + names.map(Self.quoted).joined(separator: ", ") + "}"
                return KnownScript(source: "tell application \"Finder\" to delete (every item of \(at) whose name is in \(list))",
                                   what: "Finder's delete of \(names.count) selected item\(names.count == 1 ? "" : "s")")
            case "file › new folder":
                return KnownScript(source: "tell application \"Finder\" to make new folder at \(at)", what: "Finder's make new folder")
            default:
                return nil
            }
        case "com.apple.Safari"?:
            let window = "window id \(t.windowID)"
            switch key {
            case "file › new tab":
                return KnownScript(source: "tell application \"Safari\" to tell \(window) to set current tab to (make new tab)",
                                   what: "Safari's make new tab")
            case "view › reload page":
                return KnownScript(source: "tell application \"Safari\" to tell \(window) to set URL of current tab to (URL of current tab)",
                                   what: "Safari's reload of the current tab")
            default:
                return nil
            }
        default:
            return nil
        }
    }

    /// The names of the items selected in a window: elements marked `AXSelected`, named by their file name,
    /// title or first text. Bounded walk.
    func selectedNames(in window: AXUIElement) -> [String] {
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var names: [String] = []
        var seen = 0
        while !queue.isEmpty, seen < 3_000 {
            let (e, depth) = queue.removeFirst()
            seen += 1
            if depth > 0, ax.bool(e, kAXSelectedAttribute) == true, let name = itemName(e), !names.contains(name) {
                names.append(name)
                continue
            }
            if depth < 12 { queue += ax.elements(e, kAXChildrenAttribute).map { ($0, depth + 1) } }
        }
        return names
    }

    private func itemName(_ e: AXUIElement) -> String? {
        for attr in ["AXFilename", kAXTitleAttribute] {
            if let s = ax.string(e, attr), !s.isEmpty { return s }
        }
        var queue = ax.elements(e, kAXChildrenAttribute)
        var looked = 0
        while !queue.isEmpty, looked < 40 {
            let c = queue.removeFirst()
            looked += 1
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXTextFieldRole || role == kAXStaticTextRole, let v = ax.string(c, kAXValueAttribute), !v.isEmpty { return v }
            queue += ax.elements(c, kAXChildrenAttribute)
        }
        return nil
    }

    /// A Finder window's folder from its `AXDocument` (a file URL); nil for anything else.
    static func folderPath(_ document: String?) -> String? {
        guard let document, let url = URL(string: document), url.isFileURL else { return nil }
        let path = url.path
        return path.isEmpty ? nil : path
    }

    /// An AppleScript string literal.
    static func quoted(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
