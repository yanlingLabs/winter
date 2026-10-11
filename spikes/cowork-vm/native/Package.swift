// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "WinterCoworkVMProbe",
    platforms: [.macOS("26.0")],
    products: [.library(name: "WinterCoworkVM", type: .dynamic, targets: ["WinterCoworkVM"])],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", revision: "bc994b88df46207fad7775b0eabc51947e315881")
    ],
    targets: [
        .target(name: "WinterCoworkVM", dependencies: [
            .product(name: "Containerization", package: "containerization"),
            .product(name: "ContainerizationExtras", package: "containerization"),
            .product(name: "ContainerizationOCI", package: "containerization")
        ]),
        .testTarget(name: "WinterCoworkVMTests", dependencies: ["WinterCoworkVM"])
    ]
)
