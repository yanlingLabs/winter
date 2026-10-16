import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import WinterCUPresentation
import WinterKit
import WinterProtocol

/// The Winter island rendered OFFSCREEN (no window, nothing on screen) for looking at it without a daemon: the strip,
/// each card at rest, a rectangle's birth as a filmstrip, the waiting pill, the badge and the open island. Written by
/// `IslandGalleryTests` into the folder `WINTER_ISLAND_RENDER_DIR` names (a temporary one otherwise). `ImageRenderer`
/// cannot draw AppKit-backed controls, so a text field renders as a blank.
@MainActor
enum IslandGallery {
    static let housing = CGSize(width: 185, height: 32)

    static func render(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var out: [URL] = []
        let notched = IslandScreenShape(housing: housing, menuBarHeight: 32)
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)

        for (name, shape, count) in [("strip-housing-idle", notched, 0), ("strip-housing-3", notched, 3), ("strip-no-housing-2", plain, 2)] {
            guard let strip = IslandLayout.strip(shape, waiting: count > 0) else { continue }
            let view = IslandStripView(model: IslandStripModel(waitingCount: count), size: strip.size, housingWidth: shape.housing?.width)
            out.append(try write(scene(shape, width: 520, height: 90) { view }, directory, "island-\(name)@2x.png"))
        }

        let store = sampleStore()
        for card in store.cards {
            let image = try cardImage(card, store: store, shape: notched, t: DesktopIslandFluid.settle)
            out.append(try write(image, directory, "island-card-\(card.kind)@2x.png"))
        }
        let approval = store.cards[0]
        let frames = try stride(from: 0.0, through: 1.2, by: 0.1).map { try cardImage(approval, store: store, shape: notched, t: $0) }
        out.append(try write(try filmstrip(frames), directory, "island-card-birth-filmstrip@2x.png"))
        out.append(try write(try cardImage(approval, store: store, shape: plain, t: DesktopIslandFluid.settle), directory,
                             "island-card-no-housing@2x.png"))

        // A hovered card with a newcomer waiting under it.
        let waitingGeometry = IslandLayout.cardGeometry(notched, size: size(of: approval, store: store), rounded: true)
        let waitingRect = IslandLayout.waitingRect(below: waitingGeometry)
        let withWaiting = scene(notched, width: waitingGeometry.panelSize.width + 120, height: waitingRect.maxY + 40) {
            ZStack(alignment: .topLeading) {
                restingCard(approval, store: store, geometry: waitingGeometry, hovered: true)
                IslandWaitingPill(card: store.cards[1], action: {})
                    .offset(x: waitingRect.minX, y: waitingRect.minY)
            }
            .frame(width: waitingGeometry.panelSize.width, height: waitingRect.maxY + 24, alignment: .topLeading)
        }
        out.append(try write(withWaiting, directory, "island-card-hovered-waiting@2x.png"))

        // The badge hanging from the housing.
        let badgeWidth = IslandBadge.width(for: 2)
        let badge = scene(notched, width: 520, height: 90) {
            IslandBadge(count: 2, width: badgeWidth).padding(.top, notched.topInset - IslandLayout.badgeTuck)
        }
        out.append(try write(badge, directory, "island-badge@2x.png"))

