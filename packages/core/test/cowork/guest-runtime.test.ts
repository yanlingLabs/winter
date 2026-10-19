import { authorityFixtureSessions } from "./committed-sessions";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@yanlinglabs/winter-agent-sdk";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../src/runtime-state/db";
import { CoworkRepository } from "../../src/cowork/repository";
import type { CapabilityCeiling, SourceSelection } from "../../src/cowork/types";
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
  records.bindConversation({ principalId: "fixture", requestId: "bind", expectedRevision: 1 }, created.workspaceId, { sessionId: "conversation", sourceId: source.sourceId, relativeCwd: "repo/subdir" }, authorityFixtureSessions("conversation"));
  let revoked = false, resume = false, backend = "backend-stable", model = "winter-test/echo", boot = "12345678-1234-1234-1234-123456789abc", root = "root";
  const authority = new CoworkAuthority(records, { folder: () => ({ rootIdentity: root, writable: true, revoked }), repository: () => ({ readable: true, writable: true, revoked }) });
  const deps = { records, authority, identity: () => ({ backendSessionId: backend, model, resume }), bootId: () => boot };
  return { home, db, records, deps, workspaceId: created.workspaceId, source, revoke: () => { revoked = true; }, resume: () => { resume = true; }, changeBackend: () => { backend = "backend-replaced"; }, changeModel: () => { model = "winter-test/replaced"; }, changeBoot: () => { boot = "12345678-1234-1234-1234-123456789abd"; }, replaceRoot: () => { root = "replaced-root"; } };
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
  expect(() => host.spawn("conversation")).toThrow("recovery_required"); wires[0]!.release(); wires[0]!.stdout.end();
  for await (const _ of first.stdout) {}
  await Bun.sleep(0);
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
test("effective ceiling narrowing during launch refuses transport and requests native stop", () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) {
    wire = channel(launch);
    f.records.updatePolicy({ principalId: "fixture", requestId: "narrow", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" } });
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
  f.records.bindConversation({ principalId: "fixture", requestId: "bind-two", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { sessionId: "conversation-two", sourceId: f.source.sourceId }, authorityFixtureSessions("conversation-two"));
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { return channel(launch).port; } } });
  host.spawn("conversation"); expect(() => host.spawn("conversation-two")).toThrow("authority_denied"); host.stop();
});

test("repository clone cwd uses canonical repository identity and durable conversation directory", () => {
  const f = fixture("repository"); let launched!: Readonly<GuestRuntimeLaunch>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { launched = launch; return channel(launch).port; } } });
  host.spawn("conversation");
  expect(launched.runtime.cwd).toBe("/workspace/repos/repo-id/repo/subdir"); expect(launched.runtime.storeHome).toBe("/workspace/.winter/conversations/conversation");
  expect(JSON.stringify(launched)).not.toContain("arbitrary-label"); expect(launched.source!.sourceId).toBe(f.source.sourceId); host.stop();
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

test("actual SDK buffered permission/result holds the original lifetime through exit-before-drain", async () => {
  const f=fixture();f.resume();const wires: ReturnType<typeof channel>[]=[];
  const host=new CoworkGuestRuntimeSupervisor({...f.deps,runtimeCapability:capability,port:{open(launch){const wire=channel(launch);wires.push(wire);return wire.port;}}});
  let handled=0;
  const q=query({prompt:"old prompt",options:{model:"winter-test/echo",sessionId:"backend-stable",cwd:f.home,persistSession:false,canUseTool:async()=>{handled++;return {behavior:"deny",message:"synthetic review refusal"};},spawnClaudeCodeProcess:()=>host.spawn("conversation")}});
  const old=wires[0]!;
  old.stdout.write(JSON.stringify({type:"init",protocolVersion:"1.0",sessionId:"backend-stable",permissionMode:"default",cwd:"/workspace/folders/grant/repo/subdir",model:"winter-test/echo",tools:[]})+"\n");
  old.stdout.write(JSON.stringify({type:"control_request",requestId:"old-control",subtype:"permission",payload:{requestId:"old-control",toolName:"Bash",input:{command:"true"},toolUseId:"old-tool",suggestions:[]}})+"\n");
  old.stdout.write(JSON.stringify({type:"data",message:{type:"result",subtype:"success",is_error:false,result:"old buffered result"}})+"\n");
  old.stdout.end();old.stderr.end();old.exit.resolve({code:0,signal:null});old.release();await Bun.sleep(0);
  expect(host.retained()).toHaveLength(1);expect(() => host.spawn("conversation")).toThrow("recovery_required");
  const frames=[];for await(const frame of q)frames.push(frame);
  expect(handled).toBe(1);expect(JSON.stringify(frames)).toContain("old buffered result");
  await Bun.sleep(0);expect(host.retained()).toHaveLength(0);host.spawn("conversation");expect(host.retained()).toHaveLength(1);host.stop();
});

