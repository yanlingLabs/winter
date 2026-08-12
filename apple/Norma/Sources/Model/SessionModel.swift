import Foundation
import NormaProtocol
import NormaKit

struct TaskItem: Equatable {
    let id: String
    var subject: String
    var status: String
    /// The wire's present-tense task description ("Running tests") — dropped entirely until
    /// Task 2 (2e-i); carried straight off `event.task.activeForm`. Defaulted `nil` so existing
    /// `TaskItem(id:subject:status:)` call sites/tests compile unchanged.
    var activeForm: String? = nil
    /// `event.ts` (never a client clock — the reducer stays pure) the moment this task FIRST
    /// entered `in_progress`. Stamped once and preserved across later updates (including a
    /// repeated in_progress) so Task 3's elapsed timer has a stable start; `nil` for a task that
    /// has never been in_progress. Defaulted `nil` for the same compile-compat reason as above.
    var startedTs: Int? = nil
}

/// One live child thread (2e-ii) — lifecycle + ACTIVE-time spans only. Tokens are deliberately
/// absent: the window shows time, the CLI shows tokens (each side's reducer tracks only what it
/// displays — spec §2). All timestamps are daemon `event.ts` (reducer purity).
struct SubagentItem: Equatable {
    let threadId: String
    var agentType: String
    var label: String
    /// "queued" (spawned, waiting for a SubagentManager slot) → "working" → "done".
    var status: String
    var stopReason: String? = nil
    /// Banked sum of completed child-turn windows (ms).
    var activeMs: Int = 0
    /// event.ts of the open turn_started; nil when not currently working.
    var activeSince: Int? = nil
}

/// One child SESSION spawned by a dispatch session (Phase 7) — tracked via the mirrored
/// `child_update` events that land in the dispatch session's own stream (`session_spawn`/
/// `DispatchChildren` on the daemon side). Sibling to `SubagentItem` above (that one tracks
/// in-process child THREADS of the CURRENT turn; this tracks child SESSIONS, which outlive any
/// single turn and are never pruned wholesale on turn end — see `children`'s own doc on
/// `OrbSessionState` for the prune rule that DOES apply). `Identifiable` (not just `Equatable`,
/// unlike `PendingInteraction`) so `SessionsPane`/a future roster view can `ForEach` directly.
struct ChildItem: Equatable, Identifiable {
    let sessionId: String
    let title: String
    var status: String
    var id: String { sessionId }
}

/// One live/terminal workflow run (CC-parity phase 3, Track D Task D3) — folded from the 4
/// `workflow_*` SessionEvents (`workflowStarted`/`workflowProgress`/`workflowCompleted`/
/// `workflowFailed`, Task D1), exactly like `ChildItem` above folds `child_update`. Keyed by runId
/// in `OrbSessionState.workflowRuns` (a Dictionary — see that field's own doc for why, unlike
/// `children`'s ordered array). `status` mirrors NormaKit's `WorkflowRunView.status` wire
/// convention (a plain String — "running"/"completed"/"failed"; never "stopped", see the reducer's
/// own doc on `workflowStop`), not a Swift enum a future server status would fail to decode.
struct WorkflowRunState: Equatable, Identifiable {
    let runId: String
    var name: String?
    var status: String = "running"
    var phase: String?
    var log: String?
    var running: Int = 0
    var completed: Int = 0
    var total: Int = 0
    var result: String?
    var error: String?
    var id: String { runId }
}

/// A single outstanding human-in-the-loop interaction the daemon is waiting on — approval,
/// question, or plan — carrying the payload cards need to render (2d-iii task 1). Replaces the
/// old `pendingApprovalIds: Set<String>`, which tracked only callIds and dropped everything else
/// the wire event carried (toolName/summary/questions/plan). `Equatable` (not `Identifiable`) so
/// reducer tests can assert on values directly, same convention as `ActivityItem`/`TaskItem`.
enum PendingInteraction: Equatable {
    /// `reviewerReason` (phase 5e T5): additive, mirrors `SessionEvent.ApprovalRequested.reviewerReason`
    /// — set only when this escalation came from the safety reviewer, `nil` for an ask-policy card.
    /// `childSessionId` (Dispatch, Phase 7): additive, mirrors `SessionEvent.ApprovalRequested.childSessionId`
    /// — set only on the MIRRORED copy of a child session's approval living in the dispatch
    /// session's stream; `nil` for a native (non-relayed) approval.
    /// `options` (SP-approvals T6): additive, mirrors `SessionEvent.ApprovalRequested.options` — the
    /// daemon's allow-rule choices for this call (Task 5's `approvalOptionsFor`), `nil` for a card
    /// with none (an unclassified tool, a grant/worktree card, or a reviewer escalation — see that
    /// field's own doc). All three default `nil` so existing construction/pattern-match call sites
    /// written before any of them existed stay untouched.
    case approval(callId: String, toolName: String, summary: String, reviewerReason: String? = nil, childSessionId: String? = nil, options: [SessionEvent.ApprovalOption]? = nil)
    case question(callId: String, questions: [SessionEvent.Question], childSessionId: String? = nil)
    case plan(callId: String, plan: String)

    var callId: String {
        switch self {
        case .approval(let callId, _, _, _, _, _): return callId
        case .question(let callId, _, _): return callId
        case .plan(let callId, _): return callId
        }
    }
}

/// One line of "what happened during this exchange" — tools run, task transitions, subagents
/// spawned/finished, worktree enters/exits, and interaction points (approvals/questions/plans).
/// Captured per-exchange by `SessionReducer.reduce` (2d-ii-a task 1) so the transcript can show
/// a turn's activity without re-deriving it from the flat event log; tasks 3/4 render these.
struct ActivityItem: Equatable {
    enum Kind: Equatable {
        /// `detail` (LIVE-GATE G3) is a short, tool-specific hint extracted from the tool call's
        /// `argsJson` by `SessionReducer.extractToolDetail` — the bash command's first line, a
        /// task subject, or a file path/pattern, depending on `name`. `nil` for tools with no
        /// recognized detail field, or when `argsJson` fails to parse (defensive: malformed/
        /// missing JSON never throws, it just yields no detail). Consumed by the transcript's
        /// grouped tool rows (`groupActivity`/`toolGroupLabel` in ChatContent) for the expandable
        /// per-call detail lines — never by `activityGlyphAndLabel`'s single-item fallback path.
        ///
        /// `callId`/`output`/`isError` (mac-chat-parity Task 1) carry the tool's RESULT, which the
        /// reducer used to throw away entirely — `tool_result` folded to a status flip and nothing
        /// else, so no view could ever show what a tool did or whether it failed. `callId` is the
        /// wire's `tool_call.callId`, the join key `foldToolResult` matches the later `tool_result`
        /// on; `output`/`isError` are that result. They stay at their defaults (`nil`/`false`) until
        /// it arrives, so `output == nil` is exactly "this call is still running". `output` is
        /// capped at `SessionReducer.maxToolOutputCharacters` — see that constant's own doc.
        /// All three are defaulted so every `.tool(name:detail:)` construction site written before
        /// they existed compiles and means the same thing; pattern matches must bind all five.
        case tool(name: String, detail: String?, callId: String? = nil, output: String? = nil, isError: Bool = false)
        case task(subject: String, status: String)
        case subagent(agentType: String)
        case subagentDone
        case worktree(entered: Bool, detail: String)
        case interaction(String)
    }
    var kind: Kind
}

