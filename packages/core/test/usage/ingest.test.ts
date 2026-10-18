// The usage DB's external ingest (`docs/claude/usage.md`): Codex rollouts and Claude Code transcripts, read
// incrementally (offsets, truncation, rotation), deduped, priced with the runtime's own catalog price function — and
// the privacy rule: nothing but numbers, a model, a time and an opaque id is ever stored.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService } from "../../src/usage/service";
import { readNewLines } from "../../src/usage/ingest-files";
import { stat } from "node:fs/promises";
import {
  SECRETS, claudeAssistant, claudeTranscriptPath, claudeUser, codexMessage, codexMeta, codexRolloutPath, codexTokenCount,
  codexTurnContext, lines, probeRootIn, tempDir,
} from "./fixtures";

const pricer = new UsagePricer();

function service(opts: { codexHome?: string; claudeHome?: string; tracking?: { codex: boolean; claudeCode: boolean }; now?: () => number; fileBudgetBytes?: number; maxLineBytes?: number } = {}) {
  const home = tempDir("home");
  const db = new UsageDb(join(home, "usage", "usage.db"));
  const svc = new UsageService({
    db, pricer, tracking: () => opts.tracking ?? { codex: true, claudeCode: true },
    ...(opts.codexHome === undefined ? {} : { codexHome: opts.codexHome }),
    ...(opts.claudeHome === undefined ? {} : { claudeHome: opts.claudeHome }),
    codexExecutable: () => undefined, claudeExecutable: () => undefined, winterCodexWindows: () => [],
    probeRoot: () => probeRootIn(home), ingestEveryMs: 0, ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.fileBudgetBytes === undefined ? {} : { fileBudgetBytes: opts.fileBudgetBytes }),
    ...(opts.maxLineBytes === undefined ? {} : { maxLineBytes: opts.maxLineBytes }),
  });
  return { home, db, svc };
}

function rows(db: UsageDb): Array<Record<string, unknown>> {
  return db.db.query("SELECT * FROM usage_records ORDER BY at, id").all() as Array<Record<string, unknown>>;
}

const descriptor = (key: string) => loadCatalog().models.find((m) => m.key === key)!.pricing!.value;

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);

