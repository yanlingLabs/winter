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
// The engine and the presentation layer are sibling packages, `apple/WinterCUCore` and
// `apple/WinterCUPresentation`.
let package = Package(
    name: "WinterComputerUse",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterComputerUseShell", targets: ["WinterComputerUseShell"]),
    ],
    dependencies: [
        .package(path: "../WinterCUCore"),
        .package(path: "../WinterCUPresentation"),
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
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("ImageIO"),
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
