import AppKit
import ApplicationServices

/// v1 port (GlassFieldWindow.swift ExternalFocusSnapshot, verbatim): captures the frontmost
/// external app + its focused AX window before the field steals key focus, then restores both
/// on collapse. Self-contained — AppKit + ApplicationServices only.
struct ExternalFocusSnapshot {
    let processIdentifier: pid_t
    let focusedWindow: AXUIElement?

    static func captureCurrent() -> ExternalFocusSnapshot? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = app.processIdentifier
        guard pid != getpid() else { return nil }
        if app.bundleIdentifier == Bundle.main.bundleIdentifier {
            return nil
        }

        return ExternalFocusSnapshot(
            processIdentifier: pid,
            focusedWindow: focusedWindow(for: pid)
        )
    }

    func restore() {
        guard processIdentifier != getpid(),
              let app = NSRunningApplication(processIdentifier: processIdentifier),
              !app.isTerminated else {
            return
        }

        focusWindowIfPossible()
        if #available(macOS 14.0, *) {
            app.activate(options: [])
        } else if !app.activate(options: []) {
            app.activate(options: [.activateIgnoringOtherApps])
        }
        focusWindowIfPossible()
    }

    private static func focusedWindow(for pid: pid_t) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }

        let appElement = AXUIElementCreateApplication(pid)
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedWindowAttribute as CFString,
            &focusedRef
        ) == .success,
        let focusedRef else {
            return nil
        }

        return unsafeDowncast(focusedRef, to: AXUIElement.self)
    }

    private func focusWindowIfPossible() {
        guard AXIsProcessTrusted(), let focusedWindow else { return }

        let appElement = AXUIElementCreateApplication(processIdentifier)
        AXUIElementSetAttributeValue(
            appElement,
            kAXFocusedWindowAttribute as CFString,
            focusedWindow
        )
        AXUIElementSetAttributeValue(
            focusedWindow,
            kAXMainAttribute as CFString,
            kCFBooleanTrue
        )
        AXUIElementSetAttributeValue(
            focusedWindow,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        AXUIElementPerformAction(focusedWindow, kAXRaiseAction as CFString)
    }
}
