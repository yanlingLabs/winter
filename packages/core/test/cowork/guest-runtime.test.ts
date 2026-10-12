import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@yanlinglabs/winter-agent-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import type { SourceSelection } from "../../src/cowork/types";
import { CoworkAuthority } from "../../src/cowork/authority";
import { CoworkGuestRuntimeSupervisor, GUEST_RUNTIME_TRANSPORT_LIMITS, type GuestRuntimeLaunch, type GuestRuntimeChannel, type GuestRuntimeTermination } from "../../src/cowork/guest-runtime";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class Chunks implements AsyncIterable<string> {
  private queue: string[] = []; private closed = false; private wake?: () => void;
  write(chunk: string) { this.queue.push(chunk); this.wake?.(); }
  end() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() { while (!this.closed || this.queue.length) { if (this.queue.length) yield this.queue.shift()!; else await new Promise<void>(r => { this.wake = r; }); } }
}
const roots: string[] = [], databases: RuntimeStateDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const home of roots.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(kind: "folder" | "repository" = "folder") {
  const home = mkdtempSync(join(tmpdir(), "winter-guest-supervisor-")); roots.push(home);
  const db = openRuntimeStateDb(home); databases.push(db); const records = new CoworkRepository(db);
  const caps = { toolClasses: ["read", "write", "execute"], hostServices: [], connectors: [], network: "none" as const };
  const selection: SourceSelection = kind === "folder" ? { kind: "folder", access: "read-write", label: "fixture", detail: { grantRef: "grant", rootIdentity: "root" } } : { kind: "githubRepository", access: "read-write", label: "arbitrary-label", detail: { repositoryId: "repo-id", authorityRef: "github-grant", initialRef: "main" } };
  const created = records.create({ principalId: "fixture", requestId: "create" }, { ownership: "project", title: "fixture", ceiling: caps,
    sources: [selection] });
  const epoch = records.beginIncarnation(created.workspaceId, "incarnation", 1), source = records.sources(created.workspaceId)[0]!;
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  records.bindConversation({ principalId: "fixture", requestId: "bind", expectedRevision: 1 }, created.workspaceId, { sessionId: "conversation", sourceId: source.sourceId, relativeCwd: "repo/subdir" });
  let revoked = false, resume = false, backend = "backend-stable";
  const authority = new CoworkAuthority(records, { folder: () => ({ rootIdentity: "root", writable: true, revoked }), repository: () => ({ readable: true, writable: true, revoked }) });
  const deps = { records, authority, identity: () => ({ backendSessionId: backend, model: "winter-test/echo", resume }), bootId: () => "12345678-1234-1234-1234-123456789abc" };
  return { home, db, records, deps, workspaceId: created.workspaceId, source, revoke: () => { revoked = true; }, resume: () => { resume = true; }, changeBackend: () => { backend = "backend-replaced"; } };
}
function channel(launch: Readonly<GuestRuntimeLaunch>) {
  const stdout = new Chunks(), stderr = new Chunks(), exit = deferred<{ code: number | null; signal: string | null }>(), proof = deferred<GuestRuntimeTermination>();
  const inputs: string[] = [], stops: boolean[] = []; let endCount = 0;
  const port: GuestRuntimeChannel = { protocolVersion: 1, scope: launch.scope, launchId: launch.launchId, stdout, stderr,
    async send(chunk) { inputs.push(chunk); }, async endInput() { endCount++; }, stop(force) { stops.push(force); }, runtimeExited: exit.promise, termination: proof.promise };
  const release = () => proof.resolve({ scope: launch.scope, launchId: launch.launchId, outcome: "confirmed-stopped", storeOwnerReleased: true });
  return { port, stdout, stderr, exit, proof, inputs, stops, release, ends: () => endCount };
}
const capability = { protocolVersion: 1, capabilities: ["confined-guest-posture-v1"], supportsConfinedGuestExecution: true };