extension ActivityItem {
    /// The `tool_call.callId` a `.tool` item was opened with — `nil` for every other kind, and for
    /// a `.tool` item constructed without one (the pre-Task-1 shape, still reachable from tests).
    /// This is the join key `SessionReducer.foldToolResult` searches on; it is deliberately an
    /// accessor rather than a stored field on `ActivityItem`, so that tool-only data stays on the
    /// tool case where a `.task`/`.worktree` item can't carry a meaningless one.
    var toolCallId: String? {
        if case .tool(_, _, let callId, _, _) = kind { return callId }
        return nil
    }
}

/// A user prompt paired with every assistant message its turn produced — the field's
/// inline-response shell (2c wave 2 task 3) reads `exchanges.last` instead of the flat `lastReply`
/// string so it can tell "no reply yet" (empty `reply`) apart from "no exchange at all" (empty
/// array), and so a later wave can render prior turns without re-deriving pairing from the flat
/// event log.
struct Exchange: Equatable {
    var prompt: String
    /// EVERY `assistant_message` this exchange's turn emitted, in arrival order (mac-chat-parity
    /// Task 1). The engine emits one PER ROUND, whenever the round produced text
    /// (`if (textBuf.length > 0)`, `packages/core/src/agent/engine.ts`) — this was a single
    /// `reply` string that each round OVERWROTE, so in any multi-round turn every intermediate
    /// round's prose was silently discarded before it reached the view. The transcript renders one
    /// row per entry, in order.
    var replies: [String] = []
    /// What happened while this exchange's turn ran (2d-ii-a task 1) — appended via
    /// `SessionReducer.appendActivity` (main-transcript events only; adjacent dupes collapse;
    /// capped at 200 drop-oldest). Defaulted so existing `Exchange(prompt:reply:)` call
    /// sites and equality-based tests are untouched.
    var activity: [ActivityItem] = []
    /// True when this exchange's turn ended with `stopReason == "aborted"` (Esc-interrupt) —
    /// the per-exchange sibling of the state-level `lastTurnAborted` flash flag.
    var aborted: Bool = false

    /// The LAST assistant message of this exchange, or `""` when none has arrived yet. This is
    /// what the SINGLE-BUBBLE surfaces read — `FieldStateAdapter.visibleResponse`,
    /// `GlassRootView.hasReadableReply`, `OrbWindowController`'s reveal gates — and it is the same
    /// value they read before `replies` existed, because the old stored `reply` was exactly
    /// "whatever the newest `assistant_message` overwrote it with". Their behaviour is therefore
    /// deliberately unchanged by Task 1; only the transcript, which reads `replies` in full, gains
    /// the intermediate rounds.
    var reply: String { replies.last ?? "" }

    /// The single-reply shape, which is what a one-round turn actually is — the common case in
    /// production and in nearly every test. `reply: ""` means "no reply yet" and produces NO entry
    /// (not an empty one), so `Exchange(prompt:reply:"")` still compares equal to a freshly-opened
    /// exchange the reducer built. Multi-reply state is built by appending to `replies`.
    init(prompt: String, reply: String, activity: [ActivityItem] = [], aborted: Bool = false) {
        self.prompt = prompt
        self.replies = reply.isEmpty ? [] : [reply]
        self.activity = activity
        self.aborted = aborted
    }
}

struct OrbSessionState: Equatable {
    var status: OrbStatus = .disconnected // until markConnected() — M2 contract
    var tasks: [TaskItem] = []
    /// Live child threads of the CURRENT main turn (2e-ii) — pruned wholesale when the main turn
    /// ends (children always finish first: the parent tool loop awaits the batch), so a replayed
    /// finished session correctly shows none.
    var subagents: [SubagentItem] = []
    /// Dispatch (Phase 7): child SESSIONS this dispatch session has spawned, upserted by
    /// `child_update` (see the reducer's explicit case below). UNLIKE `subagents` above, this is
    /// NOT pruned wholesale at turn end — a child session's lifecycle is independent of any single
    /// main-thread turn. Instead, a finished child (`status == "completed" || "error"`) is dropped
    /// on the NEXT main `turn_started` (subagent-roster precedent — see the CLI TUI's own
    /// `turn_started` prune of `state.agents`), so a completed child's status is still visible for
    /// at least the rest of the turn it finished in, but doesn't accumulate forever.
    var children: [ChildItem] = []
    /// CC-parity phase 3 (Workflows, Track D Task D3): live/terminal workflow runs, folded from
    /// `workflow_started`/`workflow_progress`/`workflow_completed`/`workflow_failed` (Task D1) —
    /// see `SessionReducer.reduce`'s explicit cases below. Keyed by `runId` (a Dictionary, not an
    /// ordered array like `children`): this fold is a pure O(1) upsert-by-runId with no ordering
    /// concerns of its own — the Dashboard's Workflows pane is what needs a stable display order,
    /// and it already has to merge this against `workflow.list`'s own snapshot (which carries
    /// `startedAt`, the thing worth ordering by) to show runs that started before the pane opened,
    /// so the ordering decision belongs there, not in this reducer. UNLIKE `children`, never
    /// pruned here — a workflow run has no "next turn_started" analog to prune on (these are
    /// `threadId: "main"` events with no per-turn lifecycle), and the daemon's own registry never
    /// prunes its run history either (workflows/registry.ts), so staying resident for the life of
    /// the session matches the source of truth.
    var workflowRuns: [String: WorkflowRunState] = [:]
    /// Ordered (oldest first), replay-rebuildable list of outstanding approvals/questions/plans —
    /// 2d-iii task 1. `*_requested`/`*_asked`/`*_presented` append (skipping a callId already
    /// present, so a replayed duplicate event is a no-op, not a second card); the matching
    /// `*_resolved` removes by callId; `turn_completed`/`agent_error` clear it entirely. Tasks
    /// 2-4 render this as the HITL cards; `status`'s `.approvalNeeded(count:)` is always
    /// `pendingInteractions.count`.
    var pendingInteractions: [PendingInteraction] = []
    var turnRunning = false
    var streamingText = ""
    var lastReply: String? = nil
    /// Ordered prompt/replies pairs, oldest first. `user_message(main)` appends a new exchange
    /// with no replies; `assistant_message(main)` APPENDS to the LAST exchange's `replies` (or, if
    /// no exchange exists yet, appends one with an empty prompt) — see `SessionReducer.reduce`.
    var exchanges: [Exchange] = []
    /// Wave-5 gate item 2: messages sent while a turn is already running go down `session.steer`
    /// — the daemon queues them and drains at the next round boundary, and the reducer folds each
    /// one into the current exchange's growing prompt ("↳ text", see the `.userMessage` case
    /// below) so the eventual reply lands on the exchange the user was actually looking at. That
    /// fold is silent from the UI's perspective though — nothing showed the user their message
    /// had actually been accepted and was waiting, not lost. This mirrors the fold 1:1 (appended
    /// in the same branch) so it's always in sync with what got folded, and clears whenever the
    /// turn the queued text was riding on ends — absorbed (`turnCompleted`) or died
    /// (`agentError`) — since a queued steer never survives past the turn it was queued for.
    var queuedSteers: [String] = []
    /// provider-correctness T6: the message of the `agent_error` that ENDED THE TURN THAT JUST RAN
    /// — set on a main-thread `agent_error`, cleared by the next `turn_started` and by any clean
    /// `turn_completed`. Nil at every other moment.
    ///
    /// Deliberately a "last turn" fact rather than a growing list, and that scoping is the whole
    /// point: the model/effort pickers use it to decide whether the selection the user just applied
    /// is what broke the turn, and a prior implementation of that idea SCANNED THE WHOLE TRANSCRIPT
    /// — which made a model unholdable forever after a single bad turn, surviving relaunch. One
    /// turn's message, overwritten by the next turn, cannot express that bug.
    var lastTurnError: String? = nil

