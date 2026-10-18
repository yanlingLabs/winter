import XCTest
@testable import LauncherCore

/// The launcher's side of the retained-receipt MAC (docs/cowork-native-worker.md, section 7.1): the key, the signing, the retained read path, and what must never leak.
final class ReceiptMacTests: XCTestCase {
    private func orderly(_ key: ReceiptKey) throws -> OrderlyReceipt {
        let h = SessionHarness(); try h.bringUp(); h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        return try XCTUnwrap(h.ports.stopped.first)
    }

    // MARK: the key

    func testOnlyTheCanonicalBase64Of32BytesIsAKey() {
        XCTAssertNotNil(ReceiptKey(base64: Fixture.receiptKeyBase64))
        let raw = Data(repeating: 7, count: 32)
        XCTAssertNil(ReceiptKey(base64: Data(repeating: 7, count: 31).base64EncodedString()), "31 bytes")
        XCTAssertNil(ReceiptKey(base64: Data(repeating: 7, count: 33).base64EncodedString()), "33 bytes")
        XCTAssertNil(ReceiptKey(base64: raw.map { String(format: "%02x", $0) }.joined()), "hex")
        XCTAssertNil(ReceiptKey(base64: String(raw.base64EncodedString().dropLast())), "unpadded")
        XCTAssertNil(ReceiptKey(base64: ""), "empty")
        XCTAssertNil(ReceiptKey(bytes: [UInt8](repeating: 1, count: 31)))
        XCTAssertNotNil(ReceiptKey(bytes: [UInt8](repeating: 1, count: 32)))
    }
    /// A base64 text whose last significant character carries bits the 32 byte value does not use decodes to the SAME bytes in Foundation; it is not canonical, so it is no key and no MAC.
    private func nonCanonicalSpelling(_ canonical: String) -> String? {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
        var chars = Array(canonical); let at = chars.count - 2   // the character before the single '='
        guard let index = alphabet.firstIndex(of: chars[at]) else { return nil }
        chars[at] = alphabet[index ^ 1]                          // flips an ignored low bit
        let variant = String(chars)
        return Data(base64Encoded: variant)?.count == 32 ? variant : nil
    }
    func testASpellingThatDecodesToTheSameBytesButIsNotCanonicalIsNeitherAKeyNorAMac() throws {
        let variant = try XCTUnwrap(nonCanonicalSpelling(Fixture.receiptKeyBase64), "Foundation accepts the variant, which is the point")
        XCTAssertNil(ReceiptKey(base64: variant))
        let r = try orderly(Fixture.receiptKey)
        var tampered = r; tampered.mac = try XCTUnwrap(nonCanonicalSpelling(r.mac))
        XCTAssertEqual(Data(base64Encoded: tampered.mac), Data(base64Encoded: r.mac), "the same 32 bytes")
        XCTAssertFalse(tampered.macVerifies(under: Fixture.receiptKey), "but not the canonical spelling")
        XCTAssertTrue(r.macVerifies(under: Fixture.receiptKey))
    }
    func testKeysAreEqualOnlyWhenTheirBytesAre() {
        XCTAssertEqual(Fixture.receiptKey, Fixture.receiptKey)
        XCTAssertNotEqual(Fixture.receiptKey, ReceiptKey(bytes: [UInt8](repeating: 1, count: 32))!)
        var other = Array("synthetic-receipt-key-0123456789".utf8); other[31] ^= 1
        XCTAssertNotEqual(Fixture.receiptKey, ReceiptKey(bytes: other)!, "one bit")
    }
    func testTheConstantTimeCompareRefusesADifferentLengthAndADifferentByte() {
        XCTAssertTrue(constantTimeEqual([1, 2, 3], [1, 2, 3]))
        XCTAssertFalse(constantTimeEqual([1, 2, 3], [1, 2]), "a truncated tag")
        XCTAssertFalse(constantTimeEqual([1, 2], [1, 2, 3]))
        XCTAssertFalse(constantTimeEqual([1, 2, 3], [1, 2, 4]))
        XCTAssertTrue(constantTimeEqual([], []))
    }
    func testNoPrintedFormOfTheKeyCarriesIt() throws {
        let key = Fixture.receiptKey
        let begin = LineToLauncher.begin(id: "req-1", homeId: "home_x", scope: Fixture.scope, receiptKey: key)
        var dumped = ""; dump(begin, to: &dumped)
        let forms = [String(describing: key), String(reflecting: key), "\(key)", dumped, String(describing: begin), String(reflecting: begin), "\(begin)"]
        for form in forms {
            XCTAssertFalse(form.contains(Fixture.receiptKeyBase64), "the key\'s base64 appears in a printed form")
            XCTAssertFalse(form.contains("synthetic-receipt-key"), "the key\'s raw bytes appear in a printed form")
            XCTAssertFalse(form.contains("c3ludGhldGljLXJlY2VpcHQ"), "a prefix of the key\'s base64 appears in a printed form")
        }
        XCTAssertEqual(String(describing: key), "[redacted]")
    }
    func testAZeroedKeyIsGoneAndSignsNothing() throws {
        let key = Fixture.receiptKey
        XCTAssertNotNil(key.mac([1, 2, 3])); XCTAssertNotNil(key.revealBase64()); XCTAssertFalse(key.isZeroed)
        XCTAssertNotEqual(key.bytesForTests(), [UInt8](repeating: 0, count: 32))
        key.zeroize(); key.zeroize()
        XCTAssertEqual(key.bytesForTests(), [UInt8](repeating: 0, count: 32), "the bytes themselves are overwritten, not only flagged")
        XCTAssertTrue(key.isZeroed); XCTAssertNil(key.mac([1, 2, 3])); XCTAssertNil(key.revealBase64())
        XCTAssertNotEqual(key, Fixture.receiptKey, "a zeroed key equals no live key")
        XCTAssertThrowsError(try LauncherLineCodec.serialize(.begin(id: "req-1", homeId: "home_x", scope: Fixture.scope, receiptKey: key)), "a zeroed key cannot be sent")
    }

