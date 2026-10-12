import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkGitPublicationBroker, type BrokerOptions } from "../../../src/cowork/git/broker";
import { IsolatedGitExecutor, resolveGitExecutable } from "../../../src/cowork/git/executor";
import { CanonicalPublicationJournal } from "../../../src/cowork/git/journal";
import { CoworkRepository } from "../../../src/cowork/repository";
import { openRuntimeStateDb } from "../../../src/runtime-state/db";
import { GitPublicationError, type PublicationGrant, type PublicationJournal, type PublicationReceipt, type PublicationRequest, type PublicationStatus, type PublicationTransport, type Publisher } from "../../../src/cowork/git/types";
import { GitFixtureLifetime } from "./fixture-lifetime";

const roots: string[] = [], lifetimes: GitFixtureLifetime[] = [];
afterEach(async () => {
  // A failed/timed-out test may still own Git/publication work. Cancel and settle
  // that work before removing its cwd/quarantine, including late continuations.
  await Promise.all(lifetimes.splice(0).map(lifetime => lifetime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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
  const lifetime = new GitFixtureLifetime(); lifetimes.push(lifetime);
  const executor = lifetime.executor(new IsolatedGitExecutor());
  const git = async (cwd: string, ...args: string[]) => { const result = await executor.run({ cwd, home, args }); if (result.code !== 0) throw new Error(`fixture git failed: ${args[0]}`); return result.stdout.trim(); };
  await git(guest, "init", "--initial-branch=main", "--template="); await git(root, "init", "--bare", "--template=", remote);
  await git(guest, "config", "user.name", "Fixture"); await git(guest, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(guest, "work.txt"), "base\n"); await git(guest, "add", "work.txt"); await git(guest, "commit", "-m", "base");
  const base = await git(guest, "rev-parse", "HEAD"); await git(guest, "push", remote, "HEAD:refs/heads/main");
  await git(guest, "checkout", "-b", "feature/task"); writeFileSync(join(guest, "work.txt"), "task\n"); await git(guest, "commit", "-am", "task");
  const head = await git(guest, "rev-parse", "HEAD"), ref = "refs/heads/feature/task";
  const makeBundle = async (...refs: string[]) => { const path = join(root, `input-${Math.random()}.bundle`); await git(guest, "bundle", "create", path, ...refs); return new Uint8Array(readFileSync(path)); };
  const journal = new Journal(); let authorized = true, checks = 0, pushes = 0;
  let grant: PublicationGrant = { repositoryId: "repository-123", destinationId: "destination-123", authorityId: "authority-fixture", authorityRevision: 1, sourceRevision: 1, publicationRevision: 1,
    sourceScope: { revision: 1, sourceIds: null }, capabilityState: { conversationRevision: 1, policyRevision: 1, digest: "a".repeat(64) } };
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
      // Local receive-pack is a separate server. Git clears parent command config
      // for it, so explicitly configure this fixture server's hook policy too.
      const receivePack = `'${resolveGitExecutable().replaceAll("'", "'\\''")}' -c core.hooksPath=/dev/null receive-pack`;
      const result = await executor.run({ cwd: root, home, signal, args: ["--git-dir", plan.quarantine, "push", "--porcelain", "--no-verify", `--receive-pack=${receivePack}`, plan.lease, remote, plan.refspec] });
      // Fixture-local receive-pack has an authoritative explicit stale-ref rejection. Real transport cannot classify every exit!=0 as rejected.
      return result.code === 0 ? "applied" : "rejected";
    },
  };
  const options: BrokerOptions = { quarantineRoot, isolatedFixture: true, git: executor, journal, transport, authority: { authorize: async () => { checks++; if (!authorized) throw new Error("token-fixture-secret denied"); return { ...grant }; } } };
  const request: PublicationRequest = { requestId: "request-one", workspaceId: "workspace-one", sourceId: "source-one", sourceRevision: 1, publicationRevision: 1, ref, oldOid: null, newOid: head, bundle: await makeBundle(ref) };
  return { root, home, guest, remote, quarantineRoot, git, executor, journal, options, request, base, head, ref, makeBundle,
    broker: () => new class extends CoworkGitPublicationBroker {
      override publish(publisher: Publisher, request: PublicationRequest, signal?: AbortSignal): Promise<PublicationReceipt> {
        return lifetime.track(() => super.publish(publisher, request, signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal));
      }
    }(options), checks: () => checks, pushes: () => pushes,
    revoke: () => authorized = false, setGrant: (value: PublicationGrant) => grant = value, grant: () => grant,
    protect: (value: typeof protection) => protection = value, setDefault: (value: string) => defaultRef = value,
    beforeObserve: (fn: () => Promise<void>) => beforeObserve = fn, beforePush: (fn: () => Promise<void>) => beforePush = fn, failPush: (value: typeof failPush) => failPush = value,
  };
}
async function refused(promise: Promise<unknown>, code: string) {
  // Await through normal promise rejection handling; keep the failure owned by
  // this test rather than relying on a matcher pumping an outstanding Git job.
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GitPublicationError);
  expect(error).toMatchObject({ code, message: code });
}

