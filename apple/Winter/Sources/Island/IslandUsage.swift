import Combine
import SwiftUI
import WinterKit

// The Winter island's Usage and limits tab (`docs/claude/island.md`): what the daemon already knows, nothing estimated.
//
//   - PLAN LIMITS: the windows the runtime reported (`island.usage`'s `windows` — the agent SDK's `rate_limit_event`:
//     a five-hour or weekly window's status, how full it is and when it resets), and the subscription snapshot of
//     Winter's background jobs. A ring per window (when the runtime said how full), the reset as a relative time.
//   - THIS SESSION: the session in front (a Winter window's, else the Dispatch session): its context fill (the last
//     measured context against the model's catalog window — a ring only when both are known) and the tokens its turns
//     counted since the daemon started.
//   - BACKGROUND JOBS: Winter's own background calls (titles, reviewer, dreamer, cleaner, research) — backed off
//     until when, and their tokens since start (`quota.state`'s numbers).
//   - NOTES: each model role's reported problem (`settings.modelRoles`: rate limited, usage limit, out of credits, …),
//     worded as Settings → Roles words it.

struct IslandUsageGauge: Identifiable, Equatable {
    let id: String
    let title: String
    /// How full, 0…1; nil when the runtime did not say.
    let fraction: Double?
    let status: String
    let refused: Bool
    /// "resets in 2 h 14 min" (nil without a reset).
    let resets: String?
    /// "reported 3 min ago".
    let reported: String
}

struct IslandUsageContext: Equatable {
    let title: String
    /// Context fill, 0…1, when both the measured context and the model's window are known.
    let fraction: Double?
    /// "31k of 200k context" / "31k context" / nil.
    let contextLine: String?
    /// "1.2k in · 300 out · 4 turns since Winter started".
    let tokensLine: String
    let model: String?
}

struct IslandUsageBackground: Equatable {
    let limited: Bool
    let line: String
    let tokensLine: String
}

struct IslandUsageNote: Identifiable, Equatable {
    let id: String
    let role: String
    let model: String?
    let text: String
}

enum IslandUsagePresentation {
    /// PURE: a window kind as words.
    static func windowTitle(_ kind: String?) -> String {
        switch kind {
        case "five_hour": return "5-hour window"
        case "seven_day": return "Weekly window"
        case "seven_day_opus": return "Weekly window · Opus"
        case "seven_day_sonnet": return "Weekly window · Sonnet"
        case "seven_day_overage_included": return "Weekly window · with extra usage"
        case "overage": return "Extra usage"
        case let other?: return other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: return "Plan window"
        }
    }

    /// PURE: the runtime's utilization — a FRACTION 0…1 (`SDKRateLimitInfo.utilization`, typed after the upstream SDK
    /// whose unified-limit utilization is a fraction; the pinned provider runtime's own `quotaEvent` never sends one).
    /// Anything outside 0…1 is not that unit: no fill is shown rather than a guessed one.
    static func fraction(_ utilization: Double?) -> Double? {
        guard let u = utilization, u.isFinite, (0...1).contains(u) else { return nil }
        return u
    }

    /// PURE: a window's status as words.
    static func statusText(_ status: String?) -> String {
        switch status {
        case "allowed": return "Within limits"
        case "allowed_warning": return "Nearing the limit"
        case "rejected": return "Limit reached"
        case let other?: return other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: return "Reported"
        }
    }

    /// PURE: every plan window, the most constrained first; the background jobs' subscription snapshot is added
    /// only when no runtime window of the same kind is there.
    static func gauges(_ snapshot: IslandUsageSnapshot, now: Date) -> [IslandUsageGauge] {
        var out: [IslandUsageGauge] = snapshot.windows.map { w in
            gauge(id: "window-\(w.rateLimitType ?? "plan")", kind: w.rateLimitType, status: w.status,
                  utilization: w.utilization, resetsAt: w.resetsAt, at: w.at, now: now)
        }
        if let s = snapshot.subscription, !snapshot.windows.contains(where: { $0.rateLimitType == s.rateLimitType }) {
            var g = gauge(id: "subscription", kind: s.rateLimitType, status: s.status ?? "allowed", utilization: s.utilization,
                          resetsAt: s.resetsAt, at: s.at, now: now)
            g = IslandUsageGauge(id: g.id, title: s.rateLimitType == nil ? "Background jobs' plan" : "\(g.title) · background jobs",
                                 fraction: g.fraction, status: g.status, refused: g.refused, resets: g.resets, reported: g.reported)
            out.append(g)
        }
        return out.sorted { a, b in
            if a.refused != b.refused { return a.refused }
            return (a.fraction ?? -1) > (b.fraction ?? -1)
        }
    }

