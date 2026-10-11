import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkGitPublicationBroker, type BrokerOptions } from "../../../src/cowork/git/broker";
import { IsolatedGitExecutor } from "../../../src/cowork/git/executor";
import { CanonicalPublicationJournal } from "../../../src/cowork/git/journal";
import { CoworkRepository } from "../../../src/cowork/repository";
import { openRuntimeStateDb } from "../../../src/runtime-state/db";
import { GitPublicationError, type PublicationGrant, type PublicationJournal, type PublicationReceipt, type PublicationRequest, type PublicationStatus, type PublicationTransport, type Publisher } from "../../../src/cowork/git/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const actor: Publisher = { principalId: "fixture-user", sessionId: "fixture-session", taskId: "fixture-task" };
class Journal implements PublicationJournal {
  receipts = new Map<string, PublicationReceipt>();
  async claim(key: string, receipt: PublicationReceipt) { const old = this.receipts.get(key); if (old) return { created: false, receipt: { ...old } }; this.receipts.set(key, { ...receipt }); return { created: true, receipt }; }
  async transition(key: string, from: PublicationStatus, to: PublicationStatus) { const receipt = this.receipts.get(key)!; if (receipt.status !== from) throw new Error("journal-conflict"); receipt.status = to; return { ...receipt }; }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-cowork-git-"))); roots.push(root);
  const home = join(root, "home"), guest = join(root, "guest"), remote = join(root, "remote.git"), quarantineRoot = join(root, "quarantine");
  for (const dir of [home, guest, quarantineRoot]) mkdirSync(dir, { mode: 0o700 });
  const executor = new IsolatedGitExecutor();
  const git = async (cwd: string, ...args: string[]) => { const result = await executor.run({ cwd, home, args }); if (result.code !== 0) throw new Error(`fixture git failed: ${args[0]}`); return result.stdout.trim(); };
  await git(guest, "init", "--initial-branch=main", "--template="); await git(root, "init", "--bare", "--template=", remote);
  await git(guest, "config", "user.name", "Fixture"); await git(guest, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(guest, "work.txt"), "base\n"); await git(guest, "add", "work.txt"); await git(guest, "commit", "-m", "base");
  const base = await git(guest, "rev-parse", "HEAD"); await git(guest, "push", remote, "HEAD:refs/heads/main");
  await git(guest, "checkout", "-b", "feature/task"); writeFileSync(join(guest, "work.txt"), "task\n"); await git(guest, "commit", "-am", "task");
  const head = await git(guest, "rev-parse", "HEAD"), ref = "refs/heads/feature/task";
  const makeBundle = async (...refs: string[]) => { const path = join(root, `input-${Math.random()}.bundle`); await git(guest, "bundle", "create", path, ...refs); return new Uint8Array(readFileSync(path)); };
  const journal = new Journal(); let authorized = true, checks = 0, pushes = 0;
  let grant: PublicationGrant = { repositoryId: "repository-123", destinationId: "destination-123", authorityId: "authority-fixture", authorityRevision: 1, sourceRevision: 1, publicationRevision: 1 };
  let protection: "protected" | "unprotected" | "unknown" = "unprotected", defaultRef = "refs/heads/main";
  let beforeObserve: (() => Promise<void>) | undefined, beforePush: (() => Promise<void>) | undefined;
  let failPush: "throw" | "uncertain" | undefined;
  const transport: PublicationTransport = {
    observe: async (observedGrant, atRef) => {
      if (beforeObserve) await beforeObserve();
      const value = await executor.run({ cwd: root, home, args: ["--git-dir", remote, "rev-parse", "--verify", atRef] });
      return { repositoryId: observedGrant.repositoryId, destinationId: observedGrant.destinationId, defaultRef, protection, currentOid: value.code === 0 ? value.stdout.trim() : null };
    },
    push: async (_grant, plan, signal) => {
      pushes++; if (beforePush) await beforePush(); if (failPush === "throw") throw new Error("token-fixture-secret raw transport error"); if (failPush === "uncertain") return "uncertain";
      const result = await executor.run({ cwd: root, home, signal, args: ["--git-dir", plan.quarantine, "push", "--porcelain", "--no-verify", plan.lease, remote, plan.refspec] });
      // Fixture-local receive-pack has an authoritative explicit stale-ref rejection. Real transport cannot classify every exit!=0 as rejected.
      return result.code === 0 ? "applied" : "rejected";
    },
  };
  const options: BrokerOptions = { quarantineRoot, isolatedFixture: true, git: executor, journal, transport, authority: { authorize: async () => { checks++; if (!authorized) throw new Error("token-fixture-secret denied"); return { ...grant }; } } };
  const request: PublicationRequest = { requestId: "request-one", workspaceId: "workspace-one", sourceId: "source-one", sourceRevision: 1, publicationRevision: 1, ref, oldOid: null, newOid: head, bundle: await makeBundle(ref) };
  return { root, home, guest, remote, quarantineRoot, git, executor, journal, options, request, base, head, ref, makeBundle,
    broker: () => new CoworkGitPublicationBroker(options), checks: () => checks, pushes: () => pushes,
    revoke: () => authorized = false, setGrant: (value: PublicationGrant) => grant = value, grant: () => grant,
    protect: (value: typeof protection) => protection = value, setDefault: (value: string) => defaultRef = value,
    beforeObserve: (fn: () => Promise<void>) => beforeObserve = fn, beforePush: (fn: () => Promise<void>) => beforePush = fn, failPush: (value: typeof failPush) => failPush = value,
  };
}
async function refused(promise: Promise<unknown>, code: string) { await expect(promise).rejects.toMatchObject({ code, message: code }); }

