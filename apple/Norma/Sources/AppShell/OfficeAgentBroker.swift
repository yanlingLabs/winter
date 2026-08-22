import Foundation
import Combine
import NormaKit

// MARK: - office-agent-tools Task 2: the document broker

/// **The single app-side door every agent office verb goes through.** Task 1 built the wire and a
/// routing shell that refuses every verb (`OfficeCommandConsumer`); this is what a real verb — task
/// 3's `sheets`, then `slides`, then `docs` — will stand on. Nothing after this task re-derives how a
/// document gets opened, fenced, saved, or protected: those five rules live HERE, once, and every
/// future verb calls `perform(...)` rather than reaching for `OfficeRuntime` directly.
///
/// **REUSES Stage B's own machinery — does not build a second path to LOK.** Staging
/// (`OfficeRuntime.stageDocument`), `placeAtomically`, the save waiters (`saveAndAwaitOutcome`),
/// `officeDocumentIsDirty`, the read-only-format predicate, and the request queue's no-nesting rule
/// are all `OfficeRuntime`'s own, called through its existing public doors (`open`/`close`/
/// `saveAndAwaitOutcome`) — this file adds no new call into the helper, no new LOK call, and no
/// change to `OfficeRuntime.swift` at all. The one genuinely new piece of machinery is
/// `awaitOpen(_:path:)` below, a bridge over `open`'s existing fire-and-forget contract (see its own
/// header for why that has to live here rather than as a new `OfficeRuntime` method).
///
/// **The five rules, briefly — each one's own reasoning lives at its call site in `runOnce` below:**
/// 1. Adopt or open (`runOnce`'s branch on `existingRuntime(sessionId)`).
/// 2. Close only what you opened (`runOnce`'s `defer`, gated on `!adopted`).
/// 3. Dirty refusal, write-only, adopted-only (`runOnce`'s `officeDocumentIsDirty` check).
/// 4. Save-through with a real awaited outcome (`runOnce`'s `saveAndAwaitOutcome` switch).
/// 5. Fence (`officeAgentResolvedPathWithinFence`, checked before anything else runs).
///
/// ## The double-mutation story: option (a), an idempotency token, memoizing the WHOLE outcome
///
/// The task's own hard requirement: a timeout can never honestly mean "it did not happen" (the app
/// may still be mid-`stageDocument`/queued behind unrelated FIFO work/mid-`placeAtomically` when the
/// daemon's deadline fires), so a non-idempotent write (`insert_rows`, `append`, `add_slide`) must
/// never be double-applied when the agent retries. This broker's answer is a caller-supplied
/// `requestId`: `perform(...)` memoizes its ENTIRE outcome — success or any refusal — keyed by that
/// token, and a repeat of the same token returns the FIRST attempt's outcome without touching
/// `OfficeRuntime` a second time.
///
/// **Memoizing an in-flight `Task`, not a completed `Result`, is the load-bearing detail.** The
/// canonical retry this guards against arrives WHILE attempt 1 is still running (that is exactly why
/// the daemon's deadline fired — the app was genuinely still working), so a cache that is only
/// populated on completion would still race: the retry would find nothing cached yet and launch a
/// second `open`+action+save concurrently with the first, the exact double-apply this exists to
/// prevent. Caching the `Task` itself closes that: `perform` checks-and-inserts into `inFlight` in
/// one synchronous stretch (this class is `@MainActor`; nothing can observe the dictionary between
/// the check and the insert), so a same-token call arriving at any point — before, during, or after
/// attempt 1 — joins the SAME task and gets the SAME outcome. An already-finished `Task` resolves an
/// `await` immediately with its stored result, which is what makes "the whole outcome, refusals
/// included" fall out of this one structure for free, with no separate completed-outcome cache to
/// keep in sync with it. See `OfficeAgentBrokerTests.testReplayJoinsAnInFlightAttemptRatherThanRe
/// RunningTheAction` for the concurrent-replay proof — a sequential-only replay test would pass on
/// the broken (completed-outcome-only) design just as easily as on this one, which is why that test
/// gates attempt 1 mid-ACTION and starts attempt 2 while attempt 1 is still blocked there.
///
/// **The token's contract, for whoever wires a real verb's `requestId` (task 3+): mint one per
/// LOGICAL attempt, and reuse it ONLY across a blind retry of that exact same attempt.** A token
/// derived purely from the verb's own operands (a hash of path+range+values, say) would make a
/// REFUSAL sticky forever — a dirty-refusal replayed verbatim even after the user saves the tab,
/// because the memo never expires and never re-checks. The token has to come from the CALL, not from
/// what the call contains.
@MainActor
final class OfficeAgentBroker {

