# Versioning & release

*Read this before bumping a version, writing release notes or cutting a release.*

- `VERSION`'s format is `#.###.#` — major, three-digit feature counter, single-digit patch (`0.112.0`); the first digit moves only for a rebrand-scale event (`scripts/version-lib.ts`).
- The Computer Use helper has its OWN semver `apple/ComputerUse/VERSION` (rules + protocol number: `apple/ComputerUse/PROTOCOL.md`); `version:sync`, `dev:helper` and `verify:computer-helper` stamp it into the helper's Info.plist and the marked lines of `apple/Winter/project.yml`; Winter's own stamp skips those.

```sh
bun run version:bump                 # patch +1 (throws at 9 — use a feature bump)
bun run version:bump:feature         # feature +1, patch -> 0 (throws at 999 — version:bump:major)
bun run version:sync                 # restamp version.ts / package.jsons / plists from VERSION
bun run scripts/release.ts --dry-run --no-bump   # full rehearsal: builds, notarizes, staples, never publishes
bun run scripts/release.ts                       # real release (bumps first; --no-bump ships VERSION as is)
```

- Pipeline: `scripts/release.ts` + `scripts/release-lib.ts`; `packaging/winter.rb.tmpl` is the Homebrew cask template it renders.
- `releases/notes/<version>.md` is REQUIRED — the GitHub release body and the Sparkle appcast `<description>`, rendered by `releaseNotesHtml`, which throws (naming the line) on anything outside `#`/`##`/`###`, paragraphs, `- ` bullets with indented continuations (no nesting), ``` fences, `` `code` `` and `**bold**`. The preflight fails BEFORE the bump when it is absent: write and commit the notes for the next version, bump and sync, release with `--no-bump`.
