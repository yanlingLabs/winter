# office-lok-gate spike — NO-GO

Scratch spike for Office Stage A Task 1 (the LibreOfficeKit embed go/no-go gate). **Not shipped**,
not wired into any Xcode target. Result: **NO-GO** — see
`../../docs/superpowers/research/2026-08-18-lok-embed-gate.md` for the full report, evidence, and
root-cause analysis. Short version: `lok_init_2()` crashes on macOS (AppKit main-thread violation
inside VCL's Aqua backend, on a thread LOK spawns internally) — a confirmed, currently open
upstream gap (tdf#145127), not a bug in how this spike calls it.

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

## Reproducing the gate

```sh
# 1. Harvest (downloads ~284MB, mounts+copies+trims to apple/Norma/vendor/libreoffice/ -- gitignored)
bun run scripts/fetch-libreoffice.ts

# 2. Build the spike
spikes/office-lok-gate/build.sh

# 3. Run it against the harvested set. Expect exit 134 (SIGABRT) and an
#    NSInternalInconsistencyException stack trace -- that IS the gate's current, correct result.
mkdir -p /tmp/lok-gate-profile
HOME=/tmp/lok-gate-home LANG=en_US.UTF-8 spikes/office-lok-gate/out/office-lok-gate \
  "$(pwd)/apple/Norma/vendor/libreoffice/program/Frameworks" \
  /tmp/lok-gate-profile \
  "$(pwd)/apple/Norma/Tests/NormaAppTests/Fixtures/office/gate.xlsx" \
  /tmp/gate-tile.png /tmp/gate-tile.raw
```

If this someday exits 0 and prints `VERSION:`/`RESULT: OK` instead, `tdf#145127` has closed
upstream (a real headless macOS VCL implementation shipped) — re-read the gate report, this plan
is worth reviving, and Task 2+ can proceed against a validated set (re-run the full gate steps in
the report, including a REAL trim validation this time, before trusting any smaller size number).

## Regenerating the fixtures (if the seeds change)

Requires the official LibreOffice dmg mounted read-only at `LibreOffice.app` (see
`scripts/fetch-libreoffice.ts` for the pinned download URL/sha256 — the dmg's `soffice` binary is
what actually does the conversion; the harvested/trimmed vendor tree has no `soffice` executable
of its own, only the LOK library entry points):

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