test("unconsumed cancellation fences old query bytes before a replacement and late old callbacks cannot remove it", async () => {
  const f = fixture(); f.resume(); const wires: ReturnType<typeof channel>[] = []; let handled = 0;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { const wire = channel(launch); wires.push(wire); return wire.port; } } });
  let original!: ReturnType<typeof host.spawn>;
  const q = query({ prompt: "abandoned", options: { model: "winter-test/echo", sessionId: "backend-stable", cwd: f.home, persistSession: false,
    canUseTool: async () => { handled++; return { behavior: "deny", message: "unreachable" }; },
    spawnClaudeCodeProcess: () => { original = host.spawn("conversation"); return original; },
  } });
  const old = wires[0]!;
  old.stdout.write(JSON.stringify({ type: "init", protocolVersion: "1.0", sessionId: "backend-stable", permissionMode: "default", cwd: "/workspace/folders/grant/repo/subdir", model: "winter-test/echo", tools: [] }) + "\n");
  old.stdout.write(JSON.stringify({ type: "control_request", requestId: "old-control", subtype: "permission", payload: { toolName: "Bash", input: { command: "true" }, toolUseId: "old-tool", suggestions: [] } }) + "\n");
  old.stdout.end(); old.stderr.end(); original.kill(); old.exit.resolve({ code: 0, signal: null }); old.release(); await Bun.sleep(0);
  expect(host.retained()).toHaveLength(0); const replacement = host.spawn("conversation");
  const seen: unknown[] = []; await expect((async () => { for await (const frame of q) seen.push(frame); })()).rejects.toThrow();
  expect(handled).toBe(0); expect(seen).toEqual([]); expect(host.retained()).toHaveLength(1);
  expect(() => original.stdin.write("late old write\n")).toThrow("recovery_required"); original.kill("SIGKILL"); await Bun.sleep(0);
  expect(host.retained()).toHaveLength(1); expect(wires[1]!.stops).toEqual([]); replacement.kill(); host.stop();
});
test("primary iterator return before first next fences output but still requires native store proof", async () => {
  const f = fixture(); const wires: ReturnType<typeof channel>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { const wire = channel(launch); wires.push(wire); return wire.port; } } });
  const proc = host.spawn("conversation"), iterator = proc.stdout[Symbol.asyncIterator](); await iterator.return!();
  expect(() => proc.stdin.write("after close\n")).toThrow("recovery_required"); expect(() => host.spawn("conversation")).toThrow("recovery_required");
  wires[0]!.exit.resolve({ code: 0, signal: null }); wires[0]!.release(); await Bun.sleep(0); host.spawn("conversation");
  await iterator.return!(); proc.kill(); await Bun.sleep(0); expect(host.retained()).toHaveLength(1); expect(wires[1]!.stops).toEqual([]); host.stop();
});
test("started consumer cancellation keeps admitted buffered chunks held until return", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"), iterator = proc.stdout[Symbol.asyncIterator](); wire.stdout.write("buffered frame\n"); await iterator.next();
  wire.exit.resolve({ code: 0, signal: null }); wire.release(); await Bun.sleep(0); proc.kill();
  expect(() => host.spawn("conversation")).toThrow("recovery_required"); await iterator.return!(); await Bun.sleep(0); expect(host.retained()).toEqual([]);
});

