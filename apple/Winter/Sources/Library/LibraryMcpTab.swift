import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Library → MCP tools (2026-09-17; the Winter half wired 2026-09-18). Two sections, served by two
// different RPCs, and each one degrades on its own.
//
// **External servers** (`mcp.list`) — servers the user or a project or a plugin configured, each
// with `{name, status, toolNames, source}`, reached through `DashboardWiring.mcpList` (a closure,
// never a `WinterClient`). `McpToolsModel` takes that lister as an injected optional; `nil` renders
// an honest "no door yet" state.
//
// DRILL-IN (2026-09-18): the LIST shows both halves (external servers grouped by source, then
// Winter's own); a row opens that server's tools as a full-width DETAIL page. Both models are owned
// by `LibraryPanel`, not by the list, because the detail page replaces the list and reads them.
//
// **Winter's own capability servers** (`winter__<key>`: sessions, computer, browser, office,
// research, web, lsp, external) — these are in-process MCP servers the DAEMON hands the runtime
// child, and they are not in `mcp.list`'s response at all. `capabilities.list` serves them, and
// this tab now calls it (`WinterCapabilitiesModel`).
//
// THAT RPC IS NEWER THAN THIS APP. A daemon from before it answers `-32601`, which is an ordinary
// state, not a fault — the app ships on its own cadence. The model turns that ONE error code into
// `isUnsupported` and the section falls back to exactly the copy it had before this wiring: the
// pending note plus the shape-only key list. Every other error stays an error, and a successful
// empty answer is rendered as an answer. Three different facts, three different renderings; the
// failure mode to avoid is a missing method reading as "Winter exposes no tools".
//
// THREE THINGS THE ANSWER SAYS THAT A NAIVE READING WOULD GET WRONG:
//
// - `enabled` is a LIVE GATE on `computer` and `lsp` ONLY. Every other key always reports true, so
//   it is never rendered as a per-key switch a user could have set.
// - `external` with NO tools is normal — it is the plugin-contributed server, empty until a plugin
//   contributes something. Never an error.
// - `exposure` is the resolved per-mode answer and is the interesting half: a tool listed with
//   three modes may still be withheld from one of them. The rows therefore say what each mode
//   WITHHOLDS, never a flat "available" that would imply the tool is there everywhere.
//
// TWO CAVEATS THIS FILE IS BUILT AROUND:
//
// 1. **`cwd` SPAWNS.** `mcp.list`'s handler is `if (p.cwd) await opts.mcp?.ensureProject(p.cwd)` —
//    passing a cwd starts that project's servers as a side effect of "listing". A panel you open
//    to look at things must never do that, so `McpToolsModel` has no cwd parameter at all rather
//    than an optional one someone could later fill in. The nil-cwd call is a pure read, which is
//    why this tab can safely load on appear.
//    THE PRICE, stated plainly because the tab has to say it out loud: `McpManager.list(undefined)`
//    (agent/mcp/manager.ts) returns the user's own servers plus the plugin-contributed ones and
//    NOTHING project-scoped — a project's servers are only ever appended for an explicitly passed,
//    already-started `cwd`. A cwd-less Library tab therefore cannot show them at all, and showing
//    them would mean spawning them. That is a deliberate trade, not an oversight; if project scope
//    is ever wanted here it needs a cwd the user chose, not one the panel guessed.
// 2. **`toolNames` are BARE.** The wire returns `read_file`; the name the model actually calls is
//    `mcp__<server>__<tool>`. A user matching a transcript's tool call against this list needs the
//    qualified form, so both are rendered — bare as the row title, qualified as its monospaced
//    subtitle (`mcpWireToolName`).
// -----------------------------------------------------------------------------------------------

// MARK: - Pure display helpers

/// One external MCP server as this tab renders it. A plain struct rather than the wrapper's tuple
/// so the view and the (pure) helpers below have a name to speak about.
struct McpServerRow: Equatable, Identifiable {
    var id: String { name }
    let name: String
    /// The wire's own status word, rendered verbatim — the vocabulary belongs to the daemon and
    /// inventing a client-side mapping would drift the moment it grows a state.
    let status: String
    /// BARE tool names, as the wire delivers them.
    let toolNames: [String]
    /// `user` | `project` | `plugin`.
    let source: String
}

