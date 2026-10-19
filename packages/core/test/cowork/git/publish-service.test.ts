import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntimeStateDb, type RuntimeStateDb } from "../../../src/runtime-state/db";
import { CoworkRepository } from "../../../src/cowork/repository";
import { CoworkAuthority } from "../../../src/cowork/authority";
import { CurrentCoworkPublicationAuthority } from "../../../src/cowork/git/authority";
import { CoworkGitPublicationBroker, type BrokerOptions } from "../../../src/cowork/git/broker";
import { IsolatedGitExecutor, resolveGitExecutable } from "../../../src/cowork/git/executor";
import { CanonicalPublicationJournal } from "../../../src/cowork/git/journal";
import { publishBundlePath, pullPublishBundle, type PublishBundleBinding, type PublishBundleChunk, type PublishBundlePort, type PublishBundleStat } from "../../../src/cowork/git/publish-intake";
import { createCoworkPublishService, type CoworkPublishPorts, type PublishCaller, type PublishInput } from "../../../src/cowork/git/publish-service";
import { GitPublicationError, type PublicationTransport } from "../../../src/cowork/git/types";
import { createCoworkGuestFileClient, parseCoworkGuestFileRequest, type CoworkGuestFileClient } from "../../../src/cowork/guest-file-channel";
import { authorityFixtureSessions } from "../committed-sessions";
import { GitFixtureLifetime } from "./fixture-lifetime";

// Each fixture builds real Git repositories; several tests build more than one.
setDefaultTimeout(30_000);
const roots: string[] = [], dbs: RuntimeStateDb[] = [], lifetimes: GitFixtureLifetime[] = [];
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map(lifetime => lifetime.close()));
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const GENERATION = "a".repeat(64);
const SECRET = "guest-secret-do-not-leak";

/** A scripted guest: files by relative path, with hooks to misbehave. Every call is recorded. */
class FakeGuest implements PublishBundlePort {
  files = new Map<string, Uint8Array>();
  generation = GENERATION;
  statCalls: PublishBundleBinding[] = []; readCalls: Array<PublishBundleBinding & { offset: number; expectedGeneration: string; maxBytes?: number }> = [];
  location: { incarnationId: string; locationId: string } | null = { incarnationId: "incarnation-one", locationId: "location-one" };
  locateCalls: Array<{ workspaceId: string; sessionId: string; sourceId: string }> = [];
  onStat: ((n: number) => Partial<PublishBundleStat> | void) | undefined;
  onRead: ((n: number, chunk: PublishBundleChunk) => Partial<PublishBundleChunk> | void | Promise<Partial<PublishBundleChunk> | void>) | undefined;
  throwOn: "stat" | "read" | undefined;
  locate(input: { workspaceId: string; sessionId: string; sourceId: string }) { this.locateCalls.push(input); return this.location; }
  async stat(input: PublishBundleBinding): Promise<PublishBundleStat> {
    this.statCalls.push(input);
    if (this.throwOn === "stat") throw new Error(SECRET);
    const file = this.files.get(input.relativePath);
    if (!file) throw new Error(`${SECRET} missing`);
    return { ...input, generation: this.generation, bytes: file.length, kind: "file", ...(this.onStat?.(this.statCalls.length) ?? {}) };
  }
  async readRange(input: PublishBundleBinding & { expectedGeneration: string; offset: number; maxBytes?: number }): Promise<PublishBundleChunk> {
    this.readCalls.push(input);
    if (this.throwOn === "read") throw new Error(SECRET);
    const file = this.files.get(input.relativePath)!;
    const slice = file.subarray(input.offset, Math.min(file.length, input.offset + (input.maxBytes ?? 65536)));
    const { expectedGeneration: _e, maxBytes: _m, offset: _o, ...binding } = input;
    const chunk: PublishBundleChunk = { ...binding, generation: this.generation, bytes: file.length, kind: "file", offset: input.offset, nextOffset: input.offset + slice.length, eof: input.offset + slice.length === file.length, content: Uint8Array.from(slice) };
    return { ...chunk, ...((await this.onRead?.(this.readCalls.length, chunk)) ?? {}) };
  }
}

