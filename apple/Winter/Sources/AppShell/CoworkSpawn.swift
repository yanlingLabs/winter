import Foundation

/// `/spawn` in the Dispatch pill (design 7.9): open a Cowork conversation. The pill already keeps an optional
/// `onSpawnCowork` that, while `nil`, answers "not available yet".
///
/// PURE: hands back the closure only when the app's own Cowork constant is on, and `nil` otherwise, so while
/// Cowork is closed `/spawn` keeps saying it is not available and nothing is opened. What it opens when it is
/// on is the new-chat page on the Cowork segment, with no Dispatch context carried over: the design records
/// that Dispatch and guest spawn into Cowork are denied (D11) and that a host-to-Cowork delegation grant is not
/// built, so this can only start a conversation the person writes themselves.
func dispatchPillCoworkSpawn(modeAvailable: Bool, open: @escaping () -> Void) -> (() -> Void)? {
    modeAvailable ? open : nil
}
