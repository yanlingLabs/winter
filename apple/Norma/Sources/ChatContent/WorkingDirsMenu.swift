import SwiftUI
import NormaKit

/// working-directories T8: the header's WORKING-FOLDERS chip and its menu — the mid-session half of
/// the picker (design doc §3; the create-time half is `WorkingDirPickerSheet`).
///
/// A function-family on `WindowContentView`, same cross-file extension shape as `WorkSidebar`'s own
/// `policyPickerRow`/`sidebarOptionsBlock`, so the chip renders inside the existing header row
/// alongside the model/effort/policy affordances and reads the SAME `currentSidebarSessionSummary`
/// row they read. Every decision it makes lives in `WorkingDirs.swift` where tests can drive it.
extension WindowContentView {
    /// The chip: a folder glyph + the primary's leaf name (or "No folder"), opening the menu.
    /// Slightly wider than the neighbouring plain-icon buttons on purpose — the current primary is
    /// the one piece of session state worth reading without opening anything.
    ///
    /// Turns RED while a refusal is outstanding. The refusal's own SENTENCE lives inside the menu
    /// (verbatim, `dirsMenuContent`), but a refusal arrives after the popover has already closed —
    /// the pick flow is menu → panel → confirm → RPC — so without a signal out here the user would
    /// be told nothing at all unless they happened to reopen the menu. The colour is the pointer;
    /// the sentence is still the daemon's.
    @ViewBuilder
    var dirsMenuButton: some View {
        let refused = adapter.dirsRefusal != nil
        Button {
            showingDirsMenu = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: refused ? "folder.badge.questionmark" : "folder")
                    .font(Typography.label())
                Text(dirsChipLabel(currentSidebarSessionSummary?.dirs))
                    .font(Typography.caption())
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundStyle(refused ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            .frame(maxWidth: 140, alignment: .trailing)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingDirsMenu, arrowEdge: .bottom) {
            dirsMenuContent
        }
    }

    /// The menu: every entry in the set (primary marked, locks badged), then the two doors that ADD
    /// to it, then the daemon's last refusal if there was one.
    ///
    /// **There is no dedicated per-row "make this existing entry the primary" button.** The daemon
    /// itself now PROMOTES correctly either way (whole-branch review I-1, `set-dirs.ts`'s dedupe-
    /// promote branch): `session.setDirs {op:"setPrimary"}` on a path already sitting at index k>0
    /// moves it to index 0 carrying its lock state, dropping the old primary — never a duplicate.
    /// This menu simply has no click that sends an EXISTING row's own path through that op; "Change
    /// primary folder…" opens the panel to pick a path, which happens to promote-not-duplicate if it
    /// coincides with an existing secondary, but there is no one-click "promote this row" today.
    @ViewBuilder
    var dirsMenuContent: some View {
        let dirs = currentSidebarSessionSummary?.dirs ?? []
        VStack(alignment: .leading, spacing: 2) {
            Text("Working folders")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)

            if dirs.isEmpty {
                // The workdir-less state, named rather than rendered as an empty list — a session
                // with no working folder is not broken, it's confined to its outputs folder.
                Text("No working folder — this session writes only to its outputs folder.")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 260, alignment: .leading)
                    .padding(.bottom, 4)
            } else {
                ForEach(Array(dirs.enumerated()), id: \.offset) { index, entry in
                    dirsEntryRow(dirs: dirs, index: index, entry: entry)
                }
                Divider().opacity(0.5).padding(.vertical, 4)
            }

            Button(dirs.isEmpty ? "Set working folder…" : "Change primary folder…") {
                adapter.onPickWorkingDir(.setPrimary)
                showingDirsMenu = false
            }
            .buttonStyle(.plain)
            .font(Typography.caption(.medium))
            .disabled(adapter.dirsChangeInFlight || !dirsPrimaryIsReplaceable(dirs))
            .padding(.vertical, 3)

            if !dirs.isEmpty {
                Button("Add folder…") {
                    adapter.onPickWorkingDir(.add)
                    showingDirsMenu = false
                }
                .buttonStyle(.plain)
                .font(Typography.caption(.medium))
                .disabled(adapter.dirsChangeInFlight)
                .padding(.vertical, 3)
            }

            // The daemon's own sentence, verbatim — see `FieldStateAdapter.dirsRefusal`.
            if let refusal = adapter.dirsRefusal {
                Text(refusal)
                    .font(Typography.caption())
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 260, alignment: .leading)
                    .padding(.top, 6)
            }
        }
        .padding(12)
        .frame(minWidth: 200)
    }

    /// One entry row: leaf name + primary/lock badges over the full path, with "Remove" when the
    /// daemon would accept one (`dirEntryIsRemovable` mirrors its two refusals — index 0 is a
    /// position, and a locked entry is permanent).
    @ViewBuilder
    private func dirsEntryRow(dirs: [SessionDirEntry], index: Int, entry: SessionDirEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(workingDirDisplayName(entry.path))
                        .font(Typography.caption(index == 0 ? .semibold : .regular))
                    if index == 0 {
                        Text("primary")
                            .font(Typography.badge(.medium))
                            .foregroundStyle(Theme.textMuted)
                    }
                    if entry.locked {
                        // The first-write lock: Norma has written here, so this entry is permanent
                        // for the session's lifetime.
                        Image(systemName: "lock.fill")
                            .font(Typography.micro())
                            .foregroundStyle(Theme.textMuted)
                    }
                }
                Text(entry.path)
                    .font(Typography.tiny())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if dirEntryIsRemovable(dirs, index: index) {
                Button("Remove") {
                    adapter.onSetDirs(.remove, entry.path)
                }
                .buttonStyle(.plain)
                .font(Typography.tiny(.medium))
                .foregroundStyle(.secondary)
                .disabled(adapter.dirsChangeInFlight)
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
        .padding(.vertical, 3)
    }
}
