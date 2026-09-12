import Foundation

/// Compile-time dev/distribution identity (Approach A: Debug config IS dev, Release IS dist).
/// The single Swift-side truth for home, name, and asset-set selection. `bootstrapEnvironment()`
/// must run before ANYTHING touches `WinterPaths` (it reads `WINTER_HOME` from the process env):
/// call it first in `applicationDidFinishLaunching` / the app entry point.
enum AppProfile {
    #if DEBUG
    static let isDev = true
    #else
    static let isDev = false
    #endif

    static var displayName: String { isDev ? "Winter Dev" : "Winter" }

    /// `~/.winter-dev` (dev) / `~/.winter` (dist) — the DEFAULT; an explicit `WINTER_HOME` env wins.
    static var defaultWinterHome: String {
        NSHomeDirectory() + (isDev ? "/.winter-dev" : "/.winter")
    }

    /// devfix (socket strand): the Winter home THIS process should actually dial/read against —
    /// same precedence as `bootstrapEnvironment()`'s own `setenv(..., 0)` (an explicit `WINTER_HOME`
    /// wins, else `defaultWinterHome`), but read via the raw POSIX `getenv` — the exact counterpart
    /// of the `setenv` `bootstrapEnvironment()` writes with — rather than `ProcessInfo.
    /// processInfo.environment` (what `WinterKit`'s `WinterPaths.homeDirectory()` reads). The live
    /// gate that found the keychain-service bug (v-dev-dist-split) found a second, same-shaped gap
    /// here: `AppModel.production()`/`RemoteAccessCoordinator` called `WinterPaths.socketPath()`
    /// directly, which re-derives `$WINTER_HOME` independently of this profile's own resolution —
    /// on the live Mac the two disagreed, so the dev app dialed the DIST socket (where an old
    /// dist-era daemon was listening) with a dev token, hanging/failing auth. Every daemon-facing
    /// path call now resolves its home HERE, once, and passes it explicitly into `WinterPaths.
    /// socketPath(home:)`/`settingsPath(home:)` instead of trusting a second, independent read to
    /// agree.
    static var winterHome: String {
        if let raw = getenv("WINTER_HOME") { return String(cString: raw) }
        return defaultWinterHome
    }

    /// Menu-bar asset-name prefix (Task 5 loads `mb-…` / `mb-dev-…`).
    static var menuBarAssetPrefix: String { isDev ? "mb-dev" : "mb" }

    /// Keychain service this profile's daemon stores its tokens under — mirrors
    /// `packages/core/src/profile.ts`'s `keychainService()` exactly (dist stays the historical
    /// literal, never migrate). Every `KeychainToken` read (`AppModel.production()`,
    /// `RemoteHost.Config`) must pass this, not the bare `"com.winter.core"` default — otherwise a
    /// dev-profile app reads the DIST daemon's token and fails to authenticate against its own dev
    /// daemon (the bug this property exists to prevent).
    static var keychainService: String { isDev ? "com.winter.core.dev" : "com.winter.core" }

    /// Exports WINTER_HOME + WINTER_PROFILE into this process's env (respecting pre-set values) so
    /// WinterPaths, WinterKit, and every spawned child (daemon, helper tools) inherit one identity.
    static func bootstrapEnvironment() {
        setenv("WINTER_HOME", defaultWinterHome, 0)          // 0 = never overwrite an explicit env
        setenv("WINTER_PROFILE", isDev ? "dev" : "dist", 0)
    }
}
