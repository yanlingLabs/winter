import Foundation

// -----------------------------------------------------------------------------------------------
// Winter for Chrome — the native-messaging host manifests a RELEASE Winter.app writes at every launch
// (apple/ComputerUse/WinterBrowserHost/PROTOCOL.md §8). Each tells one Chromium browser where Winter's host is:
// `<this Winter.app>/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host` — this app's own bundle
// path, never a versioned one, so an update in place keeps every browser pointed at the current host.
//
// The rules (the same as `bun run dev:helper`'s TS writer for the dev manifest, whose text it matches byte for byte):
// written atomically, only when the content differs, only into a browser whose support directory already exists (Winter
// never creates a browser's directory), and nothing is ever deleted. While the store ids do not exist yet it writes
// nothing at all: a manifest no extension may use would only be noise. The Debug app writes nothing (the dev manifest is
// `dev:helper`'s). And only an INSTALLED Winter writes: one running from `/Applications` or `~/Applications`, never a
// copy launched from a disk image, a download folder, a build directory or an App Translocation mount — every browser
// would otherwise be pointed at a host that is gone once that copy is.
// -----------------------------------------------------------------------------------------------

enum BrowserHostManifest {
    /// The dist native-messaging host name (the extension's `connectNative` name; the dev one is `com.winter.browser.dev`).
    static let hostName = "com.winter.browser"

    /// The store builds' extension ids — the Chrome Web Store and Edge Add-ons listings, publisher yanlingLabs. Assigned at
    /// the first upload; until then none. Kept equal to the daemon's (`extension-ids.ts`) and the host's
    /// (`ExtensionIds.swift`) dist lists by a repo test.
    static let storeExtensionIds: [String] = []

    /// Each browser's directory under `~/Library/Application Support/` (the manifest goes in its `NativeMessagingHosts/`).
    /// Kept equal to the TS writer's list by a repo test.
    static let browserDirectories: [String] = [
        "Google/Chrome",
        "Google/Chrome Beta",
        "Google/Chrome Dev",
        "Google/Chrome Canary",
        "Chromium",
        "Microsoft Edge",
        "Microsoft Edge Beta",
        "Microsoft Edge Dev",
        "Microsoft Edge Canary",
        "BraveSoftware/Brave-Browser",
        "Vivaldi",
        "com.operasoftware.Opera",
        "Arc/User Data",
    ]

    /// The host inside a Winter.app bundle.
    static let hostPathInApp = "Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host"

    enum Outcome: Equatable {
        case written
        case unchanged
        case skipped
        case failed(String)
    }

    /// The manifest's bytes — two-space JSON and a newline, the same text the TS writer produces — or nil when there is
    /// no extension to allow.
    static func content(hostPath: String, extensionIds: [String]) -> Data? {
        guard !extensionIds.isEmpty, hostPath.hasPrefix("/") else { return nil }
        let origins = extensionIds.map { "    \(jsonString("chrome-extension://\($0)/"))" }.joined(separator: ",\n")
        let text = """
        {
          "name": \(jsonString(hostName)),
          "description": "Winter for Chrome",
          "path": \(jsonString(hostPath)),
          "type": "stdio",
          "allowed_origins": [
        \(origins)
          ]
        }

        """
        return Data(text.utf8)
    }

    /// Writes the manifest for every browser whose support directory exists under `supportRoot`.
    static func write(appBundlePath: String, supportRoot: String, extensionIds: [String] = storeExtensionIds,
                      fileManager: FileManager = .default) -> [(dir: String, outcome: Outcome)] {
        let hostPath = (appBundlePath as NSString).appendingPathComponent(hostPathInApp)
        guard let data = content(hostPath: hostPath, extensionIds: extensionIds) else {
            return browserDirectories.map { ($0, .skipped) }
        }
        return browserDirectories.map { dir in
            let browserDir = (supportRoot as NSString).appendingPathComponent(dir)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: browserDir, isDirectory: &isDir), isDir.boolValue else { return (dir, .skipped) }
            let nmDir = (browserDir as NSString).appendingPathComponent("NativeMessagingHosts")
            let target = (nmDir as NSString).appendingPathComponent("\(hostName).json")
            if fileManager.contents(atPath: target) == data { return (dir, .unchanged) }
            do {
                try fileManager.createDirectory(atPath: nmDir, withIntermediateDirectories: false, attributes: nil)
            } catch CocoaError.fileWriteFileExists {
                // already there
            } catch {
                if !fileManager.fileExists(atPath: nmDir) { return (dir, .failed("could not create NativeMessagingHosts")) }
            }
            do {
                // `.atomic`: a temp file beside it, then a rename — a browser never reads half a manifest.
                try data.write(to: URL(fileURLWithPath: target), options: .atomic)
                return (dir, .written)
            } catch {
                return (dir, .failed("could not write the manifest"))
            }
        }
    }

    /// Is the app at `appPath` an installed Winter — directly or below `/Applications` or `<userHome>/Applications`, with
    /// symlinks resolved, and not an App Translocation copy (macOS runs a quarantined app from a randomised read-only
    /// mount until it is moved)?
    static func isInstalledLocation(appPath: String, userHome: String) -> Bool {
        let resolved = URL(fileURLWithPath: appPath).standardizedFileURL.resolvingSymlinksInPath().path
        guard !resolved.contains("/AppTranslocation/") else { return false }
        let roots = ["/Applications", (userHome as NSString).appendingPathComponent("Applications")]
            .map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path }
        return roots.contains { root in resolved.hasPrefix(root + "/") && resolved.hasSuffix(".app") }
    }

    /// Release launch: this app's manifests into the user's Application Support, off the main thread. Only the dist
    /// identity writes (a Debug build is compiled without the call; this guards a misbuilt one), and only when it runs
    /// from where it is installed.
    static func writeForThisApp(log: @escaping (String) -> Void = { _ in }) {
        guard Bundle.main.bundleIdentifier == "com.winter.app" else { return }
        let appPath = Bundle.main.bundlePath
        guard isInstalledLocation(appPath: appPath, userHome: NSHomeDirectory()) else {
            log("Winter for Chrome: not writing host manifests — this Winter is not running from /Applications or ~/Applications")
            return
        }
        DispatchQueue.global(qos: .utility).async {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.path
            guard let support else { return }
            let outcomes = write(appBundlePath: appPath, supportRoot: support)
            let written = outcomes.filter { $0.outcome == .written }.map(\.dir)
            if !written.isEmpty { log("Winter for Chrome: host manifest written for \(written.joined(separator: ", "))") }
            for case let (dir, .failed(why)) in outcomes { log("Winter for Chrome: \(dir): \(why)") }
        }
    }

    private static func jsonString(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{8}": out += "\\b"
            case "\u{C}": out += "\\f"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }
}
