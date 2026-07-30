import { z } from "zod";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionEvent } from "../src/events";
import { buildCleanerVectorsFixture, buildDangerousDomainsFixture } from "./parity-fixtures";

const outDir = join(import.meta.dir, "..", "generated");
const fixDir = join(outDir, "fixtures");
mkdirSync(fixDir, { recursive: true });

// 1. JSON Schema (for quicktype / external consumers)
const schema = z.toJSONSchema(SessionEvent);
writeFileSync(join(outDir, "session-event.schema.json"), JSON.stringify(schema, null, 2));

// 2. Canonical fixtures — one per variant; Swift must decode + re-encode all of them.
const base = { seq: 7, sessionId: "s_fixture", ts: 1781270000000 };
const fixtures: Record<string, unknown> = {
  "session_created": { ...base, type: "session_created", scope: "global" },
  // Dispatch durability follow-up: mode is additive/optional on the EXISTING session_created
  // shape — a dedicated fixture (distinct from session_created.json above) so Swift round-trips
  // one carrying it, mirroring approval_requested_with_reviewer_reason's with/without pattern.
  "session_created_with_mode": { ...base, type: "session_created", scope: "global", mode: "dispatch" },
  "harness_attached": { ...base, type: "harness_attached", clientName: "orb" },
  "harness_detached": { ...base, type: "harness_detached", clientName: "orb" },
  "user_message": { ...base, type: "user_message", threadId: "main", text: "héllo \"world\" — done ✓", clientName: "cli-1" },
  "turn_started": { ...base, threadId: "main", type: "turn_started" },
  "assistant_message": { ...base, threadId: "main", type: "assistant_message", text: "done ✓" },
  "assistant_delta": { ...base, threadId: "main", type: "assistant_delta", delta: "wor" },
  "tool_call": { ...base, threadId: "main", type: "tool_call", callId: "call_1", name: "read", argsJson: '{"path":"a.txt"}' },
  "tool_result": { ...base, threadId: "main", type: "tool_result", callId: "call_1", output: "line1\nline2", isError: false },
  // SP3 T4b review fix (Phase-A CRITICAL): this BASE fixture deliberately carries NO issuedAt/
  // expiresAt — it is the pre-T4b persisted shape, and Swift round-tripping it proves an OLD
  // session-JSONL approval_requested still decodes with the fields ABSENT (they are optional).
  // The two _with_* fixtures below carry both fields (the shape every NEW daemon emit has), same
  // with/without pattern as approval_requested_with_reviewer_reason.
  "approval_requested": { ...base, threadId: "main", type: "approval_requested", callId: "call_2", toolName: "write", summary: "write a.txt" },
  // Phase 5e T1: reviewerReason is additive/optional on the EXISTING approval_requested shape — a
  // dedicated fixture (distinct from approval_requested.json above) so Swift round-trips one
  // carrying it, mirroring task_with_graph_fields/question_with_preview's with/without pattern.
  "approval_requested_with_reviewer_reason": { ...base, threadId: "main", type: "approval_requested", callId: "call_31", toolName: "bash", summary: "run rm -rf /tmp/scratch", issuedAt: 1781270000000, expiresAt: 1781270300000, reviewerReason: "recursive delete outside the session cwd" },
  "approval_resolved": { ...base, threadId: "main", type: "approval_resolved", callId: "call_2", approved: true, by: "orb" },
  "turn_completed": { ...base, threadId: "main", type: "turn_completed", stopReason: "end_turn", inputTokens: 12, outputTokens: 3 },
  "agent_error": { ...base, threadId: "main", type: "agent_error", message: "provider unavailable" },
  "directory_added": { ...base, threadId: "main", type: "directory_added", path: "/opt/data", persisted: true },
  "bg_task_started": { ...base, threadId: "main", type: "bg_task_started", taskId: "bg_a1", command: "npm run dev" },
  "bg_task_output":  { ...base, threadId: "main", type: "bg_task_output",  taskId: "bg_a1", chunk: "listening on :3000\n" },
  "bg_task_exited":  { ...base, threadId: "main", type: "bg_task_exited",  taskId: "bg_a1", exitCode: 0, killed: false },
  checkpoint: { ...base, type: "checkpoint", threadId: "main", summary: "Earlier: set up the repo; decided to use Bun.", uptoSeq: 5 },
  question_asked: { type: "question_asked", sessionId: "s_1", threadId: "t_1", seq: 10, ts: 1700000000000, callId: "call_1",
    questions: [{ question: "Which codename?", header: "Codename", options: [{ label: "Falcon" }, { label: "Osprey", description: "the bird" }], multiSelect: false },
                { question: "Which features?", header: "Features", options: [{ label: "A", description: "first" }, { label: "B" }, { label: "C" }], multiSelect: true }] },
  question_resolved: { type: "question_resolved", sessionId: "s_1", threadId: "t_1", seq: 11, ts: 1700000000001, callId: "call_1", answers: { "Which codename?": "Osprey", "Which features?": "A, C" }, by: "cli" },
  // CC AskUserQuestion parity: per-option `preview` (the "visual scheme on the right") is
  // optional/additive — a dedicated fixture so Swift round-trips a question_asked option that
  // carries one.
  question_with_preview: { type: "question_asked", sessionId: "s_1", threadId: "t_1", seq: 28, ts: 1700000000018, callId: "call_2",
    questions: [{ question: "Which layout?", header: "Layout", multiSelect: false,
      options: [{ label: "Sidebar", description: "nav on the left", preview: "┌──┬────┐\n│▮ │    │\n└──┴────┘" }, { label: "Topbar" }] }] },
  // Slice B1: chat's AskQuestion emits a SIMPLIFIED card — no `header` chip, no per-option
  // `description`, single-select. A dedicated fixture so Swift round-trips a header-less question.
  question_simplified: { type: "question_asked", sessionId: "s_1", threadId: "t_1", seq: 30, ts: 1700000000020, callId: "call_3",
    questions: [{ question: "Which tier should I compare against?", multiSelect: false,
      options: [{ label: "Free" }, { label: "Pro" }] }] },
  // CC AskUserQuestion parity: per-answer `notes` ("press n to add notes") is optional/additive —
  // a dedicated fixture (distinct from question_resolved above) so Swift round-trips a
  // question_resolved carrying notes.
  question_resolved_with_notes: { type: "question_resolved", sessionId: "s_1", threadId: "t_1", seq: 29, ts: 1700000000019, callId: "call_2",
    answers: { "Which layout?": "Sidebar" }, notes: { "Which layout?": "prefer the nav on the left" }, by: "cli" },
  task_updated: { type: "task_updated", sessionId: "s_1", threadId: "t_1", seq: 12, ts: 1700000000002, task: { id: "1", subject: "rename the project", status: "in_progress", activeForm: "Renaming the project" } },
  // T3 review fix wave 1: task_update{status:"deleted"} now emits a task_updated event carrying
  // this status (see events.ts's TaskSchema doc comment) — a separate fixture (distinct file from
  // task_updated.json above) so Swift round-trips a "deleted" Task.status too.
  task_deleted: { type: "task_updated", sessionId: "s_1", threadId: "t_1", seq: 27, ts: 1700000000017, task: { id: "3", subject: "throwaway task", status: "deleted" } },
  // Task-graph fields (4h-ii-d, CC parity): Task gains owner/blocks/blockedBy/metadata, all
  // optional/additive — a dedicated fixture (distinct from task_updated.json above) so Swift
  // round-trips a Task carrying all four alongside the pre-existing fields.
  task_with_graph_fields: { type: "task_updated", sessionId: "s_1", threadId: "t_1", seq: 30, ts: 1700000000020,
    task: { id: "4", subject: "wire the task graph", status: "in_progress", activeForm: "Wiring the task graph",
      owner: "researcher", blocks: ["5", "6"], blockedBy: ["2"], metadata: { priority: "high", sprint: 12 } } },
  plan_presented: { type: "plan_presented", sessionId: "s_1", threadId: "t_1", seq: 13, ts: 1700000000003, callId: "call_1", plan: "# Plan\n\n1. Add the flag\n2. Wire it up\n3. Test" },
  plan_resolved: { type: "plan_resolved", sessionId: "s_1", threadId: "t_1", seq: 14, ts: 1700000000004, callId: "call_1", approved: true, feedback: "looks good", autoAccept: true, by: "cli" },
  worktree_entered: { type: "worktree_entered", sessionId: "s_1", threadId: "t_1", seq: 15, ts: 1700000000005, name: "fix-auth", path: "/repo/.norma/worktrees/fix-auth", branch: "norma/fix-auth" },
  worktree_exited: { type: "worktree_exited", sessionId: "s_1", threadId: "t_1", seq: 16, ts: 1700000000006, name: "fix-auth", action: "keep", removed: false },
  thread_started: { type: "thread_started", sessionId: "s_1", threadId: "th_child1", seq: 17, ts: 1700000000007, parentThreadId: "main", agentType: "researcher", prompt: "Summarize the auth module" },
  thread_completed: { type: "thread_completed", sessionId: "s_1", threadId: "th_child1", seq: 18, ts: 1700000000008, stopReason: "end_turn" },
  // task-16 (Stalled roster verb, CC-parity follow-up): "stalled" is a NEW VALUE on the EXISTING
  // thread_completed shape (not a new field, not a new variant) — a dedicated fixture (distinct
  // from thread_completed.json above, which stays "end_turn") so Swift round-trips a
  // stopReason:"stalled" thread_completed. stopReason decodes as a plain String on the Swift side
  // (SessionEvent.swift's ThreadCompleted), so this fixture proves the new VALUE survives
  // round-trip rather than proving a new enum CASE compiles.
  thread_completed_stalled: { type: "thread_completed", sessionId: "s_1", threadId: "th_child2", seq: 32, ts: 1700000000022, stopReason: "stalled" },
  session_titled: { type: "session_titled", seq: 9, sessionId: "s_1", ts: 5, threadId: "main", title: "Fixing the login flow" },
  lease_granted: { type: "lease_granted", sessionId: "s_1", threadId: "main", seq: 19, ts: 1700000000009, leaseId: "lease_1", class: "screenshot", holder: { kind: "session", id: "s_1" }, expiresAt: 1700000000024, tokenHash: "9aefbca72caebab86c15bc0c60c8b7c3de90040152b1be9d9ada3769dedde18d" },
  lease_lost: { type: "lease_lost", sessionId: "s_1", threadId: "main", seq: 20, ts: 1700000000010, leaseId: "lease_1", class: "screenshot", holder: { kind: "session", id: "s_1" }, reason: "expired" },
  peripheral_call_requested: { type: "peripheral_call_requested", sessionId: "s_1", threadId: "main", seq: 21, ts: 1700000000011, requestId: "req_1", leaseId: "lease_1", token: "tok_9f3a7c2e1b", class: "noop", payloadJson: "{}" },
  plugin_tool_invoke: { type: "plugin_tool_invoke", sessionId: "s_1", threadId: "main", seq: 22, ts: 1700000000012, requestId: "req_2", tool: "echo", argsJson: '{"text":"hi"}' },
  hardware_requested: { type: "hardware_requested", sessionId: "s_1", threadId: "main", seq: 23, ts: 1700000000013, requestId: "req_3", verb: "setChargeLimit", argsJson: '{"percent":80}' },
  plugin_tile_updated: { type: "plugin_tile_updated", sessionId: "$system", seq: 24, ts: 1700000000014, pluginId: "sample-echo", tile: { title: "Sample", value: "1", enabled: true } },
  shortcut_invoke: { type: "shortcut_invoke", sessionId: "$system", seq: 25, ts: 1700000000015, shortcutId: "toggle-mute" },
  tile_action: { type: "tile_action", sessionId: "$system", seq: 26, ts: 1700000000016, actionId: "reconnect" },
  // Phase 5e T1 (reviewer maturity — the NormaKit-trap task): a NEW SessionEvent variant, unlike
  // reasoning_item/task_notification above — NOT sensitive (no encrypted_content), so a normal
  // fixture is correct here (see this variant's own doc comment in events.ts).
  tool_review: { type: "tool_review", sessionId: "s_1", threadId: "t_1", seq: 31, ts: 1700000000021, toolName: "bash", verdict: "unsafe", reason: "recursive delete outside the session cwd", summary: "bash rm -rf /tmp/scratch" },
  // task-30 (push-notification track — the final CC-parity tool item): a NEW SessionEvent
  // variant, same full switch-trap discipline as tool_review above. NOT sensitive — a normal
  // fixture.
  notification_requested: { type: "notification_requested", sessionId: "s_1", threadId: "t_1", seq: 33, ts: 1700000000023, title: "Norma", message: "Long-running migration finished — 12,004 rows updated." },
  "child_update": { ...base, threadId: "main", type: "child_update", childSessionId: "s_child000001", status: "completed", title: "Fix login bug", resultSummary: "Fixed the null token check; tests pass." },
  // Dispatch relay (Phase 7): childSessionId is additive/optional on the four existing
  // approval/question shapes — dedicated with-fixtures so Swift round-trips carriers, mirroring
  // approval_requested_with_reviewer_reason's with/without pattern.
  "approval_requested_with_child_session": { ...base, threadId: "main", type: "approval_requested", callId: "call_40", toolName: "bash", summary: "run rm -rf node_modules", issuedAt: 1781270000000, expiresAt: 1781270300000, childSessionId: "s_child000001" },
  "approval_resolved_with_child_session": { ...base, threadId: "main", type: "approval_resolved", callId: "call_40", approved: true, by: "orb", childSessionId: "s_child000001" },
  "question_asked_with_child_session": { ...base, threadId: "main", type: "question_asked", callId: "call_41", questions: [{ question: "Which package manager?", header: "PkgMgr", options: [{ label: "pnpm", description: "workspace default" }, { label: "npm", description: "plain" }], multiSelect: false }], childSessionId: "s_child000001" },
  "question_resolved_with_child_session": { ...base, threadId: "main", type: "question_resolved", callId: "call_41", answers: { "Which package manager?": "pnpm" }, by: "orb", childSessionId: "s_child000001" },
  // SP-approvals T4: `options` is additive on the EXISTING approval_requested shape — mirrors the
  // reviewerReason/childSessionId with/without pattern above. One rule-bearing option (rule+scope,
  // the shape Task 5's `approvalOptionsFor` mints for a bash escalation) and one bare allow_once
  // option (no rule/scope — grants nothing durable), so Swift round-trips both option flavors.
  "approval_requested_with_options": { ...base, threadId: "main", type: "approval_requested", callId: "call_50", toolName: "bash", summary: "run git push origin main", issuedAt: 1781270000000, expiresAt: 1781270300000, options: [
    { id: "allow_once", label: "Allow once" },
    { id: "allow_project", label: "Always allow \"git push\" in this project", rule: "Bash(git push:*)", scope: "project" },
  ] },
  // CC-parity phase 3 (Workflows, Track D Task D1 — another NormaKit-trap task like tool_review/
  // notification_requested above): 4 NEW SessionEvent variants mirroring the daemon's onEvent
  // rewire of WorkflowRuntimeEvent's started/progress/completed/failed onto the wire.
  "workflow_started": { ...base, threadId: "main", type: "workflow_started", runId: "wf_a1b2c3", name: "triage", summary: "Triage 20 files in parallel" },
  "workflow_progress": { ...base, threadId: "main", type: "workflow_progress", runId: "wf_a1b2c3", phase: "synthesize", log: "merging findings", running: 3, completed: 17, total: 20 },
  "workflow_completed": { ...base, threadId: "main", type: "workflow_completed", runId: "wf_a1b2c3", resultSummary: "12 issues found across 20 files; report written." },
  "workflow_failed": { ...base, threadId: "main", type: "workflow_failed", runId: "wf_a1b2c3", error: "workflow exceeded the per-run agent cap (1000)" },
};
for (const [name, value] of Object.entries(fixtures)) {
  SessionEvent.parse(value); // fixtures must be valid by construction
  writeFileSync(join(fixDir, `${name}.json`), JSON.stringify(value, null, 2));
}

