import SwiftUI
import WinterKit

// -----------------------------------------------------------------------------------------------
// Library → Hooks (2026-09-17; WS-21 retirement 2026-09-23; fix round 1 2026-09-24 — REAL again).
//
// `plugin.list` carries a per-plugin `hooks` field again (fix round 1's daemon contract change,
// `PluginListing.hooks`/`PluginHookEntry`, `WinterKit`) — filled from each plugin's own
// `hooks/hooks.json` plus its manifest, capped at 100 entries and 500 characters per command. This
// is a DIFFERENT shape from the pre-WS-21 `manifestHooks` it replaces: PER-ROW rather than a
// whole-list "reported vs not" signal — `nil` on one row (daemon couldn't read THAT plugin's
// hooks) says nothing about any other row, so there is no cross-row ambiguity left to resolve.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure display helpers (shared with `LibraryPluginsTab.swift`'s own hooks section)

/// PURE: the sentence for a plugin whose hooks are NOT a list to render — `nil` (the daemon
/// couldn't read/build them, e.g. a malformed `hooks.json`) and `[]` (read cleanly: none declared)
/// get DIFFERENT sentences, never collapsed into one. `nil` for an actual non-empty list — the
/// caller renders that as rows instead.
func libraryHooksEmptyText(_ hooks: [PluginHookEntry]?) -> String? {
    guard let hooks else { return "Couldn't read this plugin's hooks." }
    return hooks.isEmpty ? "No hooks declared." : nil
}

/// PURE: the Hooks LIST row's one-line subtitle for one plugin.
func libraryHooksListSubtitle(_ hooks: [PluginHookEntry]?) -> String {
    if let empty = libraryHooksEmptyText(hooks) { return empty }
    let count = hooks?.count ?? 0
    return "\(count) hook\(count == 1 ? "" : "s")"
}

/// PURE (fix round 3): replaces control characters and bidirectional text overrides/isolates
/// (U+202A–U+202E — LRE/RLE/PDF/LRO/RLO — and U+2066–U+2069, the isolate family) with a visible
/// `\u{XXXX}` escape, in every hook field this file renders. A plugin's `event`/`matcher`/`type`/
/// `command` are attacker-controllable strings from `hooks.json` — an embedded RLO could redraw
/// `evil.sh` as `hs.live`, or a stray newline/tab could break the `.lineLimit(1)` truncation this
/// row depends on to stay one line — so every one of them is sanitized before it reaches either the
/// truncated summary or the full-text tooltip, never just one of the two.
func librarySanitizedHookField(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count)
    for scalar in s.unicodeScalars {
        switch scalar.value {
        case 0x00...0x1F, 0x7F, 0x202A...0x202E, 0x2066...0x2069:
            out += "\\u{\(String(scalar.value, radix: 16))}"
        default:
            out.unicodeScalars.append(scalar)
        }
    }
    return out
}

/// PURE (fix round 3): a hook's `event`/`type`, sanitized, or `"(unnamed)"` when the daemon
/// couldn't supply one — `PluginHookEntry.event`/`.type` are optional now precisely so a malformed
/// entry is shown rather than silently dropped (see `WinterClient+Methods.swift`'s own doc on
/// `decodePluginHooks`); this is where that entry gets a readable label instead of a missing one.
private func libraryHookFieldOrUnnamed(_ s: String?) -> String {
    guard let s, !s.isEmpty else { return "(unnamed)" }
    return librarySanitizedHookField(s)
}

/// PURE: one hook's compact, one-line summary — the view truncates it with `.lineLimit(1)`; the
/// full text (`libraryHookFullText`) is what the row's tooltip shows.
func libraryHookSummaryLine(_ hook: PluginHookEntry) -> String {
    var line = libraryHookFieldOrUnnamed(hook.event)
    if let matcher = hook.matcher, !matcher.isEmpty { line += " (\(librarySanitizedHookField(matcher)))" }
    if let command = hook.command, !command.isEmpty {
        line += ": \(librarySanitizedHookField(command))"
    } else {
        line += " — \(libraryHookFieldOrUnnamed(hook.type))"
    }
    return line
}

