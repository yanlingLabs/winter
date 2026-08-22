import Foundation
import NormaProtocol

/// office-agent-tools T1/T3 (task-1-brief.md/task-3-brief.md; design
/// `docs/superpowers/specs/2026-08-22-office-agent-tools-design.md` §1, §2, §3, §6) — the office half
/// of the `panel_command` bridge B2 built for the browser tool (`PanelCommandConsumer.swift`'s own
/// header). T1 shipped this as a ROUTING SHELL where every verb answered a synchronous "not
/// implemented yet" refusal; T3 gives `sheets`' two READ verbs (`info`/`read`) real behaviour — the
/// FIRST verbs this file ever actually performs. Every other verb (`sheets`' write half, all of
/// `slides`/`docs`) is UNCHANGED from T1: still routed to `Self.refusal(for:)`, still synchronous,
/// still answered on this file's own single `sendResult` call — see that function's own doc, below,
/// for why nothing about its shape needed to change for two verbs to stop using it.
///
/// ## Why T1's "no `Call` latch" reasoning still holds for two ASYNCHRONOUS verbs
///
/// T1's header argued no deadline/latch machinery was owed because every verb answered
/// synchronously. `info`/`read` are genuinely asynchronous now (`await officeAgentBroker(...)
/// .perform(...)`), and still need none of `PanelCommandConsumer`'s `Call`/timer machinery — the
/// exactly-once guarantee stays structural for a different reason than T1's: each async handler below
/// is a straight-line `async` function with exactly one `sendResult` call on every exit path (success,
/// every catch branch), and each is reached from exactly one `Task { }` spawned once per command,
/// never raced against a second attempt the way `PanelCommandConsumer`'s multi-round-trip CDP verbs
/// are. No CLIENT-side deadline timer is armed either — the DAEMON's own `OFFICE_DEADLINES_MS`
/// (`packages/core/src/panel/office-commands.ts`) is the one clock this file relies on; if it fires
/// first, the daemon reports `{kind:"timeout"}` and this file's own eventual `sendResult` call (if the
/// broker call ever completes) simply lands on a `commandId` the daemon no longer has a pending entry
/// for — a documented, harmless no-op on that side (`PanelCommandRegistry.resolve`'s own `"dropped"`
/// case), not a double-answer.
///
/// **Narrow, disclosed residual T3 does not close**: unlike `PanelCommandConsumer.handle`'s own quit
/// beat guard (checked again by NOTHING inside a still-running CDP chain either, as far as this file's
/// own reading of that machinery goes), a `sheets info`/`read` `Task` already in flight when
/// `BrowserRuntime.quiesce()` begins is not re-checked before its own eventual `sendResult` fires —
/// this file has no `BrowserRuntime` reference to ask. The window is the same ~150ms beat T1's own
/// header names, and a socket write landing inside it is the SAME class of risk `PanelCommandConsumer`
/// itself already carries for any CDP round trip in flight at that instant; not a NEW hazard T3
/// introduces, but not one T3 closes either.
///
/// ## No verb list is mirrored here — and this is the evidence for T1's no-kit-tag claim
///
/// `PanelCommand.action` is a plain `String` (`SessionEvent.swift`), not a Swift enum, precisely so
/// growth on the TS producer's side needs no Swift change — B2's own growth from one verb to nine
/// already proved this ("this type deliberately did not have to change for it", that file's own
/// comment). `isOfficeAction` below tests a PREFIX, not a membership list, for the identical reason:
/// the wire ships 22 verbs today (`OFFICE_COMMAND_ACTIONS`, events.ts), and a later task that gives
/// one of them real behaviour needs only a new `case` in this file's `handle` switch — never a change
/// to what COUNTS as an office action, and never a Swift protocol-type change either. T3's own two new
/// verbs proved this AGAIN: no `packages/protocol` change, no NormaProtocol/NormaKit change — see the
/// task's own report for the kit-tag verdict.
///
/// ## The refusal string is bounded on purpose
///
/// `PanelCommandConsumer.answer` caps its outgoing `result` at the wire's own limit as a LAST
/// resort, because an over-cap `result` is REFUSED WHOLE by the daemon at `parseParams`, this app's
/// `try?` on the RPC send swallows that rejection, and the command then expires on its deadline —
/// silence, on exactly the message a refusal exists to deliver (that file's `answer` doc carries the
/// full incident this guards against). This consumer bypasses `answer()` entirely (it has no `Call`
/// to answer through), so it owns the same guarantee itself. T1's own refusal path never echoed
/// `args` at all — `info`/`read`'s real answers now DO carry model-influenced content (a sheet name,
/// a value grid), which is exactly why T3 enforces its own bound (`sheetsResultMaxLength`, below,
/// mirroring `PanelCommandConsumer.resultMaxLength`/`PanelURLPolicy.wireLength`'s UTF-16-code-unit
/// discipline) on every string this file builds from real document content, checked BEFORE
/// `sendResult` is ever called with it — refused, not silently truncated, so a caller is told the
/// truth about what happened rather than shown a quietly-clipped grid.
@MainActor
struct OfficeCommandConsumer {