    /// Read vs write — governs exactly two things: whether the dirty check (rule 3) applies to an
    /// adopted document, and whether save-through (rule 4) runs at all. Everything else (fence,
    /// adopt-or-open, close-only-what-you-opened) applies identically to both.
    enum Access: Equatable {
        case read
        case write
    }

    /// The narrow doors this broker needs from `ShellSessionHost` — injected, not a stored
    /// `ShellSessionHost` reference, mirroring `OfficeRuntime.Driver`'s own reasoning (that type's
    /// own header: "nothing helper-shaped is safely constructible under XCTest"): a broker's own
    /// orchestration logic has to be testable without a real host, a real supervisor, or a real
    /// session directory.
    ///
    /// **`existingRuntime` is what makes "never mint a runtime just to read" possible.** `runOnce`
    /// below asks this door FIRST, always — the minting door (`runtime`) is reached only once the
    /// broker has already decided, from `existingRuntime`'s answer, that a genuine open is needed
    /// (rule 1's "otherwise" branch). A read verb for a path some OTHER part of the app already has
    /// open costs this file exactly one dictionary lookup; a read verb for a path nothing has
    /// touched yet still has to mint (there is no other way to read a document LOK has never loaded),
    /// but it does so having asked, not assumed.
    ///
    /// Both runtime doors return `OfficeRuntime?` — including `runtime`, which in production never
    /// actually answers `nil` (`ShellSessionHost.officeRuntime(for:)` always mints). The optional
    /// exists for the one pathological case a `[weak self]`-captured closure has to admit: the host
    /// deallocating between this broker being asked and the closure running. `.hostGone` is that
    /// case's honest answer, not a force-unwrap.
    struct Host {
        var existingRuntime: (_ sessionId: String) -> OfficeRuntime?
        var runtime: (_ sessionId: String) -> OfficeRuntime?
        /// The session's working directories, exactly as `SessionSummary.dirs` carries them —
        /// `nil` (no working-directory concept for this session) and `[]` (a genuinely
        /// workdir-less session) are both real, distinct answers, never conflated. See
        /// `officeAgentResolvedPathWithinFence`'s own header for what each means to the fence.
        var workingDirectories: (_ sessionId: String) -> [SessionDirEntry]?
    }

    private let host: Host

    /// Rule-owning cache: keyed by the CALLER's idempotency token, never by path or session — see
    /// this type's own header for why a `Task`, not a `Result`.
    private var inFlight: [String: Task<String, Error>] = [:]

    init(host: Host) {
        self.host = host
    }

    /// The one door. `action` is the verb's own mechanics (task 3+'s job) — whatever it does to
    /// `runtime`/`docId` between adoption/opening and save-through. It receives the ALREADY-RESOLVED
    /// absolute path's own runtime and docId, never a raw path to re-resolve: every fence/adopt
    /// decision has already been made by the time it runs.
    ///
    /// Returns the verb's own "smallest useful truth" (design spec §3.5) as a plain `String` — the
    /// shape the wire already speaks (`OfficeCommandConsumer`'s own `result: String?`) — rather than
    /// a generic `T`, so there is no type-erased cache to build and no unsafe downcast on replay.
    func perform(
        sessionId: String,
        path: String,
        access: Access,
        requestId: String,
        action: @escaping (_ runtime: OfficeRuntime, _ docId: String) async throws -> String
    ) async throws -> String {
        if let existing = inFlight[requestId] {
            return try await existing.value
        }
        let host = self.host
        let task = Task<String, Error> { @MainActor in
            try await OfficeAgentBroker.runOnce(host: host, sessionId: sessionId, path: path,
                                                access: access, action: action)
        }
        inFlight[requestId] = task
        return try await task.value
    }

