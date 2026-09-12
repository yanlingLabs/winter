import { z } from "zod";
import { ShortcutRegisterParams, TileUpdateParams, ProviderRegisterParams } from "@yanlinglabs/winter-protocol";

/**
 * Latest-per-plugin storage for the three "declarative UI contribution" plugin verbs
 * (`shortcut.register`/`tile.update`/`provider.register`, design spec §3/§6) — Phase 4b Task 4
 * wires the wire handlers (ipc/server.ts) to write into this; Phase 4d (Plugin Manager UI /
 * central shortcuts + tiles, spec §6/§7) is the reader.
 *
 * Deliberately dumb: no validation beyond the wire schemas ipc/server.ts's `parseParams` already
 * applied, and the registry itself never broadcasts anything (unlike `PluginSupervisor`'s
 * connection-scoped `plugin_tool_invoke` push) — "last write wins" per plugin id, exactly like a
 * plugin process re-declaring its own shortcuts/tile/provider info on every reconnect (the SDK's
 * `serve()` re-registers everything on reconnect, Task 5's contract). Phase 4d Task 1 adds the
 * live read side: `plugins.contrib` (ipc/server.ts) reads `all()`/`get()` directly, and the
 * `plugin_tile_updated` broadcast + `clear()`-on-disconnect are driven entirely by the SERVER
 * (which owns `harnessConns`) — this registry stays a passive store with no `onChange` hook.
 */
export interface PluginContribState {
  shortcuts?: z.infer<typeof ShortcutRegisterParams>["shortcuts"];
  tile?: z.infer<typeof TileUpdateParams>["tile"];
  provider?: z.infer<typeof ProviderRegisterParams>["info"];
}

export class PluginContribRegistry {
  private byPlugin = new Map<string, PluginContribState>();

  private entry(pluginId: string): PluginContribState {
    let e = this.byPlugin.get(pluginId);
    if (!e) {
      e = {};
      this.byPlugin.set(pluginId, e);
    }
    return e;
  }

  setShortcuts(pluginId: string, shortcuts: PluginContribState["shortcuts"]): void {
    this.entry(pluginId).shortcuts = shortcuts;
  }

  setTile(pluginId: string, tile: PluginContribState["tile"]): void {
    this.entry(pluginId).tile = tile;
  }

  setProvider(pluginId: string, provider: PluginContribState["provider"]): void {
    this.entry(pluginId).provider = provider;
  }

  /** Drops a plugin's contributions entirely — Phase 4d Task 1: called on socket close() so a
   *  disconnected plugin's stale tile/shortcuts/provider info no longer shows up in `all()`/
   *  `get()`. Stays a passive store operation: the SERVER (ipc/server.ts) is responsible for
   *  broadcasting the resulting `plugin_tile_updated {tile:null}` — this registry has no
   *  visibility into `harnessConns` and deliberately never calls out on its own. */
  clear(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  get(pluginId: string): PluginContribState | undefined {
    return this.byPlugin.get(pluginId);
  }

  /** Every plugin with at least one contribution recorded — Phase 4d's read surface. */
  all(): Array<{ pluginId: string; state: PluginContribState }> {
    return [...this.byPlugin.entries()].map(([pluginId, state]) => ({ pluginId, state }));
  }
}