    /// gate-feedback-1 FIX A: client names currently attached to this session, via
    /// `harness_attached`/`harness_detached` (previously ignored by the `default:` branch below).
    /// `harnessAttached` appends; `harnessDetached` removes ONE matching entry (first match, not
    /// "all matching") — this keeps a replay of the daemon's event log safe: a replayed
    /// attach/detach PAIR for the same clientName appends then removes, netting to exactly the
    /// same list a fresh live stream would produce, even if the same client name attaches twice
    /// concurrently (e.g. two `cli-chat` sessions) — each detach only cancels ONE of its own
    /// attaches, not every entry sharing that name.
    var attachedClients: [String] = []

    /// gate-feedback-1 FIX A: true when any attached client's name starts with "cli" (the CLI's
    /// `connect(name:)` call sites all pass names prefixed `cli-`, see `packages/cli/src/main.ts`
    /// — e.g. `cli-chat`/`cli-p`/`cli-send`). Drives the orb's terminal-chat auto-expand
    /// suppression (`GlassRootView.handleTurnCompleted()`/`isAutoRevealSuppressed`).
    var cliAttached: Bool {
        attachedClients.contains { $0.hasPrefix("cli") }
    }

    /// orb-scope Part 2: the `clientName` of the `user_message` that STARTED the most recently
    /// begun exchange — i.e. who initiated the turn that is currently running, or that just
    /// completed. Set on a genuine new-turn `userMessage` (`SessionReducer`'s "new exchange" branch
    /// below) whose `clientName` is a real originating surface/client, never one of the engine's own
    /// bookkeeping sentinels (`"steer"`, and — belt-and-braces — `"send_message"`/`"resume"`; see
    /// `isEngineSentinelClientName`'s doc). orb-scope review (Important 2) CORRECTION: a mid-turn
    /// steer does NOT reliably fold into the already-open exchange — the engine emits
    /// `assistant_message` PER ROUND (`packages/core/src/agent/engine.ts:2152`), so in any
    /// multi-round tool-using turn the current exchange's `reply` is already non-empty by the time a
    /// steer arrives, and the reducer's fold condition (`reply.isEmpty`) then takes the "new
    /// exchange" branch instead. What actually guarantees this field survives a mid-turn steer is
    /// the sentinel guard on the stamp itself, not the fold: a steer's clientName is always the
    /// engine's own `"steer"` sentinel (`engine.ts`'s `steer()`), which the guard refuses to stamp,
    /// so the field is simply left holding whatever it already held. Deliberately never cleared on
    /// `turn_completed` — it stays put as "the last known origin" until the NEXT turn's own
    /// genuine-origin user_message overwrites it, which is exactly the value
    /// `GlassRootView.handleTurnCompleted()` needs to read at the moment a turn just finished.
    /// Chosen over a local app-side flag (e.g. armed on `AppModel.sendOrSteer`, mirroring
    /// `OrbWindowController.collapseOnTurnStart`) because this is daemon-persisted, per-turn data:
    /// it survives a reconnect or an app relaunch mid-turn via the ordinary full-replay-from-seq-0
    /// path (`AppModel.refocus`), where an in-memory flag would simply be gone.
    var lastTurnOriginClientName: String? = nil

    /// True when the most recently started turn was submitted by THIS Mac app's own orb/field
    /// surface (`AppModel.ownClientName`) — false for a phone-relayed send (`"iphone-gateway"`,
    /// the Mac-side gateway's own harness identity, `RemoteHost.swift`), a scheduled routine
    /// (`"routine"`), a CLI harness, or any other origin. Drives
    /// `GlassRootView.handleTurnCompleted()`'s auto-reveal gate (orb-scope Part 2): a dispatch
    /// turn the user started somewhere else finishes quietly — the unread indicator is the only
    /// signal, no auto-expand.
    var lastTurnWasOrbInitiated: Bool {
        lastTurnOriginClientName == AppModel.ownClientName
    }

    /// Interrupt-feedback gate polish: true exactly when the MOST RECENT `turn_completed(main)`
    /// carried `stopReason == "aborted"` (an Esc-interrupt) — false for any other stop reason
    /// ("end_turn", tool-limit, etc.) and cleared back to false the instant the NEXT turn starts.
    /// This is pure reducer state (no timers, no view concerns) — `FieldStateAdapter` below is
    /// what turns a false→true transition into a transient, self-clearing UI flash; the reducer
    /// itself just tracks "was the last completed turn an interrupt," nothing more.
    var lastTurnAborted: Bool = false

