// ComputerV2 Phase 2 — the backends the browser engine can use (`transport.ts`'s `BackendRegistry`). Winter.app's
// browser link registers the built-in browser ("winter"); Winter for Chrome's host server registers one transport per
// extension instance. The engine only reads.
//
// IDS ARE STABLE. A backend id is assigned per `instanceKey` (the extension's instanceId; "winter" for the link) and
// kept for the daemon's lifetime: the same key always gets the same id back — an MV3 service worker restarts often,
// and `chrome:418` must stay valid across that — and a stale entry with the same key is REPLACED, never renumbered.
// Only a different key of the same family gets `#2`, `#3`, …
import { BROWSER_FAMILIES, familyInfo } from "./families";
import type { BackendId, BackendRegistry, BrowserBackendInfo, BrowserFamily, CdpTransport } from "./transport";

interface Instance {
  id: BackendId;
  family: BrowserFamily;
  instanceKey: string;
  name: string;
  bundleId?: string;
  transport?: CdpTransport;
}

const familyOrder = (f: string): number => {
  const i = BROWSER_FAMILIES.findIndex((x) => x.family === f);
  return i < 0 ? BROWSER_FAMILIES.length : i;
};
const instanceNumber = (id: string): number => {
  const n = Number(id.split("#")[1] ?? "1");
  return Number.isFinite(n) ? n : 1;
};

export class BrowserBackendRegistry implements BackendRegistry {
  private readonly byKey = new Map<string, Instance>();
  private readonly byId = new Map<BackendId, Instance>();
  /** Known-but-unconnected families (installed, or refused at hello), by family. */
  private readonly unavailable = new Map<BrowserFamily, { name: string; bundleId?: string; reason: string }>();
  private readonly listeners = new Set<() => void>();

  register(transport: CdpTransport, info: { family: BrowserFamily; name: string; bundleId?: string; instanceKey: string }): { id: BackendId; unregister(): void } {
    const key = `${info.family}\u0000${info.instanceKey}`;
    let inst = this.byKey.get(key);
    if (inst === undefined) {
      const id = this.freeId(info.family);
      inst = { id, family: info.family, instanceKey: info.instanceKey, name: info.name };
      this.byKey.set(key, inst);
      this.byId.set(id, inst);
    }
    // The same key again replaces the stale entry under the same id.
    inst.transport = transport;
    inst.name = info.name;
    if (info.bundleId !== undefined) inst.bundleId = info.bundleId;
    else delete inst.bundleId;
    this.unavailable.delete(info.family);
    this.changed();
    const registered = inst;
    return {
      id: registered.id,
      unregister: () => {
        // A replaced registration's unregister is a no-op: the newer transport stays.
        if (registered.transport !== transport) return;
        delete registered.transport;
        this.changed();
      },
    };
  }

  noteUnavailable(info: { family: BrowserFamily; name: string; bundleId?: string; reason: string }): void {
    this.unavailable.set(info.family, { name: info.name, ...(info.bundleId === undefined ? {} : { bundleId: info.bundleId }), reason: info.reason });
    this.changed();
  }

  get(id: BackendId): CdpTransport | undefined { return this.byId.get(id)?.transport; }

  /** The instance behind an id, connected or not (its family, name and bundle id). */
  info(id: BackendId): Omit<BrowserBackendInfo, "connected" | "reason"> | undefined {
    const inst = this.byId.get(id);
    return inst === undefined ? undefined : { id: inst.id, family: inst.family, name: inst.name, ...(inst.bundleId === undefined ? {} : { bundleId: inst.bundleId }) };
  }

  list(): BrowserBackendInfo[] {
    const rows: BrowserBackendInfo[] = [];
    const families = new Set<string>();
    for (const inst of this.byId.values()) {
      families.add(inst.family);
      const connected = inst.transport?.connected === true;
      rows.push({
        id: inst.id, family: inst.family, name: inst.name, ...(inst.bundleId === undefined ? {} : { bundleId: inst.bundleId }), connected,
        ...(connected ? {} : { reason: this.unavailable.get(inst.family)?.reason ?? disconnectedReason(inst.family, inst.name) }),
      });
    }
    for (const [family, u] of this.unavailable) {
      if (families.has(family)) continue;
      rows.push({ id: family, family, name: u.name, ...(u.bundleId === undefined ? {} : { bundleId: u.bundleId }), connected: false, reason: u.reason });
    }
    return rows.sort((a, b) => familyOrder(a.family) - familyOrder(b.family) || instanceNumber(a.id) - instanceNumber(b.id));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Every transport registered now (connected or not) — the engine hooks each one's events once. */
  transports(): Array<{ id: BackendId; transport: CdpTransport }> {
    const out: Array<{ id: BackendId; transport: CdpTransport }> = [];
    for (const inst of this.byId.values()) if (inst.transport !== undefined) out.push({ id: inst.id, transport: inst.transport });
    return out;
  }

  private freeId(family: BrowserFamily): BackendId {
    if (!this.byId.has(family)) return family;
    for (let n = 2; ; n++) if (!this.byId.has(`${family}#${n}`)) return `${family}#${n}`;
  }

  private changed(): void {
    for (const l of [...this.listeners]) {
      try { l(); } catch { /* a listener never breaks registration */ }
    }
  }
}

/** Why a known instance is not connected now, when nothing more specific was noted. */
export function disconnectedReason(family: string, name: string): string {
  if (family === "winter") return "Winter isn't running";
  return `Winter for Chrome is not connected in ${familyInfo(family)?.name ?? name} — ask the user`;
}
