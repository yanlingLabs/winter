import SwiftUI

// -----------------------------------------------------------------------------------------------
// Library → Hooks (2026-09-17). LIVE against a daemon that reports the field (2026-09-18),
// still honest against one that does not.
//
// What a hook IS here: a plugin manifest's `contributes.hooks` entry — `{event, command,
// timeoutMs?}`, where `event` is one of four (`session-start`, `pre-tool`, `post-tool`,
// `turn-end`; `packages/core/src/agent/plugin-manifest.ts`). The daemon already parses these into
// `PluginInfo.manifestHooks` and already runs them (`runtime-sdk/hooks.ts` fires every plugin's
// pre/post-tool hook on both legs). They are NOT user-authored config files: a hook exists because
// a plugin declares it, which is why this tab is organised by the plugin that declares it rather
// than by the event.
//
// THE FIELD LANDED — on a daemon new enough to send it. `plugins.list` now carries an optional
// per-plugin `manifestHooks`, decoded by `WinterClient.pluginsList()` and threaded through
// `PluginManagerModel` → `PluginRowDisplay.manifestHooks`. `hooksByPlugin` reads it straight off
// `model.rows`; every group, row, sort and empty state below was already written for a populated
// one and is unchanged.
//
// THE ONE AMBIGUITY THIS TAB HAS TO RESOLVE, and the reason it is resolved ACROSS ROWS rather than
// per row: the wire OMITS `manifestHooks` for a plugin that declares no hook, and an older daemon
// omits it for EVERY plugin because its schema has no such field. One row therefore cannot tell
// "declares none" from "this daemon cannot tell you". The whole list can —
// `pluginHooksAreReported(rows:)` is true the moment ANY row carries the key — so:
//
//   - reported ⇒ the list is the plugins that declare hooks, and an empty one honestly says "No
//     installed plugin declares a hook";
//   - not reported ⇒ the list shows the pending note and NO empty-state sentence, rather than an
//     empty list that would read as "no plugin declares a hook".
//
// DRILL-IN (2026-09-18): the LIST is the plugins that declare hooks; a row opens that plugin's
// hooks (event, command, timeout) as a full-width DETAIL page, whose one action is a door to the
// plugin's own detail on the Plugins tab (a hook has no toggle of its own).
//
// Getting that backwards is the whole failure mode here: an app that shipped ahead of the daemon
// (a cask update, a daemon from before the field) would quietly tell the user their plugins run no
// hooks, which is exactly the opposite of the truth.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure model + display helpers

/// One manifest-declared hook, mirroring the daemon's own `{event, command, timeoutMs?}` exactly.
/// Deliberately NOT an enum over the four events: the wire is a closed zod enum today, but a
/// client that hard-fails on a fifth event the daemon adds tomorrow is worse than one that shows
/// its raw name — same permissive-decode posture `WinterClient+Methods.swift` takes everywhere.
struct PluginHookDeclaration: Equatable, Identifiable {
    /// The raw wire value (`"pre-tool"`, …) — the display name is derived, never stored.
    let event: String
    /// The shell command the daemon runs. Shown monospaced and selectable: a user debugging why a
    /// hook fired needs to copy this verbatim.
    let command: String
    /// Optional on the wire — a plugin need not set one.
    let timeoutMs: Int?
    /// This declaration's position in its plugin's manifest list. Carried ONLY to make `id` unique:
    /// duplicates survive the wire as separate entries (the daemon accepts a manifest that binds
    /// the same command to the same event twice, and runs it twice), so an id built from the three
    /// content fields alone collides — and a `ForEach` over colliding ids drops rows, which would
    /// silently under-report what actually runs.
    let manifestIndex: Int

    var id: String { "\(manifestIndex)\u{1F}\(event)\u{1F}\(command)\u{1F}\(timeoutMs.map(String.init) ?? "-")" }
}

/// The four events' fixed display order — the order they FIRE in a session's life, which is the
/// only ordering a reader can predict. Alphabetical would interleave pre-tool and post-tool
/// nonsensically.
let pluginHookEventOrder: [String] = ["session-start", "pre-tool", "post-tool", "turn-end"]

/// PURE: the event's row title. A value outside the closed enum (a future daemon addition) falls
/// through to its raw wire name rather than being hidden or crashed on.
func hookEventTitle(_ event: String) -> String {
    switch event {
    case "session-start": return "Session start"
    case "pre-tool": return "Before every tool"
    case "post-tool": return "After every tool"
    case "turn-end": return "Turn end"
    default: return event
    }
}

/// PURE: the event's glyph. Unknown events get a neutral one — never a "broken" symbol, since an
/// unrecognised event is this client being old, not the plugin being wrong.
func hookEventSystemImage(_ event: String) -> String {
    switch event {
    case "session-start": return "play.circle"
    case "pre-tool": return "arrow.right.to.line"
    case "post-tool": return "arrow.left.to.line"
    case "turn-end": return "stop.circle"
    default: return "circle"
    }
}

