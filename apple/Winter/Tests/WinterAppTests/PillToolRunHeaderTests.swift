import XCTest
@testable import Winter

/// The pill-themed session window draws a tool run as the plume's own discs.
final class PillToolRunHeaderTests: XCTestCase {
    private func call(_ id: String, output: String? = nil, isError: Bool = false, sites: [SiteIconRef] = []) -> ToolCallRecord {
        ToolCallRecord(callId: id, detail: nil, output: output, isError: isError, siteIcons: sites)
    }

    func testEachDistinctToolShowsOneDiscInOrder() {
        let discs = toolRunDiscs([ToolRunEntry(name: "read", calls: [call("r1"), call("r2")]),
                                  ToolRunEntry(name: "bash", calls: [call("b1")])])
        XCTAssertEqual(discs.map(\.kind), [.tool(symbol: workingToolSymbol(for: "read")), .tool(symbol: workingToolSymbol(for: "bash"))])
    }

    func testASearchShowsTheSitesItFound() {
        let sites = [SiteIconRef(url: "https://www.britannica.com/x", iconUrl: "https://www.britannica.com/favicon.png"),
                     SiteIconRef(url: "https://nasa.gov/y", iconUrl: "https://nasa.gov/icon.png")]
        let discs = toolRunDiscs([ToolRunEntry(name: "web_search", calls: [call("s1", output: "britannica.com nasa.gov", sites: sites)])])
        XCTAssertEqual(discs.map(\.kind), [.site(host: "www.britannica.com", iconURL: "https://www.britannica.com/favicon.png"),
                                           .site(host: "nasa.gov", iconURL: "https://nasa.gov/icon.png")])
    }

    func testASearchStillOutShowsItsOwnSymbol() {
        let discs = toolRunDiscs([ToolRunEntry(name: "web_search", calls: [call("s1")])])
        XCTAssertEqual(discs.map(\.kind), [.tool(symbol: "magnifyingglass")])
    }
}

/// What each tool pill says, running and finished (user, 2026-10-02).
final class PillToolLabelTests: XCTestCase {
    private func call(_ id: String, detail: String? = nil, output: String? = nil, isError: Bool = false,
                      sites: [SiteIconRef] = [], lines: Int? = nil) -> ToolCallRecord {
        ToolCallRecord(callId: id, detail: detail, output: output, isError: isError, siteIcons: sites, writtenLines: lines)
    }
    private func sites(_ n: Int, _ prefix: String) -> [SiteIconRef] {
        (0..<n).map { SiteIconRef(url: "https://\(prefix)\($0).com/x", iconUrl: "https://\(prefix)\($0).com/i.png") }
    }

    func testSearchSaysSearchingThenSumsTheSitesOfEveryQuery() {
        let pending = ToolRunEntry(name: "web_search", calls: [call("a"), call("b")])
        XCTAssertEqual(pillToolLabel(pending, turnIsLive: true), PillToolLabel(lead: "Searching the web"))
        let half = ToolRunEntry(name: "web_search", calls: [call("a", output: "ok", sites: sites(10, "a")), call("b")])
        XCTAssertEqual(pillToolLabel(half, turnIsLive: true), PillToolLabel(lead: "Searching the web · ", count: 10, noun: .website))
        let done = ToolRunEntry(name: "web_search", calls: [call("a", output: "ok", sites: sites(10, "a")),
                                                            call("b", output: "ok", sites: sites(10, "b"))])
        XCTAssertEqual(pillToolLabel(done, turnIsLive: false), PillToolLabel(lead: "Searched ", count: 20, noun: .website))
    }

    func testFetchRotatesThePagesItIsReadingThenCountsThem() {
        let running = ToolRunEntry(name: "WebFetch", calls: [call("a", detail: "https://www.nytimes.com/x"), call("b", detail: "https://bbc.co.uk/y")])
        let label = pillToolLabel(running, turnIsLive: true)
        XCTAssertEqual(label.lead, "Reading ")
        XCTAssertEqual(label.rotation.map(\.text), ["nytimes.com", "bbc.co.uk"])
        let done = ToolRunEntry(name: "WebFetch", calls: [call("a", detail: "https://nytimes.com", output: "page"), call("b", detail: "https://bbc.co.uk", output: "page")])
        XCTAssertEqual(pillToolLabel(done, turnIsLive: false), PillToolLabel(lead: "Read ", count: 2, noun: .page))
    }

    func testShellCountsItsCommandsRunningAndRan() {
        let running = ToolRunEntry(name: "bash", calls: [call("a", output: "x"), call("b"), call("c")])
        XCTAssertEqual(pillToolLabel(running, turnIsLive: true), PillToolLabel(lead: "Running ", count: 3, noun: .shellCommand))
        let done = ToolRunEntry(name: "bash", calls: [call("a", output: "x"), call("b", output: "y")])
        XCTAssertEqual(pillToolLabel(done, turnIsLive: false), PillToolLabel(lead: "Ran ", count: 2, noun: .shellCommand))
    }

    func testWriteNamesTheFileByNameAndCountsItsLines() {
        let running = ToolRunEntry(name: "write", calls: [call("a", detail: "/Users/me/p/src/config.ts", lines: 120)])
        XCTAssertEqual(pillToolLabel(running, turnIsLive: true), PillToolLabel(lead: "Writing ", count: 120, noun: .line, tail: " to config.ts"))
        let two = ToolRunEntry(name: "write", calls: [call("a", detail: "/p/a.ts", lines: 10), call("b", detail: "/p/b.ts", lines: 5)])
        XCTAssertEqual(pillToolLabel(two, turnIsLive: true), PillToolLabel(lead: "Writing ", count: 15, noun: .line, tail: " to 2 files"))
        let done = ToolRunEntry(name: "write", calls: [call("a", detail: "/p/a.ts", output: "ok"), call("b", detail: "/p/b.ts", output: "ok")])
        XCTAssertEqual(pillToolLabel(done, turnIsLive: false), PillToolLabel(lead: "Wrote ", count: 2, noun: .file))
    }

    func testFailuresHaveTheirOwnWords() {
        let one = ToolRunEntry(name: "bash", calls: [call("a", output: "boom", isError: true)])
        XCTAssertEqual(pillToolLabel(one, turnIsLive: false), PillToolLabel(lead: "Shell command failed"))
        let some = ToolRunEntry(name: "bash", calls: [call("a", output: "ok"), call("b", output: "boom", isError: true)])
        XCTAssertEqual(pillToolLabel(some, turnIsLive: false), PillToolLabel(lead: "Ran ", count: 2, noun: .shellCommand, tail: " · 1 failed"))
    }

    func testAWriteCallRecordsItsLineCount() {
        XCTAssertEqual(SessionReducer.writtenLineCount(argsJson: #"{"file_path":"/a","content":"one\ntwo\nthree\n"}"#), 3)
        XCTAssertEqual(SessionReducer.writtenLineCount(argsJson: #"{"file_path":"/a","content":"one\ntwo"}"#), 2)
        XCTAssertNil(SessionReducer.writtenLineCount(argsJson: #"{"file_path":"/a"}"#))
    }
}
