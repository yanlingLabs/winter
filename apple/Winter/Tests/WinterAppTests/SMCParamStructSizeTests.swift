import XCTest

/// Regression guard for the gate-fix's core empirical finding: AppleSMC's IOKit user client
/// requires the parameter struct to be exactly 80 bytes, or every call returns
/// `kIOReturnBadArgument` (0xE00002C2). The previous 84-byte layout (a `UInt64 dataSize` and no
/// explicit padding field) silently failed every SMC call on real hardware — see
/// `.superpowers/sdd/4c-m4-charge-limit-research.md`. `smcParamStructByteSize` is exposed at
/// internal scope in SMCController.swift specifically so this test can pin the size without
/// widening the private `SMCParamStruct` type itself.
final class SMCParamStructSizeTests: XCTestCase {
    func test_smcParamStruct_is80Bytes() {
        XCTAssertEqual(smcParamStructByteSize, 80)
    }
}
