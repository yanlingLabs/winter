// swift-tools-version:5.9
import PackageDescription

// ROOT UMBRELLA MANIFEST (SP3 Phase B enabler).
//
// SwiftPM resolves `<repo-root>/Package.swift` for a REMOTE git dependency, but Norma's real
// Swift manifests live under `apple/` (apple/NormaProtocol, apple/NormaKit). Without a root
// manifest a remote consumer — the closed-source `yanlingLabs/norma-ios` app — cannot resolve
// this repo at all. This thin umbrella exposes ONLY the two iOS-consumable products
// (`NormaProtocol` + `NormaSessionKit`) by pathing its targets into the existing sources.
//
// Local Mac development and the Mac app keep using `apple/NormaKit/Package.swift` and
// `apple/NormaProtocol/Package.swift` unchanged — those are separate packages resolved from
// their own directories and do not interfere with this one (no consumer depends on both).
//
// KEEP IN SYNC with `apple/NormaKit/Package.swift`: the `Iroh` binaryTarget url + checksum,
// the `IrohLib` linkerSettings, and `NormaSessionKit`'s dependency list must match. When the
// iroh xcframework is republished (scripts/publish-iroh-xcframework.ts), update BOTH manifests.
let package = Package(
    name: "norma",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "NormaProtocol", targets: ["NormaProtocol"]),
        .library(name: "NormaSessionKit", targets: ["NormaSessionKit"]),
    ],
    targets: [
        .target(name: "NormaProtocol", path: "apple/NormaProtocol/Sources/NormaProtocol"),
        .binaryTarget(
            name: "Iroh",
            url: "https://github.com/yanlingLabs/norma/releases/download/iroh-xcframework-v1.1.0/IrohLib.xcframework.zip",
            checksum: "56cc44535cb91af503d7f4c6c8548b08467a1daa6ddd6e7aa2cd5a5430f5c765"
        ),
        .target(
            name: "IrohLib",
            dependencies: ["Iroh"],
            path: "apple/NormaKit/vendor/IrohLibSwift",
            linkerSettings: [
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Network"),
                .linkedFramework("CoreWLAN", .when(platforms: [.macOS])),
            ]
        ),
        .target(
            name: "NormaSessionKit",
            dependencies: ["NormaProtocol", "IrohLib"],
            path: "apple/NormaKit/Sources/NormaSessionKit"
        ),
    ]
)
