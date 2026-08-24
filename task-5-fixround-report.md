# Task 5 fix round — `sheets format`

Closing `task-5-review.md` (1 Critical, 4 Importants, 5 Minors, V-1…V-9).
Branch `office-agent`, starting at `d97e69db`.

**Status: IN PROGRESS** — this file is written continuously, not at the end.

---

## 0. Scope expansion, declared up front (pushback / addition to the review)

The review's Critical-1 names ONE unchecked-`Int` door: `officeColumnIndex`'s `value * 26 + …`.
Reading the same functions for the fix found **three more doors of the identical class** — all
agent-reachable, all aborting the whole Mac app, none named by the review or by any artifact in the
arc:

| # | Vector | Path | Daemon-side bound? |
|---|---|---|---|
| C-a | `range:"AAAAAAAAAAAAAA1"` (14 letters) | `officeColumnIndex` `value * 26` | none (`[A-Za-z]+`, `.max(64)`) |
| C-b | `range:"A1:B9223372036854775807"` | `officeParseCellReference` accepts row = `Int.max`; the consumer's very next line computes `range.cellCount` = `columnCount * rowCount` = `2 * Int.max` | none (`[1-9][0-9]*`, `.max(64)` — 23 chars) |
| C-c | `sheets insert_rows at:1e30 count:1` | `requiredCount`/`atRow`'s `Int(n)` on an unbounded `Double` — `Int(1e30)` traps | `z.number().int().positive()` — **unbounded**; `Number.isInteger(1e30)` is `true` |
| C-d | `sheets insert_rows at:1 count:9223372036854775807` | `startRow + count - 1` | `count: z.number().int().positive()` — unbounded |

