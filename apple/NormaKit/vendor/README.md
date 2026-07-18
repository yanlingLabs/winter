# vendor/ — iroh-ffi v1.1.0

Two pieces, from [n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi) tag `v1.1.0`
(core [iroh](https://github.com/n0-computer/iroh) >= v1.0.2):

1. **`IrohLib.xcframework/`** (gitignored, ~133MB unpacked / ~44MB zipped) — the
   compiled Rust FFI cdylib + C headers for iOS/macOS/Mac Catalyst, fetched from
   the GitHub release asset `IrohLib.xcframework.zip`
   (sha256 `ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776`,
   pinned in `fetch-iroh.sh`). Run `./fetch-iroh.sh` after cloning to populate it.

   **Naming gotcha**: the release asset is named `IrohLib.xcframework.zip`, but
   it unzips to a directory called `Iroh.xcframework`, and the module map
   embedded in its headers declares `module Iroh { ... }` — so Swift code
   imports it as `import Iroh`, not `import IrohLib`. `fetch-iroh.sh` renames
   the unpacked directory to `IrohLib.xcframework` only to match this repo's
   `Package.swift` path; the module name inside is still `Iroh`.

2. **`IrohLibSwift/IrohLib.swift`** — the UniFFI-generated Swift bindings file
   (verbatim copy of `IrohLib/Sources/IrohLib/IrohLib.swift` from the iroh-ffi
   repo at the same tag; dual Apache-2.0/MIT licensed, same as the rest of
   iroh-ffi). **This is committed to git** (it's ~330KB of generated Swift
   source, not a binary blob, and it's what actually defines the ergonomic
   `Endpoint` / `Connection` / `BiStream` / etc. Swift API — see below).

## Why vendor `IrohLib.swift` instead of just the xcframework?

The task brief's original plan was: fetch the xcframework, `.binaryTarget`
it as `IrohLib`, `import IrohLib`, done. That doesn't work, and this is a
genuine (not just naming) surprise worth flagging:

The XCFramework only contains the **raw C FFI** (`libiroh_ffi.a` + a C header
declaring `uniffi_iroh_ffi_fn_*` functions, module name `Iroh`). The ergonomic
Swift types this spike needs (`Endpoint`, `Connection`, `Incoming`, `Accepting`,
`BiStream`, `SendStream`, `RecvStream`, ...) are **not** in the xcframework at
all — they live in a separate, plain Swift source file
(`IrohLib/Sources/IrohLib/IrohLib.swift` upstream) that UniFFI generates and
n0-computer ships as a normal Swift **target**, not inside the binary. Upstream's
own `Package.swift` wires this as two targets combined into one product:

```swift
.target(name: "IrohLib", dependencies: [.byName(name: "Iroh")], path: "IrohLib/Sources/IrohLib", ...)
.binaryTarget(name: "Iroh", url: "...", checksum: "...")   // or a local path
```

We mirror that shape here: `.binaryTarget(name: "Iroh", ...)` +
`.target(name: "IrohLib", dependencies: ["Iroh"], path: "vendor/IrohLibSwift", ...)`.
NormaKit and the test target then depend on `"IrohLib"` and `import IrohLib`,
exactly as the brief intended — the deviation is purely in how that target gets
assembled, not in the resulting import surface.

**Alternative considered:** add `n0-computer/iroh-ffi` as a normal remote SPM
package dependency (`.package(url: ..., exact: "1.1.0")`,
`.product(name: "IrohLib", package: "iroh-ffi")`). This is what upstream
expects most consumers to do, and it avoids hand-vendoring a generated file.
We didn't, for this spike, mainly to keep the dependency graph closed (no new
network fetch at `swift build` time beyond the one-time xcframework download)
and to keep the exact pinned Swift-binding version fully visible in this repo.
**This is worth revisiting before SP2a proceeds past the spike** — hand-vendoring
a 10k-line generated file means we own re-vendoring it by hand on every iroh-ffi
version bump, which the remote-package approach would get for free.

## Linker settings

iroh's netwatch/netdev code needs `SystemConfiguration`, `Network`, and (macOS
only) `CoreWLAN` linked — mirrored from upstream's `IrohLib` target
`linkerSettings` into the `IrohLib` target in this package's `Package.swift`.

## How `Iroh` (the binaryTarget) is consumed (SP3 Task 3)

`Package.swift`'s `Iroh` binaryTarget is what a REMOTE SPM consumer (the future
private iOS app, resolving `NormaKit` as a package dependency over the network,
with no `vendor/` checkout of its own) actually downloads. Two forms exist:

**Default — `url:`/`checksum:` (what's committed):**

```swift
.binaryTarget(
    name: "Iroh",
    url: "https://github.com/yanlingLabs/norma/releases/download/iroh-xcframework-v1.1.0/IrohLib.xcframework.zip",
    checksum: "56cc44535cb91af503d7f4c6c8548b08467a1daa6ddd6e7aa2cd5a5430f5c765"
),
```

This resolves identically for local Mac builds and for a remote consumer:
`swift build` downloads the asset, verifies it against `checksum:` (SPM's own
`compute-checksum` format — **not** a raw sha256; a mismatch here is a hard
resolve error, same failure mode as `fetch-iroh.sh`'s sha256 gate but enforced
by SPM itself), and unpacks it. No `vendor/fetch-iroh.sh` run is required.

This asset is hosted on this repo's own releases (tag `iroh-xcframework-v1.1.0`
— a **build-asset tag**, deliberately distinct from the `v#.#.###` product
release tags the app itself ships under) via `scripts/publish-iroh-xcframework.ts`,
which re-zips `vendor/IrohLib.xcframework` (`ditto -c -k --keepParent`),
computes the checksum with `swift package compute-checksum`, and
`gh release create`/`upload --clobber`s it. Re-run that script (from the repo
root: `bun scripts/publish-iroh-xcframework.ts`) whenever `IROH_VERSION` in
`fetch-iroh.sh` bumps, then update both values above from its printed output.

**Alternative — local `path:` (commented out in `Package.swift`), for hacking
on an unreleased/modified xcframework:**

```swift
// .binaryTarget(name: "Iroh", path: "vendor/IrohLib.xcframework"),
```

Swap this in (and comment out the `url:`/`checksum:` form) when iterating on a
locally-patched `vendor/IrohLib.xcframework` you haven't published yet — e.g.
testing against an iroh-ffi prerelease. Requires `./fetch-iroh.sh` (or a
hand-built xcframework at that path) first; don't commit the swap.
