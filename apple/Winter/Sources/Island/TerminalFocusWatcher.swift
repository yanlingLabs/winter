import AppKit
import ApplicationServices

/// While a card is HIDDEN because its terminal is in front, a switch to another tab or window of that same terminal app
/// raises no app-activation notification. This watches the frontmost app's focused-window and title changes through an
/// `AXObserver` — only then (`update(watching: true, …)`), only with Accessibility trust, read-only — and says so,
/// coalesced to one call per run-loop turn. Nothing is installed otherwise.
@MainActor
final class TerminalFocusWatcher {
    var onChange: (() -> Void)?

    private var observer: AXObserver?
    private var pid: pid_t?
    private var pending = false

    var isWatchingForTesting: Bool { observer != nil }

    func update(watching: Bool, frontPid: pid_t?) {
        guard watching, let frontPid, frontPid != getpid(), AXIsProcessTrusted() else { stop(); return }
        if pid == frontPid, observer != nil { return }
        stop()
        install(frontPid)
    }

    func stop() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        pid = nil
    }

    private func install(_ pid: pid_t) {
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let watcher = Unmanaged<TerminalFocusWatcher>.fromOpaque(refcon).takeUnretainedValue()
            MainActor.assumeIsolated { watcher.fire() }
        }
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.1)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        for name in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXTitleChangedNotification] {
            _ = AXObserverAddNotification(created, app, name as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        self.pid = pid
    }

    private func fire() {
        guard !pending else { return }
        pending = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.pending = false
                self?.onChange?()
            }
        }
    }
}
