import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Phase 8d (whole-branch review, Major 1): the CLI tests that spawn `daemon run` inherit this env, so
// the daemon's `claude-resume-*` sweep (recovery step 8) reads a throwaway root, never the developer's
// real per-user tmpdir — the same seam packages/core/test/preload.ts sets for core's own tests.
process.env.NORMA_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "norma-test-claude-resume-"));
