import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@winter/protocol";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";
import { outdirPath, ensureOutdir } from "../../src/sessions/outdir";
import { memoryDirFor } from "../../src/agent/memory-dir";
import { sandboxAvailable } from "../../src/agent/sandbox";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest, TurnInputItem } from "../../src/providers/types";

// working-directories T4: `$OUTDIR` — the delivery-folder primitive, `<winterHome>/outputs/<sessionId>`.
//
// outdirPath/ensureOutdir are pure path/mkdir helpers (unit-tested directly below). Everything else
// in this file proves the BLESSING end to end through a REAL engine turn — never registry.execute
// directly for a grant/deny decision (the "direct-registry blindness" class: engine.ts's dispatch
// loop, not registry.execute, is what decides whether a write cards/hard-denies/lands silent — this
// project has been bitten twice by a test that only proved the tool itself works, not the gate in
// front of it). The bash-tool-in-isolation tests below are the one deliberate exception: bash.ts's
// own ctx-consuming logic (the env splice, the seatbelt writable-set union) is self-contained and
// does not depend on the dispatch loop's decision at all — only on what ctx it was handed.

describe("outdirPath", () => {
  test("<home>/outputs/<sessionId>", () => {
    expect(outdirPath("/home/.winter", "s_abc123")).toBe(join("/home/.winter", "outputs", "s_abc123"));
  });

  test("rejects a sessionId outside the session-tmp.ts alphanumeric/-/_ shape (path-injection guard)", () => {
    expect(() => outdirPath("/home/.winter", "../../etc")).toThrow();
    expect(() => outdirPath("/home/.winter", "s/abc")).toThrow();
    expect(() => outdirPath("/home/.winter", "")).toThrow();
    expect(() => outdirPath("/home/.winter", "s abc")).toThrow();
    expect(() => outdirPath("/home/.winter", "/etc/passwd")).toThrow();
  });

  test("accepts a UUID (the synced-session id shape)", () => {
    expect(() => outdirPath("/home/.winter", "550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  test("accepts a daemon-minted id (s_<hex>)", () => {
    expect(() => outdirPath("/home/.winter", "s_deadbeef1234")).not.toThrow();
  });
});

describe("ensureOutdir", () => {
  test("mkdir -p's and returns the path", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-outdir-unit-"));
    const dir = ensureOutdir(home, "s_test1");
    expect(dir).toBe(outdirPath(home, "s_test1"));
    expect(existsSync(dir)).toBe(true);
  });

  test("idempotent — calling twice for the same session does not throw", () => {
    const home = mkdtempSync(join(tmpdir(), "winter-outdir-unit-"));
    ensureOutdir(home, "s_test2");
    expect(() => ensureOutdir(home, "s_test2")).not.toThrow();
  });
});

const darwin = sandboxAvailable();

// Task 17: the bash-tool and real-engine-turn suites that followed retired with the engine (the
// Winter leg's own Bash runs under the sandbox; the OUTDIR blessing is the bridge's, pinned in
// test/runtime-sdk).
