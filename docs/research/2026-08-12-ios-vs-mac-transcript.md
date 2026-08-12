# iOS vs Mac — chat transcript, element by element

**Date:** 2026-08-12 · **Status:** research only, no code changed
**Directive:** *"make the mac app chat transcript look more similar to the ios, including approval cards, question cards etc."* + *"also the tool rows etc cuz the ios ones are much better and actually show the tool calls things"*
**Direction of travel:** the Mac changes. iOS is the reference for **shape and structure**. The Mac keeps its own colour language (`docs/brand.md`).

Repos: Mac `apple/Norma`, iOS `../norma-ios`. Gallery = `norma-ios/docs/ios26-design-gallery/` (verified; wins over prose).

---

## 0. The five headline findings

Everything below elaborates these. Ranked by how much of the perceived gap each one explains.

1. **The Mac throws the tool RESULT away at the reducer.** `SessionReducer.reduce` folds `tool_result` to exactly one statement — `if s.pendingInteractions.isEmpty { s.status = .thinking }` (`Sources/Model/SessionModel.swift:338-339`). `output` and `isError` are never stored. iOS keeps both (`Transcript.swift:282-291`) and renders the output in an expandable monospaced block. **This is the user's complaint, and it is a data-model fix, not a styling fix.**
2. **The Mac transcript is a list of *exchanges*, not a list of *events*.** `Exchange { prompt, reply, activity[] }` (`SessionModel.swift:127-138`) renders prompt → *all* activity → reply (`ChatContent/TranscriptView.swift:100-122`). True chronological interleaving is lost, and — worse — `assistant_message` **overwrites** `exchange.reply` (`SessionModel.swift:397-404`) while the engine emits one `assistant_message` **per round** (noted in the Mac's own comment, `SessionModel.swift:230`). **Intermediate assistant text in a multi-round turn is silently discarded on the Mac.** iOS appends each one as its own row.
3. **The Mac's approval/question cards are a pinned band *below* the transcript that vanishes on resolve.** `PendingCardsView` is mounted between the transcript and the composer (`ChatContent/WindowContentView.swift:153-169`), fed by `pendingInteractions`, which `resolvePending` empties on `*_resolved` and `turn_completed` clears wholesale (`SessionModel.swift:349-354`, `:405-407`). There is **no auditable record of an answered approval or question anywhere in Mac scrollback.** iOS freezes a resolved card into the transcript forever (`QuestionCardView`, `ApprovalRowView`).
4. **`ChatContent/` contains zero `Theme.` references.** Verified by grep. The whole transcript still wears the v1 donor's system semantics — `.ultraThinMaterial`, `.thinMaterial`, `.primary`/`.secondary`/`.tertiary` — while the rest of the Mac app moved to the brand palette on 2026-08-07. The window itself is already `CardSurface` (`AppShell/AppWindowController.swift:180`), so the plane is right and only the content is unbranded.
5. **Serif assistant prose is allowlisted for the Mac and not yet applied.** `docs/brand.md` §4 serif allowlist item 4: *"Assistant prose in the transcript — the reading face for what the assistant says. Live on iOS; allowlisted but not yet applied on Mac (pending the chat-surface pass)."* This is pre-approved, not a new decision.

---

## 1. Per-element comparison table

Values are literal from source. `—` means the element does not exist on that side.

| Element | iOS (reference) | Mac today | Delta |
|---|---|---|---|
| **Transcript container** | `ScrollView` + `LazyVStack(alignment:.leading, spacing:16)`, `.padding(.horizontal, 20)`, `.padding(.vertical, 12)` (`TranscriptView.swift:61,87-88`). Sits on `Theme.cardSurface` (`CodeSessionView.swift:121`). | `ScrollView` + `LazyVStack(alignment:.leading, spacing:14)`, `.padding(.vertical, 4)`; horizontal 16 comes from the parent column (`ChatContent/TranscriptView.swift:19,29`; `WindowContentView.swift:210`). Window bg = `CardSurface`. | Row gap 16 vs 14; text column inset 20 vs 16. iOS's 20 is *measured from Claude* ("Claude's measured text column (SP-chat; was 16)", `TranscriptView.swift:87`). Cosmetic, one-line. |
| **Row model** | Flat `[TranscriptItem]`, one row per event, true chronological order (`Transcript.swift:9-50`). | `[Exchange]`, each = prompt + grouped activity + single reply (`SessionModel.swift:127-138`). | **Structural.** Mac cannot interleave "text, tool, more text". Mac loses per-round assistant text (overwrite at `SessionModel.swift:403`). Highest-value structural change; also the enabler for cards-in-transcript. |
| **User message** | Trailing bubble. `HStack{ Spacer(minLength:48); Text }`, `.font(.body)` (17 pt), `.padding(.vertical,13).padding(.horizontal,18)`, `Theme.bubbleUser`, `.rect(cornerRadius:24, style:.continuous)`, `textSelection(.enabled)` (`TranscriptView.swift:282-293`). No avatar, no caption. | Trailing bubble. `HStack(alignment:.bottom){ Spacer(minLength:90); content.frame(maxWidth:560) }`, inner text 14 pt via `TranscriptFormattedMessageText`, `.padding(14)`, `.ultraThinMaterial`, radius 18 continuous (`TranscriptMessageViews.swift:18-44`). | Mac: material not brand fill; 14 pt not 17; r18 not r24; hard 560 pt cap + 90 pt min gutter vs iOS's 48 pt min gutter and no absolute cap. iOS renders markdown-free plain text; the Mac runs the user's own text through the full markdown formatter. |
| **Assistant message** | No bubble, no avatar, full width. `AssistantProse` — serif `.body` (17 pt), `lineSpacing(6)`, block gap 12, headings serif `.title3.semibold` (≤h2) / `.headline`, code blocks monospaced `.footnote` on `Theme.elevatedSurface` r10 (`AssistantMarkdown.swift:119-183`). | No bubble, no avatar, full width. Sans 14 pt, `lineSpacing(3)`, block gap 10, headings 20/17/15.5/14.5 pt (`TranscriptMessageViews.swift:140-217`), code block r12 with hover border/shadow/`scaleEffect(1.006)` (`:221-324`). | **The single biggest visual difference.** iOS reads as a serif document at 17/27; the Mac reads as a 14 pt sans UI label. Serif on Mac is pre-approved by `brand.md`. |
| **Streaming state** | Streaming row is the *same* row mutated in place (stable id), `.animation(nil, value:text)` to suppress implicit token animation (`TranscriptView.swift:300-303`). An empty streaming row renders **nothing** — the turn-level `ThinkingRow` speaks instead. | A separate synthetic trailing row: `TranscriptAssistantMessage(text:streamingText, isStreaming:true)` (`ChatContent/TranscriptView.swift:116-120`); suppresses only the copy button while streaming. | Similar enough. Mac has no `.animation(nil)` guard — worth adding to stop implicit per-token animation. |
| **"Thinking" indicator** | `ThinkingRow` in the transcript: `"Thinking"` + cycling 0–3 dots on a 0.35 s `TimelineView`, 14 pt, `Theme.textMuted`, dot slot width-reserved 16 pt so nothing reflows; static `…` under Reduce Motion (`TranscriptView.swift:356-376`). Gated by `TranscriptThinking.showsThinking` — honest: silent while a tool runs, while text streams, or while a card waits on the user (`ToolPhrase.swift:76-89`). | Nothing in the transcript. Status lives in the window header: `Text(adapter.statusText)` at 12 pt `.secondary` (`WindowContentView.swift:102-104`), plus a whimsical `workingVerb` in the orb pill. | Mac has no in-transcript waiting signal at the point of gaze. Direct port; the `showsThinking` gate is pure and portable. |
| **Tool call / activity row** | See §2. Phrase + status glyph + chevron, **expandable to the real output**. | See §2. Grey 11 pt sentence + chevron, expands to *argument hints only*. | See §2 — this is the section the user promoted. |
| **Subagent display** | No transcript row. Subagents surface as ordinary `Task`-tool rows. `SubagentDisplay` has no iOS twin. | `SubagentDisplay.swift` is pure logic (glyph `●`/`✓`/`◌`, label, `subagentActiveMs`) rendered **outside** the transcript, in `WindowContentView.subagentSection` below the composer (`WindowContentView.swift:206-208`). Inside the transcript, `.subagent` renders as `("⌥", agentType)` at 11 pt `.tertiary`. | Mac is *ahead* here (live timers, roster). Do not remove. Restyle only. |
| **Task display** | None in the transcript. | `TaskDisplay.swift` is pure logic (sort/collapse/`taskCountsLine`/`formatElapsed`), rendered as a pinned section below the transcript (`WindowContentView.swift:171-173`). `.task` activity items are **deliberately skipped** inside the transcript (`TranscriptMessageViews.swift:452-453`). | Mac ahead. Keep. |
| **Approval card** | Inline transcript row, permanent. See §3.1. | Pinned band below transcript, disappears on resolve. See §3.1. | Structural + visual. |
| **Question card** | Pending → composer morph; resolved → permanent transcript card (+ Photos-style stack for multi-question). See §3.2. | Pinned band, single shape for both, disappears on resolve. See §3.2. | Structural + visual. |
| **Plan card** | No iOS equivalent — `plan_presented` has no iOS transcript variant. | `PendingPlanBody` — scrollable plan (max 260 pt) + Approve / Approve+auto-accept / Request changes (`PendingCards.swift:674-716`). | Mac-only. Keep; restyle to match whatever card chrome lands. |
| **Message-actions row** | Under the **last, finished** assistant message only: `HStack(spacing:16)`, 16 pt glyphs, `.secondary`. Copy (`square.on.square` → `checkmark`, `.contentTransition(.symbolEffect(.replace))`, 1.5 s revert, generation-guarded) and Share (`ShareLink`) are real; play / thumbsup / thumbsdown / arrow.clockwise are decorative mocks, `accessibilityHidden` (`MessageActionsRow.swift:8-50`). Padded `.top, 4`. | A single copy button under **every** assistant message: `doc.on.doc` → `checkmark` + "Copied", 11 pt, fixed 68×22 frame, hover-driven `.secondary` → `.primary` (`TranscriptMessageViews.swift:67-78, 330-343`). | Mac: one affordance vs six; on every message vs only the last; 11 pt text-label vs 16 pt glyph row. Mac's hover state is *correct for macOS* and must survive any port. |
| **End-of-conversation footer** | `TranscriptFooter` after the last finished assistant message, `.padding(.top, 24)`: accent `asterisk` 22 pt semibold on the left, right-aligned two-line `.footnote`/`.secondary` "Norma is AI and can make mistakes. / Please double-check responses." (`MessageActionsRow.swift:54-68`). | — | Mac has no footer. Cheap, high-recognition addition. |
| **Error row** | `Label` with orange `exclamationmark.triangle.fill` + `.footnote`/`.secondary` message, `.padding(12)`, `Theme.elevatedSurface` r12 (`TranscriptView.swift:338-349`). | `agent_error` is folded into the exchange's reply text as `"⚠︎ \(message)"` (`SessionModel.swift:435-437`) — it renders as ordinary assistant prose. | Mac has no distinct error class; an error is indistinguishable from a reply except for one glyph in the text. |
| **Stopped / aborted** | — (no iOS equivalent) | `TranscriptStoppedRow`: `⏹ stopped`, 11 pt `.tertiary` (`TranscriptMessageViews.swift:399-410`). | Mac-only. Keep. |
| **Empty state** | `ContentUnavailableView` with per-connection-state symbol/title/message — `text.bubble` when live, `arrow.triangle.2.circlepath` reconnecting, `wifi.slash` otherwise (`CodeSessionView.swift:210-211, 253-270`). Gallery `14-empty-states.md` §5. | **Nothing.** `ForEach` over an empty array renders a blank region; grep finds no `ContentUnavailable` anywhere in `ChatContent/`. (The new-chat *page* is a different surface — it exists only before a session is created.) | An existing session with no messages is a blank rectangle on the Mac. |
| **Scroll / anchor behaviour** | `defaultScrollAnchor(.bottom)` + `ScrollPosition` (`TranscriptView.swift:90-91`). Bottom-pin latch computed as `contentSize.h − containerSize.h − contentInsets.top − contentOffset.y < 44` (`:94-105`). Send always snaps to bottom **next tick** (`:147-157`). Follow signal = `"\(items.count):\(streamingTailLength)"` (`:161-165,192-196`). Top-reach (<44 pt) → load older, with anchor-id restore (`:55-57,108-125`). | `ScrollViewReader` + `proxy.scrollTo(index, anchor:.bottom)`, `withAnimation(.easeOut(duration:0.18))`. Near-bottom = `contentOffset.y + containerSize.h >= contentSize.h − 40` (`ChatContent/TranscriptView.swift:31-36`). Follows on count growth and stream growth (`:38-45`). No load-older, no anchor restore. | Behaviourally close. The Mac's is simpler and adequate; **do not** port iOS's inset-corrected formula verbatim — macOS `ScrollView` has no equivalent bar insets and the correction would be wrong. |
| **Send choreography** | The **last turn** (last user message + everything after) is wrapped in a `VStack` with `minHeight: viewportHeight − 24`, so sending puts the user's message at the *top* of the viewport with blank run-out below, and the streaming reply fills the blank without moving the view (`TranscriptView.swift:73-82, 126-143, 201-209`). This is Claude's signature motion. | Nothing. A send scrolls the new content to the bottom; the reply pushes everything up as it grows. | **High perceived-quality item.** Needs a Mac viewport-height source (`GeometryReader` or `onScrollGeometryChange` container size — macOS 15+). |
| **"Jump to latest" pill** | Bottom-**centre** overlay, `Label("Jump to latest", systemImage:"arrow.down")`, `.caption.weight(.semibold)`, `.padding(.vertical,6).padding(.horizontal,12)`, `.buttonStyle(.glass)`, `.tint(Theme.accent)`, `.transition(.move(edge:.bottom).combined(with:.opacity))`, `.padding(.bottom,8)`. Tapping also resigns first responder (`TranscriptView.swift:166-178, 474-488`). | Bottom-**trailing** overlay, `Label("latest", systemImage:"arrow.down")`, 11 pt medium, `Capsule().fill(.thinMaterial)`, `.padding(.horizontal,10).padding(.vertical,5)`, `.padding(8)`, no transition (`ChatContent/TranscriptView.swift:46-48, 55-66`). | Position (centre vs trailing), copy ("Jump to latest" vs "latest"), and the missing transition. Trivial. |
| **Loading-older affordance** | `ProgressView` in a `.glassEffect(.regular, in:.capsule)` floated at the top (`TranscriptView.swift:179-187`). | — (no history paging on Mac) | Out of scope for a visual pass. |
| **Spacing rhythm** | Row gap **16**; assistant block gap **12**; question-card inner spacing **14**, blocks **10**, options **8**; approval card inner **10**, padding **14**; column inset **20**/**12**. | Row gap **14**; exchange inner gap **10**; assistant block gap **10**; card inner **10**, padding **12**; column inset **16**. | The Mac is uniformly ~2–4 pt tighter and one register smaller. iOS's rhythm is derived from Claude; adopting it wholesale is the cheapest way to close the "feels different" gap. |

---

## 2. Tool-call display — the perceived quality gap

The user is right, and the reason is sharper than styling: **iOS shows the tool's result; the Mac shows a hint about the tool's arguments and nothing else.** They are almost exactly complementary.

### 2.1 What the wire actually carries

Both apps receive identical events. From `packages/protocol/src/events.ts:61-66`:

```
tool_call   { callId, name, argsJson: string }        // full arguments, serialized JSON
tool_result { callId, output: string, isError: bool } // full output, truncated at 64 KiB by the daemon
```

The daemon caps output at `MAX_OUTPUT = 64 * 1024` with a `[truncated at 65536 bytes]` marker (`packages/core/src/agent/tools/registry.ts:170, 387`). So **everything iOS shows is available to the Mac, and everything the Mac shows is available to iOS.** Nothing needs a protocol change.

### 2.2 iOS — what is rendered per tool call

| Aspect | iOS behaviour |
|---|---|
| Data retained | `name`, `callId`, `output`, `isError` (`Transcript.swift:275-291`). **`argsJson` is dropped at the fold** — never parsed, never shown. |
| Collapsed row | `statusIcon` + phrase + flexible spacer + `chevron.right`. Phrase 14 pt; chevron 13 pt `.medium`, `.rotationEffect(90°)` when open. One colour for glyph, phrase and chevron: `Theme.textMuted` (`TranscriptView.swift:398-419`). A custom disclosure, *not* `DisclosureGroup` — the system chevron rendered "darker and larger than Claude's small trailing `>`" (r3 device gate, `:395-397`). |
| Phrase | `ToolPhrase.phrase(name:count:)` — past-tense sentences, no raw tool names: "Ran a shell command", "Read 4 files", "Asked 2 questions" (`ToolPhrase.swift:9-26`). |
| Grouping | `TranscriptDisplayRow.rows` folds a run of **consecutive same-name** calls into one group (`ToolPhrase.swift:43-69`). A name change ends the group. |
| Expanded | Per call, in order: `ScrollView(.horizontal){ Text(output).font(.system(.footnote, design:.monospaced)).textSelection(.enabled).padding(10) }` on `Theme.elevatedSurface` r10. `nil` output → "Running…"; empty output → "No output" (`TranscriptView.swift:432-449`). |
| Gesture | Whole label is a `Button` with `contentShape(Rectangle())`, `withAnimation(.smooth)`. **Disabled** until at least one call has non-empty output (`:419-420`). |
| Status / in-flight | `gearshape` 13 pt with `.symbolEffect(.pulse, options:.repeating)` while any call is running; bare `xmark` 11 pt `.medium` if any failed; bare `checkmark` 11 pt `.medium` otherwise. Deliberately **no circles, no green, no red** — r3 device-gate call (`:453-469`). Outcome is carried to VoiceOver via `.accessibilityValue("Running"/"Failed"/"Completed")`. |
| Duration | Not shown. |
| Per-tool specialization | **None.** One generic row. No per-tool SF Symbols, no custom bodies, no diff rendering. `ask_user` is the single special case, and only in the *count*: it counts questions rather than calls (`TranscriptView.swift:245-266`). |

**Live defect on iOS worth knowing before porting anything from it.** `ToolPhrase` switches on `"Bash"`, `"Read"`, `"Write"`, `"Edit"`, `"Grep"`, `"Glob"`, `"WebSearch"`, `"WebFetch"`, `"Task"`, `"TodoWrite"` — Claude-Code-style capitalized names. Norma's daemon registers `bash`, `read`, `write`, `edit`, `grep`, `glob`, `web_search`, `web_fetch`, `browser`, `computer`, `lsp`, `ls`, `task_create`… (verified by grepping `name: "…"` across `packages/core/src/agent/tools/`). **Only `ask_user` and `Skill` match.** Every other call on iOS today falls through to `default: "Used \(name)"` — "Used bash", "Used read 4 times". The Mac's `toolGroupFragment` uses the *correct* lowercase names and is the better table. **Do not replace the Mac's vocabulary with iOS's.**

### 2.3 Mac — what is rendered per tool call, and what is thrown away

| Aspect | Mac behaviour |
|---|---|
| Data retained | `name` + a short `detail` string extracted from `argsJson` (`SessionModel.swift:335-337`). **`output` and `isError` are discarded** — `tool_result` only flips `status` (`:338-339`). |
| Detail extraction | `extractToolDetail` (`SessionModel.swift:611-633`) handles exactly: `bash` → first line of `command`, capped 100 chars; `task_create`/`task_update` → `subject`; `read`/`write`/`edit`/`glob`/`grep`/`ls` → `file_path` ?? `path` ?? `pattern`. **Everything else returns `nil`** — including `browser`, `web_fetch`, `web_search`, `computer`, `lsp`, `notebook_edit`, `ReadPage`, `Search`, `Skill`, `ToolSearch`, `Workflow`, `spawn_agent`, `ask_user`. |
| Grouping | `groupActivity` folds **any unbroken run of tool calls, across different names**, into one `.toolRun`; same-name neighbours merge into one `ToolRunEntry` with a count (`TranscriptMessageViews.swift:448-474`). Non-tool activity breaks the run. `.task` items are skipped entirely. |
| Collapsed row | `chevron.right` 9 pt `.semibold` in a 10 pt slot + one comma-joined sentence, 11 pt, `.tertiary`, `lineLimit(1)`, `.truncationMode(.middle)` — e.g. "Read 4 files, listed 1 directory, ran 8 shell commands" (`TranscriptMessageViews.swift:553-575`). |
| Expanded | `"\(name) \(detail)"` lines, 11 pt monospaced `.tertiary`, `lineLimit(1)`, middle-truncated, `.padding(.leading, 16)`; `.animation(.easeOut(duration:0.15))` (`:576-588`). An entry with no detail contributes **no line at all** — a `browser`/`web_fetch` run expands to literally nothing. |
| Status / in-flight | **None.** No running indicator, no success mark, no failure mark. A failed `bash` is visually identical to a successful one. |
| Duration | Not shown. |
| Per-tool specialization | **None**, and less than iOS: `toolGroupFragment` (`:486-521`) has fragments for `bash`, `task_create`, `task_update`, `task_list`, `read`, `write`, `edit`, `ls`, `glob`, `grep`, `ToolSearch`, `Skill`, `ask_user`, `exit_plan_mode`, `request_directory`. `browser`, `web_fetch`, `web_search`, `computer`, `lsp`, `notebook_edit`, `AskQuestion`, `ReadPage`, `Search`, `Workflow`, `spawn_agent`, `session_spawn`, `enter_worktree` all fall to **"used a tool" / "used N tools"**. |

**Worked example — what a user sees on the Mac today for a browser session.** The model opens a tab, navigates, reads the page, screenshots it, clicks a button. Five `browser` calls in a row. `groupActivity` merges all five into one `ToolRunEntry(name:"browser", count:5)`; `toolGroupFragment` has no case for `browser`; `extractToolDetail` returns `nil` five times. The transcript row reads:

> `› Used 5 tools`

…and expanding it reveals **an empty area**. That is the whole record of five browser actions.

### 2.4 The enumerated waste — what exists on the wire and is not shown on the Mac

| Available | Where it is now | Shown on Mac? | Shown on iOS? |
|---|---|---|---|
| `tool_result.output` (≤64 KiB) | dropped at `SessionModel.swift:338-339` | **no** | yes, expandable monospaced |
| `tool_result.isError` | dropped, same line | **no** | yes, as the `xmark` status mark |
| in-flight state (call seen, no result) | derivable from unmatched `callId`; the Mac keeps no `callId` on `ActivityItem` at all | **no** | yes, pulsing `gearshape` |
| `tool_call.argsJson` beyond the 3 handled shapes | discarded by `extractToolDetail`'s `default:` | **no** | no (iOS drops args entirely) |
| `tool_call.callId` | not stored on `ActivityItem` | n/a | stored, used as the row id and the result join key |
| per-call timing (`event.ts` on call vs result) | present on both events | **no** | no |

Two things are **not** on the wire and cannot be shown by either client without a protocol change — state this plainly so nobody plans against it:

- **Browser screenshots are images, and the image never reaches a client.** `browser verb:"screenshot"` routes the PNG through `ctx.attachImage(…)` into the *model's* input, and `tool_result.output` gets only a text line (`packages/core/src/agent/tools/browser.ts:932-942`). Same for `computer` screenshots and `read`'s images. So "does either side render the screenshot?" — **neither, and neither can today.** Rendering it would need a new event or a field on `tool_result`, with all of CLAUDE.md's protocol-checklist obligations (the recursive per-event string cap and the remote-stream allowlist would both bite hard on a 3 MiB base64 payload).
- **Structured diffs.** `edit` results are prose, not a structured patch; neither side renders a diff, and there is no diff on the wire to render.

### 2.5 The target shape for the Mac (opinionated)

Combine, don't copy. The Mac should render **args (its strength) *and* results (iOS's strength)**:

```
⚙ Ran 3 shell commands, read a file                    ›     ← 11–13 pt, muted, one line
   ▸ bash  pnpm test                                        ← expanded: arg line (Mac's today)
     ┌────────────────────────────────────────────┐
     │ 1146 pass, 0 fail                          │         ← NEW: the output, monospaced,
     └────────────────────────────────────────────┘            horizontal-scroll, ElevatedSurface r10
   ▸ bash  git status
   ✗ read  /nope.ts   →  ENOENT: no such file                ← NEW: per-call failure mark
```

Concretely, in order of dependency:

1. Give `ActivityItem.Kind.tool` a `callId`, `output: String?` and `isError: Bool` (mirroring `TranscriptItem.Kind.tool`), and fold `tool_result` into the matching item instead of dropping it. This is the whole fix for finding #1.
2. Add the aggregate status glyph to the collapsed row (running / failed / succeeded), using iOS's quiet vocabulary — a bare `checkmark`/`xmark`, no circles, no green/red — but macOS's own idiom for the running state (see §4 on `symbolEffect`).
3. Extend `extractToolDetail` to cover `browser` (`verb` + `url`/`selector`), `web_fetch`/`ReadPage` (`url`), `web_search`/`Search` (`query`), `lsp` (`op` + `file`), `computer` (`action`), `Skill`/`ToolSearch` (name/query), `notebook_edit` (path).
4. Extend `toolGroupFragment` with the missing names, especially `browser` → "browsed"/"used the browser N times", `web_fetch` → "fetched a page", `web_search` → "searched the web", `computer` → "used the computer", `lsp` → "checked the code".

---

## 3. The cards, in detail

### 3.1 Approval

#### iOS anatomy — `ApprovalRowView.swift` (121 lines)

- **Placement.** An ordinary transcript row, in chronological position, **permanent** (`TranscriptView.swift:310-317`).
- **Container.** `VStack(alignment:.leading, spacing:10)`, `.padding(14)`, `.frame(maxWidth:.infinity, alignment:.leading)`, `.background(Theme.elevatedSurface, in:.rect(cornerRadius:16))` (`:21-29`). Gallery `15-chat-surface.md` §15.6 calls this "a floating decision card".
- **Header.** `Label("Approval: \(toolName)", systemImage:"hand.raised.fill")`, `.subheadline.weight(.semibold)` (`:22`).
- **Body.** `Text(summary).font(.footnote).foregroundStyle(.secondary)` (`:24`) — one line, no truncation cap, no expand toggle.
- **Actions (pending).** `HStack(spacing:10)`: `Button("Deny", role:.destructive).buttonStyle(.glass).frame(maxWidth:.infinity)` then Approve. Approve is `.buttonStyle(.glassProminent).tint(Theme.accent).frame(maxWidth:.infinity)` — **exactly one prominent button**, per §15.6's prominence rule (`:46-51, 75-93`).
- **Rule options.** When any option carries `rule != nil`, the Approve button *becomes* a `Menu("Approve") { … } primaryAction: { approve() }` — tap approves once, long-press reveals each rule-writing choice. Deny is untouched (`:74-93`). Options without a rule are filtered out of the menu (`:36-38`).
- **Resolved.** Buttons are replaced by a single `Label`: "Approved" `checkmark.seal.fill` `.green` / "Denied" `nosign` `.secondary`, `.footnote.weight(.semibold)` (`:55-58`). The card stays in scrollback forever — the auditability requirement §15.6 states explicitly.
- **Other terminal states.** `.sending` → `Label("Sending…", systemImage:"hourglass")` `.footnote`/`.secondary`; `.expired` → `clock.badge.xmark`; `.resolvedElsewhere` → `iphone.and.arrow.forward`, both `.footnote.weight(.semibold)`/`.secondary` (`:52-64`).
- **The never-optimistic state machine.** `ApprovalRowView.display(resolvedApproved:state:)` is a pure function with a stated precedence: an observed `approval_resolved` **always wins**; short of that only `.hostAccepted` may show an outcome, and a local tap in flight renders `.sending` and never an outcome (`:95-120`; `ApprovalModel.ButtonState`, `ApprovalModel.swift:22-34`). Approve also runs an `LAContext` device-owner check before sending (`ApprovalModel.swift:55-56`).
- **Animation.** None beyond SwiftUI's implicit state transition.

#### Mac anatomy — `PendingCards.swift` (716 lines)

- **Placement.** Not in the transcript. A `VStack(spacing:10)` band mounted between the transcript and the composer (`PendingCards.swift:13-43`; `WindowContentView.swift:153-169`). **Deleted the instant the approval resolves** (`SessionModel.swift:349-350`) and cleared wholesale by `turn_completed` (`:405-407`).
- **Container.** `VStack(alignment:.leading, spacing:10)`, `.padding(12)`, `.background(.thinMaterial, in:RoundedRectangle(cornerRadius:12, style:.continuous))` (`:303-328`).
- **Header.** Glyph + title, `.font(.system(size:13, weight:.semibold))`; glyph is a **literal character** `⚠` in `.secondary`, title `"Approval needed — \(toolName)"` in `.primary` (`:278-285, 308-316`).
- **Body.** `Text(summary)` at `.system(size:12, design:.monospaced)`, `.secondary`, `lineLimit(3)` with `.truncationMode(.middle)` and a character-count-heuristic "Show more"/"Show less" toggle at 11 pt (`:380-396`). **Monospaced — iOS uses `.footnote` proportional.**
- **Reviewer line.** `"⚠ reviewer: \(capReviewerReason(reason))"`, 11 pt `.medium` `.secondary`, capped at 100 chars single-line (`:270-276, 401-405`). **No iOS equivalent** — Mac-only, keep.
- **Actions.** `HStack(spacing:8)`: `Button("Approve").buttonStyle(.borderedProminent)` then `Button("Deny").buttonStyle(.bordered)`, `.controlSize(.small)`, both `.disabled(isInFlight)` (`:411-418`). Natural-width AppKit buttons, not equal-width.
- **Rule options.** A vertical stack of `.plain` 11 pt `.medium` `.secondary` text buttons *below* the primary row, one per option, excluding `allow_once`/`deny` by id (`:243-262, 420-435`). **Always visible, never a menu.**
- **Resolved.** — the card is gone.
- **In-flight.** Buttons `.disabled`; no "Sending…" text, no state label.
- **Errors.** An inline `errorLine` at 11 pt `.red` under the body (`:320-324`) — no iOS equivalent, keep.

#### Delta

| | iOS | Mac | Verdict |
|---|---|---|---|
| Position | inline, chronological | pinned band below transcript | **Move to inline.** Biggest structural change; also fixes "which tool call was this for?" |
| Persistence | permanent, freezes into "Approved"/"Denied" | vanishes | **Adopt iOS.** Auditability is a stated §15.6 requirement and the Mac violates it. |
| Prominence | one prominent (Approve accent glass) + one quiet (Deny glass), **equal width** | `.borderedProminent` + `.bordered`, natural width | Adopt equal width + one-prominent. Use macOS `.borderedProminent` with `.tint(Theme.accent)`, **not** glass. |
| Summary type | `.footnote` proportional secondary | 12 pt monospaced + 3-line cap + Show more | Mac's monospace is arguably right for a shell command. **Keep the mono + expand; adopt iOS's footnote size.** Judgment call — flag for the user. |
| Rule options | hidden behind Approve's long-press menu | always-visible quiet list | **Keep the Mac's.** A visible list is right on a pointer device; a long-press menu is a touch idiom (§4). |
| Header glyph | SF Symbol `hand.raised.fill` | literal `⚠` character | Adopt SF Symbols — the literal glyphs are the most obviously "unfinished" thing in the Mac cards. |
| In-flight | "Sending…" label | silent disable | Adopt the label. |
| Never-optimistic | pure `display()` function + local `ApprovalModel` | `isInFlight` set only | Mac already fails safe (it never claims an outcome), but has no positive resolved state to protect. Revisit after cards go inline. |

### 3.2 Question

#### iOS anatomy

**Pending and resolved are two different objects on iOS.** This is the design's key move (SP-ask-morph):

**Pending → the composer morphs.** A pending question renders **nothing** in the transcript (`TranscriptView.swift:319-336` — the switch only builds a card when `resolved`). Instead the composer's slot becomes `QuestionComposerView`, wearing the composer's own `ComposerChrome(radius:28)`, its icons temporarily gone (`QuestionComposerView.swift:13-62`). Multi-question blocks get a pill picker at the top, one chip per question header, accent-tinted when visible and check-marked when answered; Submit stays **one action for the whole block**. Tapping the box's empty space drops the keyboard; every option flip fires `.sensoryFeedback(.selection)`.

**Resolved → a frozen card in the transcript.** `QuestionCardView` (`QuestionCardView.swift`):

- **Chrome** (`QuestionCardChrome`, `:384-396`): `Theme.cardSurface` in `.rect(cornerRadius:28, style:.continuous)`, `.strokeBorder(Color.primary.opacity(0.17), lineWidth: 1/displayScale)` (a true hairline), `.compositingGroup()` then `.shadow(color:.black.opacity(0.05), radius:8, y:1)`. Note it is `cardSurface` — the *page's own* surface delineated by a rim, **not** the approval card's `elevatedSurface`.
- **Layout** (`:72-85`): `VStack(alignment:.leading, spacing:14)`, `.padding(16)`, one block per question separated by a `Rectangle().fill(Color.primary.opacity(0.08)).frame(height:1)`.
- **Question block** (`:144-180`): `VStack(spacing:10)`; optional header chip; then the question text in `.font(.body).fontDesign(.serif).lineSpacing(6)` — **the assistant's serif register**, "Norma's voice", `fixedSize(horizontal:false, vertical:true)`.
- **Header chip** (`:184-191`): `.caption2.weight(.semibold)`, `Theme.accent` foreground, `.padding(.horizontal,8).padding(.vertical,3)`, `Capsule().fill(Theme.accent.opacity(0.12))`. Gated on `questionShowsHeaderChip` — count > 1 **and** header present.
- **Option row, pending** (`:199-239`): `HStack(alignment:.firstTextBaseline, spacing:10)`. Glyph is honest about arity — `circle`/`checkmark.circle.fill` for single-select, `square`/`checkmark.square.fill` for multi (`:241-244`), `.subheadline`, accent when selected. Label `.subheadline`, **`.semibold` when selected**; description `.footnote`/`.secondary`. `.padding(.vertical,10).padding(.horizontal,12)`. **No resting chrome** — an unselected row has no border and no fill; selection alone paints it with `RoundedRectangle(cornerRadius:12,style:.continuous)` filled `accent.opacity(0.15)` and stroked `accent` at 1.5 pt. `.accessibilityAddTraits(.isSelected)`.
- **Other field** (`:248-261`): `pencil` glyph + `TextField("Other…", axis:.vertical).lineLimit(1...4)`, `.padding(.vertical,10).padding(.horizontal,12)`, `RoundedRectangle(cornerRadius:12).fill(.quaternary)`. Always visible.
- **Note disclosure** (`:266-287`): an accent `.footnote.weight(.medium)` `Label` toggling between "Add note"/`note.text.badge.plus` and "Hide note"/`note.text`; the field appears below when open. Gated by `questionAllowsNotes` (header-ful questions only).
- **Resolved answer row** (`:295-318`): the answer at `.callout` (16 pt) with a plain accent `checkmark` at `.body.weight(.medium)` in a **reserved 32 pt slot** trailing, plus 2 pt trailing pad; a recorded note trails as `.footnote`/`.secondary`. Fallback `"—"` while the interim flip has no records.
- **Footer** (`:322-358`): resolved cards carry **no footer at all** except the provenance line — `"answered by \(by)"`, or `"timed out — answered by best judgment"` when `by == "timeout"`, `.caption`/`.secondary`. Pending: `Button` with `.buttonStyle(.glassProminent).tint(Theme.accent)`, full-width, label "Submit" or `Label("Sending…", systemImage:"hourglass")`, disabled unless `live && !submitting && canSubmit`.
- **Disabled-after-answer.** `isResolved = resolved || interimResolved`. The interim flip is **cosmetic and conditional**: it fires only when the daemon reports `alreadyResolved == false`, so a race where someone else answered first reconciles through the real event instead of being pre-empted (`:54-57, 330-345`). `submitting` is set **synchronously before the `Task` hops**, to stop a double-tap firing two submits (`:331-333`).
- **The resolved multi-question stack** (`:87-129`) — the most distinctive animation in either app. A resolved card with >1 question splits into one card per question, stacked Photos-style: `depth = (k − frontIndex + count) % count` (a true loop, no ends); `scaleEffect(1 − depth*0.02)`; `offset(x: depth*6)`; `rotationEffect(±2.2° alternating by parity)`; `opacity 0` beyond depth 3; front card leans with the drag at `translation.width / 24`. Horizontal drag past ±70 pt cycles with `.smooth`, else springs back with `.snappy`. `.sensoryFeedback(.impact(weight:.medium, intensity:0.7), trigger: frontIndex)`. VoiceOver reads the front card only.

#### Mac anatomy — `PendingCards.swift`

- **One shape for everything**, in the pinned band; no composer morph, no resolved card. `PendingQuestionBody` (`:456-507`) is a `VStack(spacing:14)` of `QuestionBlock`s + one `Button("Submit").buttonStyle(.borderedProminent).controlSize(.small)`, disabled until `questionCardComplete`.
- **Title row.** Suppressed for a header-less (simplified) question so the text isn't duplicated (`showsCardTitleRow`, `:231-240`); otherwise `? \(header)` at 13 pt semibold.
- **Question block** (`:514-568`): `VStack(spacing:6)`; optional header at 11 pt semibold `.secondary`; question text at **13 pt sans `.primary`** — the register the whole rest of the window uses.
- **Option row** (`:594-631`): multi-select gets `checkmark.square.fill`/`square` with an accent-when-selected tint. **Single-select gets no glyph at all** — a bare `.plain` text button with `contentShape(Rectangle())`. There is **no visual selected state whatsoever for a single-select option**: no fill, no border, no weight change. The only feedback that a choice registered is the Submit button enabling. *(Read from code; worth the user confirming from memory — see §6.)*
- **Option label** (`:620-631`): label 13 pt `.primary`, description 11 pt `.secondary`, `VStack(spacing:1)`.
- **Other row** (`:633-647`): a `.plain` 12 pt `.secondary` "Other…" **button** that expands into a `TextField` with `.roundedBorder`. Two-step, unlike iOS's always-present field.
- **Note row** (`:653-662`): an always-visible `TextField("Add a note (optional)")` `.roundedBorder` 12 pt — unlike iOS's collapsed disclosure. Gated by `questionAllowsNotes`.
- **Preview pane** (`:577-591`): a genuinely **Mac-only** feature with no iOS counterpart — side-by-side layout where each option can carry a `preview`, rendered as a `ScrollView` of monospaced text capped at 180 pt on `Color.primary.opacity(0.06)` r8. iOS deliberately ignores `preview` (`Transcript.swift:91-93`). **Keep this.**
- **Draft persistence** (`:45-99`): `PendingCardDraft` is hoisted out of the view into `FieldStateAdapter.pendingCardDrafts`, keyed `sessionId|callId`, so a typed-but-unsubmitted answer survives the panel's maximize teardown. Mutual exclusion is enforced in the model — selecting clears Other, typing Other clears the selection. **A genuine Mac strength iOS lacks** (iOS's `QuestionCardView` holds `@State`, and iOS lets Other *coexist* with selections, appending it as an extra comma-joined part, `QuestionCardView.swift:40-52`). Keep the Mac's semantics; note the divergence.
- **Resolved.** — gone.

#### Delta summary

| | iOS | Mac | Verdict |
|---|---|---|---|
| Pending placement | composer morph | pinned band | **Do not port the morph** (see §4) — but do move the card inline into the transcript. |
| Resolved card | permanent frozen summary + provenance line | nothing | **Adopt.** Highest-value question change. |
| Question text register | serif `.body`, lineSpacing 6 | 13 pt sans | Adopt serif — it is the same allowlist binding as assistant prose, and it is what makes the card read as Norma asking. |
| Single-select selected state | accent fill 0.15 + accent 1.5 pt border + semibold label + filled glyph | **nothing** | **Adopt immediately.** This is a usability defect, not a style gap. |
| Selection glyph arity | circle vs square, honest | multi only | Adopt. |
| Other field | always visible, `pencil` + vertical field | hidden behind a button | Adopt iOS's always-visible form. |
| Note | collapsed disclosure with accent toggle | always-visible field | **Keep the Mac's** or adopt iOS's — low stakes. Slight preference for iOS's (less resting clutter). |
| Card chrome | `cardSurface` + hairline rim + r28 + soft shadow | `.thinMaterial` + r12 | Adopt the shape; use Mac brand tokens. r28 is a phone radius — see §4. |
| Multi-question | separator hairlines when pending; Photos-stack when resolved | separator-less stacked blocks | Adopt hairlines. **Do not adopt the stack** — see §4. |
| Preview pane | absent | present | Mac wins. Keep. |
| Draft survival | view `@State` | hoisted, keyed, unit-tested | Mac wins. Keep. |
| Submit | full-width prominent glass, "Sending…" state | small natural-width `.borderedProminent`, silent | Adopt full width + the sending state; keep `.borderedProminent`. |

---

## 4. What cannot — or should not — port

**Hard blockers (the API does not exist on macOS, or exists with different meaning).**

- `.buttonStyle(.glass)` / `.glassProminent`, `.glassEffect(.regular, in:)`, `.scrollEdgeEffectStyle(.soft, for:.top)`, `.buttonStyle(.glass)` on the jump pill. These are the iOS 26 Liquid Glass controls layer. macOS has no equivalent, and the gallery itself (`16-anti-patterns.md`, AP-1) says glass belongs on the *floating controls layer*, never on inline content. Use `.borderedProminent` + `Theme.accent` and `Theme.elevatedSurface`/`Theme.cardSurface` fills.
- `UIPasteboard`, `ShareLink`-to-share-sheet, `UIApplication.sendAction(resignFirstResponder:)`, `.scrollDismissesKeyboard`, `.sensoryFeedback`, `.contentShape` tap-to-dismiss-keyboard. All keyboard/haptic idioms with no Mac referent. The Mac already uses `NSPasteboard` correctly.
- `defaultScrollAnchor(.bottom)` + `ScrollPosition` are available on macOS 15+, but iOS's bottom-gap formula subtracts `contentInsets.top` to correct for the iOS 26 bars (`TranscriptView.swift:96-102`). **That correction is wrong on macOS** and would break the latch. Keep the Mac's own `contentOffset.y + containerSize.h >= contentSize.h − 40`.
- `ContentUnavailableView` **is** available on macOS — the Mac already uses it in `DispatchSurface`/`CoworkPlaceholder`. The empty state is portable.
- `.symbolEffect(.pulse, options:.repeating)` is macOS 14+ and portable, but CLAUDE.md-adjacent house rule in `TranscriptMessageViews.swift:11` says **no `repeatForever` animation** in this content ("renders under the morph's scale/blur/opacity bands"). Verify that constraint still holds for the shell window before adding a repeating pulse; a non-animated `gearshape` or a small `ProgressView` is the safe fallback. **Flag for the user.**

**Idioms that would be wrong on macOS even though they compile.**

- **The composer morph for pending questions.** On a phone the composer *is* the bottom of the world and there is nowhere else to put an urgent form. On a Mac the transcript is tall, the pointer is precise, and the composer is a persistent object the user is often mid-sentence in. Hijacking it would destroy an in-progress draft's affordance and would be unfindable if the user scrolled away. **Keep the Mac's card; put it inline in the transcript at the point the question was asked.**
- **The Photos-style resolved question stack.** It is driven by a horizontal `DragGesture` with a ±70 pt threshold and haptic confirmation. On a trackpad a horizontal drag is a scroll gesture, and there is no haptic. A resolved multi-question card on Mac should be **stacked blocks with hairline separators** — which is what the pending Mac card already is.
- **Long-press menus.** iOS's Approve-becomes-a-`Menu`-with-`primaryAction` is a touch disclosure. On Mac, the rule-writing options should stay a visible list (as they are) or become a `Menu` attached to a small chevron button — never a long-press.
- **44 pt touch targets.** iOS's option rows are `.padding(.vertical,10).padding(.horizontal,12)` around a `.subheadline` — roughly 40 pt tall. On Mac that is a fat row. Target ~26–30 pt with a **hover** state instead; `ShellSidebarRowStyle` (row height 32, corner radius 6, `Theme.rowHover`) is the house idiom to match, per `brand.md` §5.
- **Corner radius 24–28.** iOS's user bubble is r24 and its question card r28. Those are phone-scale radii. The Mac's own language is r18 (`newChatCardCornerRadius`), r12, r6 (sidebar rows). **Scale iOS's shapes into the Mac's radius ladder, don't copy the numbers.** Suggested: user bubble r18, cards r12–14, tool-output blocks r8–10.
- **Type sizes.** iOS uses the Dynamic Type ramp (`.body` = 17, `.callout` = 16, `.subheadline` = 15, `.footnote` = 13, `.caption` = 12, `.caption2` = 11) because Dynamic Type is mandatory on iOS. macOS has no Dynamic Type and its 13 pt system size is the norm. **Do not set assistant prose to 17 pt because iOS does.** The honest translation of "the assistant reads one register larger than the chrome" is roughly **15–15.5 pt serif with lineSpacing ~5** against 12–13 pt chrome. **This is the single value most in need of the user's eye.**

**Where `docs/brand.md` must win over iOS.**

- No hex, no computed colours, no `.opacity()` hacks for chrome (§3.1). iOS's `Color.primary.opacity(0.08)` separators and `Theme.accent.opacity(0.12)` chip fills are *exactly* the pattern brand.md forbids on Mac. Use `Theme.hairline` for separators; if an accent-tinted chip fill is wanted, it needs an authored asset.
- `.ultraThinMaterial`/`.thinMaterial` on inline content should go. The window is opaque `CardSurface`; a material over an opaque window is a no-op that looks muddy. Use `Theme.bubbleUser` for the user bubble, `Theme.elevatedSurface` for tool output and approval cards, `Theme.cardSurface` + `Theme.hairline` for the question card.
- **The accent stays out of navigation** (§3.2) and `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` stays unset. Any `.borderedProminent` in the transcript must carry an explicit `.tint(Theme.accent)`.
- **Accent-on-text contrast** (§3.4): the accent measures ≈3.5:1 on the light cream — below the 4.5:1 body floor. iOS colours the question header chip's *text* accent (`QuestionCardView.swift:186`) and the note toggle's label accent (`:274`). **Do not copy those to Mac as text colour** without the light-tuned variant brand.md says must come first. Use accent for fills, borders and glyphs.
- Serif is allowlist-bound to four bindings (§4). Applying it to assistant prose is binding #4 and is sanctioned. Applying it to the question card's question text — as iOS does — is arguably part of the same "Norma's voice" binding, but it is **not** literally on the list. **Amend the list in the same change, or leave the question card sans. Flag for the user.**

---

## 5. Proposed change list — visual impact per unit of risk

Ordered so that the top items are what a user notices in the first ten seconds. "Mechanical" = the values are determined; "judgment" = someone has to look at it.

| # | Change | Files | Surgery | Kind |
|---|---|---|---|---|
| **1** | **Show tool output.** Add `callId`/`output`/`isError` to `ActivityItem.Kind.tool`; fold `tool_result` into the matching item; render an expandable monospaced output block (horizontal scroll, `Theme.elevatedSurface`, r10, `.footnote`-equivalent) under each call; add the aggregate status glyph (running/failed/succeeded) to the collapsed row. | `Model/SessionModel.swift` (`:104-121`, `:335-339`), `ChatContent/TranscriptMessageViews.swift` (`:418-595`) | Medium. Reducer change + row rework. `appendActivity` already exempts `.tool` from its adjacent-dupe collapse (`:592-593`), so each call keeps its own slot and can carry its own result — no collapse rework needed. Two real constraints: the per-exchange **200-item drop-oldest cap** (`:598-600`) now bounds output too, and `appendActivity` returns early when `exchanges` is empty (`:590`), so a tool call before any user message is still dropped. | Mechanical, with one reducer design decision |
| **2** | **Brand + type the transcript.** Replace `.ultraThinMaterial`→`Theme.bubbleUser`, `.thinMaterial`→`Theme.elevatedSurface`/`cardSurface`, `.tertiary`→`Theme.textMuted`; assistant prose to serif at a Mac register; adopt iOS's spacing rhythm (row gap 16, block gap 12, column inset 20). | `ChatContent/TranscriptMessageViews.swift`, `TranscriptView.swift` | Medium, but almost entirely find-and-replace plus four numbers. | **Judgment** — the serif size/line-height needs the user's eye |
| **3** | **Cards go inline and stay.** Render approval/question cards as transcript rows in chronological position, and keep a frozen resolved summary ("Approved"/"Denied"; the answer + accent check + "answered by X"). | `Model/SessionModel.swift` (row model), `ChatContent/PendingCards.swift`, `TranscriptView.swift`, `WindowContentView.swift:153-169` | **Large.** Requires the exchange→item model change (#6) or a parallel per-exchange card list. The band mount and its `FieldStateAdapter` wiring both move. | Mechanical once the model decision is made |
| **4** | **Fix single-select options.** Give an unselected single-select option a `circle` glyph and a selected one `checkmark.circle.fill` + accent fill + accent border + semibold label, matching multi-select. Make "Other…" an always-visible field. | `ChatContent/PendingCards.swift:594-647` | Small, self-contained. | Mechanical — and arguably a bug fix |
| **5** | **Card chrome + button hierarchy.** SF Symbols instead of literal `⚠ ? ☰`; equal-width Approve/Deny with one prominent; full-width Submit; a "Sending…" in-flight label; hairline separators between questions. | `ChatContent/PendingCards.swift:278-341, 411-435, 492-495` | Small–medium. | Mechanical |
| **6** | **Event-shaped rows.** Replace `[Exchange]` with a flat `[TranscriptItem]`-equivalent so tool runs interleave with assistant text and per-round `assistant_message`s stop overwriting each other. | `Model/SessionModel.swift:127-138, 299-437`, `ChatContent/TranscriptView.swift` | **Large.** Touches the reducer's most-tested surface; `Exchange` is referenced by orb/menu-bar/detached-window code. | Judgment (scope), mechanical (execution) |
| **7** | **The Thinking row.** Port `TranscriptThinking.showsThinking` verbatim (it is pure) + a `ThinkingRow` at ~12–13 pt `Theme.textMuted` with a 0.35 s dot cycle, static under Reduce Motion. | `ChatContent/TranscriptView.swift`, new pure helper | Small. Needs a `turnRunning`-equivalent, which the adapter already has. | Mechanical |
| **8** | **Message actions + footer.** Under the last finished assistant message only: a 16 pt glyph row (copy, share) + the two-line disclaimer footer with the accent asterisk. | `ChatContent/TranscriptMessageViews.swift:48-96`, new view | Small. | **Judgment** — whether to include iOS's four decorative mocks. Recommendation: **no**, they are a phone-parity affectation and hovering a dead glyph on Mac is worse than on touch. |
| **9** | **Send choreography.** Pad the last turn to one viewport minus insets so a send tops the user's message out with blank run-out below. | `ChatContent/TranscriptView.swift` | Small code, fiddly to tune. Needs a viewport-height source. | **Judgment** — the feel is the whole point |
| **10** | **Empty state.** `ContentUnavailableView` for a session with no messages, connection-state aware. | `ChatContent/TranscriptView.swift` | Trivial. | Mechanical |
| **11** | **Tool vocabulary + detail extraction.** Add `browser`, `web_fetch`, `web_search`, `computer`, `lsp`, `notebook_edit`, `ReadPage`, `Search`, `Workflow`, `spawn_agent` to `toolGroupFragment` and `extractToolDetail`. | `TranscriptMessageViews.swift:486-521`, `SessionModel.swift:611-633` | Small, pure, unit-tested both sides. | Mechanical |
| **12** | **Distinct error row.** Stop folding `agent_error` into the reply text; render iOS's orange-triangle `Label` on `Theme.elevatedSurface`. | `SessionModel.swift:428-437`, `TranscriptMessageViews.swift` | Small. | Mechanical |
| **13** | **Jump pill.** Bottom-centre, "Jump to latest", `.transition(.move(edge:.bottom).combined(with:.opacity))`. | `ChatContent/TranscriptView.swift:46-66` | Trivial. | Mechanical |

**Needs the user's eye before it can be settled:**
- The serif size and line height for Mac assistant prose (#2). iOS's 17/27 is a phone metric.
- Whether the question card's *question text* gets serif — this would be a fifth serif binding and `brand.md` §4 forbids adding one without amending the list.
- Whether tool output is expanded-by-default for the last tool run of the current turn (iOS is always collapsed; on a large Mac window, always-collapsed may be too coy).
- Whether the four decorative action mocks are wanted on Mac (#8).
- The repeating `symbolEffect` pulse vs the "no `repeatForever` in this content" note at `TranscriptMessageViews.swift:11`.

---

## 6. Screenshots by proxy — what each surface renders today

Neither of us can see the screens. These descriptions are derived from code and should be **confirmed or corrected from memory** before the redesign locks.

### The Mac, today

- The window content column is inset **16 pt** from both edges. At the top sits a **30 pt** header strip: a small status word at 12 pt grey on the left (e.g. "Thinking", "Idle") and a row of plain grey SF Symbol icon buttons on the right (folders, moon, model, effort, policy). No divider under it.
- The transcript fills the middle. Rows are **14 pt apart**. Nothing is centred and nothing is width-limited except the user bubble.
- **A user message** is a rounded rectangle hugging the right edge, radius 18, filled with a *translucent frosted material* (which over the opaque warm-white window reads as a slightly cloudy pale grey), padded 14 pt, capped at **560 pt** wide with at least a **90 pt** gap from the left. Text is 14 pt, near-black.
- **An assistant message** is plain left-aligned text at **14 pt sans**, full window width, line spacing 3, starting flush at the 16 pt inset. No bubble, no avatar, no name. Headings step 20 / 17 / 15.5 / 14.5 pt. Bullets use a teal-ish `tint`-coloured `•`. Code appears in a rounded r12 card, slightly darker than the page, which **grows a coloured border, a shadow and scales up 0.6% when the pointer enters it**.
- **Underneath each finished assistant message** is a small grey `doc.on.doc` icon in a fixed 68×22 slot; hovering turns it from grey to near-black; clicking swaps it for `✓ Copied` for 1.2 s.
- **A tool run** is one line of **11 pt light-grey text** with a tiny 9 pt chevron on the left — e.g. `› Read 4 files, listed 1 directory, ran 8 shell commands` — truncated in the *middle* with an ellipsis if long. Clicking rotates the chevron 90° and reveals monospaced 11 pt light-grey lines indented 16 pt, each reading `bash pnpm test` or `read /path/to/file.ts`. **There is no checkmark, no error mark, no spinner, and no output text anywhere.** A run of `browser` or `web_fetch` calls reads `› Used 5 tools` and expands to nothing.
- **A pending approval** appears as a frosted rounded r12 box **below the transcript and above the composer** — `⚠ Approval needed — bash` at 13 pt semibold, then the command in **12 pt monospaced grey** clipped to 3 lines with a middle ellipsis and a grey "Show more" beneath, then a small blue **Approve** button and a small grey **Deny** button side by side at their natural widths, then any rule options as small grey text-only lines.
- **A pending question** appears in the same band: a `?` glyph and header at 13 pt semibold, the question at 13 pt, then the options as **plain 13 pt text lines with no bullet, no radio, no box and no highlight when chosen**, then a small grey "Other…" text button, then a bordered "Add a note (optional)" field, then a small blue Submit that is greyed out until every question has an answer.
- **The instant you answer, the card disappears** and nothing is left in the transcript to say it happened — except a single 11 pt grey `⚠ <summary>` line where the interaction occurred.
- Below all that: the pinned tasks section, any queued-steer text at 11 pt, the composer card (warm opaque face, r18, 16 pt text), and a live-subagent strip.
- **A session with no messages is an empty rectangle.**

### iOS, today

- The transcript is the page, on the warm card surface, inset **20 pt** horizontally / 12 pt vertically, rows **16 pt** apart, growing from the bottom.
- **A user message** is a warm grey near-capsule hugging the right, radius **24**, padded 13/18, at **17 pt** — a one-line reply renders about 50 pt tall and reads as a pill.
- **An assistant message** is **serif** body text at 17 pt with 27 pt line pitch, full width, no container. Code blocks are monospaced footnote on the elevated surface, r10.
- **A tool run** is one muted warm-grey line at 14 pt with a small trailing chevron and a **status mark leading it**: a pulsing gear while running, a bare `✓` when done, a bare `✗` when any call failed. Tapping expands to the **actual command output**, monospaced footnote, on a slightly raised r10 block that scrolls horizontally.
- **While the model is between steps**, a muted `Thinking` with three cycling dots sits at the bottom of the transcript.
- **An approval** is a raised r16 card *in the flow of the conversation*: `🖐 Approval: bash` in semibold subheadline, the summary in secondary footnote, then two equal-width buttons — a quiet **Deny** and an accent-filled prominent **Approve**. After you answer, the buttons are replaced by a green `✓ Approved` chip **and the card stays there forever.**
- **A pending question** does not appear in the transcript at all — **the composer becomes the question**, wearing the composer's own material at radius 28, with options, an Other field and a full-width accent Submit.
- **Once answered**, a card materialises in the transcript: warm card-surface face, radius 28, a hairline rim, a very soft shadow — the question in **serif**, the chosen answer at 16 pt with an accent `✓` in a reserved slot on the right, and a small grey `answered by <user>` at the bottom. If there were several questions, the card becomes **a leaning stack you swipe through, looping**.
- **Under the last finished reply**: a row of six 16 pt grey glyphs (copy, share, play, thumbs up, thumbs down, retry — the last four decorative), then 24 pt down, a teal asterisk on the left and a right-aligned two-line "Norma is AI and can make mistakes."
- **Sending a message** snaps it to the *top* of the viewport with an empty run-out below, and the reply fills the blank without the page moving.

---

## 7. Determined-from-code caveats

Everything above is read from source. These specifically could not be verified without running the apps, and should be treated as claims to check rather than facts:

- **Rendered sizes of `.ultraThinMaterial` over an opaque `CardSurface` window.** Code says translucent; the rendered result over an opaque background is a system-computed blend I cannot measure.
- **Whether the Mac single-select option genuinely shows no selected state.** The code path (`PendingCards.swift:608-617`) has no selected branch, but SwiftUI `.plain` buttons on macOS can pick up a system pressed/focus treatment. High confidence, not certainty.
- **Animation feel** — iOS's `.smooth`/`.snappy` timings, the 0.35 s dot cycle, the stack's drag inertia, and the Mac's 0.18 s `easeOut` scroll. Numbers are exact; how they feel is not derivable.
- **Whether the Mac's transcript autoscroll actually lands correctly** with `proxy.scrollTo(index, anchor:.bottom)` inside a `LazyVStack` whose last row is still growing. iOS explicitly documented needing a next-tick hop for this class of bug (`TranscriptView.swift:149-152`).
- **How the 200-item activity cap** (`Exchange.activity`, `SessionModel.swift:130-134`, enforced at `:598-600`) interacts with storing tool output — 200 items × up to 64 KiB per exchange is a real memory consideration the current no-output design never faced. A per-item display cap (iOS has none either, but iOS pages history and the Mac replays whole sessions) may be wanted.
