import Foundation
import XCTest

/// Locates the TS-generated cross-language parity fixtures (`packages/protocol/generated/fixtures/`,
/// written by `pnpm protocol:generate` from the LIVE TS implementations — Chat Slice D Task 4).
///
/// Read straight from the repo, never copied into this package: a copy is a second source of truth
/// that silently goes stale the moment the TS cleaner or the shipped dangerous-domain list changes,
/// which is the exact drift these fixtures exist to catch. SwiftPM resource bundling can only carry
/// files that live INSIDE the target directory, so this mirrors `apple/NormaProtocol`'s own
/// fixture-locating habit one level down: a source-relative path off `#filePath`, which the compiler
/// bakes in as the absolute path of THIS file at build time.
enum ParityFixtures {
    /// `<repo>/packages/protocol/generated/fixtures`
    static let directory: URL = {
        // #filePath == <repo>/apple/NormaChatKit/Tests/NormaChatKitTests/support/ParityFixtures.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 6 { url.deleteLastPathComponent() } // support, NormaChatKitTests, Tests, NormaChatKit, apple, <repo>
        return url.appending(path: "packages/protocol/generated/fixtures")
    }()

    static func data(_ name: String) throws -> Data {
        let url = directory.appending(path: name)
        guard FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else {
            throw FixtureMissing(path: url.path(percentEncoded: false))
        }
        return try Data(contentsOf: url)
    }

    /// One entry of `cleaner-vectors.json`. `lines` is the RAW `htmlToText(html).split("\n")` output
    /// of the TS implementation — NOT `renderLines`' numbered presentation (Task 4 review fix).
    struct CleanerVector: Decodable {
        let name: String
        let html: String
        let lines: [String]
    }

    static func cleanerVectors() throws -> [CleanerVector] {
        try JSONDecoder().decode([CleanerVector].self, from: data("cleaner-vectors.json"))
    }

    static func dangerousDomains() throws -> [String] {
        try JSONDecoder().decode([String].self, from: data("dangerous-domains.json"))
    }

    struct FixtureMissing: Error, CustomStringConvertible {
        let path: String
        var description: String { "parity fixture missing at \(path) — run `pnpm protocol:generate`" }
    }
}