test("creates and advances a feature ref using verified host graph and exact CAS; replay is reauthorized", async () => {
  const f = await fixture(), broker = f.broker();
  const first = await broker.publish(actor, f.request); expect(first.status).toBe("applied"); expect(f.checks()).toBe(2);
  expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(f.head);
  expect(await broker.publish(actor, f.request)).toEqual(first); expect(f.pushes()).toBe(1); expect(readdirSync(f.quarantineRoot)).toEqual([]);
  writeFileSync(join(f.guest, "work.txt"), "task two\n"); await f.git(f.guest, "commit", "-am", "next task");
  const next = { ...f.request, requestId: "next", oldOid: f.head, newOid: await f.git(f.guest, "rev-parse", "HEAD"), bundle: await f.makeBundle(f.ref) };
  expect((await broker.publish(actor, next)).status).toBe("applied");
  f.revoke(); await refused(broker.publish(actor, f.request), "authority_denied");
});
test("production entry remains blocked before host auth/service integration", async () => {
  const f = await fixture(); f.options.isolatedFixture = false; const broker = f.broker();
  expect(broker.availability().available).toBe(false); await refused(broker.publish(actor, f.request), "integration_unavailable"); expect(f.pushes()).toBe(0);
});
test("real local publication is not repeated after reopening canonical receipt storage", async () => {
  const f = await fixture(); let db = openRuntimeStateDb(f.home);
  try {
    const records = new CoworkRepository(db);
    const created = records.create({principalId:actor.principalId,requestId:"workspace"}, {ownership:"project",title:"Fixture",sources:[{kind:"githubRepository",label:"Repo",access:"read-write",detail:{repositoryId:f.grant().repositoryId,authorityRef:f.grant().authorityId,initialRef:"main"}}],ceiling:{toolClasses:[],hostServices:[],connectors:[],network:"none"}});
    const request = {...f.request,workspaceId:created.workspaceId};
    f.options.journal = new CanonicalPublicationJournal(records,created.workspaceId);
    const receipt = await f.broker().publish(actor,request); expect(receipt.status).toBe("applied");
    db.close(); db = openRuntimeStateDb(f.home);
    f.options.journal = new CanonicalPublicationJournal(new CoworkRepository(db),created.workspaceId);
    expect(await f.broker().publish(actor,request)).toEqual(receipt);
    expect(f.pushes()).toBe(1);
  } finally { db.close(); }
});
test("default, main, master, protected and unverifiable rules are denied", async () => {
  const f = await fixture();
  for (const ref of ["refs/heads/main", "refs/heads/master", f.ref]) { f.setDefault(ref); await refused(f.broker().publish(actor, { ...f.request, requestId: `default-${ref.split("/").at(-1)}`, ref }), "ref_denied"); }
  f.setDefault("refs/heads/main");
  for (const policy of ["protected", "unknown"] as const) { f.protect(policy); await refused(f.broker().publish(actor, { ...f.request, requestId: policy }), "ref_denied"); }
  expect(f.pushes()).toBe(0);
});
test("rejects tags, deletion, force/refspec injection, malformed IDs and zero old OIDs", async () => {
  const f = await fixture();
  for (const ref of ["refs/tags/v1", "+refs/heads/feature/x", "refs/heads/a:refs/heads/main", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a\nb", "--all"]) await refused(f.broker().publish(actor, { ...f.request, ref }), "invalid_request");
  await refused(f.broker().publish(actor, { ...f.request, newOid: "0".repeat(40) }), "invalid_request");
  await refused(f.broker().publish(actor, { ...f.request, oldOid: "0".repeat(40) }), "invalid_request");
  expect(f.pushes()).toBe(0);
});
test("multi-ref, prerequisite, mismatched head and corrupt object bundles never reach transport", async () => {
  const f = await fixture();
  const multi = await f.makeBundle("--all"); await refused(f.broker().publish(actor, { ...f.request, bundle: multi, requestId: "multi" }), "invalid_bundle");
  const thin = await f.makeBundle(f.ref, `^${f.base}`); await refused(f.broker().publish(actor, { ...f.request, bundle: thin, requestId: "thin" }), "invalid_bundle");
  await refused(f.broker().publish(actor, { ...f.request, newOid: f.base, requestId: "wrong" }), "invalid_bundle");
  const corrupt = f.request.bundle.slice(); corrupt[corrupt.length - 1] = corrupt.at(-1)! ^ 255;
  await refused(f.broker().publish(actor, { ...f.request, bundle: corrupt, requestId: "corrupt" }), "invalid_bundle"); expect(f.pushes()).toBe(0);
});
test("independent graph rejects diverged update despite claimed old/new matching current ref", async () => {
  const f = await fixture(); await f.git(f.guest, "push", f.remote, `${f.head}:${f.ref}`);
  await f.git(f.guest, "checkout", "main"); writeFileSync(join(f.guest, "other.txt"), "diverged\n"); await f.git(f.guest, "add", "other.txt"); await f.git(f.guest, "commit", "-m", "diverged");
  await f.git(f.guest, "branch", "-f", "feature/task", "HEAD");
  await refused(f.broker().publish(actor, { ...f.request, oldOid: f.head, newOid: await f.git(f.guest, "rev-parse", "HEAD"), bundle: await f.makeBundle(f.ref) }), "non_fast_forward"); expect(f.pushes()).toBe(0);
});
test("creation collision and update race cannot overwrite refs after host observation", async () => {
  const f = await fixture(); f.beforePush(async () => { await f.git(f.guest, "push", f.remote, `${f.base}:${f.ref}`); });
  expect((await f.broker().publish(actor, f.request)).status).toBe("rejected"); expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(f.base);
  const g = await fixture(); await g.git(g.guest, "push", g.remote, `${g.base}:${g.ref}`);
  writeFileSync(join(g.guest, "work.txt"), "concurrent task\n"); await g.git(g.guest, "commit", "-am", "concurrent task");
  const concurrent = await g.git(g.guest, "rev-parse", "HEAD");
  g.beforePush(async () => { await g.git(g.guest, "push", g.remote, `${concurrent}:${g.ref}`); });
  expect((await g.broker().publish(actor, { ...g.request, oldOid: g.base })).status).toBe("rejected");
  expect(await g.git(g.root, "--git-dir", g.remote, "rev-parse", g.ref)).toBe(concurrent);
});
test("rechecks policy/default/authority immediately before dispatch and preserves local data", async () => {
  const f = await fixture(); let observes = 0;
  f.beforeObserve(async () => { if (++observes === 2) f.protect("protected"); });
  await refused(f.broker().publish(actor, f.request), "ref_denied"); expect(f.pushes()).toBe(0); expect(readFileSync(join(f.guest, "work.txt"), "utf8")).toBe("task\n");
  const g = await fixture(); g.options.authority.authorize = async () => { const current = g.grant(); g.setGrant({ ...current, authorityRevision: current.authorityRevision + 1 }); return current; };
  await refused(g.broker().publish(actor, g.request), "revision_conflict"); expect(g.pushes()).toBe(0);
});
test("uncertain error receipts redact transport secrets and cannot be blindly retried", async () => {
  const f = await fixture(); f.failPush("throw"); const broker = f.broker(), receipt = await broker.publish(actor, f.request);
  expect(receipt.status).toBe("uncertain"); expect(JSON.stringify(receipt)).not.toContain("secret");
  expect(await broker.publish(actor, f.request)).toEqual(receipt); expect(f.pushes()).toBe(1);
  await refused(broker.publish(actor, { ...f.request, oldOid: f.base }), "request_conflict");
});
test("journal failures redact host errors and a persisted dispatch is never replayed", async () => {
  const f = await fixture(); f.options.journal.claim = async () => { throw new Error("secret fixture host path"); };
  await refused(f.broker().publish(actor, f.request), "command_failed"); expect(f.pushes()).toBe(0);
  const g = await fixture(), transition = g.journal.transition.bind(g.journal);
  g.options.journal.transition = async (key, from, to) => { if (to === "applied") throw new Error("secret fixture host path"); return transition(key, from, to); };
  const broker = g.broker(); await refused(broker.publish(actor, g.request), "command_failed");
  expect((await broker.publish(actor, g.request)).status).toBe("dispatched"); expect(g.pushes()).toBe(1);
});
test("concurrent duplicate requests claim one publication; principal/task/grant/payload drift conflicts", async () => {
  const f = await fixture(), broker = f.broker();
  const receipts = await Promise.all([broker.publish(actor, f.request), broker.publish(actor, f.request)]);
  expect(receipts[0]!.operationId).toBe(receipts[1]!.operationId); expect(f.pushes()).toBe(1);
  await refused(broker.publish({ ...actor, taskId: "another-task" }, f.request), "request_conflict");
  f.setGrant({ ...f.grant(), authorityRevision: 2 }); await refused(broker.publish(actor, f.request), "request_conflict");
});
test("repository destination metadata mismatch and stale source/policy authority are denied", async () => {
  const f = await fixture(); const observe = f.options.transport.observe;
  f.options.transport.observe = async (...args) => ({ ...await observe(...args), destinationId: "destination-other" });
  await refused(f.broker().publish(actor, f.request), "authority_denied"); expect(f.pushes()).toBe(0);
  const g = await fixture(); g.setGrant({ ...g.grant(), sourceRevision: 2 }); await refused(g.broker().publish(actor, g.request), "revision_conflict");
});
test("guest URL/flags/environment and mutable transfer bytes cannot change the host publication plan", async () => {
  const f = await fixture(), originalAuthorize = f.options.authority.authorize;
  f.options.authority.authorize = async (publisher, request) => {
    expect(Object.keys(request).sort()).toEqual(["bundle", "newOid", "oldOid", "publicationRevision", "ref", "requestId", "sourceId", "sourceRevision", "workspaceId"]);
    f.request.bundle.fill(0); return originalAuthorize(publisher, request);
  };
  const injected = { ...f.request, url: "https://attacker.invalid/repo", flags: ["--mirror"], env: { GIT_CONFIG_GLOBAL: "/tmp/attacker" } };
  expect((await f.broker().publish(actor, injected)).status).toBe("applied"); expect(f.pushes()).toBe(1);
});
test("cancellation before dispatch rejects; cancellation during push preserves uncertain outcome", async () => {
  const f = await fixture(), before = new AbortController(); before.abort(); await refused(f.broker().publish(actor, f.request, before.signal), "cancelled");
  const during = new AbortController(); f.beforePush(async () => during.abort());
  expect((await f.broker().publish(actor, f.request, during.signal)).status).toBe("uncertain"); expect(readdirSync(f.quarantineRoot)).toEqual([]);
});
test("cancellation while persisting dispatch never invokes push and leaves a non-replayable receipt", async () => {
  const f = await fixture(), abort = new AbortController(), transition = f.journal.transition.bind(f.journal);
  f.options.journal.transition = async (key, from, to) => {
    const receipt = await transition(key, from, to);
    if (to === "dispatched") abort.abort();
    return receipt;
  };
  const broker = f.broker();
  await refused(broker.publish(actor, f.request, abort.signal), "cancelled");
  expect(f.pushes()).toBe(0);
  expect((await broker.publish(actor, f.request)).status).toBe("rejected");
  expect(f.pushes()).toBe(0);
});
test("bundle, expanded object, object count and disk pressure budgets fail closed", async () => {
  for (const limits of [{ bundleBytes: 1 }, { expandedObjectBytes: 1 }, { objects: 1 }, { diskBytes: 1 }, { minimumFreeBytes: Number.MAX_SAFE_INTEGER }]) {
    const f = await fixture(); f.options.limits = limits;
    await refused(f.broker().publish(actor, f.request), "bundleBytes" in limits ? "invalid_request" : "object_budget"); expect(f.pushes()).toBe(0);
  }
});
test("executor bounds output and ignores inherited Git config, hooks, helpers and environment", async () => {
  const f = await fixture(), marker = join(f.root, "hook-ran"), hook = join(f.guest, ".git/hooks/pre-push");
  mkdirSync(join(f.guest, ".git/hooks"));
  writeFileSync(hook, `#!/bin/sh\necho unsafe > '${marker}'\n`, { mode: 0o700 });
  await f.git(f.guest, "config", "alias.exfiltrate", "!echo unsafe");
  expect((await f.broker().publish(actor, f.request)).status).toBe("applied");
  expect(readdirSync(f.root)).not.toContain("hook-ran");
  await expect(new IsolatedGitExecutor("/usr/bin/git", 1000, 1).run({ cwd: f.root, home: f.home, args: ["--version"] })).rejects.toBeInstanceOf(GitPublicationError);
});
