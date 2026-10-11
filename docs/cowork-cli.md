# Cowork workspace metadata CLI

`winter workspace --help` and `winter project --help` expose the implemented
host metadata/control API from [the API slice](cowork-workspace-api.md).
This CLI does not enable Cowork execution or production creation.

Workspace and Project commands list/get records, update titles, and set their
canonical default policy. Workspace commands also list/get sources, request
source removal/revocation, inspect paged policy details, narrow/update a complete
capability ceiling, change publication policy, and query operation status.
Source add commands accept only an existing opaque host selection ID. The CLI
does not issue picker selections, resolve folder paths, authenticate GitHub
accounts, receive raw grants, or launch a VM. The production daemon currently
refuses provisioning with `unsupported_topology`.

Commands use the existing local harness client/connection path. Argument
validation and help happen before connection. Every mutation requires both
`--revision N` and `--request-id ID`; there is no automatic refresh/retry.
Repeat the original arguments, revision and request ID for an exact retry.
Use a new request ID for a new change. The daemon continues to enforce current
caller/workspace authority, host capability admission and source membership.

Examples (replace the IDs/revisions with records returned by the daemon):

```sh
winter workspace list --limit 20 --json
winter project get project_example
winter workspace source list workspace_example --limit 20
winter workspace policy get workspace_example --limit 100 --revision 2
winter workspace update workspace_example --title 'Shared research' --revision 3 --request-id rename_1
winter workspace policy set-publication workspace_example --publication manual --revision 4 --request-id publication_off_1
winter workspace source revoke workspace_example source_example --revision 5 --request-id revoke_1
winter workspace operation get workspace_example operation_example
```

Lists return one bounded page and print `Next cursor` when another page exists.
Pass that token unchanged to the same command/workspace with `--cursor`.
`stale_cursor` means restart pagination without the cursor; `revision_conflict`
means refresh the record/current revision. Detail tokens cannot be reused across
workspaces or detail kinds. The optional `--revision` on detail reads refers to
desired workspace configuration for sources and policy revision for policy
capabilities.

Text and `--json` retain the complete/summary distinction. An oversized summary
shows source/capability counts and scoped detail commands; omitted capability
details never become empty grants. `set-ceiling --ceiling-json` requires the
entire capability object (`toolClasses`, `hostServices`, `connectors`, `network`).
It cannot consume a summary as an implicit authority value. Disabled automatic
publication is displayed as a policy default; blocked provisioning is reported
as the daemon's typed refusal. Mutation receipts identify their operation and
revision without claiming effective guest mounts or execution.

Verification uses private homes, isolated coordination/Git configuration,
file-secret stores and no agent backend. Source identities are synthetic; no
folder, GitHub account, real credentials, worker or VM is provisioned. Child CLI
tests exercise help and invalid input against an empty private home; they exit
before connecting or autolaunching anything.

```sh
cd packages/cli
bun test test/cowork-cli.test.ts test/main.test.ts test/cli-verb-gates.test.ts \
  test/memory-cli.test.ts test/credentials-cli.test.ts test/cli-autolaunch.test.ts
# 115 tests, 1872 assertions passed.

# From repository root
bun run typecheck:cli
# Passed.
```

This is CLI metadata integration. The native, encrypted storage, resource,
execution, UI, SDK release/pin and full product gates remain separate.