test("canceling an opened but unconsumed primary stream fences it without requiring a first next", async () => {
  const f = fixture(); const wires: ReturnType<typeof channel>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { const wire = channel(launch); wires.push(wire); return wire.port; } } });
  const proc = host.spawn("conversation"), iterator = proc.stdout[Symbol.asyncIterator](); proc.kill();
  wires[0]!.exit.resolve({ code: 0, signal: null }); wires[0]!.release(); await Bun.sleep(0); host.spawn("conversation");
  await expect(iterator.next()).rejects.toThrow("recovery_required"); expect(host.retained()).toHaveLength(1); expect(wires[1]!.stops).toEqual([]); host.stop();
});
test("old pending input acknowledgments cannot send queued callbacks to or delete a replacement", async () => {
  const f = fixture(), held = deferred<void>(), wires: ReturnType<typeof channel>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) {
    const wire = channel(launch); if (!wires.length) wire.port.send = async chunk => { wire.inputs.push(chunk); await held.promise; }; wires.push(wire); return wire.port;
  } } });
  const proc = host.spawn("conversation"); proc.stdin.write("old one\n"); proc.stdin.write("old two\n"); await Bun.sleep(0);
  proc.kill(); wires[0]!.exit.resolve({ code: 0, signal: null }); wires[0]!.release(); await Bun.sleep(0); host.spawn("conversation");
  held.resolve(); await Bun.sleep(0); expect(wires[0]!.inputs).toEqual(["old one\n"]); expect(wires[1]!.inputs).toEqual([]);
  expect(host.retained()).toHaveLength(1); expect(wires[1]!.stops).toEqual([]); host.stop();
});
test("primary iterator throw fences delivery but never substitutes for native store proof", async () => {
  const f = fixture(); const wires: ReturnType<typeof channel>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { const wire = channel(launch); wires.push(wire); return wire.port; } } });
  const proc = host.spawn("conversation"), iterator = proc.stdout[Symbol.asyncIterator]();
  await expect(iterator.throw!(new Error("consumer failed"))).rejects.toThrow("consumer failed");
  expect(() => host.spawn("conversation")).toThrow("recovery_required");
  wires[0]!.exit.resolve({ code: 0, signal: null }); wires[0]!.release(); await Bun.sleep(0); host.spawn("conversation");
  await expect(iterator.throw!(new Error("late throw"))).rejects.toThrow("late throw"); expect(wires[1]!.stops).toEqual([]); expect(host.retained()).toHaveLength(1); host.stop();
});


test("actual SDK stream finishes across rename, instructions, unrelated sources, defaults and resume/model refresh", async () => {
  const f = fixture(), wires: ReturnType<typeof channel>[] = [], launches: Readonly<GuestRuntimeLaunch>[] = [];
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { launches.push(launch); const wire = channel(launch); wires.push(wire); return wire.port; } } });
  const q = query({ prompt: "continue through metadata", options: { model: "winter-test/echo", sessionId: "backend-stable", cwd: f.home, persistSession: false, spawnClaudeCodeProcess: () => host.spawn("conversation") } });
  const wire = wires[0]!, frames: unknown[] = [];
  const finished = (async () => { for await (const frame of q) frames.push(frame); })(); void finished.catch(() => {});
  wire.stdout.write(JSON.stringify({ type: "init", protocolVersion: "1.0", sessionId: "backend-stable", permissionMode: "default", cwd: launches[0]!.runtime.cwd, model: "winter-test/echo", tools: [] }) + "\n");
  await Bun.sleep(10); expect(wire.inputs.join("")).toContain("continue through metadata");
  // Rename/instruction APIs are absent here; mutate their canonical isolated DB records.
  f.db.db.query("UPDATE cowork_workspaces SET title=?,config_revision=config_revision+1,instruction_revision=instruction_revision+1 WHERE workspace_id=?").run("renamed", f.workspaceId);
  const context = (requestId: string) => ({ principalId: "fixture", requestId, expectedRevision: f.records.get(f.workspaceId).configRevision });
  const extra = f.records.addSource(context("unrelated-add"), f.workspaceId, { kind: "folder", access: "read-only", label: "other", detail: { grantRef: "other", rootIdentity: "root" } }).value;
  f.records.removeSource(context("unrelated-remove"), f.workspaceId, extra.sourceId);
  f.records.updatePolicy(context("new-default"), f.workspaceId, { defaultPolicy: "plan", publication: "manual" }); f.resume(); f.changeModel();
  wire.stdout.write(JSON.stringify({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "completed original turn" } }) + "\n");
  wire.stdout.end(); wire.stderr.end(); wire.exit.resolve({ code: 0, signal: null }); wire.release(); await finished; await Bun.sleep(0);
  expect(JSON.stringify(frames)).toContain("completed original turn"); expect(wire.stops).not.toContain(true); expect(host.retained()).toEqual([]); host.spawn("conversation");
  expect(launches[0]!.runtime.resume).toBeUndefined(); expect(launches[0]!.runtime.model).toBe("winter-test/echo");
  expect(launches[1]!.runtime.resume).toBe("backend-stable"); expect(launches[1]!.runtime.model).toBe("winter-test/replaced");
  expect(launches[1]!.scope.instructionRevision).toBe(launches[0]!.scope.instructionRevision + 1);
  expect(launches[1]!.runtime.permissionMode).toBe(launches[0]!.runtime.permissionMode); host.stop();
});

