import Foundation
import ServiceManagement

// -----------------------------------------------------------------------------------------------
// LoginItemService / SMLoginItem — Lifecycle T4: this app's own "Launch Winter at login" toggle.
// -----------------------------------------------------------------------------------------------

/// Seam over `SMAppService.mainApp`'s register()/unregister()/status — same "own bridge type,
/// mockable service" posture as `HelperClient`'s wrapping of `SMAppService.daemon` in
/// `HelperClient.swift` (`HelperApprovalStatus`), but for THIS app's own login-item registration
/// (System Settings > General > Login Items), not the privileged `WinterHelper` daemon. Kept as a
/// protocol so `LoginItemController` is testable against `FakeLoginItemService` instead of a real
/// `SMAppService.mainApp` round-trip, which would attempt an actual login-item registration from
/// whatever process runs the test (same LIVE-GATE concern `HelperClient.register()` documents).
protocol LoginItemService {
    var isEnabled: Bool { get }
    func enable() throws
    func disable() throws
}

/// Wraps `SMAppService.mainApp` — the modern (macOS 13+) replacement for the launchd
/// `com.winter.core` agent this app used to install (`packages/cli/src/launchd.ts`'s
/// `migrateFromLaunchdAgent` tears that old mechanism down so it can't resurrect a killed daemon).
/// `isEnabled` treats both `.enabled` and `.requiresApproval` as "the user asked for this" —
/// `.requiresApproval` only means System Settings hasn't confirmed it yet, not that registration
/// failed (same posture as `HelperApprovalStatus`'s bridge).
struct SMLoginItem: LoginItemService {
    private let service = SMAppService.mainApp

    var isEnabled: Bool {
        switch service.status {
        case .enabled, .requiresApproval: return true
        case .notRegistered, .notFound: return false
        @unknown default: return false
        }
    }

    func enable() throws {
        try service.register()
    }

    /// `SMAppService.unregister()` is `async throws`; this protocol's `disable()` deliberately isn't
    /// (matching `enable()`'s synchronous `register()`, and the seam signature `LoginItemController`
    /// is tested against) — the real unregister runs on an unstructured `Task`, logged on failure.
    /// Best-effort, same posture as `AppDelegate.applicationWillTerminate`'s fire-and-forget
    /// revoke-all `Task` — there's no UI surface here to report a failed unregister against either.
    func disable() throws {
        Task {
            do {
                try await service.unregister()
            } catch {
                NSLog("[SMLoginItem] unregister failed: \(error)")
            }
        }
    }
}

// -----------------------------------------------------------------------------------------------
// LoginItemController — the mockable, UserDefaults-backed controller the menu bar binds to.
// -----------------------------------------------------------------------------------------------

/// Drives a `LoginItemService` and remembers whether the user has EVER made an explicit choice —
/// so `AppDelegate`'s default-on first-launch call (`setEnabled(true)` once, gated by
/// `!hasUserMadeChoice`) never re-enables the login item after a user has deliberately turned it
/// off. `UserDefaults`-backed, same injectable-`defaults` convention as `ShortcutBinding.swift`'s
/// `ShortcutSettingsStore`.
@MainActor
final class LoginItemController {
    private static let userChoiceMadeKey = "com.winter.loginItem.userChoiceMade"

    private let service: LoginItemService
    private let defaults: UserDefaults

    init(service: LoginItemService, defaults: UserDefaults = .standard) {
        self.service = service
        self.defaults = defaults
    }

    var isEnabled: Bool { service.isEnabled }

    /// True once `setEnabled` has ever been called against these `defaults` — including the
    /// default-on first-launch call. `AppDelegate`'s first-launch wiring reads this BEFORE calling
    /// `setEnabled(true)`, so a user who disabled the login item is never silently re-enabled on a
    /// later launch.
    var hasUserMadeChoice: Bool {
        defaults.bool(forKey: Self.userChoiceMadeKey)
    }

    func setEnabled(_ on: Bool) {
        do {
            if on {
                try service.enable()
            } else {
                try service.disable()
            }
        } catch {
            NSLog("[LoginItemController] setEnabled(\(on)) failed: \(error)")
        }
        defaults.set(true, forKey: Self.userChoiceMadeKey)
    }
}
