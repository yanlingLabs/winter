import XCTest
import WinterKit
@testable import Winter

/// Settings → Roles → "Notes": the pure decisions behind the section. Everything time-dependent
/// takes an injected `now`, a UTC calendar and an `en_US_POSIX`-free `en_US` locale.
final class SettingsRoleNotesTests: XCTestCase {
    private let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private let enUS = Locale(identifier: "en_US")
    /// 2026-09-18 10:00:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_789_725_600)

    private func problem(_ reason: String, detail: String? = "d", model: String? = "a/x",
                         retryAt: Date? = nil) -> RoleProblem {
        RoleProblem(reason: reason, detail: detail, model: model, at: nil, retryAt: retryAt)
    }

    private func text(_ p: RoleProblem) -> String {
        roleProblemText(p, now: now, calendar: utc, locale: enUS)
    }

    func testTheFixtureNowIsWhatTheTestsAssume() {
        XCTAssertEqual(roleProblemDate("2026-09-18T10:00:00Z"), now)
    }

    /// THE WORDING TABLE: every reason the daemon classifies today has one calm line of Winter's
    /// own — never the daemon's detail — and `other` is deliberately NOT in it.
    func testEveryKnownReasonHasItsOwnCalmLine() {
        let table: [(String, String)] = [
            ("rate-limited", "Rate limited for now — Winter will try again."),
            ("usage-limit", "Usage limit reached."),
            ("out-of-credits", "Out of credits — check this provider's billing."),
            ("credential-rejected", "The provider didn't accept the stored credential."),
            ("no-credential", "No credential is stored for this provider."),
            ("model-unavailable", "This model isn't available from the provider right now."),
            ("provider-unavailable", "The provider couldn't be reached — usually temporary."),
        ]
        for (reason, expected) in table {
            XCTAssertEqual(text(problem(reason, detail: "RAW PROVIDER WORDS")), expected, reason)
        }
        XCTAssertNil(roleProblemWordings["other"])
        for wording in roleProblemWordings.values {
            XCTAssertFalse(wording.contains("\n"), "one line: \(wording)")
            XCTAssertFalse(wording.contains("!"), "calm: \(wording)")
            XCTAssertFalse(wording.lowercased().contains("error"), "a note, not an alarm: \(wording)")
        }
    }

    /// Spelling drift in the reason reads as the same reason.
    func testTheReasonKeyNormalizes() {
        XCTAssertEqual(roleProblemReasonKey("rate_limited"), "rate-limited")
        XCTAssertEqual(roleProblemReasonKey(" Usage-Limit "), "usage-limit")
        XCTAssertEqual(text(problem("OUT_OF_CREDITS")), roleProblemWordings["out-of-credits"])
    }

    /// An unknown reason and `other` show the DAEMON'S OWN detail, clipped — never invented
    /// wording; with no detail, an unknown reason shows its own name and `other` the generic line.
    func testUnknownReasonsFallBackToTheDaemonsDetail() {
        XCTAssertEqual(text(problem("brand-new-reason", detail: "Region quota paused")), "Region quota paused")
        XCTAssertEqual(text(problem("other", detail: "Upstream said no")), "Upstream said no")
        XCTAssertEqual(text(problem("brand-new-reason", detail: nil)), "brand-new-reason",
                       "a new reason still reaches the screen")
        XCTAssertEqual(text(problem("brand-new-reason", detail: "   ")), "brand-new-reason")
        XCTAssertEqual(text(problem("other", detail: nil)), roleProblemGenericText)
        let long = String(repeating: "x", count: 500)
        let clipped = text(problem("other", detail: "line one\nline two " + long))
        XCTAssertFalse(clipped.contains("\n"))
        XCTAssertEqual(clipped.count, roleProblemDetailLimit + 1, "capped, plus the ellipsis")
        XCTAssertTrue(clipped.hasSuffix("…"))
        XCTAssertTrue(clipped.hasPrefix("line one line two"))
    }

    func testTheClipRule() {
        let table: [(String?, String?)] = [
            (nil, nil), ("", nil), (" \n ", nil),
            ("  short  ", "short"), ("a\r\nb\nc", "a b c"),
            (String(repeating: "y", count: roleProblemDetailLimit),
             String(repeating: "y", count: roleProblemDetailLimit)),
            (String(repeating: "y", count: roleProblemDetailLimit + 1),
             String(repeating: "y", count: roleProblemDetailLimit) + "…"),
        ]
        for (input, expected) in table {
            XCTAssertEqual(roleProblemClip(input), expected, String(describing: input))
        }
    }

    /// The time, relative and human: today / tomorrow / a date — with the injected `now`.
    func testTheTimeReadsTodayTomorrowOrADate() {
        let table: [(TimeInterval, String)] = [
            (5 * 3600 + 40 * 60, "3:40 PM today"),
            (13 * 3600 + 59 * 60, "11:59 PM today"),
            (14 * 3600, "12:00 AM tomorrow"),
            (23 * 3600, "9:00 AM tomorrow"),
            (3 * 86_400 - 1 * 3600, "9:00 AM on Sep 21"),
        ]
        for (offset, expected) in table {
            XCTAssertEqual(roleProblemTimeText(now.addingTimeInterval(offset), now: now,
                                               calendar: utc, locale: enUS)
                               .replacingOccurrences(of: "\u{202F}", with: " "),
                           expected, "+\(offset)s")
        }
    }

