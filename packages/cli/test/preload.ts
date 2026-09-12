import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_HOME_ENV } from "@yanlinglabs/winter-core";
// Phase 8d (whole-branch review, Major 1): the CLI tests that spawn `daemon run` inherit this env, so
// the daemon's `claude-resume-*` sweep (recovery step 8) reads a throwaway root, never the developer's
// real per-user tmpdir — the same seam packages/core/test/preload.ts sets for core's own tests.
process.env.WINTER_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "winter-test-claude-resume-"));
// Phase 9c Migration B: the SAME redirect packages/core/test/preload.ts sets, for the identical
// reason — a CLI test that spawns `daemon run` (or a bare `startDaemon()`) as a subprocess inherits
// `process.env`, and without this, `legacyHomeFor(profile)` would resolve to the developer's REAL
// legacy dev/dist home whenever that subprocess doesn't inject its own `secrets`. Redirected here to
// a throwaway, guaranteed-empty directory for the whole run.
process.env[LEGACY_HOME_ENV] = mkdtempSync(join(tmpdir(), "winter-test-legacy-home-"));
