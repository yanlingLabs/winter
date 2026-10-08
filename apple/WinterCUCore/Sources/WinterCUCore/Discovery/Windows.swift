import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// One window-server window, from `CGWindowListCopyWindowInfo`. Frames are global screen points, top-left
/// origin. Titles need Screen Recording; without it they read empty.
struct CUWindowServerWindow: Sendable, Equatable {
    var id: UInt32
    var pid: pid_t
    var ownerName: String
    var title: String
    var frame: CGRect
    var layer: Int
    var onScreen: Bool
    var alpha: Double
}

enum CUWindowServer {
    /// Every normal (layer 0) window, front to back. `onScreenOnly` skips minimized and other-Space windows.
    static func windows(onScreenOnly: Bool = false, includeOtherLayers: Bool = false) -> [CUWindowServerWindow] {
        let options: CGWindowListOption = onScreenOnly
            ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return raw.compactMap { d -> CUWindowServerWindow? in
            guard let id = (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let boundsDict = d[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { return nil }
            let layer = (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            if !includeOtherLayers, layer != 0 { return nil }
            return CUWindowServerWindow(
                id: id, pid: pid,
                ownerName: d[kCGWindowOwnerName as String] as? String ?? "",
                title: d[kCGWindowName as String] as? String ?? "",
                frame: bounds, layer: layer,
                onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        }
    }

    static func window(id: UInt32) -> CUWindowServerWindow? {
        guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let d = raw.first,
              let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let boundsDict = d[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { return nil }
        return CUWindowServerWindow(
            id: id, pid: pid, ownerName: d[kCGWindowOwnerName as String] as? String ?? "",
            title: d[kCGWindowName as String] as? String ?? "", frame: bounds,
            layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
            onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
            alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }

    /// A cheap fingerprint of a pid's window list (ids, frames, layers) — includes sheets, popovers and menus,
    /// which are windows of their own. Used by the settle loop.
    static func signature(pid: pid_t) -> Int {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return 0 }
        var h = Hasher()
        for d in raw where (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid {
            h.combine((d[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0)
            h.combine((d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0)
            if let b = d[kCGWindowBounds as String] as? NSDictionary,
               let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
                h.combine(Int(r.origin.x)); h.combine(Int(r.origin.y))
                h.combine(Int(r.size.width)); h.combine(Int(r.size.height))
            }
        }
        return h.finalize()
    }

    /// The front-most normal window whose frame contains `point`, skipping the helper's own windows.
    static func topWindow(at point: CGPoint, excludingPid: pid_t = getpid()) -> CUWindowServerWindow? {
        windows(onScreenOnly: true).first { $0.pid != excludingPid && $0.alpha > 0 && $0.frame.contains(point) }
    }
}

/// AX windows of an app, paired with their window-server ids.
struct CUAXWindow {
    var element: AXUIElement
    var id: UInt32
    var title: String
    var frame: CGRect
    var focused: Bool
    var main: Bool
}

enum CUAXWindows {
    /// The app's AX windows with ids: `_AXUIElementGetWindow` when available, else matched to the window
    /// server's list by frame (and title when both have one).
    static func list(pid: pid_t) -> [CUAXWindow] {
        let app = AX.app(pid)
        let focused = AX.element(app, kAXFocusedWindowAttribute)
        let main = AX.element(app, kAXMainWindowAttribute)
        let server = CUWindowServer.windows().filter { $0.pid == pid }
        var used = Set<UInt32>()
        var out: [CUAXWindow] = []
        for w in AX.elements(app, kAXWindowsAttribute) {
            let frame = AX.frame(w) ?? .zero
            let title = AX.string(w, kAXTitleAttribute) ?? ""
            var id = AX.windowID(w)
            if id == nil {
                id = server.first { s in
                    !used.contains(s.id) && abs(s.frame.minX - frame.minX) < 2 && abs(s.frame.minY - frame.minY) < 2
                        && abs(s.frame.width - frame.width) < 2 && abs(s.frame.height - frame.height) < 2
                        && (s.title.isEmpty || title.isEmpty || s.title == title)
                }?.id
            }
            guard let wid = id else { continue }
            used.insert(wid)
            out.append(CUAXWindow(element: w, id: wid, title: title, frame: frame,
                                  focused: focused.map { CFEqual($0, w) } ?? false,
                                  main: main.map { CFEqual($0, w) } ?? false))
        }
        return out
    }

    /// The requested window, else the main one, else the focused one, else the first.
    static func choose(_ windows: [CUAXWindow], selector: CUWindowSelector?) throws -> CUAXWindow {
        if let selector {
            switch selector {
            case .id(let id):
                if let w = windows.first(where: { $0.id == id }) { return w }
                throw CUError.invalidParams("this app has no window \(id)")
            case .title(let t):
                let want = t.lowercased()
                if let w = windows.first(where: { $0.title.lowercased() == want })
                    ?? windows.first(where: { $0.title.lowercased().contains(want) }) { return w }
                let have = windows.map { "“\($0.title)”" }.joined(separator: ", ")
                throw CUError.invalidParams("no window titled “\(t)” — windows: \(have.isEmpty ? "none" : have)")
            }
        }
        if let w = windows.first(where: \.main) ?? windows.first(where: \.focused) ?? windows.first { return w }
        throw CUError.targetLost("the app has no window")
    }
}
