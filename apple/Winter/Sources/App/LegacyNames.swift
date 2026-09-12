/// Winter Phase 9b (P9b-6): the ONLY Swift file that spells the pre-rename ("Norma") names.
///
/// This app is Winter now — every other source file uses the new vocabulary. These constants
/// exist purely so the two legacy-teardown call sites (`LaunchdMigration.swift`'s
/// `migrateFromLaunchdAgent`, `CliLauncher.swift`'s `removeLegacyDevWrapper(besides:)`) can find
/// and retire artifacts a PRE-RENAME build of this app left behind on disk/launchd — they are
/// deliberately the OLD literals, not the current ones. Never read by feature code otherwise.
///
/// TS twin: `packages/core/src/legacy-names.ts` (P9b-6). 9c's migrator (WS-16 §18) is this file's
/// eventual consumer for the home-directory/Keychain-service migration; until then it backs only
/// the two teardowns above.
enum LegacyNames {
    /// The historical launchd `KeepAlive` agent label (`packages/cli/src/launchd.ts`'s pre-rename
    /// `installDaemon`), superseded by `DaemonSupervisor` embedding `winter-core` directly. A
    /// leftover agent under this label would relaunch a daemon the app just killed.
    static let launchdAgentLabel = "com.norma.core"
    /// Sibling dev-wrapper filenames an earlier (pre-rename) build may have installed next to the
    /// current `winter-dev` wrapper. `CliLauncher.removeLegacyDevWrapper(besides:)` removes a
    /// sibling by one of these names iff its bytes prove it was our own bun wrapper.
    static let devWrapperNames = ["norma", "norma-dev"]
    static let homeDirName = ".norma"
    static let devHomeDirName = ".norma-dev"
    static let keychainService = "com.norma.core"
    static let keychainServiceDev = "com.norma.core.dev"
    static let cliLink = "/usr/local/bin/norma"
}
