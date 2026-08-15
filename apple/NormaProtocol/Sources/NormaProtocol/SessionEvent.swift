import Foundation

public enum SessionEvent: Codable, Equatable, Sendable {
    case sessionCreated(SessionCreated)
    case harnessAttached(HarnessAttached)
    case harnessDetached(HarnessDetached)
    case userMessage(UserMessage)
    case turnStarted(TurnStarted)
    case assistantMessage(AssistantMessage)
    case assistantDelta(AssistantDelta)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    case approvalRequested(ApprovalRequested)
    case approvalResolved(ApprovalResolved)
    case turnCompleted(TurnCompleted)
    case agentError(AgentError)
    case directoryAdded(DirectoryAdded)
    case bgTaskStarted(BgTaskStarted)
    case bgTaskOutput(BgTaskOutput)
    case bgTaskExited(BgTaskExited)
    case checkpoint(Checkpoint)
    case questionAsked(QuestionAsked)
    case questionResolved(QuestionResolved)
    case taskUpdated(TaskUpdated)
    case planPresented(PlanPresented)
    case planResolved(PlanResolved)
    case worktreeEntered(WorktreeEntered)
    case worktreeExited(WorktreeExited)
    case threadStarted(ThreadStarted)
    case threadCompleted(ThreadCompleted)
    case sessionTitled(SessionTitled)
    case leaseGranted(LeaseGranted)
    case leaseLost(LeaseLost)
    case peripheralCallRequested(PeripheralCallRequested)
    case pluginToolInvoke(PluginToolInvoke)
    case hardwareRequested(HardwareRequested)
    case pluginTileUpdated(PluginTileUpdated)
    case shortcutInvoke(ShortcutInvoke)
    case tileAction(TileAction)
    case toolReview(ToolReview)
    case notificationRequested(NotificationRequested)
    case childUpdate(ChildUpdate)
    case workflowStarted(WorkflowStarted)
    case workflowProgress(WorkflowProgress)
    case workflowCompleted(WorkflowCompleted)
    case workflowFailed(WorkflowFailed)
    case sessionActivity(SessionActivity)
    case panelTabOpened(PanelTabOpened)
    case panelTabClosed(PanelTabClosed)
    case panelTabActivated(PanelTabActivated)
    case panelTabNavigated(PanelTabNavigated)
    case panelCommand(PanelCommand)

