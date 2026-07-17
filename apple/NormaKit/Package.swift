// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NormaKit",
    // iroh-ffi v1.1.0 mandates macOS 14.5 (was 13).
    platforms: [.macOS("14.5"), .iOS(.v16)],
    products: [
        .library(name: "NormaKit", targets: ["NormaKit"]),
        .executable(name: "norma-probe", targets: ["norma-probe"]),
    ],
    dependencies: [
        .package(path: "../NormaProtocol"),
    ],
    targets: [
        // iroh-ffi v1.1.0's Apple XCFramework: raw C FFI only (module `Iroh`,
        // NOT `IrohLib` despite the release asset's filename — see vendor/README.md).
        // Fetched by vendor/fetch-iroh.sh; not committed (see .gitignore).
        .binaryTarget(name: "Iroh", path: "vendor/IrohLib.xcframework"),
        // The ergonomic Swift API (Endpoint, Connection, BiStream, ...) is a
        // generated Swift *source* file upstream ships alongside the binary,
        // not inside it. Vendored verbatim; see vendor/README.md for why.
        .target(
            name: "IrohLib",
            dependencies: ["Iroh"],
            path: "vendor/IrohLibSwift",
            linkerSettings: [
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Network"),
                .linkedFramework("CoreWLAN", .when(platforms: [.macOS])),
            ]
        ),
        .target(name: "NormaKit", dependencies: ["NormaProtocol", "IrohLib"]),
        .executableTarget(name: "norma-probe", dependencies: ["NormaKit", "NormaProtocol"]),
        .testTarget(name: "NormaKitTests", dependencies: ["NormaKit", "IrohLib"]),
    ]
)
