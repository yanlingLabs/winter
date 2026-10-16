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

Tool classes: `Read`, `Write`, `Edit`, `Bash`, `Workflow`, `InstructionEdit` (the host's content-bound `workspace.instructions.update`). Anything else is an unknown class and is denied. Path classes: `admitted`, `shared-instructions`, `protected`, `outside`, `none`.

Order of evaluation, each step beating every later one (bypass included):

1. unknown policy, tool class or path class: deny ("Unknown tool classes are not silently admitted.");
2. a saved explicit deny: deny ("Explicit deny ... apply under every policy");
3. `protected` or `outside` path: deny ("`bypass` never disables Linux control-state confinement or grants access to the Mac.");
4. the effective ceiling lacks the class: deny ("Skip ordinary prompts within grants"). Read needs `read`, Write `write`, Edit `read`+`write` (as `confinedToolVisibility` shows them), Bash and Workflow `execute`, InstructionEdit `write` plus the host service `workspace.instructions.update` (as `CoworkInstructions.agentScope` checks);
5. the table.

The decision also reports two flags the table implies but this layer cannot enforce: `bashReview` (`auto` x Bash: the Winter reviewer still applies, except where an explicit allow lets a user-allowed command skip it) and `planView` (`plan` x Bash: allowed only inside the read-only plan execution view; the mount view makes it read-only, never command classification).

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

Classifier: "not a linear privilege ranking", so a change is compared cell by cell over the matrix itself (every tool/path cell, with and without an explicit allow, under a full ceiling) and set by set over the ceiling. Results: `unchanged`, `widening`, `narrowing`, or `lateral` (something grew and something shrank). Among the six policies the only lateral pair is plan <-> dont-ask. Lateral takes the narrowing protocol. Anything malformed or unknown is `lateral`.

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
- The epoch is passed to the ports so plan scratch can be scoped by it ("Scope scratch by conversation and policy epoch").

## Decisions the spec leaves open (REVIEW NEEDED)

1. `alreadyAuthorized` is an input. The spec says the defaults apply "after hard denials and explicit applicable rules", and the cells also read "unless already authorized". The function takes the caller's resolution of an explicit allow as a boolean so both readings are encoded. Alternative: drop the input and have the caller resolve rules entirely before the call.
2. `plan` x Bash is `allow` with `planView`. The cell says "Planning/read operations only"; the next paragraph says plan is enforced "below command classification" by read-only mounts, so Bash must run in plan, inside that view.
3. Workflow is a tool class with its own row from the Workflow paragraph (denies under plan, asks under ask/accept-edits/auto unless authorized, denies unresolved dont-ask, allows under bypass) and needs the `execute` class. The spec does not name Workflow's ceiling class.
4. A direct Write, Edit, Bash or Workflow aimed at the shared-instruction path is denied (`read_only_view`); the instruction column belongs to the `InstructionEdit` host operation. The Ask there ignores `alreadyAuthorized` (no reusable approval exists for it).
5. `bashReview` is false when an explicit allow applies ("recognized read-only/user-allowed commands may skip model review").
6. Plan/disposable scratch writes are not modeled: the table has no scratch column. A `scratch` path class should be added when this is wired.
7. A failed transition blocks new requests until `retry()`, because there is no port to reopen admission.
8. An explicit ask for ordinary (non-connector) tools is not modeled; the spec states the ask-stays-ask rule only for connectors. An unrecognised stored connector value reads as ask, as `normalizeConnectorTable` does.
9. The classifier orders cell outcomes deny < allow-inside-plan-view < ask < allow-with-review < allow.

## Regression found and fixed

`CoworkInstructions.agentScope` refused an agent's shared-guidance edit only for `plan`. The table also says Deny for `dont-ask`, so a `dont-ask` conversation could be issued an approval card for an edit the policy forbids. It now refuses both before any card. `policy-transition.test.ts` covers all six policies against the matrix verdict and asserts that no card is emitted for the two denied policies (it runs on macOS arm64, where `CoworkInstructions` can be constructed).

## Tests and mutation checks

- `test/cowork/host-policy.test.ts` (13 tests): an exhaustive 5,760-case policy x tool x path x ceiling x explicit-allow comparison against a literal copy of the spec table, a written-out verdict grid, the instruction column, hard denials, unknown classes and malformed inputs, the connector table copy, the differential against `connectorVerdict(code)` and the real gate, the generic non-Code fallback pin, and the anti-wiring pin.
- `test/cowork/policy-transition.test.ts` (19 tests): the policy and ceiling classifier, transition order, every failure state and retry, busy/unresolved/invalid refusals, frozen snapshots, the instruction-edit regression and the anti-wiring pin.
- Mutations that each fail named tests: flipping dont-ask or plan on the instruction-edit row; an explicit ask under bypass allowing; unknown classes defaulting to allow; reporting the new policy before `installView` resolves (two variants); reverting the `agentScope` fix; plus protected path allowed, ceiling ignored, garbage drain accepted, failure publishing the target, rank-based classification, widening skipping install, bypass instruction edit allowed, auto Workflow allowed.

## Not done

- No wiring into `gate.ts`, the approval bridge, the daemon or any RPC; no new `CoworkErrorCode`.
- No Bash reviewer, plan mount view, admission control or drain implementation: the ports are interfaces only.
- `docs/claude/tool-surface.md` does not exist on this branch, so it could not be read.