test("guest supervision refuses absent port or unsupported image before launch", () => {
  const f = fixture(); let launches = 0;
  expect(() => new CoworkGuestRuntimeSupervisor(f.deps).spawn("conversation")).toThrow("unsupported_topology");
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, port: { open() { launches++; throw new Error("unreachable"); } }, runtimeCapability: { ...capability, supportsConfinedGuestExecution: false } });
  expect(() => host.spawn("conversation")).toThrow("unsupported_topology"); expect(launches).toBe(0);
});
test("actual SDK query frame bridge preserves chunks/control and closes stdin only after admitted writes", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>, descriptor!: Readonly<GuestRuntimeLaunch>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { descriptor = launch; wire = channel(launch); return wire.port; } } });
  const q = query({ prompt: "fixture prompt", options: { model: "winter-test/echo", sessionId: "backend-stable", cwd: f.home, persistSession: false,
    env: { SECRET_SHOULD_NOT_TRAVEL: "synthetic-not-secret" }, spawnClaudeCodeProcess: () => host.spawn("conversation") } });
  // Start the wrapper's actual parser, then send init/result split in the middle of JSON.
  const messages = (async () => { const frames: unknown[] = []; for await (const message of q) frames.push(message); return frames; })();
  void messages.catch(() => {});
  await Bun.sleep(0);
  const init = JSON.stringify({ type: "init", protocolVersion: "1.0", sessionId: "backend-stable", permissionMode: "default", cwd: descriptor.runtime.cwd, model: "winter-test/echo", tools: [] }) + "\n";
  wire.stdout.write(init.slice(0, 11)); wire.stdout.write(init.slice(11));
  await Bun.sleep(10);
  expect(wire.inputs.join("")).toContain("fixture prompt");
  const changed = q.setModel("winter-test/echo"); void changed.catch(() => {}); await Bun.sleep(0);
  const control = wire.inputs.map(chunk => JSON.parse(chunk)).find(frame => frame.type === "control_request" && frame.subtype === "set_model");
  expect(control).toBeDefined();
  wire.stdout.write(JSON.stringify({ type: "control_response", requestId: control.requestId, ok: true, payload: {} }) + "\n"); await changed;
  const result = JSON.stringify({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "guest reply" } }) + "\n";
  wire.stdout.write(result.slice(0, 17)); wire.stdout.write(result.slice(17)); wire.stdout.end(); wire.stderr.end();
  wire.exit.resolve({ code: 0, signal: null }); wire.release();
  const seen = await messages; expect(JSON.stringify(seen)).toContain("guest reply");
  expect(descriptor.runtime.executionPosture).toBe("confined-guest"); expect(descriptor.runtime.persistSession).toBe(true);
  expect(descriptor.runtime.cwd).toBe("/workspace/folders/grant/repo/subdir");
  expect(descriptor.runtime.storeHome).toBe("/workspace/.winter/conversations/conversation");
  expect(JSON.stringify(descriptor)).not.toContain(f.home); expect(JSON.stringify(descriptor)).not.toContain("SECRET_SHOULD_NOT_TRAVEL");
  expect(Object.isFrozen(descriptor.runtime)).toBe(true); await Bun.sleep(0); expect(host.retained()).toEqual([]);
});
test("EOF, runtime exit, kill and uncertain store proof cannot enable a second lifetime", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); wire.stdout.end(); for await (const _ of proc.stdout) {};
  expect(host.retained()).toHaveLength(1); expect(() => host.spawn("conversation")).toThrow("recovery_required");
  proc.kill(); wire.exit.resolve({ code: 0, signal: null }); await proc.exited;
  wire.proof.resolve({ scope: wire.port.scope, launchId: wire.port.launchId, outcome: "uncertain", storeOwnerReleased: false }); await Bun.sleep(0);
  expect(() => host.spawn("conversation")).toThrow("recovery_required"); expect(wire.stops).toEqual([false, false]);
});
test("exact independent proof enables cold continuation with stable backend/store identity", async () => {
  const f = fixture(), wires: ReturnType<typeof channel>[] = [], launches: Readonly<GuestRuntimeLaunch>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { launches.push(launch); const wire = channel(launch); wires.push(wire); return wire.port; } } });
  const first = host.spawn("conversation"); wires[0]!.exit.resolve({ code: 0, signal: null }); await first.exited;
  expect(() => host.spawn("conversation")).toThrow("recovery_required"); wires[0]!.release(); await Bun.sleep(0);
  f.resume(); host.spawn("conversation");
  expect(launches[1]!.runtime.resume).toBe("backend-stable"); expect(launches[1]!.runtime.storeHome).toBe(launches[0]!.runtime.storeHome);
  expect(launches[1]!.launchId).not.toBe(launches[0]!.launchId); expect(launches[1]!.scope.sessionId).toBe("conversation"); host.stop();
});
test("mismatched boot/channel identity and failed launch retain recovery debt", () => {
  const f = fixture(); let stops = 0;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { const wire = channel(launch); return { ...wire.port, scope: { ...launch.scope, bootId: "another-boot" }, stop() { stops++; } }; } } });
  expect(() => host.spawn("conversation")).toThrow("authority_denied"); expect(stops).toBe(1); expect(() => host.spawn("conversation")).toThrow("recovery_required");
});
test("changed grants close input admission and stale output before relay", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); f.revoke();
  expect(() => proc.stdin.write('{"type":"user","text":"stale"}\n')).toThrow("authority_denied"); expect(wire.inputs).toEqual([]); expect(wire.stops).toEqual([true]);
  wire.stdout.write("stale response\n"); await expect(proc.stdout[Symbol.asyncIterator]().next()).rejects.toThrow("recovery_required");
});
test("input ACK backpressure and split output frame limits fail closed without replay", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>; const held = deferred<void>();
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); wire.port.send = () => held.promise; return wire.port; } } });
  const proc = host.spawn("conversation"), bytes = "x".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.frameBytes - 1) + "\n";
  proc.stdin.write(bytes); proc.stdin.write(bytes); expect(() => proc.stdin.write("x")).toThrow("response_too_large");
  held.resolve(); await Bun.sleep(0); expect(host.retained()).toHaveLength(1); expect(wire.stops.length).toBeGreaterThan(0);
  const g = fixture(); let output!: ReturnType<typeof channel>;
  const second = new CoworkGuestRuntimeSupervisor({ ...g.deps, runtimeCapability: capability, port: { open(launch) { output = channel(launch); return output.port; } } }).spawn("conversation");
  const iter = second.stdout[Symbol.asyncIterator]();
  for (let i = 0; i < 4; i++) { output.stdout.write("x".repeat(GUEST_RUNTIME_TRANSPORT_LIMITS.chunkBytes)); expect((await iter.next()).done).toBe(false); }
  output.stdout.write("x"); await expect(iter.next()).rejects.toThrow("response_too_large"); expect(output.stops).toEqual([true]);
});
test("stdin end drains accepted frames in order and shutdown prevents future starts", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); proc.stdin.write("one\n"); proc.stdin.write("two\n"); proc.stdin.end(); await Bun.sleep(0);
  expect(wire.inputs).toEqual(["one\n", "two\n"]); expect(wire.ends()).toBe(1); expect(() => proc.stdin.write("three\n")).toThrow("recovery_required");
  host.stop(); expect(() => host.spawn("conversation")).toThrow("unsupported_topology"); expect(host.retained()).toHaveLength(1);
});

