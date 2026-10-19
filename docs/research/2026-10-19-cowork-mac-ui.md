# Cowork Mac UI: composer, chips, session windows, error copy (hidden behind the gate)

Lane MAC UI, stacked on the session door spine (D1). It builds the Mac app's Cowork surfaces for the door's first session and keeps every one of them unreachable while `SessionMode.cowork.isAvailable` is `false`. Nothing here makes a Cowork session creatable: the daemon still answers `session.create {mode:"cowork"}` with `unsupported_topology`.

## The gate

One answer decides whether any Cowork surface exists: `CoworkGate` (WinterKit). It is open only when all three hold:

1. the app's own constant (`SessionMode.cowork.isAvailable`, passed in as `modeAvailable` so a test can hold it open) is true;
2. `workspace.capabilities.get` reports `execution`;
3. it also reports `provisioning`.

The constant stays `false`, so the gate is closed in production whatever a daemon claims. The design asks that availability "follow `execution`, never a constant"; the AND satisfies both that and "stays off until the flip slice". The flip slice changes `SessionMode.cowork.isAvailable` to follow the capability read (or drops the constant from the AND).

While the constant is off the models issue no request of any kind: `CoworkComposerModel.refresh/start/pickFolder` and `CoworkSessionWindowModel.refresh` return before the first call, which the tests assert as an empty call list.

## What was built

| Item | Where | Gated how |
|---|---|---|
| Composer send | `CoworkComposerModel` (create workspace, optional default policy, `session.create` with the outputs location) and `ShellSessionHost.sendFirstCoworkMessage` | `start` checks the constant first, then re-reads capabilities at send time |
| Folder and approval chips | `CoworkComposerChips.swift`, `CoworkComposerCopy.swift`; `CoworkComposerChrome.makeStrip` | `CoworkComposerStripSwitch` draws the old placeholder strip until the model is open |
| Session windows | `CoworkSessionWindowModel`, `CoworkSessionBanner`; `SessionSummary.cowork` and `coworkLocation`; `listCoworkRowFacts` | the banner shows for `cowork` rows only; a closed gate shows one unavailable line and reads nothing |
| `/spawn` | `dispatchPillCoworkSpawn`, `AppDelegate.openCoworkComposer` | the factory returns `nil` while the constant is off, so the pill keeps saying "not available yet" |
| Library labels | `winterCapabilityModeOrder` gains `cowork` | data-driven: nothing is said unless the `exposure` map has a `cowork` key |
| Guidance not loaded | a note in every open Cowork window | |
| Error copy | `coworkSessionErrorText`; `CoworkRpcCode` gains `provider_unavailable`, `conversation_limit`, `cold_resume_unavailable` | unknown codes degrade to a generic sentence |
| G11 | a note in every open Cowork window | |

## Honest copy

- **Folder chip.** The first session works in its own outputs folder (owner decision O1). The chip says the folder is added to the workspace as a source that stays preparing, and that Winter cannot share Mac folders with the VM yet. It never says the folder is mounted. Source state in the window comes from `workspace.source.list`, not from a constant.
- **Approval chip.** The choice is the workspace's default (`workspace.setDefaultPolicy`), so the chip and its picker say it applies to every conversation in the workspace.
- **G11.** "Files this conversation writes live on the workspace's VM disk. Your Mac and Winter's outputs list can't see them yet." The host readers (`workspace.output.list`, `workspace.file.*`) read the shared outputs directory, which the guest does not write in N2.
- **Guidance.** "Workspace guidance isn't loaded in this version, so the model hasn't read it." until `host-query-guided-v1` lands (G3).
- **VM power.** `starting` says a first reply can take about two and a half minutes (90 s for the guest's hello plus 60 s for `runtime_ready`). `stopped` says nothing, because it cannot tell a first start from a stop that cold resume cannot reverse.

## A pre-existing hole, closed

`NewChatPage.submit` ran `sendFirstChatMessage` for every segment. The send button was blocked on the Cowork segment ("isn't built yet") but Enter was not, so Enter there created a Chat session. `submit` now routes the Cowork segment to its own sequence, which creates nothing while the mode is off and says why on the page's failure line.

## Decisions

- **Existing standalone workspaces are not offered.** A standalone workspace belongs to its single conversation; only Projects are listed for joining. A new conversation in a new folder creates a new standalone workspace.
- **A retry never duplicates.** Request ids are minted once per intent (folder and approval choice) and kept across failures; an acknowledged workspace is reused after a lost `session.create` answer.
- **No model, effort or approval on the create.** The door refuses all three beside a Cowork binding, so the composer sends none and hides the model chip once Cowork is open.
- **Polling, not watching.** The Mac has no `workspace.watch` client. An open window reads `workspace.get` and the source list every 3 s while the VM's power is changing and every 15 s otherwise.

## NEEDS FROM OTHER LANE

- A Swift `workspace.watch` client (protocol is in the kit's request inventory only as a method name) so windows can stop polling.
- DOOR D6: the `cowork` key in `capabilities.list` exposure with the flip; the Library tab already reads it.
- DOOR/S7B: a way for the Mac to learn the location kind of a listed row (`SessionRow.cowork` carries only the workspace and Project); the window gets it from `session_created.cowork` when it saw the event.

## Docs owed

`docs/claude/cowork.md` and the ledgers should say: the Mac composer, chips, session notes, `/spawn` factory and the three error codes exist behind `CoworkGate`; `SessionMode.cowork.isAvailable` remains the single constant the flip changes; the Library reads a `cowork` exposure key when present; and the unreachability proof is the zero-request tests in `CoworkSessionDoorTests` plus the source scans in `CoworkSessionDoorUITests`.
