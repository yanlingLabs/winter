import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// WS-26 — CONNECTOR PERMISSIONS on an external server's detail page (Library → MCP tools → a server).
//
// Per action, a three-way control — Always allow / Always ask / Always deny — valid in EVERY mode (code,
// chat and dispatch alike; the daemon enforces it, `core/src/agent/mcp/connector-permissions.ts`), plus a
// per-server "All actions" control. An action with nothing stored shows the DEFAULT as a quiet outline on
// the segment it resolves to: an action its server marks read-only runs without asking, anything else
// asks first (in code sessions an unset action keeps following the session's approval policy, which the
// caption says). Clicking the segment that is already stored clears it back to the default — the one
// gesture, so there is no fourth "Default" segment to crowd the row.
//
// The rows come from `mcp.tools` (the daemon's probe), never from `mcp.list`'s bare `toolNames`, because
// only the former carries the read-only mark and what applies. A server that needs a sign-in shows no
// action list — the page's sign-in section above is the whole story until it is signed in. A daemon that
// predates `mcp.tools` (`-32601`) or an app with no door keeps the plain tool list this page had before.
//
// Custom chrome, not a stock `Picker(.segmented)`: the segment is drawn like the composer's own
// `ComposerModeSegment` (`AppShell/ComposerChrome.swift`), so the Library reads as the same app.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure helpers

/// The segment labels, in display order.
let mcpPermissionOrder: [McpToolPermission] = [.allow, .ask, .deny]

/// PURE: a segment's short label.
func mcpPermissionShortLabel(_ p: McpToolPermission) -> String {
    switch p {
    case .allow: return "Allow"
    case .ask: return "Ask"
    case .deny: return "Deny"
    }
}

/// PURE: the full name of a stored value, as the settings page and the CLI both say it.
func mcpPermissionLabel(_ p: McpToolPermission) -> String {
    switch p {
    case .allow: return "Always allow"
    case .ask: return "Always ask"
    case .deny: return "Always deny"
    }
}

/// PURE: what a tap on `tapped` stores, given what is stored now — the SAME segment again clears it to
/// the default (`nil`); any other segment stores that one.
func mcpPermissionAfterTap(current: McpToolPermission?, tapped: McpToolPermission) -> McpToolPermission? {
    current == tapped ? nil : tapped
}

/// PURE: the row's caption — what applies and why. A `"rule"` (a deny rule in `sdk/settings.json`) is
/// named, because no setting on this page can undo it.
func mcpToolPermissionCaption(_ row: McpToolPermissionRow) -> String {
    switch row.source {
    case "tool":
        return "\(mcpPermissionLabel(row.permission)) — set for this action"
    case "server":
        return "\(mcpPermissionLabel(row.permission)) — from All actions"
    case "rule":
        let rule = row.rules.first { $0.behavior == .deny }?.rule ?? "a deny rule"
        return "Denied by \(rule) in sdk/settings.json — it applies in every mode"
    default:
        return row.readOnly
            ? "Default: runs without asking — the server marks it read-only"
            : "Default: asks first — code sessions follow their approval policy"
    }
}

/// PURE: the `sdk/settings.json` allow/ask rules that also name this action. They bind in CODE sessions
/// only (the router strips both from chat and dispatch), and a stored Always ask / Always deny outranks
/// an allow rule — so they are noted, never presented as what applies.
func mcpToolRuleNotes(_ row: McpToolPermissionRow) -> [String] {
    row.rules.filter { $0.behavior != .deny }.map { "\($0.behavior.rawValue) rule \($0.rule) in sdk/settings.json — code sessions only" }
}

/// PURE: whether the page must hide the action list and leave the sign-in section to speak for the
/// server — a server that needs a sign-in has no listing worth showing, and no action to set yet.
func mcpPermissionsNeedSignIn(status: String?, auth: String?) -> Bool {
    status == "needs-auth" || auth == "needs-auth"
}

// MARK: - The model

/// One server's connector permissions. Owned by `LibraryMcpServerDetail` (per server — a write in flight
/// has no reason to outlive the page it was made on).
///
/// FOUR states, kept apart as `WinterCapabilitiesModel` keeps its own: `isUnwired` (no door), `isUnsupported`
/// (`-32601`: the daemon predates `mcp.tools` — the page keeps its plain tool list), `errorText` (a real
/// failure; the last good rows stay on screen) and loaded.
@MainActor
final class McpToolPermissionsModel: ObservableObject {
    let serverName: String
    private let client: McpPermissionsClient?

    @Published private(set) var server: McpToolsServer?
    @Published private(set) var loading = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var isUnsupported = false
    @Published var errorText: String?
    /// Tool names (`"*"` for All actions) with a write in flight — their segments are disabled.
    @Published private(set) var pending: Set<String> = []

    var isUnwired: Bool { client == nil }
    /// The page falls back to its pre-WS-26 plain tool list.
    var showsPlainList: Bool { isUnwired || isUnsupported }

    init(serverName: String, client: McpPermissionsClient?) {
        self.serverName = serverName
        self.client = client
    }

    func refresh() async {
        guard let client else { return }
        loading = true
        defer { loading = false }
        do {
            server = try await client.tools(server: serverName)
            errorText = nil
            isUnsupported = false
            hasLoaded = true
        } catch {
            if isMethodNotFoundError(error) {
                isUnsupported = true
                errorText = nil
                server = nil
                return
            }
            errorText = shellPanelErrorText("Couldn't read this server's actions", detail: "\(error)")
        }
    }

