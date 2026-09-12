import Foundation

/// A single plugin-shortcut → key-combo binding (Phase 4d-iii). Produced/edited by the Task 4
/// shortcut-editor UI, consumed by `ShortcutRegistry` (same directory) to arm one distinct
/// Carbon `EventHotKeyRef` per binding. Pure model — no Carbon/AppKit import — so it and its
/// settings-list encode/decode are testable without a live event tap.
struct ShortcutBinding: Codable, Equatable, Hashable {
    var pluginId: String
    var shortcutId: String
    var keyCode: UInt32
    var modifiers: UInt32
}

/// Load/save for the `shortcuts` settings-list. A thin `UserDefaults`-backed store — the app has
/// no broader local-settings layer yet (Phase 4d-iii introduces the first one), so this is scoped
/// tight to just the `shortcuts` key rather than inventing a general-purpose settings system this
/// task doesn't need.
enum ShortcutSettingsStore {
    static let defaultsKey = "shortcuts"

    /// A missing key or corrupt/stale-format data both degrade to "no bindings" rather than
    /// throwing — a freshly-installed app (nothing written yet) and a future format change should
    /// both boot with an empty, harmless shortcut set instead of taking down `AppDelegate.boot()`.
    static func load(from defaults: UserDefaults = .standard) -> [ShortcutBinding] {
        guard let data = defaults.data(forKey: defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([ShortcutBinding].self, from: data)) ?? []
    }

    static func save(_ bindings: [ShortcutBinding], to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(bindings) else { return }
        defaults.set(data, forKey: defaultsKey)
    }
}
