import Foundation
import IOKit

// MARK: - chargeLimitPlan (THE testable core)

/// What `ChargeManager.setTarget` should do for a given requested percent, on a given chip
/// family. This is the SINGLE source of truth for the charge-limit decision table — everything
/// else (range validation, which SMC key to hit / which loop to run) flows from this pure
/// function. `ChargeManager`/`SMCController` only ever *execute* a `ChargeLimitPlan`; they never
/// re-derive or duplicate this decision.
///
/// Gate-fix (2026-07-09): the previous model (`writeCHWA`, binary 80/100-only) does not hold on
/// Apple Silicon — `CHWA` is absent (`kSMCKeyNotFound`) on this hardware generation. The replacement
/// mechanism, `CHTE`, is a binary charge-inhibit flag rather than a firmware-held percent register,
/// so an arbitrary percent cap is enforced by a software monitoring loop (`ChargeManager`) instead
/// of a single SMC write — see `.superpowers/sdd/4c-m4-charge-limit-research.md`. Because the cap is
/// now software-enforced, the old "81...99 unsupported" restriction no longer applies.
enum ChargeLimitPlan: Equatable {
    /// Apple Silicon: enforce via the CHTE charge-manager loop (target 50...99).
    case appleSiliconLimit(percent: Int)
    /// Apple Silicon: 100 -> no limit. Stop the loop and ensure CHTE = 0 (allow charging).
    case appleSiliconDisable
    /// Intel: write the BCLM (battery-charge-level-max) key to an explicit percent — unchanged,
    /// real firmware-held percent register.
    case writeBCLM(UInt8)
    /// Outside the valid 50...100 range, on either chip family.
    case invalidRange
}

/// Pure decision table — no IOKit, no state, no side effects.
///   Apple Silicon: 50-99 -> appleSiliconLimit(percent); 100 -> appleSiliconDisable
///   Intel:         50-100 -> writeBCLM(percent)
///   Anywhere:      <50 or >100 -> invalidRange (checked FIRST, before any chip-specific branch)
func chargeLimitPlan(percent: Int, appleSilicon: Bool) -> ChargeLimitPlan {
    guard percent >= 50 && percent <= 100 else { return .invalidRange }
    if appleSilicon { return percent == 100 ? .appleSiliconDisable : .appleSiliconLimit(percent: percent) }
    return .writeBCLM(UInt8(percent))
}

// MARK: - chargeControlDecision (the pure loop core)

/// Should charging be inhibited right now? Hysteresis prevents flapping in-band. Pure, no I/O —
/// this is the testable heart of `ChargeManager`'s monitoring loop (the loop itself, and the SMC
/// calls it drives, are thin untested glue — see `ChargeManager.swift`).
func chargeControlDecision(soc: Int, target: Int, currentlyInhibited: Bool, hysteresis: Int) -> Bool {
    if soc >= target { return true }                 // at/above target -> inhibit
    if soc <= target - hysteresis { return false }    // comfortably below -> allow
    return currentlyInhibited                          // in the band -> hold current state
}

// MARK: - SMCController

/// Thin, deliberately-untested bridge to the AppleSMC IOKit user client. Struct layout mirrors the
/// long-reverse-engineered AppleSMC "YPCEvent" struct used by widely-deployed open-source SMC
/// tools (smcFanControl, SMCKit, smc-command, etc.) — AppleSMC.kext's user-client interface is
/// private and undocumented, so this cannot be meaningfully unit tested in this environment. Live
/// verification against real hardware is Task 6's gate (per task-3-brief.md); keep this class thin
/// and isolated so the untestable IOKit surface stays small and the pure `chargeLimitPlan` above
/// carries all the actual decision logic.
final class SMCController {

    enum SMCError: Error, Equatable {
        case serviceNotFound
        case openFailed(kern_return_t)
        case callFailed(kern_return_t)
        case keyNotFound(String)
    }

    /// NOT internally synchronized — this class has no lock around `connection` or the SMC calls
    /// built on it. Every caller must serialize all access itself; `ChargeManager`'s serial queue
    /// is the sole sanctioned caller (Task 4, Phase 4d-cleanup doc note — no code change here, since
    /// a functional change to this file would require the user to `sudo launchctl kickstart` the
    /// installed root helper to pick it up).
    private var connection: io_connect_t = 0

    // MARK: Public API

