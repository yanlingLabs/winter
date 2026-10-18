import AppKit
import WinterKit

// The Usage window (`docs/claude/usage.md`): opened from the island's Usage tab ("Open usage") and the menu bar's
// "Usage…". One window; a second ask brings it to the front.
extension AppDelegate {
    func showUsageWindow() {
        if let existing = usageWindow {
            existing.show()
            return
        }
        guard let client = appModel?.client else { return }
        let model = UsageWindowModel()
        model.fetchSeries = { range, sources in try await client.usageSeries(range: range, sources: sources) }
        model.fetchSummary = { range, sources in try await client.usageSummary(range: range, sources: sources) }
        model.fetchSubscriptions = { try await client.usageSubscriptions() }
        model.saveSubscription = { s in try await client.usageSetSubscription(s) }
        model.deleteSubscription = { id in try await client.usageRemoveSubscription(id: id) }
        model.setTracking = { codex, claudeCode, antigravity, opencode in
            try await client.usageSetTracking(codex: codex, claudeCode: claudeCode, antigravity: antigravity, opencode: opencode)
        }
        model.setAlarm = { provider, key, pct in try await client.usageSetAlarm(provider: provider, windowKey: key, thresholdPercent: pct) }
        model.removeAlarm = { id in try await client.usageRemoveAlarm(id: id) }
        let controller = UsageWindowController(model: model)
        controller.onClosed = { [weak self] in self?.usageWindow = nil }
        usageWindow = controller
        controller.show()
    }
}
