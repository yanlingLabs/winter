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

### Important-1 — CLOSED (cap) / see §3 V-1 for the measurement

`officeFormatWidthMaxColumns = 64`, enforced in `handleSheetsFormat` **before** the broker, on
`range.columnCount`, independently of the 2,000-cell cap. Sized against the use, not the machine.

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

## 3. Verification owed (V-1…V-9)

(filled in as each lands)

## 4. Suite numbers

(filled in at the end)
