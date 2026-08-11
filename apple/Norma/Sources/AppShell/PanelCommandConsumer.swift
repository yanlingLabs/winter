import Foundation
import NormaProtocol

/// b2-agent-browser Task 3 — **the `panel_command` consumer: the first one this event has ever
/// had.**
///
/// Plan A shipped `panel_command` with no producer and no consumer (its own doc comment in
/// `SessionEvent.swift` and the spec's §3 both say so); Task 2 built the producer half — the
/// daemon's `PanelCommandRegistry` and the `panel.commandResult` answer channel
/// (`packages/core/src/panel/commands.ts`, `packages/protocol/src/methods.ts`). This is the middle:
/// the app receives a command, performs the verb against the tab's own browser, and answers exactly
/// once.
///
/// ## The three contracts it is built to
///
///  1. **Exactly one `panel.commandResult` per command.** The daemon dedups (first result wins, a
///     later one is `dropped` with a log line), but relying on that would be relying on a
///     tolerance rather than meeting a contract. Every command carries a `Call` whose `claim()` is
///     the latch: the deadline and the verb's completion race for it and only the winner speaks.
///  2. **The promise always settles, so silence is never the answer to a verb that ran.** A verb
///     that fails answers `ok:false` with a reason the model can act on ("no live browser for that
///     tab", "only http and https urls…"). The two cases that deliberately produce NO result at all
///     are named where they are decided: the quit beat (below) and the local deadline (`abandon`).
///  3. **Policy at the seam.** A `navigate` url goes through `PanelURLPolicy` before anything
///     reaches CEF — the fifth door (`PanelURLPolicy.swift`'s header names this file and this
///     arm). Nothing else here is policy: which browsers exist is `BrowserLifecycleEngine`'s
///     question, approvals are the daemon's, and the per-mode verb split is the tool registry's.
///
/// ## Where it subscribes, and why that layer
///
/// `ShellSessionHost.attachFresh`'s `feed.onEvent` — the app's ONE session-event pump
/// (`PanelStore`'s own doc comment for why a second subscriber would race it rather than duplicate
/// it), and the same hook `panelStore.apply` rides. Deliberately NOT inside `PanelStore.apply`: that
/// object is a pure fold over four PERSISTED events, and a command is an action with a reply.
///
/// Deliberately **outside** that hook's `e.sessionId == attachedSessionId` filter, unlike the store —
/// and **the reason is the HOP RACE, not a claim that unattached sessions get commands.**
///
/// Fix round 1 corrected the justification that stood here, which was false about the daemon: a
/// `panel_command` is delivered by `hub.broadcastTransient` → `fanOut(sessionId, …)` →
/// `this.attachments.get(sessionId)` alone (`packages/core/src/sessions/hub.ts`) — it is not on the
/// `onGlobalEvent` path — and this app is attached to exactly ONE session at a time, because a hop is
/// move semantics on one connection. So a command for a session the shell is not attached to is never
/// DELIVERED here at all, and "a hopped-away session's parked browser is drivable" was wrong.
///
/// What is real, and is sufficient on its own: **`hop(to:)` flips `attachedSessionId` synchronously**,
/// while the departing session's already-in-flight events are still crossing this socket. Those
/// commands were dispatched to an attachment that was genuinely ours, their tab's browser is still
/// live in this runtime, and an inside-the-filter consumer would drop every one of them into a
/// `deadlineMs` timeout for no reason. Reading the event's own `sessionId` rather than the shell's
/// current one is what keeps that window servable.
///
/// Two supporting facts, neither of which is the reason: the command names its own `sessionId` and
/// `tabId`, so no ambient context is needed to route it; and the daemon re-checks `sessionId` against
/// its own pending entry before accepting the result (`PanelCommandRegistry.resolve`), so nothing is
/// trusted here that is not checked there.
///
/// **A command can never arrive by REPLAY**, which is why nothing here guards against re-execution:
/// `panel_command` is transient, transients are never persisted, and the event's own schema comment
/// says that is exactly why it is one ("a replayed `click` or `submit` would re-fire a purchase").
///
/// ## The gap this task does not close, stated rather than left to be discovered
///
/// A command reaches this consumer only over the SHELL's harness. A session the shell is not
/// attached to — the window closed on it, or the user hopped away and only a detached window (which
/// has no panel and no runtime) holds it — has a live parked browser that no command can reach, and
/// every verb for it expires on its deadline. Spec §3 wants that answered *fast* rather than by
/// timeout ("no Mac app attached → the tool returns 'browser unavailable' immediately"), and the
/// check is Task 4's, with Task 1's per-session signals as its input.
@MainActor
final class PanelCommandConsumer {

