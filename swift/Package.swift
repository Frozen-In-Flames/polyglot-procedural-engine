// swift/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "XrEngineProviders",
    platforms: [.visionOS(.v1)],
    products: [
        .library(name: "XrEngineProviders", targets: ["XrEngineProviders"]),
    ],
    targets: [
        .target(name: "XrEngineProviders", path: "Sources/XrEngineProviders"),
    ]
)
