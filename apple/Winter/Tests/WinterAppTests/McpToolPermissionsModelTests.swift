import XCTest
import WinterKit
@testable import Winter

/// Hand-written `McpPermissionsClient` double (WS-26) — no socket, every answer scripted.
/// `@unchecked Sendable` like `FakeMcpAuthClient`: every mutation happens on the main actor.
final class FakeMcpPermissionsClient: McpPermissionsClient, @unchecked Sendable {
    struct SimpleError: Error {}
    var toolsResults: [Result<McpToolsServer?, Error>] = []
    private(set) var toolsCalls: [String] = []
    var setResult: Result<Void, Error> = .success(())
    private(set) var setCalls: [(server: String, tool: String, permission: McpToolPermission?, resetTools: Bool)] = []

    func tools(server: String) async throws -> McpToolsServer? {
        toolsCalls.append(server)
        let next = toolsResults.count > 1 ? toolsResults.removeFirst() : (toolsResults.first ?? .success(nil))
        return try next.get()
    }

    func setToolPermission(server: String, tool: String, permission: McpToolPermission?, resetTools: Bool) async throws {
        setCalls.append((server, tool, permission, resetTools))
        try setResult.get()
    }
}

private func cf(allTools: McpToolPermission? = nil, tools: [McpToolPermissionRow]) -> McpToolsServer {
    McpToolsServer(name: "cf", status: "connected", allTools: allTools, listed: true, tools: tools)
}

private let listRow = McpToolPermissionRow(name: "workers_list", toolName: "mcp__cf__workers_list", readOnly: true, permission: .allow, source: "default")
private let deleteRow = McpToolPermissionRow(name: "workers_delete", toolName: "mcp__cf__workers_delete", readOnly: false, setting: .deny, permission: .deny, source: "tool")

/// WS-26: the Library's connector-permission model and its pure helpers.
@MainActor
final class McpToolPermissionsModelTests: XCTestCase {
    func testUnwiredKeepsThePlainListAndNeverCalls() async {
        let model = McpToolPermissionsModel(serverName: "cf", client: nil)
        XCTAssertTrue(model.isUnwired)
        XCTAssertTrue(model.showsPlainList)
        await model.refresh()
        await model.tap(tool: "workers_list", .deny)
        XCTAssertNil(model.server)
    }