    /// How an answer gets back to the daemon: `panel.commandResult`, fire-and-forget. Wired to
    /// `ShellSessionHost.sendPanelCommandResult` in `AppDelegate`, which rides the bare
    /// `managementClient` — the same non-attaching connection `reportPanelNavigation` uses, for the
    /// same reason (a result is owed even while the shell is mid-hop).
    typealias ResultSender = (_ sessionId: String, _ commandId: String, _ ok: Bool,
                              _ result: String?, _ imageBase64: String?) -> Void

    // MARK: - The caps, mirrored from the wire

    /// MIRRORS `PANEL_COMMAND_RESULT_MAX_LENGTH` / `PANEL_COMMAND_IMAGE_B64_MAX_LENGTH`
    /// (`packages/protocol/src/methods.ts`).
    ///
    /// **Two hand-mirrored numbers in two languages with no compile-time coupling** — the same class
    /// `PanelURLPolicy.urlMaxLength` carries, and the same warning applies with a sharper edge here.
    /// An over-cap `result` is REFUSED by the daemon at `parseParams`, not truncated, and
    /// `sendPanelCommandResult`'s `try?` swallows that rejection — so a value that slips past this
    /// check produces no result at all, and the agent is told "timed out" for a page it could have
    /// been handed. That is precisely why the check is a PRE-check here rather than a hope that the
    /// daemon will explain itself.
    ///
    /// **The UNIT is the half that drifts** (`PanelURLPolicy.wireLength`'s own doc records the cost):
    /// zod's `.max(n)` counts UTF-16 code units, Swift's `String.count` counts grapheme clusters, and
    /// for ASCII the two agree — which is what makes every literal-pinning test blind to it. Page
    /// text is the one payload here that is routinely NOT ASCII, so measuring it with `String.count`
    /// would let a page of emoji or CJK past a check the daemon then fails. Measured with
    /// `PanelURLPolicy.wireLength`, everywhere.
    static let resultMaxLength = 64 * 1024
    static let imageBase64MaxLength = 3 * 1024 * 1024

    /// How much of an identifier a REASON STRING may quote. Not a wire cap and not policy: a message
    /// is prose, and shortening prose changes nothing that gets performed — unlike shortening a URL
    /// or a selector, which this file refuses outright for the reason `PanelURLPolicy` gives. It
    /// exists because `panel_command.tabId` has a `min(1)` and no `max` on the wire.
    private static let quotedIdentifierMaxLength = 120

    // MARK: - Construction

    private let runtime: BrowserRuntime
    private let sendResult: ResultSender
    /// The deadline clock. `BrowserRuntime.Scheduler` rather than a second one of this file's own:
    /// it already models exactly "a one-shot timer at an absolute date, and its canceller", and one
    /// clock per subsystem is what lets a test drive a deadline without waiting for it.
    private let scheduler: BrowserRuntime.Scheduler

    init(runtime: BrowserRuntime, sendResult: @escaping ResultSender,
         scheduler: BrowserRuntime.Scheduler = .production) {
        self.runtime = runtime
        self.sendResult = sendResult
        self.scheduler = scheduler
    }

    // MARK: - One command's life

    /// **The exactly-one-result latch, and the only mutable state in this file.**
    ///
    /// One per command, captured by both racers — the deadline timer and the verb's completion — so
    /// the guarantee is per command rather than a process-wide set of ids that would grow without
    /// bound over a long browsing session (the daemon needs such a set, and bounds it at 256; this
    /// side does not, because a command is delivered to a client exactly once).
    ///
    /// A class, not a struct, precisely because two closures must see the same flag.
    private final class Call {
        let sessionId: String
        let commandId: String
        let action: String
        var timer: BrowserRuntime.Scheduler.Cancellable?
        private var answered = false

        init(sessionId: String, commandId: String, action: String) {
            self.sessionId = sessionId
            self.commandId = commandId
            self.action = action
        }

        /// `true` for the first caller and never again. Cancelling the deadline here — rather than
        /// at each send site — is what keeps a command that answered early from firing a timer for
        /// a call nobody is waiting on.
        func claim() -> Bool {
            guard !answered else { return false }
            answered = true
            timer?.cancel()
            timer = nil
            return true
        }
    }