async function fixture(limits: CoworkPublishPorts["limits"] = {}, now?: () => number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-cowork-publish-"))); roots.push(root);
  const home = join(root, "home"), guestRepo = join(root, "guest"), remote = join(root, "remote.git"), quarantineRoot = join(root, "quarantine"), gitHome = join(root, "githome");
  for (const dir of [home, guestRepo, quarantineRoot, gitHome]) mkdirSync(dir, { mode: 0o700 });
  const lifetime = new GitFixtureLifetime(); lifetimes.push(lifetime);
  const executor = lifetime.executor(new IsolatedGitExecutor());
  const git = async (cwd: string, ...args: string[]) => { const r = await executor.run({ cwd, home: gitHome, args }); if (r.code !== 0) throw new Error(`fixture git failed: ${args[0]}`); return r.stdout.trim(); };
  await git(guestRepo, "init", "--initial-branch=main", "--template="); await git(root, "init", "--bare", "--template=", remote);
  await git(guestRepo, "config", "user.name", "Fixture"); await git(guestRepo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(guestRepo, "work.txt"), "base\n"); await git(guestRepo, "add", "work.txt"); await git(guestRepo, "commit", "-m", "base");
  await git(guestRepo, "push", remote, "HEAD:refs/heads/main");
  await git(guestRepo, "checkout", "-b", "feature/task"); writeFileSync(join(guestRepo, "work.txt"), "task\n"); await git(guestRepo, "commit", "-am", "task");
  const head = await git(guestRepo, "rev-parse", "HEAD"), ref = "refs/heads/feature/task";
  const makeBundle = async (...refs: string[]) => { const path = join(root, `b-${Math.random()}.bundle`); await git(guestRepo, "bundle", "create", path, ...refs); return new Uint8Array(readFileSync(path)); };

  const db = openRuntimeStateDb(home); dbs.push(db); const records = new CoworkRepository(db);
  const made = records.create({ principalId: "fixture-user", requestId: "create" }, { ownership: "project", title: "Fixture",
    sources: [{ kind: "githubRepository", label: "Fixture", access: "read-write", detail: { repositoryId: "repository-one", authorityRef: "authority-one", initialRef: "main" } }],
    ceiling: { toolClasses: ["read", "write"], hostServices: ["git.publish"], connectors: [], network: "internet" } });
  const workspaceId = made.workspaceId, source = made.value.sources[0]!;
  const epoch = records.beginIncarnation(workspaceId, "incarnation-one", made.value.workspace.configRevision);
  records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
  const context = (requestId: string) => ({ principalId: "fixture-user", requestId, expectedRevision: records.get(workspaceId).configRevision });
  records.bindConversation(context("bind"), workspaceId, { sessionId: "session-one", sourceId: source.sourceId }, authorityFixtureSessions("session-one"));
  const authority = new CoworkAuthority(records, { folder: () => undefined, repository: () => ({ readable: true, writable: true, revoked: false }) });
  const tasks = { sourceScope: async () => ({ revision: 1, sourceIds: null }), resolve: async () => ({ repositoryId: "repository-one", destinationId: "destination-one", authorityId: "authority-one", authorityRevision: 1 }) };
  const publication = new CurrentCoworkPublicationAuthority(records, authority, tasks);

  let pushes = 0, defaultRef = "refs/heads/main";
  const transport: PublicationTransport = {
    observe: async (grant, atRef) => {
      const value = await executor.run({ cwd: root, home: gitHome, args: ["--git-dir", remote, "rev-parse", "--verify", atRef] });
      return { repositoryId: grant.repositoryId, destinationId: grant.destinationId, defaultRef, protection: "unprotected", currentOid: value.code === 0 ? value.stdout.trim() : null };
    },
    push: async (_grant, plan, signal) => {
      pushes++;
      const receivePack = `'${resolveGitExecutable().replaceAll("'", "'\\''")}' -c core.hooksPath=/dev/null receive-pack`;
      const r = await executor.run({ cwd: root, home: gitHome, signal, args: ["--git-dir", plan.quarantine, "push", "--porcelain", "--no-verify", `--receive-pack=${receivePack}`, plan.lease, remote, plan.refspec] });
      return r.code === 0 ? "applied" : "rejected";
    },
  };
  const journals = new Map<string, CanonicalPublicationJournal>();
  const journalFor = (workspace: string, owner = "host-a") => { const key = `${workspace}:${owner}`; if (!journals.has(key)) journals.set(key, new CanonicalPublicationJournal(records, workspace, owner)); return journals.get(key)!; };
  const brokerFor = (workspace: string) => {
    const options: BrokerOptions = { quarantineRoot, isolatedFixture: true, git: executor, journal: journalFor(workspace), transport, authority: publication };
    return new class extends CoworkGitPublicationBroker {
      override publish(...args: Parameters<CoworkGitPublicationBroker["publish"]>) {
        const [publisher, request, signal] = args;
        return lifetime.track(() => super.publish(publisher, request, signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal));
      }
    }(options);
  };
  const guest = new FakeGuest();
  const ports: CoworkPublishPorts = { records, guest, broker: brokerFor, journal: journalFor, limits, now };
  const caller: PublishCaller = { principalId: "fixture-user", sessionId: "session-one", taskId: "task-one" };
  const input: PublishInput = { requestId: "request-one", sourceId: source.sourceId, ref, oldOid: null, newOid: head };
  const stage = async (requestId = input.requestId, bundle?: Uint8Array) => { guest.files.set(publishBundlePath(requestId), bundle ?? await makeBundle(ref)); };
  await stage();
  const outbox = (operationId: string) => records.rs.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM cowork_outbox WHERE operation_id=? ORDER BY sequence").all(operationId).map(row => JSON.parse(row.payload_json).publicationStatus);
  const operations = () => records.rs.db.query<{ n: number }, []>("SELECT count(*) AS n FROM cowork_operations WHERE method='git.publish'").get()!.n;
  return { root, home, remote, guestRepo, git, head, ref, makeBundle, records, workspaceId, source, caller, input, guest, ports, service: createCoworkPublishService(ports), stage,
    outbox, operations, pushes: () => pushes, setDefault: (value: string) => defaultRef = value, journalFor, context, quarantineRoot, publication };
}
async function refused(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GitPublicationError);
  expect(error).toMatchObject({ code, message: code });
  expect(JSON.stringify(error)).not.toContain(SECRET);
}

