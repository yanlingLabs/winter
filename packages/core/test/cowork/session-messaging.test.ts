import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoworkRepository } from "../../src/cowork/repository";
import { mayContactCoworkPeer } from "../../src/cowork/messaging-authority";
import { SessionMessaging, type MessagingDriverHandle } from "../../src/agent/session-messaging";
import { openRuntimeStateDb } from "../../src/runtime-state/db";
import type { SessionRow } from "../../src/sessions/store";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "winter-project-messaging-"));
  const db = openRuntimeStateDb(home), records = new CoworkRepository(db);
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const rows = new Map<string, SessionRow>(), drivers = new Map<string, MessagingDriverHandle>();
  const sent: Array<{ id: string; text: string }> = [], ensured: string[] = [], stopped: string[] = [];
  let sequence = 0, ensureGate: Promise<void> | undefined;
  const context = () => ({ principalId: "fixture-user", requestId: `request-${++sequence}` });
  const session = (mode = "cowork") => {
    const sessionId = `s_${++sequence}`;
    rows.set(sessionId, { sessionId, mode, approvalPolicy: "auto", scope: "test", createdAt: 1, lastSeq: 0, title: sessionId, cwd: "/fixture/host-path-must-not-leak" });
    return sessionId;
  };
  const project = () => {
    const created = records.create(context(), { ownership: "project", title: "Test", ceiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" }, sources: [{ kind: "folder", label: "Fixture", access: "read-write", detail: { grantRef: "fixture-grant", rootIdentity: "fixture-root" } }] });
    const source = created.value.sources[0]!, epoch = records.beginIncarnation(created.workspaceId, `boot-${++sequence}`, created.revision);
    records.acknowledgeSource(epoch, source.sourceId, source.revision, "ready");
    return { workspaceId: created.workspaceId, sourceId: source.sourceId };
  };
  const bind = (workspace: ReturnType<typeof project>, id = session()) => {
    records.bindConversation({ ...context(), expectedRevision: records.get(workspace.workspaceId).configRevision }, workspace.workspaceId, { sessionId: id, sourceId: workspace.sourceId }); return id;
  };
  const driver = (id: string): MessagingDriverHandle => ({ turnRunning: true,
    send: async text => { sent.push({ id, text }); return { seq: 1, queued: false }; },
    interrupt: async () => { stopped.push(id); return { wasRunning: true }; },
  });
  const deps = {
    cowork: records,
    store: { meta: (id: string) => { const row = rows.get(id); if (!row) throw Error("missing"); return row; }, list: () => [...rows.values()] },
    derive: () => "active" as const, working: () => true,
    sessions: { get: (id: string) => drivers.get(id), ensure: async (id: string) => { ensured.push(id); if (ensureGate) await ensureGate; const value = driver(id); drivers.set(id, value); return value; } },
    log: () => {},
  };
  const messaging = new SessionMessaging(deps);
  return { db, records, rows, sent, ensured, stopped, messaging, deps, drivers, driver, session, project, bind,
    send: (from: string, to: string) => messaging.handlerFor(from, "trusted-incarnation").send({ to, message: "coordinate changes", messageId: `message-${++sequence}` }, { signal: new AbortController().signal }),
    holdEnsure: () => { let release!: () => void; ensureGate = new Promise<void>(resolve => { release = resolve; }); return release; },
  };
}

test("same-Project messages resume and attribute; discovery omits host paths and unrelated sessions", async () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), foreign = f.bind(f.project()), host = f.session("code");
  expect((await f.send(a, `session:${b}`)).status).toBe("resumed_and_delivered");
  expect(f.ensured).toEqual([b]); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.text).toContain(`<agent-message`); expect(f.sent[0]!.text).toContain(`session:${a}`);
  const visible = f.messaging.list(a);
  expect(visible.sessions.map(row => row.address)).toEqual([`session:${b}`]);
  expect(visible.sessions[0]!.cwd).toBeUndefined(); expect(visible.omitted).toBeUndefined();
  expect(f.messaging.mayList(a, a)).toBe(true);
  expect(f.messaging.mayList(a, b)).toBe(true);
  expect(f.messaging.mayList(a, foreign)).toBe(false);
  expect(f.messaging.mayList(a, host)).toBe(false);
  expect((await f.send(a, foreign)).status).toBe("not_found");
  expect((await f.send(a, host)).status).toBe("not_found");
  expect(f.ensured).toEqual([b]);
});

