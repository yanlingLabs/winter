#!/usr/bin/env bun
/**
 * THE DELIBERATE REGENERATION DOOR for `test/projector/fixtures/golden/*.events.jsonl`.
 *
 * ── WHAT THESE FILES ARE (ruling P8b-14, Norma map §13.3) ───────────────────────────────────────
 *
 * Winter 8b replaces `AgentEngine` with a spawned `winter` child plus a projector that folds the
 * SDK's wire messages into Norma's `SessionEvent`s. The honest cutover proof is NOT a literal
 * dual-run — two live model calls answer differently every time, so a diff of their event streams
 * measures the model, not the projector. What IS comparable is the PRODUCT CONTRACT: for a given
 * scenario, which variants the daemon emits, in which order, carrying which fields.
 *
 * So this script runs the scenarios the existing fake-provider engine tests already drive
 * (`test/agent/engine-steer.test.ts`'s `setupEngine`, `engine-spawn.test.ts`'s `setup`,
 * `engine-interrupt.test.ts`) through the REAL `AgentEngine` in a temp home, and records the
 * resulting `SessionEvent` stream. `test/projector/golden-replay.test.ts` then drives the projector
 * from the matching recorded `ProtocolSdkMessage` stream and asserts it reproduces that same
 * sequence for the variants it owns.
 *
 * The goldens are therefore ENGINE-RECORDED and the projector is the thing under test. They are
 * committed artifacts, regenerated only by running this script on purpose — the same "golden
 * artifact, regenerate deliberately" pattern as `packages/protocol/scripts/generate.ts`. If a diff
 * appears after an unrelated change, that is the point: something moved in the product contract.
 *
 * ── WHY THE HUB AND NOT THE STORE ───────────────────────────────────────────────────────────────
 *
 * Every stream is captured from a HUB SUBSCRIBER, not from `store.read()`. Transients
 * (`assistant_delta` above all) are broadcast-only and never persisted, so a store-read golden
 * would silently omit exactly the variant P8b-8 makes the projector responsible for.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────────────────────────
 *
 * `seq` and `ts` are dropped; session ids, thread ids, call ids and the temp home/cwd are rewritten
 * to `<id-N>` / `<home>` / `<cwd>` tokens (stable within a file, assigned in first-appearance
 * order), so two runs of this script on an unchanged tree produce byte-identical files.
 *
 *     bun run packages/core/scripts/capture-projector-goldens.ts          # rewrite the fixtures
 *     bun run packages/core/scripts/capture-projector-goldens.ts --check  # fail if they'd change
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEvent } from "@norma/protocol";
import { SessionStore } from "../src/sessions/store";
import { SessionHub } from "../src/sessions/hub";
import { ToolRegistry } from "../src/agent/tools/registry";
import { registerReadTools } from "../src/agent/tools/fs-read";
import { registerWriteTools } from "../src/agent/tools/fs-write";
import { registerSpawnAgentTool } from "../src/agent/tools/spawn";
import { PermissionGate } from "../src/agent/gate";
import { ApprovalBroker } from "../src/agent/approvals";
import { AgentEngine } from "../src/agent/engine";
import { SessionDirectories } from "../src/agent/dirs";
import { ContextAssembler } from "../src/agent/context";
import { TrustStore } from "../src/agent/trust";
import { SkillStore } from "../src/agent/skills";
import { Compactor } from "../src/agent/compactor";
import { AgentStore } from "../src/agent/agents";
import { SubagentManager } from "../src/agent/subagents";
import { FakeProvider } from "../src/agent/fake-provider";
import { AbortAwaitProvider } from "../src/agent/test-providers";
import type { Provider, ProviderEvent } from "../src/providers/types";

const OUT_DIR = join(import.meta.dir, "..", "test", "projector", "fixtures", "golden");

// ── the harness ────────────────────────────────────────────────────────────────────────────────
// A trimmed copy of `test/agent/engine-steer.test.ts`'s `setupEngine` plus `engine-spawn.test.ts`'s
// subagent wiring. It is copied rather than imported because both of those live in `.test.ts` files
// that import `bun:test`, which cannot be loaded outside the test runner.

/** Every temp dir this run created, removed at the end (n11, review r1) — four per scenario
 *  otherwise, which is 28 abandoned directories per invocation. */