/// PURE: the fully-qualified name the model sees for a tool on an external server. This is the
/// string that appears in a transcript's tool call, and the only reason this tab shows the bare
/// name at all is that it is what the server itself calls the tool.
func mcpWireToolName(server: String, tool: String) -> String {
    "mcp__\(server)__\(tool)"
}

/// PURE: the fully-qualified prefix for one of Winter's OWN in-process capability servers. Same
/// shape, different namespace — the daemon registers them as `winter__<key>`, so the child sees
/// `mcp__winter__<key>__<tool>`. Kept next to `mcpWireToolName` precisely because the two look
/// alike and are not interchangeable.
func winterCapabilityWireName(key: String) -> String {
    "mcp__winter__\(key)__<tool>"
}

/// The fixed source display order — narrowest scope first, which is also the order a user thinks
/// about them in ("mine", "this project's", "a plugin's").
let mcpSourceOrder: [String] = ["user", "project", "plugin"]

/// PURE: the source's group heading. A source outside the closed wire enum falls through to its
/// raw value rather than vanishing.
func mcpSourceBadge(_ source: String) -> String {
    switch source {
    case "user": return "User"
    case "project": return "Project"
    case "plugin": return "Plugin"
    default: return source.capitalized
    }
}

/// PURE: group servers by source in `mcpSourceOrder`, omitting empty groups; an unknown source
/// still gets its own trailing group, sorted among its peers. Directly modelled on
/// `skillsGroupedBySource` — same problem, same answer, so the two surfaces behave identically.
func mcpServersGroupedBySource(_ servers: [McpServerRow]) -> [(source: String, servers: [McpServerRow])] {
    var groups: [(source: String, servers: [McpServerRow])] = []
    for source in mcpSourceOrder {
        let matched = servers.filter { $0.source == source }
        if !matched.isEmpty { groups.append((source, matched)) }
    }
    let known = Set(mcpSourceOrder)
    for source in Set(servers.map(\.source)).subtracting(known).sorted() {
        groups.append((source, servers.filter { $0.source == source }))
    }
    return groups
}

/// The eight capability keys the daemon registers today (`capabilities/`, per CLAUDE.md's tool
/// surface section) — a LABELLED GUESS, not an inventory. `external` is dynamic (one entry per
/// plugin that contributes tools), so even this list cannot be complete.
///
/// STILL LIVE CODE after the RPC wiring, with a narrowed job: it is what the section shows when
/// the daemon cannot answer `capabilities.list` (too old, or no door), rendered quiet and unbadged
/// so it can never be mistaken for the real inventory. When the RPC answers, nothing below reads
/// this list.
let winterCapabilityKeysKnownToday: [String] = [
    "sessions", "computer", "browser", "office", "research", "web", "lsp", "external",
]

/// The mode display order — the order a session's life makes sense in, and the same order
/// `SessionMode` itself lists. A mode outside the three (a daemon that grows a fourth) sorts after
/// them alphabetically rather than being dropped.
let winterCapabilityModeOrder: [String] = ["code", "dispatch", "chat"]

/// PURE: order a set of mode names for display.
func winterCapabilityModesSorted(_ modes: [String]) -> [String] {
    modes.sorted { lhs, rhs in
        let l = winterCapabilityModeOrder.firstIndex(of: lhs) ?? winterCapabilityModeOrder.count
        let r = winterCapabilityModeOrder.firstIndex(of: rhs) ?? winterCapabilityModeOrder.count
        if l != r { return l < r }
        return lhs < rhs
    }
}

/// PURE: the modes that WITHHOLD this tool — `exposure` entries that resolved to false.
///
/// Withheld, not available, is what gets rendered: a mode missing from `exposure` entirely means
/// the daemon said nothing about it, and printing "available in code, dispatch" from a two-key map
/// would be a claim about a third mode nobody made.
func winterCapabilityWithheldModes(_ tool: WinterCapabilityTool) -> [String] {
    winterCapabilityModesSorted(tool.exposure.filter { !$0.value }.map(\.key))
}