test("host-to-Cowork, standalone/unbound and sibling stop refuse without effects", async () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p);
  f.drivers.set(b, f.driver(b));
  for (const from of [f.session("code"), f.session("dispatch"), f.session()]) {
    expect((await f.send(from, b)).status).toBe("not_found");
    expect(f.messaging.list(from).sessions.some(row => row.address === `session:${b}`)).toBe(false);
  }
  expect((await f.messaging.stop(a, { id: b })).status).toBe("not_found");
  expect(f.stopped).toEqual([]); expect(f.ensured).toEqual([]); expect(f.sent).toEqual([]);
  f.db.db.run("UPDATE cowork_conversations SET project_id=NULL WHERE session_id=?", [a]);
  expect((await f.send(a, b)).status).toBe("not_found");
  expect(f.messaging.list(a).sessions).toEqual([]);
});

test("canonical binding/project state is rechecked after asynchronous resume", async () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p), release = f.holdEnsure();
  const pending = f.send(a, b);
  expect(f.ensured).toEqual([b]);
  f.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", [a]);
  release(); expect((await pending).status).toBe("not_found"); expect(f.sent).toEqual([]);
  expect(f.messaging.list(a).sessions).toEqual([]);
  f.db.db.run("UPDATE cowork_conversations SET state='active' WHERE session_id=?", [a]);
  f.db.db.run("UPDATE cowork_workspaces SET state='archived' WHERE workspace_id=?", [p.workspaceId]);
  expect((await f.send(a, b)).status).toBe("not_found");
});

test("missing authority and mismatched canonical project fail closed, even with matching session metadata", async () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p);
  const absent = new SessionMessaging({ ...f.deps, cowork: undefined });
  expect((await absent.handlerFor(a).send({ to: b, message: "hello", messageId: "one" }, { signal: new AbortController().signal })).status).toBe("not_found");
  const project = f.records.binding(a).projectId!;
  f.db.db.run("UPDATE cowork_workspaces SET owner_id='different-project' WHERE workspace_id=?", [p.workspaceId]);
  expect(mayContactCoworkPeer(f.records, a, b, "send")).toBe(false);
  expect((await f.send(a, b)).status).toBe("not_found");
  expect(f.records.binding(a).projectId).toBe(project); expect(f.ensured).toEqual([]);
});

test("host Code-to-Code send and stop retain existing broader authority", async () => {
  const f = fixture(), a = f.session("code"), b = f.session("code");
  f.rows.get(a)!.approvalPolicy = "ask"; f.rows.get(b)!.approvalPolicy = "bypass";
  expect((await f.send(a, b)).status).toBe("resumed_and_delivered");
  expect((await f.messaging.stop(a, { id: b })).status).toBe("stopped");
  expect(f.stopped).toEqual([b]);
});

test("a replacement retry rechecks membership and does not send into the successor", async () => {
  const f = fixture(), p = f.project(), a = f.bind(p), b = f.bind(p);
  const successor = f.driver(b);
  f.drivers.set(b, { turnRunning: false, send: async () => {
    f.db.db.run("UPDATE cowork_conversations SET state='archived' WHERE session_id=?", [a]);
    f.drivers.set(b, successor);
    throw Object.assign(new Error("replaced"), { code: "session_replaced" });
  } });
  expect((await f.send(a, b)).status).toBe("unavailable");
  expect(f.sent).toEqual([]); expect(f.ensured).toEqual([]);
});

test("session-index mode cannot downgrade a canonical guest binding to host authority", async () => {
  const f = fixture(), p = f.project(), guest = f.bind(p), peer = f.bind(p), host = f.session("code");
  f.rows.get(guest)!.mode = "code";
  expect((await f.send(guest, host)).status).toBe("not_found");
  expect((await f.send(host, guest)).status).toBe("not_found");
  expect(f.messaging.list(guest).sessions).toEqual([]);
  expect(f.messaging.mayList(guest, guest)).toBe(false);
  expect(f.messaging.mayList(host, guest)).toBe(false);
  expect((await f.send(peer, guest)).status).toBe("not_found");
  expect(f.sent).toEqual([]); expect(f.ensured).toEqual([]);
});

test("canonical record failures never fall back to broad host authority", async () => {
  const f = fixture(), host = f.session("code"), target = f.session("code");
  const unavailable = new SessionMessaging({ ...f.deps, cowork: {
    binding: () => { throw new Error("canonical store unavailable"); },
    project: (id) => f.records.project(id), get: (id) => f.records.get(id),
  } });
  expect((await unavailable.handlerFor(host).send({ to: target, message: "hello", messageId: "record-error" }, { signal: new AbortController().signal })).status).toBe("not_found");
  expect(unavailable.list(host).sessions).toEqual([]);
  expect(unavailable.mayList(host, target)).toBe(false);
  expect(unavailable.mayList(host, host)).toBe(false);
  expect((await unavailable.stop(host, { id: target })).status).toBe("not_found");
  expect(f.sent).toEqual([]); expect(f.ensured).toEqual([]); expect(f.stopped).toEqual([]);
});
