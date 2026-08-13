import Foundation
import SwiftUI

// MARK: - The `$OUTDIR` convention (app-shell T8, spec §3) — the app READS it directly, no RPC.
//
// Mirrors `packages/core/src/sessions/outdir.ts`'s directory shape (`<normaHome>/outputs/
// <sessionId>/…`) without this app ever calling into that file. `home` is EVERY caller's own
// `AppProfile.normaHome` — never a literal `~/.norma` (the dev/dist profile-blindness class that
// shipped as a live bug once; see `AppProfile.normaHome`'s own doc comment). Kept as free functions
// (not methods) so both `OutputsWatcher` and `ShellSessionHost` share exactly one implementation of
// "where is this session's outputs dir" rather than two that could drift.

/// `<home>/outputs` — the FSEvents watch root (`OutputsWatcher.start()`) and the box's own read
/// root.
func outputsRootPath(home: String) -> String {
    home + "/outputs"
}

/// `<home>/outputs/<sessionId>` — one session's own outdir. `sessionId` is trusted here (it always
/// arrives off `SessionSummary.sessionId`/`ShellSessionHost.attachedSessionId`, never raw external
/// input) — unlike the daemon's own `outdirPath`, which validates it against path-component
/// injection because a TOOL CALL there could otherwise escape `~/.norma` with a crafted id; no such
/// attacker-controlled path reaches this side.
func outputsSessionPath(home: String, sessionId: String) -> String {
    outputsRootPath(home: home) + "/" + sessionId
}

/// The session's current output files, recursively, sorted for a stable box order.
/// VANISH-TOLERANT: `FileManager.enumerator(at:)` on a directory that doesn't exist returns `nil`
/// (never throws) — reads as "no files" rather than a crash, the same tolerance spec §3 asks of the
/// live watcher itself (`store.deleteSession`'s `rmSync` can remove this directory between two
/// calls — SP2's own shape). Only regular files are reported; a subdirectory contributes nothing of
/// its own (its files are still walked into and reported individually by the recursive enumerator).
func listOutputFiles(home: String, sessionId: String, fileManager: FileManager = .default) -> [URL] {
    let dir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: sessionId), isDirectory: true)
    guard let enumerator = fileManager.enumerator(
        at: dir, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]
    ) else { return [] }
    var files: [URL] = []
    for case let url as URL in enumerator {
        if (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
            files.append(url)
        }
    }
    return files.sorted { $0.path < $1.path }
}

/// Whether the outputs box participates for a session's mode — code/cowork only, the SAME domain
/// `session.setActivity` enforces daemon-side (`participatesInActivity`,
/// packages/core/src/sessions/activity.ts: `ACTIVITY_MODES = new Set(["code", "cowork"])`,
/// `mode ?? "code"` for an absent value): chat/dispatch sessions carry no fs tools and therefore
/// never populate `$OUTDIR`. `ShellSessionHost` gates its `outputFiles` refresh on this directly
/// (never populating the field at all for an ineligible session), so this is the ONE place the rule
/// lives — the view never has to re-derive it.
func outputsBoxEligible(mode: String?) -> Bool {
    let resolved = mode ?? "code"
    return resolved == "code" || resolved == "cowork"
}

// MARK: - The box itself

/// code/cowork session views' outputs list (spec §3). COLLAPSED/ABSENT when empty — never a hollow
/// box (the pinned rule): the caller gates on `!files.isEmpty` before mounting this at all, the same
/// "caller already gates" convention `WindowContentView`'s `pinnedTasksSection`/`subagentSection`
/// callers use for their own empty-hiding sections.
struct OutputsBox: View {
    let files: [URL]
    let onSelect: (URL) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().opacity(0.5)
            Text("Outputs (\(files.count))")
                .font(Typography.caption(.semibold))
                .foregroundStyle(.secondary)
            ForEach(files, id: \.path) { file in
                Button {
                    onSelect(file)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "doc")
                            .foregroundStyle(.secondary)
                        Text(file.lastPathComponent)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .font(Typography.caption())
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
