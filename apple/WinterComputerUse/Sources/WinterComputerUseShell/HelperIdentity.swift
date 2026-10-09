import Darwin
import Foundation

/// Which Winter the helper serves, read from its own bundle id — never from an argument (LaunchServices does
/// not hand arguments to an instance that is already running).
public enum HelperProfile: String, Sendable {
    /// `com.winter.computeruse`, embedded in Winter.app; serves `~/.winter`.
    case dist
    /// `com.winter.computeruse.dev`, built by `bun run dev:helper` into `dist/dev/`; serves `~/.winter-dev`.
    case dev
    /// `com.winter.computeruse.test`, built only by `bun run verify:computer-helper` with the
    /// `WINTER_CU_TEST_BUILD` compilation condition; serves whatever temp home it is given.
    case test
}

/// What a test build's `main.swift` read from its environment. Never constructed by a dev or release build:
/// the code that reads those variables exists only under `#if WINTER_CU_TEST_BUILD`, and even when present it
/// is honoured only by the `test` profile.
public struct HelperTestHooks: Sendable, Equatable {
    /// The designated requirement the test helper accepts in place of the daemon's — a fake daemon identity
    /// (`always` accepts any signed peer).
    public var daemonRequirement: String?
    /// A shorter idle quit, so a verification run can watch the helper leave.
    public var idleSeconds: TimeInterval?
    /// The requirement accepted in place of Winter.app's — a fake app identity (`never` when absent).
    public var appRequirement: String?

    public init(daemonRequirement: String?, idleSeconds: TimeInterval?, appRequirement: String? = nil) {
        self.daemonRequirement = daemonRequirement
        self.idleSeconds = idleSeconds
        self.appRequirement = appRequirement
    }
}

/// The code identities the helper and the daemon name each other by.
public enum WinterCodeIdentity {
    /// Winter's Apple team (the signing certificate's OU).
    public static let teamID = "37N77U9RSZ"

    public static let distHelperBundleID = "com.winter.computeruse"
    public static let devHelperBundleID = "com.winter.computeruse.dev"
    public static let testHelperBundleID = "com.winter.computeruse.test"

    /// The shipped daemon's signing identifier. The release build signs the embedded `winter-core` without an
    /// explicit `--identifier`, so codesign names it after the file: `winter-core` (measured on 0.124.0's
    /// `Contents/Resources/winter-core`), not `com.winter.core`. Changing it would change the daemon's
    /// designated requirement, which every Keychain item's access list names — so the helper accepts what ships.
    public static let distDaemonIdentifier = "winter-core"
    /// The signed dev daemon (`bun run dev:daemon`, `scripts/dev-daemon-lib.ts`).
    public static let devDaemonIdentifier = "com.winter.core.dev"
    /// Winter.app (signed with its bundle id), the second client: it renders the in-window mirror.
    public static let distAppIdentifier = "com.winter.app"
    public static let devAppIdentifier = "com.winter.app.dev"
    /// The live ComputerV2 suite's own daemon and mirror probe (`scripts/cu-live`). TEST-ONLY identifiers: a
    /// binary carrying the dev identifiers above would satisfy the dev Keychain items' access lists and the
    /// pairing tokens'; these satisfy nothing but a dev helper serving a live-test home (`isLiveTestHome`).
    public static let liveTestDaemonIdentifier = "com.winter.core.cutest"
    public static let liveTestAppIdentifier = "com.winter.app.cutest"

    /// A stated designated requirement: the identifier and Winter's team under Apple's anchor — the shape
    /// `scripts/dev-daemon-lib.ts` signs the dev daemon with, which any Winter-team certificate satisfies.
    public static func requirement(identifier: String, team: String = teamID) -> String {
        "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    }
}

public enum HelperIdentityError: Error, CustomStringConvertible, Equatable {
    case unknownBundle(String?)
    case testBuildRequired(String)
    case missingHomeOverride
    case relativeHome(String)
    case homeMissing(String)

    public var description: String {
        switch self {
        case .unknownBundle(let id):
            return "unknown helper bundle id \(id ?? "(none)") — expected \(WinterCodeIdentity.distHelperBundleID) or \(WinterCodeIdentity.devHelperBundleID)"
        case .testBuildRequired(let why):
            return "the test helper runs only from a test build \(why)"
        case .missingHomeOverride:
            return "the test helper needs WINTER_CU_HOME"
        case .relativeHome(let path):
            return "WINTER_CU_HOME must be an absolute path (got \(path))"
        case .homeMissing(let path):
            return "the Winter home \(path) does not exist — the helper never creates a home; the daemon's first boot does"
        }
    }
}

/// Everything the helper derives about itself at launch.
public struct HelperIdentity: Sendable, Equatable {
    public static let socketName = "computer-use.sock"
    public static let defaultIdleQuitSeconds: TimeInterval = 600

    public let profile: HelperProfile
    public let bundleIdentifier: String
    /// The home it serves, canonical (`realpath`), so `hello.home` compares by the same rule.
    public let home: String
    /// Where the home came from: `"default"` or `"WINTER_CU_HOME"`.
    public let homeSource: String
    /// A dev helper serving the live suite's temp home (`isLiveTestHome`): it accepts the suite's test identities
    /// INSTEAD of the dev daemon's and Winter Dev's.
    public let liveTest: Bool
    public let socketPath: String
    /// The designated requirement a connecting daemon must satisfy.
    public let daemonRequirement: String
    /// The designated requirement a connecting Winter.app must satisfy.
    public let appRequirement: String
    public let helperVersion: String
    public let idleQuitSeconds: TimeInterval

