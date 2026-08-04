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
    @ViewBuilder
    var dirsMenuButton: some View {
        Button {
            showingDirsMenu = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "folder")
                    .font(.system(size: 12))
                Text(dirsChipLabel(currentSidebarSessionSummary?.dirs))
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundStyle(.secondary)
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
    /// **There is no "make this existing entry the primary".** `session.setDirs {op:"setPrimary"}`
    /// replaces `dirs[0]` and keeps `1…n` untouched, so pointing it at a path already sitting at
    /// index 2 produces a DUPLICATE rather than a promotion (set-dirs.ts's own expression:
    /// `[{path}, ...dirs.slice(1)]`). Promotion is not an operation this wire has, so the menu
    /// offers what it does have: "Change primary folder…", which picks a NEW directory.
    @ViewBuilder
    var dirsMenuContent: some View {
        let dirs = currentSidebarSessionSummary?.dirs ?? []
        VStack(alignment: .leading, spacing: 2) {
            Text("Working folders")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)

            if dirs.isEmpty {
                // The workdir-less state, named rather than rendered as an empty list — a session
                // with no working folder is not broken, it's confined to its outputs folder.
                Text("No working folder — this session writes only to its outputs folder.")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
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
            .font(.system(size: 11, weight: .medium))
            .disabled(adapter.dirsChangeInFlight || !dirsPrimaryIsReplaceable(dirs))
            .padding(.vertical, 3)

            if !dirs.isEmpty {
                Button("Add folder…") {
                    adapter.onPickWorkingDir(.add)
                    showingDirsMenu = false
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .disabled(adapter.dirsChangeInFlight)
                .padding(.vertical, 3)
            }

            // The daemon's own sentence, verbatim — see `FieldStateAdapter.dirsRefusal`.
            if let refusal = adapter.dirsRefusal {
                Text(refusal)
                    .font(.system(size: 11))
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
                        .font(.system(size: 11, weight: index == 0 ? .semibold : .regular))
                    if index == 0 {
                        Text("primary")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    if entry.locked {
                        // The first-write lock: Norma has written here, so this entry is permanent
                        // for the session's lifetime.
                        Image(systemName: "lock.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.tertiary)
                    }
                }
                Text(entry.path)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if dirEntryIsRemovable(dirs, index: index) {
                Button("Remove") {
                    adapter.onSetDirs(.remove, entry.path)
                }
                .buttonStyle(.plain)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .disabled(adapter.dirsChangeInFlight)
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
        .padding(.vertical, 3)
    }
}
