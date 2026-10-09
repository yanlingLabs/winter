import Foundation
import WinterKit

// -----------------------------------------------------------------------------------------------
// One feed per session, however many surfaces show it.
//
// A session can be on screen in several places at once: its child pill in the Dispatch pill (for the plume), a
// detached window, the main window. Each used to open a pinned harness of its own — its own socket, its own decode of
// every event, its own fold into its own `SessionModel` — so every extra surface doubled the work of the first.
//
// `SessionFeedHub` keeps ONE pinned `SessionFeed` (and the one `SessionModel` it folds into) per session, counted by
// the surfaces that hold it. A surface takes a `SessionFeedLease`:
//   • the pill's child plume reads the shared model as it is;
//   • a surface that MOVES between sessions (a detached window's sidebar, the main window's hop) keeps a model of its
//     own that FOLLOWS the leased one (`SessionModel.follow`) — its adapter and views are built on a model that never
//     changes — and moves its lease;
//   • each surface adds its own taps on the feed (`onEvent`, `onConnected`, `onAttach`) for the side stores it keeps.
// The last surface to let go stops the feed; the socket closes then and not before.
//
// A MOVE keeps what a hop has always been — one `session.attach` on the same connection, which the daemon reads as
// "detach the previous, attach the new" in that order — whenever the surface is the only one on the session it leaves
// (the feed is re-pinned in place, `SessionFeed.repin`). When others still hold the old session it joins the new
// session's feed instead (the one that is already there, or a new one).
// -----------------------------------------------------------------------------------------------

/// The shared feeds of one app, by session id.
@MainActor
final class SessionFeedHub {
    /// Mints a pinned feed and the model it folds into — `AppModel.makeDetachedFeed` in production; nil when none can
    /// be made (no daemon token yet).
    typealias Factory = (String) -> (feed: SessionFeed, session: SessionModel)?

    /// One session's shared feed.
    @MainActor
    final class Entry {
        let feed: SessionFeed
        let session: SessionModel
        fileprivate(set) var sessionId: String
        fileprivate(set) var holders = 0
        fileprivate var startTask: Task<Void, Never>?

        fileprivate init(feed: SessionFeed, session: SessionModel, sessionId: String) {
            self.feed = feed
            self.session = session
            self.sessionId = sessionId
        }
    }

    private let factory: Factory
    private var entries: [String: Entry] = [:]

    init(factory: @escaping Factory) {
        self.factory = factory
    }

    /// How many feeds are open, and how many surfaces hold a session's (tests).
    var liveFeedCount: Int { entries.count }
    func holders(of sessionId: String) -> Int { entries[sessionId]?.holders ?? 0 }
    func feed(for sessionId: String) -> SessionFeed? { entries[sessionId]?.feed }

    /// A hold on `sessionId`'s feed — opened, and started, if this is the first. Nil when no feed can be made.
    func lease(sessionId: String) -> SessionFeedLease? {
        let joinedAttached = entries[sessionId]?.feed.isAttached ?? false
        guard let entry = acquire(sessionId) else { return nil }
        return SessionFeedLease(hub: self, entry: entry, joinedAttachedFeed: joinedAttached)
    }

    // MARK: - What a lease does

    fileprivate func acquire(_ sessionId: String) -> Entry? {
        if let existing = entries[sessionId] {
            existing.holders += 1
            return existing
        }
        guard let made = factory(sessionId) else { return nil }
        let entry = Entry(feed: made.feed, session: made.session, sessionId: sessionId)
        entry.holders = 1
        // Begun on the next turn, never in this one: the surface that asked adds its taps right after this returns,
        // and the attach's answer must find them.
        entry.startTask = Task { await entry.feed.start() }
        entries[sessionId] = entry
        return entry
    }

    fileprivate func release(_ entry: Entry) {
        entry.holders -= 1
        guard entry.holders <= 0 else { return }
        if entries[entry.sessionId] === entry { entries[entry.sessionId] = nil }
        entry.startTask?.cancel() // a feed whose daemon never came up must stop retrying (`SessionFeed.start`)
        entry.startTask = nil
        entry.feed.stop()
    }

    /// Moves `lease` onto `sessionId`'s feed. The swap itself happens now; what returns is the wait for the attach.
    fileprivate func move(_ lease: SessionFeedLease, from old: Entry, to sessionId: String) -> Task<Void, Never> {
        // The session is already open somewhere: join it, and let go of the old one.
        if let target = entries[sessionId] {
            let joinedAttached = target.feed.isAttached
            target.holders += 1
            lease.adopt(target, joinedAttachedFeed: joinedAttached)
            release(old)
            return Task { await target.feed.waitUntilAttached() }
        }
        // Nobody else holds the session being left: the SAME feed goes along — one `session.attach` on the same
        // socket, the daemon's own "move".
        if old.holders == 1 {
            entries[old.sessionId] = nil
            old.sessionId = sessionId
            entries[sessionId] = old
            lease.adopt(old, joinedAttachedFeed: false) // re-pinned: its replay comes to every holder
            return Task { await old.feed.repin(to: sessionId) }
        }
        // Others still hold the session being left: this surface gets a feed of its own onto the new one.
        guard let target = acquire(sessionId) else { return Task {} }
        lease.adopt(target, joinedAttachedFeed: false) // a feed of its own: it replays from the start
        old.holders -= 1
        return Task { await target.feed.waitUntilAttached() }
    }
}