/// PURE: one hook's full text, every field on its own line — for the tooltip a truncated summary
/// line needs.
func libraryHookFullText(_ hook: PluginHookEntry) -> String {
    var lines = ["event: \(libraryHookFieldOrUnnamed(hook.event))"]
    if let matcher = hook.matcher, !matcher.isEmpty { lines.append("matcher: \(librarySanitizedHookField(matcher))") }
    lines.append("type: \(libraryHookFieldOrUnnamed(hook.type))")
    if let command = hook.command, !command.isEmpty { lines.append("command: \(librarySanitizedHookField(command))") }
    return lines.joined(separator: "\n")
}

/// One hook, monospaced and truncated to a single line with the full text as a tooltip — shared by
/// the Hooks tab's own detail page and `LibraryPluginsTab.swift`'s plugin-detail hooks section
/// (fix round 1, I3: "show the hooks on the plugin detail page too").
func libraryHookRow(_ hook: PluginHookEntry) -> some View {
    Text(libraryHookSummaryLine(hook))
        .font(Typography.labelMono())
        .foregroundStyle(Theme.textPrimary)
        .lineLimit(1)
        .truncationMode(.tail)
        .help(libraryHookFullText(hook))
}

// MARK: - The list

struct LibraryHooksList: View {
    @ObservedObject var model: PluginManagerModel
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    var body: some View {
        LibraryListPage(title: "Hooks") {
            Button("Refresh") { Task { await model.refresh() } }
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if model.rows.isEmpty {
                LibraryStateLine(text: "No plugins are installed, so nothing can declare a hook.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(model.rows) { row in
                            // Fix round 1 (M7): the QUALIFIED spec, not the bare id — this is what
                            // both this row's own detail page AND that detail's "Open plugin" door
                            // (`ShellOverlays.swift`) need to open the right `.plugin(name:)`.
                            let ref = LibraryItemRef.hooks(pluginName: row.spec)
                            LibraryLinkRow(
                                systemImage: "point.3.connected.trianglepath.dotted",
                                title: row.pluginId,
                                subtitle: libraryHooksListSubtitle(row.hooks),
                                isSelected: selected == ref,
                                action: { onOpen(ref) }
                            )
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .task { await model.refresh() }
    }
}

// MARK: - The detail

/// One plugin's hooks — event, matcher, command, in the daemon's own order.
struct LibraryHooksDetail: View {
    @ObservedObject var model: PluginManagerModel
    /// The qualified `"<id>@<marketplace>"` spec (fix round 1, M7) — `LibraryItemRef.hooks(
    /// pluginName:)`'s payload, the same identity `LibraryPluginDetail`'s own `spec` uses.
    let spec: String
    let onBack: () -> Void
    /// A hook has no toggle of its own — the declaring plugin's enable/disable is the only
    /// control — so the page's one action is a door to that plugin's own detail.
    let onOpenPlugin: () -> Void
    let onVanished: () -> Void

    private var row: PluginRowDisplay? { model.rows.first { $0.spec == spec } }

    var body: some View {
        LibraryDetailPage(
            title: row?.pluginId ?? spec,
            subtitle: "Hooks",
            backLabel: "Back to Hooks",
            onBack: onBack
        ) {
            Button("Open plugin", action: onOpenPlugin)
                .font(Typography.label())
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if let row {
                if let empty = libraryHooksEmptyText(row.hooks) {
                    LibraryStateLine(text: empty)
                } else if let hooks = row.hooks {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(hooks.enumerated()), id: \.offset) { _, hook in
                            libraryHookRow(hook)
                        }
                    }
                }
            } else {
                LibraryStateLine(text: "Loading…")
            }
        }
        .onChange(of: model.rows.map(\.spec)) { _, specs in
            if !specs.contains(spec) { onVanished() }
        }
    }
}
