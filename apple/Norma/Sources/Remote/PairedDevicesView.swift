import NormaKit
import SwiftUI

/// A `Date`'s relative-to-now description ("2 minutes ago", "yesterday", ...) — pulled out as a
/// free function purely so it reads the same way `sortedTrustPaths` (`TrustPane.swift`) does: a
/// tiny pure helper next to the view that uses it.
func relativeLastSeen(epochSeconds: Int) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(epochSeconds))
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

/// Task 7 (spec §4 — "Remote windows (PairedDevices) → becomes a pane, Devices group"): the
/// Dashboard's Devices pane. Lists `RemoteHost`'s allowlist (label, relative last-seen, pairing
/// epoch) with a per-row Revoke button behind a confirm alert, exactly as `PairedDevicesWindowController`
/// (deleted this task) used to — `list`/`revoke` are still injected closures
/// (`RemoteAccessCoordinator.pairedDevices()`/`revoke(phoneEndpointID:)`), this view still never
/// touches `RemoteHost` directly, and `revoke`'s failure is still surfaced (never swallowed).
///
/// `onPairDevice` is NEW (Task 7): the Devices group's own door to the pairing ceremony — the menu
/// bar's "Pair a Device…" item used to be the ONLY way in; this pane offers the same action
/// (`AppDelegate.openPairDevice()`, which now presents `PairingSheetView` as a SHEET on the shell —
/// spec §1 windows disposition — instead of spawning `PairingSheetWindowController`, also deleted).
struct PairedDevicesView: View {
    let list: () async -> [PairRecord]
    let revoke: (String) async throws -> Void
    let onPairDevice: () -> Void

    @State private var records: [PairRecord] = []
    @State private var errorText: String?
    @State private var loading = false
    @State private var revokingPeer: String?
    /// The record pending a confirmed revoke — set when "Revoke" is tapped, `nil` once the alert
    /// resolves either way. A local capture (not read back through some later selection state),
    /// same posture as `SkillsPane.confirmingDeleteName`.
    @State private var confirmingRevoke: PairRecord?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText {
                Text(errorText)
                    .foregroundStyle(.red)
                    .font(Typography.label())
                    .padding(.horizontal)
                    .padding(.bottom, 4)
            }
            if sortedRecords.isEmpty {
                Spacer()
                Text("No paired devices")
                    .font(Typography.label())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                List {
                    ForEach(sortedRecords, id: \.phoneEndpointID) { record in
                        row(for: record)
                    }
                }
                .listStyle(.inset)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await load() }
        .alert(
            "Revoke \(confirmingRevoke?.label ?? "")?",
            isPresented: Binding(
                get: { confirmingRevoke != nil },
                set: { if !$0 { confirmingRevoke = nil } }
            )
        ) {
            Button("Revoke", role: .destructive) {
                if let record = confirmingRevoke { Task { await performRevoke(record.phoneEndpointID) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This device loses remote access to this Mac immediately.")
        }
    }

    private var header: some View {
        HStack {
            Text("Paired Devices").font(Typography.paneTitle)
            Spacer()
            Button("Pair a Device…") { onPairDevice() }
            Button("Refresh") { Task { await load() } }
                .disabled(loading)
        }
        .padding()
    }

    private var sortedRecords: [PairRecord] {
        records.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private func row(for record: PairRecord) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(record.label).font(Typography.control())
                Text("epoch \(record.pairingEpoch) · last seen \(relativeLastSeen(epochSeconds: record.lastSeenAt))")
                    .font(Typography.caption())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Revoke") { confirmingRevoke = record }
                .disabled(revokingPeer != nil)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        records = await list()
    }

    private func performRevoke(_ peer: String) async {
        revokingPeer = peer
        defer { revokingPeer = nil }
        do {
            try await revoke(peer)
            errorText = nil
            await load()
        } catch {
            errorText = "couldn't revoke — try again"
        }
    }
}
