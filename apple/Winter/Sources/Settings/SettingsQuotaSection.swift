import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings → Quota (2026-09-18). Settings-native, written in `SettingsChrome`'s vocabulary instead
// of mounting the Dashboard's `QuotaPane`.
//
// Read-only, static fetch + Refresh, no polling loop — the pane's own v1 posture. Both display
// strings come from the pure, table-tested `formatQuotaState`
// (`Dashboard/panes/QuotaPane.swift`), including its deliberate fail-safe ("any unrecognised kind
// reads as OK — never alarm the user over a string we do not know"). Nothing is formatted here.
// `QuotaPane` is untouched; the Dashboard still renders it.
// -----------------------------------------------------------------------------------------------

struct SettingsQuotaSection: View {
    let fetch: () async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int)

    @State private var display: QuotaDisplay?
    @State private var errorText: String?
    @State private var loading = false

    var body: some View {
        SettingsPage(title: settingsSectionTitle(.quota),
                     subtitle: settingsSectionSubtitle(.quota)) {
            SettingsButton("Refresh", isEnabled: !loading) { Task { await load() } }
        } content: {
            SettingsGroup {
                if let display {
                    SettingsValueRow(title: "Status",
                                     description: "Whether the provider is currently serving turns.",
                                     value: display.statusLine,
                                     monospaced: false)
                    // "Tokens", not "Used this window": `quota.state` returns two counters and a
                    // kind, and names no window. A title that implied one would be this surface
                    // inventing a fact the wire never sent.
                    SettingsValueRow(title: "Tokens",
                                     description: "Sent and received on the current provider.",
                                     value: display.tokensLine)
                } else if let errorText {
                    SettingsNoteRow(errorText, isError: true)
                } else {
                    SettingsNoteRow("Loading…")
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
            display = formatQuotaState(
                kind: r.kind, resumeAt: r.resumeAt,
                inputTokens: r.inputTokens, outputTokens: r.outputTokens,
                nowMs: Int(Date().timeIntervalSince1970 * 1000)
            )
            errorText = nil
        } catch {
            errorText = "couldn't load quota — try Refresh"
        }
    }
}
