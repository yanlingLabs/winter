import Foundation
import NormaProtocol

/// office-agent-tools T1 (task-1-brief.md; design
/// `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1, §6) — the office half of the
/// `panel_command` bridge B2 built for the browser tool (`PanelCommandConsumer.swift`'s own header).
/// **This file is a ROUTING SHELL, not a runtime**: every office verb it receives answers a
/// structured "not implemented yet" refusal, synchronously, never a throw and never silence — so the
/// bridge is proven end-to-end before a single `sheets`/`slides`/`docs` verb has real behaviour.
/// Later tasks give each verb its actual mechanics here, one `case` at a time; T1 exists precisely so
/// that work inherits a bridge already proven rather than having to build the bridge and the verbs at
/// once (spec §9's staging: "Protocol + bridge … then sheets … then slides … then docs").
///
/// ## Why this file has none of `PanelCommandConsumer`'s machinery
///
/// That file needs a `Call` latch, a deadline timer and CDP round-trip chaining because its verbs are
/// ASYNCHRONOUS — a browser command answers only after CEF replies, sometimes several round trips
/// later, and the deadline exists to bound that wait. Every verb THIS file answers is SYNCHRONOUS by
/// construction: nothing below calls into `OfficeRuntime` (there is nothing yet TO call — no verb has
/// behaviour), so `handle` always has its answer before it returns. One call, one send, no race to
/// latch against: the exactly-once guarantee is structural (a straight-line function with a single
/// `sendResult` call on every path) rather than a flag two closures have to share. The day a verb
/// here gets real, asynchronous behaviour, it earns its own deadline/latch machinery THEN — see
/// `OFFICE_DEADLINES_MS` (`packages/core/src/panel/office-commands.ts`) for the numbers already
/// reserved for that.
///
/// ## No verb list is mirrored here — and this is the evidence for T1's no-kit-tag claim
///
/// `PanelCommand.action` is a plain `String` (`SessionEvent.swift`), not a Swift enum, precisely so
/// growth on the TS producer's side needs no Swift change — B2's own growth from one verb to nine
/// already proved this ("this type deliberately did not have to change for it", that file's own
/// comment). `isOfficeAction` below tests a PREFIX, not a membership list, for the identical reason:
/// T1 ships 22 verbs on the wire today (`OFFICE_COMMAND_ACTIONS`, events.ts), and a later task that
/// gives one of them real behaviour needs only a new `case` in this file's `handle` switch — never a
/// change to what COUNTS as an office action, and never a Swift protocol-type change either.
///
/// ## The refusal string is bounded on purpose
///
/// `PanelCommandConsumer.answer` caps its outgoing `result` at the wire's own limit as a LAST
/// resort, because an over-cap `result` is REFUSED WHOLE by the daemon at `parseParams`, this app's
/// `try?` on the RPC send swallows that rejection, and the command then expires on its deadline —
/// silence, on exactly the message a refusal exists to deliver (that file's `answer` doc carries the
/// full incident this guards against). This consumer bypasses `answer()` entirely (it has no `Call`
/// to answer through), so it owns the same guarantee itself, by a simpler route: every string this
/// file can ever send is STATIC TEXT plus, at most, one `brief()`-ed identifier drawn from the
/// command's OWN fields (`action`) — never an `args` value. `args` is model-influenced by the time a
/// real tool builds it (`officeCommandArgs`'s own doc, office-commands.ts) and is of unbounded length
/// on the wire (`PANEL_COMMAND_ARGS_MAX_JSON_BYTES` bounds the whole object, not any one field) —
/// echoing one of its values into a message here would reopen exactly the hazard `answer()`'s cap
/// exists to close, one layer up from where that fix landed. Simplest fix: never echo it.
@MainActor
struct OfficeCommandConsumer {

    /// Structurally identical to `PanelCommandConsumer.ResultSender` — not imported from there on
    /// purpose. The two files answer through the same RPC but otherwise share no state, and a type
    /// alias costs nothing to redeclare while a shared import would couple two files that have
    /// nothing else to say to each other.
    typealias ResultSender = (_ sessionId: String, _ commandId: String, _ ok: Bool,
                              _ result: String?, _ imageBase64: String?) -> Void

    private let sendResult: ResultSender

    init(sendResult: @escaping ResultSender) {
        self.sendResult = sendResult
    }

    /// Is this an office verb? Called by `PanelCommandConsumer.handle` to decide whether to route
    /// here at all — a PREFIX test, not a membership list, for the reason this file's header gives.
    static func isOfficeAction(_ action: String) -> Bool {
        action.hasPrefix("office.")
    }

    /// Route one office command. The entry point, and the only one this type needs: every action
    /// `isOfficeAction` accepts is answered here, synchronously, with a structured refusal.
    ///
    /// Parses `action` into (kind, verb) ONLY to word the refusal — `office.sheets.read` becomes "the
    /// `sheets` tool's `read` verb"). A shape that does not parse (no verb the daemon actually sends
    /// today, but nothing here assumes the daemon is well-behaved) still gets a true, generic refusal
    /// rather than a crash: this function has no throwing path and no force-unwrap anywhere in it.
    func handle(_ command: SessionEvent.PanelCommand) {
        sendResult(command.sessionId, command.commandId, false,
                   Self.refusal(for: command.action), nil)
    }

    // MARK: - Wording (never decisions — every office verb is refused the same way today)

    private static func refusal(for action: String) -> String {
        let quoted = brief(action)
        guard let (kind, verb) = parse(action) else {
            // Any string with the `office.` prefix that does not otherwise parse — still answered,
            // never dropped (this file's whole point).
            return "the Mac app does not yet implement the office verb `\(quoted)` — Norma's office "
                + "tools (sheets/slides/docs) are still being built. Nothing was done."
        }
        return "the `\(brief(kind))` tool's `\(brief(verb))` verb is not implemented yet on this "
            + "build of Norma — Stage C's office tools (sheets/slides/docs) are still being built. "
            + "Nothing was read from or written to the document."
    }

    /// `office.<kind>.<verb>` → `(kind, verb)`. `verb` is everything after the second dot, joined
    /// back with `.` if it somehow contained one — deliberately tolerant, since this is wording, not
    /// validation (`isOfficeAction`'s prefix check is the only gate that matters here).
    private static func parse(_ action: String) -> (kind: String, verb: String)? {
        let parts = action.split(separator: ".", maxSplits: 2)
        guard parts.count == 3, parts[0] == "office" else { return nil }
        return (String(parts[1]), String(parts[2]))
    }

    /// How much of an identifier a refusal may quote. Mirrors
    /// `PanelCommandConsumer.quotedIdentifierMaxLength` (120) — this file has no `answer()`
    /// last-resort cap to fall back on if it guessed wrong, so this bound is the ONLY thing standing
    /// between an absurd `action` string and an over-cap `result`. `action` decodes as a plain
    /// `String` with no length bound of its own (`SessionEvent.swift`), so a well-behaved daemon
    /// sending one of the 22 known verbs never comes close to this limit — it exists for the case
    /// where the daemon is not well-behaved, the same defensive posture
    /// `PanelCommandConsumer.handle`'s own `default:` branch takes on `command.action`.
    private static func brief(_ value: String, max limit: Int = 120) -> String {
        guard value.count > limit else { return value }
        return String(value.prefix(limit)) + "…"
    }
}
