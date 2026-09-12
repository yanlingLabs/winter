import AppKit
import Carbon.HIToolbox
import Foundation

/// Phase 4d-cleanup Task 3 fix 2: the seam `ShortcutBindingEditorModel` calls `reload` through —
/// lets a unit test inject a fake that scripts a non-empty failed-arm result without touching real
/// Carbon (`ShortcutRegistry` itself has no dedicated `RegisterEventHotKey` unit tests, same as
/// `HotkeyTrigger`/`PeripheralProvider` — see `ShortcutRegistryTests.swift`'s own doc comment).
@MainActor
protocol ShortcutHotkeyReloading: AnyObject {
    /// Brings the live registration set to exactly `bindings`; returns the subset of `bindings`
    /// whose `RegisterEventHotKey` call failed this call (empty = every binding is now armed).
    @discardableResult
    func reload(_ bindings: [ShortcutBinding]) -> [ShortcutBinding]
}

/// Multi-shortcut Carbon hotkey registry (Phase 4d-iii Task 1) — the plugin-shortcut counterpart
/// to `HotkeyTrigger.shared`'s single summon hotkey and `PeripheralProvider`'s single panic
/// hotkey. Registers ONE distinct `EventHotKeyRef` per `ShortcutBinding`, keyed by a unique
/// `EventHotKeyID` (signature `"NmSc"`, incrementing `id`), and routes a fired hotkey back to its
/// owning plugin via `onFire`. Purely additive: never touches either of those two files' own
/// registrations, which keep their own signatures (`"AIPT"`/`"NmPn"`) and hotKeyRefs untouched.
@MainActor
final class ShortcutRegistry: ShortcutHotkeyReloading {
    /// Fired on the main queue when one of the registered hotkeys is pressed. `AppDelegate` wires
    /// this straight to WinterKit's `client.shortcutInvoke(pluginId:shortcutId:)`.
    var onFire: ((_ pluginId: String, _ shortcutId: String) -> Void)?

    private var handlerRef: EventHandlerRef?
    private var entries: [UInt32: (ref: EventHotKeyRef, binding: ShortcutBinding)] = [:]
    private var nextId: UInt32 = 1

    private static let signature = "NmSc".fourCharCodeValue

    /// Single-instance routing seam — same posture as `PeripheralProvider.current`: a Carbon
    /// `EventHandlerUPP` is `@convention(c)` and cannot capture `self`, so the shared handler
    /// below routes through this weak static instead. `ShortcutRegistry` isn't a true singleton
    /// like `HotkeyTrigger.shared` (`AppDelegate` owns the instance), so this is set on `init`.
    private static weak var current: ShortcutRegistry?

