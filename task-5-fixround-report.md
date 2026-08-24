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

(filled in as each lands)

## 2. Red/green evidence

(filled in as each lands)

## 3. Verification owed (V-1…V-9)

(filled in as each lands)

## 4. Suite numbers

(filled in at the end)