    /// CC-style whimsical working verb for the current turn (wave 6 gate item 1) — e.g.
    /// "Reticulating", "Noodling" (see `WorkingVerbs`). The REDUCER never sets this (it must stay
    /// pure, no randomness) — `SessionModel.apply` rolls it right after `reduce` on
    /// `turnStarted(main)`, so it's stable for the whole turn and only re-rolled at the next one.
    /// Tests that drive `SessionReducer.reduce` directly (not through `SessionModel`) can set this
    /// field themselves to test composition without depending on randomness.
    var workingVerb: String = ""

    /// Wave-6 gate item 2: whether the pill's "☑ n/m" task-count suffix should show at all — ONLY
    /// while at least one task is actively `.in_progress`. A task list that exists but is idle
    /// (nothing in progress yet) or one where every task is already `.completed` shows the bare
    /// verb with no counts (the wave-4 batch-reset above already handles clearing a finished
    /// batch's counts once the NEXT run's first task arrives; this additionally hides the suffix
    /// for the current batch's own idle/tail-end moments).
    var hasActiveTask: Bool {
        tasks.contains { $0.status == "in_progress" }
    }

    var taskCounts: (done: Int, total: Int) {
        (tasks.filter { $0.status == "completed" }.count, tasks.count)
    }
}

/// PURE state derivation — every UI face (orb now; field/chat in 2c/2e) reads this.
enum SessionReducer {
    private static let mainThread = "main"

    /// Per-`tool_result` retention cap for `ActivityItem.Kind.tool`'s `output` (mac-chat-parity
    /// Task 1) — the reducer stores at most this many characters and appends a truncation marker.
    ///
    /// The daemon ALREADY truncates tool output at 64 KiB before it reaches any client (`MAX_OUTPUT`,
    /// `packages/core/src/agent/tools/registry.ts`); this is a second, app-side cap on top of that,
    /// and it exists because of what the Mac does with those events afterwards. This reducer's state
    /// is rebuilt by replaying a session's ENTIRE event log from seq 0 on every focus and every
    /// relaunch (`AppModel.refocus`), so storing results whole would keep every byte every tool in
    /// the session ever printed resident for as long as the session is open — and `appendActivity`'s
    /// 200-item cap bounds the item COUNT per exchange, not its bytes. Capping here rather than at
    /// render time is the only version that actually bounds memory: a renderer-side clip saves
    /// drawing work on a string that is already resident.
    ///
    /// 8 KiB is 8× under the daemon's own ceiling, so a realistic tool result survives whole and the
    /// cap only bites on the pathological ones — which nobody reads inside a transcript row anyway —
    /// while keeping one exchange's worst case (200 × 8 KiB) around 1.6 MiB. Internal rather than
    /// private so tests can pin the exact boundary instead of guessing at it, the same convention as
    /// `SessionModel.notificationFreshnessMs`.
    static let maxToolOutputCharacters = 8_192