const TEMP_DIRS: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};

interface Harness {
  engine: AgentEngine;
  store: SessionStore;
  hub: SessionHub;
  broker: ApprovalBroker;
  sessionId: string;
  cwd: string;
  home: string;
  events: SessionEvent[];
}

function setupEngine(provider: Provider, opts: {
  mode?: "code" | "dispatch" | "chat";
  policy?: "ask" | "auto" | "plan" | "dont-ask" | "bypass";
  withSubagents?: boolean;
  seedFiles?: Record<string, string>;
} = {}): Harness {
  const home = temp("norma-golden-home-");
  const cwd = realpathSync(temp("norma-golden-cwd-"));
  for (const [name, body] of Object.entries(opts.seedFiles ?? {})) writeFileSync(join(cwd, name), body);
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  registerSpawnAgentTool(registry);
  const broker = new ApprovalBroker();
  const dirs = new SessionDirectories(() => [cwd]);
  const assemblerHome = temp("norma-golden-actx-");
  const assemblerTrust = new TrustStore(join(assemblerHome, "trust.json"));
  const skills = new SkillStore({ normaHome: assemblerHome, trust: assemblerTrust });
  const assembler = new ContextAssembler({ normaHome: assemblerHome, trust: assemblerTrust, skills });
  const compactor = new Compactor({ provider: { provider, model: "golden-1" }, store, hub });
  const agentsHome = temp("norma-golden-agents-");
  const agentsTrust = new TrustStore(join(agentsHome, "trust.json"));
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "golden-1" },
    dirs,
    approvalTimeoutMs: 500,
    assembler,
    compactor,
    ...(opts.withSubagents
      ? {
          agents: new AgentStore({ normaHome: agentsHome, trust: agentsTrust }),
          subagents: new SubagentManager({ maxConcurrent: () => undefined, timeoutMs: () => undefined, stallTimeoutMs: () => undefined }),
        }
      : {}),
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: opts.policy ?? "auto", ...(opts.mode ? { mode: opts.mode } : {}) });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "golden-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  return { engine, store, hub, broker, sessionId, cwd, home, events };
}

// ── provider-script helpers (same vocabulary the engine tests use) ─────────────────────────────
const done = (reason: "end_turn" | "tool_calls" | "aborted"): ProviderEvent => ({ type: "done", stopReason: reason });
const usage = (input: number, output: number): ProviderEvent => ({ type: "usage", inputTokens: input, outputTokens: output });
const call = (callId: string, name: string, args: unknown): ProviderEvent =>
  ({ type: "tool_call", callId, name, argsJson: JSON.stringify(args) });

/** What the HOST does before a turn: append the user's turn AND broadcast it. `store.append` alone
 *  would persist it but never reach a harness, so the golden would silently lose the one variant
 *  P8b-5 makes the host (not the projector) responsible for. `hub.append` is `session.send`'s own
 *  path (`sessions/hub.ts`'s `appendAndBroadcast`). */
const hostSend = (h: Harness, text: string): void => {
  h.hub.append(h.sessionId, { type: "user_message", sessionId: h.sessionId, threadId: "main", text, clientName: "golden" });
};

// ── normalization ──────────────────────────────────────────────────────────────────────────────
// Two passes: collect every identifier-shaped value first (so the token numbering follows
// first-appearance order in the STREAM, not the order a recursive walk happens to reach a key),
// then rewrite. Identifier keys are rewritten as whole values; every other string has each known
// identifier and each temp path substituted inside it, which is what keeps a `tool_result.output`
// carrying a spawned child's id (`agentId: <id>`) aligned with that child's `thread_started`.

const ID_KEYS = new Set(["sessionId", "threadId", "parentThreadId", "callId", "parentSessionId", "childSessionId", "agentId", "childId", "diffId", "taskId", "tabId"]);
const LITERAL_IDS = new Set(["main"]); // MAIN_THREAD is a literal, never an allocated id
// Wall-clock millisecond fields. Their VALUES can never be reproduced by a replay, but their
// PRESENCE is part of the contract the phone reads, so they are tokenized rather than dropped.
// (`approval_requested.id`-shaped option ids like "allow_once" are deliberately NOT in ID_KEYS:
// they are stable literals the app matches on, not allocated identifiers.)
const TIME_KEYS = new Set(["issuedAt", "expiresAt", "startedAt", "endedAt", "at", "createdAt", "updatedAt"]);

function collectIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) collectIds(v, out); return; }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEYS.has(k) && typeof v === "string" && v.length > 0 && !LITERAL_IDS.has(v)) out.add(v);
    else collectIds(v, out);
  }
}

function rewrite(value: unknown, ids: Map<string, string>, paths: Array<[string, string]>): unknown {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, ids, paths));
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") return value;
    let s = value;
    for (const [raw, token] of paths) s = s.split(raw).join(token);
    for (const [raw, token] of ids) s = s.split(raw).join(token);
    return s;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "seq" || k === "ts") continue; // the two fields a replay can never reproduce
    if (TIME_KEYS.has(k) && typeof v === "number") { out[k] = "<ms>"; continue; }
    if (ID_KEYS.has(k) && typeof v === "string" && LITERAL_IDS.has(v)) { out[k] = v; continue; }
    if (ID_KEYS.has(k) && typeof v === "string" && ids.has(v)) { out[k] = ids.get(v)!; continue; }
    out[k] = rewrite(v, ids, paths);
  }
  return out;
}

function normalize(events: SessionEvent[], h: Pick<Harness, "home" | "cwd">): string {
  const raw = new Set<string>();
  for (const e of events) collectIds(e, raw);
  const ids = new Map<string, string>();
  let n = 0;
  for (const r of raw) ids.set(r, `<id-${++n}>`);
  // Longest-first so `<cwd>` never eats a prefix of `<home>` or vice versa.
  const paths: Array<[string, string]> = [[h.cwd, "<cwd>"], [h.home, "<home>"]].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;
  return `${events.map((e) => JSON.stringify(rewrite(e, ids, paths))).join("\n")}\n`;
}

// ── the scenarios ──────────────────────────────────────────────────────────────────────────────
// Each returns the raw hub stream for one turn. The host's own `user_message` append (what
// `ipc/server.ts`'s `session.send` does before starting a turn, and what the Winter leg's host push
// queue does per P8b-5) is part of every scenario, because it is part of the product contract.