    // MARK: signing

    func testTheLauncherSignsEveryClassAItMintsAndVerifiesUnderTheBeginKeyOnly() throws {
        let h = SessionHarness(); h.begin(); h.status(.sandboxed)
        let key = try XCTUnwrap(h.session.heldReceiptKey, "the session holds the key it was given")
        let disks = try DiskPair()
        h.send(.volumes(id: "req-volumes", scopeDigest: try EnvelopeFormat.scopeDigest(Fixture.scope), volumes: disks.identities), descriptors: disks.reopen())
        h.status(.volumesAccepted); h.status(.vmRunning); h.status(.guestHello); h.stop(); h.cleanHalt(); h.workerExits(.code(0))
        let receipt = try XCTUnwrap(h.ports.stopped.first)
        XCTAssertTrue(V.isCanonicalMac(receipt.mac))
        XCTAssertTrue(receipt.macVerifies(under: Fixture.receiptKey))
        XCTAssertFalse(receipt.macVerifies(under: ReceiptKey(bytes: [UInt8](repeating: 9, count: 32))!), "a different key")
        let text = try StopReceipt.orderly(receipt).serialize()
        XCTAssertTrue(String(decoding: text, as: UTF8.self).contains(",\"mac\":\"\(receipt.mac)\"}\n"), "mac is the last key")
        XCTAssertTrue(key.isZeroed, "the key is overwritten once the verdict is final"); XCTAssertNil(h.session.heldReceiptKey)
    }
    func testAnUnsignedReceiptCanNeitherBeSerializedNorStored() throws {
        var r = try orderly(Fixture.receiptKey); r.mac = ""
        XCTAssertThrowsError(try StopReceipt.orderly(r).serialize())
        let store = InMemoryReceiptStore()
        XCTAssertThrowsError(try store.persist(.orderly(r), scope: ReceiptScope(Fixture.scope)))
    }
    func testNoKeyNoClassA() throws {
        // A fully orderly stop, except that the key is gone before the verdict (a launcher fault): there is nothing to sign with, so there is no Class A.
        let h = SessionHarness(); try h.bringUp(); h.stop(); h.cleanHalt()
        try XCTUnwrap(h.session.heldReceiptKey).zeroize()
        h.workerExits(.code(0))
        XCTAssertTrue(h.ports.stopped.isEmpty, "no key, no Class A")
        XCTAssertEqual(h.ports.uncertain.map(\.reason), [.launcherFault])
    }
    func testAWrongKeyAndATruncatedOrTamperedTagNeverVerify() throws {
        let r = try orderly(Fixture.receiptKey), key = Fixture.receiptKey
        XCTAssertTrue(r.macVerifies(under: key))
        var wrongKey = r; wrongKey.mac = Data(ReceiptKey(bytes: [UInt8](repeating: 3, count: 32))!.mac(r.macInput())!).base64EncodedString()
        XCTAssertFalse(wrongKey.macVerifies(under: key), "signed under another key")
        let tag = [UInt8](Data(base64Encoded: r.mac)!)
        for (label, bad) in [("31 bytes", Array(tag.dropLast())), ("empty", []), ("33 bytes", tag + [0])] {
            var t = r; t.mac = Data(bad).base64EncodedString()
            XCTAssertFalse(t.macVerifies(under: key), "truncated or padded tag: \(label)")
        }
        var flipped = tag; flipped[0] ^= 1
        var f = r; f.mac = Data(flipped).base64EncodedString(); XCTAssertFalse(f.macVerifies(under: key), "one bit")
        var edited = r; edited.workerPid += 1; XCTAssertFalse(edited.macVerifies(under: key), "content changed after signing")
        var shortText = r; shortText.mac = String(r.mac.dropLast()); XCTAssertFalse(shortText.macVerifies(under: key), "a mac that is not canonical base64 of 32 bytes")
    }
    func testAVersionOneReceiptAndAVersionOneLineAreRefused() throws {
        let r = try orderly(Fixture.receiptKey)
        let text = String(decoding: try StopReceipt.orderly(r).serialize(), as: UTF8.self)
        XCTAssertThrowsError(try StopReceipt.parse(Array(text.replacingOccurrences(of: "{\"v\":2,", with: "{\"v\":1,").utf8)), "text version 1")
        let begin = String(decoding: try LauncherLineCodec.serialize(.begin(id: "req-1", homeId: "home_x", scope: Fixture.scope, receiptKey: Fixture.receiptKey)), as: UTF8.self)
        XCTAssertThrowsError(try LauncherLineCodec.parseToLauncher(Array(begin.replacingOccurrences(of: "{\"v\":2,", with: "{\"v\":1,").utf8))) { XCTAssertEqual($0 as? WireFailure, .version) }
        let classB = String(decoding: try StopReceipt.uncertain(UncertainReceipt(launcherInstanceId: Fixture.launcherInstanceId, admissionId: Fixture.scope.admissionId, workspaceId: Fixture.scope.workspaceId,
            incarnationId: Fixture.scope.incarnationId, leaseEpoch: Fixture.scope.leaseEpoch, workerInstanceId: Fixture.scope.workerInstanceId, reason: .daemonLost, workerPid: 1, workerStartToken: "1.1",
            workerExit: .unknown, workerStatus: 0, attachedVolumes: false, issuedAtMs: 1)).serialize(), as: UTF8.self)
        XCTAssertTrue(classB.hasPrefix("{\"v\":2,\"class\":\"B\""), "Class B is text version 2 too, and carries no MAC")
        XCTAssertFalse(classB.contains("\"mac\""))
    }