        // The open island, Needs you.
        let island = IslandLayout.island(notched, contentHeight: 520)
        let open = scene(notched, width: island.width + 120, height: island.height + 50) {
            IslandExpandedView(store: store, shape: notched, size: island.size, scrolls: false)
        }
        out.append(try write(open, directory, "island-open-needs-you@2x.png"))
        let empty = IslandStore()
        let island0 = IslandLayout.island(notched, contentHeight: 136)
        out.append(try write(scene(notched, width: island0.width + 120, height: island0.height + 50) {
            IslandExpandedView(store: empty, shape: notched, size: island0.size)
        }, directory, "island-open-empty@2x.png"))
        out.append(contentsOf: try renderTabs(to: directory, shape: notched))
        return out
    }

    // MARK: - Phase 2: the tabs

    /// Every phase-2 tab with sample data (and the empty Shelf, and the strip with working sessions). The Shelf's
    /// sample files live in a temporary folder removed afterwards; nothing else is written but the pictures.
    static func renderTabs(to directory: URL, shape: IslandScreenShape) throws -> [URL] {
        var out: [URL] = []
        let now = Date()
        let files = FileManager.default.temporaryDirectory.appendingPathComponent("winter-island-gallery-shelf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: files) }
        let models = sampleTabModels(now: now, files: files)
        let store = sampleStore()

        for (tab, name) in [(IslandTabRegistry.sessions, "sessions"), (IslandTabRegistry.shelf, "shelf"),
                            (IslandTabRegistry.usage, "usage"), (IslandTabRegistry.devices, "devices")] {
            store.tabs.select(tab.id)
            out.append(try write(openScene(store: store, models: models, shape: shape, tab: tab.id), directory,
                                 "island-tab-\(name)@2x.png"))
        }
        // The empty Shelf, and the Shelf while a drag hovers it.
        let emptyModels = IslandTabModels(shelf: IslandShelfStore(persistence: IslandShelfPersistence(
            fileURL: files.appendingPathComponent("empty-shelf.json"))))
        store.tabs.select(IslandTabRegistry.shelf.id)
        out.append(try write(openScene(store: store, models: emptyModels, shape: shape, tab: IslandTabRegistry.shelf.id),
                             directory, "island-tab-shelf-empty@2x.png"))
        emptyModels.shelf.dropTargeted = true
        out.append(try write(openScene(store: store, models: emptyModels, shape: shape, tab: IslandTabRegistry.shelf.id),
                             directory, "island-tab-shelf-drop@2x.png"))

        // The strip with waiting AND working counts, and with working only.
        for (name, waiting, working) in [("strip-housing-waiting-working", 2, 3), ("strip-housing-working", 0, 1)] {
            let model = IslandStripModel(waitingCount: waiting, workingCount: working)
            guard let strip = IslandLayout.strip(shape, waiting: model.showsWings) else { continue }
            out.append(try write(scene(shape, width: 520, height: 90) {
                IslandStripView(model: model, size: strip.size, housingWidth: shape.housing?.width)
            }, directory, "island-\(name)@2x.png"))
        }
        return out
    }

    private static func openScene(store: IslandStore, models: IslandTabModels, shape: IslandScreenShape, tab: String) -> some View {
        let host = NSHostingView(rootView: VStack(spacing: 0) { IslandTabBody(id: tab, models: models, scrolls: false) }
            .frame(width: IslandLayout.islandWidth).environment(\.colorScheme, .dark))
        let content = 46 + min(ceil(host.fittingSize.height), IslandLayout.islandMaxHeight) + 6
        let island = IslandLayout.island(shape, contentHeight: content)
        return scene(shape, width: island.width + 120, height: island.height + 50) {
            IslandExpandedView(store: store, shape: shape, size: island.size, scrolls: false, tabModels: models)
        }
    }

    /// Sample data for every tab.
    static func sampleTabModels(now: Date, files: URL) -> IslandTabModels {
        let ms = { (d: TimeInterval) in (now.addingTimeInterval(d).timeIntervalSince1970 * 1000) }
        // Sessions.
        let rows = [
            SessionSummary(sessionId: "s1", title: "Ship the island", createdAt: 5, scope: "global",
                           signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s2", title: "Refactor the shelf store", createdAt: 4, scope: "global",
                           signals: SessionSignals(attachedElsewhere: true, working: true)),
            SessionSummary(sessionId: "s3", title: "Weekly planning", createdAt: 3, scope: "global", mode: "chat",
                           signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s4", title: "Compare flight prices", createdAt: 2, scope: "global", mode: "code",
                           parentSessionId: "d1", signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s5", title: "Inbox triage", createdAt: 1, scope: "global", activity: "background",
                           signals: SessionSignals(attachedElsewhere: true, working: true)),
        ]
        let sessions = IslandSessionsModel()
        sessions.directory = { rows }
        sessions.waiting = { ["s1"] }
        sessions.childStatuses = { ["s4": "completed"] }
        sessions.windows = { IslandWindowFacts(appWindowSessionId: "s1", detachedSessionIds: ["s3"]) }
        sessions.setHostsForTesting(["s2": [IslandHost(clientName: "cli-chat", role: "harness", tty: "/dev/ttys004")],
                                     "s5": [IslandHost(clientName: "iphone-gateway", role: "remote")]])
        sessions.recompute()

        // Usage.
        let usage = IslandUsageModel()
        usage.setForTesting(IslandUsageSnapshot(
            windows: [IslandUsageWindow(rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.82,
                                        resetsAt: ms(2 * 3600 + 14 * 60), at: ms(-180), sessionId: "s2"),
                      IslandUsageWindow(rateLimitType: "seven_day", status: "allowed", utilization: 0.31,
                                        resetsAt: ms(3 * 86400 + 4 * 3600), at: ms(-180), sessionId: "s2")],
            background: .init(limited: false, inputTokens: 18_400, outputTokens: 2_150),
            session: .init(sessionId: "s1", turns: 7, inputTokens: 412_000, outputTokens: 18_300, contextTokens: 64_000,
                           contextWindow: 200_000, model: "example/model-large")),
            roles: ["titles.model": ModelRoleValue(model: "example/model-small", explicit: false, constraint: "any", permitted: [],
                                                   problem: ModelRoleProblem(reason: "rate-limited", model: "example/model-small"))],
            sessionTitle: "Ship the island")

        // Devices.
        let devices = IslandDevicesModel()
        let phone = PairRecord(phoneEndpointID: "p1", label: "Phone", createdAt: Int(now.timeIntervalSince1970) - 9 * 86400,
                               caps: [], pairingEpoch: 1, lastSeenAt: 0)
        let status = ComputerUseStatus(enabled: true, legacyComputer: false, mirror: true, privateEventPath: false,
                                       helper: ComputerUseHelperStatus(installed: true, running: true, version: "1.4.0",
                                                                       permissions: ComputerUsePermissions(accessibility: true, screenRecording: false)),
                                       browsers: [ComputerUseBrowserStatus(id: "winter", name: "Winter", connected: true),
                                                  ComputerUseBrowserStatus(id: "chrome", name: "Google Chrome", connected: false,
                                                                           reason: "Winter for Chrome is not connected in Google Chrome"),
                                                  ComputerUseBrowserStatus(id: "headless", name: "Winter (headless)", connected: true)])
        devices.setForTesting(phones: IslandDevicesPresentation.phones([phone], connected: ["p1"], mirrored: ["s2"],
                                                                       titleFor: { _ in "Refactor the shelf store" }, now: now),
                              helpers: IslandDevicesPresentation.helpers(status))

        // Shelf: three sample files (two present, one deleted after shelving — missing).
        let shelf = IslandShelfStore(persistence: IslandShelfPersistence(fileURL: files.appendingPathComponent("shelf.json")))
        var urls: [URL] = []
        for name in ["Screenshot at 09.41.12.png", "Quarterly plan.pdf", "notes.md", "draft.txt"] {
            let url = files.appendingPathComponent(name)
            FileManager.default.createFile(atPath: url.path, contents: Data("sample".utf8))
            urls.append(url)
        }
        shelf.add(urls.reversed())
        try? FileManager.default.removeItem(at: urls[3])
        shelf.resolveAllNow()
        shelf.selectedId = shelf.items.first?.id
        return IslandTabModels(sessions: sessions, shelf: shelf, usage: usage, devices: devices)
    }

    /// Three sample cards: an approval, a question and a view request (plus a link request).
    static func sampleStore() -> IslandStore {
        let store = IslandStore()
        store.clock = { 0 }
        let options = [SessionEvent.QuestionOption(label: "Keep both", description: nil, preview: nil),
                       SessionEvent.QuestionOption(label: "Use mine", description: nil, preview: nil),
                       SessionEvent.QuestionOption(label: "Use theirs", description: nil, preview: nil)]
        let question = SessionEvent.Question(question: "The merge left two versions of Package.swift. Which one should I keep?",
                                             header: "Merge", options: options, multiSelect: false)
        store.apply([
            IslandCard(callId: "c1", sessionId: "s1", answerSessionId: "s1", kind: .approval,
                       payload: .approval(toolName: "Bash", summary: "git push --force-with-lease origin feature/island",
                                          reviewerReason: nil, options: []),
                       facts: IslandSessionFacts(mode: "code", title: "Ship the island")),
            IslandCard(callId: "q1", sessionId: "s2", answerSessionId: "s2", kind: .question, payload: .question([question]),
                       facts: IslandSessionFacts(mode: "code", title: "Merge main")),
            IslandCard(callId: "v1", sessionId: "s3", answerSessionId: "s3", kind: .viewRequest,
                       payload: .viewRequest(app: "Google Chrome", bundleId: "com.google.Chrome", reason: "to click"),
                       facts: IslandSessionFacts(mode: "dispatch")),
            IslandCard(callId: "e1", sessionId: "s4", answerSessionId: "s4", kind: .elicitation,
                       payload: .elicitation(serverName: "Linear", message: "Sign in to Linear to finish connecting.",
                                             host: "linear.app", origin: "https://linear.app"),
                       facts: IslandSessionFacts(mode: "code", title: "Triage"),
                       expiresAt: Int(Date().timeIntervalSince1970 * 1000) + 600_000),
        ])
        return store
    }

    static func size(of card: IslandCard, store: IslandStore) -> CGSize {
        let host = NSHostingView(rootView: IslandRectContent(card: card, store: store).environment(\.colorScheme, .dark))
        return CGSize(width: IslandLayout.cardWidth, height: max(ceil(host.fittingSize.height), DesktopIslandGeometry.pillHeight))
    }

    private static func cardImage(_ card: IslandCard, store: IslandStore, shape: IslandScreenShape, t: Double) throws -> CGImage {
        if case .viewRequest(let app, let bundleId, let reason) = card.payload {
            let model = CUDesktopPromptModel(CUDesktopPromptRequest(promptId: card.callId, sessionId: card.answerSessionId, app: app,
                                                                    bundleId: bundleId, reason: reason, timeoutMs: 60_000), now: 0)
            let g = DesktopIslandGeometry.make(housing: shape.housing, menuBarHeight: shape.menuBarHeight,
                                               pillWidth: DesktopIslandGeometry.pillWidth(for: model.headline), slot: 0)
            let state = DesktopIslandState(secondsLeft: 43)
            state.bornAt = Date().addingTimeInterval(-t)
            state.still = true
            return try renderImage(scene(shape, width: g.panelSize.width + 120, height: g.panelSize.height + 20) {
                DesktopIslandView(model: model, geometry: g, state: state)
            })
        }
        let g = IslandLayout.cardGeometry(shape, size: size(of: card, store: store), rounded: true)
        let frame = DesktopIslandFluid(geometry: g).frame(at: t)
        return try renderImage(scene(shape, width: g.panelSize.width + 120, height: g.panelSize.height + 20) {
            CUIslandLiquidFrame(frame: frame, geometry: g, hovered: false, interactive: true) {
                IslandRectContent(card: card, store: store)
            }
        })
    }

    private static func restingCard(_ card: IslandCard, store: IslandStore, geometry: DesktopIslandGeometry, hovered: Bool) -> some View {
        CUIslandLiquidFrame(frame: DesktopIslandFluid(geometry: geometry).frame(at: DesktopIslandFluid.settle), geometry: geometry,
                            hovered: hovered, interactive: true) {
            IslandRectContent(card: card, store: store)
        }
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
        guard let image = renderer.cgImage else { throw GalleryError.cannotRender }
        return image
    }

    private static func write<V: View>(_ view: V, _ directory: URL, _ name: String) throws -> URL {
        try write(try renderImage(view), directory, name)
    }

    private static func write(_ image: CGImage, _ directory: URL, _ name: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw GalleryError.cannotWrite
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw GalleryError.cannotWrite }
        return url
    }

    enum GalleryError: Error { case cannotRender, cannotWrite }

    /// Frames stacked top to bottom.
    private static func filmstrip(_ frames: [CGImage]) throws -> CGImage {
        guard let first = frames.first,
              let ctx = CGContext(data: nil, width: first.width, height: first.height * frames.count, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw GalleryError.cannotRender }
        for (i, f) in frames.enumerated() {
            ctx.draw(f, in: CGRect(x: 0, y: (frames.count - 1 - i) * first.height, width: f.width, height: f.height))
        }
        guard let image = ctx.makeImage() else { throw GalleryError.cannotRender }
        return image
    }
}
