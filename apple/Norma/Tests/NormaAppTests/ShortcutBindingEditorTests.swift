import AppKit
import Carbon.HIToolbox
import WinterKit
import XCTest
@testable import Winter

/// Task 4 (Phase 4d-iii) — the PURE parts only, same posture as `ShortcutRegistryTests`: conflict
/// detection (`bindingConflict`) and the modifier-flags→Carbon-mask mapping (`carbonModifiers`) the
/// key-capture control's callback builds a candidate `ShortcutBinding` from. The actual live
/// `keyDown` capture is glue, verified by the live gate, not here.
final class BindingConflictTests: XCTestCase {
    private func binding(plugin: String = "com.example.a", shortcut: String = "toggle", keyCode: UInt32 = 40, modifiers: UInt32 = 4096) -> ShortcutBinding {
        ShortcutBinding(pluginId: plugin, shortcutId: shortcut, keyCode: keyCode, modifiers: modifiers)
    }

    func testSameKeybindingOnTwoDifferentShortcutsIsAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 40, modifiers: 4096)
        XCTAssertTrue(bindingConflict(existing: existing, new: new))
    }

    func testDifferentKeybindingsAreNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 41, modifiers: 4096)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    func testDifferentModifiersOnTheSameKeyCodeAreNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.b", shortcut: "open", keyCode: 40, modifiers: 2048)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    /// Rebinding the SAME (pluginId, shortcutId) to a different key combo is not a self-conflict —
    /// even though `existing` still holds that pair's OLD binding at check time (the caller hasn't
    /// removed/replaced it yet).
    func testRebindingTheSamePluginShortcutIsNotASelfConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 41, modifiers: 8192)
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    /// Re-applying the EXACT SAME binding for the same pair (a no-op save) is also not a conflict.
    func testReapplyingTheExactSameBindingIsNotAConflict() {
        let existing = [binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)]
        let new = existing[0]
        XCTAssertFalse(bindingConflict(existing: existing, new: new))
    }

    func testConflictIsDetectedAgainstAnyOneOfMultipleExistingBindings() {
        let existing = [
            binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096),
            binding(plugin: "com.example.b", shortcut: "open", keyCode: 12, modifiers: 2048),
        ]
        let new = binding(plugin: "com.example.c", shortcut: "close", keyCode: 12, modifiers: 2048)
        XCTAssertTrue(bindingConflict(existing: existing, new: new))
    }

    func testNoExistingBindingsIsNeverAConflict() {
        let new = binding(plugin: "com.example.a", shortcut: "toggle", keyCode: 40, modifiers: 4096)
        XCTAssertFalse(bindingConflict(existing: [], new: new))
    }
}

/// `carbonModifiers(from:)` — AppKit `NSEvent.ModifierFlags` → the Carbon modifier mask
/// `ShortcutBinding`/`RegisterEventHotKey` expect. Pure, no live event tap needed.
final class CarbonModifiersTests: XCTestCase {
    func testNoModifiersMapsToZero() {
        XCTAssertEqual(carbonModifiers(from: []), 0)
    }

    func testEachIndividualModifierMapsToItsOwnBit() {
        let control = carbonModifiers(from: .control)
        let option = carbonModifiers(from: .option)
        let shift = carbonModifiers(from: .shift)
        let command = carbonModifiers(from: .command)
        XCTAssertNotEqual(control, 0)
        XCTAssertNotEqual(option, 0)
        XCTAssertNotEqual(shift, 0)
        XCTAssertNotEqual(command, 0)
        // All four bits are distinct, so the OR below recovers all four with no overlap loss.
        XCTAssertEqual(Set([control, option, shift, command]).count, 4)
    }

    func testCombinedModifiersOrTogetherTheIndividualBits() {
        let combined = carbonModifiers(from: [.control, .option])
        let control = carbonModifiers(from: .control)
        let option = carbonModifiers(from: .option)
        XCTAssertEqual(combined, control | option)
    }

    func testIrrelevantModifierFlagsAreIgnored() {
        // `.capsLock`/`.function`/etc. have no Carbon hotkey-modifier equivalent this codebase
        // tracks — only control/option/shift/command are mapped.
        XCTAssertEqual(carbonModifiers(from: [.capsLock, .function]), 0)
    }
}

