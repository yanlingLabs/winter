import SwiftUI

/// A view's measured length, reported to `action` only when it moved by more than `tolerance` points.
///
/// `onGeometryChange` calls its action whenever the measured value differs AT ALL, and every site that writes
/// that value into `@State` or an observable object which feeds layout is one fraction of a point of rounding
/// away from re-triggering itself: a width that settles to 311.99997 on one pass and 312.00003 on the next makes
/// a text wrap, a clamp or a frame decision flip, which moves the length again. Below the tolerance a change is
/// not a change. (Layout feedback in a lazy transcript is also the one thing that keeps `LazyLayoutViewCache`
/// recomputing item phases forever, which is what a stuck main thread looked like in a sample.)
struct MeasuredLength: ViewModifier {
    enum Axis { case width, height }

    let axis: Axis
    let tolerance: CGFloat
    let action: (CGFloat) -> Void

    private final class Last { var value: CGFloat? }
    @State private var last = Last()

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGFloat.self, of: { axis == .width ? $0.size.width : $0.size.height }) { measured in
            if let old = last.value, abs(measured - old) <= tolerance { return }
            last.value = measured
            action(measured)
        }
    }
}

extension View {
    /// Reports this view's height when it moved by more than `tolerance` (0.5 pt).
    func onMeasuredHeight(tolerance: CGFloat = 0.5, perform action: @escaping (CGFloat) -> Void) -> some View {
        modifier(MeasuredLength(axis: .height, tolerance: tolerance, action: action))
    }

    /// Reports this view's width when it moved by more than `tolerance` (0.5 pt).
    func onMeasuredWidth(tolerance: CGFloat = 0.5, perform action: @escaping (CGFloat) -> Void) -> some View {
        modifier(MeasuredLength(axis: .width, tolerance: tolerance, action: action))
    }
}

/// Whether `new` differs from `old` by more than `tolerance` in either dimension.
func sizeChanged(_ new: CGSize, from old: CGSize, tolerance: CGFloat = 0.5) -> Bool {
    abs(new.width - old.width) > tolerance || abs(new.height - old.height) > tolerance
}
