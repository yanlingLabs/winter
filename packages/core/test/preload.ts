import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Hermetic guard: tests must never touch the user's real ~/.config/git/ignore
// (global-gitignore.ts resolves its default path from XDG_CONFIG_HOME).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "norma-test-xdg-"));
// Phase 8d (whole-branch review, Major 1): recovery step 8's `claude-resume-*` sweep deletes under
// `os.tmpdir()` by default; every daemon-booting test must sweep a throwaway root instead of the
// developer's real per-user tmpdir. `wiring.ts` reads this env seam behind the explicit dep.
process.env.NORMA_CLAUDE_RESUME_SCAN_ROOT = mkdtempSync(join(tmpdir(), "norma-test-claude-resume-"));
