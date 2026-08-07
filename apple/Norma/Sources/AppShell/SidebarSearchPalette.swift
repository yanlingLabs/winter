import SwiftUI

// MARK: - The pure decisions (sidebar-brand T3)

/// PURE: the coarse recency bucket shown at a palette row's trailing edge — the reference's own
/// register ("Past month", "Past year"), deliberately NOT a precise relative timestamp: the
/// palette exists to help you FIND a session, and a precise age would compete with the title for
/// attention while adding nothing to that job.
///
/// `createdAt` is epoch MILLISECONDS (`SessionSummary.createdAt` — every existing call site
/// divides by 1000). `now` is injected so the pin is not clock-dependent.
///
/// A FUTURE stamp — clock skew between the daemon's host and this Mac is ordinary — reads as
/// "Today" rather than falling through to "Older": the row is the newest thing we know of, and
/// calling it "Older" would be actively wrong.
func relativeTimeBucket(createdAt: Int, now: Date) -> String {
    let age = now.timeIntervalSince1970 - TimeInterval(createdAt) / 1000
    switch age {
    case ..<86_400: return "Today"          // also catches negative (future) ages
    case ..<604_800: return "Past week"     // 7 days
    case ..<2_592_000: return "Past month"  // 30 days
    case ..<31_536_000: return "Past year"  // 365 days
    default: return "Older"
    }
}

/// PURE: the keyboard highlight's next index. CLAMPED, never wrapping — ↓ on the last row stays
/// put; the reference behaves this way, and wrap-around in a short list reads as a glitch.
///
/// Total by construction: an empty result set answers 0 (the caller renders "No matches" and
/// never indexes into the list), and a STALE index left over from a wider result set is clamped
/// back into range — which is why the caller may pass `delta: 0` purely to re-clamp after the
/// row set shrinks underneath the selection.
func searchPaletteMoveSelection(current: Int, count: Int, delta: Int) -> Int {
    guard count > 0 else { return 0 }
    return min(max(current + delta, 0), count - 1)
}

// MARK: - Presentation state

/// The palette's presentation flag.
///
/// An `ObservableObject` rather than a plain `@State` because the button that OPENS the palette
/// lives in the sidebar while the palette itself is an overlay on the shell ROOT — the two are
/// siblings, not parent and child. `ShellRootView` owns the instance and hands it to both.
@MainActor
final class SearchPalettePresentation: ObservableObject {
    @Published var isPresented = false

    func open() { isPresented = true }
    func close() { isPresented = false }

    /// The ⌘K door's verb — a toggle, so the same chord closes what it opened.
    func toggle() { isPresented.toggle() }
}

// MARK: - The palette