    public struct SessionCreated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let scope: String
        // Dispatch (Phase 7 durability follow-up): carried so a full index.db rebuild can restore
        // the dispatch-singleton invariant (see events.ts's SessionCreatedEvent doc comment).
        // Additive/optional — pure Codable synthesis, no Discriminator/decode/encode changes.
        public let mode: String?
    }

    public struct HarnessAttached: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct HarnessDetached: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let clientName: String
    }

    public struct UserMessage: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
        public let clientName: String
        // Public init so a Swift PRODUCER (NormaChatKit's phone ChatEngine) can construct this event
        // — the synthesized memberwise init is `internal`. Additive; no wire/shape change.
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, text: String, clientName: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.text = text; self.clientName = clientName
        }
    }

    public struct TurnStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public init(seq: Int, sessionId: String, ts: Int, threadId: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
        }
    }

    public struct AssistantMessage: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let text: String
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, text: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId; self.text = text
        }
    }

    /// TRANSIENT streaming chunk — broadcast-only, never persisted/replayed; seq is the store's
    /// lastSeq at broadcast time. Exempt from seq-based dedupe and lastSeq tracking (see NormaKit).
    public struct AssistantDelta: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let delta: String
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, delta: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId; self.delta = delta
        }
    }

    public struct ToolCall: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let name: String
        public let argsJson: String
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, callId: String, name: String, argsJson: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.callId = callId; self.name = name; self.argsJson = argsJson
        }
    }

    /// Summary of one file's diff, stamped onto `ToolResult.fileDiff` below — mirrors TS
    /// `FileDiffSummary` (`packages/protocol/src/events.ts`). Plain fields only: this package
    /// mirrors WIRE SHAPE, not zod's runtime validation (`path`/`diffId` length caps, the
    /// `DIFF_ID_SHAPE` regex) — those are enforced daemon-side before a value like this is ever
    /// put on the wire, so decode-only fidelity is all this struct needs to provide.
    public struct FileDiffSummary: Codable, Equatable, Sendable {
        public let path: String
        public let added: Int
        public let removed: Int
        public let diffId: String
    }

    public struct ToolResult: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let output: String
        public let isError: Bool
        /// Set only by the daemon engine for edit/write/notebook_edit; chat-mode engines never
        /// produce it. Optional/additive — decode only, absent on older-shaped payloads and on
        /// results from tools that don't touch a file.
        public let fileDiff: FileDiffSummary?
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, callId: String, output: String, isError: Bool, fileDiff: FileDiffSummary? = nil) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.callId = callId; self.output = output; self.isError = isError; self.fileDiff = fileDiff
        }
    }

    /// SP-approvals T4: a caller-facing "grant a rule" choice offered alongside plain approve/
    /// deny — e.g. "Always allow `git push` in this project." `id` is an open set (the daemon
    /// mints the concrete ids per tool, engine.ts's `approvalOptionsFor` — Task 5); `label` is the
    /// exact human-readable text to render, already composed with the rule string for a
    /// rule-bearing option. `rule`/`scope` are present TOGETHER on an option that persists a
    /// permission rule when chosen, and both absent (tolerant-decode: neither is required) on a
    /// plain option (allow-once/deny) that grants nothing durable.
    public struct ApprovalOption: Codable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let rule: String?
        public let scope: String?
    }

    public struct ApprovalRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let toolName: String
        public let summary: String
        /// SP3 T4b: the approval's issue/expiry timestamps (epoch ms). The daemon ALWAYS emits both
        /// on NEW events, but they are OPTIONAL — exactly like `reviewerReason`/`childSessionId`
        /// below — so OLDER persisted events (pre-T4b session JSONL, replayed on attach) still
        /// decode (Phase-A review CRITICAL: a required field would drop pre-T4b approval history).
        /// Absent means "unknown expiry" — treat as NOT expired, never as expired. `expiresAt` is
        /// the broker's fail-closed timeout deadline; a phone renders "expires in Ns" and derives
        /// `.expired` from it (the SAME value the `approval.list` pending entry carries, where it is
        /// always present), without waiting for `approval_resolved{by:"timeout"}`.
        public let issuedAt: Int?
        public let expiresAt: Int?
        /// Phase 5e T1: populated when this escalation came from the safety reviewer — the
        /// reviewer's own sentence, distinct from `summary`. Optional/additive — decode only,
        /// absent for ask-policy/reviewer-less escalations and older-shaped payloads.
        public let reviewerReason: String?
        /// Dispatch relay (Phase 7): set on the MIRRORED copy of a child session's approval living
        /// in the dispatch session's stream — identifies which child to respond into. Optional/
        /// additive — decode only, absent on native approvals.
        public let childSessionId: String?
        /// SP-approvals T4: per-approval allow-rule choices (Task 5's `approvalOptionsFor`) — see
        /// `ApprovalOption`'s own doc comment above. Optional/additive — decode only, absent for a
        /// reviewer-escalation/grant/worktree card or an older-shaped payload.
        public let options: [ApprovalOption]?
    }

    public struct ApprovalResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let approved: Bool
        public let by: String
        /// Dispatch relay (Phase 7): see ApprovalRequested.
        public let childSessionId: String?
    }

    public struct TurnCompleted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let stopReason: String
        /// `inputTokens`/`outputTokens` are the turn's BILLING totals, summed across every tool
        /// round — never a context-size proxy (see the TS mirror, `packages/protocol/src/events.ts`'s
        /// `TurnCompletedEvent` doc comment, for the full rationale).
        public let inputTokens: Int
        public let outputTokens: Int
        /// Additive/optional (provider-correctness T2, mirrored here for followups T3 now that
        /// `NormaChatKit.ChatEngine` is a second live producer of `turn_completed`): the provider-
        /// reported input size of the turn's LARGEST single round, i.e. how full the context actually
        /// got — the only correct input to the daemon's auto-compaction trigger. ABSENT (older events,
        /// or a producer that doesn't emit it) means "skip this event", never "fall back to
        /// `inputTokens`" — that sums across rounds and would reintroduce the premature-compaction bug
        /// this field exists to fix. A producer that emits it must emit the per-round MAXIMUM, never a
        /// sum and never the last round's value alone.
        public let contextTokens: Int?
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, stopReason: String,
                    inputTokens: Int, outputTokens: Int, contextTokens: Int? = nil) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.stopReason = stopReason; self.inputTokens = inputTokens; self.outputTokens = outputTokens
            self.contextTokens = contextTokens
        }
    }

    public struct AgentError: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let message: String
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, message: String) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId; self.message = message
        }
    }

    public struct DirectoryAdded: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let path: String
        public let persisted: Bool
    }

    public struct BgTaskStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let command: String
    }

    public struct BgTaskOutput: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let chunk: String
    }

    public struct BgTaskExited: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let taskId: String
        public let exitCode: Int?
        public let killed: Bool
    }

    public struct Checkpoint: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let summary: String
        public let uptoSeq: Int
    }

    public struct QuestionOption: Codable, Equatable, Sendable {
        public let label: String
        public let description: String?
        /// CC AskUserQuestion parity: per-option preview (the "visual scheme on the right"),
        /// e.g. a diff/scheme snippet rendered alongside the option. Optional/additive — decode
        /// only, absent in older-shaped payloads.
        public let preview: String?
        public init(label: String, description: String? = nil, preview: String? = nil) {
            self.label = label; self.description = description; self.preview = preview
        }
    }

    public struct Question: Codable, Equatable, Sendable {
        public let question: String
        /// Optional since Slice B1 — chat's `AskQuestion` emits a simplified card with no header
        /// chip. `nil` is the signal for "simplified": no chip, no per-option descriptions, no
        /// notes affordance (see PendingCards.swift).
        public let header: String?
        public let options: [QuestionOption]
        public let multiSelect: Bool
        public init(question: String, header: String? = nil, options: [QuestionOption], multiSelect: Bool) {
            self.question = question; self.header = header; self.options = options; self.multiSelect = multiSelect
        }
    }

    public struct Task: Codable, Equatable, Sendable {
        public let id: String
        public let subject: String
        public let status: String
        public let activeForm: String?
        /// Task-graph fields (4h-ii-d, CC parity) — optional/additive, decode-only: absent in
        /// older-shaped payloads, which decode with all four nil. `metadata` mirrors TS's
        /// `z.record(z.string(), z.unknown())`, hence the existing `JSONValue` type (declared
        /// below, reused here rather than `[String: String]`) — a task's metadata is
        /// heterogeneous (e.g. `"priority": "high"` alongside `"sprint": 12`).
        public let owner: String?
        public let blocks: [String]?
        public let blockedBy: [String]?
        public let metadata: [String: JSONValue]?
    }

    public struct QuestionAsked: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let questions: [Question]
        /// Dispatch relay (Phase 7): see ApprovalRequested.
        public let childSessionId: String?
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, callId: String,
                    questions: [Question], childSessionId: String? = nil) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.callId = callId; self.questions = questions; self.childSessionId = childSessionId
        }
    }

    public struct QuestionResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let answers: [String: String]
        public let by: String
        /// CC AskUserQuestion parity: free-text notes ("press n to add notes"), keyed by question
        /// text like `answers`. Optional/additive — decode only, absent in older-shaped payloads.
        public let notes: [String: String]?
        /// Dispatch relay (Phase 7): see ApprovalRequested.
        public let childSessionId: String?
        public init(seq: Int, sessionId: String, ts: Int, threadId: String, callId: String,
                    answers: [String: String], by: String, notes: [String: String]? = nil,
                    childSessionId: String? = nil) {
            self.seq = seq; self.sessionId = sessionId; self.ts = ts; self.threadId = threadId
            self.callId = callId; self.answers = answers; self.by = by; self.notes = notes
            self.childSessionId = childSessionId
        }
    }

    public struct TaskUpdated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let task: Task
    }

    public struct PlanPresented: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let plan: String
    }

    public struct PlanResolved: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let callId: String
        public let approved: Bool
        public let feedback: String?
        public let autoAccept: Bool
        public let by: String
    }

    public struct WorktreeEntered: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let name: String
        public let path: String
        public let branch: String
    }

    public struct WorktreeExited: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let name: String
        public let action: String
        public let removed: Bool
    }

    public struct ThreadStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let parentThreadId: String
        public let agentType: String
        public let prompt: String
        public let description: String?
    }

    public struct ThreadCompleted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let stopReason: String
    }

    public struct SessionTitled: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let title: String
    }

    /// `{kind: "session"|"plugin", id}` — identifies the holder of a peripheral lease.
    public struct Holder: Codable, Equatable, Sendable {
        public let kind: String
        public let id: String
    }

    /// TRANSIENT (broadcast-only, like `assistant_delta`) — leases are runtime state; replay
    /// must never resurrect one. The audit log is the durable record.
    ///
    /// `tokenHash` (sha256 hex of the raw token) lets the PROVIDER validate token+class+expiry
    /// on every `peripheral_call_requested` (spec §A1: "no token, no service") — see
    /// `PeripheralProvider.shouldServe` in the app target. The raw token itself never rides this
    /// event.
    public struct LeaseGranted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let leaseId: String
        public let `class`: String
        public let holder: Holder
        public let expiresAt: Int
        public let tokenHash: String
    }

    /// TRANSIENT — see LeaseGranted.
    public struct LeaseLost: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let leaseId: String
        public let `class`: String
        public let holder: Holder
        public let reason: String
    }

    /// TRANSIENT — core pushes this to the provider's connection (approval-broker request/
    /// response pattern); the provider answers via `peripheral.respond`.
    public struct PeripheralCallRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let requestId: String
        public let leaseId: String
        public let token: String
        public let `class`: String
        public let payloadJson: String
    }

    /// TRANSIENT (broadcast-only, like `assistant_delta`/the lease events above) — core pushes
    /// this to a plugin's own connection (the same approval-broker request/response pattern as
    /// `PeripheralCallRequested`); the plugin answers via `plugin.toolResult`
    /// {requestId, resultJson?, error?}.
    public struct PluginToolInvoke: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let requestId: String
        public let tool: String
        public let argsJson: String
    }

    /// TRANSIENT (broadcast-only, like `assistant_delta`/the lease events/`PluginToolInvoke`
    /// above) — core pushes this to the active provider's connection (Norma.app, spec §5) when a
    /// plugin (or the harness) calls `hardware.request`; the provider answers via
    /// `hardware.respond` {requestId, resultJson?, error?}.
    public struct HardwareRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let requestId: String
        public let verb: String
        public let argsJson: String
    }

    /// An opaque JSON value — mirrors TS's `z.record(z.string(), z.unknown())` (the wire shape of
    /// a plugin's `tile.update` payload, PluginTileUpdated's `tile` field below): core does not
    /// validate a tile's contents beyond "is an object", so Swift can't type it any more
    /// concretely than "some JSON value" either.
    public indirect enum JSONValue: Codable, Equatable, Sendable {
        case string(String)
        case number(Double)
        case bool(Bool)
        case object([String: JSONValue])
        case array([JSONValue])
        case null

        public init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null; return }
            if let v = try? c.decode(Bool.self) { self = .bool(v); return }
            if let v = try? c.decode(Double.self) { self = .number(v); return }
            if let v = try? c.decode(String.self) { self = .string(v); return }
            if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
            if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let v): try c.encode(v)
            case .number(let v): try c.encode(v)
            case .bool(let v): try c.encode(v)
            case .object(let v): try c.encode(v)
            case .array(let v): try c.encode(v)
            case .null: try c.encodeNil()
            }
        }
    }

    /// TRANSIENT (broadcast-only, never appended to the session log/replayed on attach — there's
    /// no session to attach to; `sessionId` is always the `$system` sentinel) — Phase 4d Task 1's
    /// live tile push. Core broadcasts this to every authed harness when a plugin's `tile.update`
    /// lands, and again with `tile: nil` when the plugin disconnects (dashboards drop the
    /// now-stale card). Extends the plain `{seq, sessionId, ts}` base directly, NOT the
    /// thread-scoped shape other events use — a plugin's declarative tile isn't scoped to a
    /// thread.
    public struct PluginTileUpdated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let pluginId: String
        public let tile: [String: JSONValue]?
    }

    /// TRANSIENT (broadcast-only, never appended to the session log/replayed on attach —
    /// `sessionId` is always the `$system` sentinel) — Phase 4d Task 2's harness→plugin push: core
    /// sends this directly to a plugin's own connection when a future UI fires one of that
    /// plugin's registered shortcuts (`shortcut.invoke`, methods.ts). Extends the plain
    /// `{seq, sessionId, ts}` base directly, NOT the thread-scoped shape, same reasoning as
    /// `PluginTileUpdated` above.
    public struct ShortcutInvoke: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let shortcutId: String
    }

    /// TRANSIENT — see ShortcutInvoke above. Phase 4d Task 2's other harness→plugin push: core
    /// sends this when a future UI clicks one of the plugin's declarative tile's action buttons
    /// (`tile.action`, methods.ts).
    public struct TileAction: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let actionId: String
    }

    /// Reviewer observability (phase 5e T1) — persisted once per actual reviewer.review()
    /// invocation, never for the bashLooksSafe static bypass. `verdict` is a plain String (like
    /// `TurnCompleted.stopReason`/`WorktreeExited.action` above) — validation of its 3 allowed
    /// values lives on the TS producer side, mirrored here only as decode-shape. NOT sensitive (no
    /// encrypted content), unlike ReasoningItem — this extends ThreadBase's usual shape directly.
    public struct ToolReview: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let toolName: String
        public let verdict: String
        public let reason: String
        public let summary: String
    }

    /// Push-notification track (task-30, the final CC-parity tool item) — emitted once per
    /// `push_notification` tool call. NOT transient (unlike `AssistantDelta`/the lease events
    /// above): persisted and replayed like `ToolReview`/`TaskUpdated`. Delivery is entirely
    /// client-side: the Norma app target posts a native `UNUserNotificationCenter` alert
    /// (`SessionModel.apply`, gated on `ts` being wall-clock-fresh so a reattach/refocus replay
    /// never re-fires a historical notification as a new banner); the daemon additionally shells
    /// `osascript` as a headless fallback when nobody's attached at all (see core's
    /// `agent/notify-fallback.ts`).
    public struct NotificationRequested: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let title: String
        public let message: String
    }

    /// Dispatch (Phase 7): appended to the DISPATCH session's stream whenever a child session's
    /// status changes materially (spawned, turn ended, error, stopped). `status` is a plain
    /// String (like `ThreadCompleted.stopReason` above) — validation of its allowed values lives
    /// on the TS producer side. `resultSummary` is the child's final assistant message when the
    /// update is a turn-end.
    public struct ChildUpdate: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let childSessionId: String
        public let status: String
        public let title: String
        public let resultSummary: String?
    }

    /// CC-parity phase 3 (Workflows, Track D Task D1): the wire counterpart of WorkflowRuntime's
    /// internal `WorkflowRuntimeEvent` (core's `workflows/runtime.ts`) — the daemon's `onEvent`
    /// bridge maps its `started`/`progress`/`completed`/`failed` variants onto these 4 events so an
    /// attached client (this app) can watch a Workflow run live. Additive to, never instead of, the
    /// existing `notifyWorkflowCompletion` assistant-facing `task_notification` these SAME runtime
    /// events also drive.
    public struct WorkflowStarted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let runId: String
        public let name: String?
        public let summary: String
    }

    /// See WorkflowStarted above. `phase`/`log` mirror the script's own `phase()`/`log()` bridge
    /// calls (optional — a progress tick may carry only updated counts); `running`/`completed`/
    /// `total` are always present (WorkflowRuntimeEvent's `progress.counts`, workflows/types.ts).
    public struct WorkflowProgress: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let runId: String
        public let phase: String?
        public let log: String?
        public let running: Int
        public let completed: Int
        public let total: Int
    }

    /// See WorkflowStarted above.
    public struct WorkflowCompleted: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let runId: String
        public let resultSummary: String
    }

    /// See WorkflowStarted above.
    public struct WorkflowFailed: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let threadId: String
        public let runId: String
        public let error: String
    }

    /// session-activity-hygiene T4: a code/cowork session's derived lifecycle state, pushed live
    /// whenever it actually CHANGES so an open UI flips without re-polling `session.list`.
    ///
    /// TRANSIENT (see `transientTypes` at the bottom of this file): broadcast-only, never in the
    /// session log, and stamped with the store's current `lastSeq` — so it must be exempted from
    /// seq dedupe and cursor advancement like every other transient.
    ///
    /// SESSION-scoped, hence no `threadId` (the `HarnessAttached` shape): activity is a fact about
    /// the whole session — an attachment, a stored background/archive flag — never about one
    /// thread.
    ///
    /// `activity` is a plain `String`, not a Swift enum, deliberately — the same call
    /// `ThreadCompleted.stopReason` and `ToolReview.verdict` make. Today's four values are
    /// `active` / `background` / `idle` / `archived`, and a fifth added by a newer daemon must
    /// DECODE on an older client rather than throw. Where that bites is the STRICT path: the Mac
    /// app's `NormaClient` decodes every pushed frame into this very type, so an unknown case would
    /// throw there. (The phone's `NormaSessionClient` is not the reason — it decodes the live stream
    /// opaquely into `JSONValue` and falls back to `.null`, so a value it cannot read is skipped,
    /// not fatal.) Absence — "this session has no lifecycle", which is what chat and dispatch
    /// sessions carry in `session.list` — is never represented here: the daemon emits no event at
    /// all for a non-participating session.
    public struct SessionActivity: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let activity: String
    }

    /// UI-drawn categories for a panel tab — CLOSED, unlike the verb-shaped String fields
    /// elsewhere in this file (`WorktreeExited.action`, `PanelCommand.action` below): a tab's
    /// kind selects which SwiftUI view renders it, so an unrecognized kind has no reasonable
    /// fallback, and a new kind is exactly the sort of protocol change that already means walking
    /// this file's variant checklist.
    public enum PanelTabKind: String, Codable, Equatable, Sendable {
        case web, document, code, note, diff, files
    }

    /// panel-shell T3: the daemon-driven browsing/document panel's tab lifecycle. This event and
    /// the three below (through PanelTabNavigated), plus PanelCommand further down, all extend
    /// the plain `{seq, sessionId, ts}` base directly, NOT the thread-scoped shape most events
    /// use — a panel tab is a fact about the whole session (like `HarnessAttached`/
    /// `SessionActivity` above), never about one thread: the daemon opens/closes/navigates a tab
    /// as a side effect of a tool call running on SOME thread, but the tab itself outlives that
    /// thread.
    public struct PanelTabOpened: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let tabId: String
        public let kind: PanelTabKind
        public let url: String?
        public let title: String?
        /// Set only when kind == .diff.
        public let diffId: String?
    }

    /// See PanelTabOpened above.
    public struct PanelTabClosed: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let tabId: String
    }

    /// See PanelTabOpened above.
    public struct PanelTabActivated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let tabId: String
    }

    /// Committed TOP-LEVEL navigations only — no subframes, no in-flight redirects, no fragment
    /// changes. That bound is what keeps a browsing session at ~10-50 events instead of
    /// thousands, in a JSONL that is replayed on every session open.
    public struct PanelTabNavigated: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let tabId: String
        public let url: String
        public let title: String
    }

    /// TRANSIENT (see `transientTypes` at the bottom of this file) — the daemon's only push
    /// channel to the app for verbs needing CEF execution. A PERSISTED command would be replayed
    /// on every future attach, and unlike a replayed `ask_user` (which renders a stale card) a
    /// replayed `navigate` is an ACTION — transient removes that hazard by construction rather
    /// than by a rule someone has to remember.
    ///
    /// Tab lifecycle mutations (the four events above) are NOT commands: the daemon mints the id
    /// and appends the persisted event, and the app reacts to it. Commands carry only verbs whose
    /// value is the RESULT.
    ///
    /// `action` is a plain String, not a Swift enum — the same call `WorktreeExited.action`/
    /// `ToolReview.verdict` make above, and for the STRICT-decode reason `SessionActivity`'s own
    /// comment spells out: the Mac app's `NormaClient` decodes every pushed frame into this exact
    /// type, so a future verb an older client doesn't recognize must decode, not throw. B2 Task 2
    /// grew the TS producer's set from one verb to nine (`PANEL_COMMAND_ACTIONS`, events.ts:
    /// navigate/back/read/screenshot/click/type/scroll/submit/wait); validation of the allowed set
    /// stays on the producer side, and this type deliberately did not have to change for it.
    ///
    /// **Where the tolerance actually lives — two layers, only the first of which keeps the
    /// COMMAND.** (1) This `String` is why an unrecognized verb decodes at all; (2) one layer up,
    /// `parseServerLine` (NormaKit `ServerMessage.swift`) wraps the strict NormaProtocol decode in
    /// `try?` and degrades any failure to `.unknownEvent(raw:)`, which `NormaClient` yields as
    /// `.unknown` and keeps reading. So a Swift enum here would NOT kill the event stream — it
    /// would silently drop that one command, the daemon's pending entry would run out its
    /// `deadlineMs`, and the agent would be told "timed out" for a verb the app simply never
    /// understood. Layer 2 protects the connection; only layer 1 protects the command.
    public struct PanelCommand: Codable, Equatable, Sendable {
        public let seq: Int
        public let sessionId: String
        public let ts: Int
        public let commandId: String
        public let tabId: String?
        public let action: String
        public let url: String?
        /// B2 Task 2 — the per-verb payload (`{selector, text}` for `type`, `{dx, dy}` for
        /// `scroll`, …), opaque here exactly as it is on the TS side: `z.record(z.string(),
        /// z.unknown())` there, `[String: JSONValue]` here (the `PluginTileUpdated.tile` /
        /// `Task.metadata` precedent). Optional, so every Plan A-era `panel_command` still decodes
        /// — `panel_command_back.json` is the fixture that pins that direction.
        ///
        /// Nothing in the round-trip GATE would have caught this field's absence: an unknown JSON
        /// key is dropped on decode and simply not re-encoded, so a mirror missing `args` decodes,
        /// re-encodes and re-decodes to an equal value while losing the payload entirely. The
        /// count assertion moves, the equality assertion does not — which is why
        /// `RoundTripTests.testPanelCommandArgsDecodeOpaquely` checks CONTENT.
        public let args: [String: JSONValue]?
        public let deadlineMs: Int
    }

    private enum Discriminator: String, Codable {
        case session_created
        case harness_attached
        case harness_detached
        case user_message
        case turn_started
        case assistant_message
        case assistant_delta
        case tool_call
        case tool_result
        case approval_requested
        case approval_resolved
        case turn_completed
        case agent_error
        case directory_added
        case bg_task_started
        case bg_task_output
        case bg_task_exited
        case checkpoint
        case question_asked
        case question_resolved
        case task_updated
        case plan_presented
        case plan_resolved
        case worktree_entered
        case worktree_exited
        case thread_started
        case thread_completed
        case session_titled
        case lease_granted
        case lease_lost
        case peripheral_call_requested
        case plugin_tool_invoke
        case hardware_requested
        case plugin_tile_updated
        case shortcut_invoke
        case tile_action
        case tool_review
        case notification_requested
        case child_update
        case workflow_started
        case workflow_progress
        case workflow_completed
        case workflow_failed
        case session_activity
        case panel_tab_opened
        case panel_tab_closed
        case panel_tab_activated
        case panel_tab_navigated
        case panel_command
    }

    private enum TypeKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TypeKey.self)
        switch try c.decode(Discriminator.self, forKey: .type) {
        case .session_created:      self = .sessionCreated(try SessionCreated(from: decoder))
        case .harness_attached:     self = .harnessAttached(try HarnessAttached(from: decoder))
        case .harness_detached:     self = .harnessDetached(try HarnessDetached(from: decoder))
        case .user_message:         self = .userMessage(try UserMessage(from: decoder))
        case .turn_started:         self = .turnStarted(try TurnStarted(from: decoder))
        case .assistant_message:    self = .assistantMessage(try AssistantMessage(from: decoder))
        case .assistant_delta:      self = .assistantDelta(try AssistantDelta(from: decoder))
        case .tool_call:            self = .toolCall(try ToolCall(from: decoder))
        case .tool_result:          self = .toolResult(try ToolResult(from: decoder))
        case .approval_requested:   self = .approvalRequested(try ApprovalRequested(from: decoder))
        case .approval_resolved:    self = .approvalResolved(try ApprovalResolved(from: decoder))
        case .turn_completed:       self = .turnCompleted(try TurnCompleted(from: decoder))
        case .agent_error:          self = .agentError(try AgentError(from: decoder))
        case .directory_added:      self = .directoryAdded(try DirectoryAdded(from: decoder))
        case .bg_task_started:      self = .bgTaskStarted(try BgTaskStarted(from: decoder))
        case .bg_task_output:       self = .bgTaskOutput(try BgTaskOutput(from: decoder))
        case .bg_task_exited:       self = .bgTaskExited(try BgTaskExited(from: decoder))
        case .checkpoint:           self = .checkpoint(try Checkpoint(from: decoder))
        case .question_asked:       self = .questionAsked(try QuestionAsked(from: decoder))
        case .question_resolved:    self = .questionResolved(try QuestionResolved(from: decoder))
        case .task_updated:         self = .taskUpdated(try TaskUpdated(from: decoder))
        case .plan_presented:       self = .planPresented(try PlanPresented(from: decoder))
        case .plan_resolved:        self = .planResolved(try PlanResolved(from: decoder))
        case .worktree_entered:     self = .worktreeEntered(try WorktreeEntered(from: decoder))
        case .worktree_exited:      self = .worktreeExited(try WorktreeExited(from: decoder))
        case .thread_started:       self = .threadStarted(try ThreadStarted(from: decoder))
        case .thread_completed:     self = .threadCompleted(try ThreadCompleted(from: decoder))
        case .session_titled:       self = .sessionTitled(try SessionTitled(from: decoder))
        case .lease_granted:        self = .leaseGranted(try LeaseGranted(from: decoder))
        case .lease_lost:           self = .leaseLost(try LeaseLost(from: decoder))
        case .peripheral_call_requested: self = .peripheralCallRequested(try PeripheralCallRequested(from: decoder))
        case .plugin_tool_invoke:   self = .pluginToolInvoke(try PluginToolInvoke(from: decoder))
        case .hardware_requested:   self = .hardwareRequested(try HardwareRequested(from: decoder))
        case .plugin_tile_updated:  self = .pluginTileUpdated(try PluginTileUpdated(from: decoder))
        case .shortcut_invoke:      self = .shortcutInvoke(try ShortcutInvoke(from: decoder))
        case .tile_action:          self = .tileAction(try TileAction(from: decoder))
        case .tool_review:          self = .toolReview(try ToolReview(from: decoder))
        case .notification_requested: self = .notificationRequested(try NotificationRequested(from: decoder))
        case .child_update:         self = .childUpdate(try ChildUpdate(from: decoder))
        case .workflow_started:     self = .workflowStarted(try WorkflowStarted(from: decoder))
        case .workflow_progress:    self = .workflowProgress(try WorkflowProgress(from: decoder))
        case .workflow_completed:   self = .workflowCompleted(try WorkflowCompleted(from: decoder))
        case .workflow_failed:      self = .workflowFailed(try WorkflowFailed(from: decoder))
        case .session_activity:     self = .sessionActivity(try SessionActivity(from: decoder))
        case .panel_tab_opened:     self = .panelTabOpened(try PanelTabOpened(from: decoder))
        case .panel_tab_closed:     self = .panelTabClosed(try PanelTabClosed(from: decoder))
        case .panel_tab_activated:  self = .panelTabActivated(try PanelTabActivated(from: decoder))
        case .panel_tab_navigated:  self = .panelTabNavigated(try PanelTabNavigated(from: decoder))
        case .panel_command:        self = .panelCommand(try PanelCommand(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .sessionCreated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.session_created.rawValue, forKey: .type)
        case .harnessAttached(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.harness_attached.rawValue, forKey: .type)
        case .harnessDetached(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.harness_detached.rawValue, forKey: .type)
        case .userMessage(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.user_message.rawValue, forKey: .type)
        case .turnStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.turn_started.rawValue, forKey: .type)
        case .assistantMessage(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.assistant_message.rawValue, forKey: .type)
        case .assistantDelta(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.assistant_delta.rawValue, forKey: .type)
        case .toolCall(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tool_call.rawValue, forKey: .type)
        case .toolResult(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tool_result.rawValue, forKey: .type)
        case .approvalRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.approval_requested.rawValue, forKey: .type)
        case .approvalResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.approval_resolved.rawValue, forKey: .type)
        case .turnCompleted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.turn_completed.rawValue, forKey: .type)
        case .agentError(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.agent_error.rawValue, forKey: .type)
        case .directoryAdded(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.directory_added.rawValue, forKey: .type)
        case .bgTaskStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_started.rawValue, forKey: .type)
        case .bgTaskOutput(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_output.rawValue, forKey: .type)
        case .bgTaskExited(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.bg_task_exited.rawValue, forKey: .type)
        case .checkpoint(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.checkpoint.rawValue, forKey: .type)
        case .questionAsked(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.question_asked.rawValue, forKey: .type)
        case .questionResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.question_resolved.rawValue, forKey: .type)
        case .taskUpdated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.task_updated.rawValue, forKey: .type)
        case .planPresented(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plan_presented.rawValue, forKey: .type)
        case .planResolved(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plan_resolved.rawValue, forKey: .type)
        case .worktreeEntered(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.worktree_entered.rawValue, forKey: .type)
        case .worktreeExited(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.worktree_exited.rawValue, forKey: .type)
        case .threadStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.thread_started.rawValue, forKey: .type)
        case .threadCompleted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.thread_completed.rawValue, forKey: .type)
        case .sessionTitled(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.session_titled.rawValue, forKey: .type)
        case .leaseGranted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.lease_granted.rawValue, forKey: .type)
        case .leaseLost(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.lease_lost.rawValue, forKey: .type)
        case .peripheralCallRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.peripheral_call_requested.rawValue, forKey: .type)
        case .pluginToolInvoke(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plugin_tool_invoke.rawValue, forKey: .type)
        case .hardwareRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.hardware_requested.rawValue, forKey: .type)
        case .pluginTileUpdated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.plugin_tile_updated.rawValue, forKey: .type)
        case .shortcutInvoke(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.shortcut_invoke.rawValue, forKey: .type)
        case .tileAction(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tile_action.rawValue, forKey: .type)
        case .toolReview(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.tool_review.rawValue, forKey: .type)
        case .notificationRequested(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.notification_requested.rawValue, forKey: .type)
        case .childUpdate(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.child_update.rawValue, forKey: .type)
        case .workflowStarted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.workflow_started.rawValue, forKey: .type)
        case .workflowProgress(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.workflow_progress.rawValue, forKey: .type)
        case .workflowCompleted(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.workflow_completed.rawValue, forKey: .type)
        case .workflowFailed(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.workflow_failed.rawValue, forKey: .type)
        case .sessionActivity(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.session_activity.rawValue, forKey: .type)
        case .panelTabOpened(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.panel_tab_opened.rawValue, forKey: .type)
        case .panelTabClosed(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.panel_tab_closed.rawValue, forKey: .type)
        case .panelTabActivated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.panel_tab_activated.rawValue, forKey: .type)
        case .panelTabNavigated(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.panel_tab_navigated.rawValue, forKey: .type)
        case .panelCommand(let v):
            try v.encode(to: encoder)
            var c = encoder.container(keyedBy: TypeKey.self)
            try c.encode(Discriminator.panel_command.rawValue, forKey: .type)
        }
    }
}

