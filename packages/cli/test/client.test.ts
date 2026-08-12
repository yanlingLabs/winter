import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, FileSecretStore, FakeProvider, MemoryStore, type RunningDaemon } from "@norma/core";
import { NormaClient } from "../src/client";
import { encodeLine, METHODS, PROTOCOL_VERSION } from "@norma/protocol";

describe("NormaClient", () => {
  let daemon: RunningDaemon;
  afterEach(() => daemon?.stop());

  // `provider` left `undefined` (the default) preserves the pre-existing behavior of every
  // caller below: daemon.ts auto-detects from real settings/secrets, which is a no-op on a fresh
  // tmpdir `home` almost everywhere EXCEPT this may pick up real host-machine credentials in some
  // dev environments. Pass explicit `null` (Task 6 tests) to force a deterministic no-provider
  // daemon regardless of host state.
  async function boot(provider?: FakeProvider | null, settingsOverrides?: Record<string, unknown>): Promise<string> {
    const home = mkdtempSync(join(tmpdir(), "norma-cli-"));
    if (settingsOverrides) writeFileSync(join(home, "settings.json"), JSON.stringify(settingsOverrides));
    daemon = await startDaemon({
      home,
      secrets: new FileSecretStore(join(home, "test-secrets")),
      ...(provider !== undefined ? { agentProvider: provider ? { provider, model: "fake-1" } : null } : {}),
    });
    return home;
  }

  test("connect + hello + create + attach + send + receive own event", async () => {
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath,
      token: daemon.tokens.harness,
      clientName: "cli-test",
      onEvent: (e) => events.push(e),
    });
    const { sessionId } = await client.createSession("global");
    await client.attach(sessionId);
    await client.send(sessionId, "ping");
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === "user_message" && e.text === "ping")).toBe(true);
    client.close();
  });

  test("bad token raises a clear error", async () => {
    await boot();
    await expect(NormaClient.connect({
      socketPath: daemon.socketPath, token: "wrong", clientName: "x", onEvent: () => {},
    })).rejects.toThrow(/invalid token/);
  });

  test("client can add a directory and receive directory_added", async () => {
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cli-cwd-")) });
    await client.attach(sessionId);
    const extra = mkdtempSync(join(tmpdir(), "norma-cli-extra-"));
    const roots = await client.addDir(sessionId, extra);
    expect(roots).toContain(realpathSync(extra));
    await new Promise((r) => setTimeout(r, 30));
    expect(events.some((e) => e.type === "directory_added")).toBe(true);
    client.close();
  });

  // Live child-transcript view T3: the two thin wrappers over thread.send/agent.stop. Full
  // queued/resumed/unknown-agent coverage already lives at the protocol/core level (T1's
  // server.test.ts) — this just pins the CLIENT's own round-trip (request + zod-validated
  // result), same "unknown agent -> clear rejection" shape client.test.ts already exercises for
  // other RPCs above (no bg-agent fixture is reachable through this file's plain `startDaemon`).
  test("sendToThread/agentStop against an unknown agent reject with a clear error (client-side round-trip)", async () => {
    await boot();
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli", onEvent: () => {},
    });
    const { sessionId } = await client.createSession("global");
    await client.attach(sessionId);
    await expect(client.sendToThread(sessionId, "ghost", "hi")).rejects.toThrow(/ghost/);
    await expect(client.agentStop(sessionId, "ghost")).rejects.toThrow(/ghost/);
    client.close();
  });

  test("createSession returns trusted; trustDir makes a later create trusted", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "t", onEvent: () => {} });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-trust-")));
    const first = await client.createSession("global", { cwd });
    expect(first.trusted).toBe(false);
    expect(await client.trustDir(cwd)).toBe(true);
    const second = await client.createSession("global", { cwd });
    expect(second.trusted).toBe(true);
    client.close();
  });

  test("bg client methods round-trip", async () => {
    if (process.platform !== "darwin") { return; }
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "bg", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cli-bg-")), approvalPolicy: "auto" });
    // no tasks yet:
    expect((await client.bgList(sessionId)).length).toBe(0);
    expect((await client.bgKillAll(sessionId)).killed).toBe(0);
    client.close();
  });

  test("steer/interrupt client methods round-trip", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "si", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-si-")), approvalPolicy: "auto" });
    // idle interrupt → wasRunning:false
    expect((await client.interrupt(sessionId)).wasRunning).toBe(false);
    // steer with no running turn → injected:false (starts a turn)
    expect((await client.steer(sessionId, "hi")).injected).toBe(false);
    client.close();
  });

  test("compact client method round-trip (no engine → nothing to compact)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cc", onEvent: () => {} });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-cc-")), approvalPolicy: "auto" });
    expect(await client.compact(sessionId)).toEqual({ compacted: false, uptoSeq: 0, summaryChars: 0 });
    client.close();
  });

  // 5c T3 review regression: since T1, EVERY skills.list response carries the shipped
  // writing-skills builtin (source:"builtin") — this must survive listSkills' SkillsListResult
  // validation (client.ts throws "invalid result from server" on any unparseable element, and
  // z.array() fails wholesale on one), which is exactly how `norma skills` and /skills broke when
  // the wire schema's source enum lagged behind core's SkillMeta.
  test("listSkills client method round-trip: the always-present builtin passes the VALIDATED client path", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "sk", onEvent: () => {} });
    const skills = await client.listSkills(process.cwd()); // throws if any element fails schema validation
    expect(skills).toEqual([{ name: "writing-skills", description: expect.any(String), source: "builtin", path: expect.any(String) }]);
    client.close();
  });

  test("pluginsList client method round-trip (no plugins installed)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "pl", onEvent: () => {} });
    expect(await client.pluginsList()).toEqual({ ok: true, plugins: [] });
    client.close();
  });

  test("askUserRespond + taskList client methods round-trip", async () => {
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify({
        questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }], multiSelect: false }],
      }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "t1", name: "task_create", argsJson: JSON.stringify({ subject: "Ship it", description: "Ship the release" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot(fake);
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "aq", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-aq-")), approvalPolicy: "auto" });
    await client.attach(sessionId);
    await client.send(sessionId, "ask, then track a task");

    // wait for the question_asked event
    for (let i = 0; i < 50 && !events.some((e) => e.type === "question_asked"); i++) await new Promise((r) => setTimeout(r, 10));
    const asked = events.find((e) => e.type === "question_asked");
    expect(asked).toBeTruthy();

    const first = await client.askUserRespond({ sessionId, callId: asked.callId, answers: { "Pick one": "B" } });
    expect(first).toEqual({ ok: true, alreadyResolved: false });
    const second = await client.askUserRespond({ sessionId, callId: asked.callId, answers: { "Pick one": "B" } });
    expect(second).toEqual({ ok: true, alreadyResolved: true });

    for (let i = 0; i < 50 && !events.some((e) => e.type === "turn_completed"); i++) await new Promise((r) => setTimeout(r, 10));
    const list = await client.taskList({ sessionId });
    expect(list).toEqual({ ok: true, tasks: [{ id: "1", subject: "Ship it", status: "pending" }] });
    client.close();
  });

  // Task 3 (ask_user CC parity): proves the CLI client's askUserRespond ACTUALLY forwards an
  // optional `notes` map over the wire — the protocol/core sides already have their own T1/T2
  // tests, but nothing else exercises client.ts's (hand-written, non-generated) param type, which
  // is what main.ts's new note prompt calls through.
  test("askUserRespond forwards optional notes, mirrored onto the persisted question_resolved event", async () => {
    const fake = new FakeProvider([
      [{ type: "tool_call", callId: "q1", name: "ask_user", argsJson: JSON.stringify({
        questions: [{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }], multiSelect: false }],
      }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    await boot(fake);
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "aqn", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-aqn-")), approvalPolicy: "auto" });
    await client.attach(sessionId);
    await client.send(sessionId, "ask");

    for (let i = 0; i < 50 && !events.some((e) => e.type === "question_asked"); i++) await new Promise((r) => setTimeout(r, 10));
    const asked = events.find((e) => e.type === "question_asked");
    expect(asked).toBeTruthy();

    const result = await client.askUserRespond({
      sessionId, callId: asked.callId, answers: { "Pick one": "B" }, notes: { "Pick one": "went with B because it's simpler" },
    });
    expect(result).toEqual({ ok: true, alreadyResolved: false });

    for (let i = 0; i < 50 && !events.some((e) => e.type === "question_resolved"); i++) await new Promise((r) => setTimeout(r, 10));
    const resolved = events.find((e) => e.type === "question_resolved");
    expect(resolved.notes).toEqual({ "Pick one": "went with B because it's simpler" });
    client.close();
  });

  test("threadList client method round-trip (main thread seeded lazily on first read)", async () => {
    await boot();
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "th", onEvent: () => {} });
    const { sessionId } = await client.createSession("global");
    expect(await client.threadList({ sessionId })).toEqual({ ok: true, threads: [{ threadId: "main", status: "running" }] });
    client.close();
  });

  test("daemonStatus client method round-trip (no provider configured)", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "ds", onEvent: () => {} });
    const before = await client.daemonStatus();
    expect(before).toMatchObject({ socketPath: daemon.socketPath, provider: null, sessionsCount: 0, pluginsCount: 0 });
    expect(typeof before.version).toBe("string");
    expect(before.uptimeMs).toBeGreaterThanOrEqual(0);
    await client.createSession("global");
    const after = await client.daemonStatus();
    expect(after.sessionsCount).toBe(1);
    client.close();
  });

  test("daemonStatus reports the configured provider", async () => {
    await boot(new FakeProvider([]));
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "dsp", onEvent: () => {} });
    const status = await client.daemonStatus();
    expect(status.provider).toEqual({ id: "fake", model: "fake-1" });
    client.close();
  });

  test("quotaState client method round-trip (no provider → inert ok state)", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "qs", onEvent: () => {} });
    expect(await client.quotaState()).toEqual({ kind: "ok", inputTokens: 0, outputTokens: 0 });
    client.close();
  });

  test("trustList/trustRemove client methods round-trip", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "tr", onEvent: () => {} });
    expect(await client.trustList()).toEqual([]);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-trustlist-")));
    await client.trustDir(dir);
    expect(await client.trustList()).toEqual([dir]);
    expect(await client.trustRemove(dir)).toBe(true);
    expect(await client.trustList()).toEqual([]);
    expect(await client.trustRemove(dir)).toBe(false); // idempotent — already untrusted
    client.close();
  });

  // Phase 4b Task 2: the CLI-facing wrapper over the harness-role plugin.revokeToken RPC (used by
  // `norma plugin disable/remove`). `plugin_tokens` lives in the daemon's own sqlite, which this
  // test doesn't have direct access to (RunningDaemon doesn't expose SessionStore) — but the
  // handler is idempotent for a never-minted id, so the round-trip is fully exercisable without it.
  test("pluginRevokeToken client method round-trips (idempotent on a never-minted id)", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "prt", onEvent: () => {} });
    expect(await client.pluginRevokeToken("never-minted-plugin")).toEqual({ ok: true });
    client.close();
  });

  // Final-review Fix 1: the CLI-facing wrapper over the harness/admin-role plugin.restart RPC
  // (used by `norma plugin restart <id>`). A `FakeProvider` daemon DOES wire a real
  // PluginSupervisor (daemon.ts only builds one `if (agentProvider)`) but this fixture home has no
  // plugins directory, so the supervisor tracks nothing — restarting an id it never saw is exactly
  // `plugin.restart`'s typed NOT_FOUND path (ipc/server.ts), fully exercisable without a real
  // spawned plugin process. The deeper "restarts a circuit-open plugin and it re-spawns" behavior
  // is covered at the ipc/server.ts level (core/test/server.test.ts) with an injected fake spawn.
  test("restartPlugin client method rejects a plugin id the supervisor has never tracked", async () => {
    await boot(new FakeProvider([]));
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "rsp", onEvent: () => {} });
    await expect(client.restartPlugin("never-existed")).rejects.toThrow(/unknown plugin/);
    client.close();
  });

  // Phase 5 routines T3: the four routines.* client methods, round-tripped against a real daemon
  // (its RoutineStore is wired unconditionally, provider or not — daemon.ts's own precedent for
  // peripheral/hardware). Mirrors the shape of the plugin-lifecycle round-trip tests above.
  test("routines client methods round-trip: create, list, update, delete", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "routines", onEvent: () => {} });

    const { routine } = await client.routinesCreate({ spec: "every 30m", prompt: "check inbox" });
    expect(routine.spec).toBe("every 30m");
    expect(routine.policy).toBe("auto");
    expect(routine.enabled).toBe(true);

    expect((await client.routinesList()).routines).toHaveLength(1);

    const updated = await client.routinesUpdate({ id: routine.id, patch: { enabled: false } });
    expect(updated.routine.enabled).toBe(false);

    const deleted = await client.routinesDelete(routine.id);
    expect(deleted).toEqual({ ok: true, removed: true });
    expect((await client.routinesList()).routines).toHaveLength(0);

    client.close();
  });

  test("routinesCreate rejects an invalid spec", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "routines-bad", onEvent: () => {} });
    await expect(client.routinesCreate({ spec: "not a spec", prompt: "x" })).rejects.toThrow();
    client.close();
  });

  // Phase 5b Task 4: memoryList/memoryRead/memoryDelete round-tripped against a real daemon
  // (its MemoryStore is wired unconditionally, same daemon.ts precedent as RoutineStore above).
  // No `memoryWrite` client method exists (write is tool-only, per the brief — CLI/slash only
  // list/show/rm), so this seeds the fact directly through a second `MemoryStore` instance
  // pointed at the SAME normaHome: both are stateless fact-file readers/writers over the same
  // directory, no in-process cache to desync (memory.ts's own `list`/`read` re-read from disk on
  // every call) — the daemon's own instance sees whatever this one writes.
  //
  // T2 (design doc "dashboard rewire") makes memory.enabled default ON route these RPCs onto
  // MEMDIR files instead (ipc/server.ts's `memoryFileDir`) — since this test seeds the LEGACY
  // store directly, it explicitly disables the new backend so the RPCs still read from where it
  // wrote. Files-backed RPC coverage lives in core's own daemon-memory-rpc.test.ts.
  test("memoryList/memoryRead/memoryDelete round-trip against a real daemon", async () => {
    const home = await boot(null, { memory: { enabled: false } });
    const seed = new MemoryStore({ normaHome: home, trust: { isTrusted: () => true } });
    const wrote = await seed.write("user", { name: "captain", description: "prefers concise replies", type: "user", body: "Sam prefers short answers." }, { source: "rpc" });
    expect(wrote.ok).toBe(true);

    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "memory", onEvent: () => {} });

    const { facts } = await client.memoryList("user");
    expect(facts).toEqual([{ name: "captain", description: "prefers concise replies", type: "user" }]);

    const { fact } = await client.memoryRead("user", "captain");
    expect(fact).toEqual({ name: "captain", description: "prefers concise replies", type: "user", body: "Sam prefers short answers." });

    await client.memoryDelete("user", "captain");
    expect((await client.memoryList("user")).facts).toEqual([]);
    await expect(client.memoryRead("user", "captain")).rejects.toThrow(/not found/);

    client.close();
  });

  test("memoryRead rejects an invalid name", async () => {
    await boot(null);
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "memory-bad", onEvent: () => {} });
    await expect(client.memoryRead("user", "Not A Valid Slug")).rejects.toThrow();
    client.close();
  });

  test("init prompt reaches the session (canned NORMA.md-generation prompt)", async () => {
    const { INIT_PROMPT } = await import("../src/main");
    expect(INIT_PROMPT).toMatch(/NORMA\.md/i);
    await boot();
    const events: any[] = [];
    const client = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "init", onEvent: (e) => events.push(e) });
    const { sessionId } = await client.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "norma-init-")), approvalPolicy: "auto" });
    await client.attach(sessionId);
    await client.send(sessionId, INIT_PROMPT);
    await new Promise((r) => setTimeout(r, 40));
    expect(events.some((e) => e.type === "user_message" && e.text === INIT_PROMPT)).toBe(true);
    client.close();
  });

  test("resume continues an existing session (no new session)", async () => {
    await boot();
    const c1 = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "a", onEvent: () => {} });
    const { sessionId } = await c1.createSession("global", { cwd: mkdtempSync(join(tmpdir(), "r-")), approvalPolicy: "auto" });
    await c1.attach(sessionId); await c1.send(sessionId, "first"); c1.close();
    const seen: any[] = [];
    const c2 = await NormaClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "b", onEvent: (e) => seen.push(e) });
    const tip = (await c2.listSessions()).sessions.find((r: any) => r.sessionId === sessionId)!.lastSeq;
    await c2.attach(sessionId, tip); await c2.send(sessionId, "second");
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((e) => e.type === "user_message" && e.text === "second")).toBe(true);
    // attach-from-tip (not 0): the historical "first" message must NOT be replayed to the resuming client
    expect(seen.some((e) => e.type === "user_message" && e.text === "first")).toBe(false);
    c2.close();
  });

  // session-activity-hygiene T9 (amendment): `session.list` has always SENT `cwd` — `store.list()`
  // selects it and the handler returns rows verbatim — but `SessionListResult` never declared it, and
  // `validated()`'s safeParse strips every undeclared key. So the field reached the wire and died at
  // this client, silently: `norma agents` could not show a cwd column for data the daemon was already
  // putting on the socket. (Swift's own `NormaClient.listSessions()` reads `s["cwd"]` off the raw
  // JSON and has been consuming it all along — the TS schema was the odd one out.)
  //
  // This is a LIVE round-trip on purpose: a schema unit test would pass the day the daemon stopped
  // populating the field, and a daemon-side test would pass the day the schema stopped declaring it.
  // Only both ends at once prove the value survives.
  test("session.list round-trips `cwd` through the client's schema validation (T9)", async () => {
    await boot();
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli-cwd", onEvent: () => {},
    });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-listcwd-")));
    const { sessionId } = await client.createSession("global", { cwd });
    const withCwd = (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
    expect(withCwd!.cwd).toBe(cwd);

    // Absent stays ABSENT — a session created without one must not acquire a fabricated cwd (the
    // store writes NULL, `store.list()` maps it to undefined, and the optional field omits it).
    const { sessionId: bare } = await client.createSession("global");
    const withoutCwd = (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === bare);
    expect(withoutCwd!.cwd).toBeUndefined();
    client.close();
  });

  // mac-chat-parity T4 (the T9/`dirs` precedent, applied to `approvalPolicy`): the field is declared
  // in the SAME schema `listSessions()` validates against, so it carries the identical silent-strip
  // hazard — and the identical LIVE round trip is the only thing that closes both ends at once. A
  // schema unit test passes the day the daemon stops populating the field; a daemon-side test passes
  // the day the schema stops declaring it. This one fails on either.
  //
  // Read AFTER a real `session.setPolicy` as well as at create time, because the field's whole
  // purpose is to report what the setter wrote — a row that only ever echoed the creation argument
  // would satisfy a create-only assertion while telling a picker nothing it did not already know.
  test("session.list round-trips `approvalPolicy` through the client's schema validation (mac-chat-parity T4)", async () => {
    await boot();
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli-policy", onEvent: () => {},
    });
    const policyOf = async (id: string) =>
      (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === id)!.approvalPolicy;

    const { sessionId } = await client.createSession("global", { approvalPolicy: "bypass" });
    expect(await policyOf(sessionId)).toBe("bypass");

    // The daemon's own default, never absent: a row that omitted its policy would be
    // indistinguishable from an older daemon's, which is the one reading absence is reserved for.
    const { sessionId: plain } = await client.createSession("global");
    expect(await policyOf(plain)).toBe("ask");

    await client.setPolicy(plain, "plan");
    expect(await policyOf(plain)).toBe("plan");
    client.close();
  });

  // working-directories T3 (the T9-hygiene precedent, applied to `dirs`): `SessionListResult`'s
  // `dirs` field is declared in the SAME schema `listSessions()` validates against — the risk T9
  // found is exactly this: an undeclared field the daemon already sends dies silently at
  // `validated()`'s safeParse. A schema-only unit test would pass the day the daemon stopped
  // populating `dirs`; a daemon-only test would pass the day the schema stopped declaring it. Only
  // a LIVE round trip through a real daemon + the real client proves the value survives both ends.
  //
  // Also pins the `cwd` alias (`cwd === dirs[0]?.path`) two ways: (1) a GENUINELY pre-branch row —
  // `cwd` set at create time, `dirs` column forced back to NULL by hand (working-directories T6:
  // `session.create` now writes `dirs` DIRECTLY at INSERT time — unlocked — so the lazy migration
  // this pins is reachable only by a row that predates T6; there is no such row in a fresh test
  // daemon, so this test fakes one via a second sqlite connection to the daemon's own index.db,
  // mirroring `session-set-dirs.test.ts`'s identical T6 fix) — and (2) after a REAL `session.setDirs`
  // write, which changes `dirs[0].path` without ever touching the stored `cwd` column
  // (`setDirsRaw`'s own contract) — proving `session.list`'s `cwd` is populated FROM `dirs` at read
  // time, not trusted from that now-stale column.
  test("session.list round-trips `dirs` through the client's schema validation, cwd kept an alias (working-directories T3)", async () => {
    const home = await boot();
    const client = await NormaClient.connect({
      socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cli-dirs", onEvent: () => {},
    });

    // (1) A genuinely pre-branch-style row: `cwd` set at create time, `dirs` column forced NULL.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-listdirs-")));
    const { sessionId } = await client.createSession("global", { cwd });
    const raw = new Database(join(home, "sessions", "index.db"));
    raw.run("UPDATE sessions SET dirs = NULL WHERE session_id = ?", [sessionId]);
    raw.close();
    const migrated = (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
    expect(migrated!.dirs).toEqual([{ path: cwd, locked: true }]);
    expect(migrated!.cwd).toBe(cwd);
    expect(migrated!.cwd).toBe(migrated!.dirs![0]!.path); // the alias, stated as itself

    // (2) A REAL session.setDirs write changes the primary — `dirs` reflects it, and `cwd` (the
    // alias) follows it too, even though `setDirsRaw` never touches the `cwd` column. A FRESH,
    // cwd-LESS session (not the migrated one above): the migrated row's `dirs[0]` derives
    // `locked: true` (T1's `deriveFromCwd`), and `setPrimary` correctly REFUSES over a locked
    // primary (T2) — this proves the write path on a session where it's actually legal to write.
    const { sessionId: bareId } = await client.createSession("global");
    const newPrimary = realpathSync(mkdtempSync(join(tmpdir(), "norma-cli-listdirs-2-")));
    const written = await client.sessionSetDirs({ sessionId: bareId, op: "setPrimary", path: newPrimary });
    expect(written.dirs).toEqual([{ path: newPrimary, locked: false }]);
    const afterWrite = (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === bareId);
    expect(afterWrite!.dirs).toEqual([{ path: newPrimary, locked: false }]);
    expect(afterWrite!.cwd).toBe(newPrimary);

    // Absent stays ABSENT for a chat session — `dirs` applies to code/cowork only (same
    // participation gate as `activity`), mirroring the `cwd` test's own bare-session absence check.
    const chatCreate = await client.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    const chatRow = (await client.listSessions()).sessions.find((s: { sessionId: string }) => s.sessionId === chatCreate.sessionId);
    expect(chatRow!.dirs).toBeUndefined();
    client.close();
  });
});

