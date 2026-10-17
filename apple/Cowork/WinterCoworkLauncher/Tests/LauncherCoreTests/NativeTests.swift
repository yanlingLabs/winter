import XCTest
import Foundation
@testable import LauncherCore
import LauncherNative

/// A rights-carrying sendmsg with no count limit, to build what a hostile peer could send.
func rawSendRights(_ fd: Int32, _ payload: [UInt8], rights: [Int32]) -> Int {
    var control = [UInt8](repeating: 0, count: 16 + 4 * rights.count)
    return control.withUnsafeMutableBytes { controlBytes -> Int in
        var iov = iovec(iov_base: UnsafeMutableRawPointer(mutating: payload), iov_len: payload.count)
        return withUnsafeMutablePointer(to: &iov) { iovPointer -> Int in
            var message = msghdr()
            message.msg_iov = iovPointer; message.msg_iovlen = 1
            message.msg_control = controlBytes.baseAddress; message.msg_controllen = socklen_t(12 + 4 * rights.count)
            let header = controlBytes.baseAddress!.assumingMemoryBound(to: cmsghdr.self)
            header.pointee.cmsg_len = socklen_t(12 + 4 * rights.count); header.pointee.cmsg_level = SOL_SOCKET; header.pointee.cmsg_type = SCM_RIGHTS
            rights.enumerated().forEach { index, value in controlBytes.storeBytes(of: value, toByteOffset: 12 + 4 * index, as: Int32.self) }
            return sendmsg(fd, &message, 0)
        }
    }
}
func openDescriptorCount() -> Int { (0..<2048).filter { fcntl(Int32($0), F_GETFD) >= 0 }.count }

private struct AcceptingVerifier: WorkerImageVerifying {
    let path: String
    func validatePath() throws {}
    func validateExecuted(pid: Int32) throws {}
}

final class NativeTests: XCTestCase {
    // MARK: the kill/reap algorithm

    func testKillAndReapScenarioMatrixUsesTheInjectedSyscallBoundary() {
        // exit; ECHILD; EIO; EINTR storm; kill and reap; post-kill EINTR timeout; ESRCH without reap; exit just before the kill; post-kill
        // ECHILD; failed clock; changed SIGCHLD policy; interrupted final ownership probe; pid zero and negative; an invalid timeout:
        // each ends in the specified state with the specified number of signals (0 or 1) and no real process or signal.
        for scenario in 0...14 { XCTAssertEqual(lc_test_wait_scenario(Int32(scenario)), 1, "scenario \(scenario)") }
    }

    // MARK: descriptors