test("equal or wider ceiling permits streaming without widening the admitted launch", async () => {
  const f = fixture(), full = f.records.policy(f.workspaceId).ceiling;
  f.records.updatePolicy({ principalId: "fixture", requestId: "initial-narrow", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: { ...full, toolClasses: ["read"] } });
  let wire!: ReturnType<typeof channel>, launch!: Readonly<GuestRuntimeLaunch>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(value) { launch = value; wire = channel(value); return wire.port; } } });
  const proc = host.spawn("conversation"), stream = proc.stdout[Symbol.asyncIterator](); wire.stdout.write("before\n"); expect((await stream.next()).value).toBe("before\n");
  const changes: [string, CapabilityCeiling][] = [["equal", { ...full, toolClasses: ["read"] }], ["wider", full]];
  for (const [requestId, ceiling] of changes) {
    f.records.updatePolicy({ principalId: "fixture", requestId, expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling });
    proc.stdin.write(requestId + "\n"); wire.stdout.write(requestId + "\n"); expect((await stream.next()).value).toBe(requestId + "\n");
  }
  await Bun.sleep(0); expect(wire.inputs).toEqual(["equal\n", "wider\n"]); expect(launch.capabilities.toolClasses).toEqual(["read"]); expect(wire.stops).toEqual([]); await stream.return!(); host.stop();
});

for (const replacement of ["narrower", "incomparable"] as const) test(`mid-stream ${replacement} ceiling stops buffered output and queued input`, async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"), stream = proc.stdout[Symbol.asyncIterator](); wire.stdout.write("before\n"); await stream.next();
  const full = f.records.policy(f.workspaceId).ceiling;
  f.records.updatePolicy({ principalId: "fixture", requestId: replacement, expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: { ...full, toolClasses: ["read", ...(replacement === "incomparable" ? ["different"] : [])] } });
  wire.stdout.write("must not relay\n"); await expect(stream.next()).rejects.toThrow("stale_acknowledgment");
  expect(() => proc.stdin.write("must not send\n")).toThrow("recovery_required"); expect(wire.inputs).toEqual([]); expect(wire.stops).toContain(true); expect(host.retained()).toHaveLength(1);
});

for (const change of ["boot", "lease", "source-revocation", "root-replacement", "source-replacement", "binding-policy"] as const) test(`mid-stream ${change} stops the captured lifetime`, async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"), stream = proc.stdout[Symbol.asyncIterator](); wire.stdout.write("before\n"); await stream.next();
  if (change === "boot") f.changeBoot();
  else if (change === "lease") f.db.db.query("UPDATE cowork_workspaces SET lease_epoch=lease_epoch+1 WHERE workspace_id=?").run(f.workspaceId);
  else if (change === "source-revocation") f.records.removeSource({ principalId: "fixture", requestId: "own-revoke", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, f.source.sourceId, true);
  else if (change === "root-replacement") {
    f.replaceRoot(); f.db.db.query("UPDATE cowork_sources SET detail_json=? WHERE source_id=?").run(JSON.stringify({ grantRef: "grant", rootIdentity: "replaced-root" }), f.source.sourceId);
  } else if (change === "source-replacement") f.db.db.query("UPDATE cowork_sources SET location_id=? WHERE source_id=?").run("replaced-location", f.source.sourceId);
  else f.db.db.query("UPDATE cowork_conversations SET policy=? WHERE session_id=?").run("plan", "conversation");
  wire.stdout.write("must not relay\n"); await expect(stream.next()).rejects.toThrow(); expect(wire.stops).toContain(true);
  expect(() => proc.stdin.write("must not send\n")).toThrow("recovery_required"); expect(() => host.spawn("conversation")).toThrow("recovery_required");
});


