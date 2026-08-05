import XCTest
@testable import Norma

/// App→CLI handoff Task 1: byte-pins on the handoff script builder (the CliLauncherTests
/// house style — full-content equality per profile, plus quoting through the builder).
/// The effectful half (`moveToCli`'s real `open -a Terminal`) is a live-gate item, exactly
/// like CliLauncher's launch — the pure builder carries the coverage.
final class HandoffLauncherTests: XCTestCase {
    func testDistScriptIsByteExact() {
        let s = HandoffLauncher.handoffScript(
            dev: false, normaHome: "/Users/u/.norma",
            cliPath: "/Applications/Norma.app/Contents/Resources/norma-core",
            dir: "/Users/u/proj", sessionId: "abc123")
        XCTAssertEqual(s, """
        #!/bin/sh
        export NORMA_HOME='/Users/u/.norma'
        export NORMA_PROFILE='dist'
        cd '/Users/u/proj'
        exec '/Applications/Norma.app/Contents/Resources/norma-core' resume 'abc123'

        """)
    }

    func testDevScriptIsByteExact() {
        let s = HandoffLauncher.handoffScript(
            dev: true, normaHome: "/Users/u/.norma-dev",
            cliPath: "/repo/packages/cli/src/main.ts",
            dir: "/Users/u/proj", sessionId: "abc123")
        XCTAssertEqual(s, """
        #!/bin/sh
        export NORMA_HOME='/Users/u/.norma-dev'
        export NORMA_PROFILE='dev'
        cd '/Users/u/proj'
        exec /usr/bin/env bun '/repo/packages/cli/src/main.ts' resume 'abc123'

        """)
    }

    func testSingleQuoteEscaping() {
        XCTAssertEqual(HandoffLauncher.shellSingleQuoted("it's"), "'it'\\''s'")
        // And through the builder: a dir with a quote must not break the script line.
        let s = HandoffLauncher.handoffScript(
            dev: false, normaHome: "/h", cliPath: "/c",
            dir: "/Users/u/it's here", sessionId: "s1")
        XCTAssertTrue(s.contains("cd '/Users/u/it'\\''s here'"))
    }
}
