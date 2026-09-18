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

/// PURE: an entry's detail-page ref. Keyed by path in both cases (a rejected file may have no
/// name).
func libraryAgentRef(_ entry: AgentDefinitionEntry) -> LibraryItemRef {
    .agent(path: entry.id)
}

/// PURE: the sentence a rejected file's row and detail say — the daemon's own words when it sent
/// some, otherwise the fix for the reason we modelled.
func agentRejectionExplanation(_ reason: AgentDefinitionRejection, detail: String) -> String {
    detail.isEmpty ? agentRejectionText(reason) : detail
}

// MARK: - The list

struct LibraryAgentsList: View {
    /// TODAY: always empty — there is no `agents.list` to fill it. The one seam that changes when
    /// the daemon lands its half; every view below already renders a populated value, including
    /// the `.rejected` rows.
    let entries: [AgentDefinitionEntry]
    let selected: LibraryItemRef?
    let onOpen: (LibraryItemRef) -> Void

    private var rows: [AgentDefinitionEntry] { agentDefinitionsSorted(entries) }

    var body: some View {
        LibraryListPage(title: "Agents") {
            LibraryPendingNote(
                subject: "The subagent definitions you have written — each one's name, what it is "
                    + "for, and where its file lives.",
                waitingOn: "The daemon has no agent-definition store and no agents.list yet. "
                    + "(thread.list reports a session's running threads, which is a different "
                    + "thing and not shown here.)"
            )
            if rows.isEmpty {
                LibraryStateLine(text: "Nothing to list yet.")
            } else {
                LibraryGroupHeader(title: "Definitions", detail: agentDefinitionSummary(entries))
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(rows) { entry in
                            row(entry)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ entry: AgentDefinitionEntry) -> some View {
        let ref = libraryAgentRef(entry)
        switch entry {
        case let .definition(name, description, path, source):
            LibraryLinkRow(
                systemImage: "person.2",
                title: name,
                subtitle: description.isEmpty ? path : description,
                isSelected: selected == ref,
                action: { onOpen(ref) }
            ) {
                LibraryRowBadge(text: source)
            }
        case let .rejected(path, reason, detail):
            // A skipped file is a NORMAL row, never hidden behind a disclosure: red ink and its
            // path as the title (it may have no name), the reason right under it.
            LibraryLinkRow(
                systemImage: "exclamationmark.triangle",
                title: path,
                subtitle: agentRejectionExplanation(reason, detail: detail),
                tint: .red,
                isSelected: selected == ref,
                action: { onOpen(ref) }
            ) {
                LibraryRowBadge(text: agentRejectionBadge(reason))
            }
        }
    }
}

// MARK: - The detail

/// One definition's fields — or, for a skipped file, why it was skipped and what to add.
///
/// READ-ONLY, and it must stay that way for `permissionMode` in particular (see the security note
/// at the top of this file): showing a definition is fine, setting its approval mode from here is
/// not.
struct LibraryAgentDetail: View {
    let entries: [AgentDefinitionEntry]
    let path: String
    let onBack: () -> Void

    private var entry: AgentDefinitionEntry? { entries.first { $0.id == path } }

    var body: some View {
        switch entry {
        case let .definition(name, description, path, source):
            LibraryDetailPage(title: name, subtitle: "Agent · \(source)",
                              backLabel: "Back to Agents", onBack: onBack) {
                LibraryDetailField(label: "Description",
                                   value: description.isEmpty ? "No description" : description)
                LibraryDetailField(label: "Source", value: source)
                LibraryDetailField(label: "File", value: path, isMono: true)
            }
        case let .rejected(path, reason, detail):
            LibraryDetailPage(title: (path as NSString).lastPathComponent,
                              subtitle: "Skipped by the runtime · \(agentRejectionBadge(reason))",
                              backLabel: "Back to Agents", onBack: onBack) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(Typography.label())
                        .foregroundStyle(.red)
                    Text(agentRejectionExplanation(reason, detail: detail))
                        .font(Typography.label())
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LibraryStateLine(text: "The runtime skips a definition file without a name: and a "
                                 + "description: line in its frontmatter, so this agent is not "
                                 + "available to any session until the file is fixed.")
                LibraryDetailField(label: "File", value: path, isMono: true)
            }
        case nil:
            LibraryDetailPage(title: (path as NSString).lastPathComponent,
                              backLabel: "Back to Agents", onBack: onBack) {
                LibraryStateLine(text: "This definition is no longer listed.")
            }
        }
    }
}