/// PURE: the row's exposure sentence, or nil when there is nothing to warn about (every mode the
/// daemon spoke of exposes the tool).
func winterCapabilityExposureText(_ tool: WinterCapabilityTool) -> String? {
    let withheld = winterCapabilityWithheldModes(tool)
    guard !withheld.isEmpty else { return nil }
    return "withheld in \(withheld.joined(separator: ", "))"
}

/// PURE: the deferred sentence. A deferred tool is NOT missing — it exists in that mode but is not
/// in the prompt until the model searches for it, which is a real difference in how it behaves and
/// a different fact from being withheld. Modes that withhold the tool outright are excluded: a
/// tool that is not there cannot also be "search-first" there.
func winterCapabilityDeferredText(_ tool: WinterCapabilityTool) -> String? {
    let withheld = Set(winterCapabilityWithheldModes(tool))
    let deferred = winterCapabilityModesSorted(tool.deferred.filter { !withheld.contains($0) })
    guard !deferred.isEmpty else { return nil }
    return "found by search in \(deferred.joined(separator: ", "))"
}

/// PURE: the tool row's subtitle — what this tool's availability actually is, phrased as what is
/// TAKEN AWAY.
///
/// The fallback sentence names the modes the daemon SPOKE of rather than claiming "every mode":
/// an `exposure` map with two keys says nothing about a third mode, and a row that implied
/// otherwise would be the tab inventing availability. With no exposure map at all there is simply
/// nothing to say, so the row falls back to the registered modes — the weaker, true claim.
func winterCapabilityToolSubtitle(_ tool: WinterCapabilityTool) -> String {
    let parts = [winterCapabilityExposureText(tool), winterCapabilityDeferredText(tool)].compactMap { $0 }
    if !parts.isEmpty { return parts.joined(separator: " · ") }
    let exposed = winterCapabilityModesSorted(tool.exposure.filter(\.value).map(\.key))
    if !exposed.isEmpty { return "in \(exposed.joined(separator: ", "))" }
    let modes = winterCapabilityModesSorted(tool.modes)
    return modes.isEmpty ? "no modes reported" : "registered for \(modes.joined(separator: ", "))"
}

/// PURE: the capability's own subtitle — its tool count, or the one sentence that stops an empty
/// `external` from reading as breakage.
func winterCapabilitySubtitle(_ capability: WinterCapability) -> String {
    if capability.tools.isEmpty {
        return capability.key == "external"
            ? "No plugin contributes a tool yet"
            : "No tools reported"
    }
    return "\(capability.tools.count) tool\(capability.tools.count == 1 ? "" : "s")"
}

/// PURE: the trailing badge for a capability, or nil.
///
/// ONLY `computer` and `lsp` carry a live gate; every other key always reports `enabled: true`, so
/// a badge on them would invent a switch. An "off" badge therefore renders only where `enabled` is
/// actually false — and it says "off", not "disabled", because nothing the user did turned it off:
/// it is a capability the daemon cannot serve right now.
func winterCapabilityBadge(_ capability: WinterCapability) -> String? {
    capability.enabled ? nil : "off"
}

// MARK: - The model

/// The external half's state.
///
/// Injected lister, not a client: see this file's header. `nil` is a first-class state, not an
/// error — it means the app has no door to `mcp.list` yet, which is a different fact from "the
/// call failed" and from "there are no servers", and the view distinguishes all three.
@MainActor
final class McpToolsModel: ObservableObject {
    /// `() async throws -> [...]` shaped to `WinterClient.mcpList`'s own return tuple, so the
    /// eventual wiring is a one-line pass-through with no adapter in between.
    typealias Lister = () async throws -> [(name: String, status: String, toolNames: [String], source: String)]

    /// NO `cwd` anywhere in this type, deliberately — see caveat 1 in the file header.
    private let lister: Lister?

    @Published private(set) var servers: [McpServerRow] = []
    @Published private(set) var loading = false
    @Published var errorText: String?
    /// `false` until the first completed load, so the view never shows "no servers" before it has
    /// looked.
    @Published private(set) var hasLoaded = false