    /// Unlike `HotkeyTrigger`/`PeripheralProvider`'s handlers (which ignore the fired event, since
    /// each only ever has ONE hotkey registered), this one MUST read the fired `EventHotKeyID` back
    /// off the event to know which of the N registered bindings just fired.
    ///
    /// CRITICAL: all three registries (`HotkeyTrigger`'s `"AIPT"`, `PeripheralProvider`'s
    /// `"NmPn"`, this one's `"NmSc"`) install their `InstallEventHandler` on the SAME
    /// `GetApplicationEventTarget()`, so every installed handler sits on one shared dispatch chain
    /// and can be handed events for hotkeys it did NOT register — e.g. Hyper+Space fires as
    /// `(AIPT, id: 1)`, which collides with this registry's very first binding, also `id: 1`
    /// (different signature, same id). Routing on `.id` alone would either fire the WRONG
    /// plugin's shortcut for that collision, or — because returning `noErr` marks the event
    /// handled — silently swallow Hyper+Space/panic before their own handlers ever see it, the
    /// moment any plugin shortcut exists. So: verify `signature` first, and return
    /// `eventNotHandledErr` (not `noErr`) for anything not ours, letting the chain's other
    /// handlers still receive the event.
    private static let handler: EventHandlerUPP = { _, eventRef, _ in
        guard let eventRef else { return OSStatus(eventNotHandledErr) }
        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            eventRef,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )
        guard status == noErr else { return status }
        guard hotKeyID.signature == ShortcutRegistry.signature else {
            return OSStatus(eventNotHandledErr)
        }
        let firedId = hotKeyID.id
        DispatchQueue.main.async {
            ShortcutRegistry.current?.handleFire(id: firedId)
        }
        return noErr
    }

    init() {
        Self.current = self
    }

    private func handleFire(id: UInt32) {
        guard let entry = entries[id] else { return }
        onFire?(entry.binding.pluginId, entry.binding.shortcutId)
    }

    /// Brings the live Carbon registration set to exactly `bindings`: unregisters whatever's
    /// currently armed that isn't in the new set, registers whatever's new. Net externally-visible
    /// effect is identical to a full unregister-all-then-register-all — computed via the pure
    /// `reloadDiff` below so bindings that didn't change aren't needlessly torn down and re-armed.
    ///
    /// Phase 4d-cleanup Task 3 fix 2: returns the subset of the newly-registered bindings
    /// (`diff.toAdd`) whose `RegisterEventHotKey` call failed — a binding that was already armed
    /// and is unchanged in `bindings` is never re-registered, so it can't newly fail here; a
    /// binding that previously failed to register was never added to `entries`, so it always shows
    /// up as "new" (`diff.toAdd`) on the next `reload` that includes it, giving every retry a fair
    /// shot. Empty return = every binding in `bindings` is now armed.
    @discardableResult
    func reload(_ bindings: [ShortcutBinding]) -> [ShortcutBinding] {
        let current = entries.values.map(\.binding)
        let diff = reloadDiff(old: current, new: bindings)
        for binding in diff.toRemove {
            unregister(binding)
        }
        return diff.toAdd.filter { !register($0) }
    }

    /// Full teardown: every armed hotkey unregistered, the shared event handler removed.
    /// Idempotent — a no-op once already empty.
    func unregisterAll() {
        for entry in entries.values {
            UnregisterEventHotKey(entry.ref)
        }
        entries.removeAll()
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
    }

    private func unregister(_ binding: ShortcutBinding) {
        guard let id = entries.first(where: { $0.value.binding == binding })?.key,
              let entry = entries[id] else { return }
        UnregisterEventHotKey(entry.ref)
        entries.removeValue(forKey: id)
    }

    /// Returns `true` on a successful `RegisterEventHotKey` (recorded in `entries`), `false` on
    /// failure (nothing recorded — see `reload(_:)`'s doc comment on why that matters for retries).
    @discardableResult
    private func register(_ binding: ShortcutBinding) -> Bool {
        if handlerRef == nil {
            var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), Self.handler, 1, &eventSpec, nil, &handlerRef)
        }
        let id = nextId
        nextId += 1
        let hotKeyID = EventHotKeyID(signature: Self.signature, id: id)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(binding.keyCode, binding.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        if status == noErr, let ref {
            entries[id] = (ref, binding)
            return true
        } else {
            // Common culprits: another app holds the same combo, or the OS reserved it as a
            // system shortcut (same note as `HotkeyTrigger`'s own failure log).
            NSLog("[ShortcutRegistry] RegisterEventHotKey failed status=\(status) pluginId=\(binding.pluginId) shortcutId=\(binding.shortcutId) keyCode=\(binding.keyCode) modifiers=\(binding.modifiers)")
            return false
        }
    }
}

// MARK: - Pure helpers (no Carbon calls made — testable directly, no live event tap needed)

/// Diff powering `reload(_:)`: which of `old` needs unregistering (missing/changed in `new`) and
/// which of `new` needs registering (missing/changed from `old`). Equality is on the WHOLE
/// binding (keyCode/modifiers included) — a rebind of the same plugin+shortcut to a different key
/// is a remove-then-add, not a no-op, since the Carbon registration itself is keyed by the key
/// combo, not the plugin id.
func reloadDiff(
    old: [ShortcutBinding],
    new: [ShortcutBinding]
) -> (toRemove: [ShortcutBinding], toAdd: [ShortcutBinding]) {
    let oldSet = Set(old)
    let newSet = Set(new)
    return (
        old.filter { !newSet.contains($0) },
        new.filter { !oldSet.contains($0) }
    )
}

