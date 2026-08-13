import NormaKit
import SwiftUI

// MARK: - Pure reconcile-eviction helpers (Phase 4d-cleanup Task 3 fix 3) — no `NormaClient`/
// `Task.sleep` involved, table-tested directly.

/// The reconcile-eviction decision for one tile id in `TilesStripModel.known`. A "live tracked" id
/// (ever observed in a `client.tiles` poll) is NEVER evicted here regardless of `contribIds` — its
/// eviction is already handled by `poll()`'s own live-removal branch when the plugin pushes
/// `tile: nil`. A SEED-ONLY id (declared via `pluginsContrib()` at `seed()` time, never yet seen in
/// a live poll) is evicted only once it's ALSO absent from a FRESH `pluginsContrib()` snapshot —
/// the server clears a plugin's contrib entry on disconnect, so seed-only + gone-from-contrib
/// together mean the plugin that seeded this tile has genuinely disconnected. A seed-only id still
/// present in the fresh snapshot is just a connected-but-quiet plugin (hasn't pushed a live tile
/// this session) — kept.
func shouldEvictSeedOnly(id: String, liveTracked: Set<String>, contribIds: Set<String>) -> Bool {
    guard !liveTracked.contains(id) else { return false }
    return !contribIds.contains(id)
}

/// True on every Nth poll tick (1-indexed: tick `every`, `2*every`, …) — the gate `poll()` uses to
/// run the (comparatively expensive, RPC-backed) reconcile pass every ~10th tick instead of every
/// single one. Pure so the cadence itself is testable without a live 500ms sleep loop.
func isReconcileTick(_ tick: Int, every: Int = 10) -> Bool {
    every > 0 && tick > 0 && tick % every == 0
}

/// Task 4 (4d-iii): the Plugin Manager's live tiles strip — seeded from `pluginsContrib()`'s
/// currently-registered tile per plugin on open, then kept current by POLLING the actor-isolated
/// `client.tiles` snapshot (NOT a second `for await client.events` consumer). `client.events` is a
/// single-consumer `AsyncStream` and the Dashboard's `NormaClient` is the app's shared MAIN client
/// (`AppDelegate.makeDashboardWiring`'s `client = model.client` — App shell T7's re-host of
/// `DashboardWindowController.init`'s same claim) — its `events` stream is already being
/// drained by `AppModel`/`SessionFeed`'s own `for await` pump. A second reader on the same stream
/// would SPLIT delivery (each event goes to whichever waiter happens to receive it), silently
/// stealing roughly half the orb's events whenever the dashboard is open. `client.tiles` has no
/// such hazard: it's kept current by `NormaClient.route()`'s OWN internal transport pump (which
/// writes `tilesStore` BEFORE yielding to `events` — see `NormaClient.swift`), so reading the
/// snapshot is always as fresh as the last update regardless of who else drains `events`.
@MainActor
final class TilesStripModel: ObservableObject {
    /// One rendered tile, keyed by plugin id (`Identifiable` for `ForEach`).
    struct PluginTile: Identifiable, Equatable {
        var id: String { pluginId }
        let pluginId: String
        var data: TileData
    }

    private let client: NormaClient
    @Published private(set) var tiles: [PluginTile] = []

    /// Merged working set — NOT simply overwritten from `client.tiles` each poll (see `poll()`'s
    /// doc comment for why a blind overwrite would wrongly drop a tile seeded from
    /// `pluginsContrib()` that hasn't been re-pushed live since this client connected).
    private var known: [String: TileData] = [:]
    /// Every plugin id ever OBSERVED present in a `client.tiles` poll — once an id is "live
    /// tracked", its later absence from a poll is a REAL removal (the plugin pushed `tile: nil`,
    /// which `NormaClient.route()` evicts from `tilesStore`); a seed-only id (declared via
    /// `pluginsContrib()` but never yet seen in a live poll) staying absent from `client.tiles`
    /// means nothing on its own — it may simply not have pushed anything since this app session's
    /// client connected.
    private var liveTrackedIds: Set<String> = []
    /// Phase 4d-cleanup Task 3 fix 3: counts `poll()` invocations (NOT wall-clock time) — drives
    /// `isReconcileTick`'s "every ~10th tick" gate for the seed-only reconcile pass below.
    private var pollTickCount = 0

    init(client: NormaClient) {
        self.client = client
    }

