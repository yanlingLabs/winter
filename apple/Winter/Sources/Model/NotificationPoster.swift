import Foundation
import UserNotifications

/// Seam over `UNUserNotificationCenter` (task-30, push-notification track): `SessionModel` posts
/// through this protocol rather than the OS API directly, so `SessionModelTests` can inject a fake
/// that records calls instead of ever touching the real notification center — no permission
/// prompts, no actual banners, in CI or a dev run of the test target.
protocol NotificationPosting {
    func post(title: String, body: String)
}

/// Real `UNUserNotificationCenter`-backed poster, wired at `SessionModel`'s default construction.
///
/// Authorization is requested LAZILY, on the first ever call to `post` — never at app launch — so
/// a user who never triggers `push_notification` (directly or via a subagent) is never prompted.
/// `requestAuthorization`'s completion is intentionally ignored: whether the user grants, denies,
/// or the request is still in flight, `add(_:)` below is called unconditionally — if the OS ends
/// up with no authorization, it silently drops the request (that's `UNUserNotificationCenter`'s
/// own documented behavior, not a bug here). The daemon-side `osascript` fallback (core's
/// `agent/notify-fallback.ts`) doesn't know about this either way — ACCEPTABLE for v1, per the
/// push-notification track's own design brief.
final class SystemNotificationPoster: NotificationPosting {
    private var didRequestAuthorization = false

    func post(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        if !didRequestAuthorization {
            didRequestAuthorization = true
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(request, withCompletionHandler: nil)
    }
}
