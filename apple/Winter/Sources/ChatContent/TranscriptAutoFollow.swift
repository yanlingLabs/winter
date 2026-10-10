import AppKit
import SwiftUI

// MARK: - The glide (pure — `TranscriptAutoFollowTests`)

/// How quickly the transcript catches up with its own bottom: the time constant of an exponential
/// glide — after `τ` the remaining gap is 37%, after 3τ (~0.25 s) 5%. Streaming text arrives every
/// few dozen milliseconds, so the view is always gliding toward a target that keeps moving, never
/// stepping a line at a time (user, 2026-10-02: "smooth rather than line by line or laggy").
let transcriptFollowTimeConstant: CFTimeInterval = 0.085

/// PURE: one display frame of the follow glide — where the scroll offset goes from `current`, with
/// the bottom at `target`, `dt` seconds after the previous frame. A gap past one and a half
/// viewports (opening a session's history, a very large result landing at once) is crossed in one
/// frame: gliding through pages of text reads as lag, not as smoothness.
func transcriptFollowStep(current: CGFloat, target: CGFloat, dt: CFTimeInterval, viewport: CGFloat) -> CGFloat {
    let gap = target - current
    if abs(gap) < 1 || abs(gap) > viewport * 1.5 { return target }
    let k = 1 - exp(-min(max(dt, 0), 0.05) / transcriptFollowTimeConstant)
    return current + gap * CGFloat(k)
}

/// How close to the bottom counts as "at the bottom" — where following resumes by itself.
let transcriptFollowResumeDistance: CGFloat = 40

#if DEBUG
/// What the followers have done in this process (the scaling benchmark reads these a second at a time after the last event
/// of a turn: a healthy transcript goes quiet at once).
struct TranscriptFollowStats {
    var steps = 0
    var applies = 0
    var nudgesFromFrame = 0
    var nudgesOther = 0
    var boundsChanges = 0
}
nonisolated(unsafe) var transcriptFollowStats = TranscriptFollowStats()
#endif

// MARK: - The follower

/// Keeps a transcript's scroll view at its bottom while the user is there, scrolling it on the
/// display's own clock instead of through SwiftUI scroll animations: the old `scrollTo` per streamed
/// chunk started a fresh 0.18 s animation every few dozen milliseconds, each one cutting the last
/// off — the stutter. Here the clip view is moved a little every frame (`transcriptFollowStep`), so
/// growth of any kind — streamed text, a new exchange, a card, a row expanding — is followed by
/// one continuous glide.
///
/// Following stops the moment the user scrolls UP (a wheel or trackpad event over the view, or
/// dragging the scroller) and resumes when they come back within `transcriptFollowResumeDistance`
/// of the bottom. Nothing else stops it: SwiftUI's own offset adjustments are not the user.
/// The display link runs only while there is somewhere to go, and pauses half a second after the
/// bottom is reached.
@MainActor
final class TranscriptFollower: NSObject {
    private(set) var isFollowing = true
    /// Told when following starts or stops (the "latest" pill).
    var onFollowingChanged: ((Bool) -> Void)?
    /// Makes a move too far to glide — the first landing, a history arriving, a large result — through
    /// SwiftUI's own scroll-to-row (`TranscriptView`'s reader), never by moving the clip view: a lazy
    /// stack jumped into directly while its row heights are still estimates can keep a stale height
    /// and sit drawing nothing in an empty tail until the user scrolls (user, 2026-10-04, reproduced
    /// on their own session). Glides stay on the clip view — they never leave the rows already laid
    /// out. Without one, the far move lands on the clip view as before.
    var farJump: (() -> Void)?
    /// Told once a landing (`restartAtBottom`) has come to rest at the bottom — `landedAfterFrames`
    /// display frames without a move. A session window keeps its loading screen up until then, so the
    /// lazy rows settling into their real heights is never seen (user, 2026-10-04).
    var onLanded: (() -> Void)?
    private var landingPending = false
    static let landedAfterFrames = 12

