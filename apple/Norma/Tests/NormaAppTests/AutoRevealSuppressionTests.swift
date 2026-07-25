import XCTest
@testable import Norma

/// gate-feedback-1 FIX A / orb-scope Part 2: the terminal-chat AND turn-origin suppression gates on
/// `GlassRootView`'s answer-arrival auto-reveal. Independent pure pieces get their own coverage:
///   - `isTerminalBundleIdentifier` (`TerminalFrontmost.swift`) — the frontmost-app allowlist.
///   - `isAutoRevealSuppressed`/`shouldAutoExpand` (`GlassRootView.swift`) — the suppression table
///     itself, composed with the pre-existing cursor-calm gate. `orbInitiated: true` is passed at
///     every PRE-Part-2 call site below so those cases keep asserting exactly the truth table they
///     did before this fix (the cli/terminal-only table); the new `orbInitiated` dimension gets its
///     own dedicated cases and its own full truth table.
/// Manual summon (`OrbWindowController.toggleField()`) never calls `handleTurnCompleted()` at all
/// — see that method's doc — so it is intentionally NOT exercised here; there is nothing for this
/// suppression to affect on that path.
final class AutoRevealSuppressionTests: XCTestCase {

    // MARK: - isTerminalBundleIdentifier: the frontmost-app allowlist

    func testKnownTerminalBundleIdsAreRecognized() {
        for id in [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "dev.warp.Warp",
            "io.alacritty",
            "net.kovidgoyal.kitty",
            "com.github.wez.wezterm",
        ] {
            XCTAssertTrue(isTerminalBundleIdentifier(id), "\(id) should be recognized as a terminal")
        }
    }

    func testNonTerminalBundleIdsAreNotRecognized() {
        XCTAssertFalse(isTerminalBundleIdentifier("com.apple.finder"))
        XCTAssertFalse(isTerminalBundleIdentifier("com.norma.app"))
        XCTAssertFalse(isTerminalBundleIdentifier("com.apple.dt.Xcode"))
    }

    func testNilBundleIdIsNotATerminal() {
        XCTAssertFalse(isTerminalBundleIdentifier(nil))
    }

    // MARK: - isAutoRevealSuppressed: the pre-Part-2 cli/terminal table — unchanged, orbInitiated: true

