import type { ApprovalOption } from "@yanlinglabs/winter-protocol";

export interface ApprovalOutcome {
  approved: boolean;
  by: string;
  // working-directories Task 6.5: which `ApprovalOption.id` (events.ts) the caller chose, threaded
  // from `approval.respond`'s `optionId` (server.ts) through `resolve()` so an `onApprove` closure
  // that offers MULTIPLE meaningfully-different approved outcomes on the SAME card (the with-dirs
  // dirGrant card's new `allow_add_dir` beside its `allow_once`) can branch on which one was picked
  // — `approved: true` alone can't distinguish them. Optional/additive: every pre-existing caller
  // (server.ts's other approvals, tests, the emit-failure resolve below) omits it and behaves
  // exactly as before — `undefined` is indistinguishable from "no options were ever offered".
  optionId?: string;
}

/** A currently-pending approval, as returned by `ApprovalBroker.list()` and the `approval.list`
 *  RPC — the queryable STATE the report's approval contract asks for (pending approvals age out of
 *  the event stream, so a phone that reconnects can't reconstruct them from replay alone).
 *  `expiresAt` is the fail-closed deadline (epoch ms); a phone renders "expires in Ns" and derives
 *  `.expired` from it without waiting for the `approval_resolved{by:"timeout"}` event. */
export interface PendingApproval {
  callId: string;
  toolName: string;
  summary: string;
  issuedAt: number;   // epoch ms the approval was requested
  expiresAt: number;  // epoch ms the broker will fail it closed (issuedAt + timeoutMs)
  // SP-approvals T4: mirrors `ApprovalRequestedEvent.options`/`PendingApprovalSchema.options`
  // (protocol's events.ts/methods.ts) field-for-field — see that field's own doc comment. Undefined
  // for grant/worktree/reviewer-escalation waits (Task 5 passes no options for those) and for any
  // plain-tool wait where nothing rule-worthy applies.
  options?: ApprovalOption[];
}

/** Optional metadata threaded from the emit site (engine.ts/daemon.ts) so a pending approval is
 *  listable + carries its deadline. Omitted by callers that don't need listing (direct unit tests);
 *  the broker then falls back to `Date.now()`/`+timeoutMs` and empty tool/summary strings. */
export interface WaitMeta { toolName: string; summary: string; issuedAt: number; expiresAt: number; options?: ApprovalOption[] }

interface PendingEntry {
  sessionId: string;
  callId: string;
  resolve: (o: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  summary: string;
  issuedAt: number;
  expiresAt: number;
  options?: ApprovalOption[];
}

/** In-flight approval requests, keyed by sessionId+callId. First response wins (spec §4.10).
 *
 *  Approval identity + compare-and-set: an approval is identified by its `(sessionId, callId)` for
 *  its whole life — the callId never mutates or is reused — so `callId` IS the compare-and-set token
 *  the report's contract calls `expectedVersion`, and `resolve()`'s `{ok, alreadyResolved}` already
 *  IS its "a second answer → AlreadyResolved" semantics (an answer for an already-settled callId
 *  reports `alreadyResolved:true`). There is deliberately NO redundant numeric `version` field:
 *  callId + alreadyResolved subsumes it (SP3 T4b design decision). */
export class ApprovalBroker {
  private pending = new Map<string, PendingEntry>();

  private key(sessionId: string, callId: string): string { return `${sessionId}:${callId}`; }

  wait(sessionId: string, callId: string, timeoutMs: number, meta?: WaitMeta): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const k = this.key(sessionId, callId);
      const timer = setTimeout(() => {
        this.pending.delete(k);
        resolve({ approved: false, by: "timeout" }); // fail-closed: no answer means no
      }, timeoutMs);
      const issuedAt = meta?.issuedAt ?? Date.now();
      this.pending.set(k, {
        sessionId, callId, resolve, timer,
        toolName: meta?.toolName ?? "",
        summary: meta?.summary ?? "",
        issuedAt,
        expiresAt: meta?.expiresAt ?? issuedAt + timeoutMs,
        options: meta?.options,
      });
    });
  }

  resolve(sessionId: string, callId: string, approved: boolean, by: string, optionId?: string): { ok: true; alreadyResolved: boolean } {
    const k = this.key(sessionId, callId);
    const entry = this.pending.get(k);
    if (!entry) return { ok: true, alreadyResolved: true };
    this.pending.delete(k);
    clearTimeout(entry.timer);
    entry.resolve({ approved, by, optionId });
    return { ok: true, alreadyResolved: false };
  }

  /** The currently-pending approvals for a session (queryable state — see `PendingApproval`).
   *  Timed-out/resolved entries have already been removed from the map, so a stale approval never
   *  appears here. Order is insertion order (Map iteration). */
  list(sessionId: string): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const e of this.pending.values()) {
      if (e.sessionId !== sessionId) continue;
      out.push({ callId: e.callId, toolName: e.toolName, summary: e.summary, issuedAt: e.issuedAt, expiresAt: e.expiresAt, options: e.options });
    }
    return out;
  }

  /** SP-approvals T4: the stored meta for ONE still-pending approval, WITHOUT resolving it —
   *  Task 5's `approval.respond` handler needs to look up the chosen `optionId`'s `rule`/`scope`
   *  BEFORE deciding whether to persist a permission rule, but must leave the entry untouched for
   *  the `resolve()` call that follows right after (a lookup here must never itself count as an
   *  answer). Returns `undefined` when there is no pending entry for this identity — already
   *  resolved, timed out, or never existed (same "second answer is a no-op" shape `resolve()`
   *  degrades to via `alreadyResolved`, just without mutating anything here). */
  pendingMeta(sessionId: string, callId: string): PendingApproval | undefined {
    const e = this.pending.get(this.key(sessionId, callId));
    if (!e) return undefined;
    return { callId: e.callId, toolName: e.toolName, summary: e.summary, issuedAt: e.issuedAt, expiresAt: e.expiresAt, options: e.options };
  }
}