// -----------------------------------------------------------------------------------------------
// Final-review fix wave (4d-iii Task 4): the system-wide-keyboard-hijack fix. Escape-to-cancel and
// "require a real modifier" close the hole where "click to set" then Esc-to-back-out registered a
// modifier-less GLOBAL Carbon hotkey on Escape; the reserved-combo check closes the hole where a
// plugin shortcut could shadow Winter's own summon/panic hotkeys.
// -----------------------------------------------------------------------------------------------

/// `hasRequiredModifier(_:)` — the capture-path gate against arming a modifier-less or shift-only
/// GLOBAL Carbon hotkey. PURE, no live event tap needed, same posture as `BindingConflictTests`.
final class HasRequiredModifierTests: XCTestCase {
    /// (a) modifiers==0 must be rejected — the exact shape a canceled/no-modifier capture produces.
    func testNoModifiersIsRejected() {
        XCTAssertFalse(hasRequiredModifier(0))
    }

    /// (b) shift-only is too weak on its own — control/option/command are the only modifiers this
    /// gate accepts as "real".
    func testShiftOnlyIsRejected() {
        XCTAssertFalse(hasRequiredModifier(UInt32(shiftKey)))
    }

    /// (c) control alone (no other modifier) is accepted.
    func testControlAloneIsAccepted() {
        XCTAssertTrue(hasRequiredModifier(UInt32(controlKey)))
    }

    func testOptionAloneIsAccepted() {
        XCTAssertTrue(hasRequiredModifier(UInt32(optionKey)))
    }

    func testCommandAloneIsAccepted() {
        XCTAssertTrue(hasRequiredModifier(UInt32(cmdKey)))
    }

    /// Shift is fine ALONGSIDE a real modifier — only shift ALONE (or nothing) is rejected.
    func testShiftAlongsideARealModifierIsAccepted() {
        XCTAssertTrue(hasRequiredModifier(UInt32(shiftKey | controlKey)))
    }
}

/// `isReservedCombo(keyCode:modifiers:)` — rejects a capture equal to Winter's own summon hotkey
/// (`HotkeyTrigger.swift`'s fixed default) or panic hotkey (`PeripheralProvider.swift`'s fixed
/// combo). PURE, no live event tap needed.
final class IsReservedComboTests: XCTestCase {
    /// (e) the summon combo (`HotkeyTrigger.swift`: keyCode 49 / `kVK_Space`,
    /// `cmdKey | controlKey | optionKey`) is reserved.
    func testSummonComboIsReserved() {
        XCTAssertTrue(isReservedCombo(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | controlKey | optionKey)))
    }

    /// (e) the panic combo (`PeripheralProvider.swift`: `kVK_Escape`,
    /// `controlKey | optionKey | cmdKey`) is reserved.
    func testPanicComboIsReserved() {
        XCTAssertTrue(isReservedCombo(keyCode: UInt32(kVK_Escape), modifiers: UInt32(controlKey | optionKey | cmdKey)))
    }

    /// (e) an ordinary plugin-shortcut combo (⌃⌥K) is NOT reserved.
    func testControlOptionKIsNotReserved() {
        XCTAssertFalse(isReservedCombo(keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey | optionKey)))
    }

    /// Same keyCode as the summon combo but missing a modifier isn't a match — this is an
    /// exact-combo check, not a "shares the key" check.
    func testSameKeyCodeAsSummonButFewerModifiersIsNotReserved() {
        XCTAssertFalse(isReservedCombo(keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey)))
    }
}

/// `ShortcutBindingEditorModel.capture(...)`'s full three-gate chain (`hasRequiredModifier` →
/// `isReservedCombo` → `bindingConflict`), exercised end to end against a real (never-connected)
/// `WinterClient` — `capture(...)` never touches the client, only `UserDefaults`/`ShortcutRegistry`
/// (`nil` here, same as under `AppDelegate.boot()`'s unit-test gate), so `WinterClientTestFactory.
/// make()` (`DashboardTests.swift`, same target) is enough to satisfy the model's initializer
/// without a live connection.
@MainActor
final class ShortcutBindingEditorModelCaptureTests: XCTestCase {
    private func freshDefaults(_ name: String) -> (defaults: UserDefaults, cleanup: () -> Void) {
        let suiteName = "ShortcutBindingEditorModelCaptureTests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, { defaults.removePersistentDomain(forName: suiteName) })
    }

    private func model(defaults: UserDefaults) -> ShortcutBindingEditorModel {
        ShortcutBindingEditorModel(client: WinterClientTestFactory.make(), shortcutRegistry: nil, defaults: defaults)
    }

