# office-format-probe

The live bench for `.superpowers/research/office-formatting.md` §8's live-test list — the tests that
decide the SHAPE of `docs format` / `slides format`, above all **LT-4** (does
`getTextSelection("text/rtf")` give Writer a real attribute read-back, and therefore may `docs
format` honestly say "applied" rather than "posted").

Scratch only, like `spikes/office-lok-gate` — not part of any Xcode target. It exists because those
questions are one C call each, and answering them through the full app (xcodebuild -> NormaAppTests
-> OfficeCommandConsumer -> OfficeRuntime -> spawned NormaOfficeHelper -> LOKBridge) costs a full app
build per iteration.

    ./build.sh
    ./run.sh <doc_path> <op> [op args...]

`run.sh` reproduces the boot environment `LOKBridge` establishes before `lok_init_2` — a fresh
scratch profile and a generated `FONTCONFIG_FILE` — because LO fails to boot without it.

Every op drives the same primitives `LOKBridge.swift` drives, in the same order, with the same
payloads (`.uno:ExecuteSearch`'s argument set is copied verbatim from `LOKBridge.docsSearchArguments`,
including corrections C2; the Bold payload verbatim from `sheetsFormatOnDedicatedThread`), so a
result here transfers to the bridge rather than being merely true of this file.

Findings are written up in `.superpowers/research/office-format-report.md`.
