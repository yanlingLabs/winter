import Combine
import SwiftUI
import WinterKit

// The Winter island's Devices tab (`docs/claude/island.md`): what Winter is connected to.
//
//   - PHONES: every paired phone (the app's pairing store, `RemoteAccessCoordinator.pairedDevices()`), connected or
//     not (the gateway's open connections, `connectedPhoneIDs()`), and when it was paired — the store never updates
//     its "last seen", so the tab does not claim one. The phone mirror: the sessions a phone watches now
//     (`RemoteMirrorHub.watchedSessionIds`).
//   - HELPERS: `computerUse.status` — the Computer Use helper (installed / running / its version, and its two
//     permissions, Accessibility and Screen Recording; unknown while it is not running), and every browser it can drive:
//     Winter's own browser (the app's browser link), Winter (headless), and each Chromium browser with Winter for
//     Chrome connected or not, with the daemon's own reason.

enum IslandDeviceTone: Equatable {
    case ok, warning, off
}

enum IslandPermissionState: Equatable {
    case granted, denied, unknown
}

struct IslandDeviceChip: Equatable, Identifiable {
    let label: String
    let state: IslandPermissionState
    var id: String { label }
}

struct IslandDeviceRow: Identifiable, Equatable {
    let id: String
    let symbol: String
    let title: String
    let detail: String
    let tone: IslandDeviceTone
    var chips: [IslandDeviceChip] = []
}

enum IslandDevicesPresentation {
    /// PURE: a store time (epoch seconds, or ms) → a date.
    static func date(_ stamp: Int) -> Date {
        Date(timeIntervalSince1970: stamp > 1_000_000_000_000 ? Double(stamp) / 1000 : Double(stamp))
    }

    /// PURE: the paired phones, connected first; the mirror as its own row while a phone watches.
    static func phones(_ records: [PairRecord], connected: Set<String>, mirrored: [String],
                       titleFor: (String) -> String?, now: Date) -> [IslandDeviceRow] {
        var rows: [IslandDeviceRow] = records
            .sorted { a, b in
                let ca = connected.contains(a.phoneEndpointID), cb = connected.contains(b.phoneEndpointID)
                return ca != cb ? ca : a.createdAt > b.createdAt
            }
            .map { r in
                let on = connected.contains(r.phoneEndpointID)
                let label = r.label.trimmingCharacters(in: .whitespacesAndNewlines)
                return IslandDeviceRow(id: "phone-\(r.phoneEndpointID)", symbol: "iphone", title: label.isEmpty ? "iPhone" : label,
                                       detail: "\(on ? "Connected" : "Not connected") · paired \(islandRelativePast(date(r.createdAt), now: now))",
                                       tone: on ? .ok : .off)
            }
        if !mirrored.isEmpty {
            let names = mirrored.map { titleFor($0) ?? "a session" }
            let what = names.count == 1 ? names[0] : "\(names.count) sessions"
            rows.append(IslandDeviceRow(id: "mirror", symbol: "rectangle.on.rectangle", title: "Phone mirror",
                                        detail: "Watching \(what)", tone: .ok))
        }
        return rows
    }

    /// PURE: the helper and the browsers (nil status: the daemon could not be asked).
    static func helpers(_ status: ComputerUseStatus?) -> [IslandDeviceRow] {
        guard let status else {
            return [IslandDeviceRow(id: "cu", symbol: "cursorarrow.rays", title: "Computer Use helper",
                                    detail: "Couldn't read its status", tone: .warning)]
        }
        var rows: [IslandDeviceRow] = []
        let helper = status.helper
        let tone: IslandDeviceTone
        if !status.enabled { tone = .off } else if helper.protocolMismatch != nil || !helper.installed { tone = .warning }
        else if let p = helper.permissions, !(p.accessibility && p.screenRecording) { tone = .warning }
        else { tone = helper.running ? .ok : .off }
        let detail = status.enabled ? computerUseHelperSummary(helper) : "Computer use is off"
        rows.append(IslandDeviceRow(id: "cu", symbol: "cursorarrow.rays", title: "Computer Use helper", detail: detail, tone: tone,
                                    chips: [chip("Accessibility", helper.permissions?.accessibility),
                                            chip("Screen Recording", helper.permissions?.screenRecording)]))
        for b in status.browsers ?? [] {
            let symbol: String
            let title: String
            switch b.id {
            case "winter": symbol = "safari"; title = b.name.isEmpty ? "Winter browser" : b.name
            case "headless": symbol = "eye.slash"; title = b.name.isEmpty ? "Winter (headless)" : b.name
            default: symbol = "puzzlepiece.extension"; title = "Winter for Chrome · \(b.name)"
            }
            let reason = b.reason.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
            rows.append(IslandDeviceRow(id: "browser-\(b.id)", symbol: symbol, title: title,
                                        detail: b.connected ? "Connected" : (reason ?? "Not connected"),
                                        tone: b.connected ? .ok : .off))
        }
        return rows
    }

