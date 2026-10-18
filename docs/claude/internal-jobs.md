# Internal jobs

*Read this before touching titles, the bash safety reviewer, the dreamer or the session cleaner — how they pick a model, effort or credential.*

## The four jobs

- The daemon's OWN model calls, never a session or runtime child: `titles.model`, `reviewer.model`, `pins.dream`, `pins.cleaner` (`INTERNAL_JOB_ROLES`, `packages/core/src/settings.ts`).
- One seam: `packages/core/src/providers/internal-router.ts`'s `resolve(role, settings)` → a call or a typed `InternalRefusal`; `agent/titles.ts`, `agent/reviewer.ts`, `agent/dreamer.ts` and `sessions/cleaner.ts` skip their run on a refusal. A failed cleaner judgment waits `CLEANER_RETRY_BACKOFF_MS` (30 min).
- `agent/compactor.ts` is vestigial (built only by its test and `packages/core/scripts/capture-projector-goldens.ts`); `session.compact` answers `not_supported_on_winter_leg`.

## Eligibility — `internalEligibleProviderIds()` (settings.ts)

Catalog-derived, never a hand list: (1) `permittedProviders()`'s floor; (2) not in `CLAUDE_FIRST_PARTY_PROVIDER_IDS` (only `cc`); (3) a slot in `credentialInventory()`; (4) an adapter family in `providers/internal-adapters.ts`'s table (bedrock/vertex/xai-oauth are out — its header says why). `anthropic` and `console` ARE eligible: `buildInternalProvider` (`providers/internal-provider.ts`) names `connection.providerId` + the slot's locator ([providers-and-credentials](./providers-and-credentials.md)). Exclusion is by provider ID, never adapter family.

## Which model — `internalRoleEffectiveTag` (settings.ts)

Never a model on a provider the user did not choose: (1) an explicit pin, reported verbatim even when unrunnable (its reason rides `problem`); (2) else `settings.provider.model`'s provider if eligible AND credentialed — its `terra`/`luna` slot, else `provider.model` itself; (3) else a credentialed `codex-oauth`/`openai` (`INTERNAL_PROVIDER_IDS`' only role, plus the preference-order head); (4) else NO default — `no-default-model`, inert until pinned. `cc` answers no rung.

## Effort

`internalWireEffortFor` (internal-provider.ts) maps a role's effort onto the row it will call, since the SDK's `mapEffort` refuses one outside the row's vocabulary. `"none"`: no vocabulary → nothing sent; the row lists `"none"` → sent; a reasoning row without a `"none"` tier → its LOWEST declared tier (`REASONING_EFFORTS`), never dropped (dropping lets the provider's higher default apply). Else `internalEffortNoEscalationFor` (`runtime-sdk/provider-selection.ts`): the row's `defaultEffort` only when no heavier than asked, otherwise dropped. Never UP.

## Quota

One `QuotaManager` per provider (`InternalRouter.quotaFor`) — a Codex 429's hour-scale retry-after must not stall another vendor; counters are never a cross-vendor sum. `InternalRouter.quota` is always the `codex-oauth` ledger, read once at boot by `daemon.ts` for the `quota.state` RPC.

## Live view + self-heal

`providers/internal-view.ts` holds the ONE mutable fact (which eligible providers hold material): seeded from the boot probe, refreshed inside `credential.set`/`remove`/`list` before they return; the wire (`settings.modelRoles`), the default-tag readers and the dispatcher derive from it synchronously; per-provider `Provider`s are cached on `view.generation()` + base URL. One log line per change, never per call. `winter login`/`logout` write `codex-oauth:default` in-process, so the CLI pokes a live daemon via `credential.list` and the router self-heals with `view.refreshSoon()` (coalesced, ≤ 1 probe per `REFRESH_SOON_MIN_MS` = 30 s) on `no-internal-credential` (never `no-default-model`), on any `auth`-classified failure of the four, and once per dreamer tick.

## Role problems — `providers/internal-role-problems.ts`

Derived per read, never persisted: `provider-unsupported`, `no-credential` (pin on an eligible, empty slot), `no-internal-credential` (nothing eligible credentialed), `no-default-model` (credentialed, no model Winter will name — fix is a pin), `model-not-in-catalog` (pin on a retired row; judged after eligibility, before credential). A structural problem wins over a `<home>/runtimes/role-health.json` note. `setModelRole` refuses an internal role's tag only on permanent facts (ineligible provider, `blocked` row, no chat/responses endpoint); a key not yet stored is a `problem`, not a refusal.

## The bash safety reviewer

- Never off over a pin mistake: a `reviewer.model` pin that is `provider-unsupported`/`no-credential`/`model-not-in-catalog` runs on the unpinned default (`resolve`'s `fallbackToDefault`, enforced on the role — the other three stay inert on a refused pin); `problem` keeps the pin's reason + `— reviewing on <tag> meanwhile`.
- Hook: `bashReviewerHook` (`runtime-sdk/hooks.ts`; `PreToolUse` on `Bash`, `auto` only, `settings.reviewer.enabled`). A structural no-model (`ReviewerNoRunnableModel`: `no-internal-credential`/`no-default-model`) ALLOWS a sandboxed call, as such a home always got (an escape records no clearance, so the bridge still cards it — [tool-surface](./tool-surface.md)), one log line per state change; a transient failure (timeout, bad verdict, abort) → `ask`; `unsafe` → deny.
- Two pre-checks skip the review for a SANDBOXED call, never an escape: `bashLooksSafe` (`agent/reviewer.ts`) — a `settings.reviewer.allow` entry (whole command or first word) with no shell metacharacter, else no `SECRET_PATH` hit AND `isBashCommandReadOnly` (`runtime-sdk/bash-read-only.ts`, PORTED from the agent SDK with its test in `test/runtime-sdk/`; keep in step) — and `plainOpenUrls`: exactly one `open` with only `-a <name | installed .app path>`/`-b <bundle id>` (once), `-g`/`-j`/`-n`/`-F` and http(s) URLs, no host on the live dangerous-domain floor.
- Progress: transient `tool_review_progress {callId, phase: started|ended, verdict?: safe|unsafe|escalated}` on the call's thread (`sessions/call-threads.ts`); one `ended` per `started`, `escalated` on error/timeout/abort, no verdict when no model, nothing for a pre-allowed command. Not `tool_review` (the retired persisted record).
- `REVIEW_INSTRUCTION` names what the sandbox stops (writes outside cwd, network) and aims at the rest — destructive changes inside cwd, killing processes, `osascript`/`open` of a file/`launchctl`, running a file the agent just wrote, printing secrets; build/test/lint/read/search and opening an app or page are safe. Escapes: `UNSANDBOXED_REVIEW_INSTRUCTION` — [tool-surface](./tool-surface.md).

## Gate, policies, memory, subagents

- A call the gate cannot allow: a card in code and dispatch via `canUseTool` (`runtime-sdk/approval-bridge.ts`; dispatch respects its policy since 2026-10-17), a typed deny in chat, except a connector action ([mcp](./mcp.md)). Policies `plan | dont-ask | ask | accept-edits | auto | bypass` (`ApprovalPolicy`, protocol `methods.ts`) + chat's immutable `chat` (`agent/gate.ts`).
- Memory is a MEMDIR of markdown (`agent/memory-dir.ts`); no memory tool. Subagents: no wall-clock timeout, a resettable progress-stall window (`CHILD_STALL_TIMEOUT_MS` 600 s; `settings.subagents.stallTimeoutMs` hot, `null`/`0` off).