    private static func gauge(id: String, kind: String?, status: String, utilization: Double?, resetsAt: Double?, at: Double,
                              now: Date) -> IslandUsageGauge {
        let resets = resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) }.flatMap { date -> String? in
            date > now ? "resets \(islandRelativeFuture(date, now: now))" : nil
        }
        return IslandUsageGauge(id: id, title: windowTitle(kind), fraction: fraction(utilization), status: statusText(status),
                                refused: status == "rejected", resets: resets,
                                reported: "reported \(islandRelativePast(Date(timeIntervalSince1970: at / 1000), now: now))")
    }

    /// PURE: the session block (nil without a session).
    static func context(_ session: IslandUsageSnapshot.Session?, title: String?) -> IslandUsageContext? {
        guard let session else { return nil }
        var fraction: Double?
        var line: String?
        if let used = session.contextTokens {
            if let window = session.contextWindow, window > 0 {
                fraction = min(1, Double(used) / Double(window))
                line = "\(islandCompactCount(used)) of \(islandCompactCount(window)) context"
            } else {
                line = "\(islandCompactCount(used)) context"
            }
        }
        let turns = session.turns == 1 ? "1 turn" : "\(session.turns) turns"
        let tokens = session.turns == 0
            ? "No turns since Winter started"
            : "\(islandCompactCount(session.inputTokens)) in · \(islandCompactCount(session.outputTokens)) out · \(turns) since Winter started"
        return IslandUsageContext(title: title ?? "This session", fraction: fraction, contextLine: line, tokensLine: tokens,
                                  model: session.model)
    }

    /// PURE: the background jobs' line.
    static func background(_ b: IslandUsageSnapshot.Background, now: Date) -> IslandUsageBackground {
        let line: String
        if b.limited, let resume = b.resumeAt.map({ Date(timeIntervalSince1970: $0 / 1000) }), resume > now {
            line = "Backed off — resumes \(islandRelativeFuture(resume, now: now))"
        } else if b.limited {
            line = "Backed off"
        } else {
            line = "Running normally"
        }
        return IslandUsageBackground(limited: b.limited, line: line,
                                     tokensLine: "\(islandCompactCount(b.inputTokens)) in · \(islandCompactCount(b.outputTokens)) out since Winter started")
    }

    /// PURE: each role's reported problem, in Settings → Roles' order and words.
    static func notes(_ roles: [String: ModelRoleValue], now: Date) -> [IslandUsageNote] {
        settingsModelRoleOrder.compactMap { role in
            guard let wire = roles[role.rawValue]?.problem else { return nil }
            let problem = roleProblem(wire)
            return IslandUsageNote(id: role.rawValue, role: settingsModelRoleTitle(role),
                                   model: problem.model.flatMap { $0.isEmpty ? nil : $0 }, text: roleProblemText(problem, now: now))
        }
    }
}

/// The Usage tab's state.
@MainActor
final class IslandUsageModel: ObservableObject {
    @Published private(set) var snapshot: IslandUsageSnapshot?
    @Published private(set) var roles: [String: ModelRoleValue] = [:]
    @Published private(set) var sessionTitle: String?
    @Published private(set) var failed = false

    var fetch: (_ sessionId: String?) async throws -> IslandUsageSnapshot = { _ in
        IslandUsageSnapshot(windows: [], background: .init(limited: false, inputTokens: 0, outputTokens: 0))
    }
    var fetchRoles: () async throws -> [String: ModelRoleValue] = { [:] }
    /// The session in front: a Winter window's, else the Dispatch session — its id and title.
    var currentSession: () -> (id: String, title: String?)? = { nil }
    var now: () -> Date = { Date() }

    func refresh() async {
        let current = currentSession()
        do {
            snapshot = try await fetch(current?.id)
            failed = false
        } catch {
            failed = snapshot == nil
        }
        sessionTitle = current?.title
        if let r = try? await fetchRoles() { roles = r }
    }

    /// Test seam: set what a refresh would.
    func setForTesting(_ snapshot: IslandUsageSnapshot?, roles: [String: ModelRoleValue] = [:], sessionTitle: String? = nil) {
        self.snapshot = snapshot
        self.roles = roles
        self.sessionTitle = sessionTitle
    }
}

// MARK: - The view

struct IslandUsageTab: View {
    @ObservedObject var model: IslandUsageModel
    var now = Date()

