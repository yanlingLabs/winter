import AppKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// DELETE AT MERGE.
//
// A local stand-in for `CUMirrorModel` and `CUMirrorView` from `WinterCUPresentation`, which the
// presentation lane is still building (spine §11b, "Shared Swift API"). Everything in this app that
// draws or feeds the mirror is written against EXACTLY these signatures — `MirrorCoordinator.swift`'s
// `MirrorSink` conformance and `MirrorWindowBinder.swift`'s `CUMirrorView(model:)` — and nothing else
// from the package. When the real types land, delete this file: the package is already a dependency of
// the Winter target, a module's own declarations shadow an imported module's, so removing the stub flips
// the app onto the package's types with no other edit.
//
// It is also a working renderer (a black rounded panel, the latest frame, the agent cursor as a dot,
// the app's name), so the mirror is usable before the real one arrives.
// -----------------------------------------------------------------------------------------------

@MainActor
public final class CUMirrorModel: ObservableObject {
    @Published public private(set) var appName: String = ""
    @Published public private(set) var windowSize: CGSize = .zero
    @Published public private(set) var image: NSImage?
    /// The agent cursor in the window's own points, or nil before the first cursor event.
    @Published public private(set) var cursor: CGPoint?
    @Published public private(set) var cursorKind: String = "move"

    public init() {}

    public func show(appName: String, windowSize: CGSize) {
        self.appName = appName
        self.windowSize = windowSize
    }

    public func apply(frame jpeg: Data, width: Int, height: Int, windowSize: CGSize) {
        if let decoded = NSImage(data: jpeg) { image = decoded }
        self.windowSize = windowSize
    }

    public func applyCursor(kind: String, point: CGPoint, dragTo: CGPoint?, frame: CGRect?, text: String?, count: Int?, button: String?) {
        cursorKind = kind
        cursor = dragTo ?? point
    }

    public func clear() {
        appName = ""
        windowSize = .zero
        image = nil
        cursor = nil
    }
}

public struct CUMirrorView: View {
    @ObservedObject private var model: CUMirrorModel

    public init(model: CUMirrorModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                if let image = model.image {
                    GeometryReader { proxy in
                        ZStack(alignment: .topLeading) {
                            Image(nsImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(width: proxy.size.width, height: proxy.size.height)
                            if let cursor = model.cursor, model.windowSize.width > 0, model.windowSize.height > 0 {
                                let scale = min(proxy.size.width / model.windowSize.width, proxy.size.height / model.windowSize.height)
                                let origin = CGPoint(x: (proxy.size.width - model.windowSize.width * scale) / 2,
                                                     y: (proxy.size.height - model.windowSize.height * scale) / 2)
                                Circle()
                                    .fill(Color.white)
                                    .overlay(Circle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
                                    .frame(width: 10, height: 10)
                                    .position(x: origin.x + cursor.x * scale, y: origin.y + cursor.y * scale)
                            }
                        }
                    }
                } else {
                    Color.white.opacity(0.04)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text(model.appName)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.7))
                .lineLimit(1)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
    }
}