    /// (a) modifiers==0 → no binding produced (nothing persisted), and the rejection surfaces via
    /// `conflictMessage` (the editor's existing inline-message idiom) rather than being swallowed.
    func testModifierlessCaptureProducesNoBindingAndSurfacesAHint() {
        let (defaults, cleanup) = freshDefaults("modifierless")
        defer { cleanup() }
        let m = model(defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: 0)

        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), [])
        XCTAssertNotNil(m.conflictMessage)
    }

    /// (b) shift-only → same: rejected, nothing persisted.
    func testShiftOnlyCaptureProducesNoBinding() {
        let (defaults, cleanup) = freshDefaults("shiftonly")
        defer { cleanup() }
        let m = model(defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(shiftKey))

        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), [])
        XCTAssertNotNil(m.conflictMessage)
    }

    /// (c) control+key → accepted: persisted, `conflictMessage` cleared.
    func testControlComboCaptureIsAcceptedAndPersisted() {
        let (defaults, cleanup) = freshDefaults("accepted")
        defer { cleanup() }
        let m = model(defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))

        XCTAssertEqual(
            ShortcutSettingsStore.load(from: defaults),
            [ShortcutBinding(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))]
        )
        XCTAssertNil(m.conflictMessage)
    }

    /// (f) a reserved combo is rejected via the actual capture path, not just `isReservedCombo` in
    /// isolation. Uses the SUMMON combo specifically: the panic combo is Escape-based, and a live
    /// Escape keypress never reaches `capture(...)` at all — `KeyCaptureNSView.keyDown` cancels it
    /// first (see that view's doc comment) — so the summon combo is the one that genuinely exercises
    /// this guard end to end through `capture(...)`.
    func testSummonComboCaptureIsRejectedAsReserved() {
        let (defaults, cleanup) = freshDefaults("reserved")
        defer { cleanup() }
        let m = model(defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_Space), modifiers: UInt32(cmdKey | controlKey | optionKey))

        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), [])
        XCTAssertEqual(m.conflictMessage, "That combo is reserved by Winter.")
    }
}

// -----------------------------------------------------------------------------------------------
// Phase 4d-cleanup Task 3 fix 2: hotkey-arm failure surfaced. `ShortcutRegistry` itself can't be
// unit-tested (real Carbon calls — see `ShortcutRegistryTests.swift`'s own doc comment), so these
// exercise `ShortcutBindingEditorModel.capture(...)`'s handling of `reload(_:)`'s return value
// through the `ShortcutHotkeyReloading` seam (`ShortcutRegistry.swift`), injecting a fake that
// scripts which bindings "failed to arm" without ever touching a real hotkey.
// -----------------------------------------------------------------------------------------------

/// Scripts `reload(_:)`'s return value — `failedBindings` is echoed back verbatim on every call,
/// same "script the response" posture as this target's `FeedScriptedTransport` double.
@MainActor
private final class FakeHotkeyReloader: ShortcutHotkeyReloading {
    var failedBindings: [ShortcutBinding] = []
    private(set) var lastReloadedBindings: [ShortcutBinding] = []

    func reload(_ bindings: [ShortcutBinding]) -> [ShortcutBinding] {
        lastReloadedBindings = bindings
        return failedBindings
    }
}

@MainActor
final class ShortcutBindingEditorModelArmFailureTests: XCTestCase {
    private func freshDefaults(_ name: String) -> (defaults: UserDefaults, cleanup: () -> Void) {
        let suiteName = "ShortcutBindingEditorModelArmFailureTests.\(name).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, { defaults.removePersistentDomain(forName: suiteName) })
    }