    var body: some View {
        if let snapshot = model.snapshot {
            content(snapshot)
        } else {
            IslandEmptyTab(symbol: "gauge.with.dots.needle.50percent", line: model.failed ? "Couldn't read usage" : "Reading usage…")
        }
    }

    @ViewBuilder
    private func content(_ snapshot: IslandUsageSnapshot) -> some View {
        let gauges = IslandUsagePresentation.gauges(snapshot, now: now)
        let context = IslandUsagePresentation.context(snapshot.session, title: model.sessionTitle)
        let background = IslandUsagePresentation.background(snapshot.background, now: now)
        let notes = IslandUsagePresentation.notes(model.roles, now: now)
        VStack(alignment: .leading, spacing: 12) {
            section("Plan limits")
            if gauges.isEmpty {
                Text("No plan window reported yet. Winter shows one when your provider reports how much of it is used.")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
            } else {
                // Two per row (a plain stack: the offscreen renderer draws no lazy grid).
                VStack(spacing: 8) {
                    ForEach(Array(stride(from: 0, to: gauges.count, by: 2)), id: \.self) { i in
                        HStack(spacing: 8) {
                            IslandUsageGaugeTile(gauge: gauges[i])
                            if i + 1 < gauges.count { IslandUsageGaugeTile(gauge: gauges[i + 1]) } else { Color.clear.frame(maxWidth: .infinity) }
                        }
                    }
                }
            }
            if let context {
                section("This session")
                IslandUsageContextRow(context: context)
            }
            section("Background jobs")
            IslandHoverSurface { _ in
                HStack(spacing: 10) {
                    Image(systemName: background.limited ? "hourglass" : "checkmark.circle")
                        .font(Typography.label(.semibold))
                        .foregroundStyle(background.limited ? pillReviewAmber : Theme.textMuted)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(background.line).font(Typography.label(.medium)).foregroundStyle(Color.white)
                        Text(background.tokensLine).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(height: 46)
            }
            if !notes.isEmpty {
                section("Notes")
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(notes) { note in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(note.role).font(Typography.label(.medium)).foregroundStyle(Color.white)
                                Spacer(minLength: 6)
                                if let m = note.model {
                                    Text(m).font(Typography.captionMono()).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.middle)
                                }
                            }
                            Text(note.text).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: IslandLayout.rowCorner, style: .continuous).fill(Color.white.opacity(0.06)))
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }

    private func section(_ title: String) -> some View {
        Text(title.uppercased())
            .font(Typography.tiny(.semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 6)
            .padding(.top, 2)
    }
}

struct IslandUsageGaugeTile: View {
    let gauge: IslandUsageGauge

    var body: some View {
        IslandHoverSurface { _ in
            HStack(spacing: 10) {
                if let f = gauge.fraction {
                    IslandRing(fraction: f, color: islandFillColor(f, refused: gauge.refused))
                } else {
                    Image(systemName: gauge.refused ? "xmark.octagon.fill" : "checkmark.seal.fill")
                        .font(Typography.heading(.regular))
                        .foregroundStyle(gauge.refused ? Color(nsColor: .systemRed) : Theme.accent)
                        .frame(width: 44, height: 44)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(gauge.title).font(Typography.label(.medium)).foregroundStyle(Color.white).lineLimit(1)
                    Text(gauge.status).font(Typography.caption())
                        .foregroundStyle(gauge.refused ? Color(nsColor: .systemRed) : Theme.textMuted).lineLimit(1)
                    Text(gauge.resets ?? gauge.reported).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
        }
    }
}

struct IslandUsageContextRow: View {
    let context: IslandUsageContext

    var body: some View {
        IslandHoverSurface { _ in
            HStack(spacing: 12) {
                if let f = context.fraction {
                    IslandRing(fraction: f, color: islandFillColor(f))
                } else {
                    Image(systemName: "text.bubble")
                        .font(Typography.heading(.regular))
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: 44, height: 44)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(context.title).font(Typography.label(.medium)).foregroundStyle(Color.white).lineLimit(1)
                    if let line = context.contextLine {
                        Text(line).font(Typography.caption()).foregroundStyle(Theme.textMuted)
                    }
                    Text(context.tokensLine).font(Typography.caption()).foregroundStyle(Theme.textMuted).lineLimit(1)
                    if let f = context.fraction {
                        IslandBar(fraction: f, color: islandFillColor(f)).padding(.top, 2)
                    }
                }
                Spacer(minLength: 0)
                if let model = context.model {
                    Text(model).font(Typography.captionMono()).foregroundStyle(Theme.textMuted).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 140, alignment: .trailing)
                }
            }
            .padding(10)
        }
    }
}
