import Combine
import Foundation
import Metal
import OSLog
import WinterKit

/// ComputerV2 Phase 4 (lane H3) — **the app's headless presentations and the sessions' headless tabs**, one per app,
/// living as long as it does (the browser link starts it at launch, before any window exists).
///
/// It executes feature `headless`'s four browser-link ops (`BrowserLinkHost` hands them over):
///   * `headless.show` — a `HeadlessPresentation` connected to the producer's service (the reply waits for
///     `connectWithError:`), the session's window summoned and its panel revealed (`onShow`); a second show for
///     the same tab replaces the first;
///   * `headless.hide` — that presentation closed (BYE) and gone; `{}` even when nothing was shown;
///   * `headless.tabs` — the session's tabs, kept for the panel's list;
///   * `headless.update` — why a shown tab is shown now (its chrome's buttons follow).
/// And it sends the person's actions back (`browserLink.headless`, through `sendAction`).
///
/// The panel shows the newest presentation of the session it shows; nothing here is a panel tab or a session event.
@MainActor
final class HeadlessPresentStore: ObservableObject {
    /// The app's one store (the browser link's and the panel's).
    static let shared = HeadlessPresentStore()

    /// Live presentations, oldest first.
    @Published private(set) var presentations: [HeadlessPresentation] = []
    /// Each session's headless tabs, as the daemon last said.
    @Published private(set) var tabsBySession: [String: [BrowserLinkHeadlessTab]] = [:]
    /// Tabs a `watch` was asked for and not yet answered.
    @Published private(set) var watchPending: Set<String> = []
    /// A sentence about a session's list (a `watch` the daemon refused), cleared after a while.
    @Published private(set) var listNotice: [String: String] = [:]

    /// Where copies of chosen files may go: `<home>/cache/headless-uploads` (`BrowserLinkStarter`). A show naming
    /// an `uploadDir` outside it is refused; nil refuses every show.
    var uploadsRoot: String?
    /// `browserLink.headless` (the link client). nil: every action fails "not connected".
    var sendAction: ((_ sessionId: String, _ tabId: String?, _ action: BrowserLinkHeadlessAction) async throws -> [BrowserLinkHeadlessTab]?)?
    /// Summon Winter's window on the session and reveal its panel (`AppDelegate`).
    var onShow: ((_ sessionId: String) -> Void)?
    /// How long an ended presentation's last line stays before the view goes.
    var endedLinger: TimeInterval = 3

    /// What it shows and lists, by session and tab id and counts only — never a page's address or title
    /// (`log show --predicate 'subsystem == "com.winter.app" AND category == "headless-present"'`).
    private static let log = Logger(subsystem: "com.winter.app", category: "headless-present")

    private let device: MTLDevice?
    /// Sessions whose list was fetched on this link (a fresh link fetches again).
    private var listed: Set<String> = []
    /// Each session's list version: bumped by every push, so a fetch answered after a newer push never overwrites it.
    private var listGeneration: [String: Int] = [:]

    init(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        self.device = device
    }

    /// The presentation the panel shows for `sessionId`: its newest.
    func shown(for sessionId: String?) -> HeadlessPresentation? {
        guard let sessionId else { return nil }
        return presentations.last { $0.sessionId == sessionId }
    }

    /// The tabs the panel offers to watch for `sessionId` (none while one is shown).
    func offeredTabs(for sessionId: String?) -> [BrowserLinkHeadlessTab] {
        guard let sessionId, shown(for: sessionId) == nil else { return [] }
        let shownIds = Set(presentations.filter { $0.sessionId == sessionId }.map(\.tabId))
        return HeadlessPresentChromeState.offeredTabs(tabsBySession[sessionId] ?? [], shownTabIds: shownIds)
    }

    // MARK: - The browser link's ops

    func handle(_ command: BrowserLinkHeadlessCommand, reply: BrowserLinkReplier) {
        switch command.op {
        case .show(let show):
            reply(self.show(show))
        case .hide(let sessionId, let tabId, _):
            hide(sessionId: sessionId, tabId: tabId)
            reply(.empty)
        case .tabs(let sessionId, let tabs):
            listGeneration[sessionId, default: 0] += 1
            tabsBySession[sessionId] = tabs
            Self.log.notice("\(sessionId, privacy: .public) lists \(tabs.count) headless tab(s), \(tabs.filter(\.presented).count) shown")
            reply(.empty)
        case .update(let sessionId, let tabId, let purpose):
            for p in presentations where p.sessionId == sessionId && p.tabId == tabId { p.purposeChanged(purpose) }
            Self.log.notice("\(sessionId, privacy: .public) \(tabId, privacy: .public) is shown for \(purpose.rawValue, privacy: .public) now")
            reply(.empty)
        }
    }

