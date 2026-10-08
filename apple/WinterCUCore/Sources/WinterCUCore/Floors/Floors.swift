import Foundation

/// The hard floors the helper enforces on its own (spine §2.4), as pure classifiers. The daemon enforces
/// them too; these exist so a daemon bug cannot open them. Every refusal is `refused` with a reason.
public enum CUFloors {
    // MARK: secure fields

    /// `AXSecureTextField` (as a subrole of `AXTextField`, or as a role some apps report).
    public static func isSecureField(role: String, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    // MARK: auth and system dialogs

    /// SecurityAgent/authorization, the login window, Keychain Access (and the Passwords app that
    /// replaced its UI), TCC consent prompts and the other system dialogs that guard trust decisions.
    public static let authBundleIds: Set<String> = [
        "com.apple.SecurityAgent",
        "com.apple.loginwindow",
        "com.apple.keychainaccess",
        "com.apple.Passwords",
        "com.apple.UserNotificationCenter",           // TCC consent prompts
        "com.apple.accessibility.universalAccessAuthWarn",
        "com.apple.coreservices.uiagent",             // Gatekeeper "are you sure you want to open…"
        "com.apple.LocalAuthentication.UIAgent",
        "com.apple.CoreAuthentication.UIAgent",
    ]
    /// Process names for the same agents when no bundle id is available.
    public static let authProcessNames: Set<String> = [
        "SecurityAgent", "loginwindow", "Keychain Access", "Passwords", "UserNotificationCenter",
        "universalAccessAuthWarn", "CoreServicesUIAgent", "coreautha", "LocalAuthenticationUIAgent",
        "LocalAuthenticationRemoteService",
    ]

    public static func isAuthOrSystemDialog(bundleId: String?, processName: String?) -> Bool {
        if let b = bundleId, authBundleIds.contains(b) { return true }
        if let p = processName, authProcessNames.contains(p) { return true }
        return false
    }

    // MARK: Winter itself

    /// The ones known today; anything under `com.winter.` counts (helpers, CEF helpers, office helper…).
    public static let winterBundleIds: Set<String> = [
        "com.winter.app", "com.winter.app.dev", "com.winter.computeruse", "com.winter.computeruse.dev",
    ]
    public static let winterBundlePrefix = "com.winter."

    public static func isWinterBundle(_ bundleId: String) -> Bool {
        bundleId.lowercased().hasPrefix(winterBundlePrefix)
    }

    public static func isWinterItself(bundleId: String?, pid: pid_t, ownPid: pid_t = getpid()) -> Bool {
        if pid == ownPid { return true }
        guard let b = bundleId else { return false }
        return isWinterBundle(b)
    }

    /// The computer-use helper itself (its mirrors and cursor overlay), dist and dev.
    public static let helperBundleIds: Set<String> = ["com.winter.computeruse", "com.winter.computeruse.dev"]

    /// Whether a whole-screen image leaves this app out: the helper's own windows, the auth agents, and the
    /// caller's list. Winter's own app windows are NOT left out (user ruling 2026-10-08): a whole-screen image
    /// is for seeing the screen; controlling an app needs a bind, and binding Winter stays refused.
    public static func excludedFromScreenshots(_ bundleId: String, extra: Set<String>) -> Bool {
        helperBundleIds.contains(bundleId) || authBundleIds.contains(bundleId) || extra.contains(bundleId)
    }

    /// Bundle ids every whole-screen image leaves out (the helper and the auth agents), besides the
    /// helper's own `Bundle.main` / pid and the caller's list.
    public static var alwaysExcludedFromScreenshots: Set<String> { helperBundleIds.union(authBundleIds) }

    // MARK: privacy panes

    public static let systemSettingsBundleIds: Set<String> = ["com.apple.systempreferences", "com.apple.Settings"]

    /// Window titles / sidebar selections of the Privacy & Security pane, in the most common UI languages.
    /// Titles alone are not enough (a sub-pane is titled e.g. "Accessibility"), so identifiers are checked too.
    static let privacyTitles: [String] = [
        "privacy & security", "privacy and security", "security & privacy", "datenschutz & sicherheit",
        "confidentialité et sécurité", "privacidad y seguridad", "privacy e sicurezza", "privacidade e segurança",
        "privacy en beveiliging", "プライバシーとセキュリティ", "隐私与安全性", "隱私權與安全性", "개인정보 보호 및 보안",
    ]
    static let privacyIdentifierMarkers: [String] = [
        "privacysecurity", "privacy_", "com.apple.preference.security", "privacyandsecurity", "privacy-security",
    ]

    /// `texts` are the window title, the selected sidebar row's name and similar; `identifiers` are AX
    /// identifiers found in the window. Any privacy marker in System Settings counts.
    public static func isPrivacyPane(bundleId: String?, texts: [String], identifiers: [String]) -> Bool {
        guard let b = bundleId, systemSettingsBundleIds.contains(b) else { return false }
        for t in texts {
            let f = t.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            if privacyTitles.contains(where: { f == $0 }) { return true }
        }
        for id in identifiers {
            let f = id.lowercased()
            if privacyIdentifierMarkers.contains(where: { f.contains($0) }) { return true }
        }
        return false
    }

    // MARK: save paths

    /// File names of shell startup files. Saving to one of these anywhere is refused.
    public static let shellStartupNames: Set<String> = [
        ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login",
        ".bash_logout", ".profile", ".kshrc", ".cshrc", ".tcshrc", ".login", ".logout", ".inputrc", "config.fish",
    ]

    public static func isShellStartupName(_ name: String) -> Bool {
        shellStartupNames.contains(name.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Folders whose whole tree a save must never land in: SSH keys, launchd jobs, and the agents' own
    /// configuration — Winter's homes (`~/.winter`, `~/.winter-dev`, with `sdk/settings.json`,
    /// `settings.json`, `sdk/.winter.json`, `run/`, `runtimes/`), any project's `.winter/` (its
    /// `settings*.json` and `mcp.json` grant tools; its rules and skills load into sessions), and `~/.claude`.
    /// A save there could grant an always-allowed app more power.
    public static let protectedFolderNames: Set<String> = [
        ".ssh", "LaunchAgents", "LaunchDaemons", ".winter", ".winter-dev", ".claude",
    ]

    /// File names protected wherever they are saved: agent config files that grant tools.
    public static let protectedConfigNames: Set<String> = [".claude.json", ".winter.json"]

    /// Whether `path` (absolute, `~`-relative, or a bare file name) names a protected destination: a shell
    /// startup file, an agent config file, or anything inside a protected folder (see `protectedFolderNames`).
    public static func isProtectedSavePath(_ path: String, home: String = NSHomeDirectory()) -> Bool {
        var p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return false }
        if p == "~" { p = home } else if p.hasPrefix("~/") { p = home + String(p.dropFirst(1)) }
        let standardized = (p as NSString).standardizingPath
        let components = (standardized as NSString).pathComponents.filter { $0 != "/" }
        if let last = components.last, isShellStartupName(last) || protectedConfigNames.contains(last) { return true }
        if components.contains(where: protectedFolderNames.contains) { return true }
        // A fish config lives at ~/.config/fish/config.fish; any fish conf.d is startup code too.
        if standardized.contains("/.config/fish/") { return true }
        return false
    }

    /// A save panel's destination: `fileName` (as typed in its name field) into the folder whose chain of
    /// display names, current folder first, is `folderChain` (as far as the panel shows it). Pure.
    public static func isProtectedSaveDestination(fileName: String, folderChain: [String],
                                                  home: String = NSHomeDirectory()) -> Bool {
        if typedSavePathIsProtected(fileName, home: home) { return true }
        if folderChain.contains(where: protectedFolderNames.contains) { return true }
        // Rebuilt as a path (outermost folder first) for the subtree rules, e.g. ".config/fish".
        let rebuilt = (folderChain.reversed() + [fileName]).joined(separator: "/")
        return isProtectedSavePath(rebuilt, home: home)
    }

    /// Paths mentioned in text typed into a save panel: the whole text, plus every whitespace-free token
    /// that looks like a path.
    public static func pathsMentioned(in text: String) -> [String] {
        var out = [text]
        for token in text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            let t = String(token)
            if t.contains("/") || t.hasPrefix("~") || t.hasPrefix(".") { out.append(t) }
        }
        return out
    }

    /// Whether typing `text` into a save/open panel would target a protected destination.
    public static func typedSavePathIsProtected(_ text: String, home: String = NSHomeDirectory()) -> Bool {
        pathsMentioned(in: text).contains { isProtectedSavePath($0, home: home) }
    }
}
