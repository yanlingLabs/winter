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

    // MARK: The quiet row (the island's visual language)

    /// PURE: a row's line — full in its tone's colour when connected (green) or needing attention (amber), the grey
    /// track alone when off. Nothing is estimated: no phone or helper reports a level, so the line is all or nothing.
    static func lineFraction(_ tone: IslandDeviceTone) -> Double { tone == .off ? 0 : 1 }

    /// PURE: a permission as words inside its half of the helper's line — "✓ Accessibility", "✕ Screen Recording",
    /// "? Accessibility" (unknown while the helper is not running).
    static func chipWords(_ chip: IslandDeviceChip) -> String {
        switch chip.state {
        case .granted: return "✓ \(chip.label)"
        case .denied: return "✕ \(chip.label)"
        case .unknown: return "? \(chip.label)"
        }
    }

    /// PURE: a permission's half of the line — granted green, not granted amber, unknown grey.
    static func chipColor(_ state: IslandPermissionState) -> Color {
        switch state {
        case .granted: return islandToneColor(.ok)
        case .denied: return pillReviewAmber
        case .unknown: return Color.white.opacity(0.16)
        }
    }

    /// PURE: a permission as VoiceOver says it — "Accessibility: granted".
    static func chipAccessibility(_ chip: IslandDeviceChip) -> String {
        "\(chip.label): \(chip.state == .granted ? "granted" : chip.state == .denied ? "not granted" : "unknown")"
    }

    /// PURE: a row as VoiceOver says it — its title, its detail and its permissions (what the row showed as text and
    /// chips, now partly only under the pointer).
    static func accessibilityLabel(_ row: IslandDeviceRow) -> String {
        ([row.title, row.detail] + row.chips.map(chipAccessibility)).joined(separator: ", ")
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
            VStack(alignment: .leading, spacing: IslandDeviceRowView.gap) {
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
            .padding(.horizontal, IslandQuietRow.inset)
            .padding(.bottom, 14)
        }
    }

    private func section(_ title: String) -> some View {
        Text(title.uppercased())
            .font(Typography.tiny(.semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textMuted)
            .padding(.top, 2)
    }
}

/// A phone or a helper as a quiet row (the island's visual language): its symbol and name over a line — green while
/// connected, amber while it needs something, the grey track alone while off; the Computer Use helper's line is its
/// two permissions side by side (granted green, not granted amber, unknown grey). Under the pointer the name lifts and
/// the line says its detail — or each permission — inside itself; the helper's detail shows beside its name.
struct IslandDeviceRowView: View {
    let row: IslandDeviceRow

    static let gap: CGFloat = 8

    var body: some View {
        HoverLiftReader(id: "device:\(row.id)") { hovered in
            VStack(alignment: .leading, spacing: IslandQuietRow.lineGap) {
                HStack(spacing: 8) {
                    Image(systemName: row.symbol)
                        .font(Typography.caption(.semibold))
                        .foregroundStyle(Color.white.opacity(hovered ? 1 : 0.7))
                        .frame(width: IslandQuietRow.markWidth)
                    Text(row.title)
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white.opacity(hovered ? 1 : 0.9))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .hoverLiftLabel(hovered)
                        .padding(.trailing, hovered ? 18 : 0)
                        .layoutPriority(1)
                    Spacer(minLength: 8)
                    if !row.chips.isEmpty, hovered {
                        // The helper's line is its permissions: its own words go beside its name.
                        Text(row.detail)
                            .font(Typography.tiny())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .transition(.opacity)
                    }
                }
                .frame(height: IslandQuietRow.titleHeight)
                Group {
                    if row.chips.isEmpty {
                        HoverLine(fraction: IslandDevicesPresentation.lineFraction(row.tone), color: islandToneColor(row.tone),
                                  hovered: hovered, words: HoverLineWords(start: row.detail),
                                  inkOnFill: row.tone == .warning ? .black : .white)
                    } else {
                        HoverSegmentLine(segments: row.chips.map { chip in
                            HoverSegment(id: chip.id, fraction: 1 / Double(row.chips.count),
                                         color: IslandDevicesPresentation.chipColor(chip.state),
                                         label: IslandDevicesPresentation.chipWords(chip),
                                         ink: chip.state == .denied ? .black : .white)
                        }, hovered: hovered)
                    }
                }
                .padding(.leading, IslandQuietRow.markWidth + 8)
            }
            .contentShape(Rectangle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IslandDevicesPresentation.accessibilityLabel(row))
    }
}

func islandToneColor(_ tone: IslandDeviceTone) -> Color {
    switch tone {
    case .ok: return Color(nsColor: .systemGreen)
    case .warning: return pillReviewAmber
    case .off: return Color.white.opacity(0.25)
    }
}