// 2b. Cross-language parity fixtures (Chat Slice D, Task 4) — anchors for the upcoming Swift ports
// of the shipped dangerous-domain list and the html cleaner (page-core.ts's htmlToText/renderLines
// pipeline). Both values are COMPUTED from the live TS implementations at generate time (never
// hand-copied) via packages/protocol/scripts/parity-fixtures.ts, the ONE place that imports across
// the protocol->core boundary — see that file's own doc comment for why that's safe here.
// Written into the SAME fixtures/ directory as the SessionEvent fixtures above, but deliberately
// NOT added to the `fixtures` map itself and NOT swept into the Swift NormaProtocol test bundle
// below: RoundTripTests.swift decodes EVERY .json file it finds under Fixtures/ as a SessionEvent
// and asserts an exact count of 56 — these two are a different shape entirely, so the sync step
// below now copies the SessionEvent set explicitly (never a blanket directory copy) to keep that
// gate byte-for-byte unchanged. A later task wires these two into their own Swift consumer.
writeFileSync(join(fixDir, "dangerous-domains.json"), JSON.stringify(buildDangerousDomainsFixture(), null, 2));
const cleanerVectors = buildCleanerVectorsFixture();
writeFileSync(join(fixDir, "cleaner-vectors.json"), JSON.stringify(cleanerVectors, null, 2));

// 3. Sync fixtures into the Swift test bundle — the SessionEvent per-variant fixtures ONLY (see
// the comment above): a blanket directory copy would also carry dangerous-domains.json/
// cleaner-vectors.json into RoundTripTests.swift's Fixtures/, which decodes every file there as a
// SessionEvent and hard-asserts a count of 56.
const swiftFixDir = join(import.meta.dir, "..", "..", "..", "apple", "NormaProtocol", "Tests", "NormaProtocolTests", "Fixtures");
rmSync(swiftFixDir, { recursive: true, force: true }); // delete-then-copy: no orphaned fixtures after variant renames
mkdirSync(swiftFixDir, { recursive: true });
for (const name of Object.keys(fixtures)) {
  cpSync(join(fixDir, `${name}.json`), join(swiftFixDir, `${name}.json`));
}
console.log(
  `generated: schema + ${Object.keys(fixtures).length} fixtures (synced to Swift test bundle) + ` +
    `dangerous-domains (${buildDangerousDomainsFixture().length} entries) + cleaner-vectors (${cleanerVectors.length} vectors)`,
);