test("creates a feature ref using verified host graph and exact CAS; replay is reauthorized", async () => {
  const f = await fixture(), broker = f.broker();
  const first = await broker.publish(actor, f.request); expect(first.status).toBe("applied"); expect(f.checks()).toBe(2);
  expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(f.head);
  expect(await broker.publish(actor, f.request)).toEqual(first); expect(f.pushes()).toBe(1); expect(readdirSync(f.quarantineRoot)).toEqual([]);
  f.revoke(); await refused(broker.publish(actor, f.request), "authority_denied");
});
test("advances an existing feature ref using verified host graph and exact CAS", async () => {
  const f = await fixture(), broker = f.broker();
  await f.git(f.guest, "push", f.remote, `${f.head}:${f.ref}`);
  writeFileSync(join(f.guest, "work.txt"), "task two\n"); await f.git(f.guest, "commit", "-am", "next task");
  const next = { ...f.request, requestId: "next", oldOid: f.head, newOid: await f.git(f.guest, "rev-parse", "HEAD"), bundle: await f.makeBundle(f.ref) };
  expect((await broker.publish(actor, next)).status).toBe("applied");
  expect(await f.git(f.root, "--git-dir", f.remote, "rev-parse", f.ref)).toBe(next.newOid);
  expect(f.pushes()).toBe(1); expect(readdirSync(f.quarantineRoot)).toEqual([]);
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
    f.options.journal = new CanonicalPublicationJournal(records,created.workspaceId,"host-a");
    const receipt = await f.broker().publish(actor,request); expect(receipt.status).toBe("applied");
    db.close(); db = openRuntimeStateDb(f.home);
    f.options.journal = new CanonicalPublicationJournal(new CoworkRepository(db),created.workspaceId,"host-b");
    expect(await f.broker().publish(actor,request)).toEqual(receipt);
    expect(f.pushes()).toBe(1);
  } finally { db.close(); }
});
test("default, main, master, protected and unverifiable rules are denied", async () => {
  const f = await fixture();
  for (const ref of ["refs/heads/main", "refs/heads/MAIN", "refs/heads/master", "refs/heads/Master"]) { await refused(f.broker().publish(actor, { ...f.request, requestId: `default-${ref.split("/").at(-1)}`, ref }), "ref_denied"); }
  f.setDefault(f.ref); await refused(f.broker().publish(actor, { ...f.request, requestId: "default-exact" }), "ref_denied");
  f.setDefault(f.ref.toUpperCase().replace("REFS/HEADS/", "refs/heads/"));
  await refused(f.broker().publish(actor, { ...f.request, requestId: "default-case" }), "ref_denied");
  f.setDefault("refs/heads/main");
  for (const policy of ["protected", "unknown"] as const) { f.protect(policy); await refused(f.broker().publish(actor, { ...f.request, requestId: policy }), "ref_denied"); }
  expect(f.pushes()).toBe(0);
});
test("rejects tags, deletion, force/refspec injection, malformed IDs and zero old OIDs", async () => {
  const f = await fixture();
  for (const ref of ["refs/tags/v1", "+refs/heads/feature/x", "refs/heads/a:refs/heads/main", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a\nb", "refs/heads/HEAD", "refs/heads/feature/head/x", "refs/heads/feature/Head", "refs/heads/café", "refs/heads/feat\u200bure", "refs/heads/feat\u202ere", "--all"]) await refused(f.broker().publish(actor, { ...f.request, ref }), "invalid_request");
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
  const f = await fixture(), marker = join(f.root, "hook-ran");
  // These are the executor's actual HOME and XDG_CONFIG_HOME, and the receive
  // repository's actual hooks. Guest working-tree config is not consulted here.
  mkdirSync(join(f.home, "git")); mkdirSync(join(f.remote, "hooks"));
  const poisoned = `[core]\n hooksPath = ${join(f.remote, "hooks")}\n[alias]\n exfiltrate = !echo unsafe > '${marker}'\n[credential]\n helper = !echo unsafe > '${marker}'\n`;
  writeFileSync(join(f.home, ".gitconfig"), poisoned); writeFileSync(join(f.home, "git/config"), poisoned);
  for (const hook of ["pre-receive", "update", "post-receive"]) writeFileSync(join(f.remote, "hooks", hook), `#!/bin/sh\necho unsafe > '${marker}'\n`, { mode: 0o700 });
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(f.home, ".gitconfig");
  try {
    expect((await f.executor.run({ cwd: f.root, home: f.home, args: ["exfiltrate"] })).code).not.toBe(0);
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
  expect((await f.broker().publish(actor, f.request)).status).toBe("applied");
  expect(readdirSync(f.root)).not.toContain("hook-ran");
  await expect(new IsolatedGitExecutor(resolveGitExecutable(), 1000, 1).run({ cwd: f.root, home: f.home, args: ["--version"] })).rejects.toBeInstanceOf(GitPublicationError);
});

test("cleanup failure preserves confirmed publication success and signals host diagnostics", async () => {
  const f = await fixture(); let cleanupFailures = 0;
  f.options.onCleanupFailure = () => { cleanupFailures++; };
  const cleanup = spyOn(fsPromises, "rm").mockRejectedValue(new Error("private fixture path"));
  try {
    expect((await f.broker().publish(actor, f.request)).status).toBe("applied");
    expect(f.pushes()).toBe(1); expect(cleanupFailures).toBe(1);
  } finally { cleanup.mockRestore(); }
});
test("failed rejection persistence remains observable pending, never a fabricated rejection", async () => {
  const f = await fixture(); f.protect("protected");
  f.journal.transition = async () => { throw new Error("private journal failure"); };
  await refused(f.broker().publish(actor, f.request), "command_failed");
  expect([...f.journal.receipts.values()][0]?.status).toBe("prepared"); expect(f.pushes()).toBe(0);
});
test("an acknowledged dispatch failure never changes a persisted dispatch into rejection", async () => {
  const f = await fixture(), transition = f.journal.transition.bind(f.journal);
  f.journal.transition = async (key, from, to) => {
    const value = await transition(key, from, to);
    if (to === "dispatched") throw new Error("committed dispatch but lost acknowledgement");
    return value;
  };
  await refused(f.broker().publish(actor, f.request), "command_failed");
  expect([...f.journal.receipts.values()][0]?.status).toBe("dispatched"); expect(f.pushes()).toBe(0);
});
test("host source-scope revisions bind the request digest and dispatch grant", async () => {
  const f = await fixture(), authorize = f.options.authority.authorize;
  let checks = 0;
  f.options.authority.authorize = async (...args) => {
    if (++checks === 2) f.setGrant({ ...f.grant(), sourceScope: { revision: 3, sourceIds: null } });
    return authorize(...args);
  };
  await refused(f.broker().publish(actor, f.request), "revision_conflict"); expect(f.pushes()).toBe(0);
  await refused(f.broker().publish(actor, f.request), "request_conflict");
  const g = await fixture(); g.setGrant({ ...g.grant(), sourceScope: { revision: 2, sourceIds: ["another-source"] } });
  await refused(g.broker().publish(actor, g.request), "authority_denied"); expect(g.pushes()).toBe(0);
});
test("canonical capability epochs bind dispatch and retry even when the effective set is restored", async () => {
  const f = await fixture(), authorize = f.options.authority.authorize; let checks = 0;
  f.options.authority.authorize = async (...args) => {
    if (++checks === 2) f.setGrant({ ...f.grant(), capabilityState: { ...f.grant().capabilityState, policyRevision: 3 } });
    return authorize(...args);
  };
  await refused(f.broker().publish(actor, f.request), "revision_conflict"); expect(f.pushes()).toBe(0);
  await refused(f.broker().publish(actor, f.request), "request_conflict");
});
test("canonical broker restart retires unsent preparations and never replays dispatched or uncertain effects", async () => {
  for (const phase of ["prepared", "dispatched", "uncertain", "applied-ack-lost", "rejected-ack-lost"] as const) {
    const f = await fixture(); let db = openRuntimeStateDb(f.home);
    try {
      const records = new CoworkRepository(db);
      const created = records.create({ principalId: actor.principalId, requestId: "workspace" }, { ownership: "project", title: "Fixture",
        sources: [{ kind: "githubRepository", label: "Repo", access: "read-write", detail: { repositoryId: f.grant().repositoryId, authorityRef: f.grant().authorityId, initialRef: "main" } }],
        ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" } });
      const request = { ...f.request, workspaceId: created.workspaceId }, journal = new CanonicalPublicationJournal(records, created.workspaceId, "host-a");
      f.options.journal = {
        claim: async (...args) => { const result = await journal.claim(...args); if (phase === "prepared") throw new Error("crash after durable claim"); return result; },
        transition: async (key, from, to) => {
          if (phase === "applied-ack-lost" && to === "applied") throw new Error("crash after push before receipt persistence");
          if (phase === "rejected-ack-lost" && to === "rejected") throw new Error("crash after rejection before receipt persistence");
          const result = await journal.transition(key, from, to);
          if (phase === "dispatched" && to === "dispatched") throw new Error("crash after durable dispatch");
          return result;
        },
      };
      if (phase === "rejected-ack-lost") f.beforePush(async () => { await f.git(f.guest, "push", f.remote, `${f.base}:${f.ref}`); });
      if (phase === "uncertain") { f.failPush("throw"); expect((await f.broker().publish(actor, request)).status).toBe("uncertain"); }
      else await refused(f.broker().publish(actor, request), "command_failed");
      const expectedPushes = phase === "uncertain" || phase === "applied-ack-lost" || phase === "rejected-ack-lost" ? 1 : 0;
      expect(f.pushes()).toBe(expectedPushes);
      db.close(); db = openRuntimeStateDb(f.home);
      const recovered = new CanonicalPublicationJournal(new CoworkRepository(db), created.workspaceId, "host-b");
      await recovered.recoverPrepared(async candidate => candidate.ownerId === "host-a"); // Fixture simulates confirmed previous host loss.
      f.options.journal = recovered;
      const receipts = await Promise.all([f.broker().publish(actor, request), f.broker().publish(actor, request)]);
      expect(receipts[0]!.status).toBe(phase === "prepared" ? "rejected" : phase === "uncertain" ? "uncertain" : "dispatched");
      expect(receipts[0]).toEqual(receipts[1]); expect(f.pushes()).toBe(expectedPushes);
    } finally { db.close(); }
  }
});
test("full bundle without the claimed old commit cannot advance an existing remote branch", async () => {
  const f = await fixture(); await f.git(f.guest, "push", f.remote, `${f.base}:${f.ref}`);
  await f.git(f.guest, "checkout", "--orphan", "unrelated"); await f.git(f.guest, "rm", "-rf", ".");
  writeFileSync(join(f.guest, "orphan.txt"), "unrelated root\n"); await f.git(f.guest, "add", "."); await f.git(f.guest, "commit", "-m", "unrelated root");
  const head = await f.git(f.guest, "rev-parse", "HEAD"); await f.git(f.guest, "update-ref", f.ref, head);
  await refused(f.broker().publish(actor, { ...f.request, oldOid: f.base, newOid: head, bundle: await f.makeBundle(f.ref) }), "non_fast_forward");
  expect(f.pushes()).toBe(0);
});
test("strict fsck rejects dangerous tree entries, gitmodules and malformed commits in intact packs", async () => {
  for (const kind of ["dotgit", "gitmodules-symlink", "gitmodules-url", "missing-author"] as const) {
    const f = await fixture();
    const object = async (type: "blob" | "tree" | "commit", bytes: Uint8Array | string) => {
      const path = join(f.root, `raw-${type}-${Math.random()}`); writeFileSync(path, bytes);
      return f.git(f.guest, "hash-object", "--literally", "-w", "-t", type, path);
    };
    const blob = await object("blob", kind === "gitmodules-url" ? '[submodule "unsafe"]\n path = unsafe\n url = -uhttps://example.invalid/repo\n' : ".git/config\n");
    const tree = kind === "missing-author" ? await f.git(f.guest, "rev-parse", `${f.head}^{tree}`)
      : await object("tree", Buffer.concat([Buffer.from(`${kind === "gitmodules-symlink" ? "120000" : "100644"} ${kind === "dotgit" ? ".git" : ".gitmodules"}\0`), Buffer.from(blob, "hex")]));
    const head = kind === "missing-author"
      ? await object("commit", `tree ${tree}\nparent ${f.head}\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nmissing author\n`)
      : await f.git(f.guest, "commit-tree", tree, "-p", f.head, "-m", "unsafe tree fixture");
    await f.git(f.guest, "update-ref", f.ref, head);
    await refused(f.broker().publish(actor, { ...f.request, newOid: head, bundle: await f.makeBundle(f.ref) }), "invalid_bundle");
    expect(f.pushes()).toBe(0);
  }
});
test("small delta pack is rejected by reconstructed expansion instead of delta-program size", async () => {
  const f = await fixture();
  // Eight 4 MiB revisions are bounded below 128 MiB, but compress to a tiny
  // pack. Every revision differs in a prefix; Git packs the rest as copy deltas.
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(f.guest, "expanded.bin"), `${String(i).padStart(8, "0")}${"x".repeat(4_194_304 - 8)}`);
    await f.git(f.guest, "add", "expanded.bin"); await f.git(f.guest, "commit", "-m", `revision ${i}`);
  }
  await f.git(f.guest, "repack", "-adf", "--window=50", "--depth=50");
  const idx = readdirSync(join(f.guest, ".git/objects/pack")).find(name => name.endsWith(".idx"))!;
  const rows = (await f.git(f.guest, "verify-pack", "-v", join(f.guest, ".git/objects/pack", idx))).split("\n").filter(row => /^[a-f0-9]{40} /.test(row));
  expect(rows.some(row => row.trim().split(/\s+/).length === 7)).toBe(true);
  expect(rows.reduce((n, row) => n + Number(row.trim().split(/\s+/)[2]), 0)).toBeLessThan(8_388_608);
  const expanded = (await f.git(f.guest, "cat-file", "--batch-all-objects", "--batch-check=%(objectsize)")).split("\n").reduce((n, row) => n + Number(row), 0);
  expect(expanded).toBeGreaterThan(32_000_000); expect(expanded).toBeLessThan(134_217_728);
  const bundle = await f.makeBundle(f.ref); expect(bundle.length).toBeLessThan(100_000);
  f.options.limits = { expandedObjectBytes: 8_388_608 };
  await refused(f.broker().publish(actor, { ...f.request, newOid: await f.git(f.guest, "rev-parse", "HEAD"), bundle }), "object_budget");
  expect(f.pushes()).toBe(0);
});
test("10,000 reconstructed objects stay inside compact accounting output budget", async () => {
  const f = await fixture(), count = 9_992, blobBytes = 4096;
  // Build one valid REF_DELTA pack efficiently, with 9,992 reachable 4 KiB
  // blobs. The fixture's existing history plus the new tree/commit makes 10,000
  // objects. verify-pack -v would exceed the executor's 1 MiB output budget.
  const header = (type: number, size: number): Buffer => {
    const out = [(type << 4) | (size & 15)]; size >>>= 4;
    if (size) out[0]! |= 128;
    while (size) { const next = size & 127; size >>>= 7; out.push(next | (size ? 128 : 0)); }
    return Buffer.from(out);
  };
  const oid = (body: Buffer) => createHash("sha1").update(`blob ${body.length}\0`).update(body).digest();
  const base = Buffer.from(`00000${"x".repeat(blobBytes - 5)}`), baseOid = oid(base), objects: Buffer[] = [], entries: Buffer[] = [];
  let previousOid = baseOid;
  objects.push(Buffer.concat([header(3, base.length), deflateSync(base)]));
  for (let i = 0; i < count; i++) {
    const prefix = String(i).padStart(5, "0"), body = Buffer.from(`${prefix}${"x".repeat(blobBytes - 5)}`);
    const bodyOid = oid(body); entries.push(Buffer.concat([Buffer.from(`100644 file-${prefix}\0`), bodyOid]));
    if (i === 0) continue;
    // source/target sizes 4096; insert five bytes; copy offset 5, size 4091.
    const delta = Buffer.concat([Buffer.from([0x80, 0x20, 0x80, 0x20, 5]), Buffer.from(prefix), Buffer.from([0xb1, 5, 0xfb, 0x0f])]);
    objects.push(Buffer.concat([header(7, delta.length), i % 256 === 0 ? baseOid : previousOid, deflateSync(delta)]));
    previousOid = bodyOid;
  }
  const packHeader = Buffer.alloc(12); packHeader.write("PACK"); packHeader.writeUInt32BE(2, 4); packHeader.writeUInt32BE(count, 8);
  const pack = Buffer.concat([packHeader, ...objects]), packId = createHash("sha1").update(pack).digest("hex");
  const packPath = join(f.guest, ".git/objects/pack", `pack-${packId}.pack`);
  writeFileSync(packPath, Buffer.concat([pack, Buffer.from(packId, "hex")])); await f.git(f.guest, "index-pack", packPath);
  const treePath = join(f.root, "tree.raw"); writeFileSync(treePath, Buffer.concat(entries));
  const tree = await f.git(f.guest, "hash-object", "-w", "-t", "tree", treePath);
  const head = await f.git(f.guest, "commit-tree", tree, "-p", f.head, "-m", "bounded object-count fixture"); await f.git(f.guest, "update-ref", f.ref, head);
  const verbose = await new IsolatedGitExecutor(resolveGitExecutable(), 15_000, 2_097_152).run({ cwd: f.guest, home: f.home, args: ["verify-pack", "-v", packPath.replace(/\.pack$/, ".idx")] });
  expect(verbose.code).toBe(0); expect(Buffer.byteLength(verbose.stdout)).toBeGreaterThan(1_048_576);
  const sizes = (await f.git(f.guest, "cat-file", "--batch-all-objects", "--batch-check=%(objectsize)")).split("\n");
  expect(sizes.length).toBe(10_000); expect(sizes.reduce((n, row) => n + Number(row), 0)).toBeLessThan(67_108_864);
  expect((await f.broker().publish(actor, { ...f.request, newOid: head, bundle: await f.makeBundle(f.ref) })).status).toBe("applied");
  expect(f.pushes()).toBe(1);
}, 15_000);
test("a Unicode remote default does not disable permitted ASCII feature branches", async () => {
  const f = await fixture(); f.setDefault("refs/heads/équipe");
  expect((await f.broker().publish(actor, f.request)).status).toBe("applied");
  expect(f.pushes()).toBe(1);
});
test("pack count preflight rejects an oversized inventory before invoking Git", async () => {
  const f = await fixture(), bundle = Buffer.from(f.request.bundle), start = bundle.indexOf("\n\n") + 2;
  bundle.writeUInt32BE(200_001, start + 8);
  createHash("sha1").update(bundle.subarray(start, bundle.length - 20)).digest().copy(bundle, bundle.length - 20);
  let gitCalls = 0; const run = f.options.git.run.bind(f.options.git);
  f.options.git = { run: async command => { gitCalls++; return run(command); } };
  await refused(f.broker().publish(actor, { ...f.request, bundle }), "object_budget");
  expect(gitCalls).toBe(0); expect(f.pushes()).toBe(0);
});
