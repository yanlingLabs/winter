// swift-tools-version:5.9
import PackageDescription

// STAND-IN for `apple/WinterCUCore` (the automation engine), which is built in its own lane. It carries
// the pinned core API (types, the `CUCore` class, the event protocol) and answers every automation call
// `unsupported`. Deleted when the real package merges: `apple/WinterComputerUse/Package.swift` then points
// at `../WinterCUCore`.
let package = Package(
    name: "WinterCUCore",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterCUCore", targets: ["WinterCUCore"]),
    ],
    targets: [
        .target(name: "WinterCUCore", swiftSettings: [.enableUpcomingFeature("ConciseMagicFile")]),
    ]
)
