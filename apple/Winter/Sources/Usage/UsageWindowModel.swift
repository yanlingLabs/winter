import Combine
import Foundation
import WinterKit

/// The Usage window's state (`docs/claude/usage.md`): the range, the source toggles, the chart's metric, the series and
/// the plans for them, and the user's subscriptions. Reads only through the injected closures (the app's client in
/// production, fakes in tests); refreshes on open, on a change and every `refreshInterval` while the window is open.
@MainActor
final class UsageWindowModel: ObservableObject {
    @Published var range: UsageRange = .week { didSet { if range != oldValue { Task { await refresh() } } } }
    @Published private(set) var sources: Set<UsageSource> = Set(UsageSource.allCases)
    @Published var metric: UsageMetric = .cost
    @Published private(set) var series: UsageSeries?
    @Published private(set) var summary: UsageSummary?
    @Published private(set) var subscriptions: [UsageSubscription] = []
    @Published private(set) var failed = false
    @Published private(set) var subscriptionError: String?
    /// The plan alarms (their ticks); nil before an answer or from a daemon with none (the lines then take no clicks).
    @Published private(set) var alarms: [UsageAlarm]?

    var fetchSeries: (UsageRange, Set<UsageSource>) async throws -> UsageSeries = { r, _ in UsageSeries(range: r.rawValue) }
    var fetchSummary: (UsageRange, Set<UsageSource>) async throws -> UsageSummary = { r, _ in UsageSummary(range: r.rawValue) }
    var fetchSubscriptions: () async throws -> [UsageSubscription] = { [] }
    var saveSubscription: (UsageSubscription) async throws -> [UsageSubscription] = { _ in [] }
    var deleteSubscription: (String) async throws -> [UsageSubscription] = { _ in [] }
    var setTracking: (_ codex: Bool?, _ claudeCode: Bool?, _ antigravity: Bool?, _ opencode: Bool?) async throws -> Void = { _, _, _, _ in }
    /// `usage.alarms.set` / `.remove`, each answering the whole list.
    var setAlarm: (_ provider: String, _ windowKey: String, _ thresholdPercent: Int) async throws -> [UsageAlarm] = { _, _, _ in [] }
    var removeAlarm: (_ id: String) async throws -> [UsageAlarm] = { _ in [] }
    var now: () -> Date = { Date() }
    /// Bumped by every alarm edit: a summary asked for before one does not overwrite its answer.
    private var alarmEdits = 0

    static let refreshInterval: TimeInterval = 15
    private var ticker: Task<Void, Never>?

    func toggle(_ source: UsageSource) {
        if sources.contains(source) {
            // Never nothing at all — counting only the toggles shown (a hidden OpenCode toggle cannot be turned back on).
            let shown = sources.filter { UsagePresentation.showsToggle($0, summary: summary) }
            guard shown.count > 1 else { return }
            sources.remove(source)
        } else {
            sources.insert(source)
        }
        Task { await refresh() }
    }

    func refresh() async {
        await refresh(again: true)
    }

    private func refresh(again: Bool) async {
        let range = range, sources = sources
        // Never a source the daemon has not said it knows (`UsagePresentation.requestSources`).
        let asked = UsagePresentation.requestSources(sources, summary: summary)
        let edits = alarmEdits
        do {
            async let s = fetchSeries(range, asked)
            async let m = fetchSummary(range, asked)
            let (series, summary) = try await (s, m)
            // A newer choice while these were in flight: theirs wins.
            guard range == self.range, sources == self.sources else { return }
            self.series = series
            self.summary = summary
            if edits == alarmEdits { alarms = summary.alarms }
            failed = false
        } catch {
            failed = series == nil
        }
        // The first answer said OpenCode is known: ask once more with it, so its stored rows show at once.
        if again, UsagePresentation.requestSources(sources, summary: summary) != asked {
            await refresh(again: false)
            return
        }
        if let subs = try? await fetchSubscriptions() { subscriptions = subs }
    }

    func save(_ s: UsageSubscription) async -> Bool {
        do {
            subscriptions = try await saveSubscription(s)
            subscriptionError = nil
            return true
        } catch {
            subscriptionError = "Couldn’t save the plan."
            return false
        }
    }

    func remove(id: String) async {
        do { subscriptions = try await deleteSubscription(id) } catch { subscriptionError = "Couldn’t remove the plan." }
    }

    /// What a click on a plan line does (`UsageAlarmRules`) — nil while the daemon has no alarms.
    var alarmActions: UsageAlarmActions? {
        guard alarms != nil else { return nil }
        return UsageAlarmActions(
            set: { [weak self] provider, key, pct in self?.editAlarms { try await $0.setAlarm(provider, key, pct) } },
            remove: { [weak self] id in self?.editAlarms { try await $0.removeAlarm(id) } })
    }

    private func editAlarms(_ edit: @escaping (UsageWindowModel) async throws -> [UsageAlarm]) {
        alarmEdits += 1
        Task { [weak self] in
            guard let self, let list = try? await edit(self) else { return }
            self.alarmEdits += 1
            self.alarms = list
        }
    }

    func setTrack(codex: Bool? = nil, claudeCode: Bool? = nil, antigravity: Bool? = nil, opencode: Bool? = nil) async {
        try? await setTracking(codex, claudeCode, antigravity, opencode)
        await refresh()
    }

    /// The refresh beat — ONLY while the window is open (`start` on show, `stop` on close).
    func start() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.refreshInterval * 1_000_000_000))
                if Task.isCancelled { break }
                await self?.refresh()
            }
        }
    }

    func stop() {
        ticker?.cancel()
        ticker = nil
    }

    /// Test seam.
    func setForTesting(series: UsageSeries?, summary: UsageSummary?, subscriptions: [UsageSubscription] = []) {
        self.series = series
        self.summary = summary
        self.subscriptions = subscriptions
        self.alarms = summary?.alarms
    }
}
