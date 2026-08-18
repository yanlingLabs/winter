import AppKit
import Foundation

/// editor-product Task 3 — **the one registrant of the process-global bridge slot, and the demux
/// behind it.**
///
/// `NormaCEFSetBridgeHandler` is a SINGLE slot for the whole process and registering again replaces
/// the previous block outright (`NormaCEF.h`). Stage A shipped with exactly one registrant (the
/// DEBUG harness) and its own review named the consequence before a second one could exist: two
/// registrants means last-writer-wins, and the loser's page is not merely unheard — every query it
/// sends is answered `success = false` by a handler that has never heard of it, for the life of the
/// browser. Stage B creates a second registrant per session (`EditorRuntime`), so the slot needs an
/// owner rather than a convention.
///
/// This is that owner. Everything that wants editor messages registers HERE, keyed by the
/// `browserId` its page runs in, and this object holds the slot.
///
/// ## What it guarantees
///
/// **1. Discrimination by `browserId`, checked BEFORE anything else.** The renderer-side router
/// installs `window.cefQuery` into every V8 context in every Norma browser (`NormaCEF.h:335-349`),
/// so an arbitrary site in a panel web tab reaches this handler with whatever bytes it likes —
/// including a perfectly well-formed `saveRequested` naming a file it wants written. The id is
/// checked first and the payload is not even decoded for a browser nobody registered: the refusal
/// keys on WHERE the query came from, never on what it looks like. (Drill 11 sends exactly that
/// well-formed message from a foreign browser to keep this honest.)
///
/// **2. Refuse, never ignore.** Every delivered query is answered exactly once — by the client
/// inside its call, or by this object if the client returns without answering. An ignored query
/// strands a CEF `Callback` for the life of the browser, which the router's own contract calls a
/// runtime error.
///
/// **3. `browserId` 0 never registers.** 0 is `NormaCEFBrowserIdentifierForParent`'s "no browser"
/// sentinel; a client registered under it would match every query from any container that has no
/// browser at all — the exact `browserId == 0 == 0` accident that header warns about.
@MainActor
final class EditorBridgeHub {

    // MARK: - The client contract

    /// How a client answers the query it was handed. `success = true` runs the page's `onSuccess`;
    /// `false` runs `onFailure` with the JSON as the message (`{"message": …}` by convention).
    ///
    /// **Latched**: the first call wins and every later one is a no-op, so a client that answers and
    /// then answers again cannot double-settle a query, and a client that answers nothing still
    /// leaves the query answered (see `deliver`).
    typealias Respond = (Bool, String) -> Void

    /// One decoded message and the door to answer it with. The hub decodes ONCE, so no client parses
    /// the page's bytes itself.
    ///
    /// Clients should answer FIRST and act second — the harness's own discipline, and for the reason
    /// it documents: acting on a message can re-enter this file (a step's action sends the next
    /// message), and an entry still awaiting an answer across that re-entry is one a later failure
    /// could strand.
    typealias Client = (EditorBridgeInbound, @escaping Respond) -> Void

    // MARK: - The slot, as a seam

    /// **Every C call this file makes**, injected for the reason `BrowserRuntime.CEFDriver` exists:
    /// the suite never starts CEF, so the demux has to be reachable without it. `production` is the
    /// whole un-substitutable half — three forwards with no branch and no state of their own.
    ///
    /// `install` takes the handler this hub wants delivered to and is responsible for putting it in
    /// the process slot; a test's recorder simply keeps it and calls it, which is how "a query
    /// arrived" is simulated on the REAL path rather than by reaching into a private method.
    struct Slot {
        var install: (@escaping @MainActor @Sendable (Int32, UInt64, String) -> Void) -> Void
        var clear: () -> Void
        var respond: (UInt64, Bool, String) -> Void

        static let production = Slot(
            install: { handler in
                // Registered on the MAIN thread, where callers of `register` already are:
                // `g_bridge_handler` is read unlocked on CEF's UI thread, which under the external
                // pump IS this thread.
                NormaCEFSetBridgeHandler { browserId, queryId, requestJSON in
                    // The C string is valid only for the duration of the call — copied here, once,
                    // before anything else can hold it.
                    let request = requestJSON.map { String(cString: $0) } ?? ""
                    // A statement of fact rather than an assumption: `NormaCEF.h` contracts this
                    // block as main-thread, one main-queue turn after CEF's own callback. Same
                    // shape `BrowserRuntime.Scheduler.production` uses for the same reason.
                    MainActor.assumeIsolated { handler(browserId, queryId, request) }
                }
            },
            clear: { NormaCEFSetBridgeHandler(nil) },
            respond: { queryId, success, json in
                NormaCEFBridgeRespondCall(queryId, success, json)
            })
    }

    // MARK: - Refusals

    /// One refused query, for whoever is watching. **Diagnostics only** — the refusal itself has
    /// already happened by the time this is handed over, and no observer can change it.
    struct Refusal: Equatable {
        enum Reason: String, Equatable {
            /// No client is registered for this browser. The dangerous case, and the one drill 11
            /// executes.
            case unknownBrowser
            /// A registered browser sent something this Swift side cannot decode completely
            /// (`EditorBridgeInbound.decode` is total — see its own doc for why it guesses nothing).
            case undecodableFrame
        }

        let browserId: Int32
        let reason: Reason
        /// The request, capped — a refused frame is untrusted input and this ends up in transcripts.
        let request: String

