# Cowork

*Read this before touching `packages/core/src/cowork/**`, `packages/protocol/src/cowork.ts`, `apple/Cowork/**`, the host-storage fence or `home-fence`'s Cowork roots, `refreshForStorage`, or the `workspace.*` / `project.*` methods and events.*

Cowork is not an implemented session mode: no Cowork session can be created or run, and `SpawnSession` refuses `type: "cowork"`. The host side exists: workspace metadata, guidance, schedules and outputs. What exists and what still blocks a functional mode: [cowork-status.md](../cowork-status.md). The design: [cowork-spec.md](../cowork-spec.md).

## Ordinary host execution policy

Accepted 2026-10-12.

- Ordinary native Code, approved shell escapes, plugin hooks, LSP and third-party MCP tools get NO persistent outer Cowork Seatbelt profile. Each tool's own sandbox stays unchanged; never inject sandbox/GPU/Chromium/LSP compatibility overrides.
- Sandboxed Bash gets the protected Cowork, runtime, control and socket roots in the existing `sandboxConfigFor` denyRead/denyWrite arrays, rendered as ONE profile.
- Approved escapes keep main's behavior and no Seatbelt. Cowork escape matching is write-shaped integrity guidance, not confidentiality.
- Core/SDK file tools keep their canonical protected-path checks.
- Actual floors apply only to explicitly Winter-owned Cowork workers and bridges.
- Ordinary child execution history never requires a daemon restart before first activation.

## Storage scope (first version)

Separate per-workspace encryption is DEFERRED (user ruling, 2026-10-12). The contract and its gates: [cowork-storage-security.md](../cowork-storage-security.md).

- Private VM/disk images are plaintext, with owner-only permissions, verified file identity and backup exclusion.
- FileVault protects offline host-volume access when enabled. Same-user processes, approved escaped commands (which run as the user) and authenticated API access can read images; these are explicit residuals.
- Still required: VM isolation, selected-folder boundaries, host credential custody and active RAM return. Key-broker/LUKS work is preserved as deferred research, not an activation gate.

## `refreshForStorage`

The installed SDK has no live sandbox-settings control, so `refreshForStorage` awaits the daemon's policy consumers:

- **Code** holds queued work, lets its current turn finish, then recreates its logical incarnation/run home with the same session/backend identity and the current sandbox paths; held work resumes there.
- **Chat/Dispatch** Workers, with the accepted SDK v1 nine-family context contract, acknowledge live protected-path updates without aborting their turn or recreating the runtime; a cold protected start waits for its own matching acknowledgment. Namespace, version and family checks stay required.
- The unchanged installed SDK pin lacks that contract: its existing Workers must close before activation and its protected Chat/Dispatch launches stay refused.
- A pending or failed refresh blocks provisioning, without claiming third-party descendants were stopped.

Historical persistent-Code-floor reports describe the superseded approach.
