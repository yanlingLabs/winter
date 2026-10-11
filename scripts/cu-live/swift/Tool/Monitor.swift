import AppKit
import Foundation

// `cu-live-tool monitor` and `front`.

/// Dispatch sources must outlive `run()`'s scope.
private var signalSources: [DispatchSourceSignal] = []

enum Monitor {
    /// Runs until stdin reaches EOF or SIGTERM/SIGINT. Never returns.
    @MainActor
    static func run(intervalMs: Int) -> Never {
        // NSWorkspace.frontmostApplication and the activation notifications only update while a run loop runs
        // inside a process connected to the window server. `.prohibited` (not `.accessory`) so the monitor can
        // never become the frontmost app itself and pollute the thing it measures.
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        // The user's hardware input (HardwareInput): every sample reports it while the tap runs.
        HardwareInput.start()
        let sample: (NSRunningApplication?) -> Sample = { front in
            var s = Sampling.sample(front: front)
            if HardwareInput.tapping {
                s.hardware = (HardwareInput.count, HardwareInput.lastMs, HardwareInput.startedMs, HardwareInput.keys)
            }
            s.session = SessionState.cachedReading()
            return s
        }

        // A jump-and-back shorter than the interval would otherwise be invisible: every activation emits at once.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { note in
            let activated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            MainActor.assumeIsolated { Out.line(sample(activated).json) }
        }

        let timer = Timer(timeInterval: Double(intervalMs) / 1000, repeats: true) { _ in
            MainActor.assumeIsolated { Out.line(sample(nil).json) }
        }
        timer.tolerance = 0
        RunLoop.main.add(timer, forMode: .common)

        // SIGTERM/SIGINT end the monitor; default handling is disabled so the dispatch sources get them.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { exit(0) }
            source.resume()
            signalSources.append(source)
        }

        // The rig keeps our stdin open and closes it to stop us (SIGTERM is the backup). A dedicated thread:
        // a blocking read must not sit on the main run loop.
        let watcher = Thread {
            var buffer = [UInt8](repeating: 0, count: 256)
            while true {
                let n = read(STDIN_FILENO, &buffer, buffer.count)
                if n < 0, errno == EINTR { continue }
                if n <= 0 { break }
            }
            DispatchQueue.main.async { exit(0) }
        }
        watcher.name = "cu-live-tool.stdin"
        watcher.start()

        Out.line(sample(nil).json) // an immediate first line, not one interval from now
        app.run()
        exit(0)
    }

    /// One line, then exit 0.
    @MainActor
    static func front() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        // Let the workspace deliver its initial state before reading it.
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
        var sample = Sampling.sample()
        sample.spaceType = Sampling.activeSpaceType()
        Out.line(sample.json)
        exit(0)
    }
}
