import SwiftUI

/// A bright band passing through a white view, left to right, then resting a beat (user,
/// 2026-10-04): the running tool pill's label, and the Winter mark a session window shows while its
/// history loads. The view is drawn ONCE and masked — never duplicated, so a climbing count or a
/// rotating name inside it stays single. While `active`, the view sits at `rest` opacity and the band
/// lifts it towards full; otherwise, and always under Reduce Motion, it is still at `inactive`.
struct BandShimmer: ViewModifier {
    let active: Bool
    /// The view's opacity away from the band.
    let rest: Double
    /// The view's opacity when not shimmering.
    let inactive: Double
    /// The band's opacity at its centre, laid over `rest`.
    var peak: Double = 1
    /// The band's narrowest, and its width as a share of the view's.
    var minBand: CGFloat = 60
    var bandShare: CGFloat = 0.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let period: TimeInterval = 2.0
    /// The share of a period the band takes to cross; the rest is the pause before the next pass.
    static let sweepShare: Double = 0.7

    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content
                .foregroundStyle(Color.white)
                .mask {
                    TimelineView(.animation) { timeline in
                        let t = timeline.date.timeIntervalSinceReferenceDate
                        let phase = min(1, t.truncatingRemainder(dividingBy: Self.period) / (Self.period * Self.sweepShare))
                        GeometryReader { geo in
                            let band = max(minBand, geo.size.width * bandShare)
                            ZStack(alignment: .leading) {
                                Color.black.opacity(rest)
                                LinearGradient(colors: [.black.opacity(0), .black.opacity(peak), .black.opacity(0)],
                                               startPoint: .leading, endPoint: .trailing)
                                    .frame(width: band)
                                    .offset(x: -band + (geo.size.width + band) * phase)
                            }
                        }
                    }
                }
        } else {
            content.foregroundStyle(Color.white.opacity(inactive))
        }
    }
}
