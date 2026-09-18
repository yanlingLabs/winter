import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Daemon Status (2026-09-18). Settings-native, written in `SettingsChrome`'s vocabulary
// instead of mounting the Dashboard's `DaemonStatusPane`.
//
// Read-only by construction, and the shape of the read is unchanged: the injected `daemon.status`
// closure, fetched once on open with a Refresh button and NO polling loop (the pane's own v1
// posture, kept deliberately — a settings page that re-reads the daemon on a timer is a page that
// is never quiet). The six display strings come from `formatDaemonStatus`
// (`Dashboard/panes/DaemonStatusPane.swift`), which is pure and table-tested; this file formats
// nothing itself. `DaemonStatusPane` is untouched; the Dashboard still renders it.
// -----------------------------------------------------------------------------------------------

struct SettingsDaemonStatusSection: View {
    let fetch: () async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int)

    @State private var display: DaemonStatusDisplay?
    @State private var errorText: String?
    @State private var loading = false

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.daemonStatus),
                     subtitle: settingsSectionSubtitle(.daemonStatus)) {
            SettingsButton("Refresh", isEnabled: !loading) { Task { await load() } }
        } content: {
            SettingsGroup("Connection") {
                if let display {
                    SettingsValueRow(title: "Version", value: display.version)
                    SettingsValueRow(title: "Uptime", value: display.uptime)
                    // A socket path is long and its two ends are the informative halves; the full
                    // string stays available as a tooltip and by selection.
                    SettingsValueRow(title: "Socket", value: display.socketPath, middleTruncated: true)
                    SettingsValueRow(title: "Provider", value: display.provider)
                } else if let errorText {
                    SettingsNoteRow(errorText, isError: true)
                } else {
                    SettingsNoteRow("Loading…")
                }
            }
            if let display {
                SettingsGroup("What it is holding") {
                    SettingsValueRow(title: "Sessions", value: display.sessionsCount)
                    SettingsValueRow(title: "Plugins", value: display.pluginsCount)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let r = try await fetch()
            display = formatDaemonStatus(
                version: r.version, uptimeMs: r.uptimeMs, socketPath: r.socketPath,
                providerId: r.providerId, providerModel: r.providerModel,
                sessionsCount: r.sessionsCount, pluginsCount: r.pluginsCount
            )
            errorText = nil
        } catch {
            errorText = "couldn't load daemon status — try Refresh"
        }
    }
}