test("production shape: without a ports object every verb refuses integration_unavailable", async () => {
  const service = createCoworkPublishService(undefined);
  expect(service.availability()).toEqual({ available: false, reason: "publication_ports_absent" });
  const caller: PublishCaller = { principalId: "u", sessionId: "s", taskId: "t" };
  await refused(service.publish(caller, { requestId: "r", sourceId: "x", ref: "refs/heads/f", oldOid: null, newOid: "a".repeat(40) }), "integration_unavailable");
  expect(() => service.status(caller, "r")).toThrow(GitPublicationError);
  await refused(service.recover("w", async () => true), "integration_unavailable");
});

test("a feature branch publishes end to end: host-derived path, claim, journal, outbox events, host-side push", async () => {
  const f = await fixture();
  const receipt = await f.service.publish(f.caller, f.input);
  expect(receipt).toMatchObject({ status: "applied", ref: f.ref, newOid: f.head, oldOid: null, repositoryId: "repository-one" });
  expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(f.head);
  expect(f.pushes()).toBe(1);
  // Every guest call carried only host-derived values: the session's workspace, the located incarnation and location, the
  // canonical source revision, and a path computed from the request id.
  for (const call of [...f.guest.statCalls, ...f.guest.readCalls]) {
    expect(call).toMatchObject({ workspaceId: f.workspaceId, sessionId: "session-one", locationId: "location-one", incarnationId: "incarnation-one",
      sourceRevision: f.source.revision, relativePath: ".winter-publish/request-one.bundle" });
  }
  expect(f.guest.locateCalls).toEqual([{ workspaceId: f.workspaceId, sessionId: "session-one", sourceId: f.source.sourceId }]);
  // The claim, the dispatch and the result are one durable operation with its outbox notifications.
  expect(f.operations()).toBe(1);
  expect(f.outbox(receipt.operationId)).toEqual(["prepared", "dispatched", "applied"]);
  expect(f.records.operation(f.workspaceId, receipt.operationId)).toMatchObject({ status: "applied", terminal: true });
  expect(f.service.status(f.caller, "request-one")).toEqual(receipt);
  expect(readdirSync(f.quarantineRoot)).toEqual([]);
});