describe("Codex rollouts", () => {
  test("token_count deltas, normalized (cached is a subset of input), priced at the openai list price, incrementally", async () => {
    const codexHome = tempDir("codex");
    const file = codexRolloutPath(codexHome, T0, "sess-codex-1");
    writeFileSync(file, lines(
      codexMeta(T0), codexTurnContext(T0 + 1, "gpt-5.1"), codexMessage(T0 + 2),
      codexTokenCount(T0 + 10, { input: 1000, cached: 400, output: 200, reasoning: 50 }, { input: 1000, cached: 400, output: 200, reasoning: 50 }),
      // A repeated count (same totals) is nothing.
      codexTokenCount(T0 + 11, { input: 1000, cached: 400, output: 200, reasoning: 50 }, { input: 1000, cached: 400, output: 200, reasoning: 50 }),
    ));
    const { db, svc } = service({ codexHome });
    await svc.ingest(true);
    let r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: "codex", model: "gpt-5.1", provider: "openai", input: 600, cache_read: 400, cache_write: 0, output: 200, reasoning: 50, cost_basis: "estimate", session_id: "sess-codex-1" });
    const p = descriptor("openai/gpt-5.1");
    expect(r[0]!.cost_usd as number).toBeCloseTo((600 * p.inputPerMTokUsd + 400 * p.cacheReadPerMTokUsd! + 200 * p.outputPerMTokUsd) / 1e6, 12);
    expect(r[0]!.cache_savings_usd as number).toBeCloseTo(400 * (p.inputPerMTokUsd - p.cacheReadPerMTokUsd!) / 1e6, 12);

    // Appended: only the new bytes are read; the delta is against the stored cumulative total. A partial last line waits.
    const partial = codexTokenCount(T0 + 30, { input: 1600, cached: 500, output: 300, reasoning: 60 }, { input: 600, cached: 100, output: 100, reasoning: 10 });
    appendFileSync(file, `${codexTurnContext(T0 + 20, "gpt-5.2")}\n${partial.slice(0, 40)}`);
    await svc.ingest(true);
    expect(rows(db)).toHaveLength(1);
    appendFileSync(file, `${partial.slice(40)}\n`);
    await svc.ingest(true);
    r = rows(db);
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ model: "gpt-5.2", input: 500, cache_read: 100, output: 100, reasoning: 10 });
    const state = db.db.query("SELECT offset FROM ingest_files").get() as { offset: number };
    expect(state.offset).toBe((await stat(file)).size);
  });

  test("a truncated file and a rotated (replaced) file are read again from the start, and dedupe keeps the counts right", async () => {
    const codexHome = tempDir("codex");
    const file = codexRolloutPath(codexHome, T0, "sess-a");
    const a = codexTokenCount(T0 + 10, { input: 100, cached: 0, output: 10, reasoning: 0 }, { input: 100, cached: 0, output: 10, reasoning: 0 });
    const b = codexTokenCount(T0 + 20, { input: 300, cached: 0, output: 30, reasoning: 0 }, { input: 200, cached: 0, output: 20, reasoning: 0 });
    writeFileSync(file, lines(codexMeta(T0, "sess-a"), codexTurnContext(T0, "gpt-5.1"), a, b));
    const { db, svc } = service({ codexHome });
    await svc.ingest(true);
    expect(rows(db).map((r) => r.input)).toEqual([100, 200]);
    // Truncated to its first lines: re-read from 0, nothing counted twice.
    writeFileSync(file, lines(codexMeta(T0, "sess-a"), codexTurnContext(T0, "gpt-5.1"), a));
    await svc.ingest(true);
    expect(rows(db).map((r) => r.input)).toEqual([100, 200]);
    // Rotated: a new file (new inode) at the same path, with one more count.
    const c = codexTokenCount(T0 + 30, { input: 700, cached: 0, output: 70, reasoning: 0 }, { input: 400, cached: 0, output: 40, reasoning: 0 });
    rmSync(file);
    writeFileSync(`${file}.new`, lines(codexMeta(T0, "sess-a"), codexTurnContext(T0, "gpt-5.1"), a, b, c));
    renameSync(`${file}.new`, file);
    await svc.ingest(true);
    expect(rows(db).map((r) => r.input)).toEqual([100, 200, 400]);
    // Archived (moved to archived_sessions/): the same counts, never twice.
    const archived = join(codexHome, "archived_sessions");
    require("node:fs").mkdirSync(archived, { recursive: true });
    renameSync(file, join(archived, "rollout-x-sess-a.jsonl"));
    await svc.ingest(true);
    expect(rows(db).map((r) => r.input)).toEqual([100, 200, 400]);
  });

  test("a resumed session's file opening with an old cumulative total counts only its own last turn", async () => {
    const codexHome = tempDir("codex");
    const file = codexRolloutPath(codexHome, T0, "resumed");
    writeFileSync(file, lines(codexMeta(T0, "sess-resumed"), codexTurnContext(T0, "gpt-5.1"),
      codexTokenCount(T0 + 10, { input: 50_000, cached: 0, output: 5_000, reasoning: 0 }, { input: 1_000, cached: 0, output: 100, reasoning: 0 })));
    const { db, svc } = service({ codexHome });
    await svc.ingest(true);
    expect(rows(db).map((r) => [r.input, r.output])).toEqual([[1_000, 100]]);
  });

  test("an unknown model is counted with no price (never a guessed one)", async () => {
    const codexHome = tempDir("codex");
    writeFileSync(codexRolloutPath(codexHome, T0, "u"), lines(codexMeta(T0, "sess-u"), codexTurnContext(T0, "gpt-imaginary-9"),
      codexTokenCount(T0 + 10, { input: 10, cached: 0, output: 1, reasoning: 0 }, { input: 10, cached: 0, output: 1, reasoning: 0 })));
    const { db, svc } = service({ codexHome });
    await svc.ingest(true);
    expect(rows(db)[0]).toMatchObject({ model: "gpt-imaginary-9", cost_usd: null, cost_basis: "unknown" });
    const s = svc.series("all");
    expect(s.totals.unpricedTokens).toBe(11);
  });
});

