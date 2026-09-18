import SwiftUI

// SECURITY, before anyone adds an editor here (2026-09-18, from the session that owns the agents
// store): an agent definition file carries `permissionMode`, and the child HONOURS it. A definition
// the agent could write itself was therefore a route to an uncarded child. The daemon now strips
// `permissionMode` from parsed definitions, vetoes bypass on both legs, and fences writes to the
// agents dirs — and this tab must never offer that field either. Showing an agent's approval mode
// is fine; letting someone set it from here is not.

// -----------------------------------------------------------------------------------------------
// Library → Agents (2026-09-17). NOT BUILT DAEMON-SIDE AT ALL — the tab is the shape, honestly
// empty.
//
// What this tab is FOR: the agent DEFINITIONS a user has written — the markdown files with `name:`
// and `description:` frontmatter that the runtime turns into subagents. That store does not exist
// on the daemon yet, and neither does an `agents.list` to read it.
//
// What this tab is NOT: a monitor. `thread.list` exists and reports the LIVE threads of one
// session — which is a different object (a running thread, not a definition), scoped to a session
// this panel does not have, and answering a different question ("what is running right now")
// than the one a Library tab asks ("what have I got"). Rendering live threads here because the RPC
// happens to exist would put a monitor behind a manager's label, so it is not done.
//
// THE DETAIL THIS TAB IS DESIGNED AROUND: a definition file missing `name:` or `description:`
// frontmatter is SKIPPED by the runtime. Silently. A user who wrote a subagent, saved it, and sees
// nothing happen has no way to tell a typo'd frontmatter key from a broken feature — and a UI that
// simply lists the definitions the runtime accepted reproduces exactly that silence. So the row
// type is a two-case enum from the start: an accepted definition, or a REJECTED FILE with the
// reason it was skipped. The rejected row is not an error state of the tab, it is a normal row the
// list is expected to contain, which is why it lives in `AgentDefinitionEntry` rather than in some
// separate errors array the view could forget to render.
//
// When `agents.list` lands, the only change is where `entries` comes from — every row, sort, count
// and empty-state below already handles both cases.
// -----------------------------------------------------------------------------------------------

// MARK: - Pure model + display helpers

/// Why the runtime skipped a definition file. Closed here because these are the client's OWN
/// vocabulary for what the daemon will report; an unrecognised wire reason maps to `.unparseable`
/// with the daemon's own sentence carried alongside (`AgentDefinitionEntry.rejected(detail:)`), so
/// nothing is ever lost to a case this enum lacks.
enum AgentDefinitionRejection: String, Equatable, CaseIterable {
    /// No `name:` in the frontmatter — the runtime cannot address the agent.
    case missingName
    /// No `description:` — the runtime has nothing to tell the model about when to use it.
    case missingDescription
    /// The file has no readable frontmatter block at all.
    case unparseable
}

/// PURE: what a rejected file's row says. Written as a FIX, not a diagnosis — the user is looking
/// at this because their agent did not appear, and the next thing they need is the line to add.
func agentRejectionText(_ rejection: AgentDefinitionRejection) -> String {
    switch rejection {
    case .missingName: return "Skipped: add a name: line to the frontmatter."
    case .missingDescription: return "Skipped: add a description: line to the frontmatter."
    case .unparseable: return "Skipped: no readable --- frontmatter block."
    }
}

/// PURE: the rejection's short trailing badge.
func agentRejectionBadge(_ rejection: AgentDefinitionRejection) -> String {
    switch rejection {
    case .missingName: return "no name"
    case .missingDescription: return "no description"
    case .unparseable: return "unreadable"
    }
}

/// One row in the definitions list — accepted, or skipped.
///
/// Both cases carry `path`, because the path is the only handle a user has on a file that has no
/// name: "the one missing a name:" is useless, "`~/.winter/agents/reviewer.md`" is actionable.
enum AgentDefinitionEntry: Equatable, Identifiable {
    /// A definition the runtime accepted.
    case definition(name: String, description: String, path: String, source: String)
    /// A file the runtime skipped. `detail` is the daemon's own sentence when it sends one, so a
    /// reason this client does not model still reaches the user verbatim.
    case rejected(path: String, reason: AgentDefinitionRejection, detail: String)

