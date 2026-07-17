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
   `Package.swift` path; the module name inside is still `Iroh` (see
   `Package.swift`'s `.binaryTarget(name: "Iroh", path: "vendor/IrohLib.xcframework")`).

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
