import SwiftUI

/// The pill-themed session window's header: the session's own CHILD PILL, docked at the top of its
/// window — the same black capsule the user clicked in the dispatch pill's row, in the same plume
/// colours. While the session works, its plume streams behind the title, throwing the tools and sites
/// the turn uses, with its stop circle on the nozzle; at rest it is a quiet capsule with the title.
struct SessionWindowHeader: View {
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var directory: SessionDirectory
    let sessionId: () -> String
    let fallbackTitle: String
    let palette: PlumePalette

    static let height: CGFloat = 40
    static let width: CGFloat = 380

    private var title: String {
        let id = sessionId()
        let row = directory.rows.first { $0.sessionId == id }
        let named = (row?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return named.isEmpty ? fallbackTitle : named
    }

    var body: some View {
        let running = adapter.turnRunning
        HStack(spacing: 8) {
            if !running {
                Circle()
                    .fill(palette.bodyColor)
                    .frame(width: 7, height: 7)
                    .transition(.opacity)
            }
            Text(title)
                .font(Typography.label(.semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.tail)
                .shadow(color: .black.opacity(running ? 0.8 : 0), radius: 2)
                .frame(maxWidth: .infinity, alignment: running ? .leading : .center)
            if running {
                Button { adapter.onInterrupt?() } label: {
                    Image(systemName: "stop.fill")
                        .font(Typography.caption(.bold))
                        .foregroundStyle(.white)
                        .frame(width: Self.height - 12, height: Self.height - 12)
                        .background(Circle().fill(palette.bodyColor))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .help("Stop this session")
                .transition(.opacity.combined(with: .scale(scale: 0.6)))
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 6)
        .frame(width: Self.width, height: Self.height)
        .background {
            ZStack {
                Capsule().fill(pillChromeSurface)
                if running {
                    let thrown = plumeThrows(for: adapter.transcript.last)
                    WorkingAnimationView(thrown: thrown, repeating: thrown, emitterInset: 6 + (Self.height - 12) / 2,
                                         palette: palette)
                        .opacity(0.85)
                        .clipShape(Capsule())
                        .transition(.opacity)
                }
            }
        }
        .shadow(color: .black.opacity(0.6), radius: 12, y: 3)
        .animation(.easeInOut(duration: 0.3), value: running)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
