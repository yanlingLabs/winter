import XCTest
@testable import Winter

/// App→CLI handoff Task 1: byte-pins on the handoff script builder (the CliLauncherTests
/// house style — full-content equality per profile, plus quoting through the builder).
/// The effectful half (`moveToCli`'s real `open -a Terminal`) is a live-gate item, exactly
/// like CliLauncher's launch — the pure builder carries the coverage.
final class HandoffLauncherTests: XCTestCase {
    func testDistScriptIsByteExact() {
        let s = HandoffLauncher.handoffScript(
            dev: false, winterHome: "/Users/u/.winter",
            cliPath: "/Applications/Winter.app/Contents/Resources/winter-core",
            dir: "/Users/u/proj", sessionId: "abc123")
        XCTAssertEqual(s, """
        #!/bin/sh
        export WINTER_HOME='/Users/u/.winter'
        export WINTER_PROFILE='dist'
        cd '/Users/u/proj'
        exec '/Applications/Winter.app/Contents/Resources/winter-core' resume 'abc123'

        """)
    }

    func testDevScriptIsByteExact() {
        let s = HandoffLauncher.handoffScript(
            dev: true, winterHome: "/Users/u/.winter-dev",
            cliPath: "/repo/packages/cli/src/main.ts",
            dir: "/Users/u/proj", sessionId: "abc123")
        XCTAssertEqual(s, """
        #!/bin/sh
        export WINTER_HOME='/Users/u/.winter-dev'
        export WINTER_PROFILE='dev'
        cd '/Users/u/proj'
        exec /usr/bin/env bun '/repo/packages/cli/src/main.ts' resume 'abc123'

        """)
    }

    func testSingleQuoteEscaping() {
        XCTAssertEqual(HandoffLauncher.shellSingleQuoted("it's"), "'it'\\''s'")
        // And through the builder: a dir with a quote must not break the script line.
        let s = HandoffLauncher.handoffScript(
            dev: false, winterHome: "/h", cliPath: "/c",
            dir: "/Users/u/it's here", sessionId: "s1")
        XCTAssertTrue(s.contains("cd '/Users/u/it'\\''s here'"))
    }
}