    /// `true` when there is no way to ask the daemon at all — drives the pending state.
    var isUnwired: Bool { lister == nil }

    init(lister: Lister? = nil) {
        self.lister = lister
    }

    /// Safe on appear: the nil-cwd `mcp.list` is a pure read (the handler only calls
    /// `ensureProject` when a cwd is present).
    func refresh() async {
        guard let lister else { return }
        loading = true
        defer { loading = false }
        do {
            servers = try await lister().map {
                McpServerRow(name: $0.name, status: $0.status, toolNames: $0.toolNames, source: $0.source)
            }
            errorText = nil
            hasLoaded = true
        } catch {
            // The list is left STALE rather than cleared — same posture as `PluginManagerModel`'s
            // own failed refresh. A transient socket error should not blank a panel you are
            // reading.
            errorText = shellPanelErrorText("Couldn't read the MCP servers", detail: "\(error)")
        }
    }
}

/// The Winter half's state (`capabilities.list`).
///
/// FOUR states, kept apart on purpose, because three of them would otherwise render as the same
/// empty list:
/// - `isUnwired` — no closure at all (a tab built without wiring);
/// - `isUnsupported` — the daemon answered `-32601`: it predates the RPC. Expected, not an error;
/// - `errorText` — a real failure (socket, timeout, malformed reply), worth showing;
/// - loaded — whatever the daemon actually said, INCLUDING an empty list.
@MainActor
final class WinterCapabilitiesModel: ObservableObject {
    typealias Lister = () async throws -> [WinterCapability]

    private let lister: Lister?

    @Published private(set) var capabilities: [WinterCapability] = []
    @Published private(set) var loading = false
    @Published private(set) var hasLoaded = false
    /// Latched by the ONE error code that means "this daemon is older than this app".
    @Published private(set) var isUnsupported = false
    @Published var errorText: String?

    var isUnwired: Bool { lister == nil }
    /// True when the section must fall back to the shape-only key list rather than data.
    var showsShapeOnly: Bool { isUnwired || isUnsupported }

    init(lister: Lister? = nil) {
        self.lister = lister
    }

    /// Safe on appear: `capabilities.list` takes no params and starts nothing (unlike `mcp.list`
    /// with a cwd — see caveat 1 in the file header).
    func refresh() async {
        guard let lister else { return }
        loading = true
        defer { loading = false }
        do {
            capabilities = try await lister()
            errorText = nil
            isUnsupported = false
            hasLoaded = true
        } catch {
            if isMethodNotFoundError(error) {
                // NOT an error path: the daemon simply does not have the method. Clear any stale
                // message and let the section render its pre-RPC copy.
                isUnsupported = true
                errorText = nil
                capabilities = []
                return
            }
            // Same stale-list posture as `McpToolsModel`: a transient failure never blanks a panel
            // someone is reading. `"\(error)"` rather than `localizedDescription`, which renders
            // Foundation's "operation couldn't be completed" for a plain `RpcError`.
            errorText = shellPanelErrorText("Couldn't read the MCP servers", detail: "\(error)")
        }
    }
}

// MARK: - The tab

/// The group header's status word when a refresh FAILED but the rows from the last good read are
/// still on screen. This is STATE, not commentary: the red error line says the read failed, and only
/// this says the rows beneath it are old. Empty (no detail) otherwise.
let libraryStaleListText = "Last good read"

/// PURE: the header detail for a list that may be showing stale rows.
func libraryStaleListDetail(failed: Bool, hasRows: Bool) -> String {
    failed && hasRows ? libraryStaleListText : ""
}

/// PURE: an external server row's one-line summary.
func libraryMcpServerSubtitle(_ server: McpServerRow) -> String {
    "\(server.toolNames.count) tool\(server.toolNames.count == 1 ? "" : "s") · \(mcpSourceBadge(server.source))"
}

// MARK: - The list

