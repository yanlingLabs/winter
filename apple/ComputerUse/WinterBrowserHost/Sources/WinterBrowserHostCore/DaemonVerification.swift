import Darwin
import Foundation
import Security

/// The kernel's identity of the process on the other end of a Unix socket.
public struct PeerToken: Sendable, Equatable {
    /// The raw `audit_token_t` (pid + pid version: immune to pid reuse).
    public let auditToken: Data
    public let pid: pid_t

    public init(auditToken: Data, pid: pid_t) {
        self.auditToken = auditToken
        self.pid = pid
    }
}

public struct VerificationFailure: Error, Equatable, Sendable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
}

/// The LOAD-BEARING check of this hop: before the host sends the daemon a byte, the process on `browser.sock` must be
/// Winter's daemon — `getsockopt(LOCAL_PEERTOKEN)` → `SecCodeCopyGuestWithAttributes(audit token)` →
/// `SecCodeCheckValidity` against the daemon's stated designated requirement. Both OS-facing halves are injectable, so
/// the rule itself is tested with fakes.
public struct DaemonVerification: Sendable {
    public var readToken: @Sendable (Int32) throws -> PeerToken
    public var checkCode: @Sendable (PeerToken, String) throws -> Void

    public init(readToken: @escaping @Sendable (Int32) throws -> PeerToken,
                checkCode: @escaping @Sendable (PeerToken, String) throws -> Void) {
        self.readToken = readToken
        self.checkCode = checkCode
    }

    /// nil when the peer is the daemon; otherwise why not.
    public func refusal(socket fd: Int32, requirement: String) -> String? {
        let token: PeerToken
        do {
            token = try readToken(fd)
        } catch let failure as VerificationFailure {
            return failure.reason
        } catch {
            return "could not read the peer's audit token"
        }
        do {
            try checkCode(token, requirement)
            return nil
        } catch let failure as VerificationFailure {
            return "pid \(token.pid): \(failure.reason)"
        } catch {
            return "pid \(token.pid): its code failed the requirement"
        }
    }

    /// The real halves.
    public static let codeSigning = DaemonVerification(
        readToken: { try DaemonVerification.peerToken(socket: $0) },
        checkCode: { try DaemonVerification.check(token: $0, requirement: $1) }
    )

    public static func peerToken(socket fd: Int32) throws -> PeerToken {
        var token = audit_token_t()
        var length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0,
              length == socklen_t(MemoryLayout<audit_token_t>.size) else {
            throw VerificationFailure("LOCAL_PEERTOKEN failed: \(String(cString: strerror(errno)))")
        }
        var pid: pid_t = 0
        var pidLength = socklen_t(MemoryLayout<pid_t>.size)
        if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidLength) != 0 { pid = -1 }
        return PeerToken(auditToken: withUnsafeBytes(of: &token) { Data($0) }, pid: pid)
    }

    public static func check(token: PeerToken, requirement text: String) throws {
        var requirement: SecRequirement?
        let compiled = SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement)
        guard compiled == errSecSuccess, let requirement else {
            throw VerificationFailure("the daemon's designated requirement does not compile (OSStatus \(compiled))")
        }
        var guest: SecCode?
        let attributes = [kSecGuestAttributeAudit: token.auditToken] as CFDictionary
        let copied = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &guest)
        guard copied == errSecSuccess, let code = guest else {
            throw VerificationFailure("no code object for the peer (OSStatus \(copied))")
        }
        let valid = SecCodeCheckValidity(code, SecCSFlags(), requirement)
        guard valid == errSecSuccess else {
            throw VerificationFailure("its code does not satisfy Winter's daemon requirement (OSStatus \(valid))")
        }
    }
}
