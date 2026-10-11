// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "WinterCoworkNative",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WinterCoworkPrimitives", targets: ["WinterCoworkPrimitives"]),
        .library(name: "WinterCoworkNative", type: .dynamic, targets: ["WinterCoworkNative"])
    ],
    dependencies: [.package(url: "https://github.com/apple/containerization.git", revision: "bc994b88df46207fad7775b0eabc51947e315881")],
    targets: [
        .target(name: "WinterCoworkPrimitives", dependencies: [
            .product(name: "Containerization", package: "containerization"),
            .product(name: "ContainerizationExtras", package: "containerization")
        ]),
        .target(name: "WinterCoworkNative", dependencies: [
            "WinterCoworkPrimitives",
            .product(name: "Containerization", package: "containerization"),
            .product(name: "ContainerizationOCI", package: "containerization")
        ]),
        .testTarget(name: "WinterCoworkNativeTests", dependencies: ["WinterCoworkNative", "WinterCoworkPrimitives"])
    ]
)
