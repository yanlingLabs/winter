import WinterKit
import WinterProtocol
import XCTest
@testable import Winter

/// Task 4 (Phase 4d-iii): `TileData` — the pure adapter that unifies `pluginsContrib()`'s WinterKit
/// `JSONValue` tile shape and the live `plugin_tile_updated` event's WinterProtocol
/// `SessionEvent.JSONValue` tile shape into one struct. No `WinterClient`, no SwiftUI — same "pure
/// helper, table-tested directly" posture as `PluginManagerModelTests`' coverage of
/// `pluginRowDisplay`.
final class TileAdapterTests: XCTestCase {
    // MARK: - Both sources agree on equivalent input

    func testBothSourcesProduceEquivalentTileDataForAFullTile() {
        let kitTile: [String: JSONValue] = [
            "title": .string("Battery"),
            "value": .string("82%"),
            "icon": .string("battery.75"),
            "progress": .number(0.82),
            "actions": .array([
                .object(["id": .string("charge"), "label": .string("Set limit")]),
                .object(["id": .string("refresh"), "label": .string("Refresh")]),
            ]),
        ]
        let eventTile: [String: SessionEvent.JSONValue] = [
            "title": .string("Battery"),
            "value": .string("82%"),
            "icon": .string("battery.75"),
            "progress": .number(0.82),
            "actions": .array([
                .object(["id": .string("charge"), "label": .string("Set limit")]),
                .object(["id": .string("refresh"), "label": .string("Refresh")]),
            ]),
        ]
        guard let fromKit = TileData(from: kitTile), let fromEvent = TileData(from: eventTile) else {
            XCTFail("both sources should parse a well-formed tile")
            return
        }
        XCTAssertEqual(fromKit, fromEvent)
        XCTAssertEqual(fromKit.title, "Battery")
        XCTAssertEqual(fromKit.value, "82%")
        XCTAssertEqual(fromKit.icon, "battery.75")
        XCTAssertEqual(fromKit.progress, 0.82)
        XCTAssertEqual(fromKit.actions, [
            TileData.Action(id: "charge", label: "Set limit"),
            TileData.Action(id: "refresh", label: "Refresh"),
        ])
    }

    func testBothSourcesProduceEquivalentTileDataForAMinimalTitleOnlyTile() {
        let kitTile: [String: JSONValue] = ["title": .string("Idle")]
        let eventTile: [String: SessionEvent.JSONValue] = ["title": .string("Idle")]
        guard let fromKit = TileData(from: kitTile), let fromEvent = TileData(from: eventTile) else {
            XCTFail("both sources should parse a title-only tile")
            return
        }
        XCTAssertEqual(fromKit, fromEvent)
        XCTAssertEqual(fromKit.title, "Idle")
        XCTAssertNil(fromKit.value)
        XCTAssertNil(fromKit.icon)
        XCTAssertNil(fromKit.progress)
        XCTAssertEqual(fromKit.actions, [])
    }

    // MARK: - nil for a malformed/missing-title tile, both sources

    func testMissingTitleReturnsNilForBothSources() {
        let kitTile: [String: JSONValue] = ["value": .string("x")]
        let eventTile: [String: SessionEvent.JSONValue] = ["value": .string("x")]
        XCTAssertNil(TileData(from: kitTile))
        XCTAssertNil(TileData(from: eventTile))
    }

    func testNonStringTitleReturnsNilForBothSources() {
        let kitTile: [String: JSONValue] = ["title": .number(1)]
        let eventTile: [String: SessionEvent.JSONValue] = ["title": .number(1)]
        XCTAssertNil(TileData(from: kitTile))
        XCTAssertNil(TileData(from: eventTile))
    }

    func testEmptyTileObjectReturnsNilForBothSources() {
        let kitTile: [String: JSONValue] = [:]
        let eventTile: [String: SessionEvent.JSONValue] = [:]
        XCTAssertNil(TileData(from: kitTile))
        XCTAssertNil(TileData(from: eventTile))
    }

    // MARK: - malformed optional fields degrade gracefully rather than failing the whole tile

    func testMalformedActionEntriesAreSkippedNotFatalForBothSources() {
        let kitTile: [String: JSONValue] = [
            "title": .string("T"),
            "actions": .array([
                .object(["id": .string("ok"), "label": .string("OK")]),
                .object(["id": .string("bad")]), // missing label
                .string("not an object"),
            ]),
        ]
        let eventTile: [String: SessionEvent.JSONValue] = [
            "title": .string("T"),
            "actions": .array([
                .object(["id": .string("ok"), "label": .string("OK")]),
                .object(["id": .string("bad")]),
                .string("not an object"),
            ]),
        ]
        guard let fromKit = TileData(from: kitTile), let fromEvent = TileData(from: eventTile) else {
            XCTFail("a malformed action entry must not fail the whole tile")
            return
        }
        XCTAssertEqual(fromKit, fromEvent)
        XCTAssertEqual(fromKit.actions, [TileData.Action(id: "ok", label: "OK")])
    }

    func testWrongTypedOptionalFieldsDegradeToNilRatherThanFailing() {
        let kitTile: [String: JSONValue] = [
            "title": .string("T"),
            "value": .number(5), // wrong type — value must be a string
            "progress": .string("50%"), // wrong type — progress must be a number
        ]
        let eventTile: [String: SessionEvent.JSONValue] = [
            "title": .string("T"),
            "value": .number(5),
            "progress": .string("50%"),
        ]
        guard let fromKit = TileData(from: kitTile), let fromEvent = TileData(from: eventTile) else {
            XCTFail("wrong-typed optional fields must not fail the whole tile")
            return
        }
        XCTAssertEqual(fromKit, fromEvent)
        XCTAssertEqual(fromKit.title, "T")
        XCTAssertNil(fromKit.value)
        XCTAssertNil(fromKit.progress)
    }
}