    // MARK: the retained-receipt read path

    func testTheRetainedReadPathVerifiesTheMacAndRefusesAForgedFile() throws {
        let dir = makeTemporaryDirectory("mac-store")
        let store = try DirectoryReceiptStore(directory: BuiltProducts.canonical(dir.path))
        let r = try orderly(Fixture.receiptKey), scope = ReceiptScope(Fixture.scope)
        try store.persist(.orderly(r), scope: scope)
        XCTAssertEqual(try store.load(scope, key: Fixture.receiptKey), .orderly(r))
        XCTAssertThrowsError(try store.load(scope, key: ReceiptKey(bytes: [UInt8](repeating: 5, count: 32))!)) { XCTAssertEqual($0 as? ReceiptStoreFailure, .macInvalid) }
        let zeroed = Fixture.receiptKey; zeroed.zeroize()
        XCTAssertThrowsError(try store.load(scope, key: zeroed), "a missing key makes the file unverifiable") { XCTAssertEqual($0 as? ReceiptStoreFailure, .macInvalid) }
        // A same-user process rewrites the file with a plausible receipt whose MAC it cannot compute: same name, same shape, another worker pid.
        var forged = r; forged.workerPid += 1
        let path = dir.path + "/" + DirectoryReceiptStore.fileName(scope)
        chmod(path, 0o600)
        try Data(try StopReceipt.orderly(forged).serialize()).write(to: URL(fileURLWithPath: path))
        chmod(path, 0o600)
        XCTAssertThrowsError(try store.load(scope, key: Fixture.receiptKey)) { XCTAssertEqual($0 as? ReceiptStoreFailure, .macInvalid) }
    }
}
