import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import WinterCUPresentation
import WinterKit

/// The island's phase-2 activity rendered OFFSCREEN (no window, nothing on screen, no capture): the computer-use pill
/// (alone, with a count, under a strip counting compacted cards, its birth), its mirror and the detached mirror (with a drawn stand-in
/// picture — `ImageRenderer` cannot draw the live canvas, and nothing is captured), a turn-result card and the Watches
/// tab. Written by `IslandActivityGalleryTests` into `WINTER_ISLAND_RENDER_DIR` (a temporary folder otherwise).
@MainActor
enum IslandActivityGallery {
    static func render(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var out: [URL] = []
        let notched = IslandScreenShape(housing: IslandGallery.housing, menuBarHeight: 32)
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        let one = IslandCUPresentation(sessionId: "s1", line: "Clicking “Publish” in Google Chrome", count: 1,
                                       title: "List the extension", lingering: false)
        let two = IslandCUPresentation(sessionId: "s1", line: "Waiting for “Status: Published”", count: 2,
                                       title: "List the extension", lingering: false)

        out.append(try write(pill(one, shape: notched, t: DesktopIslandFluid.settle), directory, "island-cu-pill@2x.png"))
        out.append(try write(pill(two, shape: notched, t: DesktopIslandFluid.settle), directory, "island-cu-pill-count@2x.png"))
        out.append(try write(pill(one, shape: plain, t: DesktopIslandFluid.settle), directory, "island-cu-pill-no-housing@2x.png"))
        let typing = IslandCUPresentation(sessionId: "s1", line: "Typing in Notes", count: 1, title: nil, lingering: true)
        out.append(try write(pill(typing, shape: notched, t: DesktopIslandFluid.settle), directory, "island-cu-pill-lingering@2x.png"))
        let frames = try stride(from: 0.0, through: 1.2, by: 0.1).map { try renderImage(pill(one, shape: notched, t: $0)) }
        out.append(try write(try filmstrip(frames), directory, "island-cu-pill-birth-filmstrip@2x.png"))

        // Two cards compacted: only the strip's count says so; the pill hangs from the housing as always.
        let stripModel = IslandStripModel(waitingCount: 2)
        let strip = IslandLayout.strip(notched)
        let withCompacted = scene(notched, width: 520, height: 150) {
            ZStack(alignment: .top) {
                pillFrame(one, shape: notched, t: DesktopIslandFluid.settle)
                IslandStripView(model: stripModel, size: strip.size, housingWidth: notched.housing?.width)
            }
        }
        out.append(try write(withCompacted, directory, "island-cu-pill-with-compacted@2x.png"))

        // The mirror, in the island and detached, with a drawn stand-in picture.
        let picture = Image(decorative: try renderImage(standInWindow()), scale: 2)
        let g = IslandLayout.cardGeometry(notched, size: CGSize(width: IslandActivityLayout.cuPillWidth, height: DesktopIslandGeometry.pillHeight),
                                          rounded: false)
        let size = IslandActivityLayout.mirrorSize
        let mirror = scene(notched, width: size.width + 140, height: g.pill.minY + size.height + 40) {
            IslandMorphShell(size: size, cornerRadius: IslandActivityLayout.mirrorCorner, hovered: false) {
                IslandMirrorContent(presentation: one, model: nil, placeholder: picture, onDetach: {}, onCollapse: {})
            }
            .padding(.top, g.pill.minY)
        }
        out.append(try write(mirror, directory, "island-cu-mirror@2x.png"))
        let detached = ZStack {
            LinearGradient(colors: [Color(nsColor: .systemTeal).opacity(0.55), Color(nsColor: .systemIndigo).opacity(0.35)],
                           startPoint: .top, endPoint: .bottom)
            IslandDetachedMirrorView(title: "List the extension", model: nil, placeholder: picture, onClose: {})
                .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
                .frame(width: IslandDetachedMirrorPanel.defaultSize.width, height: IslandDetachedMirrorPanel.defaultSize.height)
        }
        .frame(width: IslandDetachedMirrorPanel.defaultSize.width + 80, height: IslandDetachedMirrorPanel.defaultSize.height + 80)
        .environment(\.colorScheme, .dark)
        out.append(try write(detached, directory, "island-cu-mirror-detached@2x.png"))

        // A turn result.
        let result = IslandResultItem(id: "s1:9", sessionId: "s1",
                                      summary: "Fixed the flaky upload test: the retry now waits for the server's ack, and all 214 tests pass.",
                                      at: 0, session: IslandSessionFacts(mode: "code", title: "Fix the build"))
        let rh = NSHostingView(rootView: IslandResultContent(item: result, onOpen: {}, onDismiss: {}).environment(\.colorScheme, .dark))
        let rg = IslandLayout.cardGeometry(notched, size: CGSize(width: IslandLayout.cardWidth,
                                                                 height: max(ceil(rh.fittingSize.height), DesktopIslandGeometry.pillHeight)),
                                           rounded: true)
        let resultScene = scene(notched, width: rg.panelSize.width + 120, height: rg.panelSize.height + 20) {
            CUIslandLiquidFrame(frame: DesktopIslandFluid(geometry: rg).frame(at: DesktopIslandFluid.settle), geometry: rg,
                                hovered: false, interactive: true) {
                IslandResultContent(item: result, onOpen: {}, onDismiss: {})
            }
        }
        out.append(try write(resultScene, directory, "island-result-card@2x.png"))

        // The open island on its Watches tab.
        let store = IslandStore()
        _ = store.tabs.select(IslandTabRegistry.watches.id)
        let nowMs = 10 * 60 * 60_000
        store.activity.apply(IslandActivitySnapshot(watches: [
            IslandWatchItem(sessionId: "s1", wakeId: "wk_1", condition: "clicked", targetLabel: "Chrome — Developer Dashboard",
                            elementLabel: "“Submit for review”", armedAt: nowMs - 4 * 60_000, expiresAt: nowMs + 56 * 60_000,
                            session: IslandSessionFacts(mode: "code", title: "List the extension")),
            IslandWatchItem(sessionId: "s2", wakeId: "wk_2", condition: "appeared", targetLabel: "Mail — Inbox",
                            elementLabel: "“Message Sent”", armedAt: nowMs - 30_000, expiresAt: nowMs + 2 * 60 * 60_000,
                            session: IslandSessionFacts(mode: "dispatch")),
            IslandWatchItem(sessionId: "s3", wakeId: "wk_3", condition: "titled", targetLabel: "Xcode — Winter",
                            elementLabel: "“Build Succeeded”", armedAt: nowMs - 70 * 60_000, expiresAt: nowMs + 3 * 60 * 60_000,
                            session: IslandSessionFacts(mode: "code", title: "Ship the island")),
        ]))
        let island = IslandLayout.island(notched)
        out.append(try write(scene(notched, width: island.width + 120, height: island.height + 50) {
            IslandExpandedViewForGallery(store: store, shape: notched, size: island.size, nowMs: nowMs)
        }, directory, "island-open-watches@2x.png"))
        return out
    }

