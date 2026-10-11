// A stand-in for the engine's BackendRegistry (lane B builds the real one), written to the pinned contract in
// `browser/transport.ts`: the same instanceKey always gets the same BackendId back for the registry's lifetime
// (replacing a stale entry, never a new `#n`); a different instanceKey of the same family gets `#2`, `#3`, …; an
// `unregister()` of an entry that was replaced since is a no-op.
import type { BackendId, BackendRegistry, BrowserBackendInfo, BrowserFamily, CdpTransport } from "../../../src/computer-use/browser/transport";

interface Entry { id: BackendId; transport: CdpTransport; info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }; token: number }

export class FakeRegistry implements BackendRegistry {
  private readonly ids = new Map<string, BackendId>();
  private readonly perFamily = new Map<BrowserFamily, number>();
  private readonly entries = new Map<BackendId, Entry>();
  private readonly listeners = new Set<() => void>();
  private nextToken = 1;
  readonly unavailable: { family: BrowserFamily; name: string; bundleId?: string; reason: string }[] = [];
  readonly registrations: { id: BackendId; instanceKey: string }[] = [];

  register(transport: CdpTransport, info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }): { id: BackendId; unregister(): void } {
    const key = `${info.family}\u0000${info.instanceKey}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      const n = (this.perFamily.get(info.family) ?? 0) + 1;
      this.perFamily.set(info.family, n);
      id = n === 1 ? info.family : `${info.family}#${n}`;
      this.ids.set(key, id);
    }
    const token = this.nextToken++;
    this.entries.set(id, { id, transport, info, token });
    this.registrations.push({ id, instanceKey: info.instanceKey });
    this.changed();
    const bound = id;
    return {
      id: bound,
      unregister: () => {
        if (this.entries.get(bound)?.token !== token) return;
        this.entries.delete(bound);
        this.changed();
      },
    };
  }

  noteUnavailable(info: { family: BrowserFamily; name: string; bundleId?: string; reason: string }): void {
    this.unavailable.push(info);
    this.changed();
  }

  get(id: BackendId): CdpTransport | undefined {
    return this.entries.get(id)?.transport;
  }

  list(): BrowserBackendInfo[] {
    return [...this.entries.values()].map((e) => {
      const n = /#(\d+)$/.exec(e.id)?.[1];
      return {
        id: e.id,
        family: e.info.family,
        name: n === undefined ? e.info.name : `${e.info.name} (${n})`,
        ...(e.info.bundleId === undefined ? {} : { bundleId: e.info.bundleId }),
        connected: e.transport.connected,
      };
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}
