// swift-tools-version: 6.2
import PackageDescription

let package = Package(name: "WinterCoworkKeyBroker", platforms: [.macOS("26.0")], products: [
    .library(name: "KeyBrokerCore", targets: ["KeyBrokerCore"]),
    .executable(name: "cowork-key-broker-fixture", targets: ["FixtureBroker"]),
    .executable(name: "cowork-key-worker-fixture", targets: ["FixtureWorker"]),
    .executable(name: "cowork-key-client-fixture", targets: ["FixtureClient"])
], targets: [
    .target(name: "KeyBrokerNative", linkerSettings: [.linkedLibrary("sandbox")]),
    .target(name: "KeyBrokerCore", dependencies: ["KeyBrokerNative"]),
    .executableTarget(name: "FixtureWorker", dependencies: ["KeyBrokerCore"]),
    .executableTarget(name: "FixtureClient", dependencies: ["KeyBrokerCore"]),
    .executableTarget(name: "FixtureBroker", dependencies: ["KeyBrokerCore"])
])