test("a replayed request id returns the stored receipt and never pushes twice", async () => {
  const f = await fixture();
  const first = await f.service.publish(f.caller, f.input);
  expect(await f.service.publish(f.caller, f.input)).toEqual(first);
  expect(f.pushes()).toBe(1); expect(f.operations()).toBe(1);
  // The same id for a different update is a conflict, not a second effect.
  await f.stage("request-one", await f.makeBundle(f.ref));
  await refused(f.service.publish(f.caller, { ...f.input, oldOid: f.head, newOid: "b".repeat(40) }), "request_conflict");
  expect(f.pushes()).toBe(1);
});

test("the size budget is judged from stat, before one byte is read and before any claim", async () => {
  const f = await fixture({ bundleBytes: 100 });
  await refused(f.service.publish(f.caller, f.input), "object_budget");
  expect(f.guest.readCalls).toHaveLength(0); expect(f.operations()).toBe(0); expect(f.pushes()).toBe(0);
});

test("a guest file that changes during the pull is refused as stale and never claimed", async () => {
  const f = await fixture();
  f.guest.onRead = n => n === 1 ? { generation: "b".repeat(64) } : undefined;
  await refused(f.service.publish(f.caller, f.input), "bundle_stale");
  expect(f.operations()).toBe(0); expect(f.pushes()).toBe(0);
  // Changed after the last byte: the closing stat catches it.
  const g = await fixture(); g.guest.onStat = n => n === 2 ? { generation: "c".repeat(64) } : undefined;
  await refused(g.service.publish(g.caller, g.input), "bundle_stale");
  expect(g.operations()).toBe(0);
});

test("hostile or malformed chunk replies are refused with no guest text in the error", async () => {
  const cases: Array<[string, (n: number, chunk: PublishBundleChunk) => Partial<PublishBundleChunk>]> = [
    ["wrong offset", (_n, chunk) => ({ offset: chunk.offset + 1 })],
    ["gap", (_n, chunk) => ({ nextOffset: chunk.nextOffset + 1 })],
    ["empty chunk", () => ({ content: new Uint8Array(0), nextOffset: 0 })],
    ["early eof", (_n, chunk) => ({ eof: !chunk.eof })],
    ["oversized chunk", (_n, chunk) => ({ content: new Uint8Array(chunk.content.length + 5), nextOffset: chunk.offset + chunk.content.length + 5 })],
    ["foreign workspace", () => ({ workspaceId: "other" })],
    ["foreign path", () => ({ relativePath: "elsewhere.bundle" })],
    ["foreign incarnation", () => ({ incarnationId: "incarnation-two" })],
    ["wrong size", (_n, chunk) => ({ bytes: chunk.bytes + 1 })],
  ];
  const f = await fixture();
  for (const [name, mutate] of cases) {
    f.guest.onRead = (n, chunk) => n === 1 ? mutate(n, chunk) : undefined; f.guest.readCalls.length = 0;
    let error: unknown; try { await f.service.publish(f.caller, f.input); } catch (caught) { error = caught; }
    expect([name, error instanceof GitPublicationError && ["bundle_unavailable", "bundle_stale"].includes(error.code)]).toEqual([name, true]);
    expect(f.operations()).toBe(0);
  }
}, 30_000);

