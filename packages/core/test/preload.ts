import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_HOME_ENV } from "../src/legacy-names";
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