C-b is the one that matters most for the review's own prescription: **fixing only the letter run
would have shipped the class half-open.** The row half needs the symmetric bound.
(C-c/C-d are T4's `resize`, not `format`; C-a/C-b are shared by `read`/`set`/`format`.)

Also swept and found daemon-bounded-only, so guarded app-side too for the same reason:
`optionalWidth` returns an unbounded `Double` into `officeWidthMm100`'s `Int((points * 2540/72).rounded())`.

**Fix philosophy: bound LEXICALLY, not semantically.** `officeColumnIndex` stays the pure inverse of
`officeColumnLetters` and deliberately does NOT learn Calc's XFD/1048576 grid limits — see §I-3: the
out-of-grid vectors `XFE1` and `D9999999` are exactly what makes a real, permanent, non-mutant
regression test for `format`'s position verification possible. Letters ≤ 3 (Calc's real max is XFD)
and row digits ≤ 7 (max 9,999,999 > Calc's 1,048,576) refuse every overflow while keeping both
vectors alive.

---

## 1. Per-finding resolution

### ⛔ Critical-1 — CLOSED (and widened: four vectors, not one)

**Red, measured before any fix** (§2). **Fix**, all in `515c71c2`:

- `officeColumnIndex` (`PanelDocumentTab.swift`) — `officeColumnMaxLetters = 3` up front (Calc's real
  max column is XFD) **plus** `multipliedReportingOverflow`/`addingReportingOverflow`. The length
  bound is the load-bearing half and is labelled as such in the header: checked arithmetic alone
  would NOT have closed it, because a 13-letter run returns a finite 2.58e18 that then overflows
  `cellCount` at the consumer's very next statement (measured: `range:"A1:AAAAAAAAAAAAAA4"`).
- `officeParseCellReference` — `officeRowMaxDigits = 7` (9,999,999 > Calc's 1,048,576 rows).
  Together the two bounds cap `cellCount` at ~1.8e11, so every downstream `Int` on a parsed range is
  total by construction.
- `OfficeCommandConsumer.requiredCount` / the resize `at` decode — `officeResizeMaxCount`
  (1,048,576) and `officeResizeMaxAt` (9,999,999), on BOTH the `.number` and `.string` arms.
- `OfficeCommandConsumer.optionalWidth` — bounded to [1, 1000] points (daemon-bounded already;
  guarded anyway, because "the daemon happens to bound it" is the exact reasoning that left the
  other three doors open), with its own refusal message so a bad width does not report as
  "name at least one attribute".
- `LOKBridge.parseSingleCellReference` — the helper-side re-encoding carries the same two bounds. A
  re-encoding that drifts on the one property that makes the original total is worse than none.
- `sheets.ts` — `A1_RANGE_SHAPE` tightened to `[A-Za-z]{1,3}[1-9][0-9]{0,6}`, `at`/`count` given
  `.max()`. **Not** the load-bearing fix (said so in the commit and the comment); it turns a
  155-second silent timeout into an immediate, specific model-facing refusal.

**Bounds are lexical, never Calc's grid** — `XFE1` (one column past XFD) and `D9999999` stay
expressible on purpose. That is what makes the I-3 position-verification drill possible without
mutating production code; both directions are pinned by tests so a later tidy-up cannot tighten it.

Regression tests: `PanelDocumentTabTests` ×4 new (14-letter both letters, 4-letter `XFDA`/`AAAA`,
`Int.max` row, the 14-A+4-rows `cellCount` vector, the lexical-not-grid pin, and a
"no accepted range can overflow `cellCount`" property test); `sheets.test.ts` ×3 new + 1 pin.

### Important-1 — CLOSED, and the finding's premise is falsified (pushback)

`officeFormatWidthMaxColumns = 256`, enforced in `handleSheetsFormat` **before** the broker, on
`range.columnCount`, independently of the 2,000-cell cap.

**But V-1's measurement contradicts the finding's severity, and I am not going to write it up as
though it did not.** The review's claim was a wedged helper — "office wedges for every document
until the app is restarted" — resting on `getTextSelection` serialising whole columns of the sheet's
full 1,048,576 rows. It does not. Two purpose-built fixtures, driven through the real helper, with
the width phase measured as its MARGINAL cost over the same call's cell-attribute baseline:

| Fixture | width 3 cols | 64 cols | 200 cols | 1,999 cols |
|---|---|---|---|---|
| 100,000 used rows x 3 used columns | +0.13s | +0.50s | — | +0.50s |
| 20,000 used rows x 200 used columns (4M used cells) | +0.04s | +0.34s | +1.58s | +2.44s |

The selection is bounded by the USED data area, not the grid. The worst case measured — every
column of a four-million-cell workbook, on the one dedicated LOK thread — is under three seconds
against a 155-second deadline. **Nothing wedged, at any width, on any shape tried.**

The cap is kept for the two reasons that survive the measurement: an operand that reaches LOK
should be bounded rather than merely observed survivable at the sizes someone happened to try, and
a `width` call naming hundreds of columns is far more likely a model error than an intention —
refusing it in milliseconds beats spending seconds on it. It is raised 64 -> 256 so the number
comes from the measurement rather than from taste: an order of magnitude above any real formatting
call, 1.6s at the measured 200-column point, so it cannot refuse work anyone actually wants.

### Important-2 — CLOSED

The numberFormat triangle now re-opens the saved file under a fresh `docId` through the helper
client and reads the cell back **through LOK** (`client.sheetsRead`), asserting the percent format
survived — the brief's own clause, previously discharged by `XCTAssertFalse(reopenSheets.isEmpty)`.
It also reads it in `formulas:true` mode, which is where Minor-5 turned into a real defect (below).

### Important-3 — CLOSED, both halves

1. The false doc comment is unwound. `testLiveSheetsFormatRefusesAnUnwritableSheetName…` keeps its
   accurate name and now describes what it actually does — a sheet-resolve refusal three guards
   before any positioning — and says so explicitly, naming the review finding.
2. A **real** position-verification drill is landed:
   `testLiveSheetsFormatRefusesWhenTheCursorCannotReachTheSpanAndTouchesNothing`, riding
   `range:"XFE1"`. Non-mutant, permanently committable, and possible **only** because the Critical's
   bound is lexical rather than grid-shaped — the two fixes are complementary, which is why the
   parser's header and the drill's header cite each other.

### Important-4 — CLOSED (trigger + both branches), with one clause left open, measured

- **Trigger narrowed** from `attributeCount > 1` to "a cell attribute AND `width`", from the
  structural argument: phase 1 does all of its throwing before its first `postUnoCommand` and has no
  throwing statement between the four cell dispatches, so `bold + italic` cannot half-apply. Pinned
  by a new unit test.
- **Both branches' DISTINGUISHING sentences** are now asserted, and each asserts the other's is
  ABSENT — the old pair asserted only `"already applied"`, common to both, so swapping the two texts
  would have kept them green. Forced red by inverting `adopted`: 6 failures across the two tests,
  each red naming the wrong branch's sentence.
- **The adopted branch is produced by a test at all** for the first time — `makeSheetsWorld`
  hardcoded `existingRuntime: { _ in nil }`, so every test through it was the opened branch.
- **V-4 forced live**, on an adopted document, with a genuine phase-1-succeeds/phase-2-fails split
  (`range:"XFC1:XFE1"`: the anchor XFC1 is reachable, the column span XFC:XFE is not). See §3 V-4
  for the one clause this still cannot force.

### Minors

- **Minor-1** (report misnamed which `align` value was fired): correct — `center` was fired, `left`
  was not. Recorded here as the ledger correction, and V-7 now fires `left` and `right` live as
  well, so the point is moot going forward.
- **Minor-2** (the vacuous `numFmtId != 0`): **confirmed by the fixture bytes** (V-6) and fixed —
  per-cell comparison against the captured pristine value, matching the sibling preset drill.
- **Minor-3** (`format` reports "applied" with no read-back): the tool description now says so
  plainly — `format` reports what it dispatched and then saved, unlike `set`/`resize` which re-read;
  read back yourself if a specific cell's formatting is load-bearing. Mechanism unchanged (adding a
  read-back for five attributes is a design change, not a fix-round patch).
- **Minor-4** (no negative decode test for the two wire guards): **not fixed, deliberately.** The
  review itself concludes T5 is consistent with the file's precedent here, the only producer is
  pinned, and adding one arm's negative test while `sheetsManageSheet`'s analogous guard stays
  untested would be cosmetic. Ledger item.
- **Minor-5**: see §2 — this one was not "untested", it was **wrong**.

## 2. Red/green evidence

### Critical-1 — the red (V-5), before the fix

Rather than aborting a live Debug app, the four production functions were copied **verbatim** out of
`d97e69db` into a standalone `swiftc -O` binary (`scratchpad/overflow-red.swift`) together with a
transcription of the daemon's own `A1_RANGE_SHAPE` + `.max(64)`, so each vector is proven to pass
daemon validation in the same run that proves it traps. `exit 133` is SIGTRAP.

```
C-a  range=ZZZZZZZZZZZZZZ1        len=15  daemonAccepts=true   -> exit=133   (14 letters)
     range=AAAAAAAAAAAAAA1        len=15  daemonAccepts=true   -> startColumn=2580398988131886038, exit=0
C-a' range=A1:AAAAAAAAAAAAAA4     len=18  daemonAccepts=true   -> exit=133   (cellCount, one line later)
     range=A1:AAAAAAAAAAAAAA2     len=18  daemonAccepts=true   -> cellCount=5160797976263772078, exit=0
C-b  range=A1:B9223372036854775807 len=23 daemonAccepts=true   -> exit=133   (cellCount = 2 * Int.max)
C-c  at=1e+30  isInteger=true                                  -> exit=133   (Int(Double))
C-d  at=1 count=9223372036854775807                            -> exit=133   (at + count - 1)
```

**Precision correction to the brief and the review.** The brief's own example, `AAAAAAAAAAAAAA1`
(14 **A**s), does **not** trap in `officeColumnIndex` — 14 A's is (26^14−1)/25 ≈ 2.58e18, inside
`Int.max` ≈ 9.22e18. The review's `ZZZZZZZZZZZZZZ1` (14 **Z**s ≈ 6.7e19) is the one that traps
there. The brief's vector is still lethal, one line later, the moment the range names more than
three rows (`A1:AAAAAAAAAAAAAA4`, measured above) — so the conclusion stands and the bound is on
LENGTH, not on a value. Both sides of that boundary are now pinned by tests.

### Critical-1 — the green

`sheets.test.ts`: 63 pass / 0 fail. Forced red first — reverting the regex and the two `.max()`
calls turns exactly the three new tests red (`3 fail`) and leaves the "still expressible" pin green,
which is the correct direction for a pin. Swift: `PanelDocumentTabTests` 69 pass,
`OfficeCommandConsumerTests` 49 pass, 0 failures.

Note on the Swift regression tests' shape: they are `XCTAssertNil`, and a trap is **not** catchable
by XCTest — if the guard is ever removed these tests do not fail, they take the whole test runner
down. That is the loudest available red, and the test names say "abort" so the next reader knows.

### Minor-5 — the description was not merely untested, it was FALSE

`sheets.ts` told the model, as fact, that a percent-formatted cell holding 0.5 "still sees the plain
number 0.5" from a `read` in **formulas mode**. The new reopen-through-LOK read in the triangle
drill was written to check that claim and **measured the opposite**:

```
read formulas:true on D7 (0.5, formatted percent) -> [["50.00%"]]
```

There is no formula on a constant cell, so the engine falls back to the formatted text. A model
following that description to recover a raw value would have got the display string and silently
computed with a percentage. The description now states the measured behaviour and points at the
working alternative (compute with the cell in a formula — `=D7*2` gives 1, which this drill already
proved). The drill pins the real behaviour, in both directions, so the text and the code cannot
drift apart again. The same run also pins the exact `"50.00%"` string the description quotes, which
was previously checked only by `contains("%")`.

## 3. Verification owed (V-1…V-9)

| V | Status |
|---|---|
| **V-1** — does `getTextSelection` shrink a whole-column selection to the used area? | **CLOSED — yes.** Two purpose-built fixtures (100k rows x 3 cols; 20k rows x 200 cols = 4M cells), built by zip surgery on `gate.xlsx` and driven through the real helper. Numbers in §1 Important-1. Falsifies the finding's wedge severity; the cap is retained on other grounds and re-sized from the data. Fixtures deliberately NOT committed (2 MB / 20 MB); the generator is trivial and described here. |
| **V-2** — deletion-red for `format`'s span check | **CLOSED, and it independently confirms `task-5-report.md`'s self-report.** Deleting `selectionTextOnDedicatedThread`'s span call reproduces the report's quoted message verbatim: `could not confirm the cursor reached D1:D1 in <uuid> (landed at B1 instead) — nothing was formatted`. Reverted; green again. The gap it was covering is now closed permanently by the `XFE1` drill. |
| **V-3** — does an attribute survive a reopen THROUGH LOK? | **CLOSED — yes.** `client.sheetsRead` on a fresh `docId` after the save returns `"50.00%"`. |
| **V-4** — force a genuine partial failure on an adopted document | **CLOSED except one clause.** Forced live (`XFC1:XFE1`), adopted branch, sentence asserted, bytes checked. **What could NOT be forced:** the disclosure's "Norma will refuse further writes" clause. Measured: after the forced partial the document is **not dirty** (`dirty=false`, permanent evidence line in the drill) — phase 1 verified its anchor but its dispatch left the document unmodified. The sentence is conditional, so with a false antecedent it holds vacuously and the next write is correctly accepted; the drill is a two-armed oracle asserting the right behaviour for whichever state it observes, and prints which arm ran. Forcing a partial where the earlier attribute genuinely lands needs a phase-2 failure following a phase-1 dispatch that really modified the document, and no operand combination found does that without mutating production code. The dirty-refusal mechanism itself is broker rule 3, proven independently by `set`'s own drills. |
| **V-5** — confirm the overflow trap empirically | **CLOSED**, four vectors, §2. Done against verbatim copies in a standalone `-O` binary rather than by aborting a live app — same proof, no collateral. |
| **V-6** — is the `numFmtId != 0` assertion vacuous? | **CLOSED — yes, exactly as analysed.** `gate.xlsx`: `<numFmt numFmtId="164" formatCode="General"/>` and **both** `cellXfs` entries carry `numFmtId="164"`. The assertion could not fail for any input. Fixed per-cell. |
| **V-7** — `align:"left"`/`"right"` and `italic:false` un-fired | **CLOSED** — new drill fires all three alignments against the saved styles and clears italic explicitly. |
| **V-8** — `formulas:true` and the exact `"50.00%"` | **CLOSED**, and it found a false claim — see Minor-5 above. |
| **V-9** — the suite numbers were self-reported | **CLOSED** — re-run here, §4. |

### One thing observed and deliberately NOT chased

A single failure of `testLiveSheetsFormatWidthWidensEveryColumn…`, on the first full-file run right
after a build:

```
an internal positioning check before formatting could not confirm the cursor reached B1 ...
(landed at D1 instead)
```

That is the SENTINEL park — a discrete loss of a `.uno:GoToCell`, the known
`goToCellVerificationAttempts` flake class. **Not reproduced in 3 subsequent full-file runs or 2
isolated runs** (14/14 green each time). Per T6's own measurement precedent (`a5634172`: raising the
budget is empirically wrong; the cure for a discrete loss is re-posting), the right response is a
retry inside `positionAndVerifySpanOnDedicatedThread` — which is shared by `read`/`set`/`format`/
`resize` and is mechanism surgery well outside a fix round's remit. Recorded with its exact message
so the next person has the observation rather than having to rediscover it.

