// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WinterProtocol",
    // SP3: OS floor raised to 26 across the board (see docs/RELEASE-NOTES-sp3-os-floor.md).
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WinterProtocol", targets: ["WinterProtocol"]),
    ],
    targets: [
        .target(name: "WinterProtocol"),
        .testTarget(
            name: "WinterProtocolTests",
            dependencies: ["WinterProtocol"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