    /// Route one command. The entry point, and the only public one.
    func handle(_ command: SessionEvent.PanelCommand) {
        // **The quiescent latch — the first branch, and it produces NO result at all.**
        //
        // `BrowserRuntime.quiesce()` freezes the world for the last ~150 ms of the process
        // (live-gate fix I): every container has been unparented for CEF's shutdown sweep, every
        // linger cancelled, and `apply` drops every plan. Performing a verb now would be the same
        // class of mistake as the create that fix was written for — reaching into CEF one turn from
        // `NSApp.terminate`.
        //
        // **Silence is the right answer here, not an `ok:false`**, and the reason is the daemon's
        // clock rather than tidiness: this app is about to stop existing, so an honest failure and a
        // timeout describe the same fact — the agent's next verb will find no app attached at all.
        // Sending would mean a socket write during the beat that fix I exists to keep empty. The
        // command expires on its `deadlineMs` and the agent is told "timed out", which is true.
        guard !runtime.isQuiescent else {
            NSLog("[PanelCommandConsumer] quiesced — dropping \(command.action) "
                  + "(\(Self.brief(command.commandId))); the daemon will time it out")
            return
        }

        // **WHO OWNS "does this tabId belong to this sessionId?" — the daemon's browser tool, not
        // this file.** Written down here because this is where the tab is resolved and nothing on
        // this side checks it: every verb below hands `command.tabId` to `BrowserRuntime`, whose
        // container registry is keyed by tabId across EVERY session the shell has folded, and the
        // runtime keeps no tab→session map to check against even if this file wanted one.
        //
        // Unreachable today, and named in `mayOpenTab`'s voice precisely because "every call site
        // happens to pass a safe value today" is exactly the reasoning this repo has already been
        // bitten by (`turn_completed.contextTokens`): the fan-out is session-scoped, so a command
        // can only arrive for a session that was ours, and the sole producer is Task 4's tool, which
        // does not exist yet. What makes it worth writing down now is that that tool takes a
        // **model-supplied `tabId`** — so it is the layer that holds the per-session tab list
        // (`panel.list`'s fold) and the layer that must validate `tabId ∈ that session's tabs`
        // BEFORE dispatch. Without that check a model could name another session's tab and this
        // consumer would drive it, because from here the two are indistinguishable.
        let call = Call(sessionId: command.sessionId, commandId: command.commandId,
                        action: command.action)

        switch command.action {
        case "navigate": navigate(command, call: call)
        case "back": back(command, call: call)
        case "read": read(command, call: call)
        case "screenshot": screenshot(command, call: call)

        case "click", "type", "scroll", "submit", "wait":
            // The INTERACT set (`PANEL_COMMAND_ACTIONS`'s own split, events.ts). Task 5 builds these;
            // until then they are answered rather than ignored, so its arrival is observable from the
            // agent's side and a chat-mode leak of an interaction verb would be visible rather than
            // silent.
            answer(call, ok: false,
                   result: "the browser's `\(command.action)` verb is not implemented in this "
                           + "version of the Mac app yet")

        default:
            // A verb from a NEWER daemon. `PanelCommand.action` is a plain `String` precisely so this
            // decodes rather than throwing (its own doc comment carries the two-layer tolerance
            // story), and this is the second half of that tolerance: the command is refused with an
            // explanation instead of being dropped into a timeout.
            answer(call, ok: false,
                   result: "the Mac app does not know the browser verb "
                           + "`\(Self.brief(command.action))`")
        }
    }

    // MARK: - The read set (Task 5 owns the interact set)