test.skipIf(!process.env.WINTER_TEST_GUEST_SDK)("actual candidate SDK confined posture refuses before any runtime/store init", async () => {
  const child = Bun.spawn([process.execPath, "run", "--preload", join(import.meta.dir, "../preload.ts"), join(import.meta.dir, "fixtures/guest-runtime-refusal.ts"), process.env.WINTER_TEST_GUEST_SDK!], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toBe("actual SDK confined startup refused before init and durable store creation\n");
}, 30_000);

test("wrong termination generation never clears held admission", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); wire.exit.resolve({ code: 0, signal: null }); await proc.exited;
  wire.proof.resolve({ scope: { ...wire.port.scope, leaseEpoch: wire.port.scope.leaseEpoch + 1 }, launchId: wire.port.launchId, outcome: "confirmed-stopped", storeOwnerReleased: true }); await Bun.sleep(0);
  expect(host.retained()).toHaveLength(1); expect(() => host.spawn("conversation")).toThrow("recovery_required");
});
test("policy revision changed during launch refuses transport and requests native stop", () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) {
    wire = channel(launch);
    f.records.updatePolicy({ principalId: "fixture", requestId: "narrow", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { defaultPolicy: "plan" });
    return wire.port;
  } } });
  expect(() => host.spawn("conversation")).toThrow("stale_acknowledgment"); expect(wire.stops).toEqual([true]); expect(host.retained()).toHaveLength(1);
});
test("failed input acknowledgment stops subsequent queued input instead of replaying", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>; const sent: string[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) {
    wire = channel(launch); wire.port.send = async chunk => { sent.push(chunk); throw new Error("lost write acknowledgment"); }; return wire.port;
  } } });
  const proc = host.spawn("conversation"); proc.stdin.write("first\n"); proc.stdin.write("second\n"); await Bun.sleep(0);
  expect(sent).toEqual(["first\n"]); expect(host.retained()).toHaveLength(1); expect(() => proc.stdin.write("retry\n")).toThrow("recovery_required");
});
test("two canonical conversations cannot share a backend/store lifetime by mistaken identity mapping", () => {
  const f = fixture();
  f.records.bindConversation({ principalId: "fixture", requestId: "bind-two", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { sessionId: "conversation-two", sourceId: f.source.sourceId });
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { return channel(launch).port; } } });
  host.spawn("conversation"); expect(() => host.spawn("conversation-two")).toThrow("authority_denied"); host.stop();
});

