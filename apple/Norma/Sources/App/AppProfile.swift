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

    /// Menu-bar asset-name prefix (Task 5 loads `mb-…` / `mb-dev-…`).
    static var menuBarAssetPrefix: String { isDev ? "mb-dev" : "mb" }

    /// Exports NORMA_HOME + NORMA_PROFILE into this process's env (respecting pre-set values) so
    /// NormaPaths, NormaKit, and every spawned child (daemon, helper tools) inherit one identity.
    static func bootstrapEnvironment() {
        setenv("NORMA_HOME", defaultNormaHome, 0)          // 0 = never overwrite an explicit env
        setenv("NORMA_PROFILE", isDev ? "dev" : "dist", 0)
    }
}
