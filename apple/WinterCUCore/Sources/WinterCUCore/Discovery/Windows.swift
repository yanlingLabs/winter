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

/// One window's window-server description, by id.
public enum CUWindowLookup {
    /// `.optionIncludingWindow` first (one window, cheap). That call leaves out some windows that exist: a
    /// full-screen window on another Space came back empty there while the full `.optionAll` listing had it,
    /// on screen false. So an empty answer is checked against the full listing before it reads as gone.
    public static func description(of id: CGWindowID) -> [String: Any]? {
        func matches(_ d: [String: Any]) -> Bool { (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
        if let one = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first(where: matches) {
            return one
        }
        return (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]])?.first(where: matches)
    }

    /// The window's frame in global screen points (top-left origin), or nil when it is gone.
    public static func frame(of id: CGWindowID) -> CGRect? {
        guard let bounds = description(of: id)?[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
    }

    /// Whether the window server has the window on screen (false: another Space, full screen elsewhere,
    /// minimized or hidden), or nil when it is gone.
    public static func isOnScreen(_ id: CGWindowID) -> Bool? {
        guard let d = description(of: id) else { return nil }
        return (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
    }
}

enum CUWindowServer {
    /// Every normal (layer 0) window, front to back. `onScreenOnly` skips minimized and other-Space windows.
    static func windows(onScreenOnly: Bool = false, includeOtherLayers: Bool = false,
                        excludeDesktop: Bool = true) -> [CUWindowServerWindow] {
        var options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly] : [.optionAll]
        if excludeDesktop { options.insert(.excludeDesktopElements) }
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
        guard let d = CUWindowLookup.description(of: id),
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

    /// A window a person would call one: normal layer, visible, at least 100×100 pt. Apps keep untitled
    /// layer-0 strips and stubs (Safari's and Finder's 1512×33 menu-bar strips, a 64×64 drag window) that are
    /// never in AX: counted as windows, they were probed by remote token to the deadline, held binds waiting,
    /// and showed up in windows() as untitled entries.
    static func isRealWindow(_ w: CUWindowServerWindow) -> Bool {
        w.layer == 0 && w.alpha > 0 && w.frame.width >= 100 && w.frame.height >= 100
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
/// b. open a new window (File → New Window / ⌘N) and bind that — only when no specific window was asked for,
///    and at most once per session and app (`openNewWindow` answers false after that). A new window that
///    opens on the app's own Space instead of this one is reached where it is (0), never replaced by another;
/// otherwise `window_elsewhere`. An app with no window at all gets (b), then `no_window`.
enum CUWindowResolver {
    /// Which step reached the window (logged, and named in the bind's detail).
    enum Step: String {
        case onThisDesktop = "on this desktop"
        case whereItIs = "step 0, where it is"
        case moved = "step a, moved here"
        case newWindow = "step b, a new window"
        case captureOnly = "capture only (no accessibility)"
    }

    struct Outcome {
        var window: CUAXWindow
        var detail: String?
        var step: Step = .onThisDesktop
        /// The window server has it but accessibility cannot reach it: bound as capture-plus-coordinates
        /// (SkyLight stills for state/screenshots, window-targeted events for input), no AX tree.
        var captureOnly: Bool = false
    }

    struct Effects {
        /// AX elements of off-Space windows by remote token, by window id (one walk for all of them).
        var remote: ([UInt32]) -> [UInt32: AXUIElement]
        /// Builds the window record for a remote element (title/frame from AX, else from the server).
        var describe: (AXUIElement, CUWindowServerWindow) -> CUAXWindow
        var moveToActiveSpace: (UInt32) -> Bool
        /// Asks the app for a new window; true when the request was sent. False once this session already
        /// asked this app for one (never twice).
        var openNewWindow: () -> Bool
        /// The AX windows now.
        var axWindows: () -> [CUAXWindow]
        /// The app's window-server windows now.
        var serverWindows: () -> [CUWindowServerWindow]
        /// Polls `probe` until it answers or a few seconds pass.
        var wait: (() -> CUAXWindow?) -> CUAXWindow?
        /// A placeholder element (the application element) for a capture-only window, which has no AX element.
        var appElement: AXUIElement
    }

    /// A capture-only window record: the placeholder element, the server's id/title/frame.
    static func captureOnlyWindow(_ s: CUWindowServerWindow, appElement: AXUIElement) -> CUAXWindow {
        CUAXWindow(element: appElement, id: s.id, title: s.title, frame: s.frame, focused: false, main: false)
    }

    static func captureOnlyDetail(_ appName: String) -> String {
        "bound \(appName)'s window as capture only — it exposes no accessibility; read it with screenshot() and act by point coordinates (type and keys go to the window)"
    }

    static func resolve(appName: String, axWindows: [CUAXWindow], server: [CUWindowServerWindow],
                        selector: CUWindowSelector?, privatePath: Bool, _ fx: Effects) throws -> Outcome {
        let listed = Set(axWindows.map(\.id))
        let offSpace = server.filter { CUWindowServer.isRealWindow($0) && !listed.contains($0.id) }
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
            guard let match else {
                // Not AX-listed and not an off-Space real window — but the server may still have it (a popup or
                // a Unity window with an empty AX tree): bind capture-only when we can find it by id/title.
                if privatePath, let s = captureOnlyMatch(selector, server) {
                    return Outcome(window: captureOnlyWindow(s, appElement: fx.appElement), detail: captureOnlyDetail(appName),
                                   step: .captureOnly, captureOnly: true)
                }
                return Outcome(window: try CUAXWindows.choose(axWindows, selector: selector, appName: appName))
            }
            let reached = try? reach([match], appName: appName, privatePath: privatePath, allowNewWindow: false, fx)
            if let reached { return reached }
            if privatePath { return Outcome(window: captureOnlyWindow(match, appElement: fx.appElement), detail: captureOnlyDetail(appName), step: .captureOnly, captureOnly: true) }
            return try reach([match], appName: appName, privatePath: privatePath, allowNewWindow: false, fx)
        }
        if !axWindows.isEmpty { return Outcome(window: try CUAXWindows.choose(axWindows, selector: nil, appName: appName)) }
        return try reach(offSpace, appName: appName, privatePath: privatePath, allowNewWindow: true, fx)
    }

    /// A server window matching an explicit selector, for a capture-only bind (not limited to isRealWindow —
    /// a popup or dialog counts). Pure.
    static func captureOnlyMatch(_ selector: CUWindowSelector, _ server: [CUWindowServerWindow]) -> CUWindowServerWindow? {
        let real = server.filter { $0.layer == 0 && $0.alpha > 0 && $0.frame.width >= 1 && $0.frame.height >= 1 }
        switch selector {
        case .id(let id): return real.first { $0.id == id }
        case .title(let t):
            let want = t.lowercased()
            return real.first { $0.title.lowercased() == want } ?? real.first { !$0.title.isEmpty && $0.title.lowercased().contains(want) }
        }
    }

    static func whereItIsDetail(_ appName: String, newWindow: Bool = false) -> String {
        let which = newWindow ? "the new \(appName) window, which opened on another Space or in full screen" : "\(appName)'s window"
        return "step 0 (where it is): bound \(which) where it is; clicks on elements, scrolls, typing and keys work there, dragging needs it on this desktop"
    }

    private static func reach(_ candidates: [CUWindowServerWindow], appName: String, privatePath: Bool,
                              allowNewWindow: Bool, _ fx: Effects) throws -> Outcome {
        if privatePath, !candidates.isEmpty {
            let found = fx.remote(candidates.map(\.id))
            if let s = candidates.first(where: { found[$0.id] != nil }), let element = found[s.id] {
                return Outcome(window: fx.describe(element, s), detail: whereItIsDetail(appName), step: .whereItIs)
            }
            for s in candidates where fx.moveToActiveSpace(s.id) {
                if let w = fx.wait({ fx.axWindows().first { $0.id == s.id } }) {
                    return Outcome(window: w, detail: "step a (moved): moved \(appName)'s window to this desktop from another Space",
                                   step: .moved)
                }
            }
        }
        if allowNewWindow {
            let beforeAX = Set(fx.axWindows().map(\.id))
            let beforeServer = Set(fx.serverWindows().map(\.id)).union(candidates.map(\.id))
            if fx.openNewWindow() {
                if let w = fx.wait({ fx.axWindows().first { !beforeAX.contains($0.id) } }) {
                    let why = candidates.isEmpty ? "" : "; the existing one is on another Space or in full screen"
                    return Outcome(window: w, detail: "step b (new window): opened a new \(appName) window\(why)", step: .newWindow)
                }
                // It opened on the app's own Space, not this one: reach it there; never open another.
                let fresh = fx.serverWindows().filter { CUWindowServer.isRealWindow($0) && !beforeServer.contains($0.id) }
                if privatePath, !fresh.isEmpty {
                    let found = fx.remote(fresh.map(\.id))
                    if let s = fresh.first(where: { found[$0.id] != nil }), let element = found[s.id] {
                        return Outcome(window: fx.describe(element, s), detail: whereItIsDetail(appName, newWindow: true),
                                       step: .whereItIs)
                    }
                }
                if privatePath, let s = fresh.first ?? candidates.first {
                    return Outcome(window: captureOnlyWindow(s, appElement: fx.appElement), detail: captureOnlyDetail(appName), step: .captureOnly, captureOnly: true)
                }
                if candidates.isEmpty { throw CUError.noWindow(appName) }
                throw CUError.windowElsewhere(appName)
            }
        }
        if privatePath, let s = candidates.first { return Outcome(window: captureOnlyWindow(s, appElement: fx.appElement), detail: captureOnlyDetail(appName), step: .captureOnly, captureOnly: true) }
        throw candidates.isEmpty ? CUError.noWindow(appName) : CUError.windowElsewhere(appName)
    }
}

/// The window wait at the start of a bind (every effect injected). A just-launched app needs a moment, and AX
/// can lag a window already on screen, so it polls. The app is asked to reopen (most apps then open a window)
/// ONLY when the window server shows it no normal window anywhere — on no Space, minimized or not. A reopen
/// sent to an app whose windows are merely elsewhere makes it open a new one on every bind (a live run left
/// Safari with twelve); with windows elsewhere the bind goes straight to the resolver, which reaches them.
enum CUBindWait {


    struct Effects {
        /// The AX windows (this desktop) and the window-server windows (every Space) of the app.
        var read: () async throws -> ([CUAXWindow], [CUWindowServerWindow])
        var reopen: () async -> Void
        var sleep: (Double) async throws -> Void
        var now: () -> Double
    }

    struct Found {
        var ax: [CUAXWindow]
        var server: [CUWindowServerWindow]
        var reopened: Bool
    }

    /// The app's real windows anywhere (`CUWindowServer.isRealWindow`), on screen or not.
    static func realWindows(_ server: [CUWindowServerWindow]) -> [CUWindowServerWindow] {
        server.filter(CUWindowServer.isRealWindow)
    }

    static func run(launched: Bool, deadlineMs: Double, _ fx: Effects) async throws -> Found {
        var (ax, server) = try await fx.read()
        let end = fx.now() + deadlineMs
        var reopened = false
        while ax.isEmpty, fx.now() < end {
            let real = realWindows(server)
            // Every real window is off screen: another Space, full screen or minimized — nothing to wait for.
            if !real.isEmpty, real.allSatisfy({ !$0.onScreen }) { break }
            if real.isEmpty, !launched, !reopened {
                reopened = true
                await fx.reopen()
            }
            try await fx.sleep(100)
            (ax, server) = try await fx.read()
        }
        return Found(ax: ax, server: server, reopened: reopened)
    }
}
