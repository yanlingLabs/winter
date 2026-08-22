import CoreGraphics
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
///
/// ## Task 5 — the interact set, and **the rule every one of its arms is built to**
///
/// From here a model types and clicks inside the user's own logged-in browser. `panel_command.args`
/// is read for the first time, which retires the containment `NormaCEF.h`'s CDP-door header relied
/// on ("every `method` string and every expression this app sends is a LITERAL … `args` is
/// deliberately not read at all until Task 5"). What replaces it is a rule, honoured at every site:
///
/// > **A model string may become a CDP PARAMETER VALUE, and nothing else. It never becomes part of a
/// > method name, a `Runtime.evaluate` expression, or a `functionDeclaration`.**
///
/// Concretely, and this is the whole reason the verbs are shaped the way they are:
///
///  * **Elements are resolved over the DOM domain, not by evaluating JavaScript.**
///    `DOM.getDocument` → `DOM.querySelector`, with the model's selector as `querySelector`'s own
///    `selector` parameter, read by Blink's CSS parser. The alternative — `Runtime.evaluate` over
///    `"document.querySelector('" + selector + "')"` — is precisely the vulnerability the door's
///    header names: a selector containing `')` would stop being a selector and start being a
///    program, in a page the user is signed into, on a bridge where `location.href = …` is a
///    navigation no URL policy can see.
///  * **Text reaches the page through `Input.insertText`'s `text` parameter**, which the browser
///    commits as if from an IME. It is never evaluated and never becomes markup.
///  * **The only JavaScript these verbs run is two argument-free literals** — the select-before-type
///    and `submit`'s form lookup — invoked with `Runtime.callFunctionOn` against an objectId this
///    app resolved. A model string cannot reach either, because neither takes an argument at all.
///  * **Numbers and enumerated words never travel as themselves.** `direction` becomes a signed
///    delta chosen from `PanelCommandArguments`' own literals; `until` becomes a
///    `WaitPredicate` case. What lands in a params dictionary is this app's value, not the
///    command's bytes.
///
/// `SensitiveFieldFloor` (`BrowserInteractionPolicy.swift`) is the OTHER half, and the one spec §4
/// calls the security deliverable: before any `type`, the target field is inspected over CDP and a
/// password/payment field is refused — fail-closed, so an inspection that does not produce a
/// readable answer refuses too. That policy lives app-side, against this repo's usual split, because
/// the question is unanswerable anywhere else: the daemon has a selector string and has never seen
/// the page. Its own doc comment carries the argument and the honest list of what it cannot catch.
///
/// **What Task 5 does NOT contain, said here because `click` is the one people assume is contained.**
/// A `click` on a link is a full navigation to wherever the page points, and no part of this stack
/// sees where that is: `PanelURLPolicy` (door 5) guards the url this consumer LOADS, and a click
/// routes through none of it; the daemon's dangerous-domain block is first-hop-only by construction
/// (`browser.ts`'s `refuseDangerous`); and `panel.reportNavigation` arrives after the fact, as a
/// report, with nothing awaiting it. The agent can therefore reach any page a link on an allowed
/// page leads to. That is inherited from Task 4 and named again here rather than left to be
/// rediscovered.
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

    /// How much of a quoted SENTENCE a reason may carry — a CDP error message, which is the
    /// browser's prose and may embed a page-thrown exception's text. Longer than an identifier's
    /// bound because 120 characters cuts a real diagnostic mid-clause; far short of the wire cap,
    /// which `answer` enforces regardless (fix round 1, review Important-1).
    private static let quotedReasonMaxLength = 400

    // MARK: - Construction

    private let runtime: BrowserRuntime
    private let sendResult: ResultSender
    /// The deadline clock. `BrowserRuntime.Scheduler` rather than a second one of this file's own:
    /// it already models exactly "a one-shot timer at an absolute date, and its canceller", and one
    /// clock per subsystem is what lets a test drive a deadline without waiting for it.
    private let scheduler: BrowserRuntime.Scheduler
    /// office-agent-tools T1 — the office half of this bridge (`OfficeCommandConsumer.swift`'s own
    /// header). Constructed HERE, reusing the SAME `sendResult` this type already received, rather
    /// than threaded through as a fourth `init` parameter: both consumers answer through the
    /// identical `panel.commandResult` mechanism, and T1 has nothing else for an office command to
    /// need from this type (no `runtime`, no `scheduler` — see that file's header for why). Keeping
    /// construction internal is what leaves `AppDelegate`'s `PanelCommandConsumer(runtime:sendResult:)`
    /// call site untouched by this task.
    private let officeCommands: OfficeCommandConsumer

    init(runtime: BrowserRuntime, sendResult: @escaping ResultSender,
         scheduler: BrowserRuntime.Scheduler = .production) {
        self.runtime = runtime
        self.sendResult = sendResult
        self.scheduler = scheduler
        self.officeCommands = OfficeCommandConsumer(sendResult: sendResult)
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
        /// **`wait`'s poll timer — a SECOND clock, and it must die with the first.** The deadline
        /// timer above bounds the whole command; this one paces the poll (or, for `until:"ms"`, IS
        /// the wait). A `claim()` that cancelled only the deadline would leave a poll re-arming
        /// itself against a call that was already answered, issuing CDP work for nobody.
        var pollTimer: BrowserRuntime.Scheduler.Cancellable?
        private var answered = false

        init(sessionId: String, commandId: String, action: String) {
            self.sessionId = sessionId
            self.commandId = commandId
            self.action = action
        }

        /// Has this call already spoken? Read by every step of a multi-round-trip verb, so a chain
        /// whose deadline fired mid-flight stops issuing CDP calls rather than running to the end
        /// and discovering it at `answer`.
        var isAnswered: Bool { answered }

        /// `true` for the first caller and never again. Cancelling the timers here — rather than
        /// at each send site — is what keeps a command that answered early from firing a timer for
        /// a call nobody is waiting on.
        func claim() -> Bool {
            guard !answered else { return false }
            answered = true
            timer?.cancel()
            timer = nil
            pollTimer?.cancel()
            pollTimer = nil
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

        // office-agent-tools T1 — route OFFICE verbs to the office consumer, AFTER the quiescent
        // guard above rather than before it. `isQuiescent` reads as CEF-specific at a glance (it is
        // `BrowserRuntime`'s own flag), but its MEANING is not: it is the app's terminal beat, and its
        // own comment gives two reasons that are subsystem-agnostic — a refusal now and a timeout
        // describe the SAME fact when the app stops existing next tick, and the beat must stay empty
        // of *socket writes*, which an office refusal is one of. One teardown discipline for every
        // verb this file routes, browser or office, rather than a second one office would otherwise
        // need to invent for itself. (What "never a throw, never silence" governs is this file's
        // handling of a verb IN OPERATION — the browser verbs below accept silence in the quit beat
        // by the same design, for the same reason.)
        guard !OfficeCommandConsumer.isOfficeAction(command.action) else {
            return officeCommands.handle(command)
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

        // The INTERACT set (`PANEL_COMMAND_ACTIONS`'s own split, events.ts) — Task 5. Every one of
        // these reads `command.args`, and the rule that governs what may be done with what it finds
        // is in this file's header.
        case "click": click(command, call: call)
        case "type": typeText(command, call: call)
        case "scroll": scroll(command, call: call)
        case "submit": submit(command, call: call)
        case "wait": wait(command, call: call)

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

    // MARK: - The read set

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

    // MARK: - Task 5: the interact set

    /// **`click` — a real pointer, at the element's own coordinates.**
    ///
    /// Seven CDP round trips and not one of them evaluates JavaScript: `DOM.getDocument` →
    /// `DOM.querySelector` (the model's selector, as a protocol parameter) → `scrollIntoViewIfNeeded`
    /// → `getBoxModel` → three `Input.dispatchMouseEvent`s. The mouse events carry NUMBERS this app
    /// computed from Blink's own box model; nothing from the command reaches them.
    ///
    /// **`Input.dispatchMouseEvent` hit-tests like a real pointer, which is the honest caveat:** the
    /// click lands on whatever is topmost at that point. An element that has a box but is covered by
    /// an overlay, or is `visibility:hidden`, sends the click to the thing in front of it. That is
    /// the same thing a person clicking there would get — it is not a defect to be papered over with
    /// a JS `.click()`, which would fire an event no real user could have produced.
    ///
    /// **This is a navigation door the daemon never sees** (this file's header): a click on a link
    /// goes wherever the page says, past every URL policy in this stack.
    private func click(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "click needs a tabId")
        }
        guard let selector = operand(PanelCommandArguments.selector(command.args, verb: "click"), call)
        else { return }

        arm(call, deadlineMs: command.deadlineMs)
        resolve(call, tabId: tabId, selector: selector) { nodeId in
            self.step(call, tabId: tabId, method: "DOM.scrollIntoViewIfNeeded",
                      params: ["nodeId": nodeId],
                      failureIs: "the element could not be scrolled into view") { _ in
                self.step(call, tabId: tabId, method: "DOM.getBoxModel", params: ["nodeId": nodeId],
                          failureIs: Self.noVisibleBox) { payload in
                    guard let centre = PanelCDPReply.boxCentre(fromResultJSON: payload) else {
                        return self.answer(call, ok: false, result: Self.noVisibleBox)
                    }
                    self.dispatchClick(call, tabId: tabId, at: centre, selector: selector)
                }
            }
        }
    }

    /// Move, press, release — the sequence a pointer actually makes. The `mouseMoved` is not
    /// ceremony: menus, tooltips and half the web's dropdowns open on hover, and a press with no
    /// preceding move arrives at an element that never learned the pointer was there.
    private func dispatchClick(_ call: Call, tabId: String, at point: CGPoint, selector: String) {
        let x = Double(point.x), y = Double(point.y)
        step(call, tabId: tabId, method: "Input.dispatchMouseEvent",
             params: ["type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0]) { _ in
            self.step(call, tabId: tabId, method: "Input.dispatchMouseEvent",
                      params: ["type": "mousePressed", "x": x, "y": y, "button": "left",
                               "buttons": 1, "clickCount": 1]) { _ in
                self.step(call, tabId: tabId, method: "Input.dispatchMouseEvent",
                          params: ["type": "mouseReleased", "x": x, "y": y, "button": "left",
                                   "buttons": 0, "clickCount": 1]) { _ in
                    self.answer(call, ok: true,
                                result: "clicked \(Self.brief(selector)) at "
                                        + "(\(Int(x.rounded())), \(Int(y.rounded()))) in the page")
                }
            }
        }
    }

    /// **`type` — and THE SENSITIVE FLOOR, which is the reason this arm has the shape it has.**
    ///
    /// The order is the policy: resolve → **inspect** → judge → (only then) focus, select, insert.
    /// Nothing types before the floor has spoken, and the floor speaks from `DOM.describeNode`'s
    /// attribute list — Blink's own view of the element, not a `Runtime.evaluate` of `el.type`,
    /// which a page can shadow with a property getter. `SensitiveFieldFloor`'s doc carries that
    /// argument in full, along with the list of what it cannot catch.
    ///
    /// **Fail closed, and this is where that is implemented:** an inspection that fails, or whose
    /// payload does not yield a named node, is a REFUSAL. There is no branch here that types into a
    /// field it could not read. (Mutation: break the inspector and this arm starts refusing — never
    /// allowing — which is what the test of that name checks.)
    ///
    /// **One node, start to finish.** The floor judges `nodeId`, and `DOM.focus` focuses that same
    /// `nodeId`; nothing re-runs the selector. Re-querying between inspection and typing would be a
    /// genuine time-of-check/time-of-use hole — a page that swapped its DOM in between could be
    /// inspected as a search box and typed into as a password field.
    ///
    /// **`type` SETS the field.** Focus, select what is there, then `Input.insertText`, which commits
    /// over the selection the way an IME does. Not key-by-key synthesis: `Input.dispatchKeyEvent`
    /// per character is slower, fires a plausible-looking key stream this app would be inventing, and
    /// is exactly as visible to a page's `input` handlers as the insert is.
    private func typeText(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "type needs a tabId")
        }
        guard let selector = operand(PanelCommandArguments.selector(command.args, verb: "type"), call),
              let text = operand(PanelCommandArguments.text(command.args), call)
        else { return }

        arm(call, deadlineMs: command.deadlineMs)
        resolve(call, tabId: tabId, selector: selector) { nodeId in
            // ---- THE FLOOR ----------------------------------------------------------------------
            self.step(call, tabId: tabId, method: "DOM.describeNode", params: ["nodeId": nodeId],
                      failureIs: Self.floorInspectionFailed) { payload in
                guard let field = PanelCDPReply.describedField(fromResultJSON: payload) else {
                    return self.answer(call, ok: false, result: Self.floorInspectionFailed)
                }
                if case .refuse(let kind, let evidence) = SensitiveFieldFloor.judge(field) {
                    NSLog("[PanelCommandConsumer] sensitive floor refused a type into a \(kind) "
                          + "(\(evidence)) — \(SensitiveFieldFloor.noApprovalCanLiftThis)")
                    return self.answer(call, ok: false,
                                       result: SensitiveFieldFloor.refusal(kind: kind,
                                                                           evidence: evidence))
                }
                // ---- only now does anything touch the field ---------------------------------
                self.insert(call, tabId: tabId, nodeId: nodeId, text: text, into: field)
            }
        }
    }

    /// Scroll into view, focus, select what is there, insert. Reached only past the floor.
    private func insert(_ call: Call, tabId: String, nodeId: Int, text: String,
                        into field: SensitiveFieldFloor.Field) {
        step(call, tabId: tabId, method: "DOM.scrollIntoViewIfNeeded", params: ["nodeId": nodeId],
             failureIs: "the field could not be scrolled into view") { _ in
            // `DOM.focus` rather than a JavaScript `el.focus()`: focusing over the protocol cannot be
            // redirected by a page that overrode `Element.prototype.focus`. (What it CANNOT prevent
            // is a page moving focus from its own `focus` handler — named in the floor's limits.)
            self.step(call, tabId: tabId, method: "DOM.focus", params: ["nodeId": nodeId],
                      failureIs: "the field could not be focused — it may be disabled, read-only, or "
                               + "not something text can be typed into") { _ in
                self.step(call, tabId: tabId, method: "DOM.resolveNode", params: ["nodeId": nodeId],
                          failureIs: "the field could not be prepared for typing") { payload in
                    guard let objectId = PanelCDPReply.remoteObjectId(fromResultJSON: payload) else {
                        return self.answer(call, ok: false,
                                           result: "the field could not be prepared for typing")
                    }
                    // The first of this task's two JavaScript literals. It takes NO arguments, so no
                    // model string can reach it; it runs against an objectId this app resolved.
                    self.step(call, tabId: tabId, method: "Runtime.callFunctionOn",
                              params: ["objectId": objectId,
                                       "functionDeclaration": Self.selectExistingContentFunction,
                                       "returnByValue": true],
                              failureIs: "the field's existing content could not be selected") { _ in
                        // The model's text, as `insertText`'s own parameter. Never evaluated.
                        self.step(call, tabId: tabId, method: "Input.insertText",
                                  params: ["text": text]) { _ in
                            self.answer(call, ok: true,
                                        result: "typed \(PanelURLPolicy.wireLength(text)) characters "
                                                + "into the \(Self.describe(field))")
                        }
                    }
                }
            }
        }
    }

    /// **`scroll` — either bring one element into view, or wheel the page.**
    ///
    /// The wheel path dispatches a real `mouseWheel` at the viewport's centre rather than calling
    /// `window.scrollBy`, and the difference is not stylistic: a wheel event scrolls whatever is
    /// under the pointer, so an inner scroll container — a chat log, a virtualised table, a modal —
    /// moves, where `scrollBy` would silently move the document behind it and report success.
    ///
    /// The viewport comes from `Page.getLayoutMetrics`, and an unreadable answer is refused rather
    /// than defaulted: a guessed viewport aims the wheel at a point that may not be over the content
    /// at all, and "scrolled" would then be a claim this code cannot make.
    private func scroll(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "scroll needs a tabId")
        }
        guard let target = operand(PanelCommandArguments.scrollTarget(command.args), call) else { return }

        arm(call, deadlineMs: command.deadlineMs)
        switch target {
        case .element(let selector):
            resolve(call, tabId: tabId, selector: selector) { nodeId in
                self.step(call, tabId: tabId, method: "DOM.scrollIntoViewIfNeeded",
                          params: ["nodeId": nodeId],
                          failureIs: Self.noVisibleBox) { _ in
                    self.answer(call, ok: true,
                                result: "scrolled \(Self.brief(selector)) into view")
                }
            }

        case .wheel(let deltaX, let deltaY):
            step(call, tabId: tabId, method: "Page.getLayoutMetrics", params: [:],
                 failureIs: "the page's viewport could not be measured") { payload in
                guard let viewport = PanelCDPReply.viewportSize(fromResultJSON: payload) else {
                    return self.answer(call, ok: false,
                                       result: "the page's viewport could not be measured")
                }
                self.step(call, tabId: tabId, method: "Input.dispatchMouseEvent",
                          params: ["type": "mouseWheel",
                                   "x": Double(viewport.width) / 2, "y": Double(viewport.height) / 2,
                                   "button": "none", "buttons": 0,
                                   "deltaX": deltaX, "deltaY": deltaY]) { _ in
                    self.answer(call, ok: true, result: Self.scrolledBy(deltaX: deltaX, deltaY: deltaY))
                }
            }
        }
    }

    /// **`submit` — the form, not the button.**
    ///
    /// `requestSubmit()` rather than `submit()`: the former is what pressing Enter in a field does —
    /// it runs the form's constraint validation and fires a cancellable `submit` event, so a page's
    /// own handler (every single-page app) sees it. `HTMLFormElement.submit()` skips both, which
    /// would post a form the page believed it had intercepted. The fallback exists only for a
    /// document old enough to lack `requestSubmit`.
    ///
    /// The selector may name the form or anything inside it — `this.form ?? this.closest("form")` —
    /// because an agent looking at a page sees the button, not the form element.
    ///
    /// **The floor does not apply here, and that is deliberate rather than an oversight.** It bounds
    /// what the agent TYPES. A form the browser autofilled can be submitted from here, and could
    /// equally be submitted by `click`ing its button — gating one and not the other would be
    /// theatre. What bounds this is the domain gate (Task 6).
    private func submit(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "submit needs a tabId")
        }
        guard let selector = operand(PanelCommandArguments.selector(command.args, verb: "submit"), call)
        else { return }

        arm(call, deadlineMs: command.deadlineMs)
        resolve(call, tabId: tabId, selector: selector) { nodeId in
            self.step(call, tabId: tabId, method: "DOM.resolveNode", params: ["nodeId": nodeId],
                      failureIs: "the element could not be prepared for submitting") { payload in
                guard let objectId = PanelCDPReply.remoteObjectId(fromResultJSON: payload) else {
                    return self.answer(call, ok: false,
                                       result: "the element could not be prepared for submitting")
                }
                // The second of this task's two JavaScript literals — argument-free, so no model
                // string reaches it, and run against an objectId this app resolved.
                self.step(call, tabId: tabId, method: "Runtime.callFunctionOn",
                          params: ["objectId": objectId,
                                   "functionDeclaration": Self.submitFormFunction,
                                   "returnByValue": true]) { payload in
                    switch PanelCDPReply.evaluatedString(fromResultJSON: payload) {
                    case "submitted":
                        self.answer(call, ok: true,
                                    result: "submitted the form containing \(Self.brief(selector))")
                    case "no-form":
                        self.answer(call, ok: false,
                                    result: "\(Self.brief(selector)) is not inside a <form>, so there "
                                            + "is nothing to submit — click the button instead")
                    default:
                        self.answer(call, ok: false, result: "the form would not submit")
                    }
                }
            }
        }
    }

    /// **`wait` — a bounded poll, whose bound has to fit inside the command's own deadline.**
    ///
    /// Three clocks run on one `wait` and only the innermost may win: the daemon's pending entry
    /// (`deadlineMs`, armed first), this consumer's local abandon timer (the same `deadlineMs`,
    /// armed later), and the model's `timeoutMs`. `PanelCommandArguments.waitCeiling` clamps the
    /// third **against this command's own `deadlineMs`** — 20 s inside the shipped 30 s;
    /// `browser.ts`'s `BROWSER_WAIT_MAX_TIMEOUT_MS` carries the full arithmetic. The clamp is
    /// applied HERE as well as there because the app is the last thing before the browser and does
    /// not take the wire's word for a bound.
    ///
    /// `until:"ms"` touches no browser at all — it is a sleep, and dressing it up as a CDP call
    /// would make a tab's health a precondition for waiting.
    private func wait(_ command: SessionEvent.PanelCommand, call: Call) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "wait needs a tabId")
        }
        guard let asked = operand(
            PanelCommandArguments.wait(command.args, deadlineMs: command.deadlineMs), call)
        else { return }

        arm(call, deadlineMs: command.deadlineMs)
        let budget = Double(asked.timeoutMs) / 1000
        let until = scheduler.now().addingTimeInterval(budget)

        if asked.predicate == .ms {
            call.pollTimer = scheduler.timer(until) { [weak self] in
                self?.answer(call, ok: true, result: "waited \(asked.timeoutMs)ms")
            }
            return
        }
        poll(call, tabId: tabId, predicate: asked.predicate, until: until,
             timeoutMs: asked.timeoutMs, previousResources: nil)
    }

    /// One poll of the page's loading state, and the decision to poll again or give up.
    ///
    /// `previousResources` is what makes `idle` mean anything: the first poll can never satisfy it,
    /// because "no new resource finished since last time" needs a last time.
    private func poll(_ call: Call, tabId: String, predicate: PanelCommandArguments.WaitPredicate,
                      until: Date, timeoutMs: Int, previousResources: Int?) {
        step(call, tabId: tabId, method: "Runtime.evaluate",
             params: ["expression": Self.waitProbeScript, "returnByValue": true, "awaitPromise": false],
             failureIs: "the page's loading state could not be read") { payload in
            guard let probe = PanelCDPReply.waitProbe(fromResultJSON: payload) else {
                return self.answer(call, ok: false,
                                   result: "the page's loading state could not be read")
            }
            let complete = probe.ready == "complete"
            let satisfied = predicate == .idle
                ? (complete && previousResources == probe.resources)
                : complete
            if satisfied {
                return self.answer(call, ok: true, result: predicate == .idle
                    ? "the page is loaded and nothing new finished fetching"
                    : "the page finished loading")
            }
            let next = self.scheduler.now().addingTimeInterval(Self.waitPollIntervalSeconds)
            guard next <= until else {
                // `probe.ready` is page-controlled, not merely page-reported: `document.readyState`
                // is a property, and a page can shadow it with a getter returning a megabyte. It is
                // read for a MESSAGE only — never for the verdict, which compares it to a literal —
                // so the exposure is the message-length one Important-1 names, and it is briefed
                // here as well as capped at `answer`.
                return self.answer(call, ok: false,
                                   result: "the page did not reach `\(predicate.rawValue)` within "
                                           + "\(timeoutMs)ms — it was still `\(Self.brief(probe.ready))`")
            }
            call.pollTimer = self.scheduler.timer(next) { [weak self] in
                self?.poll(call, tabId: tabId, predicate: predicate, until: until,
                           timeoutMs: timeoutMs, previousResources: probe.resources)
            }
        }
    }

    // MARK: - Resolution, and the one place a model string crosses into CDP

    /// **`DOM.getDocument` → `DOM.querySelector`. The model's selector travels as `querySelector`'s
    /// own parameter and nowhere else.**
    ///
    /// This function is the whole reason the interact verbs do not use `Runtime.evaluate`. A CSS
    /// selector handed to `DOM.querySelector` is read by Blink's CSS parser: the worst a hostile one
    /// can do is match a different element or fail to parse, and a parse failure comes back as a
    /// protocol error this reports. The same string concatenated into
    /// `"document.querySelector('" + selector + "')"` would be a program — in a page the user is
    /// logged into, over a bridge where one `location.href` assignment is a navigation no URL policy
    /// in this app can see (`NormaCEF.h`'s CDP-door header states exactly that).
    ///
    /// `DOM.getDocument` is re-issued per command rather than cached: node ids are scoped to the
    /// DOM agent's current document and are invalidated by every navigation, so a cached root is a
    /// stale-id bug waiting for the first page change.
    private func resolve(_ call: Call, tabId: String, selector: String,
                         then: @escaping (Int) -> Void) {
        step(call, tabId: tabId, method: "DOM.getDocument", params: ["depth": 0],
             failureIs: "the page's document could not be read") { payload in
            guard let root = PanelCDPReply.rootNodeId(fromResultJSON: payload) else {
                return self.answer(call, ok: false, result: "the page's document could not be read")
            }
            self.step(call, tabId: tabId, method: "DOM.querySelector",
                      params: ["nodeId": root, "selector": selector],
                      failureIs: "that is not a CSS selector this page's parser accepts") { payload in
                guard let nodeId = PanelCDPReply.nodeId(fromResultJSON: payload), nodeId != 0 else {
                    return self.answer(call, ok: false, result:
                        "nothing on the page matches \(Self.brief(selector)). Selectors are matched "
                        + "against the top document only — not inside iframes or shadow DOM.")
                }
                then(nodeId)
            }
        }
    }

    /// Unwrap an operand, answering the model with its own refusal when it is not there.
    private func operand<Value>(_ read: PanelCommandArguments.Read<Value>, _ call: Call) -> Value? {
        switch read {
        case .ok(let value):
            return value
        case .refused(let why):
            answer(call, ok: false, result: why)
            return nil
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

    /// Dispatch one CDP method, arm the deadline, and hand the reply to `interpret`. The shape the
    /// two read verbs use — one round trip, one verdict.
    ///
    /// **The deadline is armed only for verbs that can still be running when it fires.** `navigate`
    /// and `back` answer synchronously, so a timer for them would be a timer that only ever gets
    /// cancelled.
    private func runCDP(_ command: SessionEvent.PanelCommand, call: Call, method: String,
                        paramsJSON: String?, interpret: @escaping (String) -> Verdict) {
        guard let tabId = command.tabId else {
            return answer(call, ok: false, result: "\(command.action) needs a tabId")
        }
        arm(call, deadlineMs: command.deadlineMs)
        step(call, tabId: tabId, method: method, paramsJSON: paramsJSON) { payload in
            let verdict = interpret(payload)
            self.answer(call, ok: verdict.ok, result: verdict.result,
                        imageBase64: verdict.imageBase64)
        }
    }

    /// **Arm the command's one deadline.** Separate from `step` since Task 5, because an interact
    /// verb is a CHAIN of round trips under a SINGLE deadline — a timer per step would give a
    /// seven-hop `click` seven times the patience the command was dispatched with.
    ///
    /// **Armed BEFORE the first dispatch**, because a completion that fires synchronously (every
    /// refusal `NormaCEFExecuteCDP` decides itself does) must find a call it can claim — and
    /// `claim()` cancels the timer, so arming first costs one cancelled timer in the fast case and
    /// closes a hole in the slow one.
    ///
    /// Idempotent, so a verb that re-enters this cannot restart its own clock.
    private func arm(_ call: Call, deadlineMs: Int) {
        guard call.timer == nil else { return }
        let deadline = scheduler.now().addingTimeInterval(Double(deadlineMs) / 1000)
        call.timer = scheduler.timer(deadline) { [weak self] in self?.abandon(call) }
    }

    /// **One CDP round trip inside a verb's chain.** Arms nothing; `arm` owns the clock.
    ///
    /// Three things it guarantees, so the verbs above can be written as plain nesting:
    ///
    ///  1. **A call that has already spoken issues no further work.** Checked before the dispatch
    ///     AND inside the completion — a chain whose deadline fired mid-flight stops there rather
    ///     than running its remaining hops for an answer nobody will accept.
    ///  2. **Every failure answers.** A CEF failure carries the browser's own message; `failureIs`
    ///     replaces it with something the model can act on and keeps the raw text in parentheses,
    ///     because "Could not compute box model" means nothing to a model and everything to whoever
    ///     reads the log.
    ///  3. **A dispatch that never happened answers too** — `executeCDP` returning false means no
    ///     completion will ever fire, and that is the one case this file owes the answer itself.
    ///
    /// The quiescent check repeats `handle`'s, for the case `handle` cannot cover: a chain already
    /// in flight when the app starts shutting down. Same verdict, same reason — silence, and the
    /// daemon's timeout is the true answer.
    private func step(_ call: Call, tabId: String, method: String, paramsJSON: String?,
                      failureIs: String? = nil, then: @escaping (String) -> Void) {
        guard !call.isAnswered else { return }
        guard !runtime.isQuiescent else {
            NSLog("[PanelCommandConsumer] quiesced mid-\(call.action) "
                  + "(\(Self.brief(call.commandId))) — dropping \(method)")
            return
        }
        let dispatched = runtime.executeCDP(tabId: tabId, method: method, paramsJSON: paramsJSON) {
            [weak self] ok, payload in
            guard let self, !call.isAnswered else { return }
            // `NormaCEFExecuteCDP` promises this fires exactly once and always — including for a
            // browser that closed mid-call — so there is no "and if it never comes back" branch
            // here beyond the deadline, which exists for the app being wedged rather than for the
            // bridge being unreliable.
            if ok {
                then(payload)
            } else {
                // The browser's own words, BRIEFED: a CDP error message can carry a page-thrown
                // exception's text, which is unbounded (fix round 1). `answer`'s cap is the
                // structural guard; this keeps the quoted reason a reason rather than a wall.
                let raw = PanelCDPReply.failureMessage(fromJSON: payload)
                    .map { Self.brief($0, max: Self.quotedReasonMaxLength) }
                    ?? "the browser could not run \(method)"
                self.answer(call, ok: false, result: failureIs.map { "\($0) (\(raw))" } ?? raw)
            }
        }
        guard !dispatched else { return }
        answer(call, ok: false, result: Self.noBrowserReason(tabId))
    }

    /// `step` with the params written as a dictionary — which is how every Task 5 verb builds them,
    /// so that a value is a JSON value rather than a piece of hand-spliced text.
    private func step(_ call: Call, tabId: String, method: String, params: [String: Any],
                      failureIs: String? = nil, then: @escaping (String) -> Void) {
        guard let json = Self.jsonObject(params) else {
            // Unreachable with the literals and numbers these verbs build, and answered rather than
            // ignored anyway: a silently dropped step is a command that can only time out.
            return answer(call, ok: false,
                          result: "the Mac app could not encode its \(method) request")
        }
        step(call, tabId: tabId, method: method, paramsJSON: json, failureIs: failureIs, then: then)
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
        var body = result
        var image = imageBase64

        // **THE LAST-RESORT CAP — at the send site, so EVERY message inherits it** (fix round 1,
        // review Important-1).
        //
        // The finding it exists for: `SensitiveFieldFloor`'s evidence string quoted a page-supplied
        // `autocomplete` token matched only by a `cc-` prefix, so `autocomplete="cc-<70KB>"` built a
        // 70 KB refusal — and an over-cap `result` is REFUSED whole by the daemon at `parseParams`,
        // `sendPanelCommandResult`'s `try?` swallows the rejection, and the command then expires on
        // its deadline. **The floor's visible refusal would have become "the Mac app did not
        // answer… Nothing is known about whether it ran"** — silence, on the one message this whole
        // task exists to deliver.
        //
        // The individual sites are fixed too (`SensitiveFieldFloor.quoted`, `brief` on the tag name
        // and on `readyState`), but a per-site fix only holds until the next message is written.
        // This is the structural half: no path out of this file can produce a frame the daemon will
        // refuse for length, whatever a future arm interpolates. Page-controlled text reaches a
        // message from at least four directions today — an attribute value, an element's `nodeName`,
        // a shadowed `document.readyState`, and the browser's own CDP error text — and the list is
        // open by nature.
        //
        // **Truncated, where `read` REFUSES — and the difference is not an inconsistency.** `read`'s
        // payload IS the answer, so half of it is a page that ends somewhere arbitrary while looking
        // complete; that deserves an explicit refusal naming the size, and its own pre-check stays
        // for exactly that reason (a better message, produced earlier). A REASON is prose: its first
        // sentence carries the meaning, the cut is marked, and delivering it beats delivering
        // nothing. This is a backstop, not the first line of defence.
        if let data = image, PanelURLPolicy.wireLength(data) > Self.imageBase64MaxLength {
            // Unreachable while `screenshot`'s own pre-check stands, and owed anyway. DROPPED, never
            // cut: half a base64 PNG is not a smaller picture, it is a corrupt file — the one place
            // truncation is not merely worse but meaningless.
            NSLog("[PanelCommandConsumer] \(call.action) (\(Self.brief(call.commandId))) produced an "
                  + "over-cap image — dropped rather than truncated")
            image = nil
            body = [body, "(the image was too large to send and was dropped)"]
                .compactMap { $0 }.joined(separator: " ")
        }
        if let text = body, PanelURLPolicy.wireLength(text) > Self.resultMaxLength {
            NSLog("[PanelCommandConsumer] \(call.action) (\(Self.brief(call.commandId))) produced a "
                  + "\(PanelURLPolicy.wireLength(text))-character result — cut to the wire's cap so "
                  + "it is delivered rather than refused")
            body = Self.capped(text)
        }
        sendResult(call.sessionId, call.commandId, ok, body, image)
    }

    /// Cut a message to `resultMaxLength` in the daemon's unit, and SAY that it was cut — a silently
    /// truncated reason is a reason the reader trusts to the end. The marker is measured too, so the
    /// result of this function always fits.
    static func capped(_ text: String) -> String {
        let length = PanelURLPolicy.wireLength(text)
        guard length > resultMaxLength else { return text }
        let marker = " … [cut by Norma: the full message was \(length) characters]"
        let room = max(0, resultMaxLength - PanelURLPolicy.wireLength(marker))
        return PanelURLPolicy.truncated(text, toWireLength: room) + marker
    }

    // MARK: - Task 5's literals — every one of them fixed text, none assembled from a command

    /// How often `wait` re-asks the page. 250 ms is four questions a second: fine-grained enough
    /// that a page finishing at t+300 ms is reported at t+500 ms rather than a second later, and
    /// coarse enough that a 20-second wait is 80 round trips rather than thousands.
    static let waitPollIntervalSeconds: TimeInterval = 0.25

    /// **What `wait` asks the page, and the honest limits of the answer.**
    ///
    /// `document.readyState` is the browser's own load state and needs no defending. `resources` is
    /// a PROXY for network idle and is named as one everywhere it is used: a `PerformanceResourceTiming`
    /// entry appears when a fetch FINISHES, so a count that did not move across two polls means
    /// "nothing finished recently", which is the closest a page can come to observing its own
    /// network. What it does not see: requests that started but have not finished (they are not
    /// entries yet), websockets and long-polls (never entries), and anything after the resource
    /// timing buffer fills — 250 entries by default, after which the count stops growing and `idle`
    /// becomes trivially true. Observing the real thing needs the `Network` domain's EVENTS, and
    /// this app's CDP bridge correlates method REPLIES only (`NormaCEF.h`), so there is no event
    /// stream to subscribe to.
    ///
    /// A literal, with nothing interpolated into it — the rule this file's header states.
    static let waitProbeScript = """
        (function () {
          var n = -1;
          try { n = performance.getEntriesByType("resource").length; } catch (e) { n = -1; }
          return { ready: document.readyState, resources: n };
        })()
        """

    /// Select whatever the field already contains, so the `Input.insertText` that follows REPLACES
    /// it rather than appending to it. Argument-free by design: no model string can reach a
    /// `functionDeclaration`, and this one needs nothing but `this`.
    ///
    /// Three shapes of editable exist and all three are handled: `<input>`/`<textarea>` have
    /// `select()`; a `contenteditable` element needs a range over its contents; anything else falls
    /// through having changed nothing, which is harmless — `DOM.focus` has already refused a
    /// non-focusable element by the time this runs.
    static let selectExistingContentFunction = """
        function () {
          if (typeof this.select === "function") { this.select(); return true; }
          if (this.isContentEditable) {
            var range = document.createRange();
            range.selectNodeContents(this);
            var selection = window.getSelection();
            if (selection) { selection.removeAllRanges(); selection.addRange(range); }
            return true;
          }
          return false;
        }
        """

    /// Find the form this element belongs to and submit it the way Enter does. `requestSubmit`
    /// validates and fires a cancellable `submit` event; `submit()` does neither and exists here
    /// only as a fallback. Argument-free, like the one above — `"form"` is this file's own literal.
    static let submitFormFunction = """
        function () {
          var form = this.tagName === "FORM" ? this : (this.form || this.closest("form"));
          if (!form) { return "no-form"; }
          if (typeof form.requestSubmit === "function") { form.requestSubmit(); }
          else { form.submit(); }
          return "submitted";
        }
        """

    // MARK: - Wording (never decisions)

    /// **The floor's fail-closed sentence.** Reached when the inspection failed or produced nothing
    /// readable — which is a refusal, never a pass. Worded so a model does not read it as a
    /// transient fault worth retrying into.
    static let floorInspectionFailed =
        "refused: Norma could not inspect that field, and it never types into a field it could not "
        + "check — the check is what keeps a password or payment field from being filled in "
        + "unattended. Nothing was typed."

    private static let noVisibleBox =
        "that element has no visible box on the page — it may be hidden, collapsed, or not laid out"

    private static func scrolledBy(deltaX: Double, deltaY: Double) -> String {
        if deltaY != 0 { return "scrolled \(deltaY > 0 ? "down" : "up") \(Int(abs(deltaY)))px" }
        return "scrolled \(deltaX > 0 ? "right" : "left") \(Int(abs(deltaX)))px"
    }

    /// Name a field the way a person reading the transcript would — `<input name="q">` — so the
    /// success line says WHAT was typed into and not merely that something was.
    ///
    /// **Both halves are page-controlled and both are briefed** (fix round 1). The attribute value
    /// always was; `tagName` is `DOM.describeNode`'s `nodeName`, which for a custom element is
    /// whatever the page called it and has no length bound anywhere on the path. `answer`'s cap
    /// would now keep an unbriefed one from killing the frame, but a 70 KB tag name that survives to
    /// be cut is still a garbage message — the cap makes it deliverable, `brief` makes it readable.
    private static func describe(_ field: SensitiveFieldFloor.Field) -> String {
        for attribute in ["name", "id", "aria-label", "placeholder"] {
            if let value = field.attributes[attribute], !value.isEmpty {
                return "<\(brief(field.tagName)) \(attribute)=\"\(brief(value))\">"
            }
        }
        return "<\(brief(field.tagName))>"
    }

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
    ///
    /// `max` exists because fix round 1 gave this a second kind of caller: a whole SENTENCE from the
    /// browser (a CDP error, which can carry a page-thrown exception's text). An identifier cut at
    /// 120 is still recognisable; a sentence cut at 120 usually is not, so quoted prose gets
    /// `quotedReasonMaxLength`. Neither is a wire cap — `answer` owns that.
    private static func brief(_ value: String, max limit: Int = quotedIdentifierMaxLength) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(limit)) + "…"
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

    /// `Runtime.evaluate` / `Runtime.callFunctionOn`'s returned VALUE, whatever its JSON type.
    ///
    /// `exceptionDetails` beside it means the expression THREW — a page that redefines
    /// `document.body`, a CSP that blocks evaluation — and CEF still reports the call as a SUCCESS,
    /// because the protocol method itself worked. Treating that as a value would hand the model
    /// `nil` dressed up as an answer.
    ///
    /// Both methods answer in the same shape (a `RemoteObject` under `result`), which is why one
    /// reader serves the page text, the wait probe and the two `callFunctionOn` literals.
    static func evaluatedValue(fromResultJSON json: String) -> Any? {
        guard let root = object(json) else { return nil }
        guard root["exceptionDetails"] == nil else { return nil }
        guard let result = root["result"] as? [String: Any] else { return nil }
        return result["value"]
    }

    /// `Runtime.evaluate`'s answer when a STRING is what was asked for:
    /// `{"result":{"type":"string","value":"…"}}`.
    static func evaluatedString(fromResultJSON json: String) -> String? {
        evaluatedValue(fromResultJSON: json) as? String
    }

    /// `DOM.getDocument`'s answer: `{"root":{"nodeId":1,…}}`. The id every `DOM.querySelector` in
    /// this file is rooted at.
    static func rootNodeId(fromResultJSON json: String) -> Int? {
        guard let root = object(json), let node = root["root"] as? [String: Any] else { return nil }
        return node["nodeId"] as? Int
    }

    /// `DOM.querySelector`'s answer: `{"nodeId":n}`, where **`0` means nothing matched** — the
    /// protocol reports a miss as a valid reply with a zero id, not as an error, so a reader that
    /// only checked for `nil` would hand the rest of a verb an id that addresses no element.
    static func nodeId(fromResultJSON json: String) -> Int? {
        guard let root = object(json) else { return nil }
        return root["nodeId"] as? Int
    }

    /// **`DOM.describeNode`'s answer, turned into the floor's input.**
    ///
    /// `{"node":{"nodeName":"INPUT","attributes":["type","password","name","pw"]}}` — the attribute
    /// list is FLAT and alternating, name then value, which is the protocol's shape and the reason
    /// this reader exists rather than a dictionary decode.
    ///
    /// **`nil` is what makes the floor fail closed.** A payload with no node, or a node with no
    /// name, produces no `Field`, and `PanelCommandConsumer.typeText` turns that into a refusal. A
    /// node with a name and NO attributes is a perfectly readable answer (a bare `<input>` has
    /// none) and is not the same thing.
    static func describedField(fromResultJSON json: String) -> SensitiveFieldFloor.Field? {
        guard let root = object(json), let node = root["node"] as? [String: Any] else { return nil }
        guard let name = node["nodeName"] as? String, !name.isEmpty else { return nil }
        var attributes: [String: String] = [:]
        if let flat = node["attributes"] as? [String] {
            var index = 0
            while index + 1 < flat.count {
                attributes[flat[index]] = flat[index + 1]
                index += 2
            }
        }
        return SensitiveFieldFloor.Field(tagName: name, attributes: attributes)
    }

    /// `DOM.getBoxModel`'s answer, reduced to the point a pointer should be aimed at.
    ///
    /// `{"model":{"content":[x1,y1,x2,y2,x3,y3,x4,y4],"width":w,"height":h}}` — a QUAD, in CSS
    /// pixels relative to the viewport, which is the same coordinate space
    /// `Input.dispatchMouseEvent` reads. The centre is the mean of its four corners rather than
    /// `(x1+width/2, y1+height/2)`, because a transformed or rotated element's quad is not
    /// axis-aligned and the corner-plus-half-extent reading would aim outside it.
    ///
    /// A zero-area box is `nil`: an element that occupies no space cannot be clicked, and the
    /// protocol reports it as a success rather than an error.
    static func boxCentre(fromResultJSON json: String) -> CGPoint? {
        guard let root = object(json), let model = root["model"] as? [String: Any] else { return nil }
        guard let quad = model["content"] as? [Double], quad.count >= 8 else { return nil }
        let width = (model["width"] as? Double) ?? 0
        let height = (model["height"] as? Double) ?? 0
        guard width > 0, height > 0 else { return nil }
        let x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
        let y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
        return CGPoint(x: x, y: y)
    }

    /// `DOM.resolveNode`'s answer: `{"object":{"type":"object","subtype":"node","objectId":"…"}}`.
    /// The handle the two `Runtime.callFunctionOn` literals are run against.
    static func remoteObjectId(fromResultJSON json: String) -> String? {
        guard let root = object(json), let remote = root["object"] as? [String: Any] else { return nil }
        guard let objectId = remote["objectId"] as? String, !objectId.isEmpty else { return nil }
        return objectId
    }

    /// `PanelCommandConsumer.waitProbeScript`'s return value: `{ready, resources}`.
    static func waitProbe(fromResultJSON json: String) -> (ready: String, resources: Int)? {
        guard let value = evaluatedValue(fromResultJSON: json) as? [String: Any] else { return nil }
        guard let ready = value["ready"] as? String else { return nil }
        let resources = (value["resources"] as? Int) ?? Int((value["resources"] as? Double) ?? -1)
        return (ready, resources)
    }

    /// `Page.getLayoutMetrics`' viewport, in CSS pixels — the space `Input.dispatchMouseEvent`
    /// coordinates live in. `cssLayoutViewport` is the CSS-pixel one and is preferred; the two
    /// fallbacks are for a build that predates it (`layoutViewport` is device pixels on a scaled
    /// display, which would aim a wheel at the wrong point on a Retina Mac — hence the order).
    static func viewportSize(fromResultJSON json: String) -> CGSize? {
        guard let root = object(json) else { return nil }
        for key in ["cssLayoutViewport", "layoutViewport", "cssVisualViewport"] {
            guard let viewport = root[key] as? [String: Any] else { continue }
            let width = (viewport["clientWidth"] as? Double) ?? 0
            let height = (viewport["clientHeight"] as? Double) ?? 0
            if width > 0, height > 0 { return CGSize(width: width, height: height) }
        }
        return nil
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
