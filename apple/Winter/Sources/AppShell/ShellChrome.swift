import SwiftUI

// MARK: - ChatGPT-style window chrome (2026-09-17)

/// The shared button style for window-chrome controls — titlebar icons, the panel's tabs and its
/// "+" — measured off ChatGPT's macOS app: no fill at rest, `Theme.chromeHover` under the pointer,
/// `Theme.chromeSelected` while on. One continuous-corner shape, so every chrome control rounds the
/// same way.
struct ShellChromeButtonStyle: ButtonStyle {
    var isSelected: Bool = false
    var cornerRadius: CGFloat = shellSidebarRowCornerRadius

    func makeBody(configuration: Configuration) -> some View {
        ChromeBody(configuration: configuration, isSelected: isSelected, cornerRadius: cornerRadius)
    }

    private struct ChromeBody: View {
        let configuration: Configuration
        let isSelected: Bool
        let cornerRadius: CGFloat
        @State private var isHovered = false

        var body: some View {
            configuration.label
                .background(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .fill(shellChromeFill(isSelected: isSelected,
                                              isHovered: isHovered || configuration.isPressed))
                )
                .onHover { isHovered = $0 }
        }
    }
}

/// PURE: which fill a chrome control wears. Hover wins over selected — the pointer is the more
/// immediate fact, and it is what ChatGPT does.
func shellChromeFill(isSelected: Bool, isHovered: Bool) -> Color {
    if isHovered { return Theme.chromeHover }
    if isSelected { return Theme.chromeSelected }
    return .clear
}

/// A single-line title that FADES its trailing edge when it does not fit, rather than cutting it
/// with an ellipsis — ChatGPT's sidebar and tab treatment. Fits → drawn plainly; overflows → the
/// last `fadeWidth` points fade to clear.
struct FadingTitleText: View {
    let text: String
    let font: Font
    var fadeWidth: CGFloat = 16

    @State private var textWidth: CGFloat = 0
    @State private var boxWidth: CGFloat = 0

    var body: some View {
        // The LAYOUT is a one-line placeholder that asks for no width of its own; the real title
        // is an OVERLAY (overlays never affect layout), drawn at its full natural width and
        // clipped. Laying the full-width text out directly made every row as wide as its title
        // and shoved the whole sidebar sideways.
        Text(verbatim: " ")
            .font(font)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Text(text)
                    .font(font)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { textWidth = $0 }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { boxWidth = $0 }
            .clipped()
            .mask {
                if fadingTitleOverflows(textWidth: textWidth, boxWidth: boxWidth) {
                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: max(0, 1 - fadeWidth / max(boxWidth, 1))),
                            .init(color: .clear, location: 1),
                        ],
                        startPoint: .leading, endPoint: .trailing)
                } else {
                    Rectangle()
                }
            }
            .accessibilityLabel(text)
    }
}

/// PURE: whether a title overflows its box (half a point of slack for rounding).
func fadingTitleOverflows(textWidth: CGFloat, boxWidth: CGFloat) -> Bool {
    boxWidth > 0 && textWidth > boxWidth + 0.5
}

// MARK: - The side panels' open/close (2026-09-17)

/// The curve both side panels open and close on: a plain ease, with NO spring overshoot — the
/// `.snappy` spring this replaced bounced at the end of every toggle.
let shellPanelMotion: Animation = .easeInOut(duration: 0.28)

// MARK: - Behind-window vibrancy (2026-09-17 EXPERIMENT)

/// The sidebar's translucent plane: the DESKTOP (or whatever window sits behind Winter) blurred
/// through the pane.
///
/// **This is the only thing that can do that, and SwiftUI's `.ultraThinMaterial` is not it.** A
/// SwiftUI `Material` blends with what is behind it *inside the window*; on an opaque window that
/// is a flat tint of the app's own fill — the exact mistake `accountStrip` documents (it painted a
/// grey band, not a blur). Seeing through to the desktop takes two things together:
///
/// 1. an `NSVisualEffectView` in `.behindWindow` blending mode — it punches a hole through the
///    window's backing in its own bounds and composites the desktop's blur there;
/// 2. a window that is not opaque and has a clear fill (`AppWindowController`), or the window's
///    own backing store covers the desktop before this view ever gets to sample it.
///
/// `state = .followsWindowActiveState` is deliberate: an inactive window's sidebar desaturates the
/// way every native sidebar does, so Winter reads as background when it is. The system's "Reduce
/// transparency" setting turns this into a plain opaque fill by itself — nothing to handle here.
/// `blendingMode` is the whole difference between the two uses:
///
/// - `.behindWindow` (the sidebar) samples what is BEHIND the window — the desktop. Correct there,
///   because the pane is the window's own edge.
/// - `.withinWindow` (the floating panels, 2026-09-17) samples what is behind the view INSIDE the
///   window — the transcript the panel is covering. A panel must use this one: behind-window would
///   punch a hole clean through the app and show the desktop where the chat should be, erasing the
///   very content the panel is floating over.
struct ShellVibrancyBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .sidebar
    var blendingMode: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = blendingMode
        view.material = material
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blendingMode
    }
}
