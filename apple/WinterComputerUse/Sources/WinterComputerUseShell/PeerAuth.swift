import Darwin
import Foundation
import Security

/// Who may connect: the daemon (all automation) and Winter.app (the in-window mirror's view stream). Each is a
/// designated requirement; a peer is told apart by which ones its code satisfies.
public enum PeerClientKind: String, Sendable, Hashable, CaseIterable {
    case daemon
    case app
}

/// Whether a connected peer may talk to the helper. Decided before a single byte is read; a rejected peer is
/// closed with no response at all. An accepted peer carries every client kind its code satisfies, and its
/// `hello.client` must be one of them.
public enum PeerAuthDecision: Equatable, Sendable {
    case accept(pid: pid_t, clients: Set<PeerClientKind>)
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
/// no token → reject; a token whose code satisfies none of the client requirements → reject; otherwise accept
/// with the set it satisfies (the token is read once; every client kind is checked against it).
public struct PeerAuthPolicy: PeerAuthenticator {
    public var readToken: @Sendable (Int32) throws -> PeerToken
    public var checkCode: @Sendable (PeerToken, PeerClientKind) throws -> Void
    public var kinds: [PeerClientKind]

    public init(kinds: [PeerClientKind] = PeerClientKind.allCases,
                readToken: @escaping @Sendable (Int32) throws -> PeerToken,
                checkCode: @escaping @Sendable (PeerToken, PeerClientKind) throws -> Void) {
        self.kinds = kinds
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
        var satisfied: Set<PeerClientKind> = []
        var reasons: [String] = []
        for kind in kinds {
            do {
                try checkCode(token, kind)
                satisfied.insert(kind)
            } catch let failure as PeerAuthFailure {
                reasons.append("\(kind.rawValue): \(failure.reason)")
            } catch {
                reasons.append("\(kind.rawValue): its code failed the requirement")
            }
        }
        guard !satisfied.isEmpty else { return .reject(reason: "pid \(token.pid): \(reasons.joined(separator: "; "))") }
        return .accept(pid: token.pid, clients: satisfied)
    }
}

/// The real check: `getsockopt(LOCAL_PEERTOKEN)` → `SecCodeCopyGuestWithAttributes(audit token)` →
/// `SecCodeCheckValidity` against the stated designated requirement of each client this helper serves: the
/// daemon of its home, and the Winter.app of its profile.
public struct CodeSigningPeerAuthenticator: PeerAuthenticator {
    private let policy: PeerAuthPolicy

    /// Throws when a requirement does not compile — the helper refuses to start rather than run unguarded.
    public init(requirements texts: [PeerClientKind: String]) throws {
        var compiled: [PeerClientKind: RequirementBox] = [:]
        for (kind, text) in texts {
            var requirement: SecRequirement?
            let status = SecRequirementCreateWithString(text as CFString, SecCSFlags(), &requirement)
            guard status == errSecSuccess, let requirement else {
                throw PeerAuthFailure("the \(kind.rawValue) designated requirement does not compile (OSStatus \(status))")
            }
            compiled[kind] = RequirementBox(requirement)
        }
        let boxes = compiled
        policy = PeerAuthPolicy(
            kinds: PeerClientKind.allCases.filter { boxes[$0] != nil },
            readToken: { try CodeSigningPeerAuthenticator.peerToken(socket: $0) },
            checkCode: { token, kind in
                guard let box = boxes[kind] else { throw PeerAuthFailure("no requirement") }
                try CodeSigningPeerAuthenticator.check(token: token, requirement: box.requirement)
            }
        )
    }

    /// The daemon alone (tests).
    public init(requirement text: String) throws {
        try self.init(requirements: [.daemon: text])
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
            throw PeerAuthFailure("its code does not satisfy the designated requirement (OSStatus \(valid))")
        }
    }
}

/// `SecRequirement` is an immutable CF object; this lets it ride in the `@Sendable` check closure.
private final class RequirementBox: @unchecked Sendable {
    let requirement: SecRequirement
    init(_ requirement: SecRequirement) { self.requirement = requirement }
}
