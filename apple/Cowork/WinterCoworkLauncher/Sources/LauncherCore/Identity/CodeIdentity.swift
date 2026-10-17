import Foundation
import Security
import CryptoKit
import LauncherNative

/// The code identities the launcher names its parent and its worker by.
public enum WinterCodeIdentity {
    /// Winter's Apple team (the signing certificate's OU).
    public static let teamID = "37N77U9RSZ"

    /// The daemon's signing identifier in the production requirement, as the owner's brief for this slice states it.
    ///
    /// REVIEW NEEDED: the Computer Use helper (`HelperIdentity.swift`, `scripts/computer-helper-lib.ts` DAEMON_IDENTIFIER) records that
    /// the SHIPPED daemon is signed WITHOUT `--identifier` and so carries the file's name, `winter-core`, and that changing it would
    /// change the daemon's designated requirement, which every Keychain access list names. If that still holds, this launcher refuses
    /// the shipped daemon. One constant; nothing else depends on it.
    public static let distDaemonIdentifier = "com.winter.core"
    public static let devDaemonIdentifier = "com.winter.core.dev"
    /// From the plan (section 4); the worker's signing identity is S3's to confirm.
    public static let workerIdentifier = "com.winter.cowork.worker"
    public static let launcherIdentifier = "com.winter.cowork.launcher"

    /// A stated designated requirement: the identifier and Winter's team under Apple's anchor.
    public static func requirement(identifier: String, team: String = teamID) -> String {
        "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    }
    /// A requirement that pins one exact code directory hash (test builds only ever construct this from launcher-main).
    public static func cdhashRequirement(_ hex: String) -> String { "cdhash H\"\(hex)\"" }
}

public enum LauncherProfile: String, Sendable {
    case production, dev
    public var parentRequirementText: String {
        WinterCodeIdentity.requirement(identifier: self == .production ? WinterCodeIdentity.distDaemonIdentifier : WinterCodeIdentity.devDaemonIdentifier)
    }
    public var workerRequirementText: String { WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.workerIdentifier) }
}

public struct IdentityFailure: Error, Equatable, CustomStringConvertible, Sendable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
    public var description: String { reason }
}

/// A compiled code requirement. Creating one is the proof that its text is well-formed: a launcher with a requirement that does
/// not compile refuses to start rather than run unguarded.
public final class CodeRequirement: @unchecked Sendable {
    public let text: String
    let requirement: SecRequirement
    public init(_ text: String) throws {
        var compiled: SecRequirement?
        let status = SecRequirementCreateWithString(text as CFString, SecCSFlags(), &compiled)
        guard status == errSecSuccess, let compiled else { throw IdentityFailure("the code requirement does not compile (OSStatus \(status))") }
        self.text = text; self.requirement = compiled
    }
}

// ------------------------------------------------------------------------------------------------ the parent (L1)

public enum ParentAuthDecision: Equatable, Sendable {
    case accept(pid: Int32)
    case reject(reason: String)
}

public protocol ParentAuthenticating: Sendable {
    /// Decided before a single byte is read from L1. `socket` is the raw descriptor of the daemon's end of the pair.
    func authenticate(socket: Int32) -> ParentAuthDecision
}

/// The kernel's identity of the process on the other end of a Unix socket (pid AND pid version: immune to pid reuse).
public struct PeerToken: Equatable, Sendable {
    public let auditToken: Data
    public let pid: Int32
    public init(auditToken: Data, pid: Int32) { self.auditToken = auditToken; self.pid = pid }
}

/// The rule, with both OS-facing halves injectable so it is unit-tested with fakes:
///   1. the descriptor is an unnamed AF_UNIX stream socketpair (not something a stranger could have connected to);
///   2. a token must be readable (no token, no parent);
///   3. the token's pid must be the expected parent (the daemon SPAWNED this process, so its pid is knowable and trustworthy);
///   4. that code must satisfy the designated requirement.
/// A parse is never an authentication: nothing the daemon later writes can vouch for itself.
public struct ParentAuthPolicy: ParentAuthenticating {
    public var isUnnamedPair: @Sendable (Int32) -> Bool
    public var readToken: @Sendable (Int32) throws -> PeerToken
    public var checkCode: @Sendable (PeerToken) throws -> Void
    /// nil means "do not compare" (tests that have no parent relationship).
    public var expectedParentPid: Int32?

    public init(expectedParentPid: Int32?, isUnnamedPair: @escaping @Sendable (Int32) -> Bool, readToken: @escaping @Sendable (Int32) throws -> PeerToken,
                checkCode: @escaping @Sendable (PeerToken) throws -> Void) {
        self.expectedParentPid = expectedParentPid; self.isUnnamedPair = isUnnamedPair; self.readToken = readToken; self.checkCode = checkCode
    }

