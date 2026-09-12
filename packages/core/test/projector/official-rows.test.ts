import { describe, expect, test } from "bun:test";
import { classifyResult } from "../../src/projector";
import { accept, init, makeProjector, result } from "./harness";

/**
 * Winter Phase 8c (P8c-11 / Task 2.2): "official-stream rows" — what the projector does with
 * frames that arrive over the OFFICIAL leg rather than Winter's. Three of the section's four
 * bullets need NO new code, and this file's job is to prove that rather than assert it in a doc
 * comment:
 *
 *  - `system/init` on the official leg needs no separate branch: `asInitFrame` (`conversation.ts`)
 *    reads only `type === "system" && subtype === "init"` plus `session_id`/`model`/`tools` — the
 *    SAME field names the official runtime's own `system/init` carries (both SDKs mirror Claude
 *    Code's own message shapes; WS-14 §2 pins the official leg's settings/system-prompt fields but
 *    not the init message's own shape, which is unchanged from Claude Code's).
 *  - The `SDKAssistantMessageError` taxonomy's `authentication_failed` → `auth` and an
 *    `api_error_status` → `codeForHttpStatus` mapping are ALREADY pinned by
 *    `test/projector/errors.test.ts`'s table (both leg-agnostic: `classifyResult` reads the
 *    `result` frame's fields, never which leg produced it) — re-asserted here by name so this
 *    file is the one a reader checking "did lane 2 verify the official leg's error mapping" lands
 *    on, without duplicating that table.
 *  - The credential-resolution-failure → `auth` fix (hotfix 67d32584, already on this branch's
 *    base) is leg-agnostic for the same reason.
 *
 * The fourth bullet — `mirror_error` → `transcriptHealth: "repair-required"` — IS new code
 * (`conversation.ts`'s `asMirrorErrorFrame`, `index.ts`'s branch in `accept()`), and is PROVISIONAL:
 * no pinned wire shape exists for it (see `asMirrorErrorFrame`'s doc comment for why), so these
 * cases are hand-written from the router's own vocabulary (`HandoffOutcome`'s `"mirror-error"`
 * reason, `runtime-state/records.ts`'s `transcriptHealth` enum) rather than a recorded frame.
 */
describe("projector: official-stream rows (P8c-11 / Task 2.2)", () => {
  test("system/init on the official leg is consumed exactly like Winter's — no persisted/broadcast event, no throw", () => {
    const { projector } = makeProjector();
    const officialInit = {
      type: "system", subtype: "init", session_id: "official-be-1", model: "claude-agent/opus",
      tools: ["Read", "Write", "Bash"], cwd: "/tmp/official-x", apiKeySource: "env",
    } as unknown as Parameters<typeof accept>[1];
    expect(accept(projector, officialInit)).toEqual([]);
  });

  test("authentication_failed (official leg's result.error) classifies auth — same table errors.test.ts pins", () => {
    expect(classifyResult({ type: "result", subtype: "success", permission_denials: [], error: "authentication_failed" } as never).code).toBe("auth");
  });

  test("api_error_status on an official-leg result classifies via codeForHttpStatus — same table errors.test.ts pins", () => {
    expect(classifyResult({ type: "result", subtype: "success", permission_denials: [], api_error_status: 500 } as never).code).toBe("server");
  });

  test("PROVISIONAL: a top-level mirror_error frame marks transcriptHealth repair-required, with no persisted/broadcast event", () => {
    const { projector, warnings } = makeProjector();
    const batch = projector.accept({ type: "mirror_error", detail: "official session mirror diverged from the Winter compat store" } as never);
    expect(batch.persist).toEqual([]);
    expect(batch.broadcast).toEqual([]);
    expect(batch.transcriptHealth).toBe("repair-required");
    expect(warnings.some((w) => w.includes("mirror error"))).toBe(true);
  });

  test("PROVISIONAL: a system/mirror_error subtype frame (the kindOf convention) is recognised the same way", () => {
    const { projector } = makeProjector();
    const batch = projector.accept({ type: "system", subtype: "mirror_error", reason: "checksum mismatch" } as never);
    expect(batch.transcriptHealth).toBe("repair-required");
  });

  test("PROVISIONAL: a mirror_error with no detail/reason field still marks transcriptHealth, with no log crash", () => {
    const { projector } = makeProjector();
    const batch = projector.accept({ type: "mirror_error" } as never);
    expect(batch.transcriptHealth).toBe("repair-required");
  });

  test("an ordinary frame never carries transcriptHealth", () => {
    const { projector } = makeProjector();
    expect(accept(projector, init()).length).toBe(0);
    const batch = projector.accept(init());
    expect(batch.transcriptHealth).toBeUndefined();
  });
});
