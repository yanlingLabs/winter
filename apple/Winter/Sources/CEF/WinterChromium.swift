import Foundation

/// **Where Winter.app's Chromium is.** There is ONE copy (the user's ruling): the CEF framework and the five
/// "Winter Helper" bundles live in the nested Winter Headless helper's `Contents/Frameworks`, and Winter.app's own CEF —
/// the panel browser, the editor, Office documents, the built-in browser link — runs from there too. Winter.app's own
/// `Contents/Frameworks` holds none of it.
///
/// Why there: every Chromium subprocess enters a sandbox that may read only inside its BROWSER process's main bundle.
/// Winter Headless's bundle holds them for its own browser; Winter.app's bundle holds Winter Headless, so it holds them
/// for Winter's too. (The other way round — the helper borrowing Winter.app's `Contents/Frameworks` — was measured on a
/// Release build: the helper's subprocesses could not read the framework.)
///
/// The helper is `Winter Headless.app` in a Release build and `Winter Headless Dev.app` in a Debug one ("Winter Dev"
/// runs its CEF from the nested helper exactly as Release does). Pure path arithmetic — nothing is loaded here.
enum WinterChromium {
    /// The nested helper's names, the Release build's first.
    static let helperAppNames = ["Winter Headless.app", "Winter Headless Dev.app"]
    static let frameworkName = "Chromium Embedded Framework.framework"
    /// The base subprocess bundle; Chromium appends its own per-role suffix (" (Renderer)", " (GPU)", …) to its path.
    static let subprocessName = "Winter Helper"
    /// All five subprocess bundles.
    static let subprocessBundleNames = ["Winter Helper", "Winter Helper (Alerts)", "Winter Helper (GPU)",
                                        "Winter Helper (Plugin)", "Winter Helper (Renderer)"]

    struct Location: Equatable {
        /// `…/Contents/Helpers/<helper>.app/Contents/Frameworks` — the framework and the five bundles.
        let frameworks: URL
        /// `…/Chromium Embedded Framework.framework` (CEF's `framework_dir_path`).
        var framework: URL { frameworks.appendingPathComponent(WinterChromium.frameworkName, isDirectory: true) }
        /// The base "Winter Helper" executable (CEF's `browser_subprocess_path`).
        var subprocessExecutable: URL {
            frameworks.appendingPathComponent("\(WinterChromium.subprocessName).app/Contents/MacOS", isDirectory: true)
                .appendingPathComponent(WinterChromium.subprocessName, isDirectory: false)
        }
        /// One subprocess bundle's executable.
        func executable(of bundleName: String) -> URL {
            frameworks.appendingPathComponent("\(bundleName).app/Contents/MacOS", isDirectory: true)
                .appendingPathComponent(bundleName, isDirectory: false)
        }
    }

    /// The nested helper's Chromium in `appBundle`, or nil when no helper there carries a framework and a base
    /// subprocess (a build that embedded none).
    static func location(appBundle: URL, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> Location? {
        for name in helperAppNames {
            let location = Location(frameworks: appBundle
                .appendingPathComponent("Contents/Helpers", isDirectory: true)
                .appendingPathComponent(name, isDirectory: true)
                .appendingPathComponent("Contents/Frameworks", isDirectory: true))
            if exists(location.framework.appendingPathComponent("Chromium Embedded Framework").path),
               exists(location.subprocessExecutable.path) {
                return location
            }
        }
        return nil
    }
}