describe("Claude Code transcripts", () => {
  test("assistant usage with the cache split, deduped by message id + request id across lines and files, priced per kind", async () => {
    const claudeHome = tempDir("claude");
    const first = claudeAssistant(T0 + 1, { msgId: "msg_1", requestId: "req_1", input: 10, output: 300, cacheRead: 5_000, cacheWrite: 1_000, cacheWrite1h: 200 });
    writeFileSync(claudeTranscriptPath(claudeHome), lines(claudeUser(T0), first,
      // The same message's second content block (same id, same request): one record.
      claudeAssistant(T0 + 2, { msgId: "msg_1", requestId: "req_1", input: 10, output: 300, cacheRead: 5_000, cacheWrite: 1_000, cacheWrite1h: 200 }),
      claudeAssistant(T0 + 3, { msgId: "msg_2", requestId: "req_2", model: "<synthetic>", input: 0, output: 0 }),
    ));
    // A subagent's file repeats msg_1 (and adds its own message).
    const sub = join(claudeHome, "projects", "-Users-someone-SecretProjectName", "cc-session-1", "subagents");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-1.jsonl"), lines(first, claudeAssistant(T0 + 5, { msgId: "msg_3", requestId: "req_3", model: "claude-haiku-4-5-20251001", input: 7, output: 9 })));
    const { db, svc } = service({ claudeHome });
    await svc.ingest(true);
    const r = rows(db);
    expect(r.map((x) => x.model)).toEqual(["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]);
    expect(r[0]).toMatchObject({ source: "claude-code", provider: "anthropic", input: 10, output: 300, cache_read: 5_000, cache_write: 1_000, cost_basis: "estimate" });
    const p = descriptor("anthropic/claude-sonnet-4.5");
    const expected = (10 * p.inputPerMTokUsd + 300 * p.outputPerMTokUsd + 5_000 * p.cacheReadPerMTokUsd! + 800 * p.cacheWritePerMTokUsd! + 200 * p.inputPerMTokUsd * 2) / 1e6;
    expect(r[0]!.cost_usd as number).toBeCloseTo(expected, 12);
    // Re-reading everything (a fresh DB state for the offsets) still counts each message once.
    db.db.run("DELETE FROM ingest_files");
    await svc.ingest(true);
    expect(rows(db)).toHaveLength(2);
  });

  test("switched off in settings: nothing is read", async () => {
    const claudeHome = tempDir("claude");
    writeFileSync(claudeTranscriptPath(claudeHome), lines(claudeAssistant(T0, { msgId: "m", requestId: "r" })));
    const tracking = { codex: true, claudeCode: false };
    const { db, svc } = service({ claudeHome, tracking });
    await svc.ingest(true);
    expect(rows(db)).toHaveLength(0);
    tracking.claudeCode = true;
    await svc.ingest(true);
    expect(rows(db)).toHaveLength(1);
  });
});

describe("privacy", () => {
  test("no content, path or project name from another app's files reaches the DB (its file, WAL included)", async () => {
    const codexHome = tempDir("codex");
    const claudeHome = tempDir("claude");
    writeFileSync(codexRolloutPath(codexHome, T0, "p"), lines(codexMeta(T0), codexTurnContext(T0, "gpt-5.1"), codexMessage(T0),
      codexTokenCount(T0 + 1, { input: 10, cached: 0, output: 1, reasoning: 0 }, { input: 10, cached: 0, output: 1, reasoning: 0 })));
    writeFileSync(claudeTranscriptPath(claudeHome), lines(claudeUser(T0), claudeAssistant(T0, { msgId: "m1", requestId: "r1" })));
    const { db, svc } = service({ codexHome, claudeHome });
    await svc.ingest(true);
    expect(rows(db)).toHaveLength(2);
    const answer = JSON.stringify([await svc.summary("all", undefined, { plans: false }), svc.series("all")]);
    const path = db.path;
    db.close();
    const bytes = [readFileSync(path), ...(existsSync(`${path}-wal`) ? [readFileSync(`${path}-wal`)] : [])].map((b) => b.toString("latin1")).join("");
    for (const secret of [...SECRETS, codexHome, claudeHome, "someone"]) {
      expect(bytes.includes(secret)).toBe(false);
      expect(answer.includes(secret)).toBe(false);
    }
  });
});

describe("a line longer than the whole per-pass budget", () => {
  test("never stalls the ingest: the offset advances every pass, the line is skipped whole, what follows is read", async () => {
    const claudeHome = tempDir("claude");
    const path = claudeTranscriptPath(claudeHome);
    writeFileSync(path, `${"x".repeat(10_000)}\n${claudeAssistant(T0, { msgId: "after", requestId: "r" })}\n`);
    const { db, svc } = service({ claudeHome, fileBudgetBytes: 2_048, maxLineBytes: 1_024 });
    const offsets: number[] = [];
    for (let i = 0; i < 20 && rows(db).length === 0; i++) {
      await svc.ingest(true);
      offsets.push((db.db.query("SELECT offset FROM ingest_files").get() as { offset: number }).offset);
    }
    expect(rows(db).map((r) => r.model)).toEqual(["claude-sonnet-4-5-20250929"]);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    expect(offsets.at(-1)).toBe((await stat(path)).size);
  });
});

describe("readNewLines", () => {
  test("a line over the cap is skipped whole and the read goes on", async () => {
    const dir = tempDir("lines");
    const p = join(dir, "f.jsonl");
    writeFileSync(p, `short1\n${"x".repeat(5000)}\nshort2\n`);
    const s = await stat(p);
    const seen: string[] = [];
    const r = await readNewLines({ path: p, inode: s.ino, size: s.size, mtimeMs: s.mtimeMs }, undefined, (l) => seen.push(l), { maxLine: 1000 });
    expect(seen).toEqual(["short1", "short2"]);
    expect(r.offset).toBe(s.size);
  });
});
