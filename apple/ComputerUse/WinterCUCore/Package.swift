// swift-tools-version:5.9
import PackageDescription

// WinterCUCore — the automation engine behind ComputerV2, linked into the signed helper app
// ("Winter Computer Use"). Everything native lives here: the AX state/diff/refs/find engine, window,
// region and whole-screen capture, the input ladder (AX → pid-routed events → SkyLight → foreground),
// typing/paste, menu walks, settle detection and waits, and the hard floors. The helper shell (socket,
// JSON-RPC, auth, lifecycle) and the presentation layer (mirror, cursor, Esc tap) are separate packages.
//
// Two test targets:
// - `WinterCUCoreTests` — pure logic only (formatter, diffs, ref identity, chords, coordinate maths,
//   floors, settle machine, budgets). Runs anywhere, touches no UI and needs no TCC grant.
// - `WinterCUCoreLiveTests` — exercises the live AX/capture/input paths. Every test skips unless
//   `WINTER_CU_LIVE_TESTS=1` is set, because the process running `swift test` may inherit the
//   terminal's Accessibility grant and must never drive the real desktop by accident.
let package = Package(
    name: "WinterCUCore",
    // Latest-OS floors (standing user rule) — identical to WinterKit/WinterProtocol.
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterCUCore", targets: ["WinterCUCore"]),
    ],
    targets: [
        .target(
            name: "WinterCUCore",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AppKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
        .testTarget(name: "WinterCUCoreTests", dependencies: ["WinterCUCore"]),
        .testTarget(name: "WinterCUCoreLiveTests", dependencies: ["WinterCUCore"]),
    ]
)
