import Foundation
import LauncherNative

/// A descriptor with one owner. Dropping it closes it, so a refusal path can never leak what it was handed.
public final class OwnedFD: @unchecked Sendable {
    private var descriptor: Int32
    public init(_ descriptor: Int32) { self.descriptor = descriptor }
    public var raw: Int32 { descriptor }
    public var isOpen: Bool { descriptor >= 0 }
    /// Gives up ownership WITHOUT closing; the caller now owns the number.
    public func release() -> Int32 { let value = descriptor; descriptor = -1; return value }
    public func close() { if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 } }
    deinit { close() }
}

public enum SocketKind: Sendable { case stream, datagram }

public enum DescriptorFailure: Error, Equatable, Sendable {
    /// MSG_CTRUNC: the kernel may have installed descriptors nobody can see. Fatal for the channel.
    case rightsTruncated
    /// MSG_TRUNC: the datagram did not fit.
    case dataTruncated
    /// Anything but exactly one SCM_RIGHTS message of whole descriptors.
    case badControl
    case errno(Int32)
}

public enum ReceiveOutcome {
    /// Bytes and the descriptors that arrived WITH them (each already FD_CLOEXEC, owned by the caller).
    case data([UInt8], [OwnedFD])
    case wouldBlock
    /// End of a stream. (A zero-length datagram is `data([], [])`; the callers of datagram sockets treat it as malformed.)
    case endOfStream
    case failed(DescriptorFailure)
}

public enum Sock {
    public static func pair(_ kind: SocketKind) throws -> (OwnedFD, OwnedFD) {
        var fds: [Int32] = [-1, -1]
        guard lc_socketpair(kind == .stream ? SOCK_STREAM : SOCK_DGRAM, &fds) == 0 else { throw DescriptorFailure.errno(errno) }
        return (OwnedFD(fds[0]), OwnedFD(fds[1]))
    }
    /// A copy of `fd` at a number of at least `minimum`, FD_CLOEXEC; the original is closed.
    public static func relocate(_ fd: OwnedFD, above minimum: Int32) throws -> OwnedFD {
        let moved = lc_relocate(fd.raw, minimum)
        guard moved >= 0 else { throw DescriptorFailure.errno(errno) }
        _ = fd.release() // lc_relocate closed it
        return OwnedFD(moved)
    }
    public static func setNonBlocking(_ fd: OwnedFD) throws { guard lc_set_nonblocking(fd.raw) == 0 else { throw DescriptorFailure.errno(errno) } }

    /// The ONLY way this process reads L1, L2 or L3. A plain read()/recv() would install any descriptors the peer attached.
    public static func receive(_ fd: OwnedFD, capacity: Int) -> ReceiveOutcome {
        var buffer = [UInt8](repeating: 0, count: capacity)
        var info = lc_recv_info()
        let count = buffer.withUnsafeMutableBytes { lc_recvmsg(fd.raw, $0.baseAddress, capacity, &info) }
        if count < 0 {
            switch count {
            case LC_E_RIGHTS_TRUNCATED: return .failed(.rightsTruncated)
            case LC_E_DATA_TRUNCATED: return .failed(.dataTruncated)
            case LC_E_BAD_CONTROL: return .failed(.badControl)
            case -Int(EAGAIN): return .wouldBlock
            default: return .failed(.errno(Int32(-count)))
            }
        }
        let rights = withUnsafePointer(to: &info.rights) { pointer in
            pointer.withMemoryRebound(to: Int32.self, capacity: Int(LC_MAX_RIGHTS)) { base in (0..<Int(info.rights_count)).map { OwnedFD(base[$0]) } }
        }
        if count == 0 && rights.isEmpty { return fd.isStream ? .endOfStream : .data([], []) }
        return .data(Array(buffer.prefix(count)), rights)
    }

    /// One sendmsg with the given descriptors attached; the descriptors stay the caller's. Returns the bytes sent.
    public static func send(_ fd: OwnedFD, _ bytes: ArraySlice<UInt8>, rights: [Int32] = []) -> Result<Int, DescriptorFailure> {
        let sent = bytes.withUnsafeBytes { lc_sendmsg(fd.raw, $0.baseAddress, bytes.count, rights, Int32(rights.count)) }
        return sent < 0 ? .failure(.errno(Int32(-sent))) : .success(sent)
    }
}

extension OwnedFD {
    /// Whether this is a stream socket (a zero-byte read then means end of stream).
    var isStream: Bool {
        var type: Int32 = 0; var size = socklen_t(MemoryLayout<Int32>.size)
        return getsockopt(descriptor, SOL_SOCKET, SO_TYPE, &type, &size) == 0 && type == SOCK_STREAM
    }
}
