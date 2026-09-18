import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Trust (2026-09-18). Settings-native, written in `SettingsChrome`'s vocabulary instead
// of mounting the Dashboard's `TrustPane`.
//
// The logic is the pane's, unchanged: `trust.list` to read, `trust.remove` (admin-gated
// server-side) per row, a re-list on success, and the pure `sortedTrustPaths` for the order — the
// last of those is imported, not copied, so the list order stays pinned by the one test that owns
// it. `TrustPane` is untouched; the Dashboard still renders it.
//
// A folder is a list, not a settings row — but it is a SHORT list of one-line items each with one
// verb, which is exactly a card row, so this one does fit the vocabulary (unlike Memory, Workflows
// and Providers; see `SettingsSurface.swift`'s `wired()` switch for why those stayed as they were).
//
// `trust.list` returns bare paths — no `trustedAt` — so there is deliberately no "added on" column
// to render.
// -----------------------------------------------------------------------------------------------

struct SettingsTrustSection: View {
    let list: () async throws -> [String]
    let remove: (String) async throws -> Bool

    @State private var paths: [String] = []
    @State private var errorText: String?
    @State private var loading = false
    @State private var revokingPath: String?

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.trust),
                     subtitle: settingsSectionSubtitle(.trust)) {
            SettingsButton("Refresh", isEnabled: !loading) { Task { await load() } }
        } content: {
            SettingsGroup("Trusted folders") {
                if let errorText {
                    SettingsNoteRow(errorText, isError: true)
                }
                if paths.isEmpty {
                    // Claim-free, like the pane's own line was: there is no `trust.add` or
                    // `trust.grant` on the wire (`trust.list`/`trust.remove` are the only two),
                    // so this surface must not describe a granting flow it cannot see.
                    SettingsNoteRow("No trusted folders.")
                } else {
                    ForEach(sortedTrustPaths(paths), id: \.self) { path in
                        folderRow(path)
                    }
                }
            }
        }
        .task { await load() }
    }

    /// The folder's NAME is the title and its full path is the line underneath: a column of
    /// absolute paths all sharing a `/Users/<name>/…` head is a column you cannot scan.
    @ViewBuilder
    private func folderRow(_ path: String) -> some View {
        SettingsRow(folderDisplayName(path)) {
            Text(path)
                .font(Typography.caption())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .help(path)
        } control: {
            // Every Revoke goes down while one is in flight — the list is about to be re-read and
            // a second revoke against the stale list would be acting on what is no longer shown.
            SettingsButton("Revoke", isDestructive: true, isEnabled: revokingPath == nil) {
                Task { await revoke(path) }
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            paths = try await list()
            errorText = nil
        } catch {
            errorText = "couldn't load trust list — try Refresh"
        }
    }

    private func revoke(_ path: String) async {
        revokingPath = path
        defer { revokingPath = nil }
        do {
            _ = try await remove(path)
            await load()
        } catch {
            errorText = "couldn't revoke \(path) — try again"
        }
    }
}

/// PURE: the folder's last path component, or the path itself when there is no useful last
/// component (`/`, or a trailing slash that would otherwise render as an empty title).
func folderDisplayName(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent
    return name.isEmpty || name == "/" ? path : name
}
