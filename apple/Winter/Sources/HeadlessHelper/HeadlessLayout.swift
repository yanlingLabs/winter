import Foundation

/// Where Winter Headless finds the Chromium it runs on — worked out from its OWN location, never from an argument,
/// so nothing the daemon (or anyone else) passes can point it at another framework.
///
/// **Winter's one Chromium lives inside this helper**: its own `Contents/Frameworks` holds the CEF framework and the
/// five "Winter Helper" bundles, and Winter.app's own CEF runs from here too (the user's ruling). Every Chromium
/// subprocess enters a sandbox that may read only inside its BROWSER process's main bundle; this helper's bundle holds
/// them for its own browser, and Winter.app's holds this helper for Winter's.
///
/// CEF's main bundle is THIS helper — nested at `Winter.app/Contents/Helpers/Winter Headless.app` or standing alone
/// (the dev helper, `bun run dev:headless`) alike. The subprocesses are handed it and read it from inside their sandbox,
/// which reads only inside this process's own bundle: measured, naming the enclosing Winter.app crashed every
/// subprocess at start, while this bundle (or any bundle inside it) runs.
struct HeadlessLayout: Equatable {
    let mainBundle: String
    let frameworkDir: String
    let subprocessPath: String

    static let frameworkName = "Chromium Embedded Framework.framework"
    static let helperName = "Winter Helper"

    /// `nil` when the helper's own `Contents/Frameworks` holds no framework and no "Winter Helper".
    static func resolve(bundleURL: URL, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> HeadlessLayout? {
        let bundle = bundleURL.standardizedFileURL
        let frameworks = bundle.appendingPathComponent("Contents/Frameworks", isDirectory: true)
        let framework = frameworks.appendingPathComponent(frameworkName, isDirectory: true)
        let helper = frameworks.appendingPathComponent("\(helperName).app/Contents/MacOS/\(helperName)")
        guard exists(framework.appendingPathComponent("Chromium Embedded Framework").path), exists(helper.path) else {
            return nil
        }
        return HeadlessLayout(mainBundle: bundle.path, frameworkDir: framework.path, subprocessPath: helper.path)
    }
}

/// The helper's own arguments (`--winter-*`), and the Chromium switches it always runs with.
struct HeadlessArguments: Equatable {
    /// A directory of this run's own for CEF's root cache (the daemon makes it, 0700, and removes it).
    let cacheRoot: String
    /// Chromium switches the daemon passed through (diagnostics only: `--enable-logging=stderr`, `--v=1`).
    let passthrough: [String]

    /// Always on, whatever the daemon passes:
    ///  * `--use-mock-keychain` — never the user's Keychain: an in-memory stand-in, so no "Safe Storage" item is
    ///    read or created and no Keychain prompt can appear;
    ///  * `--mute-audio` — nobody hears a headless tab;
    ///  * `--disable-features=MediaRouter,DialMediaRouteProvider` — no cast discovery, so no "accept incoming
    ///    network connections?" dialog;
    ///  * `--enable-features=WebMCP` — a site's own agent tools (`document.modelContext`);
    ///  * `--host-resolver-rules=…` — every local-network NAME resolves to "not found"
    ///    (`HeadlessNetworkRule.hostResolverRulesSwitch`), whatever asks: a WebSocket too.
    static let fixedSwitches = [
        "--use-mock-keychain",
        "--mute-audio",
        "--disable-features=MediaRouter,DialMediaRouteProvider",
        "--enable-features=WebMCP",
        HeadlessNetworkRule.hostResolverRulesSwitch,
    ]

    static func parse(_ arguments: [String]) -> HeadlessArguments? {
        var cacheRoot: String?
        var passthrough: [String] = []
        for argument in arguments.dropFirst() {
            if argument.hasPrefix("--winter-cache-root=") {
                cacheRoot = String(argument.dropFirst("--winter-cache-root=".count))
            } else if argument.hasPrefix("--winter-") {
                continue
            } else if argument.hasPrefix("--enable-logging") || argument.hasPrefix("--v=") || argument.hasPrefix("--vmodule=") {
                passthrough.append(argument)
            }
        }
        guard let cacheRoot, cacheRoot.hasPrefix("/"), !cacheRoot.contains("\0") else { return nil }
        return HeadlessArguments(cacheRoot: cacheRoot, passthrough: passthrough)
    }

    /// Chromium's argv: the program, the fixed switches, then the passthrough.
    func chromiumArguments(program: String) -> [String] {
        [program] + Self.fixedSwitches + passthrough
    }
}