test("repository clone cwd uses canonical repository identity and durable conversation directory", () => {
  const f = fixture("repository"); let launched!: Readonly<GuestRuntimeLaunch>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { launched = launch; return channel(launch).port; } } });
  host.spawn("conversation");
  expect(launched.runtime.cwd).toBe("/workspace/repos/repo-id/repo/subdir"); expect(launched.runtime.storeHome).toBe("/workspace/.winter/conversations/conversation");
  expect(JSON.stringify(launched)).not.toContain("arbitrary-label"); expect(launched.source.sourceId).toBe(f.source.sourceId); host.stop();
});
test("canonical resume identity change blocks input without rewriting held admission identity", () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); f.changeBackend(); f.resume();
  expect(() => proc.stdin.write("do not redirect\n")).toThrow("stale_acknowledgment"); expect(wire.inputs).toEqual([]);
  expect(host.retained()[0]!.backendSessionId).toBe("backend-stable"); expect(() => host.spawn("conversation")).toThrow("recovery_required");
});
test("canonical unavailable source refuses before transport and cannot be revived by a stale ACK", () => {
  const f = fixture(); let opened = 0;
  const before = f.records.get(f.workspaceId), epoch = { workspaceId: f.workspaceId, incarnationId: before.incarnationId!, leaseEpoch: before.leaseEpoch, configRevision: before.configRevision, grantRevision: before.grantRevision };
  f.records.removeSource({ principalId: "fixture", requestId: "revoke", expectedRevision: before.configRevision }, f.workspaceId, f.source.sourceId, true);
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { opened++; return channel(launch).port; } } });
  expect(() => host.spawn("conversation")).toThrow("source_unavailable");
  expect(() => f.records.acknowledgeSource(epoch, f.source.sourceId, f.source.revision, "ready")).toThrow("stale_acknowledgment"); expect(opened).toBe(0);
});


test("channel generation cannot be rebound after the initial scope acknowledgment", () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); wire.port.scope = { ...wire.port.scope, sessionId: "another-conversation" };
  expect(() => proc.stdin.write("cannot rebind\n")).toThrow("authority_denied"); expect(wire.inputs).toEqual([]); expect(host.retained()[0]!.sessionId).toBe("conversation");
});


test("malformed native teardown receipt remains held without an unhandled error", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"); wire.exit.resolve({ code: 0, signal: null }); await proc.exited;
  wire.proof.resolve(null as unknown as GuestRuntimeTermination); await Bun.sleep(0);
  expect(() => host.spawn("conversation")).toThrow("recovery_required");
});
