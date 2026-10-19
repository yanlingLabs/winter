import Foundation
import Darwin
import LauncherCore
import LauncherNative

/*
 * FakeWorker: a plain, NON-HVF child that speaks the worker side of L2 and L3, so the launcher's spawn, suspend/resume, drain, kill,
 * reap and envelope paths can be tested without a VM. It starts no hypervisor, links no libkrun and installs no sandbox.
 *
 * The launcher spawns it exactly like the real worker (argv = [path], a two-variable environment, descriptors 0-2 on /dev/null,
 * L2 as 3, L3 as 4), so the BEHAVIOR is chosen by the scope the test sends: `workerInstanceId` is `wrk-fake-<mode>`.
 *
 *   ok                 sandboxed; accepts the disks (fstat against the VOLUMES record, writes a marker through descriptor 0 of the pair);
 *                      vm_running, guest_hello; sends a runtime frame naming its open descriptors; echoes every frame it is sent;
 *                      on DRAIN: draining, drain_acked, halting, guest_halted (flushes 1/1), exiting, exit 0
 *   silent             never reports READY
 *   ignoredrain        like ok, but never answers DRAIN (the launcher must kill it through the owned handle)
 *   crash              like ok, but _exit(79) once the disks are accepted
 *   exitnodrain        like ok, but exits 0 by itself right after vm_running, without being asked
 *   badflush           like ok, but guest_halted reports requested 2 / completed 1
 *   nohalting          like ok, but powers off without ever saying `halting` (a bare power-off: Class B)
 *   guestfault         like ok, but reports guest_fault right after guest_hello
 *   nohalt             like ok, but never reports guest_halted
 *   fault              reports fault sandbox_failed and exits 79
 *   rejectvolumes      reports fault bad_volumes when the disks arrive
 *   noaccept           receives the disks and says nothing
 *   l3rights           sends a mux frame on L3 with a descriptor attached
 *   sink               like ok, but consumes L3 SLOWLY and counts it (a bootstrap frame "done" is answered with a runtime frame "sunk:<bytes>:<frames>")
 *   trickle            like sink, but consumes L3 very slowly (50 ms per read): always progressing, never stalled
 *   stalll3            like ok, but never reads L3 again once the guest is "up"
 *   garbage            sends a datagram that is not an envelope
 *   rightsback         sends a valid status with a descriptor attached
 *   badseq             sends a status with a sequence gap
 *   controlframe       sends a CONTROL class mux frame up L3 (which never crosses L3)
 *   halt-without-vm    reports guest_halted before any vm_running
 */

setbuf(stdout, nil)
let l2 = OwnedFD(3), l3 = OwnedFD(4)

func fail(_ code: Int32) -> Never { _exit(code) }

var outSeq: UInt32 = 0
@MainActor func sendStatus(_ state: WorkerStatus, data: FlushCounters = FlushCounters(), environment: FlushCounters = FlushCounters(), rights: [Int32] = [], skip: UInt32 = 0) {
    outSeq += 1 + skip
    let bytes = try! EnvelopeFormat.serialize(.status(seq: outSeq, state: state, data: data, environment: environment))
    _ = Sock.send(l2, bytes[...], rights: rights)
}
@MainActor func sendFault(_ code: WorkerFault) {
    outSeq += 1
    _ = Sock.send(l2, try! EnvelopeFormat.serialize(.fault(seq: outSeq, code: code))[...])
}
var upSeq: [MuxClass: UInt32] = [:]
@MainActor func sendFrame(_ muxClass: MuxClass, _ payload: [UInt8]) {
    upSeq[muxClass, default: 0] += 1
    let frame = MuxFormat.frame(muxClass, seq: upSeq[muxClass]!, payload: payload)
    var offset = 0
    while offset < frame.count {
        switch Sock.send(l3, frame[offset...]) {
        case .success(let n): offset += n
        case .failure(.errno(EAGAIN)): usleep(1000)
        case .failure: fail(70)
        }
    }
}
func openDescriptors() -> [Int] { (0..<256).filter { fcntl(Int32($0), F_GETFD) >= 0 } }

// ---- wait for the SCOPE
func waitReadable(_ fds: [Int32], timeoutMs: Int32 = -1) -> [Int32] {
    var table = fds.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
    let n = poll(&table, nfds_t(table.count), timeoutMs)
    if n <= 0 { return [] }
    return table.filter { $0.revents != 0 }.map { $0.fd }
}

var mode = "ok"
var scope: Scope?
var volumeFDs: [OwnedFD] = []
var accepted = false
var booted = false
var halted = false
var counters = FlushCounters()

