import AppKit
import Carbon.HIToolbox
import NormaKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// Pure helpers (Task 4, 4d-iii) — no NormaClient/AppKit involved, table-tested directly.
// -----------------------------------------------------------------------------------------------

/// True when `new` shares its (keyCode, modifiers) combo with a DIFFERENT (pluginId, shortcutId)
/// already present in `existing` — two distinct shortcuts can't both be armed on the same Carbon
/// hotkey (`RegisterEventHotKey` has no notion of "the second registrant wins"; the OS itself would
/// only deliver the event to one of them). Deliberately NOT a conflict when `new` shares its
/// IDENTITY (same pluginId AND shortcutId) with an existing entry — that's a rebind (or a no-op
/// reapply of the exact same binding), not a collision, even though `existing` may still contain
/// that pair's OLD keybinding at check time (the caller hasn't removed/replaced it yet).
func bindingConflict(existing: [ShortcutBinding], new: ShortcutBinding) -> Bool {
    existing.contains { candidate in
        candidate.keyCode == new.keyCode
            && candidate.modifiers == new.modifiers
            && (candidate.pluginId != new.pluginId || candidate.shortcutId != new.shortcutId)
    }
}

/// AppKit `NSEvent.ModifierFlags` → the Carbon modifier mask `ShortcutBinding`/`RegisterEventHotKey`
/// expect (`controlKey`/`optionKey`/`shiftKey`/`cmdKey`, Carbon.HIToolbox — same constants
/// `ShortcutRegistry.swift`'s `shortcutDisplayString` reads back). PURE — no view/event-tap
/// involved — so it's directly testable without a live keypress.
func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
    var result: UInt32 = 0
    if flags.contains(.control) { result |= UInt32(controlKey) }
    if flags.contains(.option) { result |= UInt32(optionKey) }
    if flags.contains(.shift) { result |= UInt32(shiftKey) }
    if flags.contains(.command) { result |= UInt32(cmdKey) }
    return result
}

/// True when `modifiers` includes at least one of the three modifiers a GLOBAL Carbon hotkey
/// actually needs to be safe to arm: control, option, or command. Shift alone (or no modifier at
/// all) is too weak — a modifier-less or shift-only capture would register a hotkey that swallows
/// an ordinary keystroke (or Escape) system-wide, not just while Norma's window is focused.
/// `ShortcutBindingEditorModel.capture(...)` rejects any candidate that fails this before it ever
/// reaches `bindingConflict`. PURE — directly testable, same posture as `bindingConflict` above.
func hasRequiredModifier(_ modifiers: UInt32) -> Bool {
    modifiers & UInt32(controlKey | optionKey | cmdKey) != 0
}

/// Norma's own two global hotkeys, read straight off their owning files (not guessed): the summon
/// combo — `HotkeyTrigger.swift`'s hardcoded default, keyCode `49` (`kVK_Space`) +
/// `cmdKey | controlKey | optionKey`; `AppDelegate.boot()` always calls
/// `HotkeyTrigger.shared.start()` with no arguments, so there is no live remap to read — this IS
/// the current binding — and the panic combo — `PeripheralProvider.swift`'s
/// `registerPanicHotkey()`, `kVK_Escape` + `controlKey | optionKey | cmdKey`, likewise fixed,
/// never remapped.
private let summonReservedCombo: (keyCode: UInt32, modifiers: UInt32) = (
    UInt32(kVK_Space), UInt32(cmdKey | controlKey | optionKey)
)
private let panicReservedCombo: (keyCode: UInt32, modifiers: UInt32) = (
    UInt32(kVK_Escape), UInt32(controlKey | optionKey | cmdKey)
)

/// True when `(keyCode, modifiers)` matches one of Norma's own reserved global hotkeys above.
/// Binding a plugin shortcut to either would silently shadow it the moment it's armed — shadowing
/// panic specifically is a safety issue (the user's one guaranteed hard-stop), not just an
/// inconvenience. The panic entry here is defense-in-depth for the PERSISTED-binding path: a live
/// Escape keypress during capture is already caught earlier by `KeyCaptureNSView.keyDown`'s
/// unconditional Escape-cancels-the-capture rule below, so it can never reach this check via a real
/// keypress — but a binding could still arrive here some other way (e.g. a future import/restore
/// path), so the guard stays. PURE — directly testable, no live event tap needed, same posture as
/// `bindingConflict` above.
func isReservedCombo(keyCode: UInt32, modifiers: UInt32) -> Bool {
    (keyCode == summonReservedCombo.keyCode && modifiers == summonReservedCombo.modifiers)
        || (keyCode == panicReservedCombo.keyCode && modifiers == panicReservedCombo.modifiers)
}

// -----------------------------------------------------------------------------------------------
// ShortcutBindingEditorModel — the pane's live view-model for the shortcut list (same
// `@MainActor`/`ObservableObject` posture as `PluginManagerModel`/`TilesStripModel`, and the same
// "model owns `client` directly" exception this pane already established — see
// `PluginManagerModel`'s own doc comment on the mountable-pane contract).
// -----------------------------------------------------------------------------------------------

