import SwiftUI

/// 2e-iii Task 5: the left session-switcher sidebar — a live list of sessions (title + relative
/// creation time) driven by `SessionDirectory`, plus a "+ New session" affordance. NOT YET MOUNTED
/// anywhere (Task 6 embeds this into the window layout, sized to `sidebarLeftWidth` per
/// `SidebarLayout.swift`'s width engine) — this file only builds the view itself.
///
/// Row tap semantics: a plain click fires `onSelect` (switch the CURRENT window in place — the
/// morph window refocuses, a detached window re-pins its own feed); ⌘-click fires `onOpenDetached`
/// instead (open that session in a BRAND NEW detached window), checked via `NSEvent.modifierFlags`
/// at click time — same "read the live global modifier state" idiom `ComposerTextView` already
/// uses for its own Shift-Return check.
///
/// Styling: matches the window's adaptive, glass-adjacent palette — `.secondary`/`.tertiary` only,
/// no new colors (the window is opaque past the shell, same regime `WindowContentView` documents).
struct SessionSidebar: View {
    @ObservedObject var directory: SessionDirectory
    let currentSessionId: String?
    let onSelect: (String) -> Void
    let onOpenDetached: (String) -> Void
    let onNewSession: () -> Void
    /// Plan-immunity Task 2: `SidebarWiring.rowFilter` threaded straight through — see that
    /// struct's own doc comment. Default `{ _ in true }` reproduces every pre-existing behavior
    /// (nothing filtered) for any direct construction that doesn't pass one.
    var rowFilter: (SessionSummary) -> Bool = { _ in true }
    /// App shell T1: `SidebarWiring.onSummonApp` threaded straight through — see that struct's own
    /// doc comment. Default `nil` (every detached window) renders NO extra row, so those sidebars
    /// are unchanged; only the orb's own wiring passes it.
    var onSummonApp: (() -> Void)? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let onSummonApp {
                    summonAppRow(onSummonApp)
                }
                newSessionRow
                ForEach(directory.rows.filter(rowFilter)) { row in
                    SessionSidebarRow(
                        row: row,
                        isCurrent: row.sessionId == currentSessionId,
                        onSelect: onSelect,
                        onOpenDetached: onOpenDetached
                    )
                }
            }
            .padding(8)
        }
        .frame(width: sidebarLeftWidth)
        // FINAL-REVIEW FIX (M1): the wirer-level `startInitialLoad()` kicks (AppModel.init /
        // DetachedWindowController.init) can lose their race against this directory's own harness
        // not being connected yet at construction time — this `.task` is the belt: it fires every
        // time the sidebar itself appears (a real window/appear event, well after connect in
        // practice), so opening the sidebar always freshens the list regardless of how the earlier
        // construction-time kick landed.
        .task { await directory.refresh() }
    }

    /// App shell T1: the orb's door to the one app window (spec §1 — the orb summons the shell).
    /// Same row anatomy/typography as `newSessionRow` below, sitting above it.
    private func summonAppRow(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "macwindow")
                    .font(.system(size: 12))
                Text("Open Norma")
                    .font(.system(size: 12))
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var newSessionRow: some View {
        Button(action: onNewSession) {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle")
                    .font(.system(size: 12))
                Text("New session")
                    .font(.system(size: 12))
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One row: title (fallback "New session" when the daemon hasn't titled it yet) + relative
/// creation time, highlighted with a `.quaternary`-filled `RoundedRectangle` when it's the
/// surface's current session.
private struct SessionSidebarRow: View {
    let row: SessionSummary
    let isCurrent: Bool
    let onSelect: (String) -> Void
    let onOpenDetached: (String) -> Void

    private var displayTitle: String {
        let trimmed = row.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "New session" : trimmed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(displayTitle)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(Date(timeIntervalSince1970: TimeInterval(row.createdAt) / 1000), style: .relative)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background {
            if isCurrent {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.quaternary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if NSEvent.modifierFlags.contains(.command) {
                onOpenDetached(row.sessionId)
            } else {
                onSelect(row.sessionId)
            }
        }
    }
}
