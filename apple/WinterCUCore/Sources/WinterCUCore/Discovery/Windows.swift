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
    }

    struct Outcome {
        var window: CUAXWindow
        var detail: String?
        var step: Step = .onThisDesktop
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

    static func whereItIsDetail(_ appName: String, newWindow: Bool = false) -> String {
        let which = newWindow ? "the new \(appName) window, which opened on another Space or in full screen" : "\(appName)'s window"
        return "step 0 (where it is): bound \(which) where it is; pointer actions will try to move it to this desktop"
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
                let fresh = fx.serverWindows().filter { $0.layer == 0 && !beforeServer.contains($0.id) }
                if privatePath, !fresh.isEmpty {
                    let found = fx.remote(fresh.map(\.id))
                    if let s = fresh.first(where: { found[$0.id] != nil }), let element = found[s.id] {
                        return Outcome(window: fx.describe(element, s), detail: whereItIsDetail(appName, newWindow: true),
                                       step: .whereItIs)
                    }
                }
                if fresh.isEmpty, candidates.isEmpty { throw CUError.noWindow(appName) }
                throw CUError.windowElsewhere(appName)
            }
        }
        throw candidates.isEmpty ? CUError.noWindow(appName) : CUError.windowElsewhere(appName)
    }
}

/// The window wait at the start of a bind (every effect injected). A just-launched app needs a moment, and AX
/// can lag a window already on screen, so it polls. The app is asked to reopen (most apps then open a window)
/// ONLY when the window server shows it no normal window anywhere — on no Space, minimized or not. A reopen
/// sent to an app whose windows are merely elsewhere makes it open a new one on every bind (a live run left
/// Safari with twelve); with windows elsewhere the bind goes straight to the resolver, which reaches them.
enum CUBindWait {
    /// A window smaller than this is not one the user would call a window (helpers, offscreen stubs).
    static let minimumSide: CGFloat = 40

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

    /// The app's real windows anywhere: layer 0, a reasonable size, on screen or not.
    static func realWindows(_ server: [CUWindowServerWindow]) -> [CUWindowServerWindow] {
        server.filter { $0.layer == 0 && $0.frame.width >= minimumSide && $0.frame.height >= minimumSide }
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