    /// `usage-limit` and `rate-limited` say WHEN, if the provider said and it is still ahead; a past
    /// `retryAt` is dropped; other reasons never grow a time.
    func testUsageAndRateLimitsSayWhenTheyComeBack() {
        func clean(_ s: String) -> String { s.replacingOccurrences(of: "\u{202F}", with: " ") }
        let later = now.addingTimeInterval(5 * 3600 + 40 * 60)
        let tomorrow = now.addingTimeInterval(23 * 3600)
        XCTAssertEqual(clean(text(problem("usage-limit", retryAt: later))),
                       "Usage limit reached — resets at 3:40 PM today.")
        XCTAssertEqual(clean(text(problem("usage-limit", retryAt: tomorrow))),
                       "Usage limit reached — resets at 9:00 AM tomorrow.")
        XCTAssertEqual(clean(text(problem("rate-limited", retryAt: later))),
                       "Rate limited — retrying after 3:40 PM today.")
        XCTAssertEqual(text(problem("usage-limit", retryAt: now.addingTimeInterval(-60))),
                       "Usage limit reached.", "a moment already past is not news")
        XCTAssertEqual(text(problem("usage-limit", retryAt: nil)), "Usage limit reached.")
        XCTAssertEqual(text(problem("out-of-credits", retryAt: later)),
                       roleProblemWordings["out-of-credits"])
    }

    /// NOTHING reported ⇒ NO section: an empty list, not an "all clear".
    func testNoProblemsMeansNoNotes() {
        XCTAssertTrue(settingsRoleNotes([:], now: now).isEmpty)
        let quiet: [SettingsModelRole: SettingsRoleValue] = [
            .dispatch: SettingsRoleValue(model: "a/x", isExplicit: false, constraint: "any", permitted: []),
            .dream: SettingsRoleValue(model: "a/x", isExplicit: true, constraint: "any", permitted: []),
        ]
        XCTAssertTrue(settingsRoleNotes(quiet, now: now).isEmpty)
    }

    /// Notes come out in the page's role order, one per role that carries a problem — any role,
    /// no hardcoded list — and show the tag that FAILED, not the role's current model.
    func testNotesFollowThePageOrderAndShowTheFailedTag() {
        func value(_ model: String, _ p: RoleProblem?) -> SettingsRoleValue {
            SettingsRoleValue(model: model, isExplicit: false, constraint: "any", permitted: [], problem: p)
        }
        let values: [SettingsModelRole: SettingsRoleValue] = [
            .bashReviewer: value("a/now", problem("model-unavailable", model: "a/reviewer")),
            .dispatch: value("a/now", problem("rate-limited", model: "codex-oauth/gpt-5.6-terra")),
            .titles: value("a/now", nil),
            .sessionDefault: value("a/now", problem("out-of-credits", model: "openai/gpt-5.4")),
        ]
        let notes = settingsRoleNotes(values, now: now, calendar: utc, locale: enUS)
        XCTAssertEqual(notes.map(\.role), [.sessionDefault, .dispatch, .bashReviewer])
        XCTAssertEqual(notes.map(\.model), ["openai/gpt-5.4", "codex-oauth/gpt-5.6-terra", "a/reviewer"])
        XCTAssertEqual(notes[1].text, roleProblemWordings["rate-limited"])
    }

    /// The wire → pane mapping: raw reason kept, ISO times parsed (with or without fractional
    /// seconds), an unparseable time costs the time — never the note.
    func testTheWireProblemMapsThroughTheValueDecode() {
        let decoded = settingsModelRoleValues([
            SettingsModelRole.dream.rawValue: ModelRoleValue(
                model: "a/now", explicit: false, constraint: "any", permitted: [],
                problem: ModelRoleProblem(reason: "usage-limit", detail: "window", model: "a/failed",
                                          at: "2026-09-18T09:00:00.500Z", retryAt: "2026-09-18T15:40:00Z")),
            SettingsModelRole.cleaner.rawValue: ModelRoleValue(
                model: "a/now", explicit: false, constraint: "any", permitted: [],
                problem: ModelRoleProblem(reason: "future", at: "not a date")),
            SettingsModelRole.titles.rawValue: ModelRoleValue(
                model: "a/now", explicit: false, constraint: "any", permitted: []),
        ])
        let dream = decoded[.dream]?.problem
        XCTAssertEqual(dream?.reason, "usage-limit")
        XCTAssertEqual(dream?.model, "a/failed")
        XCTAssertEqual(dream?.at, now.addingTimeInterval(-3600 + 0.5))
        XCTAssertEqual(dream?.retryAt, now.addingTimeInterval(5 * 3600 + 40 * 60))
        XCTAssertEqual(decoded[.cleaner]?.problem?.reason, "future")
        XCTAssertNil(decoded[.cleaner]?.problem?.at)
        XCTAssertNil(decoded[.titles]?.problem)
    }

    /// The two reasons the internal-job roles report when they cannot run at all.
    func testInternalJobReasonsHaveCalmWording() {
        let now = Date()
        for reason in ["provider-unsupported", "no-internal-credential", "no-default-model"] {
            let text = roleProblemText(RoleProblem(reason: reason, detail: "raw daemon detail", model: nil,
                                                   at: nil, retryAt: nil), now: now)
            XCTAssertEqual(text, roleProblemWordings[reason])
            XCTAssertFalse(text.contains("raw daemon detail"), "our wording, not the daemon's text")
        }
    }

    /// A problem that names no model (`model: ""`) carries nil, so its row shows no tag.
    func testAnEmptyProblemModelIsNoModel() {
        let value = SettingsRoleValue(model: nil, isExplicit: false, constraint: "internal-provider", permitted: [],
                                      problem: RoleProblem(reason: "no-default-model", detail: nil, model: "",
                                                           at: nil, retryAt: nil))
        let notes = settingsRoleNotes([.titles: value], now: Date())
        XCTAssertEqual(notes.count, 1)
        XCTAssertNil(notes.first?.model)
    }
}