    /// `headless.show`: connect, then show. The reply is `{}` once the HELLO went out, a failure otherwise.
    func show(_ show: BrowserLinkHeadlessCommand.Show) -> BrowserLinkReply {
        guard let root = uploadsRoot, HeadlessPresentUploads.isInside(show.uploadDir, root: root) else {
            return .failure(code: .notAllowed, message: "headless.show: uploadDir is not Winter's uploads folder")
        }
        guard let device else {
            return .failure(code: .notLive, message: "this Mac has no Metal device to draw the page with")
        }
        // A second show for the same tab replaces the first.
        for old in presentations where old.tabId == show.tabId { old.close() }
        presentations.removeAll { $0.tabId == show.tabId }

        let presentation = HeadlessPresentation(show: show, device: device, uploadsRoot: root)
        if let error = presentation.connect() {
            presentation.close()
            return .failure(code: .notLive, message: "Winter couldn't show the headless tab: \(error)")
        }
        presentation.onEnded = { [weak self] ended in self?.presentationEnded(ended) }
        presentations.append(presentation)
        Self.log.notice("\(show.sessionId, privacy: .public) \(show.tabId, privacy: .public) shown (\(show.purpose.rawValue, privacy: .public), \(show.control ? "the person has control" : "watch-only", privacy: .public))")
        watchPending.remove(show.tabId)
        onShow?(show.sessionId)
        return .empty
    }

    /// `headless.hide`: close it (BYE) and let the panel go back to its tabs.
    func hide(sessionId: String, tabId: String) {
        for p in presentations where p.tabId == tabId && p.sessionId == sessionId { p.close() }
        presentations.removeAll { $0.tabId == tabId && $0.sessionId == sessionId }
    }

    /// The link attached or went away: lists fetched on the old one are stale. Presentations stay — their Mach channel
    /// does not ride the link, and they end by themselves when the helper goes.
    func linkChanged() {
        tabsBySession = [:]
        listed = []
        listGeneration = [:]
        watchPending = []
    }

    private func presentationEnded(_ presentation: HeadlessPresentation) {
        Self.log.notice("\(presentation.sessionId, privacy: .public) \(presentation.tabId, privacy: .public) ended by the helper")
        let id = presentation.id
        DispatchQueue.main.asyncAfter(deadline: .now() + endedLinger) { [weak self] in
            MainActor.assumeIsolated { self?.presentations.removeAll { $0.id == id } }
        }
    }

    // MARK: - The person's actions

    /// A button in a presentation's chrome. `close` takes the view away at once, tells the daemon, then says BYE.
    func act(_ action: BrowserLinkHeadlessAction, on presentation: HeadlessPresentation) {
        if case .ended = presentation.phase {
            presentations.removeAll { $0.id == presentation.id }
            return
        }
        if action == .close {
            presentations.removeAll { $0.id == presentation.id }
            let send = sendAction
            Task { @MainActor in
                _ = try? await send?(presentation.sessionId, presentation.tabId, .close)
                presentation.close()
            }
            return
        }
        guard presentation.pending == nil else { return }
        presentation.markPending(action)
        let send = sendAction
        Task { @MainActor in
            defer { presentation.markPending(nil) }
            do {
                guard let send else { throw BrowserLinkHeadlessError.notConnected }
                _ = try await send(presentation.sessionId, presentation.tabId, action)
            } catch {
                presentation.showNotice(Self.sentence(error))
            }
        }
    }

    /// The panel's list: show one of the session's headless tabs, watch-only. The daemon answers with a
    /// `headless.show`.
    func watch(sessionId: String, tabId: String) {
        guard !watchPending.contains(tabId) else { return }
        watchPending.insert(tabId)
        listNotice[sessionId] = nil
        let send = sendAction
        Task { @MainActor [weak self] in
            do {
                guard let send else { throw BrowserLinkHeadlessError.notConnected }
                _ = try await send(sessionId, tabId, .watch)
            } catch {
                self?.noteListProblem(sessionId: sessionId, Self.sentence(error))
            }
            self?.watchPending.remove(tabId)
        }
    }

    /// Fetch the session's headless tabs once per link (the daemon also pushes them whenever they change).
    func refreshTabsIfNeeded(sessionId: String?) {
        guard let sessionId, !listed.contains(sessionId), let send = sendAction else { return }
        listed.insert(sessionId)
        let generation = listGeneration[sessionId, default: 0]
        Task { @MainActor [weak self] in
            guard let tabs = try? await send(sessionId, nil, .list), let self else { return }
            // A push that came in meanwhile is newer than this answer.
            guard self.listGeneration[sessionId, default: 0] == generation else { return }
            self.tabsBySession[sessionId] = tabs
        }
    }

    private func noteListProblem(sessionId: String, _ text: String) {
        listNotice[sessionId] = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            MainActor.assumeIsolated {
                if self?.listNotice[sessionId] == text { self?.listNotice[sessionId] = nil }
            }
        }
    }

    static func sentence(_ error: Error) -> String {
        (error as? BrowserLinkHeadlessError)?.message ?? "\(error)"
    }
}