    /// One real attempt — everything `perform` memoizes. `static` and given only what it needs
    /// (never `self`), so replaying it is provably just "run this again with the same inputs," not
    /// something that could accidentally read broker state a second attempt shouldn't see.
    private static func runOnce(
        host: Host, sessionId: String, path: String, access: Access,
        action: @escaping (_ runtime: OfficeRuntime, _ docId: String) async throws -> String
    ) async throws -> String {
        // Rule 5 — fence, before anything opens. `resolvedPath` (never the raw `path`) is what every
        // later step acts on; `path` survives only to word the refusal the way `resolveWithinAny`
        // itself would (the original, possibly-relative argument, not what it would have resolved to).
        guard let resolvedPath = officeAgentResolvedPathWithinFence(
            path, dirs: host.workingDirectories(sessionId)) else {
            throw OfficeAgentBrokerError.outOfFence(path: path)
        }

        // Rule 1 — adopt or open. `existingRuntime` first, always (this type's own header, "never
        // mint just to read"); `runtime` (the minting door) is reached only in the `else`.
        let runtime: OfficeRuntime
        let docId: String
        let adopted: Bool
        if let existing = host.existingRuntime(sessionId),
           let entry = existing.stateSnapshot.documents[resolvedPath] {
            runtime = existing
            docId = entry.docId
            adopted = true
            // Rule 3 — dirty refusal, write-only, adopted-only. A document THIS call opens fresh a
            // few lines below can never be dirty yet (LOK just loaded it) — the check only makes
            // sense, and only runs, on a document someone else already has open. Reads proceed
            // regardless: they read the in-memory state, which is what the user's own tab shows.
            if access == .write, officeDocumentIsDirty(state: existing.stateSnapshot, path: resolvedPath) {
                throw OfficeAgentBrokerError.documentDirty(path: resolvedPath)
            }
        } else {
            guard let opened = host.runtime(sessionId) else {
                throw OfficeAgentBrokerError.hostGone
            }
            runtime = opened
            docId = try await awaitOpen(opened, path: resolvedPath)
            adopted = false
        }

        // Rule 2 — close only what you opened. Runs on EVERY exit from here down (action throws,
        // save fails, or plain success) because `defer` does not distinguish — which is exactly
        // right: whatever happened, a document this call opened must not be left dangling open with
        // no tab watching it, and a document this call merely adopted must never be closed out from
        // under the tab that owns it.
        defer {
            if !adopted { runtime.close(resolvedPath) }
        }

        let result = try await action(runtime, docId)

        guard access == .write else { return result }

        // Rule 4 — save-through, and the outcome is AWAITED for real (`saveAndAwaitOutcome`, not the
        // fire-and-forget `save`) — Stage B's own C1 lesson, restated for an agent caller instead of
        // the close sheet: a failed place must surface as this verb's own failure, never as success,
        // and it must leave the document dirty for whoever looks next (`OfficeRuntime`'s own
        // `saveFailedPendingSave` already guarantees the second half; this is what makes the FIRST
        // half — the caller actually being told — true for the agent's own tool result too).
        switch await runtime.saveAndAwaitOutcome(resolvedPath) {
        case .saved:
            return result
        case .failed(let reason):
            throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason: reason)
        case .noModel:
            if officeDocumentIsReadOnlyFormat(path: resolvedPath) {
                throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason:
                    "this format can't be saved by Norma's office tools — only ODF and Office Open "
                    + "XML formats are writable.")
            }
            throw OfficeAgentBrokerError.saveFailed(path: resolvedPath, reason:
                "there was no open document to save.")
        }
    }

    /// **The one genuinely new piece of machinery this task adds.** `OfficeRuntime.open(_:)` is
    /// documented fire-and-forget ("never sequence off this call returning — observe `state`/
    /// `stateSnapshot` instead"), which is right for its existing callers (a tab publishes `$state`
    /// and repaints whenever it changes) but wrong for a broker that needs a `docId` in hand before
    /// it can run a verb. This bridges the two without touching `OfficeRuntime.swift`: `open` and
    /// `$state` are both already externally readable (`PanelDocumentTabModel.refresh` sinks the
    /// identical publisher from a different file), so the bridge lives entirely on this side of that
    /// public surface.
    ///
    /// **Order is load-bearing: `open(path)` first, subscribe second.** `@Published` replays its
    /// CURRENT value to a new subscriber immediately, synchronously, on subscription. Subscribing
    /// FIRST would let that replay observe a STALE `openFailures[path]` left over from some earlier,
    /// unrelated attempt at this path, resolving this bridge as failed before this call's own `open`
    /// has even dispatched. Calling `open` first is race-free specifically because `.openRequested`'s
    /// reducer arm clears `openFailures[path]` as its very first line, SYNCHRONOUSLY, before this
    /// function ever subscribes — and the async half (the actual reply, success or failure) requires
    /// at least one task hop to land, which cannot happen inside this function's own synchronous
    /// open-then-subscribe stretch. So the first value this subscription ever sees already reflects
    /// the cleared state, never the stale one.
    ///
    /// **Every terminal condition, not just the two obvious ones.** `documents[path]` appearing and
    /// `openFailures[path]` appearing are the two paths `OfficeRuntimeReducer.openFailed`/`.opened`
    /// write for THIS path specifically — but two whole-runtime events drop a pending open WITHOUT
    /// ever writing either: `.helperDied`/`.helperUnavailable` reset to a fresh `OfficeRuntimeState`
    /// with `phase = .failed` and an EMPTY `openFailures` (the crash/never-came-up case has nothing
    /// per-path left to write into), and `teardown()` resets to a fresh state with `phase = .idle`.
    /// Without watching for both, a death or a teardown that lands while this bridge is waiting would
    /// hang it forever — and with `perform`'s in-flight `Task` cache, a same-token retry would then
    /// await that same permanently-hung task forever too. `phase == .idle` can only be a POST-call
    /// regression here (calling `open` synchronously advances `.idle`/`.failed` to `.starting` before
    /// this function ever subscribes), so seeing it again mid-wait is unambiguous.
    private static func awaitOpen(_ runtime: OfficeRuntime, path: String) async throws -> String {
        runtime.open(path)
        return try await withCheckedThrowingContinuation { continuation in
            var resolved = false
            var cancellable: AnyCancellable?
            cancellable = runtime.$state.sink { state in
                guard !resolved else { return }
                if let entry = state.documents[path] {
                    resolved = true
                    continuation.resume(returning: entry.docId)
                } else if let reason = state.openFailures[path] {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(path: path, reason: reason))
                } else if state.phase == .failed {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(
                        path: path, reason: state.failureReason ?? "The office helper is unavailable."))
                } else if state.phase == .idle {
                    resolved = true
                    continuation.resume(throwing: OfficeAgentBrokerError.openFailed(
                        path: path, reason: "the office runtime was torn down before the document could open."))
                } else {
                    return // .starting / .ready with no per-path answer yet: still genuinely in flight.
                }
                cancellable?.cancel()
            }
        }
    }
}

