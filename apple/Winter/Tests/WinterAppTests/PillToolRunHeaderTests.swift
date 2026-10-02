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
