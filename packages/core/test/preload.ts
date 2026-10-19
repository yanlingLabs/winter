// FIRST import, on purpose: ESM evaluates imports in order, so this module's body — one fresh temp root for
// this test process, `TMPDIR` pointed at it, the whole tree removed at exit — has run before anything below
// (or any test file) can call `os.tmpdir()`. See ./per-process-tmp.ts. Every `mkdtempSync(join(tmpdir(), …))`
// in this file therefore lands inside that root too.
import "./per-process-tmp";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_HOME_ENV } from "../src/legacy-names";
// Cowork fences can inspect file identity to reject hard-link aliases. Inject the coordination root
// before any fence is constructed so even metadata checks never probe the production user ledger.
process.env.WINTER_COWORK_COORDINATION_DIR = mkdtempSync(join(tmpdir(), "winter-test-cowork-coordination-"));
// Hermetic guard: tests must never touch the user's real ~/.config/git/ignore
// (global-gitignore.ts resolves its default path from XDG_CONFIG_HOME).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "winter-test-xdg-"));
// Phase 8d (whole-branch review, Major 1): recovery step 8's `claude-resume-*` sweep deletes under
// `os.tmpdir()` by default; every daemon-booting test must sweep a throwaway root instead of the
// developer's real per-user tmpdir. `wiring.ts` reads this env seam behind the explicit dep.
process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "winter-test-claude-resume-"));
// Phase 9c Migration B: `startDaemon`'s boot hook resolves `legacyHomeFor(profile)` from this env
// var whenever a caller does NOT inject its own `secrets` (the real production shape) — which
// includes any subprocess a test spawns with `daemon run` / a bare `startDaemon()` call, since a
// spawned child inherits `process.env` unless a test explicitly narrows it. Redirected here to a
// throwaway, guaranteed-empty directory for the WHOLE run so that path can never resolve to the
// developer's REAL legacy dev/dist home — global constraint: no test may ever touch it. A test that
// specifically wants to exercise Migration B passes an explicit `migration.legacyHome` override to
// `startDaemon` instead (see `daemon-migration-boot.test.ts`), which always wins over this default.
process.env[LEGACY_HOME_ENV] = mkdtempSync(join(tmpdir(), "winter-test-legacy-home-"));
// Test-keychain-isolation fix: a real-binary e2e test's spawned `winter`/`claude` child resolves
// its OWN Keychain credential refs (`profile.ts`'s `keychainService()`, `runtime-sdk/keychain.ts`)
// against a REAL Keychain service (`com.winter.core[.dev]`) — never the test's own injected
// `FileSecretStore`, which only the daemon's IN-PROCESS reads go through. `keychainService()` only
// ever honours this override for a NON-default `WINTER_HOME` (P9c-15's `isDefaultWinterHome` guard),
// so setting it here is inert for anyone running against a real `~/.winter[-dev]` home and active
// only for these tests' own temp homes. The named service has NO items — a lookup misses instantly
// instead of blocking on a macOS Keychain consent dialog or, worse, reading the user's real
// `openai:default`/`codex-oauth:default`/`anthropic:default` material.
process.env.WINTER_KEYCHAIN_SERVICE = "com.winter.core.test-isolated";
// Login-shell PATH (`src/login-shell-path.ts`): every `startDaemon` boot resolves the user's login
// shell PATH by default. No test may run the developer's REAL login shell (their rc files, their
// agents) — this turns that off for every in-process boot AND every daemon subprocess a test spawns
// (they inherit `process.env`). A test that exercises the resolution injects a fake runner instead.
process.env.WINTER_LOGIN_SHELL_PATH = "off";
// Usage tracking (`src/usage/wiring.ts`, docs/claude/usage.md): no test may read the developer's REAL Codex sessions,
// Claude Code transcripts or `~/.claude.json`, nor spawn their real `codex` / `claude` / `agy` / `opencode`. Every root
// points at an empty throwaway directory and every executable is "off" (authoritative: never a fall-through to $PATH).
// A test that exercises them injects fixture roots and a fake executable through `startDaemon({ usage })` or the
// service itself.
{
  const none = mkdtempSync(join(tmpdir(), "winter-test-usage-none-"));
  process.env.WINTER_USAGE_CODEX_HOME = join(none, "codex");
  process.env.WINTER_USAGE_CLAUDE_HOME = join(none, "claude");
  process.env.WINTER_USAGE_CLAUDE_JSON = join(none, "claude.json");
  process.env.WINTER_USAGE_CODEX_EXECUTABLE = "off";
  process.env.WINTER_USAGE_CLAUDE_EXECUTABLE = "off";
  process.env.WINTER_USAGE_AGY_EXECUTABLE = "off";
  process.env.WINTER_USAGE_OPENCODE_EXECUTABLE = "off";
  // No background plan checks either (the 30-min beat, the alarms' fast beats): a test that wants them starts them.
  process.env.WINTER_USAGE_BACKGROUND = "off";
}
// WS-21 (L3.5): saving an "in this project" answer appends to the user's GLOBAL git excludes, resolved
// through `git config --global core.excludesfile` (claude parity, `agent/git-exclude.ts`). No test may
// read or write the developer's real global git config, so every git a test (or a daemon it boots)
// spawns sees a throwaway one — with a test identity, so a test's own `git commit` keeps working.
{
  const gitHome = mkdtempSync(join(tmpdir(), "winter-test-gitconfig-"));
  const gitConfig = join(gitHome, ".gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = winter-test\n\temail = winter-test@example.invalid\n");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
}
