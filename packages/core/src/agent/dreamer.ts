import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider, TurnInputItem } from "../providers/types";
import type { SessionStore } from "../sessions/store";
import { applyOps, validateOps, RESERVED_FILES, MAX_FILES } from "./dream-ops";

export const DREAM_MODEL = "gpt-5.6-terra";
export const DREAM_EFFORT = "medium";
export const DREAM_MIN_EVENTS = 40;
export const DREAM_MIN_SPACING_MS = 7_200_000; // 2h
export const DREAM_TICK_MS = 300_000; // 5min
export const DREAM_WINDOW_MAX_CHARS = 200_000;

export const DREAM_INSTRUCTION = [
  "You are Norma's memory, consolidating while she rests. You receive: her current memory files, her tombstones list, today's date, and a transcript window of her recent conversations as the user's assistant (including outcomes of work sessions she delegated).",
  "Distill the transcript into durable memories:",
  "- SYNTHESIZE, don't transcribe: combine observations into abstractions that will matter weeks from now — preferences, ongoing projects, people, decisions, constraints. Never write fact-lists or echo single messages.",
  "- REVISE over time: every memory file carries `revised: <date>` frontmatter and a `sources: <seq ranges>` line. Update time-bounded facts as they age (an upcoming event becomes a past one; finished work is finished). Rewrite files rather than appending contradictions.",
  "- FORGET on request: if the user asked to forget or not mention something in this window, emit a tombstone op with a short description of the banned fact AND delete any file holding it.",
  "- TOMBSTONES ARE LAW: never write anything matching the tombstones list, even if the transcript re-teaches it.",
  "- NEVER memorize secrets, credentials, tokens, or keys, even if they appear. Skip transient trivia.",
  `- One topic per kebab-case .md file; at most ${MAX_FILES} files may exist — consolidate rather than sprawl. Content per file must stay small (under 8KB).`,
  'Reply with ONLY a JSON object, no prose: {"ops":[{"op":"write","file":"<kebab-name>.md","content":"..."} | {"op":"delete","file":"..."} | {"op":"tombstone","text":"..."}]} — an empty ops array is a valid answer when nothing is worth keeping.',
].join("\n");

const SUBSTANTIVE = new Set(["user_message", "assistant_message", "child_update"]);

export interface DreamerDeps {
  provider: { provider: Provider; model: string }; // wrapper for parity with compactor/titler; model IGNORED — dreams pin DREAM_MODEL
  store: SessionStore;
  dir: () => string;                // assistantMemoryDirFor thunk
  enabled: () => boolean;           // memoryEnabledHot
  activeTurnCount: () => number;    // engine idle signal
  now?: () => number;               // injectable clock (tests)
  timeoutMs?: number;               // default NORMA_DREAM_TIMEOUT_MS ?? 120_000
}

interface DreamState { watermarkSeq: number; lastDreamAt: number }

export class Dreamer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly deps: DreamerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? Number(process.env.NORMA_DREAM_TIMEOUT_MS ?? 120_000);
  }

  private statePath(): string { return join(this.deps.dir(), "dream-state.json"); }
  private readState(): DreamState {
    try { return JSON.parse(readFileSync(this.statePath(), "utf8")) as DreamState; }
    catch { return { watermarkSeq: 0, lastDreamAt: 0 }; }
  }
  private writeState(s: DreamState): void {
    mkdirSync(this.deps.dir(), { recursive: true });
    const tmp = join(this.deps.dir(), ".dream-state.json.tmp");
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.statePath());
  }

  /** The gates. NEVER throws (scheduler precedent). */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.deps.enabled()) return;
      if (this.deps.activeTurnCount() > 0) return;
      const dispatchId = this.deps.store.dispatchSessionId();
      if (!dispatchId) return;
      const state = this.readState();
      if (this.now() - state.lastDreamAt < DREAM_MIN_SPACING_MS) return;
      const events = this.deps.store.read(dispatchId, state.watermarkSeq);
      const substantive = events.filter((e) => SUBSTANTIVE.has(e.type));
      if (substantive.length < DREAM_MIN_EVENTS) return;
      await this.runCycle(dispatchId, state);
    } catch (e) {
      console.error(`[dreamer] tick failed: ${String(e)}`);
    } finally {
      this.inFlight = false;
    }
  }

  /** One dream: window → prompt → one terra/medium call → validate → apply → advance. */
  private async runCycle(dispatchId: string, state: DreamState): Promise<void> {
    const upTo = this.deps.store.lastSeq(dispatchId);
    const events = this.deps.store.read(dispatchId, state.watermarkSeq);
    const lines: string[] = [];
    for (const e of events) {
      if (e.type === "user_message") lines.push(`[user] ${e.text}`);
      else if (e.type === "assistant_message") lines.push(`[norma] ${e.text}`);
      else if (e.type === "child_update") lines.push(`[delegated work "${e.title}" → ${e.status}]${e.resultSummary ? ` ${e.resultSummary}` : ""}`);
    }
    let transcript = lines.join("\n");
    if (transcript.length > DREAM_WINDOW_MAX_CHARS) {
      transcript = `[earlier events trimmed]\n${transcript.slice(transcript.length - DREAM_WINDOW_MAX_CHARS)}`;
    }
    const dir = this.deps.dir();
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && !RESERVED_FILES.has(f)) : [];
    const memories = files.map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), "utf8")}`).join("\n\n") || "(no memories yet)";
    const tombstones = existsSync(join(dir, "tombstones.md")) ? readFileSync(join(dir, "tombstones.md"), "utf8") : "(none)";
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const content = `Today's date: ${today}\n\n## Current memory files\n${memories}\n\n## Tombstones (never re-learn)\n${tombstones}\n\n## Transcript window (events ${state.watermarkSeq + 1}..${upTo})\n${transcript}`;
    const input: TurnInputItem[] = [{ type: "message", role: "user", content }];

    let text = "";
    const run = (async () => {
      for await (const ev of this.deps.provider.provider.streamTurn({
        model: DREAM_MODEL, reasoningEffort: DREAM_EFFORT, instructions: DREAM_INSTRUCTION, input, tools: [],
      })) {
        if (ev.type === "text_delta") text += ev.delta;
        else if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
        else if (ev.type === "done" && ev.stopReason === "aborted") throw new Error("dream aborted");
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("dream timed out")), this.timeoutMs); });
    try { await Promise.race([run, timeout]); } finally { clearTimeout(timer); }

    const m = text.match(/\{[\s\S]*\}/); // reviewer.ts's greedy-brace idiom
    if (!m) throw new Error(`dream returned no JSON: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(m[0]) as { ops?: unknown };
    const v = validateOps(parsed.ops, files);
    if (!v.ok) throw new Error(`dream ops invalid: ${v.error}`);
    applyOps(dir, v.ops);
    this.writeState({ watermarkSeq: upTo, lastDreamAt: this.now() });
  }

  start(intervalMs: number = DREAM_TICK_MS): void {
    if (this.timer) return; // idempotent (scheduler precedent)
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.(); // never keeps the daemon alive on its own
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
