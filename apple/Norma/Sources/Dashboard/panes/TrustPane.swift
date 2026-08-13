import SwiftUI

/// Alphabetical (case-insensitive-ish via plain `<`, matching Swift's default `String` ordering)
/// — pure so the list order is stable/testable independent of whatever order `trust.list` happens
/// to return paths in.
func sortedTrustPaths(_ paths: [String]) -> [String] {
    paths.sorted()
}

/// Task 5 (2f-ii): the Dashboard's Trust pane — lists trusted working directories (`trust.list`)
/// and revokes one (`trust.remove`, admin-gated server-side) via a per-row Revoke button,
/// refreshing the list on success. `list`/`remove` are the injected closures (`DashboardWiring`,
/// ultimately `NormaClient.trustList()`/`trustRemove(path:)`) — this pane never touches a
/// `NormaClient` directly, and (per spec) `trust.list` returns bare paths only, no `trustedAt` —
/// there is no per-row timestamp to render.
struct TrustPane: View {
    let list: () async throws -> [String]
    let remove: (String) async throws -> Bool

    @State private var paths: [String] = []
    @State private var errorText: String?
    @State private var loading = false
    @State private var revokingPath: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Trust").font(Typography.paneTitle)
                Spacer()
                Button("Refresh") { Task { await load() } }
                    .disabled(loading)
            }
            .padding([.top, .horizontal])
            .padding(.bottom, 4)
            if let errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label()).padding(.horizontal)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if paths.isEmpty {
                        Text("No trusted directories")
                            .font(Typography.label())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }
                    ForEach(sortedTrustPaths(paths), id: \.self) { path in
                        HStack {
                            Text(path)
                                .font(Typography.labelMono())
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer()
                            Button("Revoke") { Task { await revoke(path) } }
                                .disabled(revokingPath != nil)
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 4)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .task { await load() }
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