// MARK: - Rule 5: the fence

/// PURE: rule 5's containment check. A Swift, app-side BACKSTOP behind the daemon's own fence
/// (`resolveWithinAny`, `packages/core/src/agent/paths.ts`) — not a replacement for it, and
/// deliberately narrower than that function's full `writableRoots` (which also folds in the
/// session's tmp/outputs directories, persisted per-project edit-path grants, and one-shot approval
/// grants — daemon-only state this app has no wire visibility into today). This checks exactly what
/// the brief names: "the session's working directories," i.e. `SessionSummary.dirs`, the one piece
/// of that broader set the app actually has. A legitimate write the daemon approved into one of those
/// OTHER roots would still refuse here — a known, disclosed scope limit (`task-2-report.md`), not a
/// bug, and no worse than the status quo: before this task, NO office write had any fence at all.
///
/// Mirrors `resolveWithinAny`'s semantics, not merely its message: a RELATIVE `path` resolves against
/// `dirs.first` (the primary), exactly as `resolveWithinAny` resolves against `roots[0]`; an ABSOLUTE
/// path is taken as-is. Containment is checked against EVERY entry in `dirs`, not just the primary —
/// a session's secondary/granted directories are equally in-fence, exactly as every one of TS's
/// `roots` is. Compared with a trailing separator (`root == target || target.hasPrefix(root + "/")`)
/// so `/x/proj-evil` can never match root `/x/proj`.
///
/// **Not symlink-hardened the way `resolveWithinAny` is** (`resolveLeafSymlinks`/`canonAncestor`) —
/// `NSString.standardizingPath` collapses `.`/`..` and resolves the FIRST symlink component it
/// contains, but does not walk a dangling-leaf symlink chain the way the TS original deliberately
/// does to close task-24's F4 hole. Acceptable for a backstop behind the daemon's own hardened check,
/// not for a lone gate — disclosed in `task-2-report.md`, not silently narrower than it looks.
///
/// `dirs == nil` (no working-directory concept for this session) and `dirs == []` (a genuinely
/// workdir-less session) both mean "nothing to be within" — every path refuses, mirroring
/// `resolveWithinAny`'s own `roots.length === 0` guard ("no allowed directories configured").
///
/// Returns the resolved absolute path on success (what every later step must act on — the caller's
/// raw, possibly-relative `path` is never itself a valid `OfficeRuntime` key), `nil` on refusal.
func officeAgentResolvedPathWithinFence(_ path: String, dirs: [SessionDirEntry]?) -> String? {
    guard let dirs, !dirs.isEmpty else { return nil }
    // Order preserved, unfiltered — `roots.first` has to mean the PRIMARY (`dirs[0]`), exactly as
    // `resolvedFilePath`'s own `row?.dirs?.first?.path` does. Filtering empties out before indexing
    // would silently promote a SECONDARY to "primary" whenever `dirs[0]` happens to be degenerate —
    // `resolvedFilePath` refuses to resolve at all in that case, and this mirrors it, not a filtered
    // reordering of it.
    let roots = dirs.map { ($0.path as NSString).standardizingPath }

    let target: String
    if path.hasPrefix("/") {
        target = (path as NSString).standardizingPath
    } else {
        guard let primary = roots.first, !primary.isEmpty else { return nil }
        target = ((primary as NSString).appendingPathComponent(path) as NSString).standardizingPath
    }

    for root in roots where !root.isEmpty && (target == root || target.hasPrefix(root + "/")) {
        return target
    }
    return nil
}

