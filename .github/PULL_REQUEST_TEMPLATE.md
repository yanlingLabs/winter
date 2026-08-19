## What this changes

<!-- One or two sentences. What does this PR do? -->

## Why

<!-- The reasoning. Norma's code carries heavy "why" comments on purpose — a reviewer six months
     from now needs to know what would break if this were undone. Same energy here. -->

Closes #

## How it was tested

<!-- Name the commands you actually ran and what they said. -->

- [ ] `bun test` in the packages I touched
- [ ] `pnpm protocol:generate` re-run and committed (only if I changed `packages/protocol/src`)
- [ ] `swift test` in `apple/NormaProtocol` and `apple/NormaKit` (only if I touched Swift or the protocol)
- [ ] The macOS app builds (only if I touched Swift or the protocol)
- [ ] `bun run verify:workflow` (only if I touched the workflows runtime)

## Checklist

- [ ] Scoped to one thing
- [ ] Commit messages follow Conventional Commits with a scope (`feat(app):`, `fix(core):`, …)
- [ ] New behaviour is pinned by a test that fails if the behaviour goes away
- [ ] No hand-edited version strings (releases own `VERSION`)
- [ ] No secrets, tokens, or personal paths in the diff or fixtures
- [ ] If I added a setting, it hot-reloads — no daemon restart required
- [ ] If I added a `SessionEvent` variant or RPC method, I walked the full checklist in
      [CONTRIBUTING.md](../CONTRIBUTING.md#changing-the-protocol), including the Swift side

## Screenshots

<!-- Required for anything visual. Before/after if you're changing something that already existed. -->
