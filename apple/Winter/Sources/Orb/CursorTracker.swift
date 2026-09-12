import AppKit

@MainActor
final class CursorTracker {
    var onLocationChange: ((CGPoint) -> Void)?

    private var monitors: [Any] = []

    func start() {
        guard monitors.isEmpty else { return }

        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        let handler: (NSEvent) -> Void = { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.onLocationChange?(NSEvent.mouseLocation)
            }
        }

        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: handler) {
            monitors.append(monitor)
        }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.onLocationChange?(NSEvent.mouseLocation)
            return event
        }) {
            monitors.append(monitor)
        }

        onLocationChange?(NSEvent.mouseLocation)
    }

    func stop() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }
}