    // MARK: Pieces

    private static func pillGeometry(_ shape: IslandScreenShape) -> DesktopIslandGeometry {
        IslandLayout.cardGeometry(shape, size: CGSize(width: IslandActivityLayout.cuPillWidth, height: DesktopIslandGeometry.pillHeight),
                                  rounded: false)
    }

    private static func pillFrame(_ p: IslandCUPresentation, shape: IslandScreenShape, t: Double) -> some View {
        let g = pillGeometry(shape)
        return CUIslandLiquidFrame(frame: DesktopIslandFluid(geometry: g).frame(at: t), geometry: g, hovered: false, interactive: true) {
            IslandCUPillContent(presentation: p)
        }
    }

    private static func pill(_ p: IslandCUPresentation, shape: IslandScreenShape, t: Double) -> some View {
        let g = pillGeometry(shape)
        return scene(shape, width: g.panelSize.width + 120, height: g.panelSize.height + 20) {
            pillFrame(p, shape: shape, t: t)
        }
    }

    /// A drawn stand-in for a captured window (a browser page with a "Publish" button), nothing captured.
    private static func standInWindow() -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach([Color.red, Color.yellow, Color.green], id: \.self) { Circle().fill($0.opacity(0.8)).frame(width: 9, height: 9) }
                RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.12)).frame(height: 16).padding(.leading, 10)
            }
            .padding(10)
            .background(Color(white: 0.16))
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<6, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 3).fill(Color.black.opacity(i == 0 ? 0.55 : 0.18))
                            .frame(width: i == 0 ? 160 : CGFloat(120 + (i * 37) % 90), height: i == 0 ? 12 : 8)
                    }
                    Spacer()
                }
                Spacer()
                Capsule().fill(Color.blue).frame(width: 92, height: 28)
                    .overlay(Text("Publish").font(Typography.label(.semibold)).foregroundStyle(Color.white))
            }
            .padding(18)
            .background(Color(white: 0.95))
        }
        .frame(width: 480, height: 300)
    }

    /// A desktop backdrop, the menu bar strip and the black housing, with `content` hanging from the top centre.
    private static func scene<Content: View>(_ shape: IslandScreenShape, width: CGFloat, height: CGFloat,
                                             @ViewBuilder content: () -> Content) -> some View {
        ZStack(alignment: .top) {
            LinearGradient(colors: [Color(nsColor: .systemTeal).opacity(0.55), Color(nsColor: .systemIndigo).opacity(0.35)],
                           startPoint: .top, endPoint: .bottom)
            Rectangle().fill(Color.white.opacity(0.35)).frame(height: shape.topInset)
            if let housing = shape.housing {
                UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: 9, bottomTrailing: 9), style: .continuous)
                    .fill(Color.black).frame(width: housing.width, height: housing.height)
            }
            content()
        }
        .frame(width: width, height: height)
        .environment(\.colorScheme, .dark)
    }

    private static func renderImage<V: View>(_ view: V) throws -> CGImage {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage else { throw IslandGallery.GalleryError.cannotRender }
        return image
    }

    private static func write<V: View>(_ view: V, _ directory: URL, _ name: String) throws -> URL {
        try write(try renderImage(view), directory, name)
    }

    private static func write(_ image: CGImage, _ directory: URL, _ name: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw IslandGallery.GalleryError.cannotWrite
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw IslandGallery.GalleryError.cannotWrite }
        return url
    }

    private static func filmstrip(_ frames: [CGImage]) throws -> CGImage {
        guard let first = frames.first,
              let ctx = CGContext(data: nil, width: first.width, height: first.height * frames.count, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw IslandGallery.GalleryError.cannotRender }
        for (i, f) in frames.enumerated() {
            ctx.draw(f, in: CGRect(x: 0, y: (frames.count - 1 - i) * first.height, width: f.width, height: f.height))
        }
        guard let image = ctx.makeImage() else { throw IslandGallery.GalleryError.cannotRender }
        return image
    }
}

/// The open island laid out flat on the Watches tab at a fixed "now" (the gallery's).
private struct IslandExpandedViewForGallery: View {
    @ObservedObject var store: IslandStore
    let shape: IslandScreenShape
    let size: CGSize
    let nowMs: Int

    var body: some View {
        let target = CGRect(origin: .zero, size: size)
        IslandOpenFrame(frame: .resting(target), target: target, shape: shape) {
            VStack(spacing: 0) {
                Color.clear.frame(height: shape.topInset)
                IslandOpenHeader(store: store)
                IslandWatchesList(activity: store.activity, scrolls: false, nowMs: { nowMs })
            }
            .frame(width: size.width, height: size.height, alignment: .top)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }
}