@MainActor func handleDatagram(_ bytes: [UInt8], rights: [OwnedFD]) {
    guard let envelope = try? EnvelopeFormat.parse(bytes, rights: rights.count, direction: .toWorker) else { fail(79) }
    switch envelope {
    case .scope(_, let value):
        scope = value
        if value.workerInstanceId.hasPrefix("wrk-fake-") { mode = String(value.workerInstanceId.dropFirst("wrk-fake-".count)) }
        switch mode {
        case "silent": while true { sleep(60) }
        case "fault": sendFault(.sandboxFailed); fail(79)
        case "garbage": _ = Sock.send(l2, [0x01, 0x02, 0x03][...]); while true { sleep(60) }
        case "rightsback": sendStatus(.sandboxed, rights: [Int32(open("/dev/null", O_RDONLY))]); return
        case "badseq": outSeq += 4; sendStatus(.sandboxed); return
        case "halt-without-vm": sendStatus(.sandboxed); sendStatus(.guestHalted); return
        default: break
        }
        sendStatus(.sandboxed)
    case .volumes(_, let digest, let volumes):
        guard let scope, digest == (try? EnvelopeFormat.scopeDigest(scope)), rights.count == 2 else { fail(79) }
        if mode == "rejectvolumes" { sendFault(.badVolumes); return }
        for (descriptor, identity) in zip(rights, volumes) {
            do { try VolumeDescriptorCheck.verify(descriptor, against: identity) } catch { sendFault(.badVolumes); fail(79) }
        }
        volumeFDs = rights
        if mode == "noaccept" { return }
        // A real write through the first descriptor proves the pair arrived usable.
        let marker = Array("WINTER-FAKE-WORKER".utf8)
        _ = marker.withUnsafeBytes { pwrite(volumeFDs[0].raw, $0.baseAddress, marker.count, 0) }
        _ = fcntl(volumeFDs[0].raw, F_FULLFSYNC)
        counters = FlushCounters(requested: 1, completed: 1)
        accepted = true
        sendStatus(.volumesAccepted)
        if mode == "crash" { fail(79) }
        sendStatus(.vmRunning); booted = true
        if mode == "exitnodrain" { exit(0) }
        sendStatus(.guestHello)
        if mode == "guestfault" { sendStatus(.guestFault) }
        if mode == "l3rights" {
            // A frame on L3 that drags a descriptor along: a hostile worker's way to push a file into the launcher's table.
            _ = Sock.send(l3, MuxFormat.frame(.bootstrap, seq: 1, payload: [1])[...], rights: [Int32(open("/dev/null", O_RDONLY))])
            return
        }
        sendFrame(.runtime, Array("fds:\(openDescriptors().map(String.init).joined(separator: ","))".utf8))
    case .drain(_, let nonce, _, _):
        if mode == "ignoredrain" { return }
        _ = nonce
        sendStatus(.draining)
        if booted { sendStatus(.drainAcked); if mode != "nohalting" { sendStatus(.halting) } }
        if accepted {
            // "Power off": close the disks. The final flush is reported by the exit hook, i.e. by the guest_halted status.
            volumeFDs.forEach { $0.close() }
        }
        // What the exit hook reports after the final flush. `badflush` leaves one requested flush incomplete, and says so consistently.
        let final = mode == "badflush" ? FlushCounters(requested: 2, completed: 1) : counters
        if booted && mode != "nohalt" { sendStatus(.guestHalted, data: final, environment: FlushCounters()) }
        sendStatus(.exiting, data: booted ? final : counters, environment: FlushCounters())
        exit(0)
    default: fail(79)
    }
}

var l3Reader = MuxStreamReader()
var sunkBytes = 0, sunkFrames = 0
@MainActor func handleStream(_ bytes: [UInt8]) {
    guard let frames = try? l3Reader.feed(bytes) else { fail(79) }
    for (header, frame) in frames {
        let payload = Array(frame[WireLimits.headerBytes...])
        if mode == "sink" || mode == "trickle" {
            sunkBytes += payload.count; sunkFrames += 1
            if header.muxClass == .bootstrap && payload == Array("done".utf8) { sendFrame(.runtime, Array("sunk:\(sunkBytes):\(sunkFrames)".utf8)) }
            continue
        }
        // Echo: the same class, the payload as it came.
        sendFrame(header.muxClass, payload)
    }
}

if let first = CommandLine.arguments.dropFirst().first, first == "--fds" { print(openDescriptors().map(String.init).joined(separator: ",")); exit(0) }

while true {
    let ready = waitReadable(mode == "stalll3" && booted ? [l2.raw] : [l2.raw, l3.raw])
    if ready.contains(l2.raw) {
        loop: while true {
            switch Sock.receive(l2, capacity: 4096) {
            case .data(let bytes, let rights): handleDatagram(bytes, rights: rights)
            case .wouldBlock: break loop
            case .endOfStream: exit(0)
            case .failed: fail(78) // a truncated control buffer: exit without a word, exactly as the real worker must
            }
        }
    }
    if ready.contains(l3.raw) {
        loop3: while true {
            switch Sock.receive(l3, capacity: 65536) {
            case .data(let bytes, _): if mode == "controlframe" { fail(79) } else { handleStream(bytes); if mode == "sink" { usleep(2000) } else if mode == "trickle" { usleep(50_000) } }
            case .wouldBlock: break loop3
            case .endOfStream: exit(0)
            case .failed: fail(78)
            }
        }
    }
    if ready.isEmpty { usleep(1000) }
}
