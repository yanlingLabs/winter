import AppKit
import Foundation
import WinterKit

// -----------------------------------------------------------------------------------------------
// Settings → Computer Use → Apps: the installed apps the page can name.
//
// The page lists EXCEPTIONS (`computerUse.apps.list`), not every app on the Mac. Installed apps matter
// in two places: an exception row's icon (its bundle id resolves to an app on disk, or does not and the
// row is dimmed), and the "Add exception…" sheet, which lists what is installed to pick from. This file
// holds that seam (a protocol, so a test never scans the disk or asks LaunchServices), the real
// implementation, and the sheet's pure list.
// -----------------------------------------------------------------------------------------------

/// One app found on disk.
struct InstalledApp: Equatable, Sendable {
    let bundleId: String
    let name: String
    /// The `.app` bundle's path, which is what the icon is read from.
    let path: String
}

/// The seam the model reads installed apps through, so a test never scans the disk. Both calls are
/// synchronous and blocking by design: the model makes them off the main thread.
protocol InstalledAppEnumerating: Sendable {
    /// Every installed app, scanned once per page for the add sheet.
    func installedApps() -> [InstalledApp]
    /// The `.app` path a bundle id resolves to, or nil when no installed app has it — an exception row
    /// whose app is not on this Mac.
    func appPath(forBundleId bundleId: String) -> String?
}

/// Bundle ids Winter never controls (its own app and its helper, refused by the floors), so the list does
/// not offer a setting that could never do anything.
let computerUseUnlistedBundleIds: Set<String> = [
    "com.winter.app", "com.winter.app.dev", "com.winter.computeruse", "com.winter.computeruse.dev",
]

/// The real enumerator: `.app` bundles in `/Applications`, `/System/Applications` and `~/Applications`,
/// plus one level of subfolders in each (`Utilities`). Deeper bundles are not looked for, and a bundle
/// inside an `.app` is never entered. An app with no `CFBundleIdentifier` is skipped (it could not be
/// named to the daemon); the same id found twice keeps the first, in root order.
struct FileInstalledAppEnumerator: InstalledAppEnumerating {
    let roots: [URL]

    init(roots: [URL] = FileInstalledAppEnumerator.defaultRoots) {
        self.roots = roots
    }

    static var defaultRoots: [URL] {
        [URL(fileURLWithPath: "/Applications", isDirectory: true),
         URL(fileURLWithPath: "/System/Applications", isDirectory: true),
         FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)]
    }

    /// LaunchServices' answer (`NSWorkspace.urlForApplication(withBundleIdentifier:)`), so an app
    /// installed anywhere — not only under the scanned roots — still gets its icon.
    func appPath(forBundleId bundleId: String) -> String? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)?.path
    }

    func installedApps() -> [InstalledApp] {
        var seen: Set<String> = []
        var found: [InstalledApp] = []
        for root in roots {
            for entry in children(of: root) {
                if entry.pathExtension == "app" {
                    append(entry, to: &found, seen: &seen)
                } else if isPlainDirectory(entry) {
                    for nested in children(of: entry) where nested.pathExtension == "app" {
                        append(nested, to: &found, seen: &seen)
                    }
                }
            }
        }
        return found
    }

    private func append(_ bundleURL: URL, to found: inout [InstalledApp], seen: inout Set<String>) {
        guard let bundle = Bundle(url: bundleURL), let id = bundle.bundleIdentifier, !id.isEmpty,
              !computerUseUnlistedBundleIds.contains(id), seen.insert(id).inserted else { return }
        found.append(InstalledApp(bundleId: id, name: Self.displayName(of: bundle, at: bundleURL), path: bundleURL.path))
    }

    /// `CFBundleDisplayName`, else `CFBundleName`, else the file name without `.app`.
    static func displayName(of bundle: Bundle, at url: URL) -> String {
        for key in ["CFBundleDisplayName", "CFBundleName"] {
            if let name = bundle.object(forInfoDictionaryKey: key) as? String {
                let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return url.deletingPathExtension().lastPathComponent
    }

    private func children(of directory: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
            options: [.skipsHiddenFiles])) ?? []
    }

    /// A folder that is not itself a package: `Utilities` is, `Foo.app` and `Foo.pkg` are not.
    private func isPlainDirectory(_ url: URL) -> Bool {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        return values?.isDirectory == true && values?.isPackage != true
    }
}

/// PURE: the apps the add sheet offers — installed apps that are not already exceptions, whose name or
/// bundle id contains `query` (case- and diacritic-insensitive; blank keeps all), sorted by name with
/// ties broken by bundle id.
func computerUseAddableApps(installed: [InstalledApp], exceptionIds: Set<String>, query: String) -> [InstalledApp] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    var seen: Set<String> = []
    return installed
        .filter { !exceptionIds.contains($0.bundleId) && seen.insert($0.bundleId).inserted }
        .filter {
            trimmed.isEmpty || $0.name.range(of: trimmed, options: options) != nil
                || $0.bundleId.range(of: trimmed, options: options) != nil
        }
        .sorted { lhs, rhs in
            let order = lhs.name.compare(rhs.name, options: options, locale: .current)
            return order == .orderedSame ? lhs.bundleId < rhs.bundleId : order == .orderedAscending
        }
}

/// PURE: the same order for the list of exceptions and of always-allowed apps.
func computerUseSortedByName(_ apps: [ComputerUseApp]) -> [ComputerUseApp] {
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    return apps.sorted { lhs, rhs in
        let order = lhs.name.compare(rhs.name, options: options, locale: .current)
        return order == .orderedSame ? lhs.bundleId < rhs.bundleId : order == .orderedAscending
    }
}