## 4. Pushback on the review

Four items, in descending order of consequence. The review was careful and mostly right; these are
the places where following it exactly would have produced a worse result.

1. **The Critical's prescription was half a fix.** "Bound the letter run" closes the column door and
   leaves the row door — `range:"A1:B9223372036854775807"`, 23 characters, matching the daemon's own
   shape regex — wide open, aborting the app one line later in `cellCount`. Two more doors of the
   same class (`Int(1e30)` in the resize `at`/`count` decode; `at + count - 1`) are named nowhere in
   the arc. All four measured. **The finding was right; its prescription was not sufficient.**

2. **Important-1's severity does not reproduce.** The wedge premise — whole-column selections
   serialising the full grid — is false: the selection is bounded by the used data area, and the
   worst case measured is +2.4s on a 4M-cell workbook. I kept a cap, because bounding an operand is
   right regardless, but I re-sized it from the measurement and rewrote both its header and the
   model-facing text so nobody inherits the wedge story as fact. **A cap sold on a false premise is
   the same defect class this arc keeps paying for, pointed at the fix instead of the code.**

3. **The brief's own Critical vector is the wrong one.** `AAAAAAAAAAAAAA1` (14 A's) does not trap in
   `officeColumnIndex` — 2.58e18 fits. `ZZZZZZZZZZZZZZ1` (the review's vector) does. Immaterial to
   the conclusion, material to anyone re-running the proof: a tester using the brief's string would
   have seen it return cleanly and concluded the finding was wrong.

4. **Minor-1 is right about the shipped test and understates its own importance.** `center` was
   fired, `left` was not, and the review is correct that this pins the enum FAMILY. Worth saying
   plainly in the ledger, because the T5 report's version of this sentence is the one a later reader
   would cite.

One thing the review flagged as a Minor that turned out to be a genuine defect: **Minor-5.** It was
filed as "asserted to the model but tested by nothing." Testing it showed the claim is **false**.
That is the arc's own lesson landing on the review itself — "untested" and "wrong" are not
distinguishable until somebody runs it.

## 5. Suite numbers

All run at `55b7583e` (the last code commit), after `pkill -9 -f NormaOfficeHelper`, one suite at a
time (the sentinel flake below is load-sensitive; running both concurrently would have tainted the
numbers this report cites).

- **`packages/core`, full `bun test`**: **4114 pass / 1 skip / 1 fail** (14594 expectations, 266
  files, 122s). The one failure is `tools-bash.test.ts` -> "git runs through the sandbox with clean
  output (no spurious permission errors)" — **byte-identical to the baseline `task-5-report.md` §8
  names**, the pre-existing environmental sandbox/mktemp flake every task on this branch has
  documented. Not `pnpm test`, deliberately: the CLI TUI suite is red on `main` and would have made
  these numbers meaningless.
- **`packages/core` `tsc --noEmit`**: the same 6 pre-existing `TS18048` errors in
  `test/agent/approvals.test.ts`, unchanged. Nothing new.
- **`test/agent/tools/sheets.test.ts`** (targeted, during iteration): **63 pass / 0 fail**, up from
  59 — four new tests, each forced red first against the pre-fix schema (`3 fail`, the correct three).
- **Swift, full unscoped `xcodebuild test`**: **2999 tests, 18 assertion failures across 7 methods,
  428s.** Every one dispositioned:

  | Method | Class |
  |---|---|
  | `OfficeSheetsCommandTests.testLiveAgentReadNeverTouchesThePrimaryViewsOwnSelection` (T3) | GoToCell straggler |
  | `OfficeSheetsCommandTests.testLiveSheetsSetWritesValuesAndAFormula…` (T4) | GoToCell straggler |
  | `OfficeSheetsFormatTests.testLiveSheetsFormatAppliesACellAttributeAndWidthInTheSameCall` (new here) | sentinel park, "landed at B3 instead" |
  | `OfficeSheetsFormatTests.testLiveSheetsFormatBoldFalseExplicitlyClearsExistingBoldness` (T5) | sentinel park, "landed at A1 instead" |
  | `OfficeSlidesCommandTests.testLiveAddSlideInsertsAtEveryRequestedPosition` (T6) | slides positioning |
  | `SurfaceWindowTests` x2 | the named known-unrelated `pollUntil` flake (`task-5-report.md` §8) |

  The five office methods were re-run in isolation **three times each after `pkill`: 15/15 green.**
  All five are the documented `goToCellVerificationAttempts` discrete-loss class under full-suite
  contention, which `task-4-report.md`, `task-5-report.md` and this task's own brief all name as
  known-unrelated. No mechanism was touched (see §3's note on why).
- **`OfficeSheetsFormatTests`** (this task's file), targeted: **14/14**, run four separate times
  clean; 10 original drills + 4 new (position verification, cell+width combined, forced partial on
  an adopted document, all-alignments + italic-clear).
- **`OfficeCommandConsumerTests`**: **56/56** (was 49) — 7 new.
- **`PanelDocumentTabTests`**: **69/69** (was 65) — 4 new.

## 6. Residuals, disclosed not fixed

1. **The partial-application sentence is still broader than "actually possible."** It is now exactly
   "structurally possible for THIS OPERAND COMBINATION" (a cell attribute + `width`), which is the
   fix Important-4 asked for. It is not "possible for THIS FAILURE": the full-suite run above caught
   a case where **phase 1 itself** failed its position check — nothing was dispatched at all — and
   the sentence still appeared. Narrowing that further needs the bridge to tell the consumer WHICH
   phase threw, i.e. a signature change on `sheetsFormat`, not a fix-round patch. The sentence is
   conditional, so it remains true; it is noise, and the noise is now bounded to one shape instead
   of ten.
2. **`format` still has no post-write read-back** (Minor-3). Description made honest; mechanism
   unchanged.
3. **Minor-4's two wire-codec guards still have no negative decode test.** Consistent with the
   file's own precedent, which the review itself notes.
4. **The sentinel-park flake** — observed, characterised, deliberately not chased (§3).
5. **The V-1 fixtures are not committed** (2 MB and 20 MB). Regenerating them is ~15 lines of zip
   surgery on `gate.xlsx`, described in §1 Important-1.