test("a throwing guest port, a missing file and an unlocatable guest leak nothing and claim nothing", async () => {
  for (const which of ["stat", "read"] as const) {
    const f = await fixture(); f.guest.throwOn = which;
    await refused(f.service.publish(f.caller, f.input), "bundle_unavailable"); expect(f.operations()).toBe(0);
  }
  const missing = await fixture(); missing.guest.files.clear();
  await refused(missing.service.publish(missing.caller, missing.input), "bundle_unavailable");
  const gone = await fixture(); gone.guest.location = null;
  await refused(gone.service.publish(gone.caller, gone.input), "bundle_unavailable");
  expect(gone.guest.statCalls).toHaveLength(0);
});

test("the workspace and the revisions come from canonical records, not from the request or the guest", async () => {
  const f = await fixture();
  // An unknown session, an archived conversation and a plan-mode conversation never reach the guest.
  await refused(f.service.publish({ ...f.caller, sessionId: "no-such-session" }, f.input), "authority_denied");
  f.records.rs.db.run("UPDATE cowork_conversations SET policy='plan' WHERE session_id='session-one'");
  await refused(f.service.publish(f.caller, f.input), "authority_denied");
  f.records.rs.db.run("UPDATE cowork_conversations SET policy='ask',state='archived' WHERE session_id='session-one'");
  await refused(f.service.publish(f.caller, f.input), "authority_denied");
  expect(f.guest.locateCalls).toHaveLength(0); expect(f.guest.statCalls).toHaveLength(0);
  // A source that is not in this workspace is denied, whatever id the guest names.
  f.records.rs.db.run("UPDATE cowork_conversations SET state='active' WHERE session_id='session-one'");
  await refused(f.service.publish(f.caller, { ...f.input, sourceId: "source-of-another-workspace" }), "authority_denied");
  expect(f.operations()).toBe(0);
});

test("the revisions sent to the broker are the CURRENT canonical ones, whatever they have become", async () => {
  const f = await fixture();
  f.records.updatePolicy(f.context("manual"), f.workspaceId, { publication: "manual" });
  f.records.updatePolicy(f.context("automatic"), f.workspaceId, { publication: "github-only-feature-branches" });
  f.records.rs.db.run("UPDATE cowork_sources SET revision=5,ack_revision=5 WHERE workspace_id=?", [f.workspaceId]);
  expect(f.records.policy(f.workspaceId).publicationRevision).toBe(3);
  expect((await f.service.publish(f.caller, f.input)).status).toBe("applied");
  for (const call of [...f.guest.statCalls, ...f.guest.readCalls]) expect(call.sourceRevision).toBe(5);
});

// The broker folds every authority fault, a stale revision included, into authority_denied; nothing is claimed.
test("a source or publication revision that moves while the bundle is pulled stops at the broker's authority check", async () => {
  const f = await fixture();
  f.guest.onRead = n => { if (n === 1) f.records.rs.db.run("UPDATE cowork_policies SET publication_revision=publication_revision+1 WHERE workspace_id=?", [f.workspaceId]); };
  await refused(f.service.publish(f.caller, f.input), "authority_denied");
  expect(f.operations()).toBe(0); expect(f.pushes()).toBe(0);
  const g = await fixture();
  g.guest.onRead = n => { if (n === 1) g.records.rs.db.run("UPDATE cowork_sources SET revision=revision+1 WHERE workspace_id=?", [g.workspaceId]); };
  await refused(g.service.publish(g.caller, g.input), "authority_denied");
  expect(g.operations()).toBe(0);
});