    public func authenticate(socket fd: Int32) -> ParentAuthDecision {
        guard isUnnamedPair(fd) else { return .reject(reason: "L1 is not an unnamed stream socketpair") }
        let token: PeerToken
        do { token = try readToken(fd) } catch let failure as IdentityFailure { return .reject(reason: failure.reason) } catch { return .reject(reason: "could not read the peer's audit token") }
        if let expected = expectedParentPid, token.pid != expected { return .reject(reason: "the peer is not the process that spawned this launcher") }
        do { try checkCode(token) } catch let failure as IdentityFailure { return .reject(reason: "pid \(token.pid): \(failure.reason)") } catch { return .reject(reason: "pid \(token.pid): its code failed the requirement") }
        return .accept(pid: token.pid)
    }
}

public enum CodeSigningParent {
    /// The real halves: `getsockopt(LOCAL_PEERTOKEN)` then `SecCodeCopyGuestWithAttributes(audit token)` then `SecCodeCheckValidity`.
    public static func authenticator(requirement: CodeRequirement, expectedParentPid: Int32? = getppid()) -> ParentAuthPolicy {
        ParentAuthPolicy(
            expectedParentPid: expectedParentPid,
            isUnnamedPair: { lc_is_unnamed_unix_socket($0, SOCK_STREAM) == 1 },
            readToken: { try peerToken(socket: $0) },
            checkCode: { try check(token: $0, requirement: requirement) })
    }
    public static func peerToken(socket fd: Int32) throws -> PeerToken {
        var token = [UInt8](repeating: 0, count: 32)
        guard lc_peer_token(fd, &token) == 0 else { throw IdentityFailure("LOCAL_PEERTOKEN failed: \(String(cString: strerror(errno)))") }
        var pid: pid_t = 0
        guard lc_peer_pid(fd, &pid) == 0 else { throw IdentityFailure("LOCAL_PEERPID failed") }
        return PeerToken(auditToken: Data(token), pid: pid)
    }
    public static func check(token: PeerToken, requirement: CodeRequirement) throws {
        var guest: SecCode?
        let attributes = [kSecGuestAttributeAudit: token.auditToken] as CFDictionary
        let copied = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &guest)
        guard copied == errSecSuccess, let code = guest else { throw IdentityFailure("no code object for the peer (OSStatus \(copied))") }
        let valid = SecCodeCheckValidity(code, SecCSFlags(), requirement.requirement)
        guard valid == errSecSuccess else { throw IdentityFailure("its code does not satisfy the designated requirement (OSStatus \(valid))") }
    }
}

// ------------------------------------------------------------------------------------------------ the worker image

public protocol WorkerImageVerifying: Sendable {
    /// The file on disk is still the file that was pinned (same device, inode, link count and contents).
    func validatePath() throws
    /// The EXECUTED image of the spawned process is valid, satisfies the requirement and is the pinned file's code.
    func validateExecuted(pid: Int32) throws
}

/// A port of the key broker's `FixedFixtureImage`, with the requirement stated instead of an ad-hoc pin: the path is canonical and
/// names a regular, singly-linked file; its device, inode and SHA-256 are pinned when this value is made and checked again right
/// before the spawn; the code directory hash of the file is pinned; and the process that was actually EXECUTED (looked up by the pid
/// of a child this process has not reaped, so the pid cannot have been recycled) must pass `SecCodeCheckValidity` with the strict
/// flag against the requirement and carry that same code directory hash.
public struct WorkerImage: WorkerImageVerifying {
    public let path: String
    private let device: UInt64
    private let inode: UInt64
    private let digest: Data
    private let codeHash: Data
    private let requirement: CodeRequirement

    public init(path: String, requirement: CodeRequirement) throws {
        var info = stat()
        guard path == URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path, lstat(path, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw IdentityFailure("the worker path is not a canonical, singly-linked regular file") }
        self.path = path; self.requirement = requirement
        device = UInt64(bitPattern: Int64(info.st_dev)); inode = info.st_ino
        digest = Data(SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: path))))
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code, let hash = Self.cdhash(of: code) else { throw IdentityFailure("the worker has no readable code signature") }
        codeHash = hash
    }

    private static func cdhash(of code: SecStaticCode) -> Data? {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let dictionary = information as? [String: Any], let hash = dictionary[kSecCodeInfoUnique as String] as? Data else { return nil }
        return hash
    }

    public func validatePath() throws {
        var info = stat()
        guard lstat(path, &info) == 0, UInt64(bitPattern: Int64(info.st_dev)) == device, info.st_ino == inode, info.st_nlink == 1,
              Data(SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: path)))) == digest else { throw IdentityFailure("the worker file changed after it was pinned") }
    }

    public func validateExecuted(pid: Int32) throws {
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
              SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement.requirement) == errSecSuccess else { throw IdentityFailure("the executed worker image failed its requirement") }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode, Self.cdhash(of: staticCode) == codeHash else { throw IdentityFailure("the executed worker image is not the pinned file") }
    }
}
