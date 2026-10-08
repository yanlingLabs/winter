// swift-tools-version:5.9
import PackageDescription

// STAND-IN for `apple/WinterCUPresentation` (the helper's mirror, agent cursor and Esc tap), which is
// built in its own lane. It carries the pinned presentation API and nothing that draws. Deleted when the
// real package merges: `apple/WinterComputerUse/Package.swift` then points at `../WinterCUPresentation`.
let package = Package(
    name: "WinterCUPresentation",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterCUPresentation", targets: ["WinterCUPresentation"]),
    ],
    targets: [
        .target(name: "WinterCUPresentation", swiftSettings: [.enableUpcomingFeature("ConciseMagicFile")]),
    ]
)