    /// Call once from the view's `.task` — seeds, then polls forever until the surrounding Task is
    /// cancelled (SwiftUI cancels a `.task`'s Task automatically when the view disappears, so this
    /// needs no manual stop/deinit bookkeeping).
    func start() async {
        await seed()
        while !Task.isCancelled {
            await poll()
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    private func seed() async {
        guard let entries = try? await client.pluginsContrib() else { return }
        known = [:]
        for entry in entries {
            guard let tileDict = entry.tile, let data = TileData(from: tileDict) else { continue }
            known[entry.pluginId] = data
        }
        publish()
    }

    /// Upserts every id present in the live snapshot (marking it "live tracked" along the way);
    /// evicts a "live tracked" id that's now absent (a genuine `tile: nil` removal). A seed-only id
    /// that's simply never appeared live is left untouched by this part — see `liveTrackedIds`'s
    /// doc comment — but is periodically swept by `reconcileSeedOnlyTiles()` below (Phase
    /// 4d-cleanup Task 3 fix 3), since without it a tile seeded from `pluginsContrib()` that never
    /// once appears in a live poll (e.g. the plugin was already disconnected by the time this
    /// window opened, or disconnects before ever pushing a tile) would never be evicted at all —
    /// the live-removal branch just above only ever looks at `liveTrackedIds`.
    private func poll() async {
        pollTickCount += 1
        let snapshot = await client.tiles
        for (pluginId, tile) in snapshot {
            liveTrackedIds.insert(pluginId)
            if let data = TileData(from: tile) {
                known[pluginId] = data
            } else {
                known.removeValue(forKey: pluginId)
            }
        }
        for pluginId in liveTrackedIds where snapshot[pluginId] == nil {
            known.removeValue(forKey: pluginId)
        }
        if isReconcileTick(pollTickCount) {
            await reconcileSeedOnlyTiles()
        }
        publish()
    }

    /// Runs every ~10th `poll()` tick (~5s at the 500ms cadence in `start()`): fetches a fresh
    /// `pluginsContrib()` snapshot and evicts any seed-only tile `shouldEvictSeedOnly` says is now
    /// genuinely gone. A failed fetch (daemon hiccup) is a no-op for this pass — the next tick
    /// tries again, same fail-soft posture as `seed()`/`fireAction`.
    private func reconcileSeedOnlyTiles() async {
        guard let entries = try? await client.pluginsContrib() else { return }
        let contribIds = Set(entries.map(\.pluginId))
        let liveTracked = liveTrackedIds
        // Snapshot the keys first — mutating `known` while iterating its own `.keys` view is
        // unsafe; iterating a plain `[String]` copy instead lets the loop body evict freely.
        let idsToCheck = Array(known.keys)
        for id in idsToCheck where shouldEvictSeedOnly(id: id, liveTracked: liveTracked, contribIds: contribIds) {
            known.removeValue(forKey: id)
        }
    }

    private func publish() {
        tiles = known.sorted { $0.key < $1.key }.map { PluginTile(pluginId: $0.key, data: $0.value) }
    }

    /// A tile action button's tap — pushes `tile.action {pluginId, actionId}` to the plugin's own
    /// live connection. Fire-and-forget from the UI's perspective, same posture as
    /// `ShortcutRegistry.onFire`'s `shortcutInvoke` call (AppDelegate.swift) — no result to render,
    /// a failure just means the plugin wasn't connected to receive it.
    func fireAction(pluginId: String, actionId: String) async {
        _ = try? await client.tileAction(pluginId: pluginId, actionId: actionId)
    }
}

/// The strip itself: a horizontal scroller of plugin tile cards. Adaptive colors only (`.quaternary`
/// background, `.primary`/`.secondary` text) — same opaque-window idiom as the rest of this pane
/// (`PluginManagerView`'s own tier badge / status dot rendering).
struct TilesStripView: View {
    @ObservedObject var model: TilesStripModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Live Tiles").font(Typography.label(.semibold)).foregroundStyle(.secondary)
            if model.tiles.isEmpty {
                Text("No live tiles").font(Typography.label()).foregroundStyle(.secondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(model.tiles) { tile in
                            tileCard(tile)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .task { await model.start() }
    }

    private func tileCard(_ tile: TilesStripModel.PluginTile) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                if let icon = tile.data.icon {
                    Image(systemName: icon).font(Typography.label()).foregroundStyle(.secondary)
                }
                Text(tile.data.title)
                    .font(Typography.label(.medium))
                    .lineLimit(1)
            }
            if let value = tile.data.value {
                Text(value).font(Typography.heading(.semibold))
            }
            if let progress = tile.data.progress {
                ProgressView(value: min(max(progress, 0), 1))
            }
            if !tile.data.actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(tile.data.actions, id: \.id) { action in
                        Button(action.label) {
                            Task { await model.fireAction(pluginId: tile.pluginId, actionId: action.id) }
                        }
                        .font(Typography.caption())
                    }
                }
            }
        }
        .padding(10)
        .frame(width: 150, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.quaternary))
    }
}
