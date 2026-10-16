# Cowork host policy matrix, connector row and narrowing transitions (unwired)

Date: 2026-10-16. Status: source and tests only. Nothing in `src/` imports these modules; the PR keeps them unwired.

Spec sources: `docs/cowork-execution-contracts.md`, "Approval policies" (the policy table, the unknown-class and Workflow paragraphs, the connector table and the final narrowing paragraph) and `docs/cowork-spec.md` (shared instructions, host authority). Cell text is quoted below so a change of line numbers stays checkable.

## What was built

| File | Role |
| --- | --- |
| `packages/core/src/cowork/host-policy.ts` | Pure decision `coworkHostDecision` (policy x tool class x path class x effective ceiling) and `coworkConnectorVerdict(setting, readOnly, policy)`. |
| `packages/core/src/cowork/policy-transition.ts` | `classifyCoworkPolicyChange` (cell-wise narrowing/widening classifier) and `CoworkPolicyTransitionMachine` (pending transition with injected `closeAdmission`, `drain`, `installView` ports). |
| `packages/core/src/cowork/instructions.ts` | One-line fix in `agentScope()`: an agent's shared-guidance edit is refused under `dont-ask` as well as `plan`. |

## The matrix

Spec table, cell text verbatim (admitted reads / ordinary workspace edits / other admitted guest actions / shared workspace instruction edit):

| Policy | Reads | Edits | Other | Instruction edit |
| --- | --- | --- | --- | --- |
| plan | Allow | Deny | Planning/read operations only | Deny |
| dont-ask | Allow | Only if already authorized without a prompt | Deny anything needing a prompt | Deny |
| ask | Allow | Ask unless already authorized | Ask unless already authorized | Ask |
| accept-edits | Allow | Allow the bounded edit class | Ask unless already authorized | Ask |
| auto | Allow | Allow | Normal mutation class allowed; Bash review below; Workflow still asks | Ask |
| bypass | Allow | Allow | Skip ordinary prompts within grants | Ask |

