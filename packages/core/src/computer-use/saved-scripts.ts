// ComputerV2 Phase 4 — session-saved scripts. `scripts.save(name, fn)` keeps a function's SOURCE for the rest of the
// session; any later call runs it as `scripts.<name>(…)`. The worker compiles and installs it (`worker/runtime.ts`);
// this store is what lets it outlive the worker: a reset, the 30-minute idle end, a crash or a summarized context.
//
// - IN MEMORY ONLY (the Phase 4 ruling): nothing model-written goes to disk, and a daemon restart loses them all.
// - Kept OUTSIDE the service's per-session runtime state, which the idle end deletes; cleared when the session is
//   deleted (and with the daemon). There is no delete door: a name can only be saved over.
// - Bounded: 32 names, 32 KiB each, 256 KiB per session, and 16 MiB across every session — past that the least
//   recently USED other session's scripts are cleared (never the saving session's own), and that session is told once.
// - The model can never list or read one back: nothing here is ever printed, logged, written to metrics or the audit
//   line (names only there), or sent anywhere but into the session's own fresh worker.
// - The worker is untrusted (the model's code shares its process), so every save is checked again here — its name,
//   its size and its SHAPE (one function or arrow expression and nothing after it, `worker/saved-shape.ts`, a lexer's
//   check that refuses what it could misread). A stored source is evaluated again by later workers; what keeps that
//   harmless is the shape check, the worker's inert install and the round trip at the first call together. A FORGED
//   save remains a residual risk: what passes them can run code only when that script is called by name.
import {
  SAVED_SCRIPT_MAX_BYTES, SAVED_SCRIPTS_MAX_COUNT, SAVED_SCRIPTS_MAX_TOTAL_BYTES, savedScriptNameOk, savedScriptTooLarge, type SavedScriptSource,
} from "./worker/bridge";
import { savedScriptShapeOk } from "./worker/saved-shape";

/** Across every session: past this, the least recently used other session's scripts are cleared. */
export const SAVED_SCRIPTS_DAEMON_MAX_BYTES = 16 * 1024 * 1024;

/** Why a save was refused: one sentence for the model (a `TypeError`; inside the DATA-ONLY fence once the session's
 *  runtime has read the screen, like every error that is not one of the daemon's own typed failures). */
export type SaveRefusal = { refused: string };

const kib = (bytes: number): string => `${Math.ceil(bytes / 1024)} KiB`;
const sizeOf = (source: string): number => Buffer.byteLength(source, "utf8");

export class SavedScripts {
  private readonly bySession = new Map<string, Map<string, string>>();
  /** When each session last saved or ran one (a counter, not a clock): what "least recently used" reads. */
  private readonly lastUsed = new Map<string, number>();
  private tick = 0;
  /** Sessions whose scripts were cleared to free memory and have not been told yet. */
  private readonly evicted = new Set<string>();

  constructor(private readonly daemonMaxBytes: number = SAVED_SCRIPTS_DAEMON_MAX_BYTES) {}

  /** Keep `source` under `name` for the session — a new name within the limits, or over a name it already has. */
  save(sessionId: string, name: unknown, source: unknown): { ok: true; replaced: boolean } | SaveRefusal {
    if (!savedScriptNameOk(name)) {
      return { refused: "scripts.save() takes a name that starts with a lowercase letter, then letters, digits or _ (at most 48), and is not save, then, toString or another built-in name" };
    }
    if (typeof source !== "string" || source.trim().length === 0) return { refused: "scripts.save() takes a function written in your script" };
    const bytes = sizeOf(source);
    if (bytes > SAVED_SCRIPT_MAX_BYTES) return { refused: savedScriptTooLarge(bytes) };
    if (!savedScriptShapeOk(source)) {
      return { refused: "scripts.save() takes one function or arrow expression and nothing else — write it as scripts.save(\"name\", async (a, b) => { … })" };
    }
    const mine = this.bySession.get(sessionId) ?? new Map<string, string>();
    const old = mine.get(name);
    if (old === undefined && mine.size >= SAVED_SCRIPTS_MAX_COUNT) {
      return { refused: `this session keeps at most ${SAVED_SCRIPTS_MAX_COUNT} saved scripts — save over one you no longer need` };
    }
    const total = this.sessionBytes(mine) - (old === undefined ? 0 : sizeOf(old)) + bytes;
    if (total > SAVED_SCRIPTS_MAX_TOTAL_BYTES) {
      return {
        refused: old === undefined
          ? `this session keeps at most ${kib(SAVED_SCRIPTS_MAX_TOTAL_BYTES)} of saved scripts in all — save over one you no longer need`
          : `replacing it would take this session's saved scripts past ${kib(SAVED_SCRIPTS_MAX_TOTAL_BYTES)} — save a shorter version or replace a bigger one`,
      };
    }
    // Room across the daemon: clear the least recently used OTHER sessions' scripts until this one fits.
    let daemonTotal = this.daemonBytes() - (old === undefined ? 0 : sizeOf(old)) + bytes;
    while (daemonTotal > this.daemonMaxBytes) {
      const victim = this.leastRecentlyUsedOther(sessionId);
      if (victim === undefined) return { refused: "Winter is holding too many saved scripts right now — try again later" };
      daemonTotal -= this.sessionBytes(this.bySession.get(victim)!);
      this.bySession.delete(victim);
      this.evicted.add(victim);
    }
    mine.set(name, source);
    this.bySession.set(sessionId, mine);
    this.touch(sessionId);
    return { ok: true, replaced: old !== undefined };
  }

  has(sessionId: string, name: string): boolean { return this.bySession.get(sessionId)?.has(name) === true; }

  /** A saved script of the session started: it counts as used (the memory cap clears the least recently used). */
  ran(sessionId: string): void { this.touch(sessionId); }

  /** Whether the session keeps any (the restart and reset notices say so — never which). */
  any(sessionId: string): boolean { return (this.bySession.get(sessionId)?.size ?? 0) > 0; }

  /** What a FRESH worker stores before its first run. Never shown to the model. */
  forInstall(sessionId: string): SavedScriptSource[] {
    return [...(this.bySession.get(sessionId) ?? new Map<string, string>())].map(([name, source]) => ({ name, source }));
  }

  /** True once after the session's scripts were cleared to free memory (its next call says so). */
  takeEvicted(sessionId: string): boolean { return this.evicted.delete(sessionId); }

  /** The session was deleted. */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.lastUsed.delete(sessionId);
    this.evicted.delete(sessionId);
  }

  /** The daemon stops (memory only: nothing survives it). */
  clearAll(): void {
    this.bySession.clear();
    this.lastUsed.clear();
    this.evicted.clear();
  }

  private touch(sessionId: string): void { this.lastUsed.set(sessionId, ++this.tick); }
  private sessionBytes(m: ReadonlyMap<string, string>): number { return [...m.values()].reduce((n, s) => n + sizeOf(s), 0); }
  private daemonBytes(): number { return [...this.bySession.values()].reduce((n, m) => n + this.sessionBytes(m), 0); }
  private leastRecentlyUsedOther(sessionId: string): string | undefined {
    let pick: string | undefined;
    let at = Number.POSITIVE_INFINITY;
    for (const id of this.bySession.keys()) {
      if (id === sessionId) continue;
      const used = this.lastUsed.get(id) ?? 0;
      if (used < at) { at = used; pick = id; }
    }
    return pick;
  }
}