    /// **Door 5.** The url is judged BEFORE the tab is even resolved, so a refused scheme is
    /// attributable to the policy rather than to a missing browser — the same ordering
    /// `PanelWebTabModel.navigate(typed:)` documents for the address bar, and the reason the mutation
    /// test can tell the two apart.
    private func navigate(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let raw = command.url, !raw.isEmpty else {
            return answer(call, ok: false, result: "navigate needs a url")
        }
        guard let target = PanelURLPolicy.normalizeTypedInput(raw) else {
            return answer(call, ok: false, result: Self.refusalReason(for: raw))
        }
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "navigate needs a tabId")
        }
        guard runtime.loadURL(tabId: tabId, url: target) else {
            return answer(call, ok: false, result: Self.noBrowserReason(tabId))
        }
        // "asked" rather than "navigated": `LoadURL` is fire-and-forget and the page may still fail
        // to resolve. A committed navigation is reported through an entirely different channel
        // (`panel.reportNavigation`), and claiming one here would be claiming a fact this code has
        // no way to know.
        answer(call, ok: true, result: "asked the tab to load \(target)")
    }

    private func back(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "back needs a tabId")
        }
        guard runtime.goBack(tabId: tabId) else {
            return answer(call, ok: false, result: Self.noBrowserReason(tabId))
        }
        // Deliberately not "went back". `CefBrowser::GoBack` is a no-op on a tab with no history and
        // reports nothing either way; the tab's own state channel is where "can go back" lives.
        answer(call, ok: true, result: "asked the tab to go back")
    }

    /// The page's rendered text, over CDP.
    ///
    /// `Runtime.evaluate` rather than `DOM.getDocument` + `DOM.getOuterHTML`: what the agent needs is
    /// what a reader sees, `innerText` is the browser's own answer to that (it respects `display:
    /// none` and CSS-inserted line breaks, which `textContent` does not), and one round trip beats
    /// walking a node tree over the protocol. `textContent` is the fallback for a document with no
    /// layout at all.
    private func read(_ command: SessionEvent.PanelCommand, call: Call) {
        let expression = """
            (function () {
              var el = document.body || document.documentElement;
              if (!el) { return ""; }
              return el.innerText || el.textContent || "";
            })()
            """
        let params = Self.jsonObject([
            "expression": expression,
            "returnByValue": true,
            // The expression is synchronous by construction, and awaiting a promise here would let a
            // page hold the call open for as long as it liked — bounded only by this consumer's own
            // deadline, which is a worse place to discover it.
            "awaitPromise": false,
        ])
        runCDP(command, call: call, method: "Runtime.evaluate", paramsJSON: params) { payload in
            guard let text = PanelCDPReply.evaluatedString(fromResultJSON: payload) else {
                return .init(ok: false, result: "the page did not return any text")
            }
            // **The CAP PRE-CHECK, and it is a refusal rather than a truncation.**
            //
            // Sending an over-cap `result` is not "slightly too much": the daemon refuses the whole
            // RPC at `parseParams` (`PANEL_COMMAND_RESULT_MAX_LENGTH`), the app's `try?` swallows
            // the rejection, and the command then expires on its deadline — so the agent is told
            // "the Mac app never answered" for a page that was read perfectly well. Answering
            // `ok:false` here turns that into a fact the model can act on (open a narrower page, or
            // use ReadPage's own bounded extraction).
            //
            // Truncating instead would hand the model a page that ENDS somewhere arbitrary while
            // looking complete — the same reasoning that makes this repo drop an over-long URL
            // rather than shorten it, applied to the one payload where a quiet cut is invisible.
            let length = PanelURLPolicy.wireLength(text)
            guard length <= Self.resultMaxLength else {
                return .init(ok: false,
                             result: "the page's text is \(length) characters, past the "
                                     + "\(Self.resultMaxLength)-character limit on a browser result "
                                     + "— read a narrower page or a specific element instead")
            }
            return .init(ok: true, result: text)
        }
    }

    /// A PNG of the tab, over CDP, base64 with no `data:` prefix (`PanelCommandResultParams`).
    private func screenshot(_ command: SessionEvent.PanelCommand, call: Call) {
        let params = Self.jsonObject(["format": "png"])
        runCDP(command, call: call, method: "Page.captureScreenshot", paramsJSON: params) { payload in
            guard let data = PanelCDPReply.screenshotBase64(fromResultJSON: payload) else {
                return .init(ok: false, result: "the browser returned no image data")
            }
            // Same pre-check, same reasoning as `read` — and here truncation is not even superficially
            // tempting: half a base64 PNG is not a smaller picture, it is a corrupt file.
            let length = PanelURLPolicy.wireLength(data)
            guard length <= Self.imageBase64MaxLength else {
                return .init(ok: false,
                             result: "the screenshot is \(length) base64 characters, past the "
                                     + "\(Self.imageBase64MaxLength)-character limit on a browser "
                                     + "result")
            }
            return .init(ok: true, result: "captured a PNG screenshot of the tab", imageBase64: data)
        }
    }

    // MARK: - The CDP round trip and the deadline

    /// What a reply turns into.
    private struct Verdict {
        var ok: Bool
        var result: String?
        var imageBase64: String?
        init(ok: Bool, result: String?, imageBase64: String? = nil) {
            self.ok = ok
            self.result = result
            self.imageBase64 = imageBase64
        }
    }

    /// Dispatch one CDP method, arm the deadline, and hand the reply to `interpret`.
    ///
    /// **The deadline is armed only for verbs that can still be running when it fires.** `navigate`
    /// and `back` answer synchronously, so a timer for them would be a timer that only ever gets
    /// cancelled.
    private func runCDP(_ command: SessionEvent.PanelCommand, call: Call, method: String,
                        paramsJSON: String?, interpret: @escaping (String) -> Verdict) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "\(command.action) needs a tabId")
        }

        // **Armed BEFORE the dispatch**, because a completion that fires synchronously (every
        // refusal `NormaCEFExecuteCDP` decides itself does) must find a call it can claim — and
        // `claim()` cancels the timer, so arming first costs one cancelled timer in the fast case
        // and closes a hole in the slow one.
        let deadline = scheduler.now().addingTimeInterval(Double(command.deadlineMs) / 1000)
        call.timer = scheduler.timer(deadline) { [weak self] in self?.abandon(call) }

        let dispatched = runtime.executeCDP(tabId: tabId, method: method, paramsJSON: paramsJSON) {
            [weak self] ok, payload in
            guard let self else { return }
            // `NormaCEFExecuteCDP` promises this fires exactly once and always — including for a
            // browser that closed mid-call — so there is no "and if it never comes back" branch
            // here beyond the deadline above, which exists for the app being wedged rather than for
            // the bridge being unreliable.
            if ok {
                let verdict = interpret(payload)
                self.answer(call, ok: verdict.ok, result: verdict.result,
                            imageBase64: verdict.imageBase64)
            } else {
                self.answer(call, ok: false,
                            result: PanelCDPReply.failureMessage(fromJSON: payload)
                                ?? "the browser could not run \(method)")
            }
        }
        guard !dispatched else { return }
        // Nothing was dispatched, so nothing will ever call back — the one case where this file owes
        // the answer itself. `claim()` inside `answer` disarms the timer we just set.
        answer(call, ok: false, result: Self.noBrowserReason(tabId))
    }

    /// **The local deadline fired: abandon the verb and send NOTHING.**
    ///
    /// The decision, and the reasoning, because it is the one place this file deliberately goes
    /// quiet on a command it accepted:
    ///
    /// The daemon's pending entry was armed for the SAME `deadlineMs` and armed EARLIER —
    /// `PanelCommandRegistry.dispatch` starts its `setTimeout` before it emits, and the event still
    /// has a socket, a fold and a decode to cross before this consumer sees it. So by the time this
    /// timer fires, the daemon's has all but certainly fired too: the command is settled as
    /// `{kind:"timeout"}`, the awaiting tool has been answered, and a result sent now can only be
    /// `dropped`.
    ///
    /// **"All but certainly", not "necessarily"** (fix round 1): arming order is a fact, FIRING
    /// order is not guaranteed — a daemon whose event loop is blocked can run its `setTimeout` late
    /// enough for this side to fire first. The registry's first-wins covers that skew, so the only
    /// cost of being wrong is one unsent answer that would have been accepted. Sending would trade
    /// that for a 3 MiB payload on every genuinely-timed-out screenshot, which is the wrong side of
    /// the bet.
    ///
    /// The registry TOLERATES that — a late result is not an error, it is logged and answered
    /// `{ok:true}` — so sending would be harmless, and the argument against it is not safety but
    /// cost: `screenshot`'s payload is up to 3 MiB, and pushing 3 MiB across the socket for a
    /// command nobody is waiting on is a real price for zero information. The `ok:false` alternative
    /// ("the app gave up") is worse still, because it would arrive as a *dropped* result and teach
    /// the log nothing the timeout did not already say.
    ///
    /// **What this is NOT** is a rule against late results in general. A verb that settles a
    /// millisecond before this timer still sends — clock skew between the two sides is real, and a
    /// result that arrives while the daemon's entry is still pending is ACCEPTED. The rule is only:
    /// once this side has decided the command is over, it stays over.
    private func abandon(_ call: Call) {
        guard call.claim() else { return }
        NSLog("[PanelCommandConsumer] \(call.action) (\(Self.brief(call.commandId))) passed its "
              + "deadline — abandoned, and no result is sent (the daemon timed it out first)")
    }

    /// The single send site. Everything that answers goes through here, so "exactly one result per
    /// command" is one line rather than a discipline spread across eight call sites.
    private func answer(_ call: Call, ok: Bool, result: String?, imageBase64: String? = nil) {
        guard call.claim() else {
            // The deadline (or, impossibly, a second reply) got here first. Dropping it on this side
            // rather than letting the daemon drop it is the difference between meeting the
            // exactly-once contract and leaning on the tolerance that covers for not meeting it.
            NSLog("[PanelCommandConsumer] \(call.action) (\(Self.brief(call.commandId))) answered "
                  + "twice — the second answer was dropped here, not on the wire")
            return
        }
        sendResult(call.sessionId, call.commandId, ok, result, imageBase64)
    }

    // MARK: - Wording (never decisions)

    /// Why `normalizeTypedInput` refused — **computed only AFTER it already has**, and returning a
    /// string rather than a verdict. It cannot admit anything: the policy has spoken by the time this
    /// runs, and this only chooses words for the model.
    static func refusalReason(for raw: String) -> String {
        if PanelURLPolicy.wireLength(raw) > PanelURLPolicy.urlMaxLength {
            return "that url is \(PanelURLPolicy.wireLength(raw)) characters, past the "
                + "\(PanelURLPolicy.urlMaxLength)-character limit"
        }
        if let scheme = PanelURLPolicy.scheme(of: raw),
           !PanelURLPolicy.allowedSchemes.contains(scheme) {
            return "the panel's browser only opens http and https urls — refused the "
                + "`\(Self.brief(scheme))` scheme"
        }
        return "that is not a url the panel's browser can open (http and https only)"
    }

    private static func noBrowserReason(_ tabId: String) -> String {
        "tab \(brief(tabId)) has no live browser in this window right now"
    }

    /// Quote an identifier inside a message. See `quotedIdentifierMaxLength`.
    private static func brief(_ value: String) -> String {
        guard value.count > quotedIdentifierMaxLength else { return value }
        return String(value.prefix(quotedIdentifierMaxLength)) + "…"
    }

    /// A CDP params object. `JSONSerialization` rather than string building for the obvious reason:
    /// `read`'s expression is multi-line JavaScript with quotes in it.
    static func jsonObject(_ fields: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: fields),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }
}