// MARK: - The broker's own refusals

/// Every way `OfficeAgentBroker.perform` can refuse or fail, each carrying enough to build the
/// ready-to-show sentence itself (`.message`) — callers (task 3+'s verbs, `OfficeCommandConsumer`
/// eventually) surface `.message` verbatim, the same "never re-derive wording" posture
/// `OfficeCommandConsumer`'s own refusal table already takes.
enum OfficeAgentBrokerError: Error, Equatable {
    /// Rule 5. Wording mirrors `resolveWithinAny`'s own thrown message verbatim (`path is outside
    /// the allowed directories: <path>`) — the brief's own instruction ("the same language `write`
    /// uses"), and `path` here is the CALLER's original argument, exactly as TS's own `p` is.
    case outOfFence(path: String)
    /// Rule 3.
    case documentDirty(path: String)
    /// Rule 1's "otherwise" branch failing. `reason` is ALREADY a mapped house-voice sentence
    /// (`OfficeRuntimeState.openFailures`/`.failureReason` are never raw LOK text — Stage B T9's own
    /// error table guarantees that at the source) — this case never re-maps it, only carries it.
    case openFailed(path: String, reason: String)
    /// Rule 4. Same "already mapped, never re-derived" posture as `.openFailed` for `SaveOutcome
    /// .failed`'s own reason; the `.noModel` case builds its own explanatory text at the call site
    /// since `SaveOutcome` itself carries no reason for that case.
    case saveFailed(path: String, reason: String)
    /// The host deallocated between being asked and the minting door running — see `Host`'s own doc.
    case hostGone

    var message: String {
        switch self {
        case .outOfFence(let path):
            return "path is outside the allowed directories: \(path)"
        case .documentDirty(let path):
            let name = (path as NSString).lastPathComponent
            return "\(name) has unsaved changes in an open tab — the agent will not overwrite them. "
                + "Save or discard the tab's edits first."
        case .openFailed(let path, let reason):
            return "Couldn't open \((path as NSString).lastPathComponent): \(reason)"
        case .saveFailed(let path, let reason):
            return "Couldn't save \((path as NSString).lastPathComponent): \(reason)"
        case .hostGone:
            return "Norma's office runtime is no longer available."
        }
    }
}
