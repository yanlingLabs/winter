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

    public init(daemonRequirement: String?, idleSeconds: TimeInterval?) {
        self.daemonRequirement = daemonRequirement
        self.idleSeconds = idleSeconds
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
    public let socketPath: String
    /// The designated requirement a connecting peer must satisfy.
    public let daemonRequirement: String
    public let helperVersion: String
    public let idleQuitSeconds: TimeInterval

    /// - Parameters:
    ///   - bundlePath: the helper's own `.app`, to tell an installed copy (inside Winter.app's
    ///     `Contents/Helpers`) from a dev or test build.
    ///   - userHome: the user's home directory (`~`).
    public static func resolve(bundleIdentifier: String?, bundlePath: String, environment: [String: String],
                               userHome: String, helperVersion: String,
                               testHooks: HelperTestHooks?) throws -> HelperIdentity {
        let override = environment["WINTER_CU_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        let profile: HelperProfile
        let defaultHome: String?
        let requirement: String
        var idleSeconds = defaultIdleQuitSeconds
        switch bundleIdentifier {
        case WinterCodeIdentity.distHelperBundleID:
            profile = .dist
            defaultHome = (userHome as NSString).appendingPathComponent(".winter")
            requirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.distDaemonIdentifier)
        case WinterCodeIdentity.devHelperBundleID:
            profile = .dev
            defaultHome = (userHome as NSString).appendingPathComponent(".winter-dev")
            requirement = WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devDaemonIdentifier)
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
        return HelperIdentity(
            profile: profile,
            bundleIdentifier: bundleIdentifier ?? "",
            home: canonical,
            homeSource: source,
            socketPath: ((canonical as NSString).appendingPathComponent("run") as NSString).appendingPathComponent(socketName),
            daemonRequirement: requirement,
            helperVersion: helperVersion,
            idleQuitSeconds: idleSeconds
        )
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
