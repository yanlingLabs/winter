import Foundation
import CryptoKit

/*
 * The installation's receipt MAC key (docs/cowork-native-worker.md, section 7.1; owner ruling 2026-10-18).
 *
 * The daemon holds 32 random bytes in its Keychain and hands them to the launcher ONCE, in the L1 `begin` line (an authenticated socketpair, so they never
 * touch disk). The launcher keeps them in memory only, signs every Class A receipt it mints with HMAC-SHA256, and verifies a receipt read back from its own
 * (same-user writable) durable store under the key a later `begin` carries.
 *
 * Handling rules this type enforces:
 *   - the only way in is the canonical padded base64 of exactly 32 bytes (or 32 raw bytes in tests); anything else is refused;
 *   - the bytes live in one malloc'd block that `zeroize()` and `deinit` overwrite with `memset_s` (which the compiler may not elide);
 *   - every printed form (description, debug description, mirror) is "[redacted]", so no log line, error or assertion message can carry it;
 *   - the base64 text exists in exactly one place, `revealBase64()`, which the L1 serializer (the test harness's daemon side) is the sole caller of;
 *   - equality is constant time.
 * What Swift does not let us promise: the parsed L1 line, the base64 `String`, `Data` and CryptoKit's `SymmetricKey` made for one HMAC each hold a copy
 * until their own storage is released; those are not zeroed by us. The block here is the long-lived copy and it IS zeroed.
 */
public final class ReceiptKey: @unchecked Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public static let byteCount = 32
    private let block: UnsafeMutablePointer<UInt8>
    private var zeroed = false
    private let lock = NSLock()

    private init(copying bytes: [UInt8]) {
        block = UnsafeMutablePointer<UInt8>.allocate(capacity: Self.byteCount)
        bytes.withUnsafeBufferPointer { block.update(from: $0.baseAddress!, count: Self.byteCount) }
    }
    deinit { memset_s(block, Self.byteCount, 0, Self.byteCount); block.deallocate() }

    /// Exactly 32 bytes, or nil.
    public convenience init?(bytes: [UInt8]) {
        guard bytes.count == Self.byteCount else { return nil }
        self.init(copying: bytes)
    }
    /// The canonical padded base64 of exactly 32 bytes (44 characters); hex, unpadded, other lengths and non-canonical spellings are nil.
    public convenience init?(base64: String) {
        // Re-encoding must reproduce the text exactly: that alone makes it the 44 character canonical spelling of 32 bytes.
        guard let data = Data(base64Encoded: base64), data.count == Self.byteCount, data.base64EncodedString() == base64 else { return nil }
        self.init(copying: [UInt8](data))
    }

    /// The wire form of a `begin` line's `receiptKey` value, or `bad_field`.
    static func decode(_ value: JSONValue) throws -> ReceiptKey {
        guard case .string(let text) = value, let key = ReceiptKey(base64: text) else { throw WireFailure.bad_field }
        return key
    }

    /// The ONE door to the key's text: the L1 serializer of the `begin` line. Nothing else may call it.
    func revealBase64() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard !zeroed else { return nil }
        return Data(UnsafeBufferPointer(start: block, count: Self.byteCount)).base64EncodedString()
    }

    /// For tests only: the raw block (all zero after `zeroize`), whatever the flag says.
    func bytesForTests() -> [UInt8] { lock.lock(); defer { lock.unlock() }; return Array(UnsafeBufferPointer(start: block, count: Self.byteCount)) }

    public var isZeroed: Bool { lock.lock(); defer { lock.unlock() }; return zeroed }

    /// Overwrites the key. Idempotent. After this `mac` and `revealBase64` answer nil.
    public func zeroize() {
        lock.lock(); defer { lock.unlock() }
        memset_s(block, Self.byteCount, 0, Self.byteCount); zeroed = true
    }

    /// HMAC-SHA256 of `input` under the key, 32 raw bytes; nil once zeroed.
    public func mac(_ input: [UInt8]) -> [UInt8]? {
        lock.lock(); defer { lock.unlock() }
        guard !zeroed else { return nil }
        let key = SymmetricKey(data: Data(UnsafeBufferPointer(start: block, count: Self.byteCount)))
        return [UInt8](HMAC<SHA256>.authenticationCode(for: Data(input), using: key))
    }

    public static func == (a: ReceiptKey, b: ReceiptKey) -> Bool {
        if a === b { return true }
        // Always take the two locks in the same order (by object address), so two threads comparing the same pair in opposite argument order cannot deadlock.
        let (first, second) = ObjectIdentifier(a) < ObjectIdentifier(b) ? (a, b) : (b, a)
        first.lock.lock(); second.lock.lock(); defer { second.lock.unlock(); first.lock.unlock() }
        var difference: UInt8 = a.zeroed != b.zeroed ? 1 : 0
        for i in 0..<byteCount { difference |= a.block[i] ^ b.block[i] }
        return difference == 0
    }

    public var description: String { "[redacted]" }
    public var debugDescription: String { "[redacted]" }
    public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

/// Constant-time comparison of two MACs.
func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for i in 0..<a.count { difference |= a[i] ^ b[i] }
    return difference == 0
}