describe("NormaClient against a hostile/fake server", () => {
  test("skips unknown future event types and times out hung requests", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "norma-fake-")), "fake.sock");
    Bun.listen({
      unix: sock,
      socket: {
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.hello) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION } }));
              // immediately push an unknown future event, then a known one:
              s.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: { type: "quantum_flux", seq: 1, sessionId: "s_x", ts: 1 } }));
              s.write(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: { type: "session_created", seq: 1, sessionId: "s_x", ts: 1, scope: "global" } }));
            }
            // all other requests: never answer (hang)
          }
        },
      },
    });
    const events: any[] = [];
    const client = await NormaClient.connect({
      socketPath: sock, token: "t", clientName: "fc", timeoutMs: 200, onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1); // future event skipped, known one delivered
    expect(events[0].type).toBe("session_created");
    await expect(client.request(METHODS.sessionList)).rejects.toThrow(/timed out/);
    client.close();
  });

  // orb-regressions fix round 1 (2026-07-29), review finding I1 — the TS twin of the NormaKit bug.
  //
  // `request(method, params?)` builds `encodeLine({jsonrpc, id, method, params})`, and
  // `JSON.stringify` DROPS a key whose value is `undefined` — so a params-less call emitted
  // `{"jsonrpc":"2.0","id":N,"method":"session.list"}` with no `params` key at all, character-for-
  // character the frame that killed the orb from Swift. It has one live params-less caller today
  // (`listSessions()`), which survived only because `session.list`'s handler happens not to call
  // `parseParams`. Any no-argument method the CLI calls without params — or a schema growing onto
  // `session.list` — would have reproduced `-32602 invalid params: (root)` in the CLI/TUI while
  // both Swift suites stayed green. Pinned on the WIRE (not end-to-end against a daemon) so this
  // stays RED for a CLI-only regression even though the daemon now normalizes `params ?? {}` too.
  test("a params-less request still puts an empty params object on the wire", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "norma-fake-params-")), "fake.sock");
    const lines: any[] = [];
    Bun.listen({
      unix: sock,
      socket: {
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            lines.push(msg);
            if (msg.method === METHODS.hello) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION } }));
            } else if (msg.method === METHODS.sessionList) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { sessions: [] } }));
            } else {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: {} }));
            }
          }
        },
      },
    });
    const client = await NormaClient.connect({ socketPath: sock, token: "t", clientName: "v", timeoutMs: 500, onEvent: () => {} });

    await client.listSessions();                 // the one live params-less caller
    await client.request(METHODS.sessionDispatch); // a no-argument method with a real z.object({})

    const listFrame = lines.find((l) => l.method === METHODS.sessionList);
    const dispatchFrame = lines.find((l) => l.method === METHODS.sessionDispatch);
    expect(listFrame).toBeTruthy();
    expect(dispatchFrame).toBeTruthy();
    // `"params" in frame` is the assertion that matters — JSON.stringify drops undefined values,
    // so a missing key is exactly the pre-fix wire shape.
    expect("params" in listFrame).toBe(true);
    expect(listFrame.params).toEqual({});
    expect("params" in dispatchFrame).toBe(true);
    expect(dispatchFrame.params).toEqual({});
    client.close();
  });

  test("client rejects a malformed result for a validated method", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "norma-fake2-")), "fake.sock");
    Bun.listen({
      unix: sock,
      socket: {
        data(s, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.hello) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { ok: true, serverVersion: "fake", protocolVersion: PROTOCOL_VERSION } }));
            } else if (msg.method === METHODS.sessionCreate) {
              s.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result: { sessionned: 42 } })); // wrong shape
            }
          }
        },
      },
    });
    const client = await NormaClient.connect({ socketPath: sock, token: "t", clientName: "v", timeoutMs: 500, onEvent: () => {} });
    await expect(client.createSession("global")).rejects.toThrow(/invalid result/);
    client.close();
  });
});
