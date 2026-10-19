import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import WinterCUPresentation
import WinterKit
import WinterProtocol

/// The Winter island rendered OFFSCREEN (no window, nothing on screen) for looking at it without a daemon: the strip,
/// each card at rest, a rectangle's birth as a filmstrip, the waiting pill, the compacted state (the strip's count
/// alone), the open island and its morph out of the strip as a filmstrip. Written by
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

        // Two cards compacted: nothing hangs under the housing — only the strip's left wing counts them.
        let compacted = IslandStripModel(waitingCount: 2)
        let compactedStrip = IslandLayout.strip(notched)
        out.append(try write(scene(notched, width: 520, height: 120) {
            IslandStripView(model: compacted, size: compactedStrip.size, housingWidth: notched.housing?.width)
        }, directory, "island-compacted-strip@2x.png"))

        // The open island growing out of the strip: eight frames from the click to rest (closing plays them backwards).
        let morphFrames = try (0..<8).map { i in
            try renderImage(openMorphScene(store: store, shape: notched, waiting: compacted,
                                           t: IslandOpenMorph.settle * Double(i) / 7))
        }
        out.append(try write(try filmstrip(morphFrames), directory, "island-open-morph-filmstrip@2x.png"))

        // The open island, Needs you — at its ONE size, the list cut (and faded) at its edge.
        let island = IslandLayout.island(notched)
        let open = scene(notched, width: island.width + 120, height: island.height + 50) {
            IslandExpandedView(store: store, shape: notched, size: island.size, scrolls: false)
        }
        out.append(try write(open, directory, "island-open-needs-you@2x.png"))
        let empty = IslandStore()
        out.append(try write(scene(notched, width: island.width + 120, height: island.height + 50) {
            IslandExpandedView(store: empty, shape: notched, size: island.size)
        }, directory, "island-open-empty@2x.png"))
        out.append(contentsOf: try renderTabs(to: directory, shape: notched))
        return out
    }

    // MARK: - The island's shape (user 2026-10-17): fixed size, edge integration, absolute hover growth

    /// On a LIGHT desktop, where an outline or a shadow line at the screen's edge would show: the open island on every tab
    /// at its one size, its morph out of the housing as an 8-frame filmstrip, the strip (no rim), and an island card
    /// at rest beside the same card hovered (it grows by the compact Dispatch pill's points).
    static func renderShape(to directory: URL) throws -> [URL] {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var out: [URL] = []
        let notched = IslandScreenShape(housing: housing, menuBarHeight: 32)
        let plain = IslandScreenShape(housing: nil, menuBarHeight: 24)
        let files = FileManager.default.temporaryDirectory.appendingPathComponent("winter-island-shape-shelf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: files) }
        let models = sampleTabModels(now: Date(), files: files)
        // More Shelf files than fit, so its grid's scroll (cut and faded at the island's edge) shows.
        var extra: [URL] = []
        for i in 1...9 {
            let url = files.appendingPathComponent("capture-\(i).png")
            FileManager.default.createFile(atPath: url.path, contents: Data("sample".utf8))
            extra.append(url)
        }
        models.shelf.add(extra)
        models.shelf.resolveAllNow()
        let store = sampleStore()
        store.activity.apply(sampleWatches())

        for tab in IslandTabRegistry.tabs {
            store.tabs.select(tab.id)
            out.append(try write(openScene(store: store, models: models, shape: notched, tab: tab.id, light: true), directory,
                                 "shape-open-\(tab.id)@2x.png"))
        }
        store.tabs.select(IslandTabRegistry.needsYou.id)
        out.append(try write(openScene(store: store, models: models, shape: plain, tab: IslandTabRegistry.needsYou.id, light: true),
                             directory, "shape-open-no-housing@2x.png"))

        let waiting = IslandStripModel(waitingCount: 2, workingCount: 1)
        for (name, model) in [("idle", IslandStripModel(waitingCount: 0)), ("housing", waiting)] {
            let frames = try (0..<8).map { i in
                try renderImage(openMorphScene(store: store, shape: notched, waiting: model,
                                               t: IslandOpenMorph.settle * Double(i) / 7, light: true))
            }
            out.append(try write(try filmstrip(frames), directory, "shape-open-morph-from-\(name)-filmstrip@2x.png"))
        }
        let noHousingFrames = try (0..<8).map { i in
            try renderImage(openMorphScene(store: store, shape: plain, waiting: IslandStripModel(waitingCount: 1),
                                           t: IslandOpenMorph.settle * Double(i) / 7, light: true))
        }
        out.append(try write(try filmstrip(noHousingFrames), directory, "shape-open-morph-no-housing-filmstrip@2x.png"))

        for (name, shape, model) in [("housing-idle", notched, IslandStripModel(waitingCount: 0)),
                                     ("housing-waiting-working", notched, waiting),
                                     ("no-housing", plain, IslandStripModel(waitingCount: 2))] {
            guard let strip = IslandLayout.strip(shape, waiting: model.showsWings) else { continue }
            out.append(try write(scene(shape, width: 520, height: 80, light: true) {
                IslandStripView(model: model, size: strip.size, housingWidth: shape.housing?.width)
            }, directory, "shape-strip-\(name)@2x.png"))
        }

        // An island card at rest and hovered, side by side on the same backdrop.
        let approval = store.cards[0]
        let g = IslandLayout.cardGeometry(notched, size: size(of: approval, store: store), rounded: true)
        let pair = HStack(spacing: 0) {
            ForEach([false, true], id: \.self) { hovered in
                scene(notched, width: g.panelSize.width + 60, height: g.panelSize.height + 20, light: true) {
                    restingCard(approval, store: store, geometry: g, hovered: hovered)
                }
            }
        }
        out.append(try write(pair, directory, "shape-card-rest-vs-hovered@2x.png"))
        return out
    }

    /// Three armed watches (the Watches tab's sample).
    static func sampleWatches(nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> IslandActivitySnapshot {
        IslandActivitySnapshot(watches: [
            IslandWatchItem(sessionId: "s1", wakeId: "wk_1", condition: "clicked", targetLabel: "Chrome — Developer Dashboard",
                            elementLabel: "“Submit for review”", armedAt: nowMs - 4 * 60_000, expiresAt: nowMs + 56 * 60_000,
                            session: IslandSessionFacts(mode: "code", title: "List the extension")),
            IslandWatchItem(sessionId: "s2", wakeId: "wk_2", condition: "appeared", targetLabel: "Mail — Inbox",
                            elementLabel: "“Message Sent”", armedAt: nowMs - 30_000, expiresAt: nowMs + 2 * 60 * 60_000,
                            session: IslandSessionFacts(mode: "dispatch")),
            IslandWatchItem(sessionId: "s3", wakeId: "wk_3", condition: "titled", targetLabel: "Xcode — Winter",
                            elementLabel: "“Build Succeeded”", armedAt: nowMs - 70 * 60_000, expiresAt: nowMs + 3 * 60 * 60_000,
                            session: IslandSessionFacts(mode: "code", title: "Ship the island")),
        ])
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

        store.activity.apply(sampleWatches(nowMs: Int(now.timeIntervalSince1970 * 1000)))
        for (tab, name) in [(IslandTabRegistry.sessions, "sessions"), (IslandTabRegistry.shelf, "shelf"),
                            (IslandTabRegistry.usage, "usage"), (IslandTabRegistry.devices, "devices"),
                            (IslandTabRegistry.watches, "watches"), (IslandTabRegistry.servers, "servers")] {
            store.tabs.select(tab.id)
            out.append(try write(openScene(store: store, models: models, shape: shape, tab: tab.id), directory,
                                 "island-tab-\(name)@2x.png"))
        }
        // The same tabs with one unit under the pointer (the island's visual language: the hover is forced through
        // `hoverLiftPreview`, the one-shot renderer having no pointer).
        for (tab, name, ids) in hoveredSamples(models) {
            store.tabs.select(tab.id)
            out.append(try write(openScene(store: store, models: models, shape: shape, tab: tab.id, preview: ids), directory,
                                 "island-tab-\(name)-hovered@2x.png"))
        }
        // Usage and Devices cut taller (they scroll live), at rest and hovered: the cost block; the helper and a browser
        // that is not connected (its reason on the grey track).
        for (tab, name, hovered) in [(IslandTabRegistry.sessions, "sessions", ["session:s1"]),
                                     (IslandTabRegistry.usage, "usage", ["cost"]),
                                     (IslandTabRegistry.devices, "devices", ["device:cu", "device:browser-chrome"])] {
            store.tabs.select(tab.id)
            for (suffix, ids) in [("", Set<String>()), ("-hovered", Set(hovered))] {
                out.append(try write(openScene(store: store, models: models, shape: shape, tab: tab.id, preview: ids, height: 440),
                                     directory, "island-tab-\(name)-tall\(suffix)@2x.png"))
            }
        }
        // The reference the tabs are read against: the Usage tab with its plan block under the pointer.
        out.append(try renderUsageReference(to: directory, shape: shape, store: store, models: models))

        // A server's Stop waiting for its second click, and offering (then asking) a force quit beside its link — set
        // through the seam, never clicked (nothing is signalled): Stop stays on screen with the pointer elsewhere, in the
        // row's flow, so its wider capsule never covers the link.
        store.tabs.select(IslandTabRegistry.servers.id)
        for (name, phase) in [("confirm", IslandServerStopPhase.confirming(at: now)), ("forcequit", .confirmingForce(at: now))] {
            let servers = sampleServers(now: now, withLink: true)
            if let row = servers.bundles.first(where: { !servers.drills($0) })?.rows.first {
                servers.setStopsForTesting([row.id: phase])
            }
            out.append(try write(openScene(store: store, models: IslandTabModels(shelf: models.shelf, servers: servers), shape: shape,
                                           tab: IslandTabRegistry.servers.id), directory, "island-tab-servers-\(name)@2x.png"))
        }
        // A bundle's page (drilled into through the model's own `open`): at rest, with a server under the pointer, and with
        // its "Stop all" waiting for the second click (set through the seam, nothing signalled).
        let paged = sampleServers(now: now, withLink: true)
        if let bundle = paged.bundles.first(where: { $0.isBundle }) {
            paged.open(bundle)
            let pageModels = IslandTabModels(shelf: models.shelf, servers: paged)
            let member = Set(bundle.rows.prefix(1).map { "server:\($0.id)" })
            for (suffix, ids) in [("", Set<String>()), ("-hovered", member)] {
                out.append(try write(openScene(store: store, models: pageModels, shape: shape, tab: IslandTabRegistry.servers.id,
                                               preview: ids), directory, "island-tab-servers-page\(suffix)@2x.png"))
            }
            paged.setStopsForTesting([bundle.stopId: .confirming(at: now)])
            out.append(try write(openScene(store: store, models: pageModels, shape: shape, tab: IslandTabRegistry.servers.id),
                                 directory, "island-tab-servers-page-confirm@2x.png"))
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

        // The Sessions tab with nothing running.
        store.tabs.select(IslandTabRegistry.sessions.id)
        out.append(try write(openScene(store: store, models: IslandTabModels(shelf: emptyModels.shelf), shape: shape,
                                       tab: IslandTabRegistry.sessions.id), directory, "island-tab-sessions-empty@2x.png"))

        // The Watches tab with nothing armed.
        let unwatched = sampleStore()
        unwatched.tabs.select(IslandTabRegistry.watches.id)
        out.append(try write(openScene(store: unwatched, models: emptyModels, shape: shape, tab: IslandTabRegistry.watches.id),
                             directory, "island-tab-watches-empty@2x.png"))

        // The Servers tab with nothing listening.
        let noServers = IslandTabModels(shelf: emptyModels.shelf, servers: IslandServersModel())
        noServers.servers.apply([])
        store.tabs.select(IslandTabRegistry.servers.id)
        out.append(try write(openScene(store: store, models: noServers, shape: shape, tab: IslandTabRegistry.servers.id),
                             directory, "island-tab-servers-empty@2x.png"))

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

    /// The Usage tab with its Codex plan under the island's pointer (`usage-reference`), cut tall. A plan hovers through
    /// its own pointer reader and `onChange`, which a one-shot render never fires: this renderer is kept alive — a first
    /// render lays the tab out, the pointer moves onto the plan's header, and a later render draws it hovered (no
    /// animation in between).
    static func renderUsageReference(to directory: URL, shape: IslandScreenShape, store: IslandStore,
                                     models: IslandTabModels) throws -> URL {
        store.tabs.select(IslandTabRegistry.usage.id)
        let pointer = DispatchPillPointer()
        let view = openScene(store: store, models: models, shape: shape, tab: IslandTabRegistry.usage.id, height: 440)
            .coordinateSpace(name: DispatchPillView.canvasSpace)
            .environment(\.dispatchPillPointer, pointer)
            .transaction { $0.animation = nil }
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        _ = renderer.cgImage
        // Over the Codex plan's header: the scene's island starts 60 pt in, its first plan ~40 pt down.
        pointer.set(CGPoint(x: 160, y: 40))
        for _ in 0..<3 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            _ = renderer.cgImage
        }
        guard let image = renderer.cgImage else { throw GalleryError.cannotRender }
        return try write(image, directory, "usage-reference@2x.png")
    }

    /// The units drawn hovered in the tabs' hovered pictures, by tab: one row (or tile) each.
    static func hoveredSamples(_ models: IslandTabModels) -> [(IslandTab, String, Set<String>)] {
        let single = models.servers.bundles.first { !models.servers.drills($0) }?.rows.first.map { "server:\($0.id)" }
        let bundle = models.servers.bundles.first { models.servers.drills($0) }.map { "server:\($0.key)" }
        return [
            (IslandTabRegistry.sessions, "sessions", ["session:s2"]),
            (IslandTabRegistry.shelf, "shelf", Set(models.shelf.items.dropFirst().first.map { ["shelf:\($0.id)"] } ?? [])),
            (IslandTabRegistry.devices, "devices", ["device:phone-p1"]),
            (IslandTabRegistry.watches, "watches", ["watch:wk_1"]),
            (IslandTabRegistry.servers, "servers", Set([single].compactMap { $0 })),
            (IslandTabRegistry.servers, "servers-bundle", Set([bundle].compactMap { $0 })),
        ]
    }

    private static func openScene(store: IslandStore, models: IslandTabModels, shape: IslandScreenShape, tab: String,
                                  light: Bool = false, preview: Set<String> = [], height: CGFloat? = nil) -> some View {
        // The island's one size, whatever the tab (`height`: a taller cut, to see a long tab whole).
        let island = IslandLayout.island(shape)
        let size = CGSize(width: island.width, height: height ?? island.height)
        return scene(shape, width: island.width + 120, height: size.height + 50, light: light) {
            IslandExpandedView(store: store, shape: shape, size: size, scrolls: false, tabModels: models)
                .environment(\.hoverLiftPreview, preview)
        }
    }

    /// Sample data for every tab.
    static func sampleTabModels(now: Date, files: URL) -> IslandTabModels {
        let ms = { (d: TimeInterval) in (now.addingTimeInterval(d).timeIntervalSince1970 * 1000) }
        // Sessions.
        let created = { (ago: TimeInterval) in Int(ms(-ago)) }
        let rows = [
            SessionSummary(sessionId: "s1", title: "Ship the island", createdAt: created(40 * 60), scope: "global",
                           cwd: "/Users/sample/Code/winter", model: "anthropic/claude-opus-4.1",
                           signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s2", title: "Refactor the shelf store", createdAt: created(3 * 3600), scope: "global",
                           cwd: "/Users/sample/Code/winter", model: "gpt-5-codex",
                           signals: SessionSignals(attachedElsewhere: true, working: true)),
            SessionSummary(sessionId: "s3", title: "Weekly planning", createdAt: created(26 * 3600), scope: "global", mode: "chat",
                           model: "google/gemini-2.5-pro", signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s4", title: "Compare flight prices", createdAt: created(30 * 3600), scope: "global", mode: "code",
                           parentSessionId: "d1", signals: SessionSignals(attachedElsewhere: false, working: false)),
            SessionSummary(sessionId: "s5", title: "Inbox triage", createdAt: created(4 * 86400), scope: "global",
                           cwd: "/Users/sample/Mail", model: "anthropic/claude-sonnet-4.5", activity: "background",
                           signals: SessionSignals(attachedElsewhere: true, working: true)),
            SessionSummary(sessionId: "s6", title: "Book the venue", createdAt: created(31 * 3600), scope: "global", mode: "code",
                           parentSessionId: "d1", signals: SessionSignals(attachedElsewhere: false, working: false)),
        ]
        let sessions = IslandSessionsModel()
        sessions.directory = { rows }
        sessions.waiting = { ["s1"] }
        sessions.waits = { ["s1": IslandSessionWait(kind: .approval, since: now.addingTimeInterval(-2 * 60))] }
        sessions.childStatuses = { ["s4": "completed", "s6": "error"] }
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
            sessionTitle: "Ship the island", summary: UsageGallery.sampleSummary(now: now))

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
        return IslandTabModels(sessions: sessions, shelf: shelf, usage: usage, devices: devices,
                               servers: sampleServers(now: now, withLink: true))
    }

    /// Servers: two servers of one npm package (a bundle), a Python module, a Bun app — from a made-up process list (never
    /// a scan, never a probe).
    /// `withLink`: http.server and `waifus remote` answer HTTP on loopback (made-up probes — nothing is asked), so they
    /// have a link.
    static func sampleServers(now: Date, withLink: Bool = false) -> IslandServersModel {
        let start = { (ago: TimeInterval) in UInt64(now.timeIntervalSince1970 - ago) }
        let home = "/Users/sample"
        // Each in a process group of its own; the two waifus servers are one project (one bundle row).
        func process(_ pid: Int32, parent: Int32 = 1, group: Int32, ago: TimeInterval, path: String, args: [String]? = nil,
                     cwd: String, tcp: [UInt16], loopback: [UInt16: IslandLoopback] = [:]) -> ServerProcess {
            var p = ServerProcess(identity: ServerProcessIdentity(pid: pid, uid: 501, startSeconds: start(ago), startMicros: 0),
                                  ppid: parent, pgid: group, path: path, cwd: cwd, tcpPorts: tcp, arguments: args)
            p.loopback = loopback
            return p
        }
        let model = IslandServersModel()
        model.user = 501
        model.ownPid = 0
        model.home = home
        model.apply([
            process(400, group: 400, ago: 3 * 3600 + 12 * 60, path: "/opt/homebrew/bin/node",
                    args: ["node", "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus/bin/waifus.mjs", "remote"],
                    cwd: "\(home)/Code/Discord Waifus", tcp: [3888], loopback: withLink ? [3888: .v4] : [:]),
            process(401, group: 401, ago: 3 * 3600, path: "/opt/homebrew/bin/node",
                    args: ["node", "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus/bin/waifus.mjs", "start"],
                    cwd: "\(home)/Code/Discord Waifus", tcp: [61010]),
            process(410, group: 410, ago: 25 * 60, path: "/usr/bin/python3", args: ["python3", "-m", "http.server", "8000"],
                    cwd: "\(home)/Sites/portfolio", tcp: [8000], loopback: withLink ? [8000: .v4] : [:]),
            process(420, group: 420, ago: 2 * 86400, path: "/opt/homebrew/bin/bun", args: ["bun", "run", "src/index.ts"],
                    cwd: "\(home)/Code/dashboard", tcp: [3000, 3001]),
        ])
        if withLink, let row = model.rows.first(where: { $0.tcpPorts == [8000] }),
           let waifus = model.rows.first(where: { $0.tcpPorts == [3888] }) {
            model.setProbesForTesting([IslandServers.probeKey(row, 8000): IslandHTTPProbe(isHTTP: true, isHTML: true),
                                       IslandServers.probeKey(waifus, 3888): IslandHTTPProbe(isHTTP: true, isHTML: true)])
        }
        return model
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

    /// The open island `t` seconds into its morph out of the strip (drawn under it, as live), on Needs you.
    static func openMorphScene(store: IslandStore, shape: IslandScreenShape, waiting: IslandStripModel, t: Double,
                               light: Bool = false) -> some View {
        let pad = IslandController.islandPad
        let island = IslandLayout.island(shape)
        let strip = IslandLayout.strip(shape, waiting: waiting.showsWings) ?? IslandLayout.strip(shape)
        let target = CGRect(x: pad, y: 0, width: island.width, height: island.height)
        let source = strip.offsetBy(dx: island.width / 2 + pad, dy: 0)
        let morph = IslandOpenMorph(source: source, target: target, sourceCorner: IslandLayout.stripCorner,
                                    targetCorner: IslandLayout.islandCorner)
        let panel = CGSize(width: island.width + 2 * pad, height: island.height + pad)
        return scene(shape, width: panel.width + 60, height: panel.height + 10, light: light) {
            ZStack(alignment: .top) {
                IslandStripView(model: waiting, size: strip.size, housingWidth: shape.housing?.width)
                ZStack(alignment: .topLeading) {
                    IslandOpenFrame(frame: morph.frame(at: t), target: target, shape: shape) {
                        IslandExpandedContent(store: store, shape: shape, size: target.size, scrolls: false)
                    }
                }
                .frame(width: panel.width, height: panel.height, alignment: .topLeading)
            }
        }
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

    /// A desktop backdrop, the menu bar strip and the black housing, with `content` hanging from the top centre. `light`:
    /// a pale desktop and menu bar, where any outline, shadow line or gap at the screen's edge would show.
    static func scene<Content: View>(_ shape: IslandScreenShape, width: CGFloat, height: CGFloat, light: Bool = false,
                                     @ViewBuilder content: () -> Content) -> some View {
        ZStack(alignment: .top) {
            if light {
                LinearGradient(colors: [Color(white: 0.93), Color(white: 0.86)], startPoint: .top, endPoint: .bottom)
                Rectangle().fill(Color(white: 0.97)).frame(height: shape.topInset)
            } else {
                LinearGradient(colors: [Color(nsColor: .systemTeal).opacity(0.55), Color(nsColor: .systemIndigo).opacity(0.35)],
                               startPoint: .top, endPoint: .bottom)
                Rectangle().fill(Color.white.opacity(0.35)).frame(height: shape.topInset)
            }
            if let housing = shape.housing {
                UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: 9, bottomTrailing: 9), style: .continuous)
                    .fill(Color.black).frame(width: housing.width, height: housing.height)
            }
            content()
        }
        .frame(width: width, height: height)
        .environment(\.colorScheme, .dark)
    }

    static func renderImage<V: View>(_ view: V) throws -> CGImage {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage else { throw GalleryError.cannotRender }
        return image
    }

    private static func write<V: View>(_ view: V, _ directory: URL, _ name: String) throws -> URL {
        try write(try renderImage(view), directory, name)
    }

    static func write(_ image: CGImage, _ directory: URL, _ name: String) throws -> URL {
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
    static func filmstrip(_ frames: [CGImage]) throws -> CGImage {
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