    static func reduce(_ state: OrbSessionState, _ event: SessionEvent) -> OrbSessionState {
        var s = state
        switch event {
        case .harnessAttached(let v): // gate-feedback-1 FIX A — see `attachedClients`'s doc.
            s.attachedClients.append(v.clientName)
        case .harnessDetached(let v):
            if let i = s.attachedClients.firstIndex(of: v.clientName) {
                s.attachedClients.remove(at: i) // remove-first-match, see `attachedClients`'s doc
            }
        case .userMessage(let v) where v.threadId == mainThread:
            if s.turnRunning, let last = s.exchanges.indices.last, s.exchanges[last].reply.isEmpty {
                // Mid-turn steer: same turn, same exchange — the prompt grows (one turn = one exchange).
                s.exchanges[last].prompt += "\n↳ \(v.text)"
                // Wave-5 gate item 2: surface the queued message separately from the fold above
                // so the UI can show it as visibly "queued" rather than silently absorbed.
                s.queuedSteers.append(v.text)
            } else {
                s.exchanges.append(Exchange(prompt: v.text, reply: ""))
                // orb-scope Part 2 / Important-2 fix: a NEW exchange is exactly a new-turn start —
                // stamp who initiated it, UNLESS `clientName` is one of the engine's OWN bookkeeping
                // sentinels (never a real originating surface/client) — see
                // `isEngineSentinelClientName`'s doc for the reachability analysis of each one. When
                // guarded, `lastTurnOriginClientName` simply keeps whatever it already held (the
                // prior turn's origin, or `nil` pre-first-turn) — there is no honest value to stamp
                // from a sentinel, and guessing would be worse than staying put.
                if !isEngineSentinelClientName(v.clientName) {
                    s.lastTurnOriginClientName = v.clientName
                }
            }
        case .turnStarted(let v) where v.threadId == mainThread:
            s.turnRunning = true
            s.status = .thinking
            s.streamingText = ""
            s.lastTurnAborted = false // a fresh turn clears any prior interrupt flag
            s.lastTurnError = nil     // T6: and any prior turn's error — this one hasn't failed yet
            // Dispatch (Phase 7): prune finished children on the NEXT main turn — same cadence as
            // the CLI TUI's `state.agents` prune on `turn_started` (subagent-roster precedent).
            s.children.removeAll { $0.status == "completed" || $0.status == "error" }
        case .turnStarted(let v):
            // CHILD thread got a SubagentManager slot — the active timer starts here, not at
            // thread_started (queued-but-idle time must NOT count — spec §2).
            if let i = s.subagents.firstIndex(where: { $0.threadId == v.threadId }) {
                s.subagents[i].status = "working"
                s.subagents[i].activeSince = v.ts
            }
        case .toolCall(let v) where v.threadId == mainThread:
            if s.pendingInteractions.isEmpty { s.status = .toolRunning(name: v.name) }
            appendActivity(.tool(name: v.name, detail: extractToolDetail(name: v.name, argsJson: v.argsJson), callId: v.callId), to: &s)
        case .toolResult(let v) where v.threadId == mainThread:
            // The status flip is deliberately UNCONDITIONAL and comes first: it is the behaviour
            // this case has always had, and it must not become contingent on whether the fold
            // below finds an item to land on.
            if s.pendingInteractions.isEmpty { s.status = .thinking }
            foldToolResult(&s, callId: v.callId, output: v.output, isError: v.isError)
        case .approvalRequested(let v) where v.threadId == mainThread:
            appendPending(.approval(callId: v.callId, toolName: v.toolName, summary: v.summary, reviewerReason: v.reviewerReason, childSessionId: v.childSessionId, options: v.options), to: &s)
            appendActivity(.interaction(v.summary), to: &s)
        case .questionAsked(let v) where v.threadId == mainThread:
            appendPending(.question(callId: v.callId, questions: v.questions, childSessionId: v.childSessionId), to: &s)
            appendActivity(.interaction(v.questions.first?.question ?? "question"), to: &s)
        case .planPresented(let v) where v.threadId == mainThread:
            appendPending(.plan(callId: v.callId, plan: v.plan), to: &s)
            appendActivity(.interaction("plan presented"), to: &s)
        case .approvalResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .questionResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .planResolved(let v):
            s = resolvePending(s, callId: v.callId)
        case .childUpdate(let v):
            // Dispatch (Phase 7): upsert by childSessionId — a brand-new child appends, a known
            // one is replaced wholesale (title can change, e.g. once the daemon assigns one).
            // Pruning finished entries is the SEPARATE `turnStarted` rule above, not here — a
            // `completed`/`error` update still needs to land and be visible first.
            if let i = s.children.firstIndex(where: { $0.sessionId == v.childSessionId }) {
                s.children[i] = ChildItem(sessionId: v.childSessionId, title: v.title, status: v.status)
            } else {
                s.children.append(ChildItem(sessionId: v.childSessionId, title: v.title, status: v.status))
            }
        case .workflowStarted(let v):
            // CC-parity phase 3 (Track D Task D3): a fresh run always REPLACES wholesale, never
            // merges into a stale prior entry under the same runId — daemon runIds are fresh random
            // hex per launch (`wf_<hex>`, workflows/runtime.ts), so a repeat `_started` for one only
            // happens on a replayed duplicate, which should reset to a clean initial state exactly
            // like a genuinely new run would.
            s.workflowRuns[v.runId] = WorkflowRunState(runId: v.runId, name: v.name, status: "running")
        case .workflowProgress(let v):
            // `phase`/`log` are OPTIONAL per tick (WorkflowProgress's own doc, SessionEvent.swift:
            // "a progress tick may carry only updated counts") — only overwrite when THIS tick
            // actually carries a new one, so a counts-only tick can't blank out the last-seen
            // phase/log. `running`/`completed`/`total` are always present, so those overwrite
            // unconditionally.
            upsertWorkflowRun(&s, runId: v.runId) { run in
                if let phase = v.phase { run.phase = phase }
                if let log = v.log { run.log = log }
                run.running = v.running
                run.completed = v.completed
                run.total = v.total
            }
        case .workflowCompleted(let v):
            upsertWorkflowRun(&s, runId: v.runId) { run in
                run.status = "completed"
                run.result = v.resultSummary
            }
        case .workflowFailed(let v):
            upsertWorkflowRun(&s, runId: v.runId) { run in
                run.status = "failed"
                run.error = v.error
            }
        case .assistantDelta(let v) where v.threadId == mainThread:
            s.streamingText += v.delta
        case .assistantMessage(let v) where v.threadId == mainThread:
            s.lastReply = v.text
            s.streamingText = ""
            if s.exchanges.isEmpty {
                s.exchanges.append(Exchange(prompt: "", reply: v.text))
            } else if !v.text.isEmpty {
                // APPEND, never assign: the engine emits one assistant_message per ROUND, so
                // assigning discarded every round's prose but the last (see `Exchange.replies`).
                // Empty text is skipped rather than appended — the daemon only emits the event
                // when the round produced text (`if (textBuf.length > 0)`, engine.ts), so this is
                // defence against a second producer, and an empty entry would both draw a blank
                // transcript row and blank out `reply` for the surfaces that read it. It matches
                // `Exchange(prompt:reply:)`, which likewise maps an empty reply to no entry.
                s.exchanges[s.exchanges.count - 1].replies.append(v.text)
            }
        case .turnCompleted(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingInteractions = []
            s.streamingText = ""
            s.status = .idle
            s.lastTurnError = nil // T6: this turn ended without an agent_error
            s.queuedSteers = [] // the turn absorbed whatever was queued for it
            s.lastTurnAborted = (v.stopReason == "aborted") // Esc-interrupt feedback (gate polish)
            if v.stopReason == "aborted", !s.exchanges.isEmpty {
                // Per-exchange record of the interrupt (2d-ii-a task 1) — unlike the transient
                // lastTurnAborted flash above, this stays on the exchange for the transcript.
                s.exchanges[s.exchanges.count - 1].aborted = true
            }
            s.subagents = [] // 2e-ii prune: children always complete before the main turn does
        case .turnCompleted(let v):
            // CHILD turn window closed — bank the active span. Status stays "working" (alive)
            // until thread_completed; a next child turn would reopen a span.
            if let i = s.subagents.firstIndex(where: { $0.threadId == v.threadId }) {
                if let since = s.subagents[i].activeSince {
                    s.subagents[i].activeMs += max(0, v.ts - since)
                    s.subagents[i].activeSince = nil
                }
            }
        case .agentError(let v) where v.threadId == mainThread:
            s.turnRunning = false
            s.pendingInteractions = []
            s.streamingText = ""
            s.status = .idle
            s.lastTurnError = v.message // T6: the one signal the pickers' probation reads
            s.queuedSteers = [] // the turn died with whatever was queued for it
            if let last = s.exchanges.indices.last, s.exchanges[last].reply.isEmpty {
                s.exchanges[last].replies.append("⚠︎ \(v.message)")
            }
            s.subagents = [] // defensive prune — an errored main turn must not strand a live block
        case .taskUpdated(let v): // any thread — tasks are session-wide
            // T3 review fix wave 1: `status: "deleted"` is a TERMINAL removal, not an upsert —
            // packages/protocol's TaskSchema now has this value (events.ts), and
            // packages/core/src/agent/tools/tasks.ts's task_update deleted branch emits this
            // event right before the daemon's TaskStore actually drops the task. Handled FIRST,
            // before the pre-upsert/upsert/append logic below, so a deleted task can never
            // re-enter `s.tasks` via that path. Without this, the pinned task list (and this
            // orb pill) would phantom the deleted task forever — the daemon never sends a
            // follow-up event once a task is actually gone.
            if v.task.status == "deleted" {
                // `wasPresent` mirrors the upsert path's `previousStatus`-gated activity append
                // below (only append on an actual change) — a delete for an id already absent
                // (e.g. a duplicated/replayed event) removes nothing, so it logs nothing either.
                let wasPresent = s.tasks.contains(where: { $0.id == v.task.id })
                s.tasks.removeAll(where: { $0.id == v.task.id })
                if v.threadId == mainThread, wasPresent {
                    appendActivity(.task(subject: v.task.subject, status: v.task.status), to: &s)
                }
                break
            }
            // 2d-ii-a task 1: remember the PRE-upsert status so activity capture below can
            // append only when this event actually transitioned the task (nil = brand-new
            // task, which counts as a change). The helper's adjacent-dupe collapse is a
            // second net, not the primary dedupe.
            let previousStatus = s.tasks.first(where: { $0.id == v.task.id })?.status
            if let i = s.tasks.firstIndex(where: { $0.id == v.task.id }) {
                s.tasks[i].subject = v.task.subject
                s.tasks[i].status = v.task.status
                s.tasks[i].activeForm = v.task.activeForm
                // Task 2 (2e-i): stamp startedTs the moment this task FIRST enters in_progress —
                // previousStatus != "in_progress" covers both "was pending" and "was absent until
                // the branch above just wrote status" (previousStatus is read BEFORE this
                // mutation). A repeated in_progress update (previousStatus already "in_progress")
                // must NOT reset the timer, so startedTs is left untouched in that case —
                // event.ts only, never a client clock, keeps the reducer pure.
                if v.task.status == "in_progress", previousStatus != "in_progress" {
                    s.tasks[i].startedTs = v.ts
                }
            } else {
                // GATE-4 FIX (item 2 — "tasks never clear"): `v.task.id` not being in `s.tasks`
                // means the daemon just called `task_create`, never `task_update` (see
                // `packages/core/src/agent/tools/tasks.ts`: only `task_create` can mint a new
                // id; `task_update` 404s on an unknown one — `TaskStore.create`'s ids are a
                // monotonic session-wide counter, `String(m.size + 1)`, so they're never reused
                // either). An EXPLICIT deletion now removes its task on arrival (the `status ==
                // "deleted"` branch above, T3 review fix wave 1) — but a task that's simply never
                // been touched again still lingers in `s.tasks` by design, so session task
                // HISTORY is kept for CLI/replay purposes. That's correct for the CLI, but this
                // orb pill is a CURRENT-RUN indicator, not a session history view: upserting
                // forever into one flat array made `taskCounts` (done/total) accumulate across
                // every task list the session ever had, so completing one 3-task run and
                // starting a new one showed "☑ 4/6 working…" instead of "☑ 1/3 working…" — the
                // old, finished batch visually never went away.
                //
                // Fix, scoped entirely to this reducer (no daemon change needed — this predates
                // the "deleted" status and is orthogonal to it: an explicit delete removes ONE
                // task by id, this handles an entire finished BATCH aging out implicitly): a
                // brand-new task id arriving while the CURRENT list has nothing in_progress and every
                // existing task is already completed is exactly "the start of a new batch" —
                // there is no in-flight work the old entries could still be tracking. Clear the
                // finished batch before appending the new task, so the pill's counts reset to
                // just the new list. A new task id arriving mid-run (something still
                // pending/in_progress) is NOT a batch boundary and must NOT reset — the two
                // conditions below are individually sufficient (an all-completed list trivially
                // has nothing in_progress) but both are spelled out to match that reasoning
                // explicitly rather than relying on one to imply the other.
                if !s.tasks.isEmpty,
                   !s.tasks.contains(where: { $0.status == "in_progress" }),
                   s.tasks.allSatisfy({ $0.status == "completed" }) {
                    s.tasks.removeAll()
                }
                s.tasks.append(TaskItem(
                    id: v.task.id,
                    subject: v.task.subject,
                    status: v.task.status,
                    activeForm: v.task.activeForm,
                    // Brand-new task (previousStatus nil, i.e. "absent") — same "absent OR not
                    // already in_progress" rule as the upsert branch above.
                    startedTs: v.task.status == "in_progress" ? v.ts : nil
                ))
            }
            // Transcript activity is MAIN-thread only (child-thread task churn still upserts
            // above — tasks are session-wide — but must not pollute the main transcript).
            if v.threadId == mainThread, previousStatus != v.task.status {
                appendActivity(.task(subject: v.task.subject, status: v.task.status), to: &s)
            }
        case .worktreeEntered(let v) where v.threadId == mainThread:
            appendActivity(.worktree(entered: true, detail: v.branch), to: &s)
        case .worktreeExited(let v) where v.threadId == mainThread:
            appendActivity(.worktree(entered: false, detail: v.name), to: &s)
        case .threadStarted(let v):
            // Subagent lifecycle events carry CHILD threadIds by nature, so a main-thread guard
            // would drop all of them — yet they ARE main-transcript-relevant ("spawned an agent").
            // Guard on turnRunning instead: only capture while the main turn is actually going.
            if s.turnRunning { appendActivity(.subagent(agentType: v.agentType), to: &s) }
            // 2e-ii: live-list insert — dedupe by threadId (replay-safe).
            if !s.subagents.contains(where: { $0.threadId == v.threadId }) {
                s.subagents.append(SubagentItem(
                    threadId: v.threadId,
                    agentType: v.agentType,
                    label: subagentLabel(description: v.description, prompt: v.prompt),
                    status: "queued"
                ))
            }
        case .threadCompleted(let v):
            if s.turnRunning { appendActivity(.subagentDone, to: &s) }
            if let i = s.subagents.firstIndex(where: { $0.threadId == v.threadId }) {
                s.subagents[i].status = "done"
                s.subagents[i].stopReason = v.stopReason
                if let since = s.subagents[i].activeSince {
                    // Defensive: an aborted child can die without its own turn_completed.
                    s.subagents[i].activeMs += max(0, v.ts - since)
                    s.subagents[i].activeSince = nil
                }
            }
        default:
            break // messages/deltas/bg/checkpoint + child-thread events don't move state (harness
                  // attach/detach ARE now handled above — gate-feedback-1 FIX A)
        }
        return s
    }

    /// Appends a new pending interaction and re-derives `status`'s count — 2d-iii task 1. Replay
    /// dedupe: an `*_requested`/`*_asked`/`*_presented` event for a callId already in the list
    /// (the daemon replaying its event log from the top) is a no-op, not a second card — mirrors
    /// how `taskUpdated` above treats a re-seen id as an update rather than a duplicate.
    private static func appendPending(_ item: PendingInteraction, to state: inout OrbSessionState) {
        guard !state.pendingInteractions.contains(where: { $0.callId == item.callId }) else { return }
        state.pendingInteractions.append(item)
        state.status = .approvalNeeded(count: state.pendingInteractions.count)
    }

    /// CC-parity phase 3 (Workflows, Track D Task D3): get-or-insert-default then mutate, same
    /// upsert shape `childUpdate`'s inline `firstIndex`/replace-or-append pair expresses for an
    /// array — a Dictionary makes this a one-liner at each call site instead of three. Defensive
    /// against replay/attach-mid-stream (see `testProgressWithNoPriorStartedSynthesizesAnEntry`):
    /// `workflow_progress`/`_completed`/`_failed` arriving with no prior `workflow_started` for
    /// that runId still lands, rather than being silently dropped.
    private static func upsertWorkflowRun(_ state: inout OrbSessionState, runId: String, _ mutate: (inout WorkflowRunState) -> Void) {
        var run = state.workflowRuns[runId] ?? WorkflowRunState(runId: runId)
        mutate(&run)
        state.workflowRuns[runId] = run
    }

    /// Lands a `tool_result` on the `.tool` activity item its `callId` opened (mac-chat-parity
    /// Task 1). The reducer used to drop `output`/`isError` on the floor, which is why no Mac view
    /// could ever show what a tool did or that it failed.
    ///
    /// Scans EXCHANGES newest-first rather than only the last one, because a tool_call and its
    /// tool_result can straddle an exchange boundary: a main-thread steer's `user_message` is
    /// persisted at SEND time (`AgentEngine.steer`, `packages/core/src/agent/engine.ts`), so it can
    /// arrive between the two — and once the open exchange already holds a reply (any multi-round
    /// turn), the `userMessage` case above opens a NEW exchange for it. Searching only the last
    /// exchange would silently drop those results.
    ///
    /// Joins by `callId` rather than by position. The engine's tool loop happens to be serial today
    /// (`for (const call of calls)` — emit call, await, emit result), so the last-opened item would
    /// usually be right; the callId is what makes that an invariant of the data rather than a bet on
    /// the engine's loop shape. `lastIndex` because a callId identifies at most one call — unless a
    /// duplicated `tool_call` event appended twice (`.tool` is exempt from `appendActivity`'s
    /// adjacent-dupe collapse), in which case the newest copy is the one on screen.
    ///
    /// No match → no-op. That happens when the `tool_call` was dropped by `appendActivity`'s
    /// no-open-exchange guard (a tool call before any `user_message`); there is nothing to fold into,
    /// exactly as before this existed.
    private static func foldToolResult(_ state: inout OrbSessionState, callId: String, output: String, isError: Bool) {
        for e in state.exchanges.indices.reversed() {
            guard let i = state.exchanges[e].activity.lastIndex(where: { $0.toolCallId == callId }),
                  case .tool(let name, let detail, let itemCallId, _, _) = state.exchanges[e].activity[i].kind else {
                continue
            }
            state.exchanges[e].activity[i].kind = .tool(
                name: name,
                detail: detail,
                callId: itemCallId,
                output: capToolOutput(output),
                isError: isError
            )
            return
        }
    }

    /// Truncates one tool result to `maxToolOutputCharacters` and marks that it was truncated —
    /// see that constant's doc for why the cap lives in the reducer at all. An output of exactly
    /// the cap's length is kept whole with NO marker, so the marker always means "there was more".
    private static func capToolOutput(_ output: String) -> String {
        guard output.count > maxToolOutputCharacters else { return output }
        return String(output.prefix(maxToolOutputCharacters))
            + "\n[… truncated at \(maxToolOutputCharacters) characters]"
    }

    /// Appends to the exchange currently being built. Transcript capture is MAIN-thread only
    /// and defensive: no open exchange → drop. Adjacent duplicates collapse — EXCEPT `.tool`
    /// (LIVE-GATE G3): every tool call is now its own item, even back-to-back calls to the same
    /// tool, so the transcript can show an accurate per-call count/detail list (grouping into
    /// "Ran N shell commands" etc. is the VIEW's job, `groupActivity` in ChatContent, not the
    /// reducer's). Capped at 200 (drop-oldest) so a marathon turn can't balloon memory (spec §1).
    /// That cap bounds the item COUNT and nothing else — since mac-chat-parity Task 1 each `.tool`
    /// item can also hold its result's output, so the BYTES are bounded separately, by
    /// `maxToolOutputCharacters` (8 KiB × 200 ≈ 1.6 MiB worst case per exchange).
    private static func appendActivity(_ kind: ActivityItem.Kind, to state: inout OrbSessionState) {
        guard !state.exchanges.isEmpty else { return }
        let last = state.exchanges.count - 1
        if case .tool = kind {
            // no adjacent-dupe collapse — see doc comment above.
        } else if state.exchanges[last].activity.last?.kind == kind {
            return
        }
        state.exchanges[last].activity.append(ActivityItem(kind: kind))
        if state.exchanges[last].activity.count > 200 {
            state.exchanges[last].activity.removeFirst(state.exchanges[last].activity.count - 200)
        }
    }

    /// LIVE-GATE G3: a short, tool-specific hint pulled from the tool call's raw `argsJson` —
    /// pure JSON parsing, no throwing (malformed/missing JSON, or a field of the wrong type,
    /// all fall through to `nil`; this must never crash the reducer). `bash` → the command's
    /// first line, clipped to 100 chars (long heredocs/scripts stay one line). `task_create`/
    /// `task_update` → the task's `subject`. `read`/`write`/`edit`/`glob`/`grep` → whichever of
    /// `file_path`/`path`/`pattern` is present (different tools use different field names for
    /// "the thing this call touched"). Anything else → `nil` — not every tool has a useful
    /// one-line summary, and that's fine, the group just renders with no detail lines.
    private static func extractToolDetail(name: String, argsJson: String) -> String? {
        guard let data = argsJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        switch name {
        case "bash":
            guard let command = obj["command"] as? String, !command.isEmpty else { return nil }
            let firstLine = command.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
                .first.map(String.init) ?? command
            return String(firstLine.prefix(100))
        case "task_create", "task_update":
            guard let subject = obj["subject"] as? String, !subject.isEmpty else { return nil }
            return subject
        case "read", "write", "edit", "glob", "grep", "ls":
            if let path = obj["file_path"] as? String, !path.isEmpty { return path }
            if let path = obj["path"] as? String, !path.isEmpty { return path }
            if let pattern = obj["pattern"] as? String, !pattern.isEmpty { return pattern }
            return nil
        default:
            return nil
        }
    }

    static func reduceConnection(_ state: OrbSessionState, _ conn: ConnectionState) -> OrbSessionState {
        var s = state
        switch conn {
        case .disconnected, .reconnecting:
            s.status = .disconnected
        case .connected:
            s.status = s.pendingInteractions.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingInteractions.count)
        }
        return s
    }