test("narrowed authority prevents an already queued send after the preceding ACK", async () => {
  const f = fixture(), held = deferred<void>(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) {
    wire = channel(launch); wire.port.send = async chunk => { wire.inputs.push(chunk); await held.promise; }; return wire.port;
  } } });
  const proc = host.spawn("conversation"); proc.stdin.write("first\n"); proc.stdin.write("queued\n"); await Bun.sleep(0);
  const full = f.records.policy(f.workspaceId).ceiling;
  f.records.updatePolicy({ principalId: "fixture", requestId: "queued-narrow", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: { ...full, toolClasses: ["read"] } });
  held.resolve(); await Bun.sleep(0); expect(wire.inputs).toEqual(["first\n"]); expect(wire.stops).toContain(true); expect(host.retained()).toHaveLength(1);
});

for (const axis of ["hostServices", "connectors", "network"] as const) test(`mid-stream ${axis} authority narrowing is denied`, async () => {
  const f = fixture(), initial = { toolClasses: ["read"], hostServices: ["host-fixture"], connectors: ["connector-fixture"], network: "internet" as const };
  // Current API fixes binding restrictions at creation; set a canonical richer binding fixture
  // before admission so every ceiling axis is exercised independently.
  f.db.db.query("UPDATE cowork_conversations SET restrictions_json=? WHERE session_id=?").run(JSON.stringify(initial), "conversation");
  f.records.updatePolicy({ principalId: "fixture", requestId: "initial-rich", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: initial });
  let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation"), stream = proc.stdout[Symbol.asyncIterator](); wire.stdout.write("before\n"); await stream.next();
  const narrower = { ...initial, [axis]: axis === "network" ? "none" : [] };
  f.records.updatePolicy({ principalId: "fixture", requestId: "axis-narrow", expectedRevision: f.records.get(f.workspaceId).configRevision }, f.workspaceId, { ceiling: narrower });
  wire.stdout.write("denied\n"); await expect(stream.next()).rejects.toThrow("stale_acknowledgment"); expect(wire.stops).toContain(true);
});

test("D3b: a launch admitted for one location never spawns as the other; an outputs launch carries no source", () => {
  // A source conversation turned into an outputs row between admission and spawn: stale.
  const f = fixture();
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { return channel(launch).port; } } });
  const prepared = host.prepareQuery("conversation");
  expect(prepared.launch.source).not.toBeNull();
  f.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id='conversation'");
  expect(() => prepared.spawn()).toThrow("stale_acknowledgment");
  // An outputs conversation's launch: no source, cwd its own outputs folder; turned into a source row before spawn: stale.
  const g = fixture();
  g.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id='conversation'");
  const outputsHost = new CoworkGuestRuntimeSupervisor({ ...g.deps, runtimeCapability: capability, port: { open(launch) { return channel(launch).port; } } });
  const outputs = outputsHost.prepareQuery("conversation");
  expect(outputs.launch.source).toBeNull();
  expect(outputs.launch.runtime.cwd).toBe("/workspace/outputs/conversation");
  g.db.db.run("UPDATE cowork_conversations SET location_kind='source', source_id=?, relative_cwd='.' WHERE session_id='conversation'", [g.source.sourceId]);
  expect(() => outputs.spawn()).toThrow("stale_acknowledgment");
});

test("D3b: a running lifetime whose conversation changes location is stale at its next input, either way", async () => {
  const f = fixture(); let wire!: ReturnType<typeof channel>;
  const host = new CoworkGuestRuntimeSupervisor({ ...f.deps, runtimeCapability: capability, port: { open(launch) { wire = channel(launch); return wire.port; } } });
  const proc = host.spawn("conversation");
  f.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id='conversation'");
  expect(() => proc.stdin.write("x\n")).toThrow("stale_acknowledgment"); expect(wire.inputs).toEqual([]);
  const g = fixture(); let outputsWire!: ReturnType<typeof channel>;
  g.db.db.run("UPDATE cowork_conversations SET location_kind='outputs', source_id=NULL, relative_cwd='.' WHERE session_id='conversation'");
  const outputsHost = new CoworkGuestRuntimeSupervisor({ ...g.deps, runtimeCapability: capability, port: { open(launch) { outputsWire = channel(launch); return outputsWire.port; } } });
  const outputs = outputsHost.spawn("conversation");
  outputs.stdin.write("ok\n"); await Bun.sleep(0);
  expect(outputsWire.inputs).toEqual(["ok\n"]);
  g.db.db.run("UPDATE cowork_conversations SET location_kind='source', source_id=?, relative_cwd='.' WHERE session_id='conversation'", [g.source.sourceId]);
  expect(() => outputs.stdin.write("x\n")).toThrow("stale_acknowledgment");
});