/// The centred floating search palette — the Claude Mac app's shape (user reference,
/// 2026-08-07), replacing the sidebar's old always-visible inline search field (spec R2).
///
/// A SwiftUI overlay on the shell root, NOT an `NSPanel`: keyboard focus, Esc dismissal and
/// window ownership all come free, and it can never become a stray window the dock-ghost harness
/// has to sweep (`HarnessTeardownObserver`).
///
/// Rows come from `filteredRecents(recentsCandidates(...))` — the same two pure functions the
/// sidebar's own Recents list uses, so search behaviour is unchanged by construction and the
/// dispatch exclusion (spec R6) cannot drift between the two surfaces.
struct SidebarSearchPalette: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    @ObservedObject var presentation: SearchPalettePresentation

    @State private var query = ""
    @State private var selection = 0
    @FocusState private var fieldFocused: Bool

    private var rows: [SessionSummary] {
        filteredRecents(recentsCandidates(directory.rows), query: query)
    }

    var body: some View {
        // The BACKDROP (live-gate finding, 2026-08-07): the card alone is only 670 pt wide, so
        // without this every click outside it fell straight THROUGH to the app behind — the
        // palette looked modal while the sidebar underneath stayed live, and clicking "Dispatch"
        // navigated the shell with the palette still sitting on top of it. A full-bleed backdrop
        // makes the palette actually modal and gives it the reference's click-away dismissal.
        //
        // It DIMS (user call, 2026-08-07 — this pass first shipped it at `opacity(0.001)`, just
        // hit-testable and invisible). A scrim is what tells you at a glance that the rest of the
        // window is not accepting clicks right now, which the invisible version left you to
        // discover by clicking. Kept light: the palette is a quick find-and-go, not a sheet, and a
        // heavy scrim would make it feel like a bigger interruption than it is.
        ZStack {
            Color.black.opacity(searchPaletteScrimOpacity)
                .ignoresSafeArea()
                .onTapGesture { presentation.close() }
            card
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            field
            if rows.isEmpty {
                Text(recentsCandidates(directory.rows).isEmpty ? "No sessions yet" : "No matches")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 16)
            } else {
                Divider()
                results
            }
        }
        .frame(width: searchPaletteWidth)
        .background(
            RoundedRectangle(cornerRadius: searchPaletteCornerRadius, style: .continuous)
                .fill(Theme.paletteSurface)
                .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
        )
        // The query resets on every open (the reference does) — a palette that reopens holding
        // last time's search is a small annoyance repeated forever.
        .onAppear {
            query = ""
            selection = 0
            fieldFocused = true
        }
        // Typing re-aims at the top row: after narrowing the list, the best match is first, and
        // leaving the highlight buried mid-list means ↵ opens something you did not look at.
        .onChange(of: query) { _, _ in selection = 0 }
        // The safety net for a shrink the query did NOT cause — a live directory refresh while
        // the palette is open. `delta: 0` is the pure function's re-clamp call.
        .onChange(of: rows.count) { _, count in
            selection = searchPaletteMoveSelection(current: selection, count: count, delta: 0)
        }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.downArrow) { move(1); return .handled }
        // Esc. `.onKeyPress` rather than `.onExitCommand` (live-gate finding, 2026-08-07): with
        // the TextField holding focus, `.onExitCommand` never fired and Esc did nothing at all.
        // `.onKeyPress` routes up from the focused descendant, which is what the arrow keys above
        // already rely on. `.onExitCommand` is KEPT as a second path for the case where focus is
        // not in the field.
        .onKeyPress(.escape) { presentation.close(); return .handled }
        .onExitCommand { presentation.close() }
    }

    private var field: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textMuted)
            TextField("Search sessions", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .focused($fieldFocused)
                .onSubmit(openSelection)
            Button {
                presentation.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close search")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
    }

    private var results: some View {
        ScrollView {
            VStack(spacing: 1) {
                ForEach(Array(rows.enumerated()), id: \.element.sessionId) { index, row in
                    Button { open(row) } label: {
                        rowLabel(row, isHighlighted: index == selection)
                    }
                    // The SAME row treatment as the sidebar (`ShellSidebarRowStyle`) — one row
                    // vocabulary across the whole shell, not a second one invented here.
                    .buttonStyle(ShellSidebarRowStyle(isSelected: index == selection))
                }
            }
            .padding(8)
        }
        .frame(maxHeight: searchPaletteMaxResultsHeight)
    }

    private func rowLabel(_ row: SessionSummary, isHighlighted: Bool) -> some View {
        HStack(spacing: 10) {
            // spec R3: the session's OWN mode glyph. `SessionMode(wire:)` is the shell's one mode
            // table (nil/unknown → `.code`, because the daemon sends nil for a plain code
            // session), so this is the exact glyph set the sidebar's mode rows wear — there is no
            // second table here to drift out of sync. Dispatch is unreachable in this list by
            // construction (spec R6, `recentsCandidates`).
            Image(systemName: SessionMode(wire: row.mode).systemImage)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
                .frame(width: 20)
            Text(sessionDisplayTitle(row.title))
                .font(.system(size: 14))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 12)
            if isHighlighted {
                Image(systemName: "return")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textMuted)
            } else {
                Text(relativeTimeBucket(createdAt: row.createdAt, now: Date()))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: searchPaletteRowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func move(_ delta: Int) {
        selection = searchPaletteMoveSelection(current: selection, count: rows.count, delta: delta)
    }

    /// ↵ on the field opens whatever the highlight is on. Guarded rather than trusting the
    /// clamp: `rows` is recomputed on every access, so an empty list must simply do nothing.
    private func openSelection() {
        guard selection < rows.count else { return }
        open(rows[selection])
    }

    private func open(_ row: SessionSummary) {
        nav.navigate(to: .session(row.sessionId))
        presentation.close()
    }
}

// MARK: - Metrics (tune-at-gate, the same posture as the sidebar's own constants)

/// Reference-measured from the Claude Mac app's palette (~670 pt on a 1512 pt-wide screen).
let searchPaletteWidth: CGFloat = 670

/// Deliberately NOT the sidebar rows' 6 pt — the palette is a CARD, not a row.
let searchPaletteCornerRadius: CGFloat = 14

/// A palette row is slightly taller than a sidebar row: it carries a glyph and a trailing label,
/// and it is read at the centre of the window rather than scanned down a narrow column.
let searchPaletteRowHeight: CGFloat = 34

/// Caps the result list so a long session history cannot grow the card past the window.
let searchPaletteMaxResultsHeight: CGFloat = 420

/// The backdrop's dim. Light on purpose — enough to say "the window is busy", not enough to make
/// a quick find-and-go feel like a modal sheet. Works in both appearances: black at a low alpha
/// deepens the warm charcoal as readily as it shades the cream.
let searchPaletteScrimOpacity: Double = 0.16
