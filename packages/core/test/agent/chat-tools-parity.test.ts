import { describe, expect, test } from "bun:test";
import { CHAT_ALLOW_TOOLS, CHAT_ONLY_TOOLS } from "../../src/agent/chat-prompt";

/**
 * B1-T3 fix round 2 — the drift tripwire for a SECOND hand-mirrored pair, same convention this
 * repo already uses for `REMOTE_ALLOWED_METHODS` (packages/core/src/ipc/server.ts) and its literal
 * parity test (test/ipc/remote-allowlist-parity.test.ts): two independently hand-maintained lists
 * that must never drift apart get an explicit test pinning the relationship, so editing ONE side
 * without the other fails HERE rather than silently admitting a chat-only tool into code mode.
 *
 * `CHAT_ALLOW_TOOLS` (chat-prompt.ts) is chat's own allowlist — what a chat session may call.
 * `CHAT_ONLY_TOOLS` (chat-prompt.ts) is folded into code mode's `excludeTools` in THREE places in
 * engine.ts (the main-thread `toolAccess` ternary, the spawn_agent child's `childExcludeTools`,
 * and `runWorkflowAgent`'s `childExcludeTools`) specifically so a chat-only tool registered in the
 * SAME shared per-daemon registry never rides along into a code session or its children.
 *
 * The reviewer proved by simulation that adding a future chat tool (e.g. Task 5's `Search`) to
 * `CHAT_ALLOW_TOOLS` ALONE — the single obvious one-line edit, and the only one Task 5's own brief
 * names — makes chat's own tests pass (chat is correctly offered `Search`) while leaking `Search`
 * into code mode's offered toolset, with the ENTIRE pre-round-2 suite green: nothing previously
 * asserted the two sets stay in sync. This test is that tripwire.
 *
 * Every entry in `CHAT_ALLOW_TOOLS` today is a chat-specific variant of an existing code tool
 * (`AskQuestion` vs `ask_user`; Task 5's `Search` vs `web_search`) — by `CHAT_ALLOW_TOOLS`'s own
 * doc comment ("Nothing that touches the filesystem, the shell, or the machine may ever join"),
 * nothing in chat's allowlist is meant to ALSO be offered to code. If that ever changes
 * deliberately, the shared tool must be added to an explicitly named/commented escape set (and
 * this test updated to exempt it) — never silently dropped from `CHAT_ONLY_TOOLS` while staying in
 * `CHAT_ALLOW_TOOLS`.
 */
describe("chat tool sets parity (drift tripwire): CHAT_ALLOW_TOOLS ⊆ CHAT_ONLY_TOOLS", () => {
  test("every tool chat is allowed to call is also excluded from code mode", () => {
    for (const name of CHAT_ALLOW_TOOLS) {
      expect(CHAT_ONLY_TOOLS.has(name)).toBe(true);
    }
  });

  // Belt-and-braces against the reverse mistake (a name added to CHAT_ONLY_TOOLS without ever
  // being added to CHAT_ALLOW_TOOLS) — not the bug the reviewer found, but an equally silent typo
  // this same test can catch for free since both directions are cheap to assert.
  test("CHAT_ONLY_TOOLS never carries a name chat itself was never given", () => {
    for (const name of CHAT_ONLY_TOOLS) {
      expect(CHAT_ALLOW_TOOLS.has(name)).toBe(true);
    }
  });
});
