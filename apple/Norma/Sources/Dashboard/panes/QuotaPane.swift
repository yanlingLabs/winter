import SwiftUI

/// One fetch's worth of `quota.state` rendered as display strings — pure so the "limited, resumes
/// in Xs" wording (reusing `formatElapsed`) and the token totals (reusing `formatTokens`) are
/// table-tested without a live `NormaClient`.
struct QuotaDisplay: Equatable {
    let statusLine: String
    let tokensLine: String
}

/// `kind == "limited"` with a still-future `resumeAt` → "Limited — resumes in <elapsed>"; a
/// past/equal `resumeAt` (clock skew, or the daemon hasn't flipped `kind` back to "ok" yet) or a
/// missing `resumeAt` → the bare "Limited". Anything else (including any unrecognized kind) reads
/// as "OK" — fails safe toward NOT alarming the user over an unknown kind string.
func formatQuotaState(kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int, nowMs: Int) -> QuotaDisplay {
    let statusLine: String
    if kind == "limited" {
        if let resumeAt, resumeAt > nowMs {
            statusLine = "Limited — resumes in \(formatElapsed(resumeAt - nowMs))"
        } else {
            statusLine = "Limited"
        }
    } else {
        statusLine = "OK"
    }
    let tokensLine = "↑ \(formatTokens(inputTokens)) ↓ \(formatTokens(outputTokens)) tokens"
    return QuotaDisplay(statusLine: statusLine, tokensLine: tokensLine)
}

/// Task 5 (2f-ii): the Dashboard's Quota pane — spec §B: "static fetch + refresh button in v1".
/// `fetch` is the injected `quota.state` closure (`DashboardWiring`, ultimately
/// `NormaClient.quotaState()`).
struct QuotaPane: View {
    let fetch: () async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int)

    @State private var display: QuotaDisplay?
    @State private var errorText: String?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Quota").font(Typography.paneTitle)
                Spacer()
                Button("Refresh") { Task { await load() } }
                    .disabled(loading)
            }
            if let display {
                Text(display.statusLine).font(Typography.control(.medium))
                Text(display.tokensLine)
                    .font(Typography.labelMono())
                    .foregroundStyle(.secondary)
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

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let r = try await fetch()
            display = formatQuotaState(
                kind: r.kind, resumeAt: r.resumeAt, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
                nowMs: Int(Date().timeIntervalSince1970 * 1000)
            )
            errorText = nil
        } catch {
            errorText = "couldn't load quota — try Refresh"
        }
    }
}