Tool classes: `Read`, `Write`, `Edit`, `Bash`, `Workflow`, `InstructionEdit` (the host's content-bound `workspace.instructions.update`). Anything else is an unknown class and is denied. Path classes: `admitted`, `shared-instructions`, `outputs`, `scratch`, `protected`, `outside`, `none`.

Order of evaluation, each step beating every later one (bypass included):

1. unknown policy, tool class or path class: deny ("Unknown tool classes are not silently admitted.");
2. a saved explicit deny: deny ("Explicit deny ... apply under every policy");
3. `protected` or `outside` path: deny ("`bypass` never disables Linux control-state confinement or grants access to the Mac.");
4. the effective ceiling lacks the class: deny ("Skip ordinary prompts within grants"). Read needs `read`, Write `write`, Edit `read`+`write` (as `confinedToolVisibility` shows them), Bash and Workflow `execute`, InstructionEdit `write` plus the host service `workspace.instructions.update` (as `CoworkInstructions.agentScope` checks);
5. `outputs` or `scratch` path class: deny as `path_unclassified` (see below);
6. the table.

Verdicts are `allow`, `ask`, `deny`, and one more for tools: `allow-in-plan-view` (`plan` x Bash: allowed only inside the read-only plan execution view; the mount view makes it read-only, never command classification). It is deliberately not spelled `allow`, so a caller that only knows `verdict === "allow"` fails closed instead of running plan Bash in a writable view. The decision also carries `bashReview`: `auto` x Bash is `allow` with `bashReview: true` for EVERY call, saved rule or delegation bound included. The reviewer itself belongs to the hook: in Code, `bashReviewerHook` (runtime-sdk/hooks.ts) skips the model review only for `bashLooksSafe` commands, never because of an explicit allow, so this layer must not promise a skip.

### Connector row

| Setting/class | Decision (spec) | Code |
| --- | --- | --- |
| Explicit deny | Deny in every policy | `coworkConnectorVerdict` |
| Explicit ask | Ask even under bypass; deny under dont-ask and for plan-mode mutation | same |
| Explicit allow | Allow except plan-mode mutation | same |
| Unset, read-only | Allow | same |
| Unset mutation/unknown | plan/dont-ask deny; ask/accept-edits ask; auto/bypass allow | same |

Difference from `connectorVerdict({ mode: "code" })`: exactly six cells, unset and not read-only, where Code answers `"gate"` and Cowork spells the verdict (deny, deny, ask, ask, allow, allow). Those six equal what `PermissionGate.evaluate` gives an external tool, with the engine's dont-ask conversion of ask to deny. Difference from the generic non-Code fallback (`"ask"` for every unset mutation in chat and dispatch): plan, dont-ask, auto and bypass. Both are pinned in tests so a change to `connectorVerdict` forces a re-read of the spec note "applied explicitly rather than ... inherit the current generic non-Code fallback".

## Transitions

Spec: "When narrowing a policy or hard capability ceiling, first close affected admission and cancel/drain processes holding older writable handles or broker capabilities. Switching into plan requires replacing the old execution view before it becomes effective. Show a pending transition until affected work is stopped and the new view installed ... Use workspace restart where a share/grant revocation cannot be enforced per process."

Classifier: "not a linear privilege ranking", so a change is compared cell by cell over the matrix itself (every tool/path cell, with and without an explicit allow, under a full ceiling; every cell of the connector row, each stored setting x read-only or not) and set by set over the ceiling. A test pins that every (tool, path) cell the matrix can answer with a table verdict is a classifier cell, so a future cell cannot escape classification. Results: `unchanged`, `widening`, `narrowing`, or `lateral` (something grew and something shrank). Among the six policies the lateral pairs are plan <-> dont-ask, and auto <-> each of dont-ask, ask and accept-edits (auto's Bash is always reviewed, so against an explicit allow it shrinks while against an unauthorized call it grows). Lateral takes the narrowing protocol, the safe direction. Anything malformed or unknown is `lateral`.

Machine phases and the invariant:

```
stable --request--> pending(closing-admission) -> pending(draining) -> pending(installing-view) -> stable(new, epoch+1)
                        |                              |                      |
              close-admission-failed        drain-failed / restart-required   install-view-failed     (phase: failed)
```

- The reported `effective` state is assigned in exactly one place, after `installView` resolved. In every pending and failed state it is the OLD state, and the snapshot carries the target, the kind, the admission state (`open`, `closed`, `unknown`) and `workspaceRestartRequired`.
- A widening only runs `installView`; it keeps admission open and still reports the old, narrower state until the view is installed.
- `drain` resolves `"drained"` or `"restart-required"`; any other value is a drain failure. `restart-required` is terminal for this machine: the owner restarts the workspace and builds a fresh machine from the canonical record.
- `retry()` resumes at the step that failed (admission already closed is not closed again).
- `request()` while pending is `busy`; while failed it is `unresolved`.
- Listeners are notified in order through a queue. A listener that calls `request()` or `retry()` synchronously cannot make the call that just finished report the nested transition's snapshot: the returned result carries the snapshot that call committed.
- The epoch is passed to the ports so plan scratch can be scoped by it ("Scope scratch by conversation and policy epoch").

## Decisions the spec leaves open (REVIEW NEEDED)

1. `alreadyAuthorized` is an input. The spec says the defaults apply "after hard denials and explicit applicable rules", and the cells also read "unless already authorized". The function takes the caller's resolution of an explicit allow as a boolean so both readings are encoded. Alternative: drop the input and have the caller resolve rules entirely before the call.
2. `plan` x Bash is the distinct verdict `allow-in-plan-view`. The cell says "Planning/read operations only"; the next paragraph says plan is enforced "below command classification" by read-only mounts, so Bash must run in plan, inside that view.
3. Workflow is a tool class with its own row from the Workflow paragraph (denies under plan, asks under ask/accept-edits/auto unless authorized, denies unresolved dont-ask, allows under bypass) and needs the `execute` class. The spec does not name Workflow's ceiling class.
4. A direct Write, Edit, Bash or Workflow aimed at the shared-instruction path is denied (`read_only_view`); the instruction column belongs to the `InstructionEdit` host operation. The Ask there ignores `alreadyAuthorized` (no reusable approval exists for it).
5. `bashReview` is always true for `auto` x Bash. The "may skip model review" for read-only or user-allowed commands is the hook's `bashLooksSafe`, not a policy-layer decision.
6. `/workspace/outputs` and conversation scratch (`/workspace/.winter/scratch/<session-id>`) are path classes `outputs` and `scratch`. The spec table has no cell for either; the plan paragraph only says plan's tool execution "receives ... separately scoped disposable/planning scratch" (a mount fact, not a verdict). DECISION (marked `// DECISION:` in `host-policy.ts`): every tool class on them is denied as `path_unclassified` under every policy until the spec gives the cells, so no caller can satisfy the matrix by calling them `admitted`.
7. A failed transition blocks new requests until `retry()`, because there is no port to reopen admission.
8. An explicit ask for ordinary (non-connector) tools is not modeled; the spec states the ask-stays-ask rule only for connectors. An unrecognised stored connector value reads as ask, as `normalizeConnectorTable` does.
9. The classifier orders cell outcomes deny < allow-in-plan-view < ask < allow-with-review < allow, and connector outcomes deny < ask < allow.

## Wiring notes

- Two sources of truth until wiring calls `coworkHostDecision`: `CoworkInstructions.agentScope` carries its own `plan`/`dont-ask` literal for the shared-guidance edit, and the matrix carries the same cell. A test cross-checks them for all six policies; wiring must replace the literal with a call to the matrix.
- The matrix knows Read, Write, Edit, Bash, Workflow and InstructionEdit. Glob and Grep must map to `Read` at wiring (the spec applies the same view to them: "Apply this to Glob/Grep, notebook/image tools and model-directed diff reads too"). Notebook and image tools need an explicit mapping decision; until then they are unknown classes and denied.

## Regression found and fixed

`CoworkInstructions.agentScope` refused an agent's shared-guidance edit only for `plan`. The table also says Deny for `dont-ask`, so a `dont-ask` conversation could be issued an approval card for an edit the policy forbids. It now refuses both before any card. `policy-transition.test.ts` covers all six policies against the matrix verdict and asserts that no card is emitted for the two denied policies (it runs on macOS arm64, where `CoworkInstructions` can be constructed).

## Tests and mutation checks

- `test/cowork/host-policy.test.ts` (16 tests): an exhaustive 8,064-case policy x tool x path x ceiling x explicit-allow comparison against a literal copy of the spec table, a written-out verdict grid, the instruction column, hard denials, unknown classes and malformed inputs, the connector table copy, the differential against `connectorVerdict(code)` and the real gate, the generic non-Code fallback pin, and the anti-wiring pin.
- `test/cowork/policy-transition.test.ts` (23 tests): the policy and ceiling classifier (including the connector row and the classifier-cell completeness check), transition order, every failure state and retry, busy/unresolved/invalid refusals, listener re-entrancy, frozen snapshots, the instruction-edit regression and the anti-wiring pin.
- 25 mutations, each failing named tests: flipping dont-ask or plan on the instruction-edit row; an explicit ask under bypass allowing; unknown classes defaulting to allow; reporting the new policy before `installView` resolves (two variants); reverting the `agentScope` fix; protected path allowed, ceiling ignored, garbage drain accepted, failure publishing the target, rank-based classification, widening skipping install, bypass instruction edit allowed, auto Workflow allowed; and for the review fixes: an explicit allow skipping auto Bash review, plan Bash spelled `allow`, plan-view ranked above ask, result reporting the current snapshot (applied and failed), listeners not queued, the classifier ignoring the connector row or dropping a tool cell, outputs/scratch not denied, scratch reads allowed.

## Not done

- No wiring into `gate.ts`, the approval bridge, the daemon or any RPC; no new `CoworkErrorCode`.
- No Bash reviewer, plan mount view, admission control or drain implementation: the ports are interfaces only. No cells for `outputs` or `scratch` until the spec provides them.
- `docs/claude/tool-surface.md` does not exist on this branch, so it could not be read.