    /// `sysctlbyname("hw.optional.arm64", ...)` — present and 1 on Apple Silicon, absent (or 0)
    /// on Intel. This is the one piece of "real I/O" in this class that IS safe to exercise
    /// anywhere (no hardware/entitlement dependency), but it isn't table-tested since it isn't
    /// parameterized — `chargeLimitPlan` above is what's exhaustively tested.
    func isAppleSilicon() -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let rc = sysctlbyname("hw.optional.arm64", &value, &size, nil, 0)
        return rc == 0 && value == 1
    }

    /// `CHTE` (`ui32`, little-endian) — the Tahoe-era Apple Silicon charge-inhibit key. `1` = hold
    /// (stop taking charge), `0` = allow normal charging. NOT a percent register — see
    /// `ChargeLimitPlan`/`ChargeManager` for how a percent cap is built on top of this binary flag.
    /// `CHWA` (the old "charge-hold-when-away" key this replaces) is absent on this hardware
    /// generation (`kSMCKeyNotFound`) and intentionally has no read/write path here anymore — do
    /// not reintroduce it.
    func writeCHTE(_ inhibit: Bool) throws {
        try withConnection { try self.writeUInt32LE(key: "CHTE", value: inhibit ? 1 : 0) }
    }

    /// Nonzero ⇒ charging is currently inhibited.
    func readCHTE() throws -> Bool {
        try withConnection { (try self.readUInt32LE(key: "CHTE")) != 0 }
    }

    func writeBCLM(_ percent: UInt8) throws {
        try withConnection { try self.write(key: "BCLM", bytes: [percent]) }
    }

    func readBCLM() throws -> UInt8 {
        try withConnection { (try self.read(key: "BCLM")).first ?? 100 }
    }

    /// State-of-charge percent, read from `AppleSmartBattery`'s `CurrentCapacity` (IORegistry, not
    /// SMC) — this is the value `ChargeManager`'s loop compares against the target. `nil` when the
    /// service/property is unavailable; callers must NOT thrash state on a transient miss.
    func readStateOfChargePercent() -> Int? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        var props: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, 0) == kIOReturnSuccess,
              let dict = props?.takeRetainedValue() as? [String: Any] else { return nil }
        return dict["CurrentCapacity"] as? Int
    }

    /// Instantaneous charge current in mA, read from SMC `B0AC` (`si16`, little-endian, signed).
    /// `AppleSmartBattery`'s `Amperage`/`IsCharging` (IORegistry) are known-stale on this hardware
    /// (frozen across a whole polling session) — this is the fast, live signal used for
    /// telemetry/manual live-gate verification. Not wired into any XPC resultJson (Task 6's shapes
    /// don't include it); `nil` when unavailable.
    func readChargeCurrentMilliamps() -> Int? {
        guard let bytes = try? withConnection({ try self.read(key: "B0AC") }), bytes.count >= 2 else { return nil }
        var value = Int(bytes[0]) | (Int(bytes[1]) << 8)
        if value >= 0x8000 { value -= 0x10000 }
        return value
    }

    // MARK: Connection lifecycle

    private func withConnection<T>(_ body: () throws -> T) throws -> T {
        try open()
        defer { close() }
        return try body()
    }

    private func open() throws {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
        guard service != 0 else { throw SMCError.serviceNotFound }
        defer { IOObjectRelease(service) }
        let rc = IOServiceOpen(service, mach_task_self_, 0, &connection)
        guard rc == kIOReturnSuccess else { throw SMCError.openFailed(rc) }
    }

    private func close() {
        guard connection != 0 else { return }
        IOServiceClose(connection)
        connection = 0
    }

    // MARK: SMC struct call plumbing

    /// IOConnectCallStructMethod selector for AppleSMC's "handle YPC event" method — the single
    /// entry point used for key info lookups, reads, and writes (which sub-operation is requested
    /// is encoded in the input struct's `data8` field, not the selector).
    private static let ypcEventSelector: UInt32 = 2
    private static let readKeySelector: UInt8 = 5
    private static let writeKeySelector: UInt8 = 6
    private static let getKeyInfoSelector: UInt8 = 9
    private static let successStatus: UInt8 = 0

    private func read(key: String) throws -> [UInt8] {
        let info = try keyInfo(for: key)

        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = Self.readKeySelector
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }

        return Self.unpack(output.bytes, count: Int(info.dataSize))
    }

    private func write(key: String, bytes: [UInt8]) throws {
        let info = try keyInfo(for: key)

        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.keyInfo.dataSize = info.dataSize
        input.data8 = Self.writeKeySelector
        input.bytes = Self.pack(bytes)
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }
    }

    /// Little-endian `ui32` write, e.g. `CHTE`.
    private func writeUInt32LE(key: String, value: UInt32) throws {
        let bytes: [UInt8] = [
            UInt8(value & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 24) & 0xff),
        ]
        try write(key: key, bytes: bytes)
    }

    /// Little-endian `ui32` read, e.g. `CHTE`.
    private func readUInt32LE(key: String) throws -> UInt32 {
        let bytes = try read(key: key)
        var value: UInt32 = 0
        for (index, byte) in bytes.prefix(4).enumerated() {
            value |= UInt32(byte) << (8 * index)
        }
        return value
    }

    private func keyInfo(for key: String) throws -> SMCKeyInfoData {
        var input = SMCParamStruct()
        input.key = Self.fourCC(key)
        input.data8 = Self.getKeyInfoSelector
        let output = try call(input)
        guard output.result == Self.successStatus else { throw SMCError.keyNotFound(key) }
        return output.keyInfo
    }

    private func call(_ input: SMCParamStruct) throws -> SMCParamStruct {
        var input = input
        var output = SMCParamStruct()
        var outputSize = MemoryLayout<SMCParamStruct>.size
        let rc = withUnsafeMutablePointer(to: &output) { outPtr -> kern_return_t in
            withUnsafePointer(to: &input) { inPtr in
                IOConnectCallStructMethod(
                    connection,
                    Self.ypcEventSelector,
                    inPtr,
                    MemoryLayout<SMCParamStruct>.size,
                    outPtr,
                    &outputSize
                )
            }
        }
        guard rc == kIOReturnSuccess else { throw SMCError.callFailed(rc) }
        return output
    }

    private static func fourCC(_ key: String) -> UInt32 {
        key.utf8.reduce(UInt32(0)) { ($0 << 8) + UInt32($1) }
    }

    private static func pack(_ values: [UInt8]) -> SMCBytes {
        var tuple = smcZeroBytes()
        withUnsafeMutableBytes(of: &tuple) { raw in
            for (index, value) in values.enumerated() where index < raw.count {
                raw[index] = value
            }
        }
        return tuple
    }

    private static func unpack(_ tuple: SMCBytes, count: Int) -> [UInt8] {
        withUnsafeBytes(of: tuple) { raw in
            Array(raw.prefix(max(0, count)))
        }
    }
}

