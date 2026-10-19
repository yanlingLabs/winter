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
    /// Its state in a word or two, beside its status dot ("Connected", "Running · 1.4.0"; empty: no status).
    var status: String = ""
    /// What the pointer reveals under the title ("Paired 9 d ago", a browser's reason); empty: nothing more to say.
    var detail: String = ""
    let tone: IslandDeviceTone
    var chips: [IslandDeviceChip] = []
    /// The detail is worth scanning at rest too (a status that could not be read, how to pair a phone).
    var detailAtRest = false
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
                                       status: on ? "Connected" : "Not connected",
                                       detail: "Paired \(islandRelativePast(date(r.createdAt), now: now))",
                                       tone: on ? .ok : .off)
            }
        if !mirrored.isEmpty {
            let names = mirrored.map { titleFor($0) ?? "a session" }
            let what = names.count == 1 ? names[0] : "\(names.count) sessions"
            rows.append(IslandDeviceRow(id: "mirror", symbol: "rectangle.on.rectangle", title: "Phone mirror",
                                        status: "Watching", detail: what, tone: .ok))
        }
        return rows
    }

    /// PURE: the helper and the browsers (nil status: the daemon could not be asked).
    static func helpers(_ status: ComputerUseStatus?) -> [IslandDeviceRow] {
        guard let status else {
            return [IslandDeviceRow(id: "cu", symbol: "cursorarrow.rays", title: "Computer Use helper", status: "Unknown",
                                    detail: "Couldn't read its status", tone: .warning, detailAtRest: true)]
        }
        var rows: [IslandDeviceRow] = []
        let helper = status.helper
        let tone: IslandDeviceTone
        if !status.enabled { tone = .off } else if helper.protocolMismatch != nil || !helper.installed { tone = .warning }
        else if let p = helper.permissions, !(p.accessibility && p.screenRecording) { tone = .warning }
        else { tone = helper.running ? .ok : .off }
        rows.append(IslandDeviceRow(id: "cu", symbol: "cursorarrow.rays", title: "Computer Use helper",
                                    status: helperStatus(status), detail: helperDetail(status), tone: tone,
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
                                        status: b.connected ? "Connected" : "Not connected",
                                        detail: b.connected ? "" : (reason ?? ""),
                                        tone: b.connected ? .ok : .off))
        }
        return rows
    }

    /// PURE: the helper's state in a word or two — "Running · 1.4.0", "Not running", "Not installed", "Needs an update",
    /// "Off".
    static func helperStatus(_ status: ComputerUseStatus) -> String {
        let helper = status.helper
        if !status.enabled { return "Off" }
        if helper.protocolMismatch != nil { return "Needs an update" }
        if !helper.installed { return "Not installed" }
        if !helper.running { return "Not running" }
        if let version = helper.version, !version.isEmpty { return "Running · \(version)" }
        return "Running"
    }

    /// PURE: what the helper's row reveals beyond its status — Settings' own words ("Installed — starts when a session
    /// needs it", an incompatibility's message, "Computer use is off"); nothing while it runs (the status says it all).
    static func helperDetail(_ status: ComputerUseStatus) -> String {
        guard status.enabled else { return "Computer use is off" }
        let helper = status.helper
        if helper.protocolMismatch == nil, helper.installed, helper.running { return "" }
        let summary = computerUseHelperSummary(helper)
        return summary == helperStatus(status) ? "" : summary
    }

    static func chip(_ label: String, _ granted: Bool?) -> IslandDeviceChip {
        IslandDeviceChip(label: label, state: granted.map { $0 ? .granted : .denied } ?? .unknown)
    }

    // MARK: The row (the island's visual language: a glyph, a name, a status dot and its word)

    /// PURE: the status dot — green while connected or running, amber while it needs something, hollow grey while off.
    static func mark(_ tone: IslandDeviceTone) -> IslandStatusMark {
        switch tone {
        case .ok: return .dot(Color(nsColor: .systemGreen))
        case .warning: return .dot(pillReviewAmber)
        case .off: return .ring(Color.white.opacity(0.35))
        }
    }

    /// PURE: a permission as a small labelled mark — ✓ granted (quiet), ✕ missing (amber: it needs you), ? unknown while
    /// the helper is not running (quiet).
    static func permissionMark(_ chip: IslandDeviceChip) -> (symbol: String, color: Color) {
        switch chip.state {
        case .granted: return ("checkmark", Theme.textMuted)
        case .denied: return ("xmark", pillReviewAmber)
        case .unknown: return ("questionmark", Theme.textMuted)
        }
    }

    /// PURE: whether the line under the name shows its detail — under the pointer, or at rest when it is worth scanning.
    static func showsDetail(_ row: IslandDeviceRow, hovered: Bool) -> Bool {
        !row.detail.isEmpty && (hovered || row.detailAtRest)
    }

    /// PURE: a permission as VoiceOver says it — "Accessibility: granted".
    static func chipAccessibility(_ chip: IslandDeviceChip) -> String {
        "\(chip.label): \(chip.state == .granted ? "granted" : chip.state == .denied ? "not granted" : "unknown")"
    }

    /// PURE: a row as VoiceOver says it, at rest — its title, its status, its detail and its permissions.
    static func accessibilityLabel(_ row: IslandDeviceRow) -> String {
        ([row.title, row.status, row.detail].filter { !$0.isEmpty } + row.chips.map(chipAccessibility)).joined(separator: ", ")
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
            VStack(alignment: .leading, spacing: IslandQuietRow.rowGap) {
                IslandGroupTitle(title: "Phones")
                if model.phones.isEmpty {
                    IslandDeviceRowView(row: IslandDeviceRow(id: "none", symbol: "iphone.slash", title: "No phone paired",
                                                             detail: "Pair one from Winter's phone panel", tone: .off,
                                                             detailAtRest: true))
                } else {
                    ForEach(model.phones) { IslandDeviceRowView(row: $0) }
                }
                IslandGroupTitle(title: "Helpers")
                    .padding(.top, 6)
                ForEach(model.helpers) { IslandDeviceRowView(row: $0) }
            }
            .padding(.horizontal, IslandQuietRow.inset)
            .padding(.bottom, 14)
        }
    }

}


