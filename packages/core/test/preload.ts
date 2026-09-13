import { mkdtempSync } from "node:fs";
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
