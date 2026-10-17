import SwiftUI

/// Where the pointer is over the pill's canvas (y-down, the canvas's own space), nil when it is outside. The mouse gate
/// writes it; only the buttons that glow observe it, so a move redraws them and nothing else.
@MainActor
final class DispatchPillPointer: ObservableObject {
    @Published private(set) var location: CGPoint?

    func set(_ point: CGPoint?) {
        if location != point { location = point }
    }
}

private struct DispatchPillPointerKey: EnvironmentKey {
    static let defaultValue: DispatchPillPointer? = nil
}

extension EnvironmentValues {
    /// The pill's pointer, for its buttons' hover glow (nil outside the pill: no glow).
    var dispatchPillPointer: DispatchPillPointer? {
        get { self[DispatchPillPointerKey.self] }
        set { self[DispatchPillPointerKey.self] = newValue }
    }
}

/// Under the pointer a pill button glows softly in its own colour (user 2026-10-15: glow, gentle — the same as the
/// desktop-switch pill's ✕ and ✓).
enum PillHoverGlowMetrics {
    static let near: Double = 0.45
    static let far: Double = 0.22
    static let nearRadius: CGFloat = 4
    static let farRadius: CGFloat = 10
}

extension View {
    /// A soft glow of `color` while the pill's pointer is over this view.
    func pillHoverGlow(_ color: Color) -> some View {
        modifier(PillHoverGlowModifier(color: color))
    }
}

private struct PillHoverGlowModifier: ViewModifier {
    let color: Color
    @Environment(\.dispatchPillPointer) private var pointer

    func body(content: Content) -> some View {
        if let pointer {
            content.modifier(PillHoverGlowTracking(pointer: pointer, color: color))
        } else {
            content
        }
    }
}

private struct PillHoverGlowTracking: ViewModifier {
    @ObservedObject var pointer: DispatchPillPointer
    let color: Color
    @State private var frame: CGRect = .zero

    func body(content: Content) -> some View {
        let hovered = pointer.location.map { frame.insetBy(dx: -2, dy: -2).contains($0) } ?? false
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(DispatchPillView.canvasSpace))
            } action: { frame = $0 }
            .shadow(color: color.opacity(hovered ? PillHoverGlowMetrics.near : 0), radius: PillHoverGlowMetrics.nearRadius)
            .shadow(color: color.opacity(hovered ? PillHoverGlowMetrics.far : 0), radius: PillHoverGlowMetrics.farRadius)
            .animation(.easeOut(duration: 0.15), value: hovered)
    }
}
