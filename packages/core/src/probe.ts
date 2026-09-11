// P8b-18 (C-15): the compiled-artifact proof for the 8a runtime spine.
//
// WHY THIS EXISTS. `runtime-state.db` is opened with `bun:sqlite` and migrated by
// `runtime-state/db.ts`'s MIGRATIONS at boot. Everything about that is exercised under `bun test`
// — and `bun test` runs the DEV path. The shipped daemon is a `bun build --compile` single-file
// binary whose whole module graph lives in `/$bunfs`, and this repo has already been bitten once by
// a subsystem that worked in dev and was DEAD in the compiled binary (workflows, C1 — see
// `scripts/verify-workflow-compiled.ts`). So the 8a carry ("the compiled daemon creates
// runtime-state.db in the bundle") is only discharged by running the real artifact.
//
// WHAT IT PROVES, and how. It boots the REAL daemon — `startDaemon`, the same entry `norma-core
// daemon run` uses, which calls `startRuntimeState` at `daemon.ts:272` — against a caller-supplied
// temp `NORMA_HOME`, with a `FileSecretStore` injected so NOTHING touches the macOS Keychain. Then
// it re-opens the produced database READ-ONLY, from disk, after the daemon has stopped, and reports
// its `PRAGMA user_version`. A migration that silently did not run shows up as a user_version of 0;
// a bundling gap shows up as the process never printing a line at all.
//
// Reached ONLY by `scripts/verify-runtime-state-compiled.ts` through the static
// `__runtime-state-probe` argv route in `packages/cli/src/main.ts` (beside `__workflow-worker`).
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { FileSecretStore } from "./auth/secret-store";
import { startDaemon } from "./daemon";
import { runtimeStateOnline } from "./runtime-state/wiring";

export type RuntimeStateProbeResult =
  | { ok: true; home: string; dbPath: string; userVersion: number; online: true }
  | { ok: false; error: string };

export async function runRuntimeStateProbe(input: { home: string | undefined }): Promise<RuntimeStateProbeResult> {
  if (!input.home) return { ok: false, error: "NORMA_HOME is required (the probe never touches a real home)" };
  const home = input.home;
  // Never `Bun.secrets`: the probe mints the daemon's tokens into a throwaway directory under the
  // temp home, so a proof run can never write to (or read from) the user's Keychain.
  const secrets = new FileSecretStore(join(home, "probe-secrets"));
  try {
    // `agentProvider: null` — the agent loop is irrelevant here and wiring a provider would need a
    // credential. Everything on the runtime-spine path (bootstrap → lock → SessionStore →
    // startRuntimeState → recovery → backfill → retention) runs exactly as it does in production.
    const daemon = await startDaemon({ home, secrets, agentProvider: null });
    let dbPath: string;
    let online: boolean;
    try {
      const state = runtimeStateOnline(daemon.runtimeState);
      online = state !== undefined;
      dbPath = state?.db.path ?? join(home, "runtimes", "runtime-state.db");
      if (!online && "unavailable" in daemon.runtimeState) {
        return { ok: false, error: `runtime state reported offline: ${daemon.runtimeState.unavailable.message}` };
      }
    } finally {
      // The runtime-state drain lives behind this promise — it MUST be awaited before the file is
      // re-opened, or the read below could race the WAL checkpoint the close performs.
      await daemon.stop();
    }
    // Re-opened from DISK, read-only, with the daemon gone: what is asserted is what persisted,
    // not what a live handle happened to be holding.
    const db = new Database(dbPath, { readonly: true });
    let userVersion: number;
    try {
      userVersion = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    } finally {
      db.close();
    }
    return { ok: true, home, dbPath, userVersion, online: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
