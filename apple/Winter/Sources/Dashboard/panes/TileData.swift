import WinterKit
import WinterProtocol

/// Unifies the two independent tile-JSON shapes a plugin's declarative tile can arrive in (Phase
/// 4d-iii Task 4) into one struct `TilesStripView` renders — regardless of source:
///   - `pluginsContrib()`'s `PluginContribEntry.tile` — WinterKit's `JSONValue` (a JSON-RPC result
///     field, decoded by the WinterKit module).
///   - the live `plugin_tile_updated` event's `tile` — WinterProtocol's `SessionEvent.JSONValue` (a
///     wire event payload, decoded by the WinterProtocol module).
/// These are TWO DISTINCT Swift types (the module split between WinterKit/WinterProtocol — see
/// `WinterClient.swift`'s doc comments on `tilesStore`/`PluginContribEntry.tile`), so there are two
/// failable initializers below, one per source — but both apply the IDENTICAL parse rule against
/// the same declarative schema (`{title, value?, icon?, progress?, actions?: [{id, label}]}`), so
/// equivalent JSON from either source produces an equal `TileData` (see `TileAdapterTests`).
///
/// `title` is the only required field — a tile with a missing or non-string `title` fails to parse
/// (`nil`), since there's nothing sensible to render as the card's header. Every other field
/// degrades to `nil`/empty on a type mismatch or absence, rather than failing the whole tile — a
/// plugin sending a slightly-malformed `progress`/`icon` shouldn't hide its `title`/`value`.
struct TileData: Equatable {
    /// One of the tile's action buttons (`{id, label}`) — `id` is what `tileAction(pluginId:actionId:)`
    /// sends back to the plugin; `label` is the button's display text.
    struct Action: Equatable {
        let id: String
        let label: String
    }

    let title: String
    let value: String?
    let icon: String?
    let progress: Double?
    let actions: [Action]

    /// From `pluginsContrib()`'s `PluginContribEntry.tile` (WinterKit `JSONValue`).
    init?(from tile: [String: JSONValue]) {
        guard case .string(let title)? = tile["title"] else { return nil }
        self.title = title
        if case .string(let v)? = tile["value"] { value = v } else { value = nil }
        if case .string(let i)? = tile["icon"] { icon = i } else { icon = nil }
        if case .number(let p)? = tile["progress"] { progress = p } else { progress = nil }
        if case .array(let arr)? = tile["actions"] {
            actions = arr.compactMap { entry -> Action? in
                guard case .object(let o) = entry,
                      case .string(let id)? = o["id"],
                      case .string(let label)? = o["label"] else { return nil }
                return Action(id: id, label: label)
            }
        } else {
            actions = []
        }
    }

    /// From the live `plugin_tile_updated` event's tile (WinterProtocol `SessionEvent.JSONValue`) —
    /// mirrors the initializer above field-for-field, same parse rule, different source type.
    init?(from tile: [String: SessionEvent.JSONValue]) {
        guard case .string(let title)? = tile["title"] else { return nil }
        self.title = title
        if case .string(let v)? = tile["value"] { value = v } else { value = nil }
        if case .string(let i)? = tile["icon"] { icon = i } else { icon = nil }
        if case .number(let p)? = tile["progress"] { progress = p } else { progress = nil }
        if case .array(let arr)? = tile["actions"] {
            actions = arr.compactMap { entry -> Action? in
                guard case .object(let o) = entry,
                      case .string(let id)? = o["id"],
                      case .string(let label)? = o["label"] else { return nil }
                return Action(id: id, label: label)
            }
        } else {
            actions = []
        }
    }
}
