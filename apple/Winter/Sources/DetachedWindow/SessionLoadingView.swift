import SwiftUI

/// What a session window shows until its history has loaded (user, 2026-10-04): the Winter mark in
/// grey on the window's black, a band passing through it like the running tool pill's text. The
/// window fades it out once the replay has landed (`SessionModel.isLoadingHistory`).
struct SessionLoadingView: View {
    static let markSize: CGFloat = 56

    var body: some View {
        Image("BrandMark")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .frame(width: Self.markSize, height: Self.markSize)
            .modifier(BandShimmer(active: true, rest: 0.18, inactive: 0.25, peak: 0.5, minBand: 32, bandShare: 0.7))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black)
            .accessibilityElement()
            .accessibilityLabel("Loading session")
    }
}
