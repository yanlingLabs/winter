// swift-tools-version:5.9
import PackageDescription

// ROOT UMBRELLA MANIFEST (SP3 Phase B enabler).
//
// SwiftPM resolves `<repo-root>/Package.swift` for a REMOTE git dependency, but Winter's real
// Swift manifests live under `apple/` (apple/WinterProtocol, apple/WinterKit). Without a root
// manifest a remote consumer — the closed-source `yanlingLabs/norma-ios` app — cannot resolve
// this repo at all. This thin umbrella exposes ONLY the iOS-consumable products
// (`WinterProtocol` + `WinterSessionKit` + `WinterChatKit`) by pathing its targets into the
// existing sources.
//
// Local Mac development and the Mac app keep using `apple/WinterKit/Package.swift` and
// `apple/WinterProtocol/Package.swift` unchanged — those are separate packages resolved from
// their own directories and do not interfere with this one (no consumer depends on both).
//
// KEEP IN SYNC with `apple/WinterKit/Package.swift`: the `Iroh` binaryTarget url + checksum,
// the `IrohLib` linkerSettings, and `WinterSessionKit`'s dependency list must match. When the
// iroh xcframework is republished (scripts/publish-iroh-xcframework.ts), update BOTH manifests.
// Likewise KEEP IN SYNC with `apple/WinterChatKit/Package.swift` for `WinterChatKit`'s deps.
let package = Package(
    name: "winter",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WinterProtocol", targets: ["WinterProtocol"]),
        .library(name: "WinterSessionKit", targets: ["WinterSessionKit"]),
        .library(name: "WinterChatKit", targets: ["WinterChatKit"]),
    ],
    targets: [
        .target(name: "WinterProtocol", path: "apple/WinterProtocol/Sources/WinterProtocol"),
        .binaryTarget(
            name: "Iroh",
            url: "https://github.com/yanlingLabs/norma/releases/download/iroh-xcframework-v1.1.0/IrohLib.xcframework.zip",
            checksum: "56cc44535cb91af503d7f4c6c8548b08467a1daa6ddd6e7aa2cd5a5430f5c765"
        ),
        .target(
            name: "IrohLib",
            dependencies: ["Iroh"],
            path: "apple/WinterKit/vendor/IrohLibSwift",
            linkerSettings: [
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Network"),
                .linkedFramework("CoreWLAN", .when(platforms: [.macOS])),
            ]
        ),
        .target(
            name: "WinterSessionKit",
            dependencies: ["WinterProtocol", "IrohLib"],
            path: "apple/WinterKit/Sources/WinterSessionKit"
        ),
        // Chat Slice D: the phone's standalone chat engine. No IrohLib — it must link without
        // the transport (a locally-running chat turn never talks to the Mac).
        .target(
            name: "WinterChatKit",
            dependencies: ["WinterProtocol"],
            path: "apple/WinterChatKit/Sources/WinterChatKit"
        ),
    ]
)