    /// The path, which is unique per file in both cases — a rejected file may have no name at all,
    /// so the name cannot be the identity.
    var id: String {
        switch self {
        case let .definition(_, _, path, _): return path
        case let .rejected(path, _, _): return path
        }
    }

    var isRejected: Bool {
        if case .rejected = self { return true }
        return false
    }
}

/// PURE: the tab's one-line summary of what the list contains. Counts BOTH kinds, because "4
/// agents" over a list that also holds 2 skipped files is a lie of omission about the exact thing
/// this tab exists to surface.
func agentDefinitionSummary(_ entries: [AgentDefinitionEntry]) -> String {
    let rejected = entries.filter(\.isRejected).count
    let accepted = entries.count - rejected
    let agents = "\(accepted) agent\(accepted == 1 ? "" : "s")"
    guard rejected > 0 else { return agents }
    return "\(agents), \(rejected) file\(rejected == 1 ? "" : "s") skipped"
}

/// PURE: accepted definitions first (alphabetical by name), then skipped files (alphabetical by
/// path).
///
/// Skipped files sort LAST rather than first on purpose: they are the exceptional case and the
/// common reading of this tab is "which agents do I have". They are never hidden behind a
/// disclosure, though — a problem you have to click to see is a problem you will not see.
func agentDefinitionsSorted(_ entries: [AgentDefinitionEntry]) -> [AgentDefinitionEntry] {
    func key(_ entry: AgentDefinitionEntry) -> (Int, String) {
        switch entry {
        case let .definition(name, _, _, _): return (0, name.lowercased())
        case let .rejected(path, _, _): return (1, path.lowercased())
        }
    }
    return entries.sorted { lhs, rhs in
        let (lhsRank, lhsName) = key(lhs)
        let (rhsRank, rhsName) = key(rhs)
        if lhsRank != rhsRank { return lhsRank < rhsRank }
        return lhsName < rhsName
    }
}

// MARK: - The tab

struct LibraryAgentsTab: View {
    /// TODAY: always empty — there is no `agents.list` to fill it. The one seam that changes when
    /// the daemon lands its half; every view below already renders a populated value, including
    /// the `.rejected` rows.
    var entries: [AgentDefinitionEntry] = []

    private var rows: [AgentDefinitionEntry] { agentDefinitionsSorted(entries) }

    var body: some View {
        VStack(alignment: .leading, spacing: libraryDetailSpacing) {
            LibraryTabHeader(title: "Agents")
            LibraryPendingNote(
                subject: "The subagent definitions you have written — each one's name, what it is "
                    + "for, and where its file lives.",
                waitingOn: "The daemon has no agent-definition store and no agents.list yet. "
                    + "(thread.list reports a session's running threads, which is a different "
                    + "thing and not shown here.)"
            )
            if rows.isEmpty {
                Text("Nothing to list yet.")
                    .font(Typography.label())
                    .foregroundStyle(Theme.textSecondary)
            } else {
                LibraryGroupHeader(title: "Definitions", detail: agentDefinitionSummary(entries))
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(rows) { entry in
                            row(entry)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(libraryDetailPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func row(_ entry: AgentDefinitionEntry) -> some View {
        switch entry {
        case let .definition(name, description, path, source):
            LibraryRow(
                systemImage: "person.2",
                title: name,
                subtitle: description.isEmpty ? path : description
            ) {
                LibraryRowBadge(text: source)
            }
        case let .rejected(path, reason, detail):
            // The explicit error row. `.red` ink (the same semantic style `SkillsPane` and
            // `PluginManagerView` use for their error lines) and the file's own path as the title,
            // because a skipped file may have no name to show.
            LibraryRow(
                systemImage: "exclamationmark.triangle",
                title: path,
                subtitle: detail.isEmpty ? agentRejectionText(reason) : detail,
                tint: .red
            ) {
                LibraryRowBadge(text: agentRejectionBadge(reason))
            }
        }
    }
}