@MainActor
final class ShortcutBindingEditorModel: ObservableObject {
    /// One row: a plugin's DECLARED shortcut id (from `pluginsContrib().shortcuts`) plus whatever
    /// binding is currently persisted for it (`nil` = unbound).
    struct Row: Identifiable, Equatable {
        var id: String { "\(pluginId)#\(shortcutId)" }
        let pluginId: String
        let shortcutId: String
        let description: String?
        let defaultKeybinding: String?
        var binding: ShortcutBinding?
    }

    private let client: NormaClient
    /// `nil` under unit tests (`AppDelegate.boot()` only constructs a real `ShortcutRegistry`
    /// outside `!isRunningUnitTests`) — `capture(...)` still persists the binding either way; only
    /// the live Carbon re-registration is skipped when this is `nil`. Typed as the
    /// `ShortcutHotkeyReloading` seam (not the concrete `ShortcutRegistry`) so
    /// `testCaptureSurfacesArmFailure...` (`ShortcutBindingEditorTests.swift`) can inject a fake
    /// that scripts a failed-arm result without touching real Carbon.
    private let shortcutRegistry: (any ShortcutHotkeyReloading)?
    private let defaults: UserDefaults

    @Published private(set) var rows: [Row] = []
    /// Set by `capture(...)` when the candidate binding collides with a DIFFERENT shortcut's combo,
    /// fails the modifier/reserved-combo gates, OR (Phase 4d-cleanup Task 3 fix 2) the live
    /// `ShortcutRegistry` reports the just-captured binding failed to arm — cleared on the next
    /// successful-and-armed capture. The view surfaces this as an inline message.
    @Published var conflictMessage: String?

    init(client: NormaClient, shortcutRegistry: (any ShortcutHotkeyReloading)?, defaults: UserDefaults = .standard) {
        self.client = client
        self.shortcutRegistry = shortcutRegistry
        self.defaults = defaults
    }

    func refresh() async {
        guard let entries = try? await client.pluginsContrib() else { return }
        let bindings = ShortcutSettingsStore.load(from: defaults)
        rows = entries.flatMap { entry in
            entry.shortcuts.map { shortcut in
                Row(
                    pluginId: entry.pluginId,
                    shortcutId: shortcut.id,
                    description: shortcut.description,
                    defaultKeybinding: shortcut.defaultKeybinding,
                    binding: bindings.first { $0.pluginId == entry.pluginId && $0.shortcutId == shortcut.id }
                )
            }
        }
    }

    /// The key-capture control's callback. Three gates, in order, before anything is persisted:
    /// (1) `hasRequiredModifier` — reject a modifier-less or shift-only combo outright (a real
    /// keypress can still reach here with `modifiers == 0`/shift-only since `KeyCaptureNSView` only
    /// special-cases Escape, not weak modifiers — see that view's doc comment); (2) `isReservedCombo`
    /// — reject a combo that shadows Norma's own summon/panic hotkeys; (3) `bindingConflict` — the
    /// pre-existing conflict check against every OTHER (pluginId, shortcutId)'s persisted binding.
    /// Any rejection sets `conflictMessage` and changes nothing else. On success: replaces this
    /// pair's prior binding (if any) in the persisted list, saves, reloads the live
    /// `ShortcutRegistry`, and updates `rows` in place so the display string refreshes without a
    /// full `refresh()` round-trip.
    ///
    /// Phase 4d-cleanup Task 3 fix 2: the persisted save always happens (a plugin author or the
    /// user may still want the intended binding remembered for a later retry — e.g. the app
    /// restarts, or the other app holding the combo quits), but if the live `reload(_:)` reports
    /// THIS pair's binding specifically failed to arm, `conflictMessage` is set to say so instead
    /// of being cleared — same inline-message surface as every other rejection above, just after
    /// persistence rather than instead of it.
    func capture(pluginId: String, shortcutId: String, keyCode: UInt32, modifiers: UInt32) {
        guard hasRequiredModifier(modifiers) else {
            conflictMessage = "Use a modifier combo like \u{2303}\u{2325}K."
            return
        }
        guard !isReservedCombo(keyCode: keyCode, modifiers: modifiers) else {
            conflictMessage = "That combo is reserved by Norma."
            return
        }
        let candidate = ShortcutBinding(pluginId: pluginId, shortcutId: shortcutId, keyCode: keyCode, modifiers: modifiers)
        var bindings = ShortcutSettingsStore.load(from: defaults)
        guard !bindingConflict(existing: bindings, new: candidate) else {
            conflictMessage = "That key combo is already bound to another shortcut."
            return
        }
        bindings.removeAll { $0.pluginId == pluginId && $0.shortcutId == shortcutId }
        bindings.append(candidate)
        ShortcutSettingsStore.save(bindings, to: defaults)
        let failed = shortcutRegistry?.reload(bindings) ?? []
        if failed.contains(candidate) {
            conflictMessage = "Couldn't register \(shortcutDisplayString(keyCode: keyCode, modifiers: modifiers)) \u{2014} the key may be in use by another app."
        } else {
            conflictMessage = nil
        }
        if let idx = rows.firstIndex(where: { $0.pluginId == pluginId && $0.shortcutId == shortcutId }) {
            rows[idx].binding = candidate
        }
    }
}

