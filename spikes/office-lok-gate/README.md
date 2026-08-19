# office-lok-gate spike — history: NO-GO on the official dmg, later reversed to GO from-source

Scratch spike for Office Stage A Task 1 (the LibreOfficeKit embed go/no-go gate). **Not shipped**,
not wired into any Xcode target.

**Original result (against the official, dmg-packaged LibreOffice): NO-GO.** `lok_init_2()`
crashed on macOS (AppKit main-thread violation inside VCL's Aqua backend, on a thread LOK spawns
internally) — a confirmed, then-open upstream gap (tdf#145127). See git history and the release
notes at https://github.com/yanlingLabs/norma/releases/tag/vendor-libreoffice-20260819 for the
full investigation.

**That verdict was later overturned.** A from-scratch native macOS arm64 build with
`--enable-headless` (the svp/headless VCL backend, the same shape iOS's own LibreOffice port
uses) builds and runs cleanly from stock upstream `LibreOffice/core` master, with ZERO source
patches — `tdf#145127` blocks the Aqua backend only, not the source tree. `scripts/fetch-
libreoffice.ts` now vendors THAT build (a pre-built, hash-pinned release asset — see its own
header for the recipe that produced it), and the GO story is what Office Stage A builds against
today. This spike's own NO-GO reproduction below is kept as the historical record of the
ORIGINAL finding, not a recipe that still matches what gets vendored today (see the note at the
end of that section).

## Files

- `main.c` — the spike itself. Plain C, `#define LOK_USE_UNSTABLE_API` before including the
  vendored headers (`apple/Norma/Sources/OfficeKit/include/`). Deliberately does NOT include
  `LibreOfficeKitEnums.h` (it isn't plain-C-safe as vendored — see the gate report's Layout Facts
  section); the two tile-mode constants it needs are transcribed with a citation instead.
- `build.sh` — `clang`, no hardened runtime, ad-hoc/linker signature (a hardened-runtime binary
  cannot `dlopen` TDF-signed dylibs at all — a red herring that looks identical to a real LOK
  failure).
- `seeds/gate.fod{s,t,p}` — hand-written flat-ODF seed documents (plain XML, colored content near
  the origin) used to generate the six committed fixtures
  (`apple/Norma/Tests/NormaAppTests/Fixtures/office/gate.{xlsx,ods,pptx,odp,docx,odt}`) via the
  **official, mounted, read-only** `soffice --headless --convert-to` — never installed to
  `/Applications`, never touching `~/.norma*`.

## Reproducing the ORIGINAL NO-GO (historical — does not match today's vendored tree)

The commands below reproduce the ORIGINAL finding, from when `scripts/fetch-libreoffice.ts`
harvested the official, dmg-packaged LibreOffice (mount + copy + trim, producing a `program/`
tree). That is not what the script does anymore — see its own header. Today
`scripts/fetch-libreoffice.ts` vendors the GO, from-source, headless build into `product-set/`
(**not** `program/`), fetched as one pre-built, hash-pinned release asset (the `-r2` asset on
`vendor-libreoffice-20260819`); running the commands below against a fresh fetch will not find a
`program/` directory at all.

```sh
# Historical shape (no longer produced by fetch-libreoffice.ts):
mkdir -p /tmp/lok-gate-profile
HOME=/tmp/lok-gate-home LANG=en_US.UTF-8 spikes/office-lok-gate/out/office-lok-gate \
  "$(pwd)/apple/Norma/vendor/libreoffice/program/Frameworks" \
  /tmp/lok-gate-profile \
  "$(pwd)/apple/Norma/Tests/NormaAppTests/Fixtures/office/gate.xlsx" \
  /tmp/gate-tile.png /tmp/gate-tile.raw
# Result at the time: exit 134 (SIGABRT), an NSInternalInconsistencyException stack trace — the
# gate's ORIGINAL, correct result against the Aqua-backed official dmg.
```

Against TODAY's vendored tree (`apple/Norma/vendor/libreoffice/product-set/Frameworks`), this
spike's `lok_init_2()` call SUCCEEDS — measured, not merely expected: the re-cut verification
ran this spike UNMODIFIED against the fully-rebuilt product-set and all six pinned tile SHA-256s
MATCHED (recut-report, "Hash table vs gate pins"). `main.c` takes its install path from argv[1]
(only a doc-comment parenthetical still mentions the old `program/Frameworks` wording), so it
works against `product-set/Frameworks` as-is. One measured caveat: the Writer formats
(gate.docx/gate.odt) exit 134 at process teardown — the known SwDLL static-destructor crash
AFTER main returns, accepted branch-wide; the rendered output is flushed and judged by SHA
before that. The spike stays useful as a standalone repro/verification tool; the product path's
own verification lives in the Office harness.

## Regenerating the fixtures (if the seeds change)

Requires the official LibreOffice dmg mounted read-only at `LibreOffice.app` (this is a SEPARATE,
one-time fixture-generation step, unrelated to what `scripts/fetch-libreoffice.ts` vendors — the
dmg's `soffice` binary is what actually does the conversion; the vendored product-set has no
`soffice` executable of its own, only the LOK library entry points):

```sh
SOFFICE=/Volumes/LibreOffice/LibreOffice.app/Contents/MacOS/soffice
PROFILE=file:///tmp/lok-fixture-profile
for fmt in ods xlsx; do  "$SOFFICE" --headless --nologo --nofirststartwizard --norestore \
  -env:UserInstallation=$PROFILE --convert-to "$fmt" --outdir /tmp/fixtures-out seeds/gate.fods; done
for fmt in odt docx; do  "$SOFFICE" --headless --nologo --nofirststartwizard --norestore \
  -env:UserInstallation=$PROFILE --convert-to "$fmt" --outdir /tmp/fixtures-out seeds/gate.fodt; done
for fmt in odp pptx; do  "$SOFFICE" --headless --nologo --nofirststartwizard --norestore \
  -env:UserInstallation=$PROFILE --convert-to "$fmt" --outdir /tmp/fixtures-out seeds/gate.fodp; done
```