const scenarios: Array<{ name: string; run: () => Promise<{ events: SessionEvent[]; home: string; cwd: string }> }> = [
  {
    // Chat: conversation only, no tools. The projector's minimum path — deltas, one final
    // assistant_message, one terminal.
    name: "chat-text-only",
    run: async () => {
      const provider = new FakeProvider([[{ type: "text_delta", delta: "Hello" }, { type: "text_delta", delta: ", world." }, usage(1200, 40), done("end_turn")]]);
      const h = setupEngine(provider, { mode: "chat", policy: "auto" });
      hostSend(h, "say hello");
      await h.engine.runTurn(h.sessionId);
      return h;
    },
  },
  {
    // Code: one tool call, its result, then a wrap-up message. Two provider rounds.
    name: "code-tool-call",
    run: async () => {
      const provider = new FakeProvider([
        [call("c1", "read", { path: "note.txt" }), usage(1500, 25), done("tool_calls")],
        [{ type: "text_delta", delta: "The note says hello." }, usage(1800, 12), done("end_turn")],
      ]);
      const h = setupEngine(provider, { mode: "code", policy: "auto", seedFiles: { "note.txt": "hello from the golden fixture\n" } });
      hostSend(h, "read note.txt");
      await h.engine.runTurn(h.sessionId);
      return h;
    },
  },
  {
    // Code, policy `ask`: a gated tool call the user refuses. The approval pair and the denial
    // tool_result are Task 11's variants, but the surrounding conversation spine is part 1's.
    name: "code-tool-denied",
    run: async () => {
      const provider = new FakeProvider([
        [call("c1", "write", { path: "/etc/nope.txt", content: "x" }), usage(1500, 30), done("tool_calls")],
        [{ type: "text_delta", delta: "Understood — I will not write there." }, usage(1700, 14), done("end_turn")],
      ]);
      const h = setupEngine(provider, { mode: "code", policy: "ask" });
      // The user answers "no" the instant the card appears — deterministic, and far faster than
      // letting `approvalTimeoutMs` expire (a timeout is a different product path).
      const seen = new Set<string>();
      const deny = setInterval(() => {
        for (const p of h.broker.list(h.sessionId)) if (!seen.has(p.callId)) { seen.add(p.callId); h.broker.resolve(h.sessionId, p.callId, false, "golden"); }
      }, 5);
      hostSend(h, "write to /etc/nope.txt");
      try { await h.engine.runTurn(h.sessionId); } finally { clearInterval(deny); }
      return h;
    },
  },
  {
    // A child agent spawned and run to completion. `spawn_agent` declares no `modes`, so the
    // registry defaults it to `["code"]` — a CODE session is the only place this scenario can be
    // captured today (see the report's scenario table).
    name: "code-child-spawn",
    run: async () => {
      const provider = new FakeProvider([
        [call("s1", "spawn_agent", { prompt: "summarise the note", description: "summarise", run_in_background: false }), usage(1600, 40), done("tool_calls")],
        // round 2 is the CHILD's own turn (a fresh runThread over the same scripted provider)
        [{ type: "text_delta", delta: "child final report" }, usage(900, 20), done("end_turn")],
        [{ type: "text_delta", delta: "The child reported back." }, usage(2000, 16), done("end_turn")],
      ]);
      const h = setupEngine(provider, { mode: "code", policy: "auto", withSubagents: true });
      hostSend(h, "delegate the summary");
      await h.engine.runTurn(h.sessionId);
      return h;
    },
  },
  {
    // A provider failure ends the turn. The engine emits BOTH `agent_error` and
    // `turn_completed(stopReason:"error")`, in that order (engine.ts:2905-2906) — the projector's
    // terminal rule must reproduce the pair, not choose between them.
    name: "code-provider-error",
    run: async () => {
      const provider = new FakeProvider([[usage(1400, 0), { type: "error", message: "HTTP 429: rate limited", code: "rate_limit" }]]);
      const h = setupEngine(provider, { mode: "code", policy: "auto" });
      hostSend(h, "do the thing");
      await h.engine.runTurn(h.sessionId);
      return h;
    },
  },
  {
    // An interrupt is a TURN BOUNDARY, never an error (ruling P8b-24): one
    // `turn_completed(stopReason:"aborted")`, no `agent_error`.
    name: "code-interrupted",
    run: async () => {
      const provider = new AbortAwaitProvider();
      const h = setupEngine(provider, { mode: "code", policy: "auto" });
      hostSend(h, "start something long");
      const turn = h.engine.runTurn(h.sessionId);
      await new Promise((r) => setTimeout(r, 25));
      h.engine.interrupt(h.sessionId);
      await turn;
      return h;
    },
  },
  {
    // Dispatch mode drives the same conversation spine as code with a different tool surface — the
    // per-mode row the other five scenarios do not cover.
    name: "dispatch-tool-call",
    run: async () => {
      const provider = new FakeProvider([
        [call("c1", "read", { path: "note.txt" }), usage(1100, 22), done("tool_calls")],
        [{ type: "text_delta", delta: "Done." }, usage(1300, 6), done("end_turn")],
      ]);
      const h = setupEngine(provider, { mode: "dispatch", policy: "auto", seedFiles: { "note.txt": "hello from the golden fixture\n" } });
      hostSend(h, "read the note");
      await h.engine.runTurn(h.sessionId);
      return h;
    },
  },
];

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const check = process.argv.includes("--check");
mkdirSync(OUT_DIR, { recursive: true });
let drift = 0;
for (const s of scenarios) {
  const h = await s.run();
  const body = normalize(h.events, h);
  const path = join(OUT_DIR, `${s.name}.events.jsonl`);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (check) {
    if (before !== body) { drift++; console.error(`DRIFT  ${s.name}.events.jsonl`); }
    else console.log(`ok     ${s.name}.events.jsonl (${h.events.length} events)`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  console.log(`${before === undefined ? "new   " : before === body ? "same  " : "CHANGED"} ${s.name}.events.jsonl (${h.events.length} events: ${[...new Set(h.events.map((e) => e.type))].join(", ")})`);
}
for (const dir of TEMP_DIRS) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp dir must never fail a capture */ } }
if (check && drift > 0) { console.error(`\n${drift} golden file(s) would change — rerun without --check to accept, and say why in the commit.`); process.exit(1); }
