import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Library → MCP tools (2026-09-17; the Winter half wired 2026-09-18). Two sections, served by two
// different RPCs, and each one degrades on its own.
//
// **External servers** (`mcp.list`) — servers the user or a project or a plugin configured, each
// with `{name, status, toolNames, source}`. The RPC exists and `WinterClient.mcpList(cwd:)` wraps
// it; what does NOT exist is a door from the Library panel to a `WinterClient`. `LibraryPanel`
// receives a `DashboardWiring`, whose whole contract is "DATA or a CLOSURE, never a WinterClient",
// and no existing field can serve this call (every pane model holds its client `private`). Adding
// the closure is a two-line edit to `DashboardSurface.swift` + `AppDelegate.swift` — both owned by
// another session this cycle — so `McpToolsModel` takes the lister as an injected optional and is
// constructed with `nil` here. `nil` renders an honest "no door yet" state; the future edit is
// `McpToolsModel(lister: wiring.mcpList)`.
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

struct LibraryMcpTab: View {
    @StateObject private var model: McpToolsModel
    @StateObject private var capabilities: WinterCapabilitiesModel

    /// `@StateObject` with an injected instance: the panel is torn down on close, so the model's
    /// life is the tab's, and `.task` re-seeds it on every open — the same re-seed-on-appear
    /// posture every Dashboard pane already has.
    ///
    /// `capabilities:` is DEFAULTED so the existing construction site
    /// (`ShellOverlays.swift`'s `LibraryMcpTab(lister: wiring.mcpList)`, a file this change does
    /// not own) keeps compiling and keeps rendering the pre-RPC section. Passing
    /// `wiring.capabilitiesList` there is the one edit that lights the Winter half up.
    init(lister: McpToolsModel.Lister? = nil,
         capabilities: WinterCapabilitiesModel.Lister? = nil) {
        _model = StateObject(wrappedValue: McpToolsModel(lister: lister))
        _capabilities = StateObject(wrappedValue: WinterCapabilitiesModel(lister: capabilities))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: libraryDetailSpacing) {
            LibraryTabHeader(title: "MCP tools") {
                Button("Refresh") {
                    Task { await model.refresh() }
                    Task { await capabilities.refresh() }
                }
                // Enabled while EITHER half can still be asked — the two sections fail
                // independently and one dead half must not lock the other's refresh.
                .disabled((model.isUnwired || model.loading)
                          && (capabilities.showsShapeOnly || capabilities.loading))
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    externalSection
                    Divider()
                    winterSection
                }
                .padding(.vertical, 2)
            }
        }
        .padding(libraryDetailPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await model.refresh() }
        .task { await capabilities.refresh() }
    }

    // MARK: External servers — live the moment a lister is injected

    @ViewBuilder
    private var externalSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "External servers")
            if model.isUnwired {
                LibraryPendingNote(
                    subject: "MCP servers you or a project or a plugin configured, and the tools "
                        + "each one exposes.",
                    waitingOn: "The daemon serves these over mcp.list today — waiting on a door "
                        + "from this panel to that call (DashboardWiring carries none yet)."
                )
            } else if let errorText = model.errorText {
                Text(errorText)
                    .font(Typography.label())
                    .foregroundStyle(.red)
            }
            if model.errorText != nil, !model.isUnwired, !model.servers.isEmpty {
                // Stale-list disclosure: the rows below are from the last GOOD read, not from the
                // refresh that just failed above (whose message is already shown, once, in red).
                LibraryFootnote(text: "Showing the last successful read.")
            }
            if !model.isUnwired {
                if model.servers.isEmpty {
                    Text(model.hasLoaded
                         ? "No external MCP servers are configured."
                         : "Loading…")
                        .font(Typography.label())
                        .foregroundStyle(Theme.textSecondary)
                } else {
                    ForEach(mcpServersGroupedBySource(model.servers), id: \.source) { group in
                        VStack(alignment: .leading, spacing: 2) {
                            LibraryGroupHeader(title: mcpSourceBadge(group.source))
                            ForEach(group.servers) { server in
                                serverRows(server)
                            }
                        }
                    }
                }
            }
            LibraryFootnote(text: "This list never starts a server, so it shows your own servers "
                            + "and any a plugin contributes. A project's servers are not "
                            + "included — listing them would mean starting them.")
        }
    }

    @ViewBuilder
    private func serverRows(_ server: McpServerRow) -> some View {
        LibraryRow(
            systemImage: "server.rack",
            title: server.name,
            subtitle: "\(server.toolNames.count) tool\(server.toolNames.count == 1 ? "" : "s")"
        ) {
            LibraryRowBadge(text: server.status)
        }
        ForEach(server.toolNames, id: \.self) { tool in
            LibraryRow(
                systemImage: "wrench",
                title: tool,
                // The BARE name is what the server calls it; the qualified name is what the model
                // actually invokes and what a transcript shows. Both, always — see caveat 2.
                subtitle: mcpWireToolName(server: server.name, tool: tool),
                subtitleIsMono: true
            )
            .padding(.leading, 18)
        }
    }

    // MARK: Winter's own capability servers — capabilities.list

    @ViewBuilder
    private var winterSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            LibraryGroupHeader(title: "Winter's own tools")
            if capabilities.showsShapeOnly {
                shapeOnlyCapabilities
            } else {
                liveCapabilities
            }
        }
    }

    /// The pre-RPC rendering, reached on a daemon that predates `capabilities.list` (or a tab built
    /// with no closure). Identical to what this section always showed — the point is that an app
    /// ahead of its daemon looks exactly as it did before, never like a Winter with no tools.
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
        // Shape only. These keys are what the daemon registers today per CLAUDE.md's tool
        // surface; `external` is per-plugin and dynamic, so no hand-kept list here can be
        // right — which is the whole argument for the RPC. Rendered quiet and unbadged so it
        // cannot be mistaken for a live inventory.
        ForEach(winterCapabilityKeysKnownToday, id: \.self) { key in
            LibraryRow(
                systemImage: "sparkles",
                title: key,
                subtitle: winterCapabilityWireName(key: key),
                subtitleIsMono: true
            )
        }
        LibraryFootnote(text: "Known keys, not a live inventory — the tools inside each one "
                        + "are not listed until the daemon can report them.")
    }

    @ViewBuilder
    private var liveCapabilities: some View {
        if let errorText = capabilities.errorText {
            Text(errorText)
                .font(Typography.label())
                .foregroundStyle(.red)
            if !capabilities.capabilities.isEmpty {
                LibraryFootnote(text: "Showing the last successful read.")
            }
        }
        if capabilities.capabilities.isEmpty {
            Text(capabilities.hasLoaded
                 ? "The daemon reports no capability servers."
                 : "Loading…")
                .font(Typography.label())
                .foregroundStyle(Theme.textSecondary)
        } else {
            ForEach(capabilities.capabilities, id: \.key) { capability in
                capabilityRows(capability)
            }
            LibraryFootnote(text: "Every mode gets a different slice of these. A tool says where "
                            + "it is withheld and where the model has to go looking for it; "
                            + "\"off\" means the daemon cannot serve that capability right now.")
        }
    }

    @ViewBuilder
    private func capabilityRows(_ capability: WinterCapability) -> some View {
        LibraryRow(
            systemImage: "sparkles",
            title: capability.key,
            subtitle: winterCapabilitySubtitle(capability)
        ) {
            if let badge = winterCapabilityBadge(capability) {
                LibraryRowBadge(text: badge)
            }
        }
        ForEach(capability.tools, id: \.name) { tool in
            LibraryRow(
                systemImage: "wrench",
                // The wire already qualifies these (`mcp__winter__<key>__<tool>`) — unlike an
                // external server's bare `toolNames`, which this file has to reassemble. Nothing
                // is reconstructed here; this is the exact string a transcript shows.
                title: tool.name,
                subtitle: winterCapabilityToolSubtitle(tool)
            )
            .padding(.leading, 18)
        }
    }
}