// -----------------------------------------------------------------------------------------------
// KeyCaptureControl — a small AppKit-backed "click, then press a key" capture (SwiftUI has no
// native primitive for "record the next keypress"). LIVE-gate item (a real keyDown needs a live
// event tap) — `carbonModifiers` above is this file's testable core; this view is deliberately
// thin around it.
// -----------------------------------------------------------------------------------------------

final class KeyCaptureNSView: NSView {
    var label: String = "" { didSet { needsDisplay = true } }
    var onCapture: ((UInt32, UInt32) -> Void)?
    private var isCapturing = false { didSet { needsDisplay = true } }

    override var acceptsFirstResponder: Bool { true }

    override func mouseDown(with event: NSEvent) {
        isCapturing = true
        window?.makeFirstResponder(self)
    }

    override func keyDown(with event: NSEvent) {
        guard isCapturing else {
            // Not capturing — this isn't ours to swallow; a stray keystroke while this view
            // happens to retain first responder outside an active capture must still reach the
            // normal responder chain.
            super.keyDown(with: event)
            return
        }
        isCapturing = false
        // Escape backs OUT of capture rather than becoming the binding — unconditionally, not just
        // when bare. Without this, "click to set" then Esc-to-back-out registers a modifier-less
        // GLOBAL Carbon hotkey on Escape (`onCapture?(53, 0)`), which — before it's even rejected
        // downstream by `hasRequiredModifier` — has already primed the exact combo `isReservedCombo`
        // guards against for the panic hotkey. No persistence, no callback, full stop.
        guard UInt32(event.keyCode) != UInt32(kVK_Escape) else { return }
        onCapture?(UInt32(event.keyCode), carbonModifiers(from: event.modifierFlags))
    }

    override func resignFirstResponder() -> Bool {
        isCapturing = false
        return super.resignFirstResponder()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        let path = NSBezierPath(roundedRect: bounds, xRadius: 4, yRadius: 4)
        path.fill()
        NSColor.separatorColor.setStroke()
        path.lineWidth = 1
        path.stroke()
        let text = isCapturing ? "Press a key…" : (label.isEmpty ? "Click to set" : label)
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: isCapturing ? NSColor.controlAccentColor : NSColor.labelColor,
            .font: Typography.shortcutKeyNS,
        ]
        let size = text.size(withAttributes: attrs)
        let rect = NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
        text.draw(in: rect, withAttributes: attrs)
    }
}

/// SwiftUI wrapper for `KeyCaptureNSView` — `label` is the current binding's display string (or
/// empty for "unbound"); `onCapture` fires once per captured keypress with `(keyCode, modifiers)`.
struct KeyCaptureControl: NSViewRepresentable {
    let label: String
    let onCapture: (UInt32, UInt32) -> Void

    func makeNSView(context: Context) -> KeyCaptureNSView {
        let view = KeyCaptureNSView()
        view.label = label
        view.onCapture = onCapture
        return view
    }

    func updateNSView(_ nsView: KeyCaptureNSView, context: Context) {
        nsView.label = label
        nsView.onCapture = onCapture
    }
}

// -----------------------------------------------------------------------------------------------
// ShortcutBindingEditor — the pane section: one row per declared plugin shortcut, each with a
// capture control showing its current binding (`shortcutDisplayString`, ShortcutRegistry.swift) or
// its manifest-declared default hint when unbound. Same adaptive-color/opaque-window idiom as the
// rest of `PluginManagerView`.
// -----------------------------------------------------------------------------------------------

struct ShortcutBindingEditor: View {
    @ObservedObject var model: ShortcutBindingEditorModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Shortcuts").font(Typography.label(.semibold)).foregroundStyle(.secondary)
            if let conflictMessage = model.conflictMessage {
                Text(conflictMessage).foregroundStyle(.red).font(Typography.caption())
            }
            if model.rows.isEmpty {
                Text("No plugin shortcuts declared").font(Typography.label()).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(model.rows) { row in
                        shortcutRow(row)
                    }
                }
            }
        }
        .task { await model.refresh() }
    }

    private func shortcutRow(_ row: ShortcutBindingEditorModel.Row) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.shortcutId).font(Typography.label(.medium))
                if let description = row.description {
                    Text(description).font(Typography.caption()).foregroundStyle(.secondary)
                }
            }
            Spacer()
            KeyCaptureControl(
                label: row.binding.map { shortcutDisplayString(keyCode: $0.keyCode, modifiers: $0.modifiers) }
                    ?? row.defaultKeybinding.map { "default: \($0)" } ?? "",
                onCapture: { keyCode, modifiers in
                    model.capture(pluginId: row.pluginId, shortcutId: row.shortcutId, keyCode: keyCode, modifiers: modifiers)
                }
            )
            .frame(width: 140, height: 24)
        }
    }
}