    private(set) weak var scrollView: NSScrollView?
    private var link: CADisplayLink?
    private var lastTimestamp: CFTimeInterval?
    private var settledFrames = 0
    private var applying = false
    private var userScrolling = false
    /// The first glide after attaching lands at once — a session opens at its bottom.
    private var snapNext = true
    private var observers: [NSObjectProtocol] = []
    private var wheelMonitor: Any?

    func attach(to scrollView: NSScrollView) {
        guard scrollView !== self.scrollView else { return }
        detach()
        self.scrollView = scrollView
        snapNext = true
        let clip = scrollView.contentView
        clip.postsBoundsChangedNotifications = true
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.boundsChanged() }
        })
        observers.append(center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.userScrolling = true }
        })
        observers.append(center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.userScrolling = false }
        })
        if let document = scrollView.documentView {
            document.postsFrameChangedNotifications = true
            observers.append(center.addObserver(forName: NSView.frameDidChangeNotification, object: document, queue: .main) { [weak self] _ in
                #if DEBUG
                transcriptFollowStats.nudgesFromFrame += 1
                #endif
                MainActor.assumeIsolated { self?.nudge() }
            })
        }
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            MainActor.assumeIsolated { self?.wheel(event) }
            return event
        }
        let link = scrollView.displayLink(target: self, selector: #selector(step(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        nudge()
    }

    func detach() {
        link?.invalidate()
        link = nil
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor) }
        wheelMonitor = nil
        scrollView = nil
        lastTimestamp = nil
    }

    /// The content may have grown: start gliding if following.
    func nudge() {
        #if DEBUG
        transcriptFollowStats.nudgesOther += 1
        #endif
        guard isFollowing, let link else { return }
        settledFrames = 0
        if link.isPaused { lastTimestamp = nil; link.isPaused = false }
    }

    /// The "latest" pill: follow again, from here.
    func jumpToBottom() {
        setFollowing(true)
        nudge()
    }

    /// A different history is coming in (the transcript was reset): land at its bottom, following.
    func restartAtBottom() {
        snapNext = true
        landingPending = true
        logGeometry("restart at bottom")
        // The far jump and the settle are logged as they happen; these follow the geometry after.
        for delay in [0.5, 1.0, 2.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                MainActor.assumeIsolated { self?.logGeometry("+\(delay)s") }
            }
        }
        setFollowing(true)
        nudge()
    }

    /// Lands the follow at once (tests).
    func settleForTesting() {
        guard let scrollView else { return }
        apply(bottomOffset(of: scrollView), in: scrollView)
    }

    private func setFollowing(_ following: Bool) {
        guard following != isFollowing else { return }
        isFollowing = following
        onFollowingChanged?(following)
        if following { nudge() } else { link?.isPaused = true }
    }

    /// A wheel or trackpad scroll over this transcript toward its top is the user taking over.
    private func wheel(_ event: NSEvent) {
        guard let scrollView, event.window === scrollView.window,
              scrollView.bounds.contains(scrollView.convert(event.locationInWindow, from: nil)) else { return }
        if event.scrollingDeltaY > 0 { setFollowing(false) }
    }

    private func boundsChanged() {
        #if DEBUG
        transcriptFollowStats.boundsChanges += 1
        #endif
        guard !applying, let scrollView else { return }
        let distance = abs(bottomOffset(of: scrollView) - scrollView.contentView.bounds.origin.y)
        if distance <= transcriptFollowResumeDistance {
            setFollowing(true)
        } else if userScrolling {
            setFollowing(false)
        }
    }

    @objc private func step(_ link: CADisplayLink) {
        #if DEBUG
        transcriptFollowStats.steps += 1
        #endif
        guard isFollowing, let scrollView else { link.isPaused = true; return }
        let now = link.timestamp
        let dt = lastTimestamp.map { now - $0 } ?? (1.0 / 60.0)
        lastTimestamp = now
        let current = scrollView.contentView.bounds.origin.y
        let target = bottomOffset(of: scrollView)
        let viewport = scrollView.contentView.bounds.height
        if let farJump, abs(target - current) >= 1, snapNext || abs(target - current) > viewport * 1.5 {
            logGeometry("far jump from \(Int(current)) to \(Int(target))")
            farJump()
            settledFrames = 0
            if (scrollView.documentView?.frame.height ?? 0) > 0 { snapNext = false }
            return
        }
        let next = snapNext ? target : transcriptFollowStep(current: current, target: target, dt: dt, viewport: viewport)
        if abs(next - current) > 0.01 {
            apply(next, in: scrollView)
            settledFrames = 0
            snapNext = false
        } else {
            settledFrames += 1
            // Content has to be there before the first landing counts.
            if (scrollView.documentView?.frame.height ?? 0) > 0 { snapNext = false }
            if landingPending, !snapNext, settledFrames >= Self.landedAfterFrames {
                landingPending = false
                logGeometry("landed")
                refreshLazyLayout(scrollView)
                onLanded?()
            }
            if settledFrames > 30 { link.isPaused = true; lastTimestamp = nil }
        }
    }

    /// A landing's last step: one small scroll up and back through the scroll view's OWN event path,
    /// as the user's hand would make it. Jumped into while its rows were still estimates, a lazy stack
    /// could keep drawing nothing at the bottom until a real scroll made it lay out the rows that are
    /// on screen (user, 2026-10-04: "I have to do a little scroll to actually show the transcript").
    /// Net zero, at the bottom, inside the resume distance — following is untouched.
    private func refreshLazyLayout(_ scrollView: NSScrollView) {
        for dy: Int32 in [1, -1] {
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0),
                  let event = NSEvent(cgEvent: cg) else { continue }
            scrollView.scrollWheel(with: event)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            MainActor.assumeIsolated { self?.logGeometry("after refresh") }
        }
    }

    /// `WINTER_ORB_DEBUG=1` diagnostics for the window-opening landing.
    private func logGeometry(_ what: String) {
        guard OrbDebug.enabled, let scrollView else { return }
        let clip = scrollView.contentView.bounds
        OrbDebug.log("transcript \(what): offset \(Int(clip.origin.y)) viewport \(Int(clip.height)) document \(Int(scrollView.documentView?.frame.height ?? -1)) following \(isFollowing)")
    }

    private func apply(_ y: CGFloat, in scrollView: NSScrollView) {
        #if DEBUG
        transcriptFollowStats.applies += 1
        #endif
        let clip = scrollView.contentView
        applying = true
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        scrollView.reflectScrolledClipView(clip)
        applying = false
    }

    /// The clip view's offset at the very bottom, insets and margins included — asked of the clip
    /// view itself, which clamps a proposal past the end to the real limit.
    private func bottomOffset(of scrollView: NSScrollView) -> CGFloat {
        let clip = scrollView.contentView
        var proposed = clip.bounds
        proposed.origin.y = (scrollView.documentView?.isFlipped ?? true) ? 1e9 : -1e9
        return clip.constrainBoundsRect(proposed).origin.y
    }
}

/// Puts a `TranscriptFollower` on the `ScrollView` it sits inside: an invisible, click-through view
/// placed in the scroll content, which finds its enclosing `NSScrollView` once it is in a window.
struct TranscriptAutoFollow: NSViewRepresentable {
    let follower: TranscriptFollower

    func makeNSView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.follower = follower
        return view
    }

    func updateNSView(_ view: AnchorView, context: Context) {
        view.follower = follower
        view.attachIfReady()
    }

    static func dismantleNSView(_ view: AnchorView, coordinator: ()) {
        view.follower?.detach()
    }

    final class AnchorView: NSView {
        weak var follower: TranscriptFollower?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { follower?.detach() } else { attachIfReady() }
        }

        func attachIfReady() {
            guard window != nil, let scrollView = enclosingScrollView else { return }
            follower?.attach(to: scrollView)
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
