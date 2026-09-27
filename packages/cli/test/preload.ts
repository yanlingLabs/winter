import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { LEGACY_HOME_ENV } from "@yanlinglabs/winter-core";
// Ink's own <Text dimColor>/<Text inverse> render through chalk's default (shared, singleton)
// export, whose color LEVEL chalk auto-detects from `process.stdout` at first import — 0 whenever
// stdout isn't a real TTY, which is every `bun test` process, with or without FORCE_COLOR (that env
// var's OWN effective level then depends on COLORTERM, so it is 1 on a bare CI box but 3 on a dev
// machine with `COLORTERM=truecolor` — not deterministic either way). At level 0 chalk's
// `applyStyle` drops modifier codes (dim, inverse, bold, …) same as it drops color, so ink-testing-
// library frames silently lose their inverse-video cursor and dimmed hint text. Every place THIS
// package colors text itself already sidesteps the same detection by constructing its own
// `new Chalk({ level: 3 })` (src/tui/{app,composer,markdown,flatten-blocks}.tsx); pin the shared
// singleton chalk (and so Ink) to the same level, so the two never disagree and a plain `bun test`
// renders byte-identical frames to `FORCE_COLOR=1 bun test` regardless of the host terminal.
chalk.level = 3;
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
// Test-keychain-isolation fix: the SAME redirect packages/core/test/preload.ts sets — a CLI test
// that spawns `daemon run` (or drives a real `winter`/`claude` child) inherits `process.env`, and
// `keychainService()` (`@yanlinglabs/winter-core`) only ever honours this override for a
// NON-default `WINTER_HOME` (P9c-15's guard), so it is inert against a real `~/.winter[-dev]` home
// and active only for these tests' own temp homes. The named service has no items.
process.env.WINTER_KEYCHAIN_SERVICE = "com.winter.core.test-isolated";
// Login-shell PATH: the SAME switch packages/core/test/preload.ts sets — a CLI test that spawns
// `daemon run` (or boots `startDaemon()` in-process) must never run the developer's real login shell.
process.env.WINTER_LOGIN_SHELL_PATH = "off";
