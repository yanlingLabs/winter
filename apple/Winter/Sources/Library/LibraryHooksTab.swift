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
//   - reported ⇒ a hookless plugin says "Declares no hooks", which is a fact;
//   - not reported ⇒ the tab keeps its original pending note and per-row "not reported" line,
//     rather than an empty list that would read as "no plugin declares a hook".
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

// MARK: - The tab

struct LibraryHooksTab: View {
    /// The live plugin list — the same instance the Plugins tab and the Dashboard's Plugins pane
    /// observe. This tab only READS it (`rows`) and calls `refresh()`; every mutation stays on the
    /// Plugins tab, which is what `onOpenPlugins` sends the user to.
    @ObservedObject var model: PluginManagerModel
    /// Flips the panel to the Plugins tab. A hook has no toggle of its own — enabling or disabling
    /// the declaring plugin is the only control — so the honest affordance is a door to where that
    /// control actually lives, not a disabled switch here.
    let onOpenPlugins: () -> Void

    /// Read straight off the live plugin rows — `plugins.list`'s own `manifestHooks`, decoded by
    /// `WinterClient.pluginsList()`. Empty on a daemon that does not report the field, which
    /// `hooksAreReported` is what distinguishes from "every plugin declares none".
    private var hooksByPlugin: [String: [PluginHookDeclaration]] {
        pluginHooksByPlugin(rows: model.rows)
    }

    /// The one cross-row question (see the file header): can this daemon tell us about hooks at
    /// all? Everything the tab says about an EMPTY hook list hangs off it.
    private var hooksAreReported: Bool {
        pluginHooksAreReported(rows: model.rows)
    }

    private var groups: [LibraryHookGroup] {
        hooksGroupedByPlugin(rows: model.rows, hooks: hooksByPlugin)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: libraryDetailSpacing) {
            LibraryTabHeader(title: "Hooks") {
                Button("Refresh") { Task { await model.refresh() } }
            }
            if let errorText = model.errorText {
                Text(errorText)
                    .font(Typography.label())
                    .foregroundStyle(.red)
            }
            if hooksAreReported {
                Text("Commands an installed plugin runs at session start, around every tool call, "
                     + "and at the end of a turn.")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !model.rows.isEmpty {
                // UNCHANGED from the pre-field build, and reached for exactly one reason now: a
                // daemon older than `manifestHooks`. Never an error — an app ahead of its daemon is
                // an ordinary state, and the honest thing to say is that we were not told.
                //
                // Suppressed when there are NO plugins at all: with nothing installed there is no
                // evidence either way, and the list's own "nothing can declare a hook" line is the
                // complete and correct answer. Printing a "waiting on the daemon" note beside it
                // would invent a second, unfounded reason for an empty tab.
                LibraryPendingNote(
                    subject: "Commands an installed plugin runs at session start, around every tool "
                        + "call, and at the end of a turn.",
                    waitingOn: "The daemon already parses and runs these, but this one's "
                        + "plugins.list does not report manifestHooks yet."
                )
            }
            list
            LibraryFootnote(text: "A hook has no switch of its own: it runs whenever the plugin "
                            + "that declares it is enabled and consented. Turn the plugin off to "
                            + "turn its hooks off.")
        }
        .padding(libraryDetailPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task { await model.refresh() }
    }

    @ViewBuilder
    private var list: some View {
        if groups.isEmpty {
            Text("No plugins are installed, so nothing can declare a hook.")
                .font(Typography.label())
                .foregroundStyle(Theme.textSecondary)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 2) {
                            LibraryGroupHeader(
                                title: group.pluginName,
                                detail: group.statusText.isEmpty ? "not installed" : group.statusText
                            )
                            if group.hooks.isEmpty {
                                if hooksAreReported {
                                    // A FACT now, not a gap: the daemon reported this plugin's
                                    // hooks and there are none.
                                    LibraryRow(
                                        systemImage: "minus.circle",
                                        title: "Declares no hooks",
                                        subtitle: "This plugin runs nothing at session start, "
                                            + "around a tool call, or at the end of a turn."
                                    )
                                } else {
                                    LibraryRow(
                                        systemImage: "questionmark.circle",
                                        title: "Hooks not reported",
                                        subtitle: group.isEnabled
                                            ? "This plugin's hooks, if any, run today — the app just "
                                                + "cannot list them yet."
                                            : "This plugin is off, so none of its hooks run."
                                    )
                                }
                            } else {
                                ForEach(group.hooks) { hook in
                                    hookRow(hook, isEnabled: group.isEnabled)
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            HStack {
                Spacer(minLength: 0)
                Button("Manage in Plugins", action: onOpenPlugins)
            }
        }
    }

    private func hookRow(_ hook: PluginHookDeclaration, isEnabled: Bool) -> some View {
        LibraryRow(
            systemImage: hookEventSystemImage(hook.event),
            title: hookEventTitle(hook.event),
            subtitle: hook.command,
            subtitleIsMono: true
        ) {
            HStack(spacing: 6) {
                LibraryRowBadge(text: hookTimeoutText(hook.timeoutMs))
                if !isEnabled { LibraryRowBadge(text: "off") }
            }
        }
    }
}