test("the default branch and a bundle that does not match the named update stay refused through the whole path", async () => {
  const f = await fixture();
  f.guest.files.set(publishBundlePath("main-attempt"), await f.makeBundle(f.ref));
  await refused(f.service.publish(f.caller, { ...f.input, requestId: "main-attempt", ref: "refs/heads/main" }), "ref_denied");
  f.setDefault(f.ref);
  await refused(f.service.publish(f.caller, f.input), "ref_denied");
  // A multi-ref bundle is not what the update names.
  f.setDefault("refs/heads/main");
  f.guest.files.set(publishBundlePath("multi"), await f.makeBundle("--all"));
  await refused(f.service.publish(f.caller, { ...f.input, requestId: "multi" }), "invalid_bundle");
  expect(f.pushes()).toBe(0);
});

test("one publish at a time per workspace, released afterwards even on failure", async () => {
  const f = await fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.guest.onRead = async n => { if (n === 1) await gate; };
  const first = f.service.publish(f.caller, f.input);
  await new Promise(resolve => setTimeout(resolve, 20));
  await f.stage("request-two");
  await refused(f.service.publish(f.caller, { ...f.input, requestId: "request-two" }), "publication_busy");
  release(); expect((await first).status).toBe("applied");
  f.guest.onRead = undefined;
  // The slot is free again, and a failed attempt frees it too.
  f.guest.throwOn = "stat"; await refused(f.service.publish(f.caller, { ...f.input, requestId: "request-two" }), "bundle_unavailable");
  f.guest.throwOn = undefined;
  await refused(f.service.publish(f.caller, { ...f.input, requestId: "request-two" }), "remote_conflict"); // reached the broker: the slot was free
});

test("a rolling per-workspace attempt cap refuses the surplus and recovers with the window", async () => {
  let clock = 1_000;
  const f = await fixture({ maxPerWindow: 2, windowMs: 60_000 }, () => clock);
  f.guest.throwOn = "stat"; // attempts count whether or not they succeed
  for (const id of ["a1", "a2"]) await refused(f.service.publish(f.caller, { ...f.input, requestId: id }), "bundle_unavailable");
  await refused(f.service.publish(f.caller, { ...f.input, requestId: "a3" }), "publication_budget");
  clock += 59_999; await refused(f.service.publish(f.caller, { ...f.input, requestId: "a4" }), "publication_budget");
  clock += 2; await refused(f.service.publish(f.caller, { ...f.input, requestId: "a5" }), "bundle_unavailable");
});

test("status is principal- and workspace-scoped, and never an effect", async () => {
  const f = await fixture();
  expect(f.service.status(f.caller, "request-one")).toBeNull();
  const receipt = await f.service.publish(f.caller, f.input);
  expect(f.service.status(f.caller, "request-one")).toEqual(receipt);
  expect(f.service.status({ ...f.caller, principalId: "someone-else" }, "request-one")).toBeNull();
  expect(() => f.service.status({ ...f.caller, sessionId: "no-such-session" }, "request-one")).toThrow(GitPublicationError);
  expect(() => f.service.status(f.caller, "bad id!")).toThrow(GitPublicationError);
  expect(f.pushes()).toBe(1);
});

test("recovery retires only an unsent preparation of a dead owner, behind explicit proof", async () => {
  const f = await fixture();
  // A previous host owner prepared and died before dispatch.
  const dead = f.journalFor(f.workspaceId, "host-dead");
  const key = JSON.stringify(["fixture-user", f.workspaceId, "orphan"]);
  await dead.claim(key, { operationId: "00000000-0000-4000-8000-000000000001", digest: "d".repeat(64), status: "prepared", repositoryId: "repository-one", ref: f.ref, oldOid: null, newOid: f.head });
  expect(await f.service.recover(f.workspaceId, async () => false)).toBe(0);
  expect(await f.service.recover(f.workspaceId, async candidate => { expect(candidate.ownerId).toBe("host-dead"); return true; })).toBe(1);
  expect(f.records.operation(f.workspaceId, "00000000-0000-4000-8000-000000000001")).toMatchObject({ status: "failed", terminal: true });
  await refused(f.service.recover("bad id!", async () => true), "invalid_request");
});