/// Human-readable "⌃⌥K"-style label for a key code + modifier mask — used by the (later) shortcut
/// editor UI to display a binding. Modifier order follows Apple's own menu-shortcut convention:
/// Control, Option, Shift, Command, immediately followed by the key.
func shortcutDisplayString(keyCode: UInt32, modifiers: UInt32) -> String {
    var symbols = ""
    if modifiers & UInt32(controlKey) != 0 { symbols += "\u{2303}" } // ⌃
    if modifiers & UInt32(optionKey) != 0 { symbols += "\u{2325}" } // ⌥
    if modifiers & UInt32(shiftKey) != 0 { symbols += "\u{21E7}" } // ⇧
    if modifiers & UInt32(cmdKey) != 0 { symbols += "\u{2318}" } // ⌘
    return symbols + keyDisplayName(keyCode)
}

/// Named-key display text for the common keys a plugin shortcut is likely bound to; anything
/// outside this table falls back to a raw `Key<code>` label rather than guessing.
func keyDisplayName(_ keyCode: UInt32) -> String {
    switch Int(keyCode) {
    case kVK_ANSI_A: return "A"
    case kVK_ANSI_B: return "B"
    case kVK_ANSI_C: return "C"
    case kVK_ANSI_D: return "D"
    case kVK_ANSI_E: return "E"
    case kVK_ANSI_F: return "F"
    case kVK_ANSI_G: return "G"
    case kVK_ANSI_H: return "H"
    case kVK_ANSI_I: return "I"
    case kVK_ANSI_J: return "J"
    case kVK_ANSI_K: return "K"
    case kVK_ANSI_L: return "L"
    case kVK_ANSI_M: return "M"
    case kVK_ANSI_N: return "N"
    case kVK_ANSI_O: return "O"
    case kVK_ANSI_P: return "P"
    case kVK_ANSI_Q: return "Q"
    case kVK_ANSI_R: return "R"
    case kVK_ANSI_S: return "S"
    case kVK_ANSI_T: return "T"
    case kVK_ANSI_U: return "U"
    case kVK_ANSI_V: return "V"
    case kVK_ANSI_W: return "W"
    case kVK_ANSI_X: return "X"
    case kVK_ANSI_Y: return "Y"
    case kVK_ANSI_Z: return "Z"
    case kVK_ANSI_0: return "0"
    case kVK_ANSI_1: return "1"
    case kVK_ANSI_2: return "2"
    case kVK_ANSI_3: return "3"
    case kVK_ANSI_4: return "4"
    case kVK_ANSI_5: return "5"
    case kVK_ANSI_6: return "6"
    case kVK_ANSI_7: return "7"
    case kVK_ANSI_8: return "8"
    case kVK_ANSI_9: return "9"
    case kVK_Space: return "Space"
    case kVK_Return: return "\u{21A9}" // ↩
    case kVK_Tab: return "\u{21E5}" // ⇥
    case kVK_Delete: return "\u{232B}" // ⌫
    case kVK_Escape: return "\u{238B}" // ⎋
    case kVK_LeftArrow: return "\u{2190}" // ←
    case kVK_RightArrow: return "\u{2192}" // →
    case kVK_UpArrow: return "\u{2191}" // ↑
    case kVK_DownArrow: return "\u{2193}" // ↓
    case kVK_F1: return "F1"
    case kVK_F2: return "F2"
    case kVK_F3: return "F3"
    case kVK_F4: return "F4"
    case kVK_F5: return "F5"
    case kVK_F6: return "F6"
    case kVK_F7: return "F7"
    case kVK_F8: return "F8"
    case kVK_F9: return "F9"
    case kVK_F10: return "F10"
    case kVK_F11: return "F11"
    case kVK_F12: return "F12"
    default: return "Key\(keyCode)"
    }
}

/// Deliberate duplicate of `HotkeyTrigger.swift`/`PeripheralProvider.swift`'s own private
/// `String.fourCharCodeValue` extension (each `private` to its own file) — a four-line helper,
/// not worth widening either unrelated file's access level for.
private extension String {
    var fourCharCodeValue: UInt32 {
        var result: UInt32 = 0
        for scalar in utf8.prefix(4) {
            result = (result << 8) + UInt32(scalar)
        }
        return result
    }
}
