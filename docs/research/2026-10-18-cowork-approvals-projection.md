# Cowork approvals projected into the approval bridge (behind the refusal)

Date: 2026-10-18. Status: source and tests; reachable only through an injected port that production never supplies.

Inputs: the Cowork host policy matrix and transition machine (`docs/research/2026-10-16-cowork-host-policy.md`), `docs/cowork-execution-contracts.md` "Approval policies", `docs/cowork-spec.md` (approval cards, occupancy, unattended work), `docs/claude/tool-surface.md`, `docs/claude/island.md`.

## What was built

- `packages/core/src/runtime-sdk/cowork-approval.ts` (new, pure): `projectCoworkCall(ports, call)` turns one `canUseTool` request into allow, ask or deny from `coworkHostDecision`, `coworkConnectorVerdict` and the transition machine's snapshot. `CoworkApprovalPorts` is what the host supplies per conversation: `identity()`, `snapshot()`, `classifyPath()`, optional `explicit()` and `planViewInstalled()`.
- `packages/core/src/runtime-sdk/approval-bridge.ts`: a new optional `deps.cowork`. When present, every request except `AskUserQuestion` takes the Cowork route; when absent the file behaves exactly as before (the existing approval tests are unchanged and green). `raiseCard` gained three optional, Cowork-only knobs: a summary prefix, an explicit park bound and a revalidation hook.
- `packages/core/src/cowork/instructions.ts`: `agentScope()` now asks the matrix for the shared-guidance edit column instead of carrying its own `plan`/`dont-ask` literal, closing the "two sources of truth" note from the host policy doc. Behaviour is identical (Deny under plan and dont-ask, Ask otherwise).

## Order of decisions

1. A narrowing in flight (pending, or failed with admission not `open`): deny. The old, broader state is never used to admit new work while its replacement is installed (`transition_pending`, `restart_required`).
2. `dangerouslyDisableSandbox: true` on Bash: deny in every policy. Bash `allowNetwork: true` under a `none` network ceiling: deny.
3. Connector action: the Cowork connector row, inside the ceiling's `connectors` grant (not listed: deny). An explicit ask stays a card under bypass.
4. Read/Glob/Grep, Write, Edit/MultiEdit, Bash, Workflow: the policy matrix. Glob and Grep also classify the literal prefix of `pattern` / `glob` (an ALLOWLIST: only `[A-Za-z0-9._ -]`, `*`, `?` and `/` are accepted, anywhere; braces, extglob groups, brackets, `|`, `\`, `~` and `!` name the filesystem root and are denied, whether the guest tools expand them or not; otherwise the prefix is resolved against the cwd, and a `..` after the first wildcard also names the root), and every reached path must pass. The host classifies the target path; relative paths resolve against the conversation's cwd. A file tool with no resolvable target is `none`, which the matrix denies.
5. Anything else is an unknown class: deny under every policy, bypass included.

## How decisions reach the clients (no new event, no protocol field)

- deny: a typed `PermissionResult` deny, no event, no broker entry. Plan and dont-ask use the bridge's existing wording; the other reasons have their own text in `coworkDeniedMessage` (no paths, no secrets).
- allow: silent.
- ask: the existing `approval_requested` / `approval_resolved`, answered by `approval.respond`. The summary leads with `Cowork workspace <id> (source revision <n>, agent <id|main>) — `, which is how the card identifies workspace, source revision and requesting agent. Cards are plain Allow/Deny: a saved rule is never host authority in Cowork. The card sits in the same broker, so `approval.list`, the island registry and `island.pending` show it with no change (tested with a real `IslandRegistry`).
- unattended turn (any origin that is not a person's, or unknown): the card is raised and bounded at the dispatch family's 10 minutes and times out to a typed deny. It is never turned into an allow.
- revalidation: when a yes arrives, the call is projected again; if the policy narrowed meanwhile the answer becomes a deny (`approval_resolved{approved:false, by:"policy-changed"}`, no `interrupt`).
- `AskUserQuestion` and `ExitPlanMode` keep the question bridge and the plan bridge.

## Why the Mac fences and the gate are skipped

The control-plane fence, the home fence and the protected-write checks judge Mac paths against Mac settings; a guest path is judged by the matrix and by the mount views. The gate classifies host tool names. The spec says the Cowork check must not be replaced by the SDK's or the gate's blanket behaviour.

## Behind the refusal

`session.create {mode:"cowork"}` and the driver still refuse (`unsupported_topology`). The one production constructor of the bridge (`session-driver.ts`) never passes `cowork`. `test/runtime-sdk/cowork-approval.test.ts` proves it by scanning the source, and that the projection module is imported only by the bridge. The two older anti-wiring pins moved from "no importer" to a named allow-list: the matrix is reached by `policy-transition.ts`, `instructions.ts` and `cowork-approval.ts`; the transition module by `cowork-approval.ts` (a type) only.

## NEEDS FROM OTHER LANE (DOOR: `session-driver.ts`, `mode-options.ts`, hooks)

1. When Cowork is activated, the driver builds `CoworkApprovalPorts` for the conversation and passes `cowork` to `canUseToolFor`. Required members: `identity()` from the binding and workspace revision, `snapshot()` from a per-conversation `CoworkPolicyTransitionMachine`, `classifyPath()` from the admitted roots (it must return `admitted`, `shared-instructions`, `outputs`, `scratch`, `protected` or `outside`), and `planViewInstalled()` from the plan execution view. It must also pass `turnOrigin` (an unknown origin is bounded to 10 minutes).
2. Under `bypassPermissions`, `auto` and a saved allow rule the child never calls `canUseTool` for an allowed tool, so the matrix must also run before execution. Register a PreToolUse hook that calls `projectCoworkCall` and maps `deny` to `permissionDecision: "deny"`, `ask` to `"ask"` and `allow` to nothing (and `allow` with `bashReview` to the existing Bash reviewer hook). The connector floor hook for Cowork must use `coworkConnectorVerdict`, not `connectorVerdict`.
3. A tool-surface decision for the tools the matrix leaves unknown (see below).
4. Path classes are lexical (the projection resolves `.`/`..` against the cwd and classifies the string). Symlinks are the host classifier's and the mount view's to own; a symlink inside an admitted root that points at protected state must be refused by them.
5. `bashReview` on an allow is advisory here: under `auto` the review itself depends on the PreToolUse reviewer hook DOOR owes (item 2); the bridge ignores the flag on an allow.

No `cowork/types.ts` code, no protocol field and no `SessionEvent` is needed.

## Owner decisions

1. Tools with no matrix class are denied: web tools, `Agent`, `Task*`, `Skill`, `ToolSearch`, `NotebookEdit`, `LSP`, `SendMessage` and Winter's own default tools (`advisor`, `ReadNotifications`). That is what the spec says ("Unknown tool classes are not silently admitted"), but it will make a Cowork conversation very quiet. Recommendation: give the read-only orchestration tools (`ToolSearch`, `Skill`, `Task*`) a read-only class once the table has a cell for them, and keep the rest denied.
2. `outputs` and a non-plan `scratch` remain denied until the policy table gets explicit cells (the host policy doc's decision 6).
3. Unattended cards time out after 10 minutes; an unknown turn origin counts as unattended. Recommendation: keep.

## Docs owed

`docs/claude/cowork.md` and the ledgers should say: the approval bridge has a Cowork route behind an injected `cowork` port, production never supplies it; the decision table lives in `cowork/host-policy.ts` and `cowork/policy-transition.ts`; `CoworkInstructions.agentScope` asks the matrix; the PreToolUse hook, the port construction and the tool mapping remain for the DOOR lane.
