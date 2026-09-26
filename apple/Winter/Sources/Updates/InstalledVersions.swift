import Foundation
import WinterKit

// MARK: - What is actually installed (2026-09-18)
//
// The panel's second half. "What version am I on" is not one number — Winter ships a browser engine
// and two agent SDKs inside itself, and when something misbehaves the first question is always
// which of them is which version. This file is the model plus the two readers that can answer
// locally; the SDK rows come from the daemon and are modelled as PENDING rather than omitted.

/// One row of the installed-versions table.
///
/// Two version fields, deliberately, because for the SDKs they genuinely differ and a difference is
/// a NORMAL state rather than an error:
/// - `pinned` — what this build of Winter was compiled against (its constant).
/// - `installed` — what is actually resolved and running.
///
/// Winter and CEF have only one number each, so they carry it in `installed` and leave `pinned`
/// nil. A row with neither is a row we cannot answer yet, and says so through `pendingReason`.
struct InstalledComponent: Equatable, Identifiable {
    var id: String { name }
    /// The facing name ("Winter", "Chromium", "Winter agent SDK", …).
    var name: String
    /// The version actually in place; nil when unknown.
    var installed: String?
    /// The compile-time pin, when the component has one distinct from `installed`.
    var pinned: String?
    /// Why `installed` is nil — rendered in the value column so the row is never blank.
    var pendingReason: String?
}

/// PURE: what goes in the row's value column.
///
/// The three shapes: a plain version; a pin-vs-installed pair when they disagree (both shown, no
/// alarm tone — an SDK resolving to a different build than the pin is an ordinary consequence of
/// the resolver's rungs, and hiding one of the two numbers is exactly what makes it hard to
/// diagnose); and the pending reason when there is nothing to show.
func installedComponentValue(_ component: InstalledComponent) -> String {
    switch (component.installed, component.pinned) {
    case (let installed?, let pinned?) where installed != pinned:
        return "\(installed) (pinned \(pinned))"
    case (let installed?, _):
        return installed
    case (nil, let pinned?):
        return "pinned \(pinned)"
    case (nil, nil):
        return component.pendingReason ?? "unknown"
    }
}

/// PURE: `true` when the installed version differs from the pin. A DISPLAY fact (the value column
/// shows both), never an error state — nothing in the panel turns red for this.
func installedComponentIsOffPin(_ component: InstalledComponent) -> Bool {
    guard let installed = component.installed, let pinned = component.pinned else { return false }
    return installed != pinned
}

/// PURE: `true` when the row is still waiting on something.
func installedComponentIsPending(_ component: InstalledComponent) -> Bool {
    component.installed == nil && component.pinned == nil
}

// MARK: - The local readers

/// Winter's own version — `CFBundleShortVersionString`, the same string `DashboardWiring.appVersion`
/// reads and the same one `VERSION` stamps.
func winterInstalledVersion(bundle: Bundle = .main) -> String? {
    bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
}

/// The embedded Chromium/CEF version, read WITHOUT initialising CEF.
///
/// This matters: `WinterCEF.mm`'s loader is a one-way door (`CefInitialize` on a process that then
/// cannot un-initialise), and a version row must never be the thing that boots a browser engine.
/// `Bundle(path:)` on the embedded framework reads its `Info.plist` off disk and touches nothing
/// else — no `dlopen`, no CEF symbols, no helper processes.
///
/// `Contents/Frameworks/Chromium Embedded Framework.framework` is where the app's own loader looks
/// (`cef_scoped_library_loader_mac.mm`'s `kPathFromMainExe`, mirrored in `WinterCEF.mm`), so this
/// reads exactly the framework that would be loaded. Measured on a Release build: `151.3.16.0`.
///
/// nil is a real answer, not a failure: Debug app builds embed no runtimes at all.
func embeddedChromiumVersion(appBundleURL: URL = Bundle.main.bundleURL) -> String? {
    let framework = appBundleURL
        .appendingPathComponent("Contents/Frameworks", isDirectory: true)
        .appendingPathComponent("Chromium Embedded Framework.framework", isDirectory: true)
    guard let bundle = Bundle(path: framework.path) else { return nil }
    return bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
}

// MARK: - The table

/// The SDK rows, in a fixed order, as they read before the daemon answers. (WS-23: the "Claude agent
/// SDK" row went with the official runtime — nothing Winter ships runs on it any more.)
///
/// They are LISTED rather than omitted on purpose. Omitting them would make the panel quietly claim
/// Winter is made of two components; naming them with an honest "pending" says what is missing and
/// what will fill it. Feeding them later is one substitution — `DashboardWiring.sdkVersions`
/// returns `[InstalledComponent]` in exactly this shape, pins and all, and `installedComponents`
/// below swaps them in by name.
let pendingSdkComponents: [InstalledComponent] = [
    InstalledComponent(name: "Winter agent SDK", pendingReason: "waiting for the daemon"),
    InstalledComponent(name: "Winter runtime SDK", pendingReason: "waiting for the daemon"),
]

/// The SDK rows' wire keys, paired with the facing names `pendingSdkComponents` uses.
///
/// The pairing is the whole contract: `installedComponents` swaps a daemon row in BY NAME, so a
/// name that does not match a pending row's exactly would append nothing and silently leave the
/// row pending. Kept as one table so the two halves cannot drift.
let sdkComponentWireKeys: [(name: String, key: String)] = [
    ("Winter agent SDK", "winterAgentSdk"),
    ("Winter runtime SDK", "winterRuntimeSdk"),
]

/// PURE: `versions.get`'s answer → the SDK rows.
///
/// Both numbers ride along untouched: `pinned` is what this daemon build was compiled against,
/// `installed` is what actually resolved. A disagreement renders as "0.0.15 (pinned 0.0.16)" in a
/// quiet tone and NOTHING here treats it as a problem — the resolver has several rungs (an explicit
/// setting, an env override, a dev checkout, the npm package) and which one answered is exactly the
/// fact this table exists to show.
///
/// A row the daemon did not name in `installed` keeps its pin and renders "pinned X"; a row it
/// named in neither map says so rather than going blank. `winterExecutable` is deliberately NOT a
/// row: it carries a path and a resolver rung but no version (the `winter` binary has no version
/// flag at all), so it belongs to a different table than this one.
func sdkInstalledComponents(_ snapshot: VersionsSnapshot) -> [InstalledComponent] {
    sdkComponentWireKeys.map { name, key in
        InstalledComponent(name: name,
                           installed: snapshot.installed[key],
                           pinned: snapshot.pins[key],
                           pendingReason: "the daemon didn't report this one")
    }
}

/// PURE: assemble the table. `sdk` is whatever the daemon has told us so far (empty when the
/// daemon predates `versions.get`); anything it does not name keeps its pending row, in the fixed
/// order above, so a partial answer never reorders or drops a row.
func installedComponents(winter: String?, chromium: String?, sdk: [InstalledComponent]) -> [InstalledComponent] {
    let byName = Dictionary(sdk.map { ($0.name, $0) }, uniquingKeysWith: { _, last in last })
    var rows: [InstalledComponent] = [
        InstalledComponent(name: "Winter", installed: winter,
                           pendingReason: "no version in this bundle"),
        InstalledComponent(name: "Chromium", installed: chromium,
                           pendingReason: "not embedded in this build"),
    ]
    rows.append(contentsOf: pendingSdkComponents.map { byName[$0.name] ?? $0 })
    return rows
}
