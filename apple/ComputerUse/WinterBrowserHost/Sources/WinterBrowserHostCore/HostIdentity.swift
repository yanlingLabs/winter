import Foundation

/// Which Winter the host serves, read from its ENCLOSING app's bundle id — the Winter Computer Use helper it ships in —
/// never from an argument (Chrome passes only the caller's origin).
public enum HostProfile: String, Sendable, Equatable {
    /// Inside `com.winter.computeruse` (embedded in Winter.app): serves `~/.winter`.
    case dist
    /// Inside `com.winter.computeruse.dev` (`bun run dev:helper`'s build in `dist/dev/`): serves `~/.winter-dev`.
    case dev
    /// A test build (the test-build compilation condition), inside the test helper or standalone: serves the home it is given.
    case test
}

/// What a test build's `main.swift` read from its environment. A dev or release binary never constructs one: the code
/// that reads those variables compiles only under the test-build condition, in `Tool/main.swift`; no variable name appears here.
public struct HostTestHooks: Sendable, Equatable {
    /// The home to serve instead of the profile's (honoured only when the host is not inside an installed Winter.app).
    public var home: String?
    /// The designated requirement the daemon must satisfy instead of the real one — a fake daemon identity.
    public var daemonRequirement: String?

    public init(home: String?, daemonRequirement: String?) {
        self.home = home
        self.daemonRequirement = daemonRequirement
    }
}

/// The code identities the host and the daemon name each other by.
public enum HostCodeIdentity {
    /// Winter's Apple team (the signing certificate's OU).
    public static let teamID = "37N77U9RSZ"

    public static let distHelperBundleID = "com.winter.computeruse"
    public static let devHelperBundleID = "com.winter.computeruse.dev"
    public static let testHelperBundleID = "com.winter.computeruse.test"

    /// The host's own codesign identifiers (each signed with a stated requirement naming it).
    public static let distHostIdentifier = "com.winter.browserhost"
    public static let devHostIdentifier = "com.winter.browserhost.dev"
    public static let testHostIdentifier = "com.winter.browserhost.test"

    /// The shipped daemon (`winter-core`, signed without `--identifier`, so named after its file) and the signed dev
    /// daemon — the same identities the helper accepts.
    public static let distDaemonIdentifier = "winter-core"
    public static let devDaemonIdentifier = "com.winter.core.dev"

    /// The native-messaging host names Chrome knows the host by (each manifest's `name`).
    public static let distNativeHostName = "com.winter.browser"
    public static let devNativeHostName = "com.winter.browser.dev"

    /// A stated designated requirement: the identifier and Winter's team under Apple's anchor.
    public static func requirement(identifier: String, team: String = teamID) -> String {
        "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
    }
}

public enum HostIdentityError: Error, CustomStringConvertible, Equatable {
    case notInsideTheHelper(String)
    case testBuildRequired
    case missingHome
    case relativeHome(String)
    case missingDaemonRequirement

    public var description: String {
        switch self {
        case .notInsideTheHelper(let path):
            return "winter-browser-host runs only from inside Winter Computer Use (it is at \(path))"
        case .testBuildRequired:
            return "the test host runs only from a test build"
        case .missingHome:
            return "the test host needs a home"
        case .relativeHome(let path):
            return "the test host's home must be an absolute path (got \(path))"
        case .missingDaemonRequirement:
            return "the test host needs a fake daemon requirement"
        }
    }
}

/// Everything the host derives about itself at launch.
public struct HostIdentity: Sendable, Equatable {
    public let profile: HostProfile
    /// The Winter home whose daemon it talks to.
    public let home: String
    /// `<home>/run/browser.sock`.
    public let socketPath: String
    /// The designated requirement the daemon on the socket must satisfy.
    public let daemonRequirement: String
    /// The extension ids it serves.
    public let allowedExtensionIds: [String]
    /// The enclosing helper's version (`CFBundleShortVersionString`), reported as `hostVersion`.
    public let hostVersion: String

