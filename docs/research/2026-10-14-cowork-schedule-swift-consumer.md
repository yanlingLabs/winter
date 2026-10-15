# Cowork schedule Swift consumer — source evidence

Date: 2026-10-14. Isolated branch `cowork/workspace-schedule-ui`, base
`37b68e0aa7ab1cee98c54bfd649253892e52aa81`. This is a source-only consumer of
the existing local schedule authority. It does not admit scheduled execution.

## Implemented source

- `WinterProtocol/CoworkSchedules.swift` mirrors the existing Core definition,
  target, one-shot/recurring timing, normal/quarantined schedule, occurrence,
  list page and status schemas. Closed fields, required nullable fields, UTF-16
  string bounds, saved capability names, all six existing approval policies,
  revisions and the `execution: unavailable` literal are decoded explicitly.
  Quarantine never decodes or displays the invalid definition.
- Dedicated factories call the existing `workspace.schedule.create/list/status/cancel`
  methods. Creation requires an explicit complete definition and stable request ID.
  Cancellation has **no request ID** in Core: its exact expected revision is
  retained for the existing committed-receipt replay semantics.
- `WinterKit/CoworkSchedulesModel.swift` retains one canonical page, checks workspace,
  schedule and occurrence identities, rejects duplicate identities/cursor loops,
  and limits page history to 100 cursors. The 256 KiB Foundation re-encoding bound
  accommodates slash escaping over Core's existing 128 KiB list response budget.
  At most 128 unconfirmed cancellation revisions are retained (see "Review fixes").
- Workspace binding UUIDs prevent late reads/receipts from entering a later
  selection, including returning to the same workspace ID. The parent model's
  `selected` observer invalidates schedules immediately during navigation or
  refresh, before the SwiftUI disappearance callback. Confirmation sends the
  captured binding UUID and exact schedule revision. Confirmed cancellation is
  retained if its follow-up status read fails; that status cannot roll back the
  confirmed cancelled revision. Quarantined and handled records can be cancelled.
- `CoworkSchedulesView.swift` displays canonical schedule/list/status/cancellation
  metadata, saved approval/ceiling/source/target/branch references, next due time,
  claim/recovery states, closed blocking reasons and missed/coalesced occurrence
  counts. It explicitly displays scheduled execution as unavailable. It provides
  no run, wake, guest-cron or Code fallback control.

The parent workspace model and view each have small integration hunks; DTOs,
consumer, UI and new tests live in dedicated files. The request initializer is
internal to WinterProtocol so the dedicated factory extensions can use it.
Source/policy paging and existing workspace publication/default/bypass behavior
are unchanged. Capability counts never become saved capability authority.

## Review fixes

- **Stale cancellation pin.** A pinned cancel revision is the lost-reply replay token. It is
  sent again only while the row still sits at that exact revision; at any other revision the
  earlier attempt cannot have applied (revisions only advance), so the pin is dropped before
  the unconfirmed-limit check and a list publish releases it. A definitive refusal
  (`revision_conflict`, `not_found`, `authority_denied`, `invalid_request`, or a missing
  method) releases it at once; ambiguous failures (transport loss, `recovery_required`,
  `unsupported_topology`, unknown codes) keep it. A `revision_conflict` re-reads the page the
  reader is on inside the same busy scope, so the next attempt carries the current revision.
  Before this, a once-schedule that fired (revision 2, `handled`) after a refused attempt kept
  re-sending revision 1 forever.
- **Error text.** `RpcError` is not `LocalizedError`; its `localizedDescription` is a generic
  Cocoa string and its `message` is daemon prose. `RpcError.data.code` (Core's `CoworkError`,
  as relayed by `ipc/server.ts`) maps to one fixed sentence per code, an unknown code to a
  generic sentence with only the numeric JSON-RPC code. A daemon that answers `-32601` for the
  schedule methods is the neutral `isUnsupported` state (no red error, no empty-list claim).
- **Wire parity.** Ceiling labels compare Unicode scalars, so `"\r\n"` is refused like Core's
  `/[\0\r\n]/`. Response decoding keeps strict, closed key sets, matching Core's `.strict()`
  schemas. `CoworkWorkspaceModel.validTitle` still compares `Character`s and accepts `"\r\n"`;
  it belongs to the workspace lane and was deliberately not changed here.
- **Presentation.** Once and next-due times name their time zone; the receipt banner clears on
  a new listing or rebinding; row buttons carry per-schedule accessibility labels; the card
  fill is `ElevatedSurface` and alerts use `.red` (docs/brand.md section 3.5).

## Source regressions and verification limits

Twelve protocol regression methods cover strict schema/nullable round trips,
quarantine safety, all existing policies/reasons, UTF-16/trim bounds (including
the NUL/CR/LF scalars of Core's label check), target/timing, definition bounds,
view accessors, explicit creation identity and the exact cancellation wire shape.
Thirty-two async fake-transport model regression methods cover canonical unavailable
status, coalescing/claims/recovery, cross-workspace and same-ID generation races,
late reads/receipts, immediate parent selection invalidation, exact cancellation
retry, serialization, invalid receipts, post-receipt read failure, pagination
replacement/loops/history limits, response bounds and safe quarantine cancellation.

**These Swift tests were authored but not executed or compiled.** No Swift/native
command, test host, app, GUI, live Winter home/daemon/Keychain, guest, provider or VM
was used. `git diff --check` and targeted source/wire-inventory inspection were
performed. The repository protocol checklist was read; no new method/event schema
or event fixture is introduced, so no code generation is needed for this mirror.
WinterProtocol tests, WinterKit tests and an app build remain required under a
separately authorized build lane. Source inspection does not prove Swift compilation,
SwiftUI lifecycle behavior, transport execution or guest execution.

## Deliberate remaining contract limits

- The creation **form** is deferred. The current workspace policy consumer provides
  a summary/counts, and current conversation target binding is not a complete
  trusted creation input. Fabricating a ceiling from counts/defaults would extend
  authority. The typed factory requires the complete explicit saved definition;
  future form work must obtain canonical capability names and validate the current
  trusted target/source/ceiling context.
- All four existing paired-client schedule method denials remain unchanged. This
  source does not extend remote authority or make a synthetic local principal
  eligible for a paired scheduling surface.
- Core still returns `execution: unavailable`; pending/claimed/uncertain records
  are metadata, never proof of a wake or completed effect. Production branch-state
  validation/admitted dispatch and actual guest/VM scheduling remain separate gates.
- Guidance editor commit `7798a5edc79d5fe05671e2bda0d85b72e12679e1` is a separate
  source lane. Product composition must preserve its guidance model/view additions
  together with this lane's selected observer, lazy schedules property and view
  insertion. This worktree does not include that separate commit.

No push, pin, release or activation was performed.
