import SwiftUI

/// One fetch's worth of `daemon.status` rendered as display strings — pure so the formatting
/// (uptime especially — spec's own hint to reuse `formatElapsed`) is table-tested without a live
/// `NormaClient`.
struct DaemonStatusDisplay: Equatable {
    let version: String
    let uptime: String
    let socketPath: String
    let provider: String
    let sessionsCount: String
    let pluginsCount: String
}

/// `providerId`/`providerModel` → "none" (no provider currently advertised), the bare id (a
/// provider connected but never advertised classes — shouldn't happen in practice, but the daemon
/// contract doesn't guarantee `model` is always paired), or `"id (model)"`.
func formatDaemonStatus(version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int) -> DaemonStatusDisplay {
    let provider: String
    switch (providerId, providerModel) {
    case let (.some(id), .some(model)):
        provider = "\(id) (\(model))"
    case let (.some(id), nil):
        provider = id
    default:
        provider = "none"
    }
    return DaemonStatusDisplay(
        version: version,
        uptime: formatElapsed(uptimeMs),
        socketPath: socketPath,
        provider: provider,
        sessionsCount: String(sessionsCount),
        pluginsCount: String(pluginsCount)
    )
}

/// Task 5 (2f-ii): the Dashboard's Daemon-status pane — spec §B: "static fetch + refresh button in
/// v1 (no polling loop)". `fetch` is the injected `daemon.status` closure (`DashboardWiring`,
/// ultimately `NormaClient.daemonStatus()`), never a `NormaClient` directly.
struct DaemonStatusPane: View {
    let fetch: () async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int)

    @State private var display: DaemonStatusDisplay?
    @State private var errorText: String?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Daemon Status").font(Typography.paneTitle)
                Spacer()
                Button("Refresh") { Task { await load() } }
                    .disabled(loading)
            }
            if let display {
                VStack(alignment: .leading, spacing: 6) {
                    row("Version", display.version)
                    row("Uptime", display.uptime)
                    row("Socket", display.socketPath)
                    row("Provider", display.provider)
                    row("Sessions", display.sessionsCount)
                    row("Plugins", display.pluginsCount)
                }
            } else if let errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label())
            } else {
                Text("Loading…").foregroundStyle(.secondary).font(Typography.label())
            }
            Spacer()
        }
        .padding()
        .task { await load() }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
        }
        .font(Typography.labelMono())
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