    func testSuppressedOnlyWhenBothConditionsHold() {
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: true, orbInitiated: true))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: false, orbInitiated: true))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: true, orbInitiated: true))
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: true))
    }

    // MARK: - isAutoRevealSuppressed: orb-scope Part 2 — the orbInitiated dimension

    /// Core reveal preserved: an orb-initiated turn, no CLI attached, terminal not frontmost —
    /// today's summon→type→answer loop must keep auto-expanding exactly as it always has.
    func testOrbInitiatedWithNoOtherConditionIsNotSuppressed() {
        XCTAssertFalse(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: true))
    }

    /// The fix itself: a dispatch turn NOT initiated from the orb (phone dispatch mode, a
    /// scheduled routine) is suppressed even with no CLI attached and no terminal frontmost —
    /// unlike the pre-Part-2 table, this alone is enough to suppress.
    func testNotOrbInitiatedIsSuppressedEvenWithNoOtherCondition() {
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: false))
    }

    /// `orbInitiated: false` suppresses regardless of the cli/terminal state — the two reasons are
    /// OR'd, not AND'd; either alone is sufficient.
    func testNotOrbInitiatedSuppressesRegardlessOfCliTerminalState() {
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: false, orbInitiated: false))
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: false, frontmostIsTerminal: true, orbInitiated: false))
        XCTAssertTrue(isAutoRevealSuppressed(cliAttachedToFocused: true, frontmostIsTerminal: true, orbInitiated: false))
    }

    // MARK: - shouldAutoExpand: suppression composed with the pre-existing calm-gate

    /// Suppression wins outright — `calm` is never consulted once BOTH cli/terminal conditions
    /// hold, so even a calm cursor (which would normally auto-expand) does not.
    func testSuppressionOverridesCalmCursor() {
        XCTAssertFalse(shouldAutoExpand(calm: true, cliAttachedToFocused: true, frontmostIsTerminal: true, orbInitiated: true))
    }

    /// orb-scope Part 2: suppression also wins outright when the turn simply wasn't orb-initiated —
    /// same "calm never consulted" outcome, driven by the new dimension instead of cli/terminal.
    func testNotOrbInitiatedOverridesCalmCursor() {
        XCTAssertFalse(shouldAutoExpand(calm: true, cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: false))
    }

    /// Not suppressed (only one cli/terminal condition holds, or neither, and the turn IS
    /// orb-initiated) — falls through to the ordinary calm-gate exactly as before this fix.
    func testUnsuppressedFallsThroughToCalmGate() {
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: true))
        XCTAssertFalse(shouldAutoExpand(calm: false, cliAttachedToFocused: false, frontmostIsTerminal: false, orbInitiated: true))
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: true, frontmostIsTerminal: false, orbInitiated: true))
        XCTAssertTrue(shouldAutoExpand(calm: true, cliAttachedToFocused: false, frontmostIsTerminal: true, orbInitiated: true))
    }

    /// Full 2×2×2 truth table (pre-Part-2 dimensions only, `orbInitiated` pinned `true`), spelled
    /// out explicitly so a future edit to the `&&` can't silently flip a corner without a test
    /// noticing.
    func testFullTruthTableCliTerminalDimensionsOrbInitiated() {
        let cases: [(calm: Bool, cli: Bool, terminal: Bool, expected: Bool)] = [
            (true,  false, false, true),
            (true,  true,  false, true),
            (true,  false, true,  true),
            (true,  true,  true,  false), // the ONLY suppressed-and-would-have-expanded case
            (false, false, false, false),
            (false, true,  false, false),
            (false, false, true,  false),
            (false, true,  true,  false),
        ]
        for c in cases {
            XCTAssertEqual(
                shouldAutoExpand(calm: c.calm, cliAttachedToFocused: c.cli, frontmostIsTerminal: c.terminal, orbInitiated: true),
                c.expected,
                "calm=\(c.calm) cli=\(c.cli) terminal=\(c.terminal) orbInitiated=true"
            )
        }
    }

    /// Full 2×2×2×2 truth table across ALL FOUR dimensions — the drift tripwire for the merged
    /// `!orbInitiated || (cli && terminal)` formula itself.
    func testFullTruthTableAllFourDimensions() {
        let cases: [(calm: Bool, cli: Bool, terminal: Bool, orbInitiated: Bool, expected: Bool)] = [
            // orbInitiated: true — identical to the cli/terminal-only table above.
            (true,  false, false, true,  true),
            (true,  true,  false, true,  true),
            (true,  false, true,  true,  true),
            (true,  true,  true,  true,  false),
            (false, false, false, true,  false),
            (false, true,  false, true,  false),
            (false, false, true,  true,  false),
            (false, true,  true,  true,  false),
            // orbInitiated: false — ALWAYS suppressed (false), regardless of calm/cli/terminal.
            (true,  false, false, false, false),
            (true,  true,  false, false, false),
            (true,  false, true,  false, false),
            (true,  true,  true,  false, false),
            (false, false, false, false, false),
            (false, true,  false, false, false),
            (false, false, true,  false, false),
            (false, true,  true,  false, false),
        ]
        for c in cases {
            XCTAssertEqual(
                shouldAutoExpand(calm: c.calm, cliAttachedToFocused: c.cli, frontmostIsTerminal: c.terminal, orbInitiated: c.orbInitiated),
                c.expected,
                "calm=\(c.calm) cli=\(c.cli) terminal=\(c.terminal) orbInitiated=\(c.orbInitiated)"
            )
        }
    }
}
