import AppKit
import ApplicationServices
import Darwin
import Foundation

// The Winter island's "is that EXACT terminal in front?" (`docs/claude/island.md`, routing rule 2): a session driven
// from a terminal (the CLI/TUI) hides its cards on top only while the terminal window or tab it runs in is the one in
// front. The daemon knows the client's tty (`hello.tty` → `island.pending`'s hosts); this maps the tty to the
// frontmost app's window through the process tree and the window's accessibility titles.
//
// Positive evidence only: `.front` needs proof, and anything that cannot be told is `.unknown` — the card then SHOWS.
// Terminal.app and iTerm2 do not put the tty in a title by default, so with several tabs open the answer is usually
// `.unknown` unless the title names the running program uniquely. iTerm2's sessions are not children of the app
// (its server daemon is), so the process tree never finds them: `.unknown`.

/// One process, as the matcher needs it.
struct TerminalProcess: Equatable {
    let pid: Int32
    let ppid: Int32
    /// The controlling terminal's name (`ttys004`), nil for none.
    let tty: String?
    /// The executable's short name (`p_comm`, ≤ 16 bytes).
    let command: String
}

/// What is in front, read at one moment.
struct FrontTerminalSnapshot: Equatable {
    /// The frontmost app's pid (nil when none could be read), and its bundle id.
    let frontPid: Int32?
    var frontBundleId: String? = nil
    let processes: [TerminalProcess]
    /// The focused window's title, and the selected tab's title when the window has a tab group (nil when unread —
    /// no Accessibility trust, or the app answered nothing).
    let windowTitle: String?
    let tabTitle: String?
}

enum TerminalWindowMatcher {
    /// Apps whose every window is a terminal. In any other app hosting a terminal (an editor's integrated terminal) the
    /// focus may be anywhere else in the window, so only a title naming the tty itself counts there.
    static let dedicatedTerminals: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "net.kovidgoyal.kitty",
        "com.github.wez.wezterm", "org.alacritty", "io.alacritty", "dev.warp.Warp-Stable", "co.zeit.hyper",
        "com.raphaelamorim.rio", "org.tabby",
    ]

    /// Shells, logins and wrappers: never the program a title is named after.
    static let unnamedCommands: Set<String> = ["login", "zsh", "-zsh", "bash", "-bash", "fish", "-fish", "sh", "-sh",
                                               "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "env", "sudo"]

    /// PURE: the terminal device name of a tty path (`/dev/ttys004` → `ttys004`).
    static func deviceName(_ tty: String) -> String {
        tty.hasPrefix("/dev/") ? String(tty.dropFirst(5)) : tty
    }

    /// PURE: the ttys of every process descending from `root`, each with the commands running on it.
    static func ttysUnder(_ root: Int32, processes: [TerminalProcess]) -> [String: Set<String>] {
        var children: [Int32: [TerminalProcess]] = [:]
        for p in processes where p.pid != root { children[p.ppid, default: []].append(p) }
        var out: [String: Set<String>] = [:]
        var stack = children[root] ?? []
        var seen = Set<Int32>()
        while let p = stack.popLast() {
            guard seen.insert(p.pid).inserted else { continue }
            if let tty = p.tty { out[tty, default: []].insert(p.command) }
            stack.append(contentsOf: children[p.pid] ?? [])
        }
        return out
    }

    /// PURE: does `title` mention `word` as a whole word (letters, digits, `_`, `-`, `.` around it are not boundaries)?
    static func title(_ title: String, mentions word: String) -> Bool {
        guard !word.isEmpty else { return false }
        let isWordChar: (Character) -> Bool = { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == "." }
        var search = title.startIndex..<title.endIndex
        while let r = title.range(of: word, options: [.caseInsensitive], range: search) {
            let before = r.lowerBound == title.startIndex ? nil : title[title.index(before: r.lowerBound)]
            let after = r.upperBound == title.endIndex ? nil : title[r.upperBound]
            if !(before.map(isWordChar) ?? false), !(after.map(isWordChar) ?? false) { return true }
            search = r.upperBound..<title.endIndex
        }
        return false
    }

    /// PURE: is the terminal on `tty` the frontmost window/tab?
    static func frontness(of tty: String, in snapshot: FrontTerminalSnapshot) -> TerminalFrontness {
        let target = deviceName(tty)
        guard let front = snapshot.frontPid else { return .unknown }
        let ttys = ttysUnder(front, processes: snapshot.processes)
        // The frontmost app does not host that terminal at all (another app is in front, or it runs inside tmux/ssh,
        // whose pty belongs to a server): not in front as far as anything can tell — the card shows either way.
        guard ttys[target] != nil else { return .notFront }
        let titles = [snapshot.tabTitle, snapshot.windowTitle].compactMap { $0 }.filter { !$0.isEmpty }

        // 1. A title that names a tty names exactly one.
        for title in titles {
            let named = ttys.keys.filter { Self.title(title, mentions: $0) }
            if named.count == 1 { return named[0] == target ? .front : .notFront }
        }
        // Past here the evidence is the window's, which holds only in an app that is nothing but terminals.
        guard let bundle = snapshot.frontBundleId, dedicatedTerminals.contains(bundle) else { return .unknown }
        // 2. The app runs ONE terminal: whatever of it is in front is that one.
        if ttys.count == 1 { return .front }
        // 3. A title names the program running in exactly one of its terminals (Terminal.app's default title shows
        //    the foreground process: "user — winter — 80×24").
        for title in titles {
            var matches = Set<String>()
            for (name, commands) in ttys {
                for command in commands where command.count >= 3 && !unnamedCommands.contains(command) {
                    if Self.title(title, mentions: command) { matches.insert(name); break }
                }
            }
            if matches.count == 1 { return matches.first == target ? .front : .notFront }
        }
        return .unknown
    }
}