    /// Structurally identical to `PanelCommandConsumer.ResultSender` — not imported from there on
    /// purpose. The two files answer through the same RPC but otherwise share no state, and a type
    /// alias costs nothing to redeclare while a shared import would couple two files that have
    /// nothing else to say to each other.
    typealias ResultSender = (_ sessionId: String, _ commandId: String, _ ok: Bool,
                              _ result: String?, _ imageBase64: String?) -> Void

    private let sendResult: ResultSender

    /// office-agent-tools T3 — the one door onto real office behaviour: `ShellSessionHost
    /// .officeAgentBroker`, injected as a closure (mirroring `sendResult`'s own `[weak host]` capture
    /// at the `AppDelegate` construction site) rather than a stored `ShellSessionHost` reference, for
    /// the identical reason `OfficeAgentBroker.Host` itself is closures-based: nothing host-shaped is
    /// safely constructible under XCTest. `nil` is a real, honest answer (the host deallocated between
    /// being asked and this closure running — the same pathological case `OfficeAgentBroker.Host`'s
    /// own doc names), not a force-unwrap away from a crash.
    private let officeAgentBroker: (_ sessionId: String) -> OfficeAgentBroker?

    init(sendResult: @escaping ResultSender,
         officeAgentBroker: @escaping (_ sessionId: String) -> OfficeAgentBroker? = { _ in nil }) {
        self.sendResult = sendResult
        self.officeAgentBroker = officeAgentBroker
    }

    /// Is this an office verb? Called by `PanelCommandConsumer.handle` to decide whether to route
    /// here at all — a PREFIX test, not a membership list, for the reason this file's header gives.
    static func isOfficeAction(_ action: String) -> Bool {
        action.hasPrefix("office.")
    }

    /// Route one office command. The entry point, and the only one this type needs.
    ///
    /// `sheets.info`/`sheets.read` are real now — dispatched onto their own `Task`, one per command,
    /// so `handle` itself stays synchronous and non-blocking exactly as it always has (a caller that
    /// wanted an `await`able `handle` would have to change `PanelCommandConsumer.handle`'s own call
    /// site too, which T3 does not touch). Every OTHER action — T1's entire refusal surface — is
    /// UNCHANGED: answered here, synchronously, with the same structured refusal as before.
    func handle(_ command: SessionEvent.PanelCommand) {
        switch command.action {
        case "office.sheets.info":
            Task { await handleSheetsInfo(command) }
        case "office.sheets.read":
            Task { await handleSheetsRead(command) }
        default:
            sendResult(command.sessionId, command.commandId, false,
                       Self.refusal(for: command.action), nil)
        }
    }

    // MARK: - office-agent-tools T3: sheets info/read

    /// How much of a REAL result (one built from actual document content, never T1's own static
    /// refusal prose) this file will ever hand to `sendResult`. Mirrors
    /// `PanelCommandConsumer.resultMaxLength` (64 KiB) exactly — the SAME wire cap, checked here for
    /// the SAME reason that file's own header gives: an over-cap `result` is refused WHOLE at the
    /// daemon, silently, past this app's own `try?`. `PanelDocumentTab.swift`'s
    /// `officeReadRangeMaxCells` already keeps an ordinary `read` far under this in practice (that
    /// file's own test measures it); this is the SECOND belt — the one that catches a real LOK answer
    /// this file did not anticipate (a formula longer than the "worst realistic case" the cap's own
    /// comment assumed, or a mechanism this task's own live drills found returns more than requested)
    /// — refusing rather than truncating, so a caller is told the truth rather than shown a silently
    /// clipped grid.
    private static let sheetsResultMaxLength = PanelCommandConsumer.resultMaxLength