    static func chip(_ label: String, _ granted: Bool?) -> IslandDeviceChip {
        IslandDeviceChip(label: label, state: granted.map { $0 ? .granted : .denied } ?? .unknown)
    }
}

/// The Devices tab's state.
@MainActor
final class IslandDevicesModel: ObservableObject {
    @Published private(set) var phones: [IslandDeviceRow] = []
    @Published private(set) var helpers: [IslandDeviceRow] = []
    @Published private(set) var loaded = false

    var fetchStatus: () async throws -> ComputerUseStatus? = { nil }
    var fetchPhones: () async -> [PairRecord] = { [] }
    var connectedPhones: () async -> Set<String> = { [] }
    var mirrored: () -> [String] = { [] }
    var titleFor: (String) -> String? = { _ in nil }
    var now: () -> Date = { Date() }

    func refresh() async {
        let status = try? await fetchStatus()
        let records = await fetchPhones()
        let connected = await connectedPhones()
        phones = IslandDevicesPresentation.phones(records, connected: connected, mirrored: mirrored(), titleFor: titleFor, now: now())
        helpers = IslandDevicesPresentation.helpers(status)
        loaded = true
    }

    /// Test seam.
    func setForTesting(phones: [IslandDeviceRow], helpers: [IslandDeviceRow]) {
        self.phones = phones
        self.helpers = helpers
        loaded = true
    }
}

// MARK: - The view

struct IslandDevicesTab: View {
    @ObservedObject var model: IslandDevicesModel

    var body: some View {
        if !model.loaded {
            IslandEmptyTab(symbol: "laptopcomputer.and.iphone", line: "Reading devices…")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                section("Phones")
                if model.phones.isEmpty {
                    IslandDeviceRowView(row: IslandDeviceRow(id: "none", symbol: "iphone.slash", title: "No phone paired",
                                                             detail: "Pair one from Winter's phone panel", tone: .off))
                } else {
                    ForEach(model.phones) { IslandDeviceRowView(row: $0) }
                }
                section("Helpers")
                ForEach(model.helpers) { IslandDeviceRowView(row: $0) }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
    }

    private func section(_ title: String) -> some View {
        Text(title.uppercased())
            .font(Typography.tiny(.semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 6)
            .padding(.top, 4)
    }
}

struct IslandDeviceRowView: View {
    let row: IslandDeviceRow

    var body: some View {
        IslandHoverSurface { _ in
            HStack(spacing: 10) {
                Image(systemName: row.symbol)
                    .font(Typography.label(.semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title).font(Typography.label(.medium)).foregroundStyle(Color.white).lineLimit(1)
                    Text(row.detail).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    if !row.chips.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(row.chips) { IslandPermissionChip(chip: $0) }
                        }
                        .padding(.top, 2)
                    }
                }
                Spacer(minLength: 6)
                Circle()
                    .fill(islandToneColor(row.tone))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
        .accessibilityElement(children: .combine)
    }
}

struct IslandPermissionChip: View {
    let chip: IslandDeviceChip

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: chip.state == .granted ? "checkmark" : chip.state == .denied ? "xmark" : "questionmark")
                .font(Typography.micro(.bold))
            Text(chip.label).font(Typography.tiny(.medium))
        }
        .foregroundStyle(chip.state == .denied ? Color.black : Color.white)
        .padding(.horizontal, 7)
        .frame(height: 18)
        .background(Capsule().fill(chip.state == .denied ? pillReviewAmber : Color.white.opacity(chip.state == .granted ? 0.16 : 0.08)))
        .accessibilityLabel("\(chip.label): \(chip.state == .granted ? "granted" : chip.state == .denied ? "not granted" : "unknown")")
    }
}

func islandToneColor(_ tone: IslandDeviceTone) -> Color {
    switch tone {
    case .ok: return Color(nsColor: .systemGreen)
    case .warning: return pillReviewAmber
    case .off: return Color.white.opacity(0.25)
    }
}