/// A phone or a helper as a row in the island's language: its glyph and name, and its state as a small dot and a word
/// ("● Connected", "● Running · 1.4.0") — the Computer Use helper's two permissions as small labelled marks under it
/// (✓ Accessibility, ✕ Screen Recording in amber when missing). Under the pointer the name lifts and the detail shows
/// (when it was paired, why a browser is not connected). No line: nothing here is an amount.
struct IslandDeviceRowView: View {
    let row: IslandDeviceRow

    var body: some View {
        HoverLiftReader(id: "device:\(row.id)") { hovered in
            IslandLiftRow(title: row.title, hovered: hovered) {
                Image(systemName: row.symbol)
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(Color.white.opacity(hovered ? 0.95 : 0.7))
            } trailing: {
                if !row.status.isEmpty {
                    IslandStatusWord(mark: IslandDevicesPresentation.mark(row.tone), word: row.status)
                }
            } below: {
                if !row.chips.isEmpty {
                    IslandPermissionMarks(chips: row.chips)
                }
                if IslandDevicesPresentation.showsDetail(row, hovered: hovered) {
                    IslandRowWords(text: row.detail, lines: 2)
                        .transition(.opacity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IslandDevicesPresentation.accessibilityLabel(row))
    }
}

/// The helper's permissions as small labelled marks — "✓ Accessibility   ✕ Screen Recording".
struct IslandPermissionMarks: View {
    let chips: [IslandDeviceChip]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(chips) { chip in
                let mark = IslandDevicesPresentation.permissionMark(chip)
                HStack(spacing: 4) {
                    Image(systemName: mark.symbol).font(Typography.micro(.bold))
                    Text(chip.label).font(IslandQuietRow.wordsFont)
                }
                .foregroundStyle(mark.color)
                .lineLimit(1)
            }
        }
        .frame(minHeight: 16)
    }
}
