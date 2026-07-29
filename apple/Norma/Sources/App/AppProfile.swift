import Foundation

/// Compile-time dev/distribution identity (Approach A: Debug config IS dev, Release IS dist).
/// The single Swift-side truth for home, name, and asset-set selection. `bootstrapEnvironment()`
/// must run before ANYTHING touches `NormaPaths` (it reads `NORMA_HOME` from the process env):
/// call it first in `applicationDidFinishLaunching` / the app entry point.
enum AppProfile {
    #if DEBUG
    static let isDev = true
    #else
    static let isDev = false
    #endif

    static var displayName: String { isDev ? "Norma Dev" : "Norma" }

    /// `~/.norma-dev` (dev) / `~/.norma` (dist) — the DEFAULT; an explicit `NORMA_HOME` env wins.
    static var defaultNormaHome: String {
        NSHomeDirectory() + (isDev ? "/.norma-dev" : "/.norma")
    }

    /// devfix (socket strand): the Norma home THIS process should actually dial/read against —
    /// same precedence as `bootstrapEnvironment()`'s own `setenv(..., 0)` (an explicit `NORMA_HOME`
    /// wins, else `defaultNormaHome`), but read via the raw POSIX `getenv` — the exact counterpart
    /// of the `setenv` `bootstrapEnvironment()` writes with — rather than `ProcessInfo.
    /// processInfo.environment` (what `NormaKit`'s `NormaPaths.homeDirectory()` reads). The live
    /// gate that found the keychain-service bug (v-dev-dist-split) found a second, same-shaped gap
    /// here: `AppModel.production()`/`RemoteAccessCoordinator` called `NormaPaths.socketPath()`
    /// directly, which re-derives `$NORMA_HOME` independently of this profile's own resolution —
    /// on the live Mac the two disagreed, so the dev app dialed the DIST socket (where an old
    /// dist-era daemon was listening) with a dev token, hanging/failing auth. Every daemon-facing
    /// path call now resolves its home HERE, once, and passes it explicitly into `NormaPaths.
    /// socketPath(home:)`/`settingsPath(home:)` instead of trusting a second, independent read to
    /// agree.
    static var normaHome: String {
        if let raw = getenv("NORMA_HOME") { return String(cString: raw) }
        return defaultNormaHome
    }

    /// Menu-bar asset-name prefix (Task 5 loads `mb-…` / `mb-dev-…`).
    static var menuBarAssetPrefix: String { isDev ? "mb-dev" : "mb" }

    /// Keychain service this profile's daemon stores its tokens under — mirrors
    /// `packages/core/src/profile.ts`'s `keychainService()` exactly (dist stays the historical
    /// literal, never migrate). Every `KeychainToken` read (`AppModel.production()`,
    /// `RemoteHost.Config`) must pass this, not the bare `"com.norma.core"` default — otherwise a
    /// dev-profile app reads the DIST daemon's token and fails to authenticate against its own dev
    /// daemon (the bug this property exists to prevent).
    static var keychainService: String { isDev ? "com.norma.core.dev" : "com.norma.core" }

    /// Exports NORMA_HOME + NORMA_PROFILE into this process's env (respecting pre-set values) so
    /// NormaPaths, NormaKit, and every spawned child (daemon, helper tools) inherit one identity.
    static func bootstrapEnvironment() {
        setenv("NORMA_HOME", defaultNormaHome, 0)          // 0 = never overwrite an explicit env
        setenv("NORMA_PROFILE", isDev ? "dev" : "dist", 0)
    }
}