    /// The just-captured binding is in `reload`'s failed set → `conflictMessage` surfaces the
    /// arm-failure text (not the generic "already bound" message), and the binding is STILL
    /// persisted (a later retry — app restart, the other app quitting — should be able to pick it
    /// back up without the user having to re-capture it).
    func testCaptureSurfacesArmFailureWhenTheJustCapturedBindingFailsToRegister() {
        let (defaults, cleanup) = freshDefaults("failed")
        defer { cleanup() }
        let candidate = ShortcutBinding(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))
        let fake = FakeHotkeyReloader()
        fake.failedBindings = [candidate]
        let m = ShortcutBindingEditorModel(client: WinterClientTestFactory.make(), shortcutRegistry: fake, defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))

        XCTAssertEqual(ShortcutSettingsStore.load(from: defaults), [candidate], "the binding is persisted even though it failed to arm live")
        XCTAssertEqual(m.conflictMessage, "Couldn't register \u{2303}K \u{2014} the key may be in use by another app.")
        XCTAssertEqual(fake.lastReloadedBindings, [candidate], "reload must be called with the full updated bindings list")
    }

    /// An empty failed-set (the common case) clears `conflictMessage` — same as before this fix.
    func testCaptureClearsConflictMessageWhenReloadReportsNoFailures() {
        let (defaults, cleanup) = freshDefaults("ok")
        defer { cleanup() }
        let fake = FakeHotkeyReloader()
        fake.failedBindings = []
        let m = ShortcutBindingEditorModel(client: WinterClientTestFactory.make(), shortcutRegistry: fake, defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))

        XCTAssertNil(m.conflictMessage)
    }

    /// `reload`'s failed set names a DIFFERENT binding (not the one just captured) — irrelevant to
    /// this capture, so `conflictMessage` stays clear.
    func testCaptureIgnoresAFailureReportedForADifferentBinding() {
        let (defaults, cleanup) = freshDefaults("otherfailed")
        defer { cleanup() }
        let other = ShortcutBinding(pluginId: "com.example.b", shortcutId: "open", keyCode: UInt32(kVK_ANSI_L), modifiers: UInt32(optionKey))
        let fake = FakeHotkeyReloader()
        fake.failedBindings = [other]
        let m = ShortcutBindingEditorModel(client: WinterClientTestFactory.make(), shortcutRegistry: fake, defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))

        XCTAssertNil(m.conflictMessage)
    }

    /// A `nil` registry (the unit-test-boot posture — `AppDelegate.boot()` never constructs a real
    /// one under `isRunningUnitTests`) must not crash and must clear `conflictMessage`, same as
    /// before this fix.
    func testCaptureWithNilRegistryDoesNotCrashAndClearsConflictMessage() {
        let (defaults, cleanup) = freshDefaults("nilregistry")
        defer { cleanup() }
        let m = ShortcutBindingEditorModel(client: WinterClientTestFactory.make(), shortcutRegistry: nil, defaults: defaults)

        m.capture(pluginId: "com.example.a", shortcutId: "toggle", keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey))

        XCTAssertNil(m.conflictMessage)
    }
}

/// `KeyCaptureNSView.keyDown`'s Escape-cancel rule — exercised directly (no window/responder chain
/// needed: `mouseDown`/`keyDown` are just method calls, and `window?.makeFirstResponder(self)`
/// no-ops safely with `window` nil).
final class KeyCaptureNSViewEscapeCancelTests: XCTestCase {
    private func syntheticMouseDownEvent() -> NSEvent {
        NSEvent.mouseEvent(
            with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1
        )!
    }

    private func syntheticKeyEvent(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: modifierFlags, timestamp: 0,
            windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "",
            isARepeat: false, keyCode: keyCode
        )!
    }

    /// (d) Escape during an active capture cancels it — no binding, `onCapture` never invoked.
    func testEscapeDuringCaptureCancelsWithoutInvokingOnCapture() {
        let view = KeyCaptureNSView()
        var captured: (UInt32, UInt32)?
        view.onCapture = { keyCode, modifiers in captured = (keyCode, modifiers) }

        view.mouseDown(with: syntheticMouseDownEvent()) // arms capture
        view.keyDown(with: syntheticKeyEvent(keyCode: UInt16(kVK_Escape)))

        XCTAssertNil(captured, "Escape must cancel the capture, not become the binding")
    }

    /// A non-Escape keypress during capture is unaffected by the Escape-cancel rule — it still
    /// reaches `onCapture` (downstream gates in `ShortcutBindingEditorModel.capture` handle
    /// modifier/reserved-combo validation from there).
    func testNonEscapeKeyDuringCaptureStillInvokesOnCapture() {
        let view = KeyCaptureNSView()
        var captured: (UInt32, UInt32)?
        view.onCapture = { keyCode, modifiers in captured = (keyCode, modifiers) }

        view.mouseDown(with: syntheticMouseDownEvent())
        view.keyDown(with: syntheticKeyEvent(keyCode: UInt16(kVK_ANSI_K), modifierFlags: .control))

        XCTAssertNotNil(captured)
    }
}