    func testRecvmsgHandsBackExactlyTheAttachedDescriptorsAndSetsCloseOnExec() throws {
        let (a, b) = try Sock.pair(.stream)
        let disks = try DiskPair()
        XCTAssertEqual(try Sock.send(a, Array("hello\n".utf8)[...], rights: disks.descriptors.map(\.raw)).get(), 6)
        guard case .data(let data, let rights) = Sock.receive(b, capacity: 64) else { return XCTFail("no data") }
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "hello\n")
        XCTAssertEqual(rights.count, 2)
        for (received, original) in zip(rights, disks.descriptors) {
            XCTAssertNotEqual(received.raw, original.raw)
            XCTAssertEqual(lc_has_cloexec(received.raw), 1)
            var x = stat(), y = stat()
            XCTAssertEqual(fstat(received.raw, &x), 0); XCTAssertEqual(fstat(original.raw, &y), 0)
            XCTAssertEqual(x.st_ino, y.st_ino); XCTAssertEqual(x.st_dev, y.st_dev)
        }
    }

    func testAPlainReadInstallsAttachedDescriptorsWhichIsWhyEveryReaderUsesRecvmsg() throws {
        // The contract's HARD finding, reproduced: an ordinary read() on a stream socket silently installs SCM_RIGHTS descriptors.
        let (a, b) = try Sock.pair(.stream)
        let disks = try DiskPair()
        _ = try Sock.send(a, Array("x\n".utf8)[...], rights: disks.descriptors.map(\.raw)).get()
        let before = openDescriptorCount()
        var buffer = [UInt8](repeating: 0, count: 16)
        XCTAssertEqual(read(b.raw, &buffer, buffer.count), 2)
        XCTAssertEqual(openDescriptorCount() - before, 2, "read() installed two descriptors nobody asked for")
        // …and lc_recvmsg is the reader that does not leak them:
        let (c, d) = try Sock.pair(.stream)
        _ = try Sock.send(c, Array("x\n".utf8)[...], rights: disks.descriptors.map(\.raw)).get()
        let mid = openDescriptorCount()
        guard case .data(_, let rights) = Sock.receive(d, capacity: 16) else { return XCTFail() }
        XCTAssertEqual(rights.count, 2)
        XCTAssertEqual(openDescriptorCount() - mid, 2)
        _ = a
    }

    func testControlTruncationIsFatalAndLeavesNoDescriptorOpen() throws {
        let (a, b) = try Sock.pair(.stream)
        let source = try DiskPair()
        let extra = (0..<20).map { _ in open(source.urls[0].path, O_RDONLY) }
        defer { extra.forEach { close($0) } }
        XCTAssertGreaterThan(rawSendRights(a.raw, Array("x\n".utf8), rights: extra), 0)
        let before = openDescriptorCount()
        guard case .failed(.rightsTruncated) = Sock.receive(b, capacity: 16) else { return XCTFail("MSG_CTRUNC must be reported as rightsTruncated") }
        // The kernel installs ALL twenty and only seventeen fit the control buffer: three are installed and invisible. That is exactly why
        // truncation is fatal for the channel. Every descriptor that WAS visible has been closed.
        XCTAssertEqual(openDescriptorCount() - before, 20 - Int(LC_MAX_RIGHTS), "only the invisible excess remains; the visible ones were closed")
    }

    func testMoreDescriptorsThanTheCallerAllowsAreStillSeenAndHandedBackToBeRefused() throws {
        let (a, b) = try Sock.pair(.stream)
        let source = try DiskPair()
        let three = (0..<3).map { _ in open(source.urls[0].path, O_RDONLY) }
        defer { three.forEach { close($0) } }
        _ = rawSendRights(a.raw, Array("x\n".utf8), rights: three)
        guard case .data(_, let rights) = Sock.receive(b, capacity: 16) else { return XCTFail() }
        XCTAssertEqual(rights.count, 3, "an extra descriptor is SEEN (so it can be refused and closed), never silently truncated")
    }

    /// What a hostile peer cannot send on macOS (two rights items in one message) is built by hand and handed to the same decision.
    private func cmsg(level: Int32 = SOL_SOCKET, type: Int32 = SCM_RIGHTS, payload: [Int32]) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 12 + 4 * payload.count)
        func put(_ v: UInt32, _ at: Int) { for i in 0..<4 { bytes[at + i] = UInt8(truncatingIfNeeded: v >> (8 * UInt32(i))) } }
        put(UInt32(bytes.count), 0); put(UInt32(bitPattern: level), 4); put(UInt32(bitPattern: type), 8)
        for (i, v) in payload.enumerated() { put(UInt32(bitPattern: v), 12 + 4 * i) }
        return bytes
    }
    private func classify(_ control: [UInt8], flags: Int32 = 0) -> (code: Int, rights: [Int32]) {
        var info = lc_recv_info()
        let code = control.withUnsafeBytes { lc_test_classify_control($0.baseAddress, $0.count, flags, &info) }
        let count = Int(info.rights_count)
        let rights = withUnsafeBytes(of: &info.rights) { raw in (0..<count).map { raw.load(fromByteOffset: 4 * $0, as: Int32.self) } }
        return (Int(code), rights)
    }
    func testOneRightsItemIsAcceptedAndTwoAreRefusedWithEveryDescriptorClosed() {
        let a = dup(0), b = dup(0), c = dup(0)
        let one = classify(cmsg(payload: [a]))
        XCTAssertEqual(one.code, 0); XCTAssertEqual(one.rights, [a]); XCTAssertEqual(lc_has_cloexec(a), 1, "an accepted descriptor is close-on-exec")
        close(a)
        let two = classify(cmsg(payload: [b]) + cmsg(payload: [c]))
        XCTAssertEqual(two.code, Int(LC_E_BAD_CONTROL), "a second rights item is refused (macOS will not send two, but the receiver does not rely on that)")
        XCTAssertEqual(fcntl(b, F_GETFD), -1); XCTAssertEqual(fcntl(c, F_GETFD), -1, "everything the buffer held was closed")
    }
    func testAnythingButRightsInTheControlBufferIsRefusedAndTheRightsClosed() {
        let a = dup(0)
        let mixed = classify(cmsg(payload: [a]) + cmsg(type: 2 /* SCM_TIMESTAMP */, payload: [0]))
        XCTAssertEqual(mixed.code, Int(LC_E_BAD_CONTROL)); XCTAssertEqual(fcntl(a, F_GETFD), -1)
        let b = dup(0)
        var ragged = cmsg(payload: [b, 0]); ragged[0] -= 2   // a length that is not a whole number of descriptors (18 = 12 + 4 + 2)
        XCTAssertEqual(classify(ragged).code, Int(LC_E_BAD_CONTROL)); XCTAssertEqual(fcntl(b, F_GETFD), -1)
    }
    func testTruncationFlagsOutrankEverythingAndStillCloseWhatWasSeen() {
        let a = dup(0)
        XCTAssertEqual(classify(cmsg(payload: [a]), flags: MSG_CTRUNC).code, Int(LC_E_RIGHTS_TRUNCATED)); XCTAssertEqual(fcntl(a, F_GETFD), -1)
        let b = dup(0)
        XCTAssertEqual(classify(cmsg(payload: [b]), flags: MSG_TRUNC).code, Int(LC_E_DATA_TRUNCATED)); XCTAssertEqual(fcntl(b, F_GETFD), -1)
    }
    func testTruncatedDatagramClosesItsDescriptors() throws {
        let (a, b) = try Sock.pair(.datagram)
        let source = try DiskPair()
        let fd = open(source.urls[0].path, O_RDONLY); defer { close(fd) }
        _ = rawSendRights(a.raw, [UInt8](repeating: 7, count: 100), rights: [fd])
        let before = openDescriptorCount()
        guard case .failed(.dataTruncated) = Sock.receive(b, capacity: 10) else { return XCTFail("MSG_TRUNC must be reported") }
        XCTAssertLessThanOrEqual(openDescriptorCount() - before, 0)
    }

    func testEndOfStreamAndWouldBlock() throws {
        let (a, b) = try Sock.pair(.stream)
        try Sock.setNonBlocking(b)
        guard case .wouldBlock = Sock.receive(b, capacity: 16) else { return XCTFail() }
        a.close()
        guard case .endOfStream = Sock.receive(b, capacity: 16) else { return XCTFail() }
    }

    func testSocketPairsAreCloseOnExecAndRelocatable() throws {
        let (a, b) = try Sock.pair(.datagram)
        XCTAssertEqual(lc_has_cloexec(a.raw), 1); XCTAssertEqual(lc_has_cloexec(b.raw), 1)
        let old = a.raw
        let moved = try Sock.relocate(a, above: 40)
        XCTAssertGreaterThanOrEqual(moved.raw, 40)
        XCTAssertEqual(lc_has_cloexec(moved.raw), 1)
        XCTAssertEqual(fcntl(old, F_GETFD), -1, "the original number is closed")
    }

    func testUnnamedSocketCheckAcceptsOnlyAnUnnamedPairOfTheRightType() throws {
        let (a, _b) = try Sock.pair(.stream)
        XCTAssertEqual(lc_is_unnamed_unix_socket(a.raw, SOCK_STREAM), 1)
        XCTAssertEqual(lc_is_unnamed_unix_socket(a.raw, SOCK_DGRAM), 0, "the wrong type")
        let (d, _e) = try Sock.pair(.datagram)
        XCTAssertEqual(lc_is_unnamed_unix_socket(d.raw, SOCK_STREAM), 0)
        // A connection to a NAMED listener is not an unnamed pair.
        let directory = makeTemporaryDirectory("sock"); defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("s").path
        XCTAssertLessThan(path.utf8.count, 100)
        let server = socket(AF_UNIX, SOCK_STREAM, 0); defer { close(server) }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutablePointer(to: &address.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: 104) { strncpy($0, path, 103) } }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        XCTAssertEqual(withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, size) } }, 0)
        XCTAssertEqual(Darwin.listen(server, 1), 0)
        let client = socket(AF_UNIX, SOCK_STREAM, 0); defer { close(client) }
        XCTAssertEqual(withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(client, $0, size) } }, 0)
        XCTAssertEqual(lc_is_unnamed_unix_socket(client, SOCK_STREAM), 0)
        let accepted = accept(server, nil, nil); defer { close(accepted) }
        XCTAssertEqual(lc_is_unnamed_unix_socket(accepted, SOCK_STREAM), 0)
    }

    // MARK: the owned child (a REAL process, never a VM)

    private func spawn(_ path: String = BuiltProducts.fakeWorker, verifier: WorkerImageVerifying? = nil) throws -> (NativeWorkerProcess, OwnedFD, OwnedFD) {
        let (p2, c2) = try Sock.pair(.datagram), (p3, c3) = try Sock.pair(.stream)
        let parent2 = try Sock.relocate(p2, above: 5), child2 = try Sock.relocate(c2, above: 5)
        let parent3 = try Sock.relocate(p3, above: 5), child3 = try Sock.relocate(c3, above: 5)
        let process = try NativeWorkerProcess(verifier: verifier ?? AcceptingVerifier(path: path), l2Child: child2, l3Child: child3)
        return (process, parent2, parent3)
    }
    private func status(of pid: Int32) -> UInt32 {
        var info = proc_bsdinfo()
        precondition(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0)
        return info.pbi_status
    }

    func testTheWorkerStartsSuspendedAndOnlyTheOwnedHandleCanKillIt() throws {
        let (process, _p2, _p3) = try spawn()
        XCTAssertEqual(process.probe(), .running)
        XCTAssertEqual(status(of: process.pid), 4 /* SSTOP */, "POSIX_SPAWN_START_SUSPENDED: nothing of the worker has run")
        XCTAssertFalse(process.startToken.isEmpty)
        let outcome = process.kill()
        XCTAssertEqual(outcome.exit, .signal(SIGKILL))
        XCTAssertTrue(outcome.killSent)
        XCTAssertEqual(process.probe(), .signal(SIGKILL), "reaped by the launcher itself")
        // A second kill finds a confirmed exit: no new signal is authorised by a recorded pid.
        let again = process.kill()
        XCTAssertEqual(again.exit, .signal(SIGKILL))
        XCTAssertEqual(kill(process.pid, 0), -1, "the process is really gone")
    }

    func testResumeRunsTheWorkerAndAnAlreadyExitedChildIsNeverSignalled() throws {
        let (process, _p2, _p3) = try spawn("/usr/bin/true")
        try process.resume()
        var exit = WorkerExit.running
        for _ in 0..<500 where exit == .running { usleep(10_000); exit = process.probe() }
        XCTAssertEqual(exit, .code(0))
        let outcome = process.kill()
        XCTAssertEqual(outcome.exit, .code(0))
        XCTAssertFalse(outcome.killSent, "a confirmed exit authorises no signal: the pid may belong to someone else by now")
    }

    func testSpawnRefusesAnAutoReapingOrIgnoringSigchldPolicy() throws {
        var saved = sigaction(); XCTAssertEqual(sigaction(SIGCHLD, nil, &saved), 0)
        defer { sigaction(SIGCHLD, &saved, nil) }
        for ignoring in [true, false] {
            var policy = saved
            policy.__sigaction_u.__sa_handler = ignoring ? SIG_IGN : SIG_DFL
            policy.sa_flags = ignoring ? 0 : SA_NOCLDWAIT
            XCTAssertEqual(sigaction(SIGCHLD, &policy, nil), 0)
            let (p2, c2) = try Sock.pair(.datagram), (p3, c3) = try Sock.pair(.stream)
            let a = try Sock.relocate(c2, above: 5), b = try Sock.relocate(c3, above: 5)
            var child: OpaquePointer?
            XCTAssertEqual(lc_spawn_owned("/usr/bin/true", a.raw, b.raw, &child), EPERM, "sole reaper or nothing")
            XCTAssertNil(child)
            _ = (p2, p3)
        }
    }

    func testSpawnRefusesChildDescriptorsOnOrBelowTheWorkersOwnTable() throws {
        let (p2, c2) = try Sock.pair(.datagram), (p3, c3) = try Sock.pair(.stream)
        var child: OpaquePointer?
        XCTAssertEqual(lc_spawn_owned("/usr/bin/true", 3, 9, &child), EINVAL)
        XCTAssertEqual(lc_spawn_owned("/usr/bin/true", 9, 4, &child), EINVAL)
        XCTAssertEqual(lc_spawn_owned("/usr/bin/true", 9, 9, &child), EINVAL)
        _ = (p2, c2, p3, c3)
    }

    func testSpawnRefusesAFileThatChangedAfterItWasPinned() throws {
        let directory = makeTemporaryDirectory("pin"); defer { try? FileManager.default.removeItem(at: directory) }
        let path = BuiltProducts.canonical(directory.appendingPathComponent("worker").path)
        try FileManager.default.copyItem(atPath: BuiltProducts.fakeWorker, toPath: path)
        let requirement = try CodeRequirement(cdhashRequirementText(try CodeHash.ofFile(path)))
        let image = try WorkerImage(path: path, requirement: requirement)
        try image.validatePath()
        // Swap the contents (same name, new bytes): the pinned digest no longer matches.
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        try handle.seekToEnd(); handle.write(Data([0x00])); try handle.close()
        XCTAssertThrowsError(try image.validatePath())
        XCTAssertThrowsError(try spawn(path, verifier: image)) { XCTAssertEqual($0 as? SpawnFailure, .imageChanged) }
    }
}