    /// `office.sheets.info` — sheet names, each one's used range, and the active sheet.
    ///
    /// **`info` is ALSO the drivability probe** (spec §1/§3, mirroring `browser tabs`) — but the
    /// "app not running" half of that lives on the DAEMON side, not here: `sheets.ts`'s own reach
    /// check (mirroring `browser.ts`'s `panelReach`) refuses BEFORE ever dispatching a `panel_command`
    /// when no usable harness is attached, so this function only ever runs at all once the app IS
    /// known to be reachable. **The fence still has to win when BOTH would fire** — spec §5's "a probe
    /// outside the working dirs answers with the fence refusal, not the app-not-running one" is why
    /// `sheets.ts` checks its OWN fence BEFORE its reach check (see that file's own header): the
    /// daemon already knows the session's working directories without needing the app at all, so
    /// refusing an out-of-fence path never has to wait to learn whether the app is even running.
    private func handleSheetsInfo(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false,
                               Self.requiredPathRefusal, nil)
        }
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId in
                let (sheets, activeSheet) = try await runtime.sheetsInfo(docId: docId)
                return Self.formatSheetsInfo(path: path, sheets: sheets, activeSheet: activeSheet)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    /// `office.sheets.read` — a value or formula grid over one A1 range on one named sheet.
    ///
    /// **Operand validation — INCLUDING the range's own cell-count cap — runs entirely BEFORE the
    /// broker is ever reached**, deliberately: `officeParseRange`'s cap check
    /// (`officeReadRangeMaxCells`) is a pure function of the `range` string alone, so refusing an
    /// oversized range here costs nothing and, critically, never pays for a cold helper boot or an
    /// open/adopt round trip on a request that was always going to be refused. Skipping this and
    /// letting an oversized range reach the broker would trade a sub-second refusal for the exact
    /// silent-155s-timeout failure mode `officeReadRangeMaxCells`'s own header exists to prevent (an
    /// over-cap RESULT still gets refused at the wire, but only after doing all the work to produce
    /// one).
    private func handleSheetsRead(_ command: SessionEvent.PanelCommand) async {
        guard let path = Self.requiredPath(command.args) else {
            return sendResult(command.sessionId, command.commandId, false,
                               Self.requiredPathRefusal, nil)
        }
        guard let sheet = Self.requiredSheet(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredSheetRefusal, nil)
        }
        guard let rangeText = Self.requiredRangeText(command.args) else {
            return sendResult(command.sessionId, command.commandId, false, Self.requiredRangeRefusal, nil)
        }
        guard let range = officeParseRange(rangeText) else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(Self.brief(rangeText))\" is not a valid A1 range — examples: "
                                   + "\"A1\", \"A1:C10\".", nil)
        }
        guard range.cellCount <= officeReadRangeMaxCells else {
            return sendResult(command.sessionId, command.commandId, false,
                               "\"\(rangeText)\" spans \(range.cellCount) cells, past the "
                                   + "\(officeReadRangeMaxCells)-cell limit on one read — ask for a "
                                   + "smaller range.", nil)
        }
        let formulas = Self.optionalFormulas(command.args)
        let rangeString = "\(officeCellReference(column: range.startColumn, row: range.startRow)):"
            + officeCellReference(column: range.endColumn, row: range.endRow)
        guard let broker = officeAgentBroker(command.sessionId) else {
            return sendResult(command.sessionId, command.commandId, false, Self.hostGoneRefusal, nil)
        }
        do {
            let resultText = try await broker.perform(
                sessionId: command.sessionId, path: path, access: .read, requestId: command.commandId
            ) { runtime, docId in
                let rows = try await runtime.sheetsRead(docId: docId, sheet: sheet, range: rangeString, formulas: formulas)
                return Self.formatSheetsRead(sheet: sheet, range: rangeString, formulas: formulas, rows: rows)
            }
            let (ok, text) = Self.capped(resultText)
            sendResult(command.sessionId, command.commandId, ok, text, nil)
        } catch {
            sendResult(command.sessionId, command.commandId, false, Self.message(for: error), nil)
        }
    }

    // MARK: - office-agent-tools T3: operands (wire strictness — missing required, never defaulted)

    private static let requiredPathRefusal = "this office verb needs a `path`."
    private static let requiredSheetRefusal = "`sheets read` needs a `sheet` naming which sheet to read."
    private static let requiredRangeRefusal = "`sheets read` needs a `range` in A1 notation (examples: \"A1\", \"A1:C10\")."
    private static let hostGoneRefusal = "Norma's office runtime is no longer available."

    private static func requiredPath(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["path"], !raw.isEmpty else { return nil }
        return raw
    }
    private static func requiredSheet(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["sheet"], !raw.isEmpty else { return nil }
        return raw
    }
    private static func requiredRangeText(_ args: [String: SessionEvent.JSONValue]?) -> String? {
        guard case .string(let raw)? = args?["range"], !raw.isEmpty else { return nil }
        return raw
    }
    /// `formulas` is the ONE genuinely optional operand (spec §2's table: `formulas?`) — a missing or
    /// wrong-typed value defaults to `false` (values), never refused; this is the single deliberate
    /// exception to "missing required operand is malformed, never defaulted" because this operand was
    /// never required in the first place.
    private static func optionalFormulas(_ args: [String: SessionEvent.JSONValue]?) -> Bool {
        guard case .bool(let value)? = args?["formulas"] else { return false }
        return value
    }

    // MARK: - office-agent-tools T3: result formatting (the "smallest useful truth", spec §3.5)

    private static func formatSheetsInfo(path: String, sheets: [OfficeSheetInfo], activeSheet: String) -> String {
        let name = (path as NSString).lastPathComponent
        var lines = ["\(sheets.count) sheet\(sheets.count == 1 ? "" : "s") in \(name) (active: \"\(activeSheet)\"):"]
        for sheet in sheets {
            let usedRange: String
            if sheet.usedEndColumn < 0 || sheet.usedEndRow < 0 {
                usedRange = "empty"
            } else {
                usedRange = "A1:\(officeCellReference(column: sheet.usedEndColumn, row: sheet.usedEndRow))"
            }
            let activeMark = sheet.name == activeSheet ? " (active)" : ""
            lines.append("- \"\(sheet.name)\"\(activeMark): \(usedRange)")
        }
        return lines.joined(separator: "\n")
    }

    /// A plain TSV grid — `rows[r][c]` joined by tabs, rows joined by newlines — the SAME shape LOK's
    /// own `getTextSelection` speaks (`LOKBridge.selectionTextOnDedicatedThread`'s own header), passed
    /// through rather than re-encoded: a model reading this sees exactly the rectangle it asked for,
    /// row-major, with no reshaping this file could get wrong. An empty `rows` (the sheet had nothing
    /// in the requested range) still gets an honest header line, never a bare empty string a caller
    /// could mistake for a dropped result.
    private static func formatSheetsRead(sheet: String, range: String, formulas: Bool, rows: [[String]]) -> String {
        let header = "\(sheet)!\(range) (\(formulas ? "formulas" : "values")):"
        guard !rows.isEmpty else { return "\(header) (nothing in this range)" }
        let grid = rows.map { $0.joined(separator: "\t") }.joined(separator: "\n")
        return "\(header)\n\(grid)"
    }

    /// The final belt — `sheetsResultMaxLength`, checked in the wire's own UTF-16-code-unit unit
    /// (`PanelURLPolicy.wireLength`, the same measure `PanelCommandConsumer`'s own cap uses), never
    /// `String.count`. Returns `ok: false` when it fires — an over-cap answer is a REFUSAL, never sent
    /// as `ok: true` with swapped-in prose (that would tell the daemon a successful read produced this
    /// sentence as its own real content). Refuses rather than truncates: a silently clipped grid would
    /// be indistinguishable from a complete one to whatever reads this file's own result text.
    private static func capped(_ text: String) -> (ok: Bool, text: String) {
        guard PanelURLPolicy.wireLength(text) > sheetsResultMaxLength else { return (true, text) }
        return (false, "this read's own result would be \(PanelURLPolicy.wireLength(text)) characters, past "
                + "the \(sheetsResultMaxLength)-character wire limit — ask for a smaller range or narrower columns.")
    }

    /// One error, one sentence — never `"\(error)"` verbatim when a cleaner extraction exists.
    /// `OfficeAgentBrokerError.message` is already the ready-to-show sentence (fence refusal, dirty
    /// tab, open/save failure, all pre-mapped house voice per that enum's own doc).
    /// `OfficeHelperClientError.serverError`'s `reason` is unwrapped rather than using that enum's own
    /// `.description` — the description prepends "office helper refused: ", which is accurate but is
    /// this app's OWN internal framing, not something a model needs to see; the bare reason (composed
    /// entirely by `LOKBridge`'s own `SaveError` — never raw LibreOffice text, that enum's own header)
    /// is the whole sentence on its own. Anything else (a genuinely unexpected error shape) falls back
    /// to `"\(error)"` — still answered, never silence, matching this file's whole standing rule.
    private static func message(for error: Error) -> String {
        if let brokerError = error as? OfficeAgentBrokerError { return brokerError.message }
        if let clientError = error as? OfficeHelperClientError {
            switch clientError {
            case .serverError(let reason): return reason
            case .openFailed(let reason): return reason
            case .saveFailed(let reason): return reason
            case .timedOut, .unexpectedReply: return clientError.description
            }
        }
        return "\(error)"
    }

    // MARK: - Wording (T1's own refusal — every OTHER office verb still uses this, unchanged)

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
