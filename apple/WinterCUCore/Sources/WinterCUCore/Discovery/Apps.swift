import AppKit
import Foundation

/// App discovery, resolution and background launch.
enum CUApps {
    static let searchDirs: [String] = [
        "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications",
    ]

    struct Installed: Sendable, Equatable {
        var name: String
        var bundleId: String
        var url: URL
    }

    /// Top-level `.app` bundles in the standard folders.
    static func installed() -> [Installed] {
        var out: [Installed] = []
        var seen = Set<String>()
        let fm = FileManager.default
        for dir in searchDirs {
            guard let names = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for n in names where n.hasSuffix(".app") {
                let url = URL(fileURLWithPath: dir).appendingPathComponent(n)
                guard let b = Bundle(url: url), let id = b.bundleIdentifier, !seen.contains(id) else { continue }
                seen.insert(id)
                out.append(Installed(name: displayName(b, fallback: String(n.dropLast(4))), bundleId: id, url: url))
            }
        }
        return out
    }

    static func displayName(_ b: Bundle, fallback: String) -> String {
        (b.localizedInfoDictionary?["CFBundleDisplayName"] as? String)
            ?? (b.infoDictionary?["CFBundleDisplayName"] as? String)
            ?? (b.infoDictionary?["CFBundleName"] as? String)
            ?? fallback
    }

    /// Running regular apps first (by name), then installed ones not running.
    static func list() -> [CUAppInfo] {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        var out: [CUAppInfo] = []
        var ids = Set<String>()
        for app in running {
            guard let id = app.bundleIdentifier, !ids.contains(id) else { continue }
            ids.insert(id)
            out.append(CUAppInfo(name: app.localizedName ?? id, bundleId: id, running: true, pid: app.processIdentifier))
        }
        out.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        let rest = installed().filter { !ids.contains($0.bundleId) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        out.append(contentsOf: rest.map { CUAppInfo(name: $0.name, bundleId: $0.bundleId, running: false, pid: nil) })
        return out
    }

    enum Resolved {
        case running(NSRunningApplication)
        case installed(URL, bundleId: String?, name: String)
    }

    /// `app` is a bundle id, a path, or a name (case-insensitive; ".app" optional).
    static func resolve(_ app: String) throws -> Resolved {
        let q = app.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { throw CUError.invalidParams("app is empty") }
        let running = NSWorkspace.shared.runningApplications
        // A path.
        if q.hasPrefix("/") || q.hasPrefix("~") {
            let path = (q as NSString).expandingTildeInPath
            let url = URL(fileURLWithPath: path).standardizedFileURL
            if let r = running.first(where: { $0.bundleURL?.standardizedFileURL == url }) { return .running(r) }
            guard let b = Bundle(url: url) else { throw CUError.invalidParams("no app at \(q)") }
            return .installed(url, bundleId: b.bundleIdentifier, name: displayName(b, fallback: url.deletingPathExtension().lastPathComponent))
        }
        // A bundle id.
        if q.contains("."), !q.lowercased().hasSuffix(".app") {
            if let r = running.first(where: { $0.bundleIdentifier?.lowercased() == q.lowercased() }) { return .running(r) }
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: q), let b = Bundle(url: url) {
                return .installed(url, bundleId: b.bundleIdentifier, name: displayName(b, fallback: q))
            }
        }
        // A name.
        var name = q
        if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
        let want = name.lowercased()
        let regular = running.filter { $0.activationPolicy == .regular }
        if let r = regular.first(where: { $0.localizedName?.lowercased() == want }) ?? running.first(where: {
            $0.localizedName?.lowercased() == want || $0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == want
        }) { return .running(r) }
        let inst = installed()
        if let i = inst.first(where: { $0.name.lowercased() == want || $0.url.deletingPathExtension().lastPathComponent.lowercased() == want }) {
            return .installed(i.url, bundleId: i.bundleId, name: i.name)
        }
        if let i = inst.first(where: { $0.name.lowercased().hasPrefix(want) }) {
            return .installed(i.url, bundleId: i.bundleId, name: i.name)
        }
        throw CUError.invalidParams("no app named “\(app)” — apps.list() shows what is available")
    }

    /// Launches without activating (the user's front app keeps focus) and waits for it to register.
    static func launchInBackground(_ url: URL, timeoutMs: Double = 8000) async throws -> NSRunningApplication {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.allowsRunningApplicationSubstitution = true  // a running copy is used, never a second instance
        config.addsToRecentItems = false
        config.promptsUserIfNeeded = false
        let app: NSRunningApplication
        do {
            app = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
        } catch {
            throw CUError.unsupported("could not launch \(url.lastPathComponent): \(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(timeoutMs / 1000)
        while !app.isFinishedLaunching, Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        return app
    }
}
