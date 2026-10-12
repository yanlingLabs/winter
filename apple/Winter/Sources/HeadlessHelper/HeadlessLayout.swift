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
    /// Chromium switches the daemon passed through (diagnostics only: `--enable-logging=stderr`, `--v=1`, `--vmodule=…`,
    /// and a NetLog capture, `--log-net-log=<file>` with `--net-log-capture-mode=…`).
    let passthrough: [String]

    /// Always on, whatever the daemon passes:
    ///  * `--use-mock-keychain` — never the user's Keychain: an in-memory stand-in, so no "Safe Storage" item is
    ///    read or created and no Keychain prompt can appear;
    ///  * `--mute-audio` — nobody hears a headless tab;
    ///  * `--disable-features=MediaRouter,DialMediaRouteProvider,…` — no cast discovery, so no "accept incoming network
    ///    connections?" dialog; `WebRtcHideLocalIpsWithMdns` — no mDNS responder for WebRTC: measured, a page's
    ///    `RTCPeerConnection` made the network service bind the mDNS port (5353, multicast on the LAN) even with WebRTC
    ///    held to proxied TCP (`webrtc.ip_handling_policy`, set per session context), which gathers no host address
    ///    to hide; and the rest, `backgroundRequestSwitches` below;
    ///  * `backgroundRequestSwitches` — **no request a page did not cause** (each one's measurement is on it);
    ///  * `--enable-features=WebMCP` — a site's own agent tools (`document.modelContext`);
    ///  * `--host-resolver-rules=…` — every local-network NAME resolves to "not found"
    ///    (`HeadlessNetworkRule.hostResolverRulesSwitch`), whatever asks: a WebSocket too;
    ///  * `--proxy-pac-url=data:…` — every request the network service makes to a refused host, an IP literal or a
    ///    single-label name included, goes to a proxy that is never there (`HeadlessNetworkRule.proxyPacSwitch`).
    static let fixedSwitches = [
        "--use-mock-keychain",
        "--mute-audio",
        "--disable-features=" + disabledFeatures.joined(separator: ","),
        "--enable-features=WebMCP",
        HeadlessNetworkRule.hostResolverRulesSwitch,
        HeadlessNetworkRule.proxyPacSwitch,
    ] + backgroundRequestSwitches

    /// The features off (WinterCEF adds its own to the same list).
    static let disabledFeatures = [
        "MediaRouter", "DialMediaRouteProvider", // cast discovery
        "WebRtcHideLocalIpsWithMdns", // WebRTC's mDNS responder (the mDNS port)
        "NetworkTimeServiceQuerying", // the network-time query at start (clients2.google.com/time)
        "AutofillServerCommunication", // each page's form signatures sent to Google's autofill server
        "AimEnabled", // the AI Mode eligibility request at start (www.google.com/async/folae), every trigger of it
        "OptimizationHints", "Translate", // not seen in a run; off as a belt (hint fetches on navigation, translate)
    ]

    /// **No request a page did not cause — but one.** Measured with a NetLog of a two-minute idle run and of a browsing
    /// run: each switch here stopped the request it names, and with all of them nothing leaves the Mac that no page
    /// asked for except the COMPONENT UPDATER, which stays on purpose: it is how the browser's Chrome Root Store is kept
    /// current (its PKI metadata component: measured, the root store this build compiled in is version 35, and the
    /// browser verifies with version 40 once the component installs, ~60 s after start) and how the CRLSet arrives (its
    /// download seen ~65 s in, in one two-minute run, not in another). The daemon keeps the components
    /// across runs (`browser/headless/components.ts`), so after the first run it costs one update check
    /// (update.googleapis.com) and no download. (What else is
    /// left is the host resolver's IPv6 route check — a UDP connect that sends no packet.) `disabledFeatures` holds the
    /// feature half.
    ///    * `--no-first-run` — every run is a first run (a fresh cache root): without it, the RLZ ping 90 s after start
    ///      (clients1.google.com/tools/pso/ping);
    ///    * `--gaia-url=https://127.0.0.1:4/` — the sign-in cookie check at start (`ListAccounts`) has no switch of its
    ///      own (sign-in is already disallowed in CEF; `--allow-browser-signin=false`, `--disable-sync` and the
    ///      cookie-jar features were tried and did not stop it): Google's sign-in origin is moved to the PAC belt's dead
    ///      port on this Mac, so its attempts fail at once and none leaves the Mac;
    ///    * `--disable-background-networking` — Safe Browsing's list update about 85 s after start
    ///      (safebrowsing.googleapis.com, answered 400: this build has no API key, so no list ever loads — nothing a
    ///      page relies on is lost), and the other periodic fetches it governs;
    ///    * `--disable-domain-reliability` — not seen in a run, off as a belt: error beacons about Google's own domains.
    /// Each was checked by leaving it out of an otherwise full set: its request came back.
    static let backgroundRequestSwitches = [
        "--no-first-run",
        "--gaia-url=https://127.0.0.1:4/",
        "--disable-background-networking",
        "--disable-domain-reliability",
    ]

    static func parse(_ arguments: [String]) -> HeadlessArguments? {
        var cacheRoot: String?
        var passthrough: [String] = []
        for argument in arguments.dropFirst() {
            if argument.hasPrefix("--winter-cache-root=") {
                cacheRoot = String(argument.dropFirst("--winter-cache-root=".count))
            } else if argument.hasPrefix("--winter-") {
                continue
            } else if argument.hasPrefix("--enable-logging") || argument.hasPrefix("--v=") || argument.hasPrefix("--vmodule=")
                        || argument.hasPrefix("--log-net-log=") || argument.hasPrefix("--net-log-capture-mode=") {
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