    /// Important-2 fix (orb-scope review): `clientName` values the ENGINE stamps onto a
    /// `user_message` IT synthesizes/relays on someone ELSE's behalf — never a real originating
    /// surface/client's own self-declared identity (`"orb"`, `"iphone-gateway"`, `"routine"`, any
    /// `"cli-*"`). Criterion: if the value identifies the ENGINE rather than an originating
    /// surface/client, it belongs here. Decided per literal, grepped straight off
    /// `packages/core/src/agent/engine.ts`:
    ///   - `"steer"` (`engine.steer()`, line ~1049) — stamped UNCONDITIONALLY on every steer,
    ///     whether it queues into a running turn or starts a fresh one when idle. REACHABLE at
    ///     `threadId == mainThread` — this is the literal the reported bug rides in on (a mid-turn
    ///     steer in a multi-round tool-using turn, where `assistant_message` already arrived for an
    ///     earlier round, falls into the reducer's "new exchange" branch above).
    ///   - `"send_message"` (`runThread`'s child-thread steer drain, line ~2065) and `"resume"`
    ///     (`resumeAgent`, line ~3795) — both stamped ONLY on a CHILD thread's events per their own
    ///     doc comments in `engine.ts` (`latestMainUserMessage`'s doc: "a child thread's own
    ///     'send_message'/'resume'-clientName events... are never candidates" for anything
    ///     MAIN_THREAD-scoped). Neither can reach this `mainThread`-scoped branch today — listed
    ///     anyway (belt-and-braces, mirroring this codebase's own redundant-condition style
    ///     elsewhere, e.g. `workflowToolAllowed`'s doc in `engine.ts`) so a future engine change that
    ///     ever DID surface one on the main thread fails closed instead of silently corrupting the
    ///     origin.
    /// Genuine cross-client sends are deliberately NOT listed and MUST keep overwriting:
    /// `"iphone-gateway"` (the phone's Mac-side gateway harness), `"routine"` (a scheduled routine),
    /// any `"cli-*"` (the CLI's own `connect(name:)` identities), and `"orb"` itself — each of these
    /// is a real new turn origin, not the engine talking to itself.
    private static func isEngineSentinelClientName(_ clientName: String) -> Bool {
        ["steer", "send_message", "resume"].contains(clientName)
    }

