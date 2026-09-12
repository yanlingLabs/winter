# Real `getTextSelection("text/rtf")` output, captured from the engine

Not hand-written. Each file is the exact bytes LibreOffice returned for a real selection on a real
agent view, captured with `spikes/office-format-probe` (`OFP_RTF_OUT=…`). They exist so the RTF
containment check can be pinned by a fast, deterministic unit test instead of only by live drills —
and because the defect they encode is invisible in any fixture an implementer would write by hand.

| file | what it is | the point |
|---|---|---|
| `pristine-no-bold-no-italic.rtf` | whole-document SelectAll on a document with **no bold and no italic anywhere** | its `{\stylesheet}` still contains `\i` from LibreOffice's stock `caption` style. A whole-string check answers "italic confirmed" on **every Writer document**. |
| `plain-word-selected-bold-named-style.rtf` | FIND_ALL of a **plain** word in a document whose bold sits on a **named paragraph style** | the `\b` is in the stylesheet header, not the body. A whole-string check answers "bold confirmed" for text that is not bold. |
| `one-of-three-genuinely-bold.rtf` | FIND_ALL of a literal appearing 3×, exactly **one** genuinely bold | the TRUE positive that must survive body-scoping — and the evidence that the check is existential, never universal. |
| `genuine-italic-selected.rtf` | a genuinely italic run selected | true positive: body-scoping must not trade a false positive for a false negative. |
| `genuine-underline-selected.rtf` | a genuinely underlined run selected | same, for underline — note this one leaks `\i` **and** carries a real `\ul`. |

The two leak files are the shapes the original LT-4 arms could not produce: both original fixtures
carried bold on an *automatic character style*, which RTF inlines per-run inside the body — the one
carrier where the leak structurally cannot appear.
