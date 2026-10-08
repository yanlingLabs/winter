import Darwin
import Foundation
import Security

/// Whether a connected peer may talk to the helper. Decided before a single byte is read; a rejected peer is
/// closed with no response at all.
public enum PeerAuthDecision: Equatable, Sendable {
    case accept(pid: pid_t)
    case reject(reason: String)
}

public protocol PeerAuthenticator: Sendable {
    func authorize(socket fd: Int32) -> PeerAuthDecision
}

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

public struct PeerAuthFailure: Error, Equatable, Sendable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
}

/// The decision, with both of its OS-facing halves injectable so the rule itself is unit-tested with fakes:
/// no token → reject; a token whose code does not satisfy the requirement → reject; otherwise accept.
public struct PeerAuthPolicy: PeerAuthenticator {
    public var readToken: @Sendable (Int32) throws -> PeerToken
    public var checkCode: @Sendable (PeerToken) throws -> Void

    public init(readToken: @escaping @Sendable (Int32) throws -> PeerToken, checkCode: @escaping @Sendable (PeerToken) throws -> Void) {
        self.readToken = readToken
        self.checkCode = checkCode
    }

    public func authorize(socket fd: Int32) -> PeerAuthDecision {
        let token: PeerToken
        do {
            token = try readToken(fd)
        } catch let failure as PeerAuthFailure {
            return .reject(reason: failure.reason)
        } catch {
            return .reject(reason: "could not read the peer's audit token")
        }
        do {
            try checkCode(token)
        } catch let failure as PeerAuthFailure {
            return .reject(reason: "pid \(token.pid): \(failure.reason)")
        } catch {
            return .reject(reason: "pid \(token.pid): its code failed the requirement")
        }
        return .accept(pid: token.pid)
    }
}

/// The real check: `getsockopt(LOCAL_PEERTOKEN)` → `SecCodeCopyGuestWithAttributes(audit token)` →
/// `SecCodeCheckValidity` against the stated designated requirement of the daemon this helper serves.
public struct CodeSigningPeerAuthenticator: PeerAuthenticator {
    private let policy: PeerAuthPolicy

    /// Throws when `requirement` does not compile — the helper refuses to start rather than run unguarded.
    public init(requirement text: String) throws {
        var compiled: SecRequirement?
        let status = SecRequirementCreateWithString(text as CFString, SecCSFlags(), &compiled)
        guard status == errSecSuccess, let requirement = compiled else {
            throw PeerAuthFailure("the designated requirement does not compile (OSStatus \(status))")
        }
        let box = RequirementBox(requirement)
        policy = PeerAuthPolicy(
            readToken: { try CodeSigningPeerAuthenticator.peerToken(socket: $0) },
            checkCode: { token in try CodeSigningPeerAuthenticator.check(token: token, requirement: box.requirement) }
        )
    }

    public func authorize(socket fd: Int32) -> PeerAuthDecision {
        policy.authorize(socket: fd)
    }

    public static func peerToken(socket fd: Int32) throws -> PeerToken {
        var token = audit_token_t()
        var length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0,
              length == socklen_t(MemoryLayout<audit_token_t>.size) else {
            throw PeerAuthFailure("LOCAL_PEERTOKEN failed: \(String(cString: strerror(errno)))")
        }
        var pid: pid_t = 0
        var pidLength = socklen_t(MemoryLayout<pid_t>.size)
        if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidLength) != 0 { pid = -1 }
        return PeerToken(auditToken: withUnsafeBytes(of: &token) { Data($0) }, pid: pid)
    }

    public static func check(token: PeerToken, requirement: SecRequirement) throws {
        var guest: SecCode?
        let attributes = [kSecGuestAttributeAudit: token.auditToken] as CFDictionary
        let copied = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &guest)
        guard copied == errSecSuccess, let code = guest else {
            throw PeerAuthFailure("no code object for the peer (OSStatus \(copied))")
        }
        let valid = SecCodeCheckValidity(code, SecCSFlags(), requirement)
        guard valid == errSecSuccess else {
            throw PeerAuthFailure("its code does not satisfy the daemon's designated requirement (OSStatus \(valid))")
        }
    }
}

/// `SecRequirement` is an immutable CF object; this lets it ride in the `@Sendable` check closure.
private final class RequirementBox: @unchecked Sendable {
    let requirement: SecRequirement
    init(_ requirement: SecRequirement) { self.requirement = requirement }
}
