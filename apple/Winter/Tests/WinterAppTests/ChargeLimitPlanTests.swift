import XCTest

/// Exhaustive table test for `chargeLimitPlan` (SMCController.swift), the single source of truth
/// for the battery charge-limit decision. This file, plus HelperSources/SMCController.swift, are
/// given dual membership in the app test target (see project.yml) precisely so this pure function
/// is directly testable without pulling in the untestable IOKit surface or the XPC plumbing.
///
/// Gate-fix (2026-07-09): rewritten for the CHTE charge-manager loop. `CHWA` is absent on modern
/// Apple Silicon, so the old binary "80 or 100 only, 81...99 unsupported" model is gone — any
/// percent 50...99 is representable via the software monitoring loop (`chargeControlDecision`,
/// tested separately in ChargeControlDecisionTests.swift).
final class ChargeLimitPlanTests: XCTestCase {

    // MARK: Apple Silicon

    func test_appleSilicon_50_isLimit50() {
        XCTAssertEqual(chargeLimitPlan(percent: 50, appleSilicon: true), .appleSiliconLimit(percent: 50))
    }

    func test_appleSilicon_80_isLimit80() {
        XCTAssertEqual(chargeLimitPlan(percent: 80, appleSilicon: true), .appleSiliconLimit(percent: 80))
    }

    func test_appleSilicon_99_isLimit99() {
        XCTAssertEqual(chargeLimitPlan(percent: 99, appleSilicon: true), .appleSiliconLimit(percent: 99))
    }

    func test_appleSilicon_100_isDisable() {
        XCTAssertEqual(chargeLimitPlan(percent: 100, appleSilicon: true), .appleSiliconDisable)
    }

    func test_appleSilicon_49_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 49, appleSilicon: true), .invalidRange)
    }

    func test_appleSilicon_101_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 101, appleSilicon: true), .invalidRange)
    }

    // MARK: Intel

    func test_intel_50_isBCLM50() {
        XCTAssertEqual(chargeLimitPlan(percent: 50, appleSilicon: false), .writeBCLM(50))
    }

    func test_intel_75_isBCLM75() {
        XCTAssertEqual(chargeLimitPlan(percent: 75, appleSilicon: false), .writeBCLM(75))
    }

    func test_intel_100_isBCLM100() {
        XCTAssertEqual(chargeLimitPlan(percent: 100, appleSilicon: false), .writeBCLM(100))
    }

    func test_intel_49_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 49, appleSilicon: false), .invalidRange)
    }

    func test_intel_101_isInvalidRange() {
        XCTAssertEqual(chargeLimitPlan(percent: 101, appleSilicon: false), .invalidRange)
    }
}