/// PURE: the trailing timeout badge's text. Absent means the daemon's own default applies, which
/// is a different fact from "0 ms" and must not render as one.
func hookTimeoutText(_ timeoutMs: Int?) -> String {
    guard let timeoutMs else { return "default timeout" }
    if timeoutMs >= 1000, timeoutMs % 1000 == 0 { return "\(timeoutMs / 1000)s" }
    return "\(timeoutMs)ms"
}

/// PURE: does this daemon report manifest hooks at all?
///
/// TRUE the moment ANY row carries the key — including a row carrying an EMPTY array, which is a
/// daemon saying "this plugin declares none". False for an empty list too: a Winter with no plugins
/// installed has told us nothing either way, and the tab's own "nothing can declare a hook" empty
/// state is what answers that case, not this flag.
func pluginHooksAreReported(rows: [PluginRowDisplay]) -> Bool {
    rows.contains { $0.manifestHooks != nil }
}

/// PURE: the `[pluginName: hooks]` dictionary `hooksGroupedByPlugin` consumes, read off the live
/// plugin rows. A row that reported nothing is OMITTED rather than mapped to `[]`, so the group
/// builder's own "this plugin declares none" state stays reachable only when it is true.
func pluginHooksByPlugin(rows: [PluginRowDisplay]) -> [String: [PluginHookDeclaration]] {
    var out: [String: [PluginHookDeclaration]] = [:]
    for row in rows {
        if let hooks = row.manifestHooks { out[row.name] = hooks }
    }
    return out
}

/// One plugin and the hooks it declares — the tab's row group.
struct LibraryHookGroup: Equatable, Identifiable {
    var id: String { pluginName }
    let pluginName: String
    /// The plugin's live status word (`PluginRowDisplay.statusText`), or empty when this group came
    /// from a hook declaration with no matching plugin row.
    let statusText: String
    /// Whether the plugin is currently enabled — the ONE toggle that governs these hooks.
    let isEnabled: Bool
    /// Sorted by `pluginHookEventOrder`; empty means "this plugin declares none", which is only
    /// distinguishable from "we were not told" by the tab's own pending state.
    let hooks: [PluginHookDeclaration]
}