// ---------------------------------------------------------------------------------------------
// The card CONTENT builders (Winter Phase 8b Task 8).
//
// These three are LITERAL COPIES of `engine.ts`'s own private `approvalCardSummary`,
// `BASH_PREFIX_MULTI_WORD_HEADS`/`suggestBashPrefix` and `approvalOptionsFor` — the helpers that
// compose what a human actually reads on an approval card and what choosing an option persists.
// The Winter approval bridge (`runtime-sdk/approval-bridge.ts`) is a SECOND producer of
// `approval_requested` and needs exactly this text; engine.ts is deleted in Task 17, so the copies
// are made HERE (beside the broker they feed) rather than by exporting out of a module that is
// about to disappear. **Deliberate one-phase duplication:** engine.ts keeps its private copies
// untouched — nothing about the engine leg changes — and they go away with the engine. Any edit to
// the card text during that window must be made in BOTH places until then.
// ---------------------------------------------------------------------------------------------

const WORKFLOW_TOOL = "Workflow";

/** The one-line human-readable summary on an approval card. Copy of engine.ts's private
 *  `approvalCardSummary`; `call.name` is a WINTER tool name (`runtime-sdk/tool-names.ts` normalizes
 *  a Winter name before this is called) and `argsJson` the call's raw JSON arguments. */
export function approvalCardSummary(call: { name: string; argsJson: string }): string {
  const oneLine = (s: string) => s.split(/\r?\n/).join(" ").trim();
  if (call.name === "skill_write") {
    try {
      const a = JSON.parse(call.argsJson || "{}") as { name?: unknown; description?: unknown; body?: unknown };
      if (typeof a.name === "string" && typeof a.description === "string" && typeof a.body === "string") {
        return `skill_write "${oneLine(a.name)}" — ${oneLine(a.description).slice(0, 200)} [body: ${a.body.length} chars — not shown; review in dashboard after approving]`;
      }
    } catch { /* malformed argsJson → generic slice below */ }
  }
  if (call.name === "bash") {
    try {
      const a = JSON.parse(call.argsJson || "{}") as { command?: unknown; allowNetwork?: unknown; dangerouslyDisableSandbox?: unknown };
      if (typeof a.command === "string" && oneLine(a.command) !== "") {
        const cmd = oneLine(a.command).slice(0, 120);
        if (a.dangerouslyDisableSandbox === true) return `bash (UNSANDBOXED): ${cmd}`;
        if (a.allowNetwork === true) return `bash (with network): ${cmd}`;
        return `bash ${cmd}`;
      }
    } catch { /* malformed argsJson → generic slice below */ }
  }
  if (call.name === WORKFLOW_TOOL) {
    try {
      const a = JSON.parse(call.argsJson || "{}") as { script?: unknown; name?: unknown };
      if (typeof a.script === "string" && oneLine(a.script.split(/\r?\n/)[0] ?? "") !== "") {
        const label = typeof a.name === "string" && oneLine(a.name) !== "" ? ` "${oneLine(a.name)}"` : "";
        const firstLine = oneLine(a.script.split(/\r?\n/)[0] ?? "").slice(0, 120);
        return `Workflow${label}: ${firstLine}`;
      }
    } catch { /* malformed argsJson → generic slice below */ }
  }
  return `${call.name} ${call.argsJson.slice(0, 160)}`;
}

const BASH_PREFIX_MULTI_WORD_HEADS = new Set([
  "git", "npm", "pnpm", "cargo", "docker", "kubectl", "brew", "bun", "swift", "xcodebuild", "gh", "make",
]);

/** The `Bash(<prefix>:*)` rule suggested on a bash card — first token alone, or first+second for a
 *  well-known multi-word CLI head. Copy of engine.ts's exported `suggestBashPrefix`. */
export function suggestBashPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const head = tokens[0]!;
  return tokens.length > 1 && BASH_PREFIX_MULTI_WORD_HEADS.has(head) ? `${head} ${tokens[1]}` : head;
}

/** The "always allow" choices offered alongside plain approve/deny. Copy of engine.ts's private
 *  `approvalOptionsFor`: bash only — every other tool name returns `undefined` (a plain
 *  approve/deny card). `rule`/`scope` mirror exactly what choosing the option persists through
 *  `approval.respond`'s `PermissionRules.append` — the ONE rules-store writer. */
export function approvalOptionsFor(call: { name: string; argsJson: string }): ApprovalOption[] | undefined {
  if (call.name === "bash") {
    let command = "";
    try {
      const a = JSON.parse(call.argsJson || "{}") as { command?: unknown };
      if (typeof a.command === "string") command = a.command;
    } catch { /* malformed argsJson → suggestBashPrefix("") below yields "", same degenerate case */ }
    const rule = `Bash(${suggestBashPrefix(command)}:*)`;
    return [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: `Allow "${rule}" in this project`, rule, scope: "project" },
      { id: "allow_global", label: `Allow "${rule}" everywhere`, rule, scope: "global" },
      { id: "deny", label: "Deny" },
    ];
  }
  return undefined;
}
