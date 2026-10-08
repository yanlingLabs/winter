import AppKit
import CoreGraphics
import WinterCUPresentation

// A manual check of the presentation layer, for the controller and the user (never run by tests: it captures the
// screen, draws overlays and installs an event tap). It mirrors one window, walks the agent cursor over it through
// every action kind, and arms the Esc stop.
//
//   cu-presentation-demo --list                 windows you can pick (id, app, frame)
//   cu-presentation-demo --window <id> [--seconds 30] [--no-mirror] [--no-esc]
//
// Needs Screen Recording (the mirror) and Accessibility (the Esc tap) for the terminal running it.

struct Options {
    var list = false
    var windowID: CGWindowID?
    var seconds: TimeInterval = 30
    var mirror = true
    var esc = true
}

func parse(_ args: [String]) -> Options? {
    var o = Options()
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--list": o.list = true
        case "--window":
            i += 1
            guard i < args.count, let id = UInt32(args[i]) else { return nil }
            o.windowID = id
        case "--seconds":
            i += 1
            guard i < args.count, let s = TimeInterval(args[i]), s > 0 else { return nil }
            o.seconds = s
        case "--no-mirror": o.mirror = false
        case "--no-esc": o.esc = false
        default: return nil
        }
        i += 1
    }
    return o
}

func windowInfos() -> [[String: Any]] {
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
}

func describe(_ info: [String: Any]) -> (id: CGWindowID, pid: pid_t, app: String, frame: CGRect)? {
    guard let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue, layer == 0,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { return nil }
    return (id, pid, info[kCGWindowOwnerName as String] as? String ?? "?", frame)
}

let usage = "usage: cu-presentation-demo --list | --window <id> [--seconds N] [--no-mirror] [--no-esc]"
guard let options = parse(Array(CommandLine.arguments.dropFirst())) else {
    FileHandle.standardError.write((usage + "\n").data(using: .utf8)!)
    exit(2)
}

if options.list || options.windowID == nil {
    for info in windowInfos() {
        guard let w = describe(info) else { continue }
        print("\(w.id)\t\(w.app)\t\(Int(w.frame.minX)),\(Int(w.frame.minY)) \(Int(w.frame.width))×\(Int(w.frame.height))")
    }
    if options.windowID == nil && !options.list { print(usage) }
    exit(0)
}

guard let windowID = options.windowID,
      let window = windowInfos().compactMap(describe).first(where: { $0.id == windowID }) else {
    FileHandle.standardError.write("window \(options.windowID ?? 0) is not on screen (try --list)\n".data(using: .utf8)!)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

/// Drives the presentation through a fixed loop of actions over the chosen window.
@MainActor final class Demo {
    let session = "demo"
    let target: CUWindowRef
    let frame: CGRect
    let presentation: CUPresentation
    let tap: CUEscapeTap
    var timer: Timer?
    var index = 0

    init(window: (id: CGWindowID, pid: pid_t, app: String, frame: CGRect), options: Options) {
        target = CUWindowRef(pid: window.pid, windowID: window.id, appName: window.app)
        frame = window.frame
        (presentation, tap) = WinterCUPresentationFactory.make()
        presentation.mirrorsEnabled = options.mirror
        if options.esc {
            tap.onEscape = { [weak self] in
                MainActor.assumeIsolated { self?.finish("Esc pressed: stopping") }
            }
            tap.setArmed(true)
        }
    }

    func start(seconds: TimeInterval) {
        presentation.showMirror(sessionId: session, target: target)
        let t = Timer(timeInterval: 1.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.step() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            MainActor.assumeIsolated { self?.finish("time is up: the mirror fades (turn end)") }
        }
    }

    /// A loop of points over the window, each with a different action kind.
    func step() {
        func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: frame.minX + frame.width * x, y: frame.minY + frame.height * y)
        }
        let steps: [(CGPoint, CUCursorKind)] = [
            (at(0.3, 0.3), .move),
            (at(0.7, 0.35), .press),
            (at(0.5, 0.6), .type),
            (at(0.4, 0.75), .scroll),
            (at(0.25, 0.5), .drag(to: at(0.75, 0.55))),
            (at(0.5, 0.2), .press),
        ]
        let (point, kind) = steps[index % steps.count]
        index += 1
        presentation.cursor(sessionId: session, target: target, point: point, kind: kind)
    }

    func finish(_ reason: String) {
        guard timer != nil else { return }
        print(reason)
        timer?.invalidate()
        timer = nil
        tap.setArmed(false)
        presentation.turnEnded(sessionId: session)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in
            MainActor.assumeIsolated { presentation.sessionEnded(sessionId: session) }
            exit(0)
        }
    }
}

let demo = MainActor.assumeIsolated { () -> Demo in
    let demo = Demo(window: window, options: options)
    demo.start(seconds: options.seconds)
    return demo
}
print("mirroring window \(window.id) of \(window.app) for \(Int(options.seconds)) s" + (options.esc ? "; press Esc to stop" : ""))

app.run()
