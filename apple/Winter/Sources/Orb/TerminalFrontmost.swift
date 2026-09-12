import AppKit

/// gate-feedback-1 FIX A: the terminal-emulator allowlist used to suppress the orb's
/// answer-arrival auto-reveal (`GlassRootView.handleTurnCompleted()`) while the user is actively
/// chatting with the orb's OWN focused session from a terminal CLI — bundle ids named verbatim in
/// the fix brief.
let terminalBundleIdentifiers: Set<String> = [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp",
    "io.alacritty",
    "net.kovidgoyal.kitty",
    "com.github.wez.wezterm",
]

/// PURE: is the given bundle id one of the known terminal emulators? Extracted from the live
/// `NSWorkspace` read below (`frontmostApplicationIsTerminal()`) so `AutoRevealSuppressionTests`
/// can drive it directly without faking frontmost-app state.
func isTerminalBundleIdentifier(_ bundleIdentifier: String?) -> Bool {
    guard let bundleIdentifier else { return false }
    return terminalBundleIdentifiers.contains(bundleIdentifier)
}

/// LIVE read: `NSWorkspace.shared.frontmostApplication`'s bundle id, checked against
/// `isTerminalBundleIdentifier`. Cheap enough to poll at decision time (gate-feedback-1 FIX A
/// brief: "polled at decision time, no observers needed") — no caching, no notification observer,
/// just a direct synchronous read the instant `handleTurnCompleted()`'s decision fires.
func frontmostApplicationIsTerminal() -> Bool {
    isTerminalBundleIdentifier(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
}