// ================================================================================================
// TRANSIENT event types — the Swift half of ONE cross-language definition.
// ================================================================================================

extension SessionEvent {
    /// The nine BROADCAST-ONLY TRANSIENT event types, as wire discriminators. Mirrors
    /// `TRANSIENT_EVENT_TYPES` in `packages/protocol/src/events.ts` — read that constant's doc
    /// comment for the full contract; the short version:
    ///
    /// A transient is fanned out to attached clients but NEVER appended to the session log (absent
    /// from the JSONL, from attach replay, and from `session.history`). It carries
    /// `seq = the store's lastSeq at broadcast time` — the seq of the last event actually APPENDED,
    /// not one of its own — so on a caught-up client it routinely arrives at `seq == cursor`, and
    /// can even sit BELOW it. Every client MUST therefore exempt these from BOTH seq dedupe AND
    /// cursor/lastSeq advancement. Skipping the dedupe is what gets the event to the UI; skipping
    /// the ADVANCE is what keeps the real, persisted event at that borrowed seq alive.
    ///
    /// **Why it lives here.** `Discriminator` above is `private`, so every consumer that needed
    /// this list hand-copied the strings — and the phone client's copy was simply missing, which
    /// dropped 100% of `assistant_delta` and left iOS with no streaming at all while the suite
    /// stayed green. Exposing one public constant is the fix: `NormaClient` (Mac),
    /// `NormaSessionClient` (phone) and the daemon's remote live-stream filter all derive from a
    /// single definition, and parity tests pin this literal against the TypeScript one.
    public static let transientTypes: Set<String> = [
        "assistant_delta",
        "lease_granted",
        "lease_lost",
        "peripheral_call_requested",
        "plugin_tool_invoke",
        "hardware_requested",
        "plugin_tile_updated",
        // session-activity-hygiene T4: the lifecycle's live signal (7 → 8).
        "session_activity",
        // panel-shell T3: the daemon->app command channel (8 → 9) — see `PanelCommand`'s own doc
        // comment above for why transient.
        "panel_command",
    ]

    /// Case-level mirror of `transientTypes`, for callers holding a DECODED event (`NormaClient`)
    /// rather than a raw wire discriminator (`NormaSessionClient`, which handles payloads
    /// opaquely). The two halves are proven equivalent by `SessionEventTransientTests`, which
    /// round-trips every variant through the encoder and asserts
    /// `transientTypes.contains(type) == isTransient` — so this switch cannot drift from the set
    /// above, in either direction.
    public var isTransient: Bool {
        switch self {
        case .assistantDelta, .leaseGranted, .leaseLost, .peripheralCallRequested,
             .pluginToolInvoke, .hardwareRequested, .pluginTileUpdated, .sessionActivity,
             .panelCommand:
            return true
        default:
            return false
        }
    }
}