    /// A tap on one action's segment: store it, or clear it when it was already stored.
    func tap(tool: String, _ tapped: McpToolPermission) async {
        let current = server?.tools.first { $0.name == tool }?.setting
        await write(tool: tool, mcpPermissionAfterTap(current: current, tapped: tapped), resetTools: false)
    }

    /// A tap on All actions. Storing a value sets EVERY action (per-action choices are cleared — "All
    /// actions → Always deny" must mean every action); tapping the stored one again clears only it.
    func tapAll(_ tapped: McpToolPermission) async {
        let next = mcpPermissionAfterTap(current: server?.allTools, tapped: tapped)
        await write(tool: "*", next, resetTools: next != nil)
    }

    private func write(tool: String, _ permission: McpToolPermission?, resetTools: Bool) async {
        guard let client, !pending.contains(tool) else { return }
        pending.insert(tool)
        defer { pending.remove(tool) }
        do {
            try await client.setToolPermission(server: serverName, tool: tool, permission: permission, resetTools: resetTools)
            errorText = nil
        } catch {
            errorText = shellPanelErrorText("Couldn't save that permission", detail: "\(error)")
        }
        // Re-read either way: what applies is the daemon's answer, never this page's guess.
        await refresh()
    }
}

// MARK: - The segment

/// Allow / Ask / Deny, drawn like `ComposerModeSegment`. `selected` is the STORED value (filled);
/// `effective` is what applies when nothing is stored (outlined, quieter) — so the default is visible
/// without looking like a choice the user made.
struct McpPermissionSegment: View {
    let selected: McpToolPermission?
    let effective: McpToolPermission?
    var disabled: Bool = false
    let accessibilitySubject: String
    let onTap: (McpToolPermission) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(mcpPermissionOrder, id: \.self) { option in
                let isSelected = option == selected
                let isDefault = selected == nil && option == effective
                Button {
                    onTap(option)
                } label: {
                    Text(mcpPermissionShortLabel(option))
                        .font(Typography.caption(isSelected ? .medium : .regular))
                        .foregroundStyle(isSelected ? AnyShapeStyle(.primary) : AnyShapeStyle(Theme.textMuted))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isSelected ? AnyShapeStyle(Theme.composerSurface) : AnyShapeStyle(Color.clear))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(isDefault ? Theme.textMuted.opacity(0.45) : Color.clear,
                                      style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                )
                .help(isSelected
                      ? "\(mcpPermissionLabel(option)) — click again to use the default"
                      : isDefault ? "The default — click to store \(mcpPermissionLabel(option))" : mcpPermissionLabel(option))
                .accessibilityLabel("\(mcpPermissionLabel(option)) for \(accessibilitySubject)")
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.controlSurface))
        .disabled(disabled)
        .opacity(disabled ? 0.55 : 1)
    }
}

// MARK: - The section

/// The permissions half of `LibraryMcpServerDetail`: All actions, then each action with its segment.
struct McpToolPermissionsSection: View {
    @ObservedObject var model: McpToolPermissionsModel

    var body: some View {
        if let errorText = model.errorText {
            LibraryErrorLine(text: errorText)
        }
        if let server = model.server {
            LibraryGroupHeader(title: "Permissions", detail: "Every mode")
            allActionsRow(server)
            if server.tools.isEmpty {
                LibraryStateLine(text: server.listed
                                 ? "This server reports no tools."
                                 : "No action list yet — the daemon has not listed this server's tools.")
            } else {
                LibraryGroupHeader(title: "Actions", detail: "\(server.tools.count)")
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(server.tools) { row in
                        actionRow(row)
                    }
                }
            }
        } else {
            LibraryStateLine(text: model.hasLoaded ? "The daemon reports nothing for this server." : "Loading…")
        }
    }

    private func allActionsRow(_ server: McpToolsServer) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "square.stack.3d.up")
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text("All actions")
                    .font(Typography.control())
                    .foregroundStyle(Theme.textPrimary)
                Text(server.allTools.map { "\(mcpPermissionLabel($0)) — choosing one clears every per-action choice" }
                     ?? "Choosing one sets every action of \(server.name) at once")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer(minLength: 8)
            McpPermissionSegment(selected: server.allTools, effective: nil,
                                 disabled: model.pending.contains("*"),
                                 accessibilitySubject: "every action of \(server.name)") { tapped in
                Task { await model.tapAll(tapped) }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func actionRow(_ row: McpToolPermissionRow) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: row.readOnly ? "eye" : "wrench")
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.name)
                        .font(Typography.control())
                        .foregroundStyle(Theme.textPrimary)
                    if row.readOnly { LibraryRowBadge(text: "read-only") }
                }
                Text(row.toolName)
                    .font(Typography.captionMono())
                    .foregroundStyle(Theme.textMuted)
                    .textSelection(.enabled)
                Text(mcpToolPermissionCaption(row))
                    .font(Typography.caption())
                    .foregroundStyle(row.source == "rule" ? AnyShapeStyle(.red) : AnyShapeStyle(Theme.textMuted))
                ForEach(mcpToolRuleNotes(row), id: \.self) { note in
                    Text(note)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                }
            }
            Spacer(minLength: 8)
            McpPermissionSegment(selected: row.setting,
                                 effective: row.setting == nil ? row.permission : nil,
                                 disabled: model.pending.contains(row.name) || model.pending.contains("*"),
                                 accessibilitySubject: row.name) { tapped in
                Task { await model.tap(tool: row.name, tapped) }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .help(row.description ?? "")
    }
}