        /// The `{"message": …}` body the page's `onFailure` receives.
        var responseJSON: String {
            switch reason {
            case .unknownBrowser:
                return #"{"message":"this browser is not registered with the editor bridge"}"#
            case .undecodableFrame:
                return #"{"message":"this frame did not decode"}"#
            }
        }
    }

    /// How much of a refused request is kept for the observer. Same order as the harness's own
    /// 200-character prefix, which is what this replaced.
    static let refusalRequestPrefix = 200

    /// "A query was refused" — set by the harness so drill 11 can record the refusal it provoked.
    /// `nil` in the product, where a refusal is an ordinary, uninteresting event.
    var onRefusal: ((Refusal) -> Void)?

    // MARK: - Construction

    /// The app's one hub. Tests build their own against a recorder — this one owns a process-global
    /// slot, which would leak from test to test (the same reasoning `BrowserRuntime.shared` carries).
    static let shared = EditorBridgeHub()

    private let slot: Slot
    private var clients: [Int32: Client] = [:]

    /// Whether the process slot is currently held by this hub. Tracked rather than derived from
    /// `clients.isEmpty` so install/clear stay exactly paired even if a future path empties the
    /// table by another route.
    private(set) var isInstalled = false

    /// How many times the slot has been taken and given back. The pin for "the FIRST register
    /// installs and the LAST unregister clears" — an internal counter rather than a spy on the C
    /// function, since the C function is unreachable from a test that must not touch the real slot.
    private(set) var installCount = 0
    private(set) var clearCount = 0

    /// Which browsers currently have a client. Read by tests; also the answer to "is this browser
    /// mine" for anything that needs it.
    var registeredBrowserIds: Set<Int32> { Set(clients.keys) }

    init(slot: Slot = .production) {
        self.slot = slot
    }

    // MARK: - Registration

    /// Claim every `cefQuery` from `browserId`.
    ///
    /// Registering an id that already has a client REPLACES it, mirroring the C slot's own
    /// register-replaces-outright semantics: a runtime that re-created its browser and got the same
    /// id back must not be shadowed by its own dead closure.
    ///
    /// **`browserId == 0` is refused, loudly, and does not trap.** A `precondition` would be
    /// untestable (the test that proves the refusal would take the process down with it) and there
    /// is no `assertionFailure` anywhere in this app's sources; the guard IS the discipline and a
    /// test observes it. A caller reaching this has almost certainly not waited for its browser to
    /// exist — `NormaCEFBrowserIdentifierForParent` answers 0 until `OnAfterCreated` has run.
    func register(browserId: Int32, client: @escaping Client) {
        guard browserId != 0 else {
            NSLog("[EditorBridgeHub] refused to register browser id 0 — that is the \"no browser\" "
                  + "sentinel, and a client under it would match every query in the process")
            return
        }
        clients[browserId] = client
        install()
    }

    /// Stop claiming that browser's queries. Unknown ids are a no-op: a teardown may run twice (a
    /// window closing and an explicit teardown), and the second one has nothing to do.
    func unregister(browserId: Int32) {
        guard clients.removeValue(forKey: browserId) != nil else { return }
        if clients.isEmpty { clear() }
    }

    private func install() {
        guard !isInstalled else { return }
        isInstalled = true
        installCount += 1
        slot.install { [weak self] browserId, queryId, request in
            guard let self else {
                // The hub is gone but the query still MUST be answered — an ignored query strands a
                // CEF callback for the life of the browser. Unreachable for `shared` (it lives as
                // long as the process); reachable for a test's own hub going out of scope.
                Slot.production.respond(queryId, false,
                                        #"{"message":"the editor bridge is gone"}"#)
                return
            }
            self.deliver(browserId: browserId, queryId: queryId, request: request)
        }
    }

    private func clear() {
        guard isInstalled else { return }
        isInstalled = false
        clearCount += 1
        slot.clear()
    }

    // MARK: - The demux

    /// One query, from wherever in the process it came.
    ///
    /// The order below is the contract, not an implementation detail: **browser first, decode
    /// second, client third.** See the type's own doc for why the id cannot be checked after the
    /// shape.
    private func deliver(browserId: Int32, queryId: UInt64, request: String) {
        guard let client = clients[browserId] else {
            refuse(browserId: browserId, queryId: queryId, request: request, reason: .unknownBrowser)
            return
        }
        guard let message = EditorBridgeInbound.decode(request) else {
            refuse(browserId: browserId, queryId: queryId, request: request, reason: .undecodableFrame)
            return
        }

        // **Exactly once, guaranteed here rather than trusted to every client.** The latch makes a
        // second answer a no-op (which is also what the C door does with a `queryId` it has already
        // forgotten), and the fallback below makes a client that answers NOTHING harmless: the page's
        // promise settles either way.
        var answered = false
        let respond: Respond = { [slot] success, json in
            guard !answered else { return }
            answered = true
            slot.respond(queryId, success, json)
        }
        client(message, respond)
        if !answered {
            respond(true, "{}")
        }
    }

    private func refuse(browserId: Int32, queryId: UInt64, request: String, reason: Refusal.Reason) {
        let refusal = Refusal(browserId: browserId, reason: reason,
                              request: String(request.prefix(Self.refusalRequestPrefix)))
        slot.respond(queryId, false, refusal.responseJSON)
        onRefusal?(refusal)
    }
}