    /// - Parameters:
    ///   - bundlePath: the helper's own `.app`, to tell an installed copy (inside Winter.app's
    ///     `Contents/Helpers`) from a dev or test build.
    ///   - userHome: the user's home directory (`~`).
    ///   - temporaryDirectory: the per-user temp dir (`NSTemporaryDirectory()`), where a live-test home lives.
    public static func resolve(bundleIdentifier: String?, bundlePath: String, environment: [String: String],
                               userHome: String, helperVersion: String,
                               testHooks: HelperTestHooks?,
                               temporaryDirectory: String = NSTemporaryDirectory()) throws -> HelperIdentity {
        let override = environment["WINTER_CU_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        let profile: HelperProfile
        let defaultHome: String?
        let requirement: String
        let appRequirement: String
        var idleSeconds = defaultIdleQuitSeconds
        switch bundleIdentifier {
        case WinterCodeIdentity.distHelperBundleID:
            profile = .dist
            defaultHome = (userHome as NSString).appendingPathComponent(".winter")
            requirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.distDaemonIdentifier)
            appRequirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.distAppIdentifier)
        case WinterCodeIdentity.devHelperBundleID:
            profile = .dev
            defaultHome = (userHome as NSString).appendingPathComponent(".winter-dev")
            requirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devDaemonIdentifier)
            appRequirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devAppIdentifier)
        case WinterCodeIdentity.testHelperBundleID:
            // No variable names in these messages: the test hooks' names must not appear in a dev or release
            // binary at all (release.ts scans the shipped helper for them).
            guard let hooks = testHooks else { throw HelperIdentityError.testBuildRequired("(this one has no test hooks)") }
            guard let fake = hooks.daemonRequirement, !fake.isEmpty else {
                throw HelperIdentityError.testBuildRequired("given a fake daemon requirement")
            }
            profile = .test
            defaultHome = nil
            requirement = fake
            appRequirement = hooks.appRequirement.flatMap { $0.isEmpty ? nil : $0 } ?? "never"
            if let seconds = hooks.idleSeconds, seconds > 0 { idleSeconds = seconds }
        default:
            throw HelperIdentityError.unknownBundle(bundleIdentifier)
        }

        // WINTER_CU_HOME: never for the shipped identity, and never for a copy installed inside an app.
        let honoursOverride = profile != .dist && !isEmbeddedInApp(bundlePath: bundlePath)
        let chosen: String
        let source: String
        if honoursOverride, let override {
            guard override.hasPrefix("/") else { throw HelperIdentityError.relativeHome(override) }
            chosen = override
            source = "WINTER_CU_HOME"
        } else if let defaultHome {
            chosen = defaultHome
            source = "default"
        } else {
            throw HelperIdentityError.missingHomeOverride
        }
        guard let canonical = canonicalPath(chosen) else { throw HelperIdentityError.homeMissing(chosen) }
        // The live suite (`bun run e2e:cu-live`): a DEV helper launched for a home inside a `winter-cu-live-` run dir
        // under the temp dir serves that run's test daemon and probe, and nothing else — the requirement is chosen
        // here, once, at startup. Every other dev helper keeps demanding the dev daemon and Winter Dev.
        let liveTest = profile == .dev && source == "WINTER_CU_HOME" && isLiveTestHome(canonical, temporaryDirectory: temporaryDirectory)
        return HelperIdentity(
            profile: profile,
            bundleIdentifier: bundleIdentifier ?? "",
            home: canonical,
            homeSource: source,
            liveTest: liveTest,
            socketPath: ((canonical as NSString).appendingPathComponent("run") as NSString).appendingPathComponent(socketName),
            daemonRequirement: liveTest ? WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.liveTestDaemonIdentifier) : requirement,
            appRequirement: liveTest ? WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.liveTestAppIdentifier) : appRequirement,
            helperVersion: helperVersion,
            idleQuitSeconds: idleSeconds
        )
    }

    /// `<temp>/winter-cu-live-<anything>/<home…>`: a home INSIDE a live-suite run dir directly under the temp dir
    /// (canonical paths on both sides). The run dir itself is not a home.
    public static func isLiveTestHome(_ canonicalHome: String, temporaryDirectory: String) -> Bool {
        guard let temp = canonicalPath(temporaryDirectory) else { return false }
        let prefix = temp.hasSuffix("/") ? temp : temp + "/"
        guard canonicalHome.hasPrefix(prefix) else { return false }
        let parts = canonicalHome.dropFirst(prefix.count).split(separator: "/")
        guard parts.count >= 2, let runDir = parts.first else { return false }
        return runDir.hasPrefix("winter-cu-live-") && runDir.count > "winter-cu-live-".count
    }

    /// `…/<Something>.app/Contents/Helpers/<Helper>.app` — the installed shape.
    public static func isEmbeddedInApp(bundlePath: String) -> Bool {
        let parts = (bundlePath as NSString).standardizingPath.split(separator: "/").map(String.init)
        guard parts.count >= 4 else { return false }
        let n = parts.count
        return parts[n - 1].hasSuffix(".app") && parts[n - 2] == "Helpers" && parts[n - 3] == "Contents" && parts[n - 4].hasSuffix(".app")
    }

    /// `realpath(3)`: both sides of the `hello.home` comparison go through it, so `/var` vs `/private/var` and
    /// a symlinked home compare equal. `nil` when the path does not exist.
    public static func canonicalPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