/// The live reads behind a `FrontTerminalSnapshot`: the process table (`sysctl KERN_PROC_ALL`) and the frontmost
/// app's focused window through accessibility — read-only, only when `AXIsProcessTrusted()` (never prompts), a 0.1 s
/// messaging timeout, a shallow walk for the tab group, nothing set on the app. Off the main thread.
enum TerminalSnapshotReader {
    static func read(frontPid: Int32?, frontBundleId: String?) -> FrontTerminalSnapshot {
        let processes = Self.processTable()
        var windowTitle: String?
        var tabTitle: String?
        if let frontPid, AXIsProcessTrusted() {
            (windowTitle, tabTitle) = Self.focusedTitles(pid: frontPid)
        }
        return FrontTerminalSnapshot(frontPid: frontPid, frontBundleId: frontBundleId, processes: processes,
                                     windowTitle: windowTitle, tabTitle: tabTitle)
    }

    /// Every process: pid, parent, terminal and short name.
    static func processTable() -> [TerminalProcess] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return [] }
        // Room for processes started between the two calls.
        size += size / 8
        let count = size / MemoryLayout<kinfo_proc>.stride
        var procs = [kinfo_proc](repeating: kinfo_proc(), count: count)
        guard sysctl(&mib, 3, &procs, &size, nil, 0) == 0 else { return [] }
        let n = size / MemoryLayout<kinfo_proc>.stride
        var out: [TerminalProcess] = []
        out.reserveCapacity(n)
        for i in 0..<n {
            var p = procs[i]
            let dev = p.kp_eproc.e_tdev
            var tty: String?
            if dev != -1, dev != 0, let name = devname(dev, S_IFCHR) { tty = String(cString: name) }
            let command = withUnsafePointer(to: &p.kp_proc.p_comm) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN) + 1) { String(cString: $0) }
            }
            out.append(TerminalProcess(pid: p.kp_proc.p_pid, ppid: p.kp_eproc.e_ppid, tty: tty, command: command))
        }
        return out
    }

    /// The focused window's title and its selected tab's title.
    static func focusedTitles(pid: Int32) -> (String?, String?) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        guard let window = Self.element(app, kAXFocusedWindowAttribute) else { return (nil, nil) }
        let windowTitle = Self.string(window, kAXTitleAttribute)
        var tabTitle: String?
        // The tab group sits at most two levels down (Terminal.app: the window's direct child).
        if let group = Self.firstDescendant(of: window, role: kAXTabGroupRole as String, depth: 2),
           let tabs = Self.children(group) {
            for tab in tabs.prefix(64) {
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(tab, kAXValueAttribute as CFString, &value) == .success,
                      let number = value as? NSNumber, number.intValue == 1 else { continue }
                tabTitle = Self.string(tab, kAXTitleAttribute)
                break
            }
        }
        return (windowTitle, tabTitle)
    }

    private static func element(_ e: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func string(_ e: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private static func children(_ e: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    private static func firstDescendant(of e: AXUIElement, role: String, depth: Int) -> AXUIElement? {
        guard depth > 0, let kids = Self.children(e) else { return nil }
        for kid in kids.prefix(64) where Self.string(kid, kAXRoleAttribute) == role { return kid }
        for kid in kids.prefix(64) {
            if let found = Self.firstDescendant(of: kid, role: role, depth: depth - 1) { return found }
        }
        return nil
    }
}
