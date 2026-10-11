// ComputerV2 Phase 4 — session-saved scripts. `scripts.save(name, fn)` keeps a function's SOURCE for the rest of the
// session; any later call runs it as `scripts.<name>(…)`. The worker compiles and installs it (`worker/runtime.ts`);
// this store is what lets it outlive the worker: a reset, the 30-minute idle end, a crash or a summarized context.
//
// - IN MEMORY ONLY (the Phase 4 ruling): nothing model-written goes to disk, and a daemon restart loses them all.
// - Kept OUTSIDE the service's per-session runtime state, which the idle end deletes; cleared only when the session is
//   deleted (and with the daemon).
// - The model can never list or read one back: nothing here is ever printed, logged, written to metrics or the audit
//   line (names only there), or sent anywhere but into the session's own fresh worker.
// - The worker is untrusted (the model's code shares its process), so every save is checked again here.
import {
  SAVED_SCRIPT_MAX_BYTES, SAVED_SCRIPTS_MAX_COUNT, SAVED_SCRIPTS_MAX_TOTAL_BYTES, savedScriptNameOk, savedScriptTooLarge, type SavedScriptSource,
} from "./worker/bridge";

/** Why a save was refused: one sentence for the model (shown as a `TypeError`). */
export type SaveRefusal = { refused: string };

const kib = (bytes: number): string => `${Math.ceil(bytes / 1024)} KiB`;

export class SavedScripts {
  private readonly bySession = new Map<string, Map<string, string>>();

  /** Keep `source` under `name` for the session — a new name within the limits, or over a name it already has. */
  save(sessionId: string, name: unknown, source: unknown): { ok: true; replaced: boolean } | SaveRefusal {
    if (!savedScriptNameOk(name)) {
      return { refused: "scripts.save() takes a name that starts with a lowercase letter, then letters, digits or _ (at most 48), and is not save, then, toString or another built-in name" };
    }
    if (typeof source !== "string" || source.trim().length === 0) return { refused: "scripts.save() takes a function written in your script" };
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes > SAVED_SCRIPT_MAX_BYTES) return { refused: savedScriptTooLarge(bytes) };
    const mine = this.bySession.get(sessionId) ?? new Map<string, string>();
    const old = mine.get(name);
    if (old === undefined && mine.size >= SAVED_SCRIPTS_MAX_COUNT) {
      return { refused: `this session keeps at most ${SAVED_SCRIPTS_MAX_COUNT} saved scripts — save over one you no longer need` };
    }
    const total = [...mine.values()].reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0) - (old === undefined ? 0 : Buffer.byteLength(old, "utf8")) + bytes;
    if (total > SAVED_SCRIPTS_MAX_TOTAL_BYTES) {
      return { refused: `this session keeps at most ${kib(SAVED_SCRIPTS_MAX_TOTAL_BYTES)} of saved scripts in all — save over one you no longer need` };
    }
    mine.set(name, source);
    this.bySession.set(sessionId, mine);
    return { ok: true, replaced: old !== undefined };
  }

  has(sessionId: string, name: string): boolean { return this.bySession.get(sessionId)?.has(name) === true; }

  /** Whether the session keeps any (the restart and reset notices say so — never which). */
  any(sessionId: string): boolean { return (this.bySession.get(sessionId)?.size ?? 0) > 0; }

  /** What a FRESH worker installs before its first run. Never shown to the model. */
  forInstall(sessionId: string): SavedScriptSource[] {
    return [...(this.bySession.get(sessionId) ?? new Map<string, string>())].map(([name, source]) => ({ name, source }));
  }

  /** A script the worker could not re-create (it compiled when saved, so this cannot happen short of an engine
   *  change): dropped, and the run says so. */
  drop(sessionId: string, name: string): void {
    const mine = this.bySession.get(sessionId);
    if (mine === undefined) return;
    mine.delete(name);
    if (mine.size === 0) this.bySession.delete(sessionId);
  }

  /** The session was deleted. */
  clearSession(sessionId: string): void { this.bySession.delete(sessionId); }

  /** The daemon stops (memory only: nothing survives it). */
  clearAll(): void { this.bySession.clear(); }
}
