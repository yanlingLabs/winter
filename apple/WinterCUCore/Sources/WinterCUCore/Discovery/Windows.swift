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
    /// server's list (`server`, the pid's windows) by frame and title. AX lists only windows on the current
    /// Space (minimized ones included); others come from `CUWindowResolver`.
    static func list(pid: pid_t, ax: CUAXBackend, server: [CUWindowServerWindow]) -> [CUAXWindow] {
        let app = ax.application(pid)
        let focused = ax.element(app, kAXFocusedWindowAttribute)
        let main = ax.element(app, kAXMainWindowAttribute)
        var used = Set<UInt32>()
        var out: [CUAXWindow] = []
        for w in ax.elements(app, kAXWindowsAttribute) {
            let frame = ax.frame(w) ?? .zero
            let title = ax.string(w, kAXTitleAttribute) ?? ""
            var id = ax.windowID(w)
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
    static func choose(_ windows: [CUAXWindow], selector: CUWindowSelector?, appName: String = "The app") throws -> CUAXWindow {
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
        throw CUError.noWindow(appName)
    }
}

/// Which window a bind gets when the obvious ones aren't usable (pure; every effect is injected).
///
/// AX lists only windows on the current Space. A window the window server has but AX doesn't is on another
/// Space or in full screen. In order:
/// 0. use it where it is: its AX element by remote token (private, `privatePath`) — state, find, screenshots,
///    AX actions and text work there with no move;
/// a. move it to this desktop (SkyLight, `privatePath`), then wait for AX to list it;
/// b. open a new window (File → New Window / ⌘N) and bind that — only when no specific window was asked for;
/// otherwise `window_elsewhere`. An app with no window at all gets (b), then `no_window`.
enum CUWindowResolver {
    struct Outcome {
        var window: CUAXWindow
        var detail: String?
    }

    struct Effects {
        /// AX element of an off-Space window by remote token.
        var remote: (UInt32) -> AXUIElement?
        /// Builds the window record for a remote element (title/frame from AX, else from the server).
        var describe: (AXUIElement, CUWindowServerWindow) -> CUAXWindow
        var moveToActiveSpace: (UInt32) -> Bool
        /// Asks the app for a new window; true when the request was sent.
        var openNewWindow: () -> Bool
        /// The AX windows now.
        var axWindows: () -> [CUAXWindow]
        /// Polls `probe` until it answers or a few seconds pass.
        var wait: (() -> CUAXWindow?) -> CUAXWindow?
    }

    static func resolve(appName: String, axWindows: [CUAXWindow], server: [CUWindowServerWindow],
                        selector: CUWindowSelector?, privatePath: Bool, _ fx: Effects) throws -> Outcome {
        let listed = Set(axWindows.map(\.id))
        let offSpace = server.filter { $0.layer == 0 && !listed.contains($0.id) }
        if let selector {
            if let w = try? CUAXWindows.choose(axWindows, selector: selector, appName: appName) { return Outcome(window: w) }
            let match: CUWindowServerWindow? = {
                switch selector {
                case .id(let id): return offSpace.first { $0.id == id }
                case .title(let t):
                    let want = t.lowercased()
                    return offSpace.first { $0.title.lowercased() == want } ?? offSpace.first { !$0.title.isEmpty && $0.title.lowercased().contains(want) }
                }
            }()
            guard let match else { return Outcome(window: try CUAXWindows.choose(axWindows, selector: selector, appName: appName)) }
            return try reach([match], appName: appName, privatePath: privatePath, allowNewWindow: false, fx)
        }
        if !axWindows.isEmpty { return Outcome(window: try CUAXWindows.choose(axWindows, selector: nil, appName: appName)) }
        return try reach(offSpace, appName: appName, privatePath: privatePath, allowNewWindow: true, fx)
    }

    private static func reach(_ candidates: [CUWindowServerWindow], appName: String, privatePath: Bool,
                              allowNewWindow: Bool, _ fx: Effects) throws -> Outcome {
        if privatePath {
            for s in candidates {
                if let element = fx.remote(s.id) {
                    return Outcome(window: fx.describe(element, s),
                                   detail: "bound \(appName)'s window where it is (another Space or full screen); pointer actions will move it to this desktop")
                }
            }
            for s in candidates where fx.moveToActiveSpace(s.id) {
                if let w = fx.wait({ fx.axWindows().first { $0.id == s.id } }) {
                    return Outcome(window: w, detail: "moved \(appName)'s window to this desktop from another Space")
                }
            }
        }
        if allowNewWindow {
            let before = Set(fx.axWindows().map(\.id))
            if fx.openNewWindow(), let w = fx.wait({ fx.axWindows().first { !before.contains($0.id) } }) {
                let why = candidates.isEmpty ? "" : "; the existing one is on another Space or in full screen"
                return Outcome(window: w, detail: "opened a new \(appName) window\(why)")
            }
        }
        throw candidates.isEmpty ? CUError.noWindow(appName) : CUError.windowElsewhere(appName)
    }
}
