import SwiftUI

/// "" / whitespace-only / nil → "New session" (the placeholder the daemon hasn't titled yet
/// exists as); otherwise the trimmed title verbatim. Pure factoring of the same fallback rule
/// `SessionSidebarRow.displayTitle` applies inline — kept as its own tested function here rather
/// than reaching into `ChatContent/SessionSidebar.swift` (a different, untouched file per this
/// task's scope) for a private computed property.
func sessionDisplayTitle(_ title: String?) -> String {
    let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "New session" : trimmed
}

/// Dispatch (Phase 7), task-7 review fix: STABLE regroup of the directory's rows — every
/// parentless row keeps `directory.rows`' existing (newest-first) relative order, and each child
/// row is lifted to sit immediately after its parent (siblings among themselves keep the
/// directory's own order too). A naive sort keyed on `(parentSessionId ?? sessionId, ...)` would
/// order parentless rows by their opaque random hex ids, destroying newest-first for the whole
/// list — grouping must never reorder what it isn't grouping. Orphan children (parent id not
/// present in `rows` at all, e.g. a vanished dispatch session) keep their natural directory
/// position rather than being dropped or floated. Pure + tested (`DashboardTests`), same
/// convention as `sessionDisplayTitle` above.
func groupedSessionRows(_ rows: [SessionSummary]) -> [SessionSummary] {
    let presentIds = Set(rows.map(\.sessionId))
    var childrenByParent: [String: [SessionSummary]] = [:]
    for row in rows {
        // Self-parented rows are malformed — treat as parentless rather than recursing on them.
        if let parent = row.parentSessionId, parent != row.sessionId, presentIds.contains(parent) {
            childrenByParent[parent, default: []].append(row)
        }
    }
    var result: [SessionSummary] = []
    var emitted = Set<String>()
    func emit(_ row: SessionSummary) {
        guard emitted.insert(row.sessionId).inserted else { return }
        result.append(row)
        for child in childrenByParent[row.sessionId] ?? [] { emit(child) }
    }
    for row in rows {
        let hasPresentParent = row.parentSessionId.map { $0 != row.sessionId && presentIds.contains($0) } ?? false
        if !hasPresentParent { emit(row) }
    }
    // Defensive sweep: a pathological parent CYCLE (a↔b — both rows have a "present parent," so
    // neither is a top-level emit root above) must degrade to natural-order rows, never dropped
    // ones. `emit`'s dedupe makes this a no-op in every well-formed case.
    for row in rows { emit(row) }
    return result
}

/// Task 5 (2f-ii): the Dashboard's Sessions pane — reuses the SAME `SessionDirectory` the app's
/// other sidebars already drive (`AppModel.directory`), so the Dashboard shows exactly the same
/// session list without a second listing harness. A row click reuses the EXISTING "open in a new
/// detached window" path (`onOpenSessionDetached`, wired by `AppDelegate` to
/// `openSessionInNewDetachedWindow`) — the Dashboard has no session harness of its own to repin
/// in place, unlike `SessionSidebar`'s plain-click behavior.
struct SessionsPane: View {
    @ObservedObject var directory: SessionDirectory
    let onOpenSessionDetached: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Sessions")
                .font(.headline)
                .padding([.top, .horizontal])
                .padding(.bottom, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if directory.rows.isEmpty {
                        Text("No sessions yet")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)
                    }
                    ForEach(groupedSessionRows(directory.rows)) { row in
                        Button {
                            onOpenSessionDetached(row.sessionId)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    // Dispatch (Phase 7): the singleton coordinator session badges
                                    // itself so it reads distinctly from an ordinary session row.
                                    if row.mode == "dispatch" {
                                        Text("DISPATCH")
                                            .font(.caption2)
                                            .bold()
                                            .foregroundStyle(.secondary)
                                    }
                                    // Chat Mode Slice A (CM-T3): same badge treatment, beside the
                                    // dispatch one — a chat session reads distinctly too.
                                    if row.mode == "chat" {
                                        Text("CHAT")
                                            .font(.caption2)
                                            .bold()
                                            .foregroundStyle(.secondary)
                                    }
                                    Text(sessionDisplayTitle(row.title))
                                        .font(.system(size: 13))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Text(Date(timeIntervalSince1970: TimeInterval(row.createdAt) / 1000), style: .relative)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal)
                            // Dispatch (Phase 7): a child session indents under its dispatch parent
                            // — see `groupedSessionRows` for the matching grouping this indent
                            // visually cues.
                            .padding(.leading, row.parentSessionId != nil ? 16 : 0)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .task { await directory.refresh() }
    }
}