    /// - Parameters:
    ///   - executablePath: the host's own executable (`…/Winter Computer Use.app/Contents/MacOS/winter-browser-host`).
    ///   - helperInfo: reads an app bundle's Info.plist (injectable for tests) → (bundle id, short version).
    ///   - userHome: the user's home directory.
    public static func resolve(executablePath: String,
                               userHome: String,
                               testHooks: HostTestHooks?,
                               helperInfo: (String) -> (bundleId: String?, version: String?) = HostIdentity.bundleInfo) throws -> HostIdentity {
        let app = enclosingApp(executablePath: executablePath)
        let info = app.map(helperInfo) ?? (bundleId: nil, version: nil)
        let embeddedInInstalledApp = app.map(isEmbeddedInApp(bundlePath:)) ?? false
        let hooks = embeddedInInstalledApp ? nil : testHooks
        let version = info.version ?? "0.0.0"

        let profile: HostProfile
        var home: String
        var requirement: String
        switch info.bundleId {
        case HostCodeIdentity.distHelperBundleID:
            profile = .dist
            home = (userHome as NSString).appendingPathComponent(".winter")
            requirement = HostCodeIdentity.requirement(identifier: HostCodeIdentity.distDaemonIdentifier)
        case HostCodeIdentity.devHelperBundleID:
            profile = .dev
            home = (userHome as NSString).appendingPathComponent(".winter-dev")
            requirement = HostCodeIdentity.requirement(identifier: HostCodeIdentity.devDaemonIdentifier)
        default:
            // The test helper, or no helper at all: a test build only.
            guard let hooks else {
                if info.bundleId == HostCodeIdentity.testHelperBundleID { throw HostIdentityError.testBuildRequired }
                throw HostIdentityError.notInsideTheHelper(executablePath)
            }
            guard let fake = hooks.daemonRequirement, !fake.isEmpty else { throw HostIdentityError.missingDaemonRequirement }
            guard let testHome = hooks.home, !testHome.isEmpty else { throw HostIdentityError.missingHome }
            profile = .test
            home = testHome
            requirement = fake
        }
        // A test build outside an installed Winter.app may be pointed at another home and a fake daemon identity.
        if let hooks, profile != .test {
            if let h = hooks.home, !h.isEmpty { home = h }
            if let r = hooks.daemonRequirement, !r.isEmpty { requirement = r }
        }
        guard home.hasPrefix("/") else { throw HostIdentityError.relativeHome(home) }
        return HostIdentity(
            profile: profile,
            home: home,
            socketPath: ((home as NSString).appendingPathComponent("run") as NSString).appendingPathComponent(HostProtocol.socketName),
            daemonRequirement: requirement,
            allowedExtensionIds: profile == .dist ? ExtensionIds.dist : ExtensionIds.dev,
            hostVersion: version
        )
    }

    /// `<A>.app` for `<A>.app/Contents/MacOS/<executable>`, else nil.
    public static func enclosingApp(executablePath: String) -> String? {
        let parts = (executablePath as NSString).standardizingPath.split(separator: "/").map(String.init)
        guard parts.count >= 4 else { return nil }
        let n = parts.count
        guard parts[n - 2] == "MacOS", parts[n - 3] == "Contents", parts[n - 4].hasSuffix(".app") else { return nil }
        return "/" + parts[0...(n - 4)].joined(separator: "/")
    }

    /// `…/<Something>.app/Contents/Helpers/<Helper>.app` — the installed shape (inside Winter.app).
    public static func isEmbeddedInApp(bundlePath: String) -> Bool {
        let parts = (bundlePath as NSString).standardizingPath.split(separator: "/").map(String.init)
        guard parts.count >= 4 else { return false }
        let n = parts.count
        return parts[n - 1].hasSuffix(".app") && parts[n - 2] == "Helpers" && parts[n - 3] == "Contents" && parts[n - 4].hasSuffix(".app")
    }

    public static func bundleInfo(_ appPath: String) -> (bundleId: String?, version: String?) {
        let plist = ((appPath as NSString).appendingPathComponent("Contents") as NSString).appendingPathComponent("Info.plist")
        guard let data = FileManager.default.contents(atPath: plist),
              let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return (nil, nil) }
        return (dict["CFBundleIdentifier"] as? String, dict["CFBundleShortVersionString"] as? String)
    }
}
