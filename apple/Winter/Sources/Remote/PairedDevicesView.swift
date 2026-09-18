import WinterKit
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
                            // Row backgrounds off too, or each row repaints the plane the list no
                            // longer does and the rows come back as opaque stripes.
                            .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.inset)
                // A `List` paints its own OPAQUE background, which is why the devices panel was
                // glass at the header and solid below it (user report, 2026-09-18). Hidden, the list
                // sits on whatever the host gives it — the panel's material here, the card surface
                // in the Dashboard — instead of on a plane of its own.
                .scrollContentBackground(.hidden)
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

    /// Room for the floating panel's close button when this pane is hosted in one; zero in the
    /// Dashboard, where nothing sits in that corner.
    @Environment(\.shellPanelCloseGutter) private var closeGutter

    private var header: some View {
        HStack {
            Text("Paired Devices").font(Typography.paneTitle)
            Spacer()
            // PLAIN, not filled (user call, 2026-09-18): two filled capsules in the corner of a
            // translucent panel read as the loudest thing on it, louder than the devices the pane
            // is about. Text buttons in the accent, the register the rest of the app's inline
            // actions already use.
            Button("Pair a Device…") { onPairDevice() }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accent)
            Button("Refresh") { Task { await load() } }
                .buttonStyle(.plain)
                .foregroundStyle(loading ? Theme.textMuted : Theme.accent)
                .disabled(loading)
        }
        // In a floating panel: the shared header line (`shellPanelHeaderHeight`, 18 pt in), level
        // with the close glyph. In the Dashboard (no gutter): the pane's own padding, unchanged.
        .padding(.horizontal, closeGutter > 0 ? shellPanelEdgeInset : 16)
        .padding(.vertical, closeGutter > 0 ? 0 : 16)
        .frame(height: closeGutter > 0 ? shellPanelHeaderHeight : nil)
        .padding(.trailing, closeGutter)
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
            // A trash glyph, not the word (user call). The confirm alert still spells out what
            // revoking does, so the row does not have to carry the sentence — and a row of
            // repeated "Revoke" buttons made the list read as a list of buttons.
            Button {
                confirmingRevoke = record
            } label: {
                Image(systemName: "trash")
                    .font(Typography.control())
                    .frame(width: shellTitlebarButtonSize, height: shellTitlebarButtonSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(ShellChromeButtonStyle())
            .foregroundStyle(Theme.textMuted)
            .help("Revoke \(record.label)")
            .accessibilityLabel("Revoke \(record.label)")
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
