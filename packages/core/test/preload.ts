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
