// swift-tools-version:5.9
import PackageDescription

// Winter Computer Use — the signed helper app that holds its own Accessibility and Screen Recording grants
// and does the native work behind the `ComputerV2` tool. This package is the app's whole shell: the
// socket server the daemon talks to, the peer check, the RPC dispatch into the automation engine
// (`WinterCUCore`), the forwarding of engine events to the mirror/cursor/Esc layer
// (`WinterCUPresentation`), and the lifecycle (idle quit). The app target in `apple/Winter/project.yml`
// is only `App/main.swift` on top of the `WinterComputerUseShell` library, so everything here is tested
// with `swift test`, and the helper never links WinterKit.
//
// The engine and the presentation layer are sibling packages (`apple/WinterCUCore`,
// `apple/WinterCUPresentation`), built in their own lanes. Until they merge, this package builds against the
// stand-ins in `Stubs/` (same module names, the pinned API, nothing behind them).
//
// MERGE (one commit, after both packages are in the tree): replace the two `Stubs/…` paths below with
// "../WinterCUCore" and "../WinterCUPresentation", and delete `Stubs/`. Nothing else changes. (Not detected
// automatically: SwiftPM and Xcode cache a manifest's evaluation, so a checkout that once resolved the stubs
// would keep them after the real packages appear — measured.) A helper built on the stub engine says so:
// release.ts refuses to ship one, dev:helper and verify:computer-helper print a warning.
let package = Package(
    name: "WinterComputerUse",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterComputerUseShell", targets: ["WinterComputerUseShell"]),
    ],
    dependencies: [
        .package(path: "Stubs/WinterCUCore"),
        .package(path: "Stubs/WinterCUPresentation"),
    ],
    targets: [
        .target(
            name: "WinterComputerUseShell",
            dependencies: [
                .product(name: "WinterCUCore", package: "WinterCUCore"),
                .product(name: "WinterCUPresentation", package: "WinterCUPresentation"),
            ],
            // `#file` as `#fileID`: the release identity scan reads every shipped byte, and a full source
            // path baked into a Release binary by an assertion's default argument is the leak it exists for.
            swiftSettings: [.enableUpcomingFeature("ConciseMagicFile")],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "WinterComputerUseShellTests",
            dependencies: [
                "WinterComputerUseShell",
                .product(name: "WinterCUCore", package: "WinterCUCore"),
                .product(name: "WinterCUPresentation", package: "WinterCUPresentation"),
            ]
        ),
    ]
)