    private static func resolvePending(_ state: OrbSessionState, callId: String) -> OrbSessionState {
        var s = state
        s.pendingInteractions.removeAll { $0.callId == callId }
        if case .approvalNeeded = s.status {
            s.status = s.pendingInteractions.isEmpty
                ? (s.turnRunning ? .thinking : .idle)
                : .approvalNeeded(count: s.pendingInteractions.count)
        }
        return s
    }
}

@MainActor
final class SessionModel: ObservableObject {
    @Published private(set) var state = OrbSessionState()
    private let notifier: NotificationPosting

    /// task-30 (push-notification track): how fresh `notificationRequested.ts` must be (wall-clock
    /// ms) to actually post a native alert. See `apply`'s own doc comment for why this exists —
    /// internal (not `private`) so `SessionModelTests` can pin the exact boundary rather than
    /// guessing at it.
    static let notificationFreshnessMs: Double = 10_000

    init(notifier: NotificationPosting = SystemNotificationPoster()) {
        self.notifier = notifier
    }

    func apply(_ event: SessionEvent) {
        state = SessionReducer.reduce(state, event)
        // Store-level impurity seam (wave 6, item 1): `SessionReducer.reduce` must stay pure —
        // no `Bool`/`Int`/`Array.randomElement` inside it, or two calls with identical inputs
        // could produce different outputs, which breaks the reducer's testability/replay
        // contract. So the ONE random roll a turn needs happens HERE, right after the pure
        // reduce, keyed off the same `turnStarted(main)` case the reducer used to flip
        // `turnRunning`/`status` — this is the one and only place `workingVerb` is assigned by
        // production code; `OrbSessionState.workingVerb`'s doc comment points back here.
        if case .turnStarted(let v) = event, v.threadId == "main" {
            state.workingVerb = WorkingVerbs.random()
        }
        // task-30 (push-notification track): a SECOND impurity seam, same shape as workingVerb
        // above — posting a native OS notification is a real side effect, so it can never live in
        // the pure `SessionReducer`. REPLAY SAFETY is the reason this isn't a plain unconditional
        // post: `notification_requested` is persisted and replayed like any other event, and
        // AppModel.refocus/SessionFeed.repin/a fresh app launch all replay a session's ENTIRE
        // history from seq 0 — without a freshness gate, reattaching to (or relaunching into) a
        // session with old notifications would re-fire every one of them as a brand-new banner.
        // `ts` is the daemon's own wall-clock stamp at emission (`Date.now()`, sessions/store.ts) —
        // a genuinely live event's `ts` is always within a few ms of "now"; a replayed one is
        // whatever it was stamped at, virtually always older than the threshold in any realistic
        // session. A slow/laggy daemon roundtrip could in principle delay a live notification past
        // the threshold and silently drop it — acceptable for v1 (a missed OS toast, not data
        // loss: the event itself is still in the transcript/session history either way).
        if case .notificationRequested(let v) = event {
            let ageMs = Date().timeIntervalSince1970 * 1000 - Double(v.ts)
            if ageMs < Self.notificationFreshnessMs {
                notifier.post(title: v.title, body: v.message)
            }
        }
    }

    func apply(connection: ConnectionState) {
        state = SessionReducer.reduceConnection(state, connection)
    }

    /// M2 contract: NormaClient.connect() yields NO initial `.connected` event —
    /// the app layer calls this after connect() returns.
    func markConnected() {
        state = SessionReducer.reduceConnection(state, .connected)
    }

    /// New focus target: drop per-session state before replaying another session.
    func reset() {
        let wasConnected = state.status != .disconnected
        state = OrbSessionState()
        if wasConnected { state.status = .idle }
    }

    /// Test-only mutation seam (Task 2, fluid state derivation tests): lets tests set arbitrary
    /// `OrbSessionState` fields directly (e.g. `turnRunning`, `tasks`) without constructing a full
    /// `SessionEvent`/`SessionReducer` round trip for state combinations the real event stream
    /// wouldn't produce on its own (e.g. "turnRunning with no tasks"). Internal, not `public` —
    /// reachable from `FluidStateTests` via `@testable import Norma`, same convention as
    /// `OrbWindowController.morphProgressForTesting`.
    func applyForTesting(_ mutate: (inout OrbSessionState) -> Void) {
        mutate(&state)
    }
}