/// The DevTools replies this app reads, parsed in Swift.
///
/// Separate from the consumer because it is PURE and because the ObjC++ side deliberately does no
/// parsing of its own (`NormaCEF.h`: the payload is handed over verbatim, always as a JSON object).
/// One place decodes CDP; it is testable with canned strings; and the bridge stays a transport.
enum PanelCDPReply {

    /// `Runtime.evaluate`'s answer: `{"result":{"type":"string","value":"…"}}`.
    ///
    /// `exceptionDetails` beside it means the expression THREW — a page that redefines
    /// `document.body`, a CSP that blocks evaluation — and CEF still reports the call as a SUCCESS,
    /// because the protocol method itself worked. Treating that as text would hand the model the
    /// empty string as if it were the page.
    static func evaluatedString(fromResultJSON json: String) -> String? {
        guard let root = object(json) else { return nil }
        guard root["exceptionDetails"] == nil else { return nil }
        guard let result = root["result"] as? [String: Any] else { return nil }
        return result["value"] as? String
    }

    /// `Page.captureScreenshot`'s answer: `{"data":"<base64>"}`, no `data:` prefix.
    static func screenshotBase64(fromResultJSON json: String) -> String? {
        guard let root = object(json) else { return nil }
        guard let data = root["data"] as? String, !data.isEmpty else { return nil }
        return data
    }

    /// The reason out of a failure payload. Both kinds land here and both carry `message`: the
    /// protocol's own `error` dictionary (`{"code":-32000,"message":"…"}`) and the bridge's
    /// synthesised `{"message":"…"}` — which is the whole point of the door promising one shape.
    static func failureMessage(fromJSON json: String) -> String? {
        guard let root = object(json), let message = root["message"] as? String,
              !message.isEmpty else { return nil }
        return message
    }

    private static func object(_ json: String) -> [String: Any]? {
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parsed as? [String: Any]
    }
}
