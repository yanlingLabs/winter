// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaProtocol",
    // SP3: OS floor raised to 26 across the board (see docs/RELEASE-NOTES-sp3-os-floor.md).
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "NormaProtocol", targets: ["NormaProtocol"]),
    ],
    targets: [
        .target(name: "NormaProtocol"),
        .testTarget(
            name: "NormaProtocolTests",
            dependencies: ["NormaProtocol"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
