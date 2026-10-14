import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COWORK_RPC, ConnWriter, LineDecoder, PROTOCOL_VERSION, encodeLine, type CoworkWatchFrame, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { WinterClient } from "../../../cli/src/client";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CoworkRepository } from "../../src/cowork/repository";
import { runtimeStateOnline } from "../../src/runtime-state/wiring";
import type { CoworkHostPorts } from "../../src/cowork/service";
import { CoworkError } from "../../src/cowork/types";
let daemon: RunningDaemon | undefined;
const homes: string[] = [], clients: WinterClient[] = [], sockets: Array<{ end(): void }> = [];
afterEach(async () => { clients.splice(0).forEach(c => c.close()); sockets.splice(0).forEach(c => c.end()); if (daemon) { await daemon.stop(); daemon = undefined; } homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })); });
async function boot(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "winter-watch-rpc-")); homes.push(home);
  const ports: CoworkHostPorts = {
    principal: connection => connection.role === "harness" || connection.role === "admin" ? { kind: "local-user", id: "fixture" } : { kind: "paired-user", id: "paired", workspaceIds: new Set(), repositoryAuthorities: new Set() },
    grants: { folder: () => undefined, repository: () => undefined }, selection: () => undefined, creationCeiling: () => undefined,
    requireProvisioning: () => { throw new CoworkError("unsupported_topology"); },
  };
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null, coworkHost: ports });
  const records = new CoworkRepository(runtimeStateOnline(daemon.runtimeState)!.db);
  const ids = Array.from({ length: count }, (_, index) => records.create({ principalId: "fixture", requestId: `fixture-${index}` }, {
    ownership: "project", title: `Project-${index}`, ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" },
    sources: [{ kind: "githubRepository", label: "Repo", access: "read-write", detail: { repositoryId: "SECRET_REPOSITORY", authorityRef: "SECRET_AUTHORITY", initialRef: "main" } }],
  }).workspaceId);
  return { home, records, ids, ports };
}
async function connect(home: string) {
  const frames: CoworkWatchFrame[] = [], events: unknown[] = [];
  const client = await WinterClient.connect({ socketPath: join(home, "run/core.sock"), token: daemon!.tokens.harness, clientName: "watch-fixture", onEvent: e => events.push(e), onWorkspaceWatch: frame => frames.push(frame) });
  clients.push(client); return { client, frames, events };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2500;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
test("actual local Unix subscription and TS consumer deliver snapshot/change/terminal without sessions", async () => {
  const f = await boot(2), observer = await connect(f.home);
  const lease = await observer.client.watchWorkspaces(f.ids);
  expect(lease.renewAfterMs).toBe(20_000);
  await until(() => observer.frames.length === 2);
  expect(observer.frames.map(frame => frame.phase)).toEqual(["snapshot", "snapshot"]);
  await observer.client.cowork("workspace.update", { workspaceId: f.ids[0]!, requestId: "rename", expectedRevision: 1, title: "Renamed" });
  await until(() => observer.frames.some(frame => frame.phase === "change"));
  expect(observer.frames.at(-1)).toMatchObject({ phase: "change", seq: 3, refetchRequired: false, revisions: [{ workspaceId: f.ids[0], configRevision: 2 }] });
  expect((await lease.renew()).subscriptionId).toBe(lease.subscriptionId);
  expect(await lease.detach()).toEqual({ detached: true });
  await until(() => observer.frames.at(-1)?.phase === "ended");
  expect(observer.frames.at(-1)).toMatchObject({ reason: "detached" });
  expect(f.records.rs.db.query("SELECT count(*) AS n FROM cowork_conversations").get()).toEqual({ n: 0 });
  expect((await observer.client.listSessions()).sessions).toHaveLength(0);
  for (const secret of ["SECRET_REPOSITORY", "SECRET_AUTHORITY", "$system", "incarnationId"]) expect(JSON.stringify(observer.frames)).not.toContain(secret);
  expect(observer.events.some((e: any) => e.type === "workspace_changed")).toBe(false);
});
test("two real connections cannot renew/detach each other's watch; reconnect is fresh snapshot generation", async () => {
  const f = await boot(), first = await connect(f.home), other = await connect(f.home);
  const old = await first.client.watchWorkspaces(f.ids); await until(() => first.frames.length === 1);
  for (const method of ["workspace.watch.renew", "workspace.watch.detach"] as const) {
    await expect(other.client.cowork(method, { subscriptionId: old.subscriptionId })).rejects.toMatchObject({ rpc: { data: { code: "authority_denied" } } });
  }
  first.client.close(); await Bun.sleep(20);
  const reconnected = await connect(f.home), fresh = await reconnected.client.watchWorkspaces(f.ids);
  expect(fresh.subscriptionId).not.toBe(old.subscriptionId); await until(() => reconnected.frames.length === 1);
  expect(reconnected.frames[0]).toMatchObject({ phase: "snapshot", seq: 1 });
  await expect(reconnected.client.cowork("workspace.watch.renew", { subscriptionId: old.subscriptionId })).rejects.toMatchObject({ rpc: { data: { code: "authority_denied" } } });
  await fresh.detach();
});
test("actual RPC caps, unknown IDs, access revocation and shutdown release terminal", async () => {
  const f = await boot(), observer = await connect(f.home);
  await expect(observer.client.cowork("workspace.watch", { workspaceIds: [f.ids[0]!, "unknown"] })).rejects.toMatchObject({ rpc: { data: { code: "not_found" } } });
  const watches = await Promise.all(Array.from({ length: 4 }, () => observer.client.watchWorkspaces(f.ids)));
  await expect(observer.client.watchWorkspaces(f.ids)).rejects.toMatchObject({ rpc: { data: { code: "invalid_request" } } });
  await until(() => observer.frames.length === 4);
  f.ports.principal = () => undefined;
  f.records.updateTitle({ principalId: "fixture", requestId: "revoke", expectedRevision: 1 }, f.ids[0]!, "Forbidden");
  await until(() => observer.frames.filter(frame => frame.phase === "ended").length === 4);
  expect(observer.frames.filter(frame => frame.phase === "ended").every(frame => frame.reason === "authority_revoked")).toBe(true);
  f.ports.principal = () => ({ kind: "local-user", id: "fixture" });
  const shutdown = await observer.client.watchWorkspaces(f.ids); await until(() => observer.frames.some(frame => frame.subscriptionId === shutdown.subscriptionId));
  await daemon!.stop(); daemon = undefined;
  await until(() => observer.frames.some(frame => frame.subscriptionId === shutdown.subscriptionId && frame.phase === "ended" && frame.reason === "shutdown"));
  await Bun.sleep(20);
  // stop closes the actual Unix transport; lease no longer belongs to a connected daemon.
  await expect(observer.client.cowork("workspace.watch.renew", { subscriptionId: watches[0]!.subscriptionId })).rejects.toThrow();
});
test("paired watch methods are refused before shape validation and never silently forward a one-shot result", async () => {
  const f = await boot(), decoder = new LineDecoder();
  const replies = new Map<number, any>();
  let writer: ConnWriter;
  const socket = await Bun.connect({ unix: join(f.home, "run/core.sock"), socket: {
    data(_socket, bytes) { for (const line of decoder.push(bytes)) { const msg = JSON.parse(line); if (msg.id) replies.set(msg.id, msg); } },
    drain() { writer.onDrain(); },
  } }); sockets.push(socket); writer = new ConnWriter(socket as unknown as WritableSocket);
  writer.enqueue(encodeLine({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: PROTOCOL_VERSION, token: daemon!.tokens.remote, role: "remote", clientName: "paired-fixture" } }));
  await until(() => replies.has(1)); expect(replies.get(1).error).toBeUndefined();
  let index = 2;
  for (const method of ["workspace.watch", "workspace.watch.renew", "workspace.watch.detach"]) {
    const id = index++; writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params: { malformed: true } }));
    await until(() => replies.has(id)); expect(replies.get(id).error.code).toBe(-32001);
  }
});
test("TS consumer automatically performs a real Unix renewal after20 seconds and stops on detach", async () => {
  const f = await boot(), observer = await connect(f.home);
  const renewals: Array<{ subscriptionId: string; leaseExpiresAt: string }> = [];
  const original = observer.client.request.bind(observer.client);
  observer.client.request = async (method, params) => {
    const result = await original(method, params);
    if (method === "workspace.watch.renew") renewals.push(result);
    return result;
  };
  const lease = await observer.client.watchWorkspaces(f.ids);
  const deadline = performance.now() + 25_000;
  while (!renewals.length && performance.now() < deadline) await Bun.sleep(50);
  expect(renewals).toHaveLength(1);
  expect(renewals[0]!.subscriptionId).toBe(lease.subscriptionId);
  expect(Date.parse(renewals[0]!.leaseExpiresAt) - Date.parse(lease.leaseExpiresAt)).toBeGreaterThanOrEqual(19_900);
  await lease.detach();
  await until(() => observer.frames.at(-1)?.phase === "ended");
}, 30_000);
test("concurrent Project RPC changes reach only each separately subscribed workspace", async () => {
  const f = await boot(2), a = await connect(f.home), b = await connect(f.home);
  const [wa, wb] = await Promise.all([a.client.watchWorkspaces([f.ids[0]!]), b.client.watchWorkspaces([f.ids[1]!])]);
  await until(() => a.frames.length === 1 && b.frames.length === 1);
  await Promise.all([
    a.client.cowork("workspace.update", { workspaceId: f.ids[0]!, requestId: "a", expectedRevision: 1, title: "A" }),
    b.client.cowork("workspace.update", { workspaceId: f.ids[1]!, requestId: "b", expectedRevision: 1, title: "B" }),
  ]);
  await until(() => a.frames.some(frame => frame.phase === "change") && b.frames.some(frame => frame.phase === "change"));
  for (const [observer, workspaceId] of [[a, f.ids[0]!], [b, f.ids[1]!]] as const) {
    const changes = observer.frames.filter(frame => frame.phase === "change"); expect(changes).toHaveLength(1);
    expect(changes[0]!.revisions.map(revision => revision.workspaceId)).toEqual([workspaceId]);
  }
  expect(f.records.rs.db.query("SELECT count(*) AS n FROM cowork_conversations").get()).toEqual({ n: 0 });
  await Promise.all([wa.detach(), wb.detach()]);
});
test("consumer never installs renewal when detach or disconnect wins before watch acceptance continuation", async () => {
  const f = await boot();
  for (const race of ["detach", "disconnect"] as const) {
    const observer = await connect(f.home), original = observer.client.request.bind(observer.client);
    observer.client.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "workspace.watch") {
        if (race === "disconnect") observer.client.close();
        else {
          await original("workspace.watch.detach", { subscriptionId: result.subscriptionId });
          await until(() => observer.frames.some(frame => frame.subscriptionId === result.subscriptionId && frame.phase === "ended"));
        }
      }
      return result;
    };
    let scheduled = 0; const timer = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      if (args[1] === 20_000) scheduled++;
      return timer(...args);
    }) as typeof setTimeout;
    try { await observer.client.watchWorkspaces(f.ids); expect(scheduled).toBe(0); }
    finally { globalThis.setTimeout = timer; }
  }
});
test("W6: malformed local watch frames surface a sanitized consumer error", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-watch-decoder-")); homes.push(home);
  const path = join(home, "decoder.sock"), errors: Array<[string, unknown]> = [];
  const server = Bun.listen<{ decoder: LineDecoder }>({ unix: path, socket: {
    open(socket) { socket.data = { decoder: new LineDecoder() }; },
    data(socket, bytes) { for (const line of socket.data.decoder.push(bytes)) {
      const request = JSON.parse(line);
      socket.write(encodeLine({ jsonrpc: "2.0", id: request.id, result: { ok: true, protocolVersion: PROTOCOL_VERSION, serverVersion: "fixture" } }));
      socket.write(encodeLine({ jsonrpc: "2.0", method: "workspace.watch", params: { subscriptionId: "watch_fixture", phase: "snapshot", seq: "invalid" } }));
    } },
  } });
  try {
    const client = await WinterClient.connect({ socketPath: path, token: "fixture-only", clientName: "decoder", onEvent: () => {}, onWorkspaceWatchError: (id, error) => errors.push([id, error]) }); clients.push(client);
    await until(() => errors.length === 1);
    expect(errors[0]![0]).toBe("watch_fixture"); expect((errors[0]![1] as Error).message).toBe("invalid workspace watch frame");
    client.close();
  } finally { server.stop(true); }
});
test("W6: automatic renewal has at most two bounded retries, then succeeds on the existing Unix lease", async () => {
  const f = await boot(), errors: unknown[] = [];
  const client = await WinterClient.connect({ socketPath: join(f.home, "run/core.sock"), token: daemon!.tokens.harness, clientName: "retry", onEvent: () => {}, onWorkspaceWatchError: (_id, error) => errors.push(error) }); clients.push(client);
  const originalRequest = client.request.bind(client); let attempts = 0;
  client.request = async (method, params) => {
    if (method === "workspace.watch.renew" && ++attempts <= 2) throw new Error("fixture transient transport failure");
    return originalRequest(method, params);
  };
  const originalTimer = globalThis.setTimeout, delays: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if ([20_000, 1000, 2000].includes(args[1] ?? 0)) { delays.push(args[1]!); return originalTimer(args[0], 5, ...args.slice(2)); }
    return originalTimer(...args);
  }) as typeof setTimeout;
  try {
    const lease = await client.watchWorkspaces(f.ids);
    await until(() => attempts === 3); await lease.detach();
    expect(delays.slice(0, 3)).toEqual([20_000, 1000, 2000]); expect(errors).toHaveLength(2);
    expect(attempts).toBe(3);
  } finally { globalThis.setTimeout = originalTimer; }
});
test("W6: authority refusal never retries even if a malformed response claims retryable", async () => {
  const f = await boot(), observer = await connect(f.home), originalRequest = observer.client.request.bind(observer.client); let attempts = 0;
  observer.client.request = async (method, params) => {
    if (method === "workspace.watch.renew") { attempts++; throw Object.assign(new Error("refused"), { rpc: { code: -32001, data: { code: "authority_denied", retryable: true } } }); }
    return originalRequest(method, params);
  };
  const originalTimer = globalThis.setTimeout, delays: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if ([20_000, 1000, 2000].includes(args[1] ?? 0)) { delays.push(args[1]!); return originalTimer(args[0], 5, ...args.slice(2)); }
    return originalTimer(...args);
  }) as typeof setTimeout;
  try {
    const lease = await observer.client.watchWorkspaces(f.ids); await until(() => attempts === 1); await Bun.sleep(30);
    expect(delays).toEqual([20_000]); expect(attempts).toBe(1); await lease.detach();
  } finally { globalThis.setTimeout = originalTimer; }
});
test("W1b: live Unix hints arrive during2s of50ms writes instead of waiting for quiet", async () => {
  const f = await boot(), observed: Array<{ at: number; frame: CoworkWatchFrame }> = [];
  const client = await WinterClient.connect({ socketPath: join(f.home, "run/core.sock"), token: daemon!.tokens.harness, clientName: "steady-writer", onEvent: () => {}, onWorkspaceWatch: frame => observed.push({ at: performance.now(), frame }) }); clients.push(client);
  const lease = await client.watchWorkspaces(f.ids); await until(() => observed.some(value => value.frame.phase === "snapshot"));
  const start = performance.now();
  for (let index = 0; index < 40; index++) {
    await client.cowork("workspace.update", { workspaceId: f.ids[0]!, requestId: `live-steady-${index}`, expectedRevision: index + 1, title: `Steady-${index}` });
    await Bun.sleep(50);
  }
  const end = performance.now(), changes = observed.filter(value => value.frame.phase === "change");
  expect(changes.length).toBeGreaterThanOrEqual(3);
  expect(changes[0]!.at - start).toBeLessThan(650); //500ms deadline + ordinary host scheduler/RPC slack
  expect(changes[0]!.at).toBeLessThan(end - 1000);
  console.log(JSON.stringify({ kind: "workspace-watch-live-fairness-v1", commits: 40, intervalMs: 50,
    firstHintMs: Math.round((changes[0]!.at - start) * 1000) / 1000, hintsDuringBurst: changes.length,
    burstMs: Math.round((end - start) * 1000) / 1000 }));
  await until(() => observed.some(value => value.frame.phase === "change" && value.frame.revisions[0]?.configRevision === 41));
  await lease.detach();
}, 10_000);