/// Two sections, kept visibly apart — **External servers** (`server.rack`, grouped by source) and
/// **Winter's own tools** (`sparkles`) — because the two are different namespaces that fail
/// independently. Each row is a door to that server's tools.
///
/// The models are OWNED BY THE PANEL (`LibraryPanel`), not by this view: the detail page replaces
/// this list entirely and reads the same models, so a tab-owned `@StateObject` would die on every
/// drill-in and reload from scratch on every back.
struct LibraryMcpList: View {
    @ObservedObject var model: McpToolsModel
    @ObservedObject var capabilities: WinterCapabilitiesModel
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    var body: some View {
        LibraryListPage(title: "MCP tools") {
            Button("Refresh") {
                Task { await model.refresh() }
                Task { await capabilities.refresh() }
            }
            // Enabled while EITHER half can still be asked — the two sections fail
            // independently and one dead half must not lock the other's refresh.
            .disabled((model.isUnwired || model.loading)
                      && (capabilities.showsShapeOnly || capabilities.loading))
        } content: {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    externalSection
                    Divider()
                    winterSection
                }
                .padding(.vertical, 2)
            }
        }
        // Both reads are safe on appear: the MCP read passes NO cwd (caveat 1 — a cwd spawns), and
        // `capabilities.list` takes no params and starts nothing.
        .task { await model.refresh() }
        .task { await capabilities.refresh() }
    }

    // MARK: External servers

    @ViewBuilder
    private var externalSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "External servers",
                               detail: libraryStaleListDetail(
                                   failed: model.errorText != nil && !model.isUnwired,
                                   hasRows: !model.servers.isEmpty))
            if model.isUnwired {
                LibraryPendingNote(
                    subject: "MCP servers you or a project or a plugin configured, and the tools "
                        + "each one exposes.",
                    waitingOn: "The daemon serves these over mcp.list today — waiting on a door "
                        + "from this panel to that call (DashboardWiring carries none yet)."
                )
            } else {
                if let errorText = model.errorText {
                    LibraryErrorLine(text: errorText)
                }
                if model.servers.isEmpty {
                    LibraryStateLine(text: model.hasLoaded
                                     ? "No external MCP servers are configured."
                                     : "Loading…")
                } else {
                    ForEach(mcpServersGroupedBySource(model.servers), id: \.source) { group in
                        VStack(alignment: .leading, spacing: 1) {
                            LibraryGroupHeader(title: mcpSourceBadge(group.source))
                            ForEach(group.servers) { server in
                                let ref = LibraryItemRef.mcpServer(name: server.name)
                                LibraryLinkRow(
                                    systemImage: "server.rack",
                                    title: server.name,
                                    subtitle: libraryMcpServerSubtitle(server),
                                    isSelected: selected == ref,
                                    action: { onOpen(ref) }
                                ) {
                                    LibraryRowBadge(text: server.status)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Winter's own capability servers

    @ViewBuilder
    private var winterSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "Winter's own tools",
                               detail: libraryStaleListDetail(
                                   failed: !capabilities.showsShapeOnly
                                       && capabilities.errorText != nil,
                                   hasRows: !capabilities.capabilities.isEmpty))
            if capabilities.showsShapeOnly {
                shapeOnlyCapabilities
            } else {
                liveCapabilities
            }
        }
    }

    /// The pre-RPC rendering, for a daemon that predates `capabilities.list` (or no door). Rows are
    /// NOT doors here — there is no data behind them to drill into — and they stay quiet and
    /// unbadged so they cannot be mistaken for a live inventory.
    @ViewBuilder
    private var shapeOnlyCapabilities: some View {
        LibraryPendingNote(
            subject: "The capability servers the daemon runs in-process and hands the model "
                + "— sessions, the computer, the browser, office, research, the web, LSP, and "
                + "anything a plugin contributes.",
            waitingOn: capabilities.isUnwired
                ? "These are not in mcp.list at all — this panel has no door to capabilities.list."
                : "These are not in mcp.list at all, and this daemon does not answer "
                    + "capabilities.list yet."
        )
        ForEach(winterCapabilityKeysKnownToday, id: \.self) { key in
            LibraryRow(
                systemImage: "sparkles",
                title: key,
                subtitle: winterCapabilityWireName(key: key),
                subtitleIsMono: true
            )
        }
    }

    @ViewBuilder
    private var liveCapabilities: some View {
        if let errorText = capabilities.errorText {
            LibraryErrorLine(text: errorText)
        }
        if capabilities.capabilities.isEmpty {
            LibraryStateLine(text: capabilities.hasLoaded
                             ? "The daemon reports no capability servers."
                             : "Loading…")
        } else {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(capabilities.capabilities, id: \.key) { capability in
                    let ref = LibraryItemRef.winterCapability(key: capability.key)
                    LibraryLinkRow(
                        systemImage: "sparkles",
                        title: capability.key,
                        subtitle: winterCapabilitySubtitle(capability),
                        isSelected: selected == ref,
                        action: { onOpen(ref) }
                    ) {
                        if let badge = winterCapabilityBadge(capability) {
                            LibraryRowBadge(text: badge)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - The details

/// One external server's tools: the BARE name (what the server calls it) as the title, the
/// qualified `mcp__<server>__<tool>` (what the model calls and a transcript shows) under it.
struct LibraryMcpServerDetail: View {
    @ObservedObject var model: McpToolsModel
    let name: String
    let onBack: () -> Void
    let onVanished: () -> Void

    private var server: McpServerRow? { model.servers.first { $0.name == name } }

    var body: some View {
        LibraryDetailPage(
            title: name,
            subtitle: server.map { "External server · \(mcpSourceBadge($0.source))" } ?? "External server",
            backLabel: "Back to MCP tools",
            onBack: onBack
        ) {
            if let server { LibraryRowBadge(text: server.status) }
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if let server {
                if server.toolNames.isEmpty {
                    LibraryStateLine(text: "This server reports no tools.")
                } else {
                    LibraryGroupHeader(title: "Tools", detail: "\(server.toolNames.count)")
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(server.toolNames, id: \.self) { tool in
                            LibraryRow(
                                systemImage: "wrench",
                                title: tool,
                                subtitle: mcpWireToolName(server: server.name, tool: tool),
                                subtitleIsMono: true
                            )
                        }
                    }
                }
            } else {
                LibraryStateLine(text: "Loading…")
            }
        }
        .onChange(of: model.servers.map(\.name)) { _, names in
            if !names.contains(name) { onVanished() }
        }
    }
}

/// One of Winter's own capability servers: its tools, each with what it is withheld from or
/// deferred in. The wire already qualifies these names (`mcp__winter__<key>__<tool>`) — nothing is
/// reassembled here.
struct LibraryWinterCapabilityDetail: View {
    @ObservedObject var capabilities: WinterCapabilitiesModel
    let key: String
    let onBack: () -> Void
    let onVanished: () -> Void

    private var capability: WinterCapability? {
        capabilities.capabilities.first { $0.key == key }
    }

    var body: some View {
        LibraryDetailPage(
            title: key,
            subtitle: "Winter's own tools · \(winterCapabilityWireName(key: key))",
            backLabel: "Back to MCP tools",
            onBack: onBack
        ) {
            if let capability, let badge = winterCapabilityBadge(capability) {
                LibraryRowBadge(text: badge)
            }
        } content: {
            if let errorText = capabilities.errorText {
                LibraryErrorLine(text: errorText)
            }
            if let capability {
                if !capability.enabled {
                    LibraryStateLine(text: "The daemon cannot serve this capability right now.")
                }
                if capability.tools.isEmpty {
                    LibraryStateLine(text: winterCapabilitySubtitle(capability))
                } else {
                    LibraryGroupHeader(title: "Tools", detail: "\(capability.tools.count)")
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(capability.tools, id: \.name) { tool in
                            LibraryRow(
                                systemImage: "wrench",
                                title: tool.name,
                                subtitle: winterCapabilityToolSubtitle(tool)
                            )
                        }
                    }
                }
            } else {
                LibraryStateLine(text: "Loading…")
            }
        }
        .onChange(of: capabilities.capabilities.map(\.key)) { _, keys in
            if !keys.contains(key) { onVanished() }
        }
    }
}
