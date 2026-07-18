import AppKit
import NormaKit
import SwiftUI

/// SP2b Task 5: the Paired Devices window's approved content size — same "small utility panel,
/// not a main window" posture as `pairingSheetDefaultSize` (`PairingSheetWindow.swift`).
let pairedDevicesDefaultSize = CGSize(width: 420, height: 360)

/// `pairedDevicesDefaultSize` CENTERED in `visibleFrame`. PURE, same posture as
/// `centeredPairingSheetFrame`/`centeredDashboardFrame`.
func centeredPairedDevicesFrame(visibleFrame: CGRect) -> CGRect {
    let size = pairedDevicesDefaultSize
    return CGRect(
        x: visibleFrame.midX - size.width / 2,
        y: visibleFrame.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// A `Date`'s relative-to-now description ("2 minutes ago", "yesterday", ...) — pulled out as a
/// free function purely so it reads the same way `sortedTrustPaths` (`TrustPane.swift`) does: a
/// tiny pure helper next to the view that uses it.
func relativeLastSeen(epochSeconds: Int) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(epochSeconds))
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}

/// The Mac's Paired Devices window (SP2b Task 5) — lists `RemoteHost`'s allowlist (label,
/// relative last-seen, pairing epoch) with a per-row Revoke button behind a confirm alert. Dumb
/// view, same posture as `TrustPane`: `list`/`revoke` are injected closures
/// (`RemoteAccessCoordinator.pairedDevices()`/`revoke(phoneEndpointID:)`) — this view never
/// touches `RemoteHost` directly, and `revoke`'s failure is surfaced (never swallowed), per the
/// brief's own instruction that `RemoteHost.revoke` propagates store failures.
struct PairedDevicesView: View {
    let list: () async -> [PairRecord]
    let revoke: (String) async throws -> Void

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
                    .font(.system(size: 12))
                    .padding(.horizontal)
                    .padding(.bottom, 4)
            }
            if sortedRecords.isEmpty {
                Spacer()
                Text("No paired devices")
                    .font(.system(size: 12))
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
        .frame(width: pairedDevicesDefaultSize.width, height: pairedDevicesDefaultSize.height)
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
            Text("Paired Devices").font(.headline)
            Spacer()
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
                Text(record.label).font(.system(size: 13))
                Text("epoch \(record.pairingEpoch) · last seen \(relativeLastSeen(epochSeconds: record.lastSeenAt))")
                    .font(.system(size: 11))
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

/// Hosts `PairedDevicesView` in an `NSPanel` — same construction idiom as
/// `PairingSheetWindowController` (`PairingSheetWindow.swift`): delegate-driven one-shot
/// `onClosed`, `isReleasedWhenClosed = false`, this controller owns the window's whole lifetime.
@MainActor
final class PairedDevicesWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private var didClose = false

    var onClosed: ((PairedDevicesWindowController) -> Void)?
    var windowForTesting: NSWindow? { window }

    init(
        list: @escaping () async -> [PairRecord],
        revoke: @escaping (String) async throws -> Void,
        frame: NSRect
    ) {
        let window = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Paired Devices"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 320, height: 240)
        self.window = window
        super.init()
        window.delegate = self
        window.contentView = NSHostingView(rootView: PairedDevicesView(list: list, revoke: revoke))
        window.setFrame(frame, display: true)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        onClosed?(self)
    }
}
