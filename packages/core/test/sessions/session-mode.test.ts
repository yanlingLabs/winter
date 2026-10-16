// Cowork (session door): the session-mode boundary (`sessions/session-mode.ts`) and the store behind it.
// `cowork` is recognised by the protocol and runnable by nothing, so:
//   - the runtime-facing mode type cannot hold it (a type-level guarantee, pinned with @ts-expect-error —
//     `bun run typecheck` fails if a runtime table ever starts accepting it);
//   - the store refuses to MINT one (no row, no scope directory, no log);
//   - a log that says cowork (a newer daemon's, or a hand-edited one) rebuilds as cowork — never as Code.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_MODES, SessionEvent } from "@yanlinglabs/winter-protocol";
import { CoworkError } from "../../src/cowork/types";
import { SessionStore } from "../../src/sessions/store";
import {
  COWORK_SESSION_UNSUPPORTED_CODE, RUNNABLE_SESSION_MODES, UNRUNNABLE_SESSION_MODES, isCoworkSessionMode,
  type RunnableSessionMode,
} from "../../src/sessions/session-mode";
import { toolsFor, disallowedToolsFor } from "../../src/runtime-sdk/mode-options";
import { WINTER_CAPABILITY_TOOLS } from "../../src/capabilities/names";
import type { SessionMode as RuntimeSessionMode } from "../../src/runtime-sdk/create";
import { runsEmbedded } from "../../src/runtime-sdk/embedded";
import type { Mode as RegistryMode } from "../../src/agent/tools/registry";
import type { SessionMode as ProjectorMode } from "../../src/projector/types";

function loseIndex(dir: string): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try { rmSync(join(dir, "sessions", "index.db" + ext)); } catch { /* not present */ }
  }
}

describe("the protocol's modes are exactly the runnable ones plus the unrunnable ones", () => {
  test("SESSION_MODES = RUNNABLE_SESSION_MODES + UNRUNNABLE_SESSION_MODES (the compile-time pin has a runtime twin)", () => {
    expect([...SESSION_MODES].sort()).toEqual([...RUNNABLE_SESSION_MODES, ...UNRUNNABLE_SESSION_MODES].sort());
    expect([...UNRUNNABLE_SESSION_MODES]).toEqual(["cowork"]);
    expect(RUNNABLE_SESSION_MODES.some((m) => (m as string) === "cowork")).toBe(false);
  });

  test("isCoworkSessionMode is true for exactly 'cowork' — absent and unknown strings are NOT cowork", () => {
    expect(isCoworkSessionMode("cowork")).toBe(true);
    for (const other of [undefined, null, "", "code", "chat", "dispatch", "Cowork", "COWORK", "cowork ", "workspace"]) expect(isCoworkSessionMode(other)).toBe(false);
    expect(COWORK_SESSION_UNSUPPORTED_CODE).toBe("unsupported_topology");
  });
});

describe("type-level guarantee: no runtime-facing mode type can hold cowork", () => {
  test("every runtime table keyed by a mode rejects it at compile time", () => {
    const runnable: RunnableSessionMode[] = [...RUNNABLE_SESSION_MODES];
    const runtime: RuntimeSessionMode = "chat";
    const registry: RegistryMode = "dispatch";
    const projector: ProjectorMode = "code";
    expect([runtime, registry, projector]).toEqual(["chat", "dispatch", "code"]);
    expect(runnable).toHaveLength(3);

    // Compile-time only (never called): `bun run typecheck` fails if any of these starts compiling.
    const compileTimeOnly = (): void => {
      // @ts-expect-error "cowork" is not a RunnableSessionMode
      const a: RunnableSessionMode = "cowork";
      // @ts-expect-error runtime-sdk's SessionMode is the runnable set
      const b: RuntimeSessionMode = "cowork";
      // @ts-expect-error the tool registry's Mode is the runnable set (no tool can declare it)
      const c: RegistryMode = "cowork";
      // @ts-expect-error the projector's SessionMode is the runnable set
      const d: ProjectorMode = "cowork";
      // @ts-expect-error the built-in tool allowlist is only defined for runnable modes
      toolsFor("cowork", {});
      // @ts-expect-error the capability disallow table is only defined for runnable modes
      disallowedToolsFor("cowork", {}, WINTER_CAPABILITY_TOOLS);
      // @ts-expect-error embedded-ness is only defined for runnable modes
      runsEmbedded("cowork");
      void [a, b, c, d];
    };
    expect(typeof compileTimeOnly).toBe("function");
  });

  test("no capability tool registers cowork — the table hands a cowork session nothing", () => {
    for (const [name, facts] of Object.entries(WINTER_CAPABILITY_TOOLS)) {
      expect({ name, cowork: (facts.modes as readonly string[]).includes("cowork") }).toEqual({ name, cowork: false });
    }
  });
});

describe("SessionStore refuses to mint a cowork session", () => {
  test("createSession({mode: 'cowork'}) throws unsupported_topology BEFORE any row, directory or log exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-session-mode-"));
    const store = new SessionStore(dir);
    try {
      let thrown: unknown;
      try { store.createSession("coworkscope", { mode: "cowork" as never }); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(CoworkError);
      expect((thrown as CoworkError).code).toBe("unsupported_topology");
      expect(store.list()).toEqual([]);
      expect(existsSync(join(dir, "sessions", "coworkscope"))).toBe(false); // not even the scope directory
      const files = existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions"), { recursive: true }).map(String).filter((f) => !f.startsWith("index.db")) : [];
      expect(files).toEqual([]);

      // @ts-expect-error the store's mode option is the runnable set; cowork is not mintable even by type
      const typeOnly: Parameters<SessionStore["createSession"]>[1] = { mode: "cowork" };
      expect(typeOnly).toBeDefined();

      // The runnable modes still mint exactly as before.
      for (const mode of RUNNABLE_SESSION_MODES) expect(store.meta(store.createSession("global", { mode })).mode).toBe(mode);
    } finally { store.close(); }
  });
});

describe("a log that says cowork is rebuilt as cowork, never as Code", () => {
  test("session_created{mode:'cowork'} parses, and a full index rebuild keeps the row's mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-session-mode-"));
    const store = new SessionStore(dir);
    const id = store.createSession("global");
    store.close();
    // What a newer daemon (or a hand-edited log) could leave behind: the seq-1 event names the mode.
    const line = { type: "session_created", seq: 1, sessionId: id, ts: Date.now(), scope: "global", mode: "cowork" };
    expect(SessionEvent.parse(line)).toMatchObject({ type: "session_created", mode: "cowork" });
    writeFileSync(join(dir, "sessions", "global", `${id}.jsonl`), JSON.stringify(line) + "\n");
    loseIndex(dir);
    const reopened = new SessionStore(dir);
    try {
      // Losing the mode here would read as "absent = code": a Cowork conversation resurrected as a Code session.
      expect(reopened.meta(id).mode).toBe("cowork");
      expect(reopened.list().find((r) => r.sessionId === id)?.mode).toBe("cowork");
    } finally { reopened.close(); }
  });
});