test("a service cannot be built over a nonsensical budget", async () => {
  const f = await fixture();
  for (const limits of [{ bundleBytes: 0 }, { maxPerWindow: -1 }, { windowMs: 1.5 }]) expect(() => createCoworkPublishService({ ...f.ports, limits })).toThrow(GitPublicationError);
});

test("the intake rejects a hostile path argument shape: the path is derived from the request id alone", () => {
  expect(publishBundlePath("req_1-A")).toBe(".winter-publish/req_1-A.bundle");
  for (const id of ["", "../x", "a/b", "a.b", "a b", "x".repeat(129), "a\0b", ".."]) expect(() => publishBundlePath(id)).toThrow(GitPublicationError);
});

test("the intake honours cancellation and pulls a multi-chunk bundle contiguously", async () => {
  const f = await fixture();
  const big = Uint8Array.from({ length: 700_000 }, (_v, i) => (i * 7) & 0xff);
  f.guest.files.set("big", big);
  const binding: PublishBundleBinding = { workspaceId: "w", sessionId: "s", locationId: "l", relativePath: "big", incarnationId: "i", sourceRevision: 1 };
  const pulled = await pullPublishBundle(f.guest, binding, { maxBytes: 1_000_000 });
  expect(Buffer.from(pulled.bytes).equals(Buffer.from(big))).toBe(true);
  expect(f.guest.readCalls.map(call => call.offset)).toEqual([0, 262144, 524288]);
  const controller = new AbortController(); controller.abort();
  await expect(pullPublishBundle(f.guest, binding, { maxBytes: 1_000_000 }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
});

// ---------------------------------------------------------------- the real file-channel client satisfies the port

test("the real guest file-channel client satisfies the structural port and its bytes publish", async () => {
  const f = await fixture();
  const bundle = await f.makeBundle(f.ref);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const authority = { check: () => ({ incarnationId: "incarnation-one" as string | null, sourceRevision: f.source.revision }) };
  let n = 0;
  const client: CoworkGuestFileClient = createCoworkGuestFileClient({
    authority, requestId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    frames: { async send(frame) {
      const request = parseCoworkGuestFileRequest(frame);
      const head = { version: 1, requestId: request.requestId, op: request.op, ok: true, workspaceId: request.workspaceId, sessionId: request.sessionId, locationId: request.locationId,
        relativePath: request.relativePath, incarnationId: request.incarnationId, sourceRevision: request.sourceRevision, generation: GENERATION, bytes: bundle.length, kind: "file" };
      if (request.op === "stat") return line(head);
      const offset = request.op === "readRange" ? request.offset : 0;
      const slice = bundle.subarray(offset, Math.min(bundle.length, offset + request.maxBytes));
      return line({ ...head, offset, nextOffset: offset + slice.length, eof: offset + slice.length === bundle.length, contentBase64: Buffer.from(slice).toString("base64"), encoding: "base64" });
    } },
  });
  const port: PublishBundlePort = client; // assignability, enforced by `bun run typecheck:core`
  const guest = { stat: (input: PublishBundleBinding) => port.stat(input), readRange: (input: Parameters<PublishBundlePort["readRange"]>[0]) => port.readRange(input), locate: () => ({ incarnationId: "incarnation-one", locationId: "location-one" }) };
  const service = createCoworkPublishService({ ...f.ports, guest });
  expect((await service.publish(f.caller, f.input)).status).toBe("applied");
  expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(f.head);
});
