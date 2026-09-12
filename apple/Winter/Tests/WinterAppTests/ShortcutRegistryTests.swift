import Carbon.HIToolbox
import XCTest
@testable import Winter

/// Phase 4d-iii Task 1 — the PURE parts only (per the task brief): `ShortcutBinding` Codable
/// round-trip through the settings-list shape, `reloadDiff`'s set-difference logic, and the
/// keybinding→display-string mapping. The actual `RegisterEventHotKey` call is glue, verified by
/// the live gate (xcodebuild), not here — mirrors `HotkeyTrigger`/`PeripheralProvider` having no
/// dedicated Carbon-call unit tests either.
final class ShortcutRegistryTests: XCTestCase {
    // MARK: - ShortcutBinding Codable round-trip (settings-list shape)

    func testShortcutBindingRoundTripsThroughSettingsListShape() throws {
        let bindings = [
            ShortcutBinding(pluginId: "com.example.plugin", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey | optionKey)),
            ShortcutBinding(pluginId: "com.example.plugin2", shortcutId: "open", keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey)),
        ]
        let data = try JSONEncoder().encode(bindings)
        let decoded = try JSONDecoder().decode([ShortcutBinding].self, from: data)
        XCTAssertEqual(decoded, bindings)
    }

    func testShortcutSettingsStoreLoadsEmptyWhenNothingPersisted() {
        let suiteName = "ShortcutRegistryTests.empty.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), [])
    }

    func testShortcutSettingsStoreRoundTripsThroughUserDefaults() {
        let suiteName = "ShortcutRegistryTests.roundtrip.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let bindings = [
            ShortcutBinding(pluginId: "p1", shortcutId: "s1", keyCode: 1, modifiers: 2),
            ShortcutBinding(pluginId: "p2", shortcutId: "s2", keyCode: 3, modifiers: 4),
        ]
        ShortcutSettingsStore.save(bindings, to: defaults)
        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), bindings)
        XCTAssertNotNil(defaults.data(forKey: ShortcutSettingsStore.defaultsKey))
    }

    // MARK: - reloadDiff (pure diff logic behind `ShortcutRegistry.reload`)

    func testReloadDiffAddsNewBindingsWhenOldIsEmpty() {
        let new = [ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 1, modifiers: 0)]
        let diff = reloadDiff(old: [], new: new)
        XCTAssertEqual(diff.toRemove, [])
        XCTAssertEqual(diff.toAdd, new)
    }

    func testReloadDiffRemovesBindingsGoneFromNew() {
        let old = [ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 1, modifiers: 0)]
        let diff = reloadDiff(old: old, new: [])
        XCTAssertEqual(diff.toRemove, old)
        XCTAssertEqual(diff.toAdd, [])
    }

    func testReloadDiffLeavesUnchangedBindingsOutOfBothSets() {
        let shared = ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 1, modifiers: 0)
        let onlyOld = ShortcutBinding(pluginId: "p2", shortcutId: "s2", keyCode: 2, modifiers: 0)
        let onlyNew = ShortcutBinding(pluginId: "p3", shortcutId: "s3", keyCode: 3, modifiers: 0)
        let diff = reloadDiff(old: [shared, onlyOld], new: [shared, onlyNew])
        XCTAssertEqual(diff.toRemove, [onlyOld])
        XCTAssertEqual(diff.toAdd, [onlyNew])
    }

    func testReloadDiffTreatsRebindAsRemoveThenAdd() {
        // Same plugin+shortcut, different key combo — the Carbon registration is keyed by the
        // key combo, so this must show up as BOTH a remove (the old combo) and an add (the new
        // one), not a no-op.
        let before = ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 1, modifiers: 0)
        let after = ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 2, modifiers: 0)
        let diff = reloadDiff(old: [before], new: [after])
        XCTAssertEqual(diff.toRemove, [before])
        XCTAssertEqual(diff.toAdd, [after])
    }

    func testReloadDiffIsNoOpWhenOldAndNewAreIdentical() {
        let bindings = [ShortcutBinding(pluginId: "p", shortcutId: "s", keyCode: 1, modifiers: 0)]
        let diff = reloadDiff(old: bindings, new: bindings)
        XCTAssertEqual(diff.toRemove, [])
        XCTAssertEqual(diff.toAdd, [])
    }

    // MARK: - keybinding -> display string

    func testDisplayStringControlOptionK() {
        XCTAssertEqual(
            shortcutDisplayString(keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey | optionKey)),
            "\u{2303}\u{2325}K"
        )
    }

    func testDisplayStringCommandSpace() {
        XCTAssertEqual(
            shortcutDisplayString(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey)),
            "\u{2318}Space"
        )
    }

    func testDisplayStringAllFourModifiersEscape() {
        let mods = UInt32(controlKey | optionKey | shiftKey | cmdKey)
        XCTAssertEqual(
            shortcutDisplayString(keyCode: UInt32(kVK_Escape), modifiers: mods),
            "\u{2303}\u{2325}\u{21E7}\u{2318}\u{238B}"
        )
    }

    func testDisplayStringNoModifiersFallsBackToKeyCodeForUnmappedKey() {
        XCTAssertEqual(shortcutDisplayString(keyCode: 9999, modifiers: 0), "Key9999")
    }
}
