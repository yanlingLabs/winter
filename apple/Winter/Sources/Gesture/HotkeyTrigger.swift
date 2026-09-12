import AppKit
import Carbon.HIToolbox
import Foundation

@MainActor
final class HotkeyTrigger {
    static let shared = HotkeyTrigger()

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    // Default binding is "Hyper + Space" (Cmd + Ctrl + Opt + Space). The
    // previous default (Ctrl + Opt + Space) collided with the macOS system
    // shortcut "Select the previous input source" on most keyboard layouts,
    // so the trigger silently ate the user's intent. The hyper-style combo
    // is a near-guaranteed no-op in macOS by default, so it's safe to ship
    // as the factory default. Users can still remap via `update(...)`.
    private var currentSpec: (keyCode: UInt32, modifiers: UInt32) = (
        49,
        UInt32(cmdKey | controlKey | optionKey)
    )

    private static let signature = "AIPT".fourCharCodeValue

    /// `HotkeyTrigger`'s `InstallEventHandler` sits on the same shared `GetApplicationEventTarget()`
    /// dispatch chain as `PeripheralProvider`'s panic handler and `ShortcutRegistry`'s plugin-shortcut
    /// handler, so it can be handed hotkey-pressed events that aren't its own. Verify the fired
    /// `EventHotKeyID.signature` before firing, and return `eventNotHandledErr` (not `noErr`) for
    /// anything not `"AIPT"`, so the chain's other handlers still get a chance at it — same pattern
    /// as `ShortcutRegistry.handler`.
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
        guard hotKeyID.signature == HotkeyTrigger.signature else {
            return OSStatus(eventNotHandledErr)
        }
        DispatchQueue.main.async {
            TriggerHub.shared.fire(from: "hotkey")
        }
        return noErr
    }

    func start(keyCode: UInt32? = nil, modifiers: UInt32? = nil) {
        guard hotKeyRef == nil, handlerRef == nil else { return }

        if let keyCode {
            currentSpec.keyCode = keyCode
        }
        if let modifiers {
            currentSpec.modifiers = modifiers
        }

        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: OSType(kEventHotKeyPressed)
        )

        InstallEventHandler(
            GetApplicationEventTarget(),
            Self.handler,
            1,
            &eventSpec,
            nil,
            &handlerRef
        )

        let hotKeyID = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(
            currentSpec.keyCode,
            currentSpec.modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        if status != noErr {
            // Common culprits: another app holds the same combo (Alfred,
            // Raycast, Spotlight), or the OS reserved it as a system
            // shortcut. Log so the user can find out instead of the trigger
            // silently never firing.
            NSLog("[HotkeyTrigger] RegisterEventHotKey failed status=\(status) keyCode=\(currentSpec.keyCode) modifiers=\(currentSpec.modifiers)")
        }
    }

    func stop() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
    }

    func update(keyCode: UInt32, modifiers: UInt32) {
        stop()
        currentSpec = (keyCode, modifiers)
        start()
    }
}

private extension String {
    var fourCharCodeValue: UInt32 {
        var result: UInt32 = 0
        for scalar in utf8.prefix(4) {
            result = (result << 8) + UInt32(scalar)
        }
        return result
    }
}