/// A surface's hold on a session's feed. Either shared (from `SessionFeedHub.lease`) or standalone — one surface's own
/// feed, started and stopped with it, for a caller that builds its feed itself (`init(standalone:)`).
@MainActor
final class SessionFeedLease {
    /// The session this lease is on now. Flips synchronously when the lease moves.
    private(set) var sessionId: String
    private(set) var feed: SessionFeed
    /// The model the feed folds into: shared by every lease on this session. A surface that moves keeps a model of its
    /// own and follows this one.
    private(set) var session: SessionModel
    private(set) var isReleased = false
    /// True when this lease's last acquire or move landed on a feed that was ALREADY attached: its replay has been (or
    /// is being) delivered to the surfaces that were there first, and a later joiner's taps hear only what comes after
    /// — never the history. A surface that builds a store from the event stream rather than from the model's `state`
    /// must seed it another way (`ShellSessionHost`'s panel tabs take the daemon's `panel.list`). False for a lease
    /// that opened its feed, whose taps are in place before the attach answers, and for one whose feed was re-pinned.
    private(set) var joinedAttachedFeed = false

    private weak var hub: SessionFeedHub?
    private var entry: SessionFeedHub.Entry?
    private var standaloneTask: Task<Void, Never>?

    fileprivate init(hub: SessionFeedHub, entry: SessionFeedHub.Entry, joinedAttachedFeed: Bool) {
        self.hub = hub
        self.entry = entry
        self.joinedAttachedFeed = joinedAttachedFeed
        sessionId = entry.sessionId
        feed = entry.feed
        session = entry.session
    }

    /// One surface's own feed: `begin()` starts it, `release()` stops it, `move(to:)` re-pins it. For a surface that is
    /// handed a feed it did not get from a hub (the tests' scripted ones).
    init(standalone feed: SessionFeed, session: SessionModel) {
        self.feed = feed
        self.session = session
        sessionId = feed.pinnedSessionId ?? ""
    }

    var isShared: Bool { entry != nil }

    /// Starts a standalone feed (once). A shared one is started by the hub when its first lease is taken.
    func begin() {
        guard entry == nil, !isReleased, standaloneTask == nil else { return }
        let feed = self.feed
        standaloneTask = Task { await feed.start() }
    }

    /// Lets go: cancels this lease's taps and its hold on the feed; the last hold stops the feed.
    func release() {
        guard !isReleased else { return }
        isReleased = true
        cancelTaps()
        if let entry {
            hub?.release(entry)
            self.entry = nil
        } else {
            standaloneTask?.cancel()
            standaloneTask = nil
            feed.stop()
        }
    }

    /// Moves this lease onto another session. Synchronous in effect — `sessionId`, `feed` and `session` are the new
    /// ones when this returns — and the Task is the wait for the attach (`repin`'s answer, or the shared feed's).
    @discardableResult
    func move(to sessionId: String) -> Task<Void, Never> {
        guard !isReleased, sessionId != self.sessionId else { return Task {} }
        if let entry, let hub {
            return hub.move(self, from: entry, to: sessionId)
        }
        self.sessionId = sessionId
        joinedAttachedFeed = false
        let feed = self.feed
        return Task { await feed.repin(to: sessionId) }
    }

    fileprivate func adopt(_ entry: SessionFeedHub.Entry, joinedAttachedFeed: Bool) {
        self.entry = entry
        self.joinedAttachedFeed = joinedAttachedFeed
        sessionId = entry.sessionId
        feed = entry.feed
        session = entry.session
        // The surface's taps follow it onto the new feed. A connect that already happened is not announced again
        // (the surface asks the move's own wait for that); an attach that already happened is (nil: no replay).
        eventTap?.cancel(); connectedTap?.cancel(); attachTap?.cancel()
        eventTap = onEvent.map { feed.observeEvents($0) }
        connectedTap = onConnected.map { feed.observeConnected(fireIfAlreadyConnected: false, $0) }
        attachTap = onAttach.map { feed.observeAttach($0) }
    }

    // MARK: - Taps

    private var eventTap: FeedObservation?
    private var connectedTap: FeedObservation?
    private var attachTap: FeedObservation?

    /// Every event the feed reads, as it is read — before it is folded. A surface with a side store folds what it needs.
    var onEvent: ((WinterEvent) -> Void)? {
        didSet {
            eventTap?.cancel()
            eventTap = isReleased ? nil : onEvent.map { feed.observeEvents($0) }
        }
    }

    /// The feed's connect — told at once (one turn on) if it already happened.
    var onConnected: (() -> Void)? {
        didSet {
            connectedTap?.cancel()
            connectedTap = isReleased ? nil : onConnected.map { feed.observeConnected($0) }
        }
    }

    /// The attach answer (`SessionFeed.observeAttach`): the session and the seq of the last event its replay delivers;
    /// nil when no replay is coming.
    var onAttach: ((String, Int?) -> Void)? {
        didSet {
            attachTap?.cancel()
            attachTap = isReleased ? nil : onAttach.map { feed.observeAttach($0) }
        }
    }

    private func cancelTaps() {
        eventTap?.cancel(); eventTap = nil
        connectedTap?.cancel(); connectedTap = nil
        attachTap?.cancel(); attachTap = nil
    }
}