    func testRefreshLoadsTheServer() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.success(cf(tools: [listRow, deleteRow]))]
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()
        XCTAssertEqual(fake.toolsCalls, ["cf"])
        XCTAssertEqual(model.server?.tools.map(\.name), ["workers_list", "workers_delete"])
        XCTAssertFalse(model.showsPlainList)
        XCTAssertTrue(model.hasLoaded)
    }

    /// `-32601` is a daemon that predates `mcp.tools` — an expected state: the plain list, no error.
    func testAnOlderDaemonFallsBackToThePlainList() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.failure(RpcError(code: -32601, message: "method not found"))]
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()
        XCTAssertTrue(model.isUnsupported)
        XCTAssertTrue(model.showsPlainList)
        XCTAssertNil(model.errorText)
    }

    /// A real failure keeps the last good rows on screen and says so.
    func testAFailedRefreshKeepsTheLastRows() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.success(cf(tools: [listRow])), .failure(FakeMcpPermissionsClient.SimpleError())]
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()
        await model.refresh()
        XCTAssertEqual(model.server?.tools.count, 1)
        XCTAssertNotNil(model.errorText)
        XCTAssertFalse(model.showsPlainList)
    }

    /// A tap stores the tapped value; a tap on the STORED value clears it to the default; either way the
    /// model re-reads what the daemon says applies.
    func testTapStoresAndTheSameTapClears() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.success(cf(tools: [listRow, deleteRow]))]
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()

        await model.tap(tool: "workers_list", .ask)
        await model.tap(tool: "workers_delete", .deny)
        XCTAssertEqual(fake.setCalls.count, 2)
        XCTAssertEqual(fake.setCalls[0].tool, "workers_list")
        XCTAssertEqual(fake.setCalls[0].permission, .ask)
        XCTAssertFalse(fake.setCalls[0].resetTools)
        XCTAssertEqual(fake.setCalls[1].tool, "workers_delete")
        XCTAssertNil(fake.setCalls[1].permission, "tapping the stored Deny clears it to the default")
        XCTAssertEqual(fake.toolsCalls.count, 3, "each write re-reads")
        XCTAssertTrue(model.pending.isEmpty)
    }

    /// All actions: a value resets every per-action choice; tapping the stored value clears only it.
    func testTapAllResetsPerActionChoicesAndTheSameTapClears() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.success(cf(allTools: .ask, tools: [listRow]))]
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()

        await model.tapAll(.deny)
        XCTAssertEqual(fake.setCalls.last?.tool, "*")
        XCTAssertEqual(fake.setCalls.last?.permission, .deny)
        XCTAssertEqual(fake.setCalls.last?.resetTools, true)

        await model.tapAll(.ask)
        XCTAssertNil(fake.setCalls.last?.permission)
        XCTAssertEqual(fake.setCalls.last?.resetTools, false)
    }

    func testAFailedWriteIsReportedAndStillReReads() async {
        let fake = FakeMcpPermissionsClient()
        fake.toolsResults = [.success(cf(tools: [listRow]))]
        fake.setResult = .failure(FakeMcpPermissionsClient.SimpleError())
        let model = McpToolPermissionsModel(serverName: "cf", client: fake)
        await model.refresh()
        await model.tap(tool: "workers_list", .deny)
        XCTAssertEqual(fake.toolsCalls.count, 2)
        XCTAssertTrue(model.pending.isEmpty)
    }

    // MARK: pure helpers

    func testAfterTap() {
        XCTAssertEqual(mcpPermissionAfterTap(current: nil, tapped: .allow), .allow)
        XCTAssertEqual(mcpPermissionAfterTap(current: .ask, tapped: .deny), .deny)
        XCTAssertNil(mcpPermissionAfterTap(current: .deny, tapped: .deny))
    }

    func testCaptionSaysWhatAppliesAndWhy() {
        XCTAssertEqual(mcpToolPermissionCaption(listRow), "Default: runs without asking — the server marks it read-only")
        XCTAssertEqual(mcpToolPermissionCaption(deleteRow), "Always deny — set for this action")
        let fromServer = McpToolPermissionRow(name: "x", toolName: "mcp__cf__x", readOnly: false, permission: .ask, source: "server")
        XCTAssertEqual(mcpToolPermissionCaption(fromServer), "Always ask — from All actions")
        let unsetWrite = McpToolPermissionRow(name: "y", toolName: "mcp__cf__y", readOnly: false, permission: .ask, source: "default")
        XCTAssertEqual(mcpToolPermissionCaption(unsetWrite), "Default: asks first — code sessions follow their approval policy")
        let ruled = McpToolPermissionRow(name: "z", toolName: "mcp__cf__z", readOnly: false, setting: .allow, permission: .deny, source: "rule",
                                         rules: [McpToolRule(behavior: .deny, rule: "mcp__cf__z"), McpToolRule(behavior: .allow, rule: "mcp__cf__*")])
        XCTAssertEqual(mcpToolPermissionCaption(ruled), "Denied by mcp__cf__z in sdk/settings.json — it applies in every mode")
        XCTAssertEqual(mcpToolRuleNotes(ruled), ["allow rule mcp__cf__* in sdk/settings.json — code sessions only"])
    }

    func testASignInHidesTheActionList() {
        XCTAssertTrue(mcpPermissionsNeedSignIn(status: "needs-auth", auth: nil))
        XCTAssertTrue(mcpPermissionsNeedSignIn(status: "connected", auth: "needs-auth"))
        XCTAssertFalse(mcpPermissionsNeedSignIn(status: "connected", auth: "signed-in"))
        XCTAssertFalse(mcpPermissionsNeedSignIn(status: "connected", auth: nil))
    }
}