/// PURE: fold the live plugin list and the (not yet delivered) hook declarations into the tab's
/// groups.
///
/// Order is `rows`' own order — `plugins.list`'s — so the Hooks tab and the Plugins tab list the
/// same plugins in the same sequence. A hook dictionary key with NO matching plugin row is still
/// emitted, appended alphabetically at the end: that combination means the plugin list and the
/// hook source disagree, and silently dropping the hooks would hide exactly the inconsistency a
/// user needs to see.
///
/// Within a plugin, hooks sort by `pluginHookEventOrder` (fire order), then by command, so two
/// renders of the same manifest are identical. An event outside the known four sorts last, keeping
/// its relative order among its peers.
func hooksGroupedByPlugin(
    rows: [PluginRowDisplay],
    hooks: [String: [PluginHookDeclaration]]
) -> [LibraryHookGroup] {
    func sorted(_ declarations: [PluginHookDeclaration]) -> [PluginHookDeclaration] {
        declarations.enumerated().sorted { lhs, rhs in
            let lhsRank = pluginHookEventOrder.firstIndex(of: lhs.element.event) ?? pluginHookEventOrder.count
            let rhsRank = pluginHookEventOrder.firstIndex(of: rhs.element.event) ?? pluginHookEventOrder.count
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            if lhs.element.command != rhs.element.command { return lhs.element.command < rhs.element.command }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    var groups: [LibraryHookGroup] = rows.map { row in
        LibraryHookGroup(
            pluginName: row.name,
            statusText: row.statusText,
            // `pluginRowDisplay` renders a disabled plugin's status as exactly "Disabled" (it is
            // checked ahead of every runtime state), which is the one cross-check available to a
            // client that never sees the raw `disabled` flag.
            isEnabled: row.statusText != "Disabled",
            hooks: sorted(hooks[row.name] ?? [])
        )
    }
    let known = Set(rows.map(\.name))
    for orphan in hooks.keys.filter({ !known.contains($0) }).sorted() {
        groups.append(LibraryHookGroup(pluginName: orphan, statusText: "", isEnabled: false,
                                       hooks: sorted(hooks[orphan] ?? [])))
    }
    return groups
}

// MARK: - Drill-in helpers (2026-09-18)

/// PURE: the Hooks LIST — the plugins that DECLARE hooks, in `plugins.list` order.
///
/// A plugin reported as declaring none is not a row: the tab is about hooks, and a list of plugins
/// each saying "declares no hooks" is noise around the ones that matter. A plugin whose hooks were
/// NOT reported (an older daemon) is not a row either — there is nothing to drill into, and the
/// tab's pending note already says the daemon cannot tell us.
func libraryHookListGroups(_ groups: [LibraryHookGroup]) -> [LibraryHookGroup] {
    groups.filter { !$0.hooks.isEmpty }
}

/// PURE: a hook group row's one-line summary — how many hooks, and whether they run at all.
func libraryHookGroupSubtitle(_ group: LibraryHookGroup) -> String {
    let count = "\(group.hooks.count) hook\(group.hooks.count == 1 ? "" : "s")"
    if group.statusText.isEmpty { return "\(count) · plugin not installed" }
    return group.isEnabled ? count : "\(count) · plugin off, none run"
}

/// PURE: the LIST page's empty-state sentence, or nil when there are rows to show. Three different
/// facts, three different sentences — and the one that must never appear is "no plugin declares a
/// hook" on a daemon that simply did not say.
func libraryHookListEmptyText(rows: [PluginRowDisplay], reported: Bool,
                              listGroups: [LibraryHookGroup]) -> String? {
    guard listGroups.isEmpty else { return nil }
    if rows.isEmpty { return "No plugins are installed, so nothing can declare a hook." }
    if reported { return "No installed plugin declares a hook." }
    // Not reported: the pending note above the list is the whole answer.
    return nil
}

// MARK: - The list

struct LibraryHooksList: View {
    /// The live plugin list — the same instance the Plugins tab and the Dashboard's Plugins pane
    /// observe. This tab only READS it and calls `refresh()`; every mutation is the Plugins tab's.
    @ObservedObject var model: PluginManagerModel
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    /// The one cross-row question (see the file header): can this daemon tell us about hooks at
    /// all? Everything the tab says about an EMPTY hook list hangs off it.
    private var hooksAreReported: Bool { pluginHooksAreReported(rows: model.rows) }

    private var groups: [LibraryHookGroup] {
        libraryHookListGroups(hooksGroupedByPlugin(rows: model.rows,
                                                   hooks: pluginHooksByPlugin(rows: model.rows)))
    }

    var body: some View {
        LibraryListPage(title: "Hooks") {
            Button("Refresh") { Task { await model.refresh() } }
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if !hooksAreReported && !model.rows.isEmpty {
                // Reached for exactly one reason: a daemon older than `manifestHooks`. Never an
                // error — an app ahead of its daemon is an ordinary state. Suppressed with NO
                // plugins at all, where the empty line below is the complete answer.
                LibraryPendingNote(
                    subject: "Commands an installed plugin runs at session start, around every tool "
                        + "call, and at the end of a turn.",
                    waitingOn: "The daemon already parses and runs these, but this one's "
                        + "plugins.list does not report manifestHooks yet."
                )
            }
            if let empty = libraryHookListEmptyText(rows: model.rows, reported: hooksAreReported,
                                                    listGroups: groups) {
                LibraryStateLine(text: empty)
            } else if !groups.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(groups) { group in
                            let ref = LibraryItemRef.hooks(pluginName: group.pluginName)
                            LibraryLinkRow(
                                systemImage: "point.3.connected.trianglepath.dotted",
                                title: group.pluginName,
                                subtitle: libraryHookGroupSubtitle(group),
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

/// One plugin's hooks: event, command, timeout — in the order they fire.
struct LibraryHooksDetail: View {
    @ObservedObject var model: PluginManagerModel
    let pluginName: String
    let onBack: () -> Void
    /// A hook has no toggle of its own — the declaring plugin's enable/disable is the only control —
    /// so the page's one action is a door to that plugin's own detail.
    let onOpenPlugin: () -> Void
    let onVanished: () -> Void

    private var group: LibraryHookGroup? {
        hooksGroupedByPlugin(rows: model.rows, hooks: pluginHooksByPlugin(rows: model.rows))
            .first { $0.pluginName == pluginName }
    }

    var body: some View {
        LibraryDetailPage(
            title: pluginName,
            subtitle: group.map(libraryHookGroupSubtitle) ?? "Hooks",
            backLabel: "Back to Hooks",
            onBack: onBack
        ) {
            Button("Open plugin", action: onOpenPlugin)
                .font(Typography.label())
        } content: {
            if let errorText = model.errorText {
                LibraryErrorLine(text: errorText)
            }
            if let group {
                if !group.isEnabled {
                    LibraryStateLine(text: "This plugin is off, so none of these hooks run.")
                }
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(group.hooks) { hook in
                        LibraryRow(
                            systemImage: hookEventSystemImage(hook.event),
                            title: hookEventTitle(hook.event),
                            subtitle: hook.command,
                            subtitleIsMono: true
                        ) {
                            LibraryRowBadge(text: hookTimeoutText(hook.timeoutMs))
                        }
                    }
                }
            } else {
                LibraryStateLine(text: "Loading…")
            }
        }
        // The plugin was removed, or a refresh reports it declares none now.
        .onChange(of: group?.hooks.isEmpty ?? true) { _, gone in
            if gone { onVanished() }
        }
    }
}
