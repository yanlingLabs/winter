import Foundation

/// Winter Headless's end of the pipe (`HeadlessWire`): a reader thread on fd 3 handing each command to the host on
/// the main thread, in arrival order, and one serial output queue writing fd 4 through the outbox.
///
/// The pipe is the helper's lifeline: EOF (or an error) on fd 3 means the daemon closed it or died, and a failed
/// write on fd 4 means the same — either way `onClosed` runs once, on the main thread, and the helper exits.
final class HeadlessLink: HeadlessOutput, @unchecked Sendable {
    private let readFD: Int32
    private let writeFD: Int32
    private let out = DispatchQueue(label: "com.winter.headless.out")
    private let outbox: HeadlessOutbox
    private let flushWindow: TimeInterval
    private let log: @Sendable (String) -> Void
    /// Bumped each time the batch timer is armed, so a stale timer flushes nothing.
    private var flushGeneration: UInt64 = 0
    private var writeFailed = false
    private let closedLock = NSLock()
    private var closed = false

    /// Set before `start`; called on the main thread.
    var onCommand: (@MainActor (HeadlessWire.Inbound) -> Void)?
    var onClosed: (@MainActor (_ reason: String) -> Void)?

    let linkId: String

    init(readFD: Int32, writeFD: Int32, linkId: String = "h-" + UUID().uuidString.lowercased(),
         flushWindow: TimeInterval = 0.05, log: @escaping @Sendable (String) -> Void) {
        self.readFD = readFD
        self.writeFD = writeFD
        self.linkId = linkId
        self.flushWindow = flushWindow
        self.log = log
        self.outbox = HeadlessOutbox(linkId: linkId, log: log)
    }

    /// Start reading commands. Call once.
    func start() {
        let thread = Thread { [self] in readLoop() }
        thread.name = "com.winter.headless.in"
        thread.start()
    }

    // MARK: - Reading

    private func readLoop() {
        let decoder = LineDecoder(maxLine: HeadlessWire.commandLineMax)
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buffer.withUnsafeMutableBytes { read(readFD, $0.baseAddress, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN {
                    // A descriptor the spawner left non-blocking: wait for it rather than spin or give up.
                    var fds = pollfd(fd: readFD, events: Int16(POLLIN), revents: 0)
                    _ = poll(&fds, 1, -1)
                    continue
                }
                closeOnce("the pipe failed to read (errno \(errno))")
                return
            }
            if n == 0 {
                closeOnce("the pipe closed")
                return
            }
            let lines: [Data]
            do {
                lines = try decoder.pushData(Data(buffer[0..<n]))
            } catch {
                log("headless: dropped a command line over \(HeadlessWire.commandLineMax) bytes")
                continue
            }
            for line in lines {
                let inbound = HeadlessWire.parse(line)
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated { self?.onCommand?(inbound) }
                }
            }
        }
    }

    private func closeOnce(_ reason: String) {
        let first: Bool = closedLock.withLock {
            if closed { return false }
            closed = true
            return true
        }
        guard first else { return }
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.onClosed?(reason) }
        }
    }

    // MARK: - Writing

    func hello() {
        let pid = getpid()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        out.async { [self] in write(outbox.hello(pid: pid, version: version)) }
    }

    func reply(cmdId: String, _ reply: BrowserLinkReply) {
        out.async { [self] in
            for line in outbox.result(cmdId: cmdId, reply: reply) { write(line) }
        }
    }

    func emitEvent(tabId: String, method: String, params: Data, cdpSessionId: String?, strip: Bool) {
        let event = HeadlessOutbox.PendingEvent(tabId: tabId, method: method, params: params, cdpSessionId: cdpSessionId, strip: strip)
        out.async { [self] in
            let wasEmpty = !outbox.hasPendingEvents
            for line in outbox.event(event) { write(line) }
            if wasEmpty, outbox.hasPendingEvents {
                flushGeneration &+= 1
                let mine = flushGeneration
                out.asyncAfter(deadline: .now() + flushWindow) { [self] in
                    guard mine == flushGeneration else { return }
                    for line in outbox.flush() { write(line) }
                }
            }
        }
    }

    func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason) {
        out.async { [self] in
            for line in outbox.tabGone(tabId: tabId, reason: reason) { write(line) }
        }
    }

    func notice(tabId: String, kind: String) {
        out.async { [self] in
            for line in outbox.notice(tabId: tabId, kind: kind) { write(line) }
        }
    }

    func presentationEnded(tabId: String, reason: String) {
        out.async { [self] in
            for line in outbox.presentationEnded(tabId: tabId, reason: reason) { write(line) }
        }
    }

    /// The whole line, or the pipe is gone.
    private func write(_ line: Data) {
        guard !writeFailed else { return }
        let ok: Bool = line.withUnsafeBytes { raw in
            guard var base = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(writeFD, base, left)
                if n < 0 {
                    if errno == EINTR { continue }
                    if errno == EAGAIN {
                        var fds = pollfd(fd: writeFD, events: Int16(POLLOUT), revents: 0)
                        _ = poll(&fds, 1, -1)
                        continue
                    }
                    return false
                }
                left -= n
                base = base.advanced(by: n)
            }
            return true
        }
        if !ok {
            writeFailed = true
            closeOnce("the pipe failed to write (errno \(errno))")
        }
    }
}