// MARK: - SMC wire structs

/// AppleSMC's private "YPCEvent" struct, reverse-engineered by (and shared across) the open-source
/// SMC tooling ecosystem. Field order matters (it's read/written across the IOKit user client
/// boundary as raw bytes) — do not reorder without re-verifying against real hardware.
private struct SMCVersion {
    var major: UInt8 = 0
    var minor: UInt8 = 0
    var build: UInt8 = 0
    var reserved: UInt8 = 0
    var release: UInt16 = 0
}

private struct SMCPLimitData {
    var version: UInt16 = 0
    var length: UInt16 = 0
    var cpuPLimit: UInt32 = 0
    var gpuPLimit: UInt32 = 0
    var memPLimit: UInt32 = 0
}

private struct SMCKeyInfoData {
    // Empirically confirmed against real hardware (gate-fix 2026-07-09): the kernel wire layout
    // for this field is 32-bit, not the 64-bit `IOByteCount` the original comment here assumed.
    // With `UInt64` (84-byte `SMCParamStruct`) every AppleSMC call returned `kIOReturnBadArgument`
    // (0xE00002C2); switching to `UInt32` (plus the `padding` field below) yields the correct
    // 80-byte struct and calls return rc=0. See `.superpowers/sdd/4c-m4-charge-limit-research.md`.
    var dataSize: UInt32 = 0
    var dataType: UInt32 = 0
    var dataAttributes: UInt8 = 0
}

private typealias SMCBytes = (
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
)

private func smcZeroBytes() -> SMCBytes {
    (0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0,
     0, 0, 0, 0, 0, 0, 0, 0)
}

private struct SMCParamStruct {
    var key: UInt32 = 0
    var vers = SMCVersion()
    var pLimitData = SMCPLimitData()
    var keyInfo = SMCKeyInfoData()
    // Classic SMCKit field — without this explicit padding between `keyInfo` and `result` the
    // struct is 76 bytes, not the AppleSMC-required 80. Confirmed empirically (gate-fix 2026-07-09).
    var padding: UInt16 = 0
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: SMCBytes = smcZeroBytes()
}

/// Regression guard for the 80-byte AppleSMC parameter-struct requirement above. Exposed at
/// internal (default) scope — rather than widening `SMCParamStruct` itself out of file-private
/// scope — specifically so `WinterAppTests` (which gives this file dual target membership; see
/// project.yml) can pin the size without touching AppleSMC's private wire-struct visibility.
let smcParamStructByteSize = MemoryLayout<SMCParamStruct>.size
