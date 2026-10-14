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
validation and help happen before connection. Values can use `--flag=value`; for example `--title=--draft` preserves a title
that starts with two dashes. Human output escapes directional/invisible controls;
JSON output preserves the original typed values. Every mutation requires both
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

## Shared guidance

`winter workspace instructions get WORKSPACE` prints the current shared guidance
revision, SHA-256 digest and size (and the text, with terminal controls escaped);
`instructions provenance WORKSPACE` lists the discovered guidance sources. Both are
workspace-only reads.

`instructions update` replaces the shared guidance (`WINTER.md`) and takes:

```sh
winter workspace instructions update WORKSPACE \
  --instruction-revision N --digest SHA256 --request-id ID \
  (--content TEXT | --stdin | --content-file FILE) [--allow-empty] [--json]
```

- `--instruction-revision` and `--digest` are required and name the guidance being
  replaced, exactly as `instructions get` printed them, not the new text. A stale pair
  is a `revision_conflict`; the CLI never refreshes or retries.
- `--request-id` is required and is the replay identity (see below).
- Exactly one content source. `--content TEXT` is the inline form. `--content-file FILE`
  reads a regular file (relative to the caller's cwd; a symlink to a regular file works,
  FIFOs, devices and directories are refused). `--stdin` reads raw bytes until EOF.
  `--stdin` and `--content-file` keep the text out of argv, shell history and `ps`.
- Content is at most 65536 UTF-8 bytes with no NUL; BOM, CRLF and the final newline are
  sent exactly as read. Oversized, non-UTF-8 and NUL input is refused without echoing it.
- Zero-byte `--stdin` or `--content-file` input is refused, so a failed pipeline stage
  cannot blank the guidance. `--allow-empty` (only with `--stdin` or `--content-file`)
  makes the clear deliberate; `--content ""` also clears. Whitespace-only input is content.
- On a terminal, `--stdin` prints a one-line hint on stderr (end with Ctrl-D). An unreadable
  file reports a fixed message and its errno code (for example `(ENOENT)`), never the path.
- All validation and input reading finish before any connection, so a refused command
  never touches the daemon.

```sh
winter workspace instructions get workspace_example
winter workspace instructions update workspace_example --instruction-revision 2 --digest "$DIGEST" --request-id guidance_1 --content-file ./WINTER.md
generate-guidance | winter workspace instructions update workspace_example --instruction-revision 2 --digest "$DIGEST" --request-id guidance_1 --stdin
```

The request ID names the canonical `workspace.instructions.update` request, not the input
mode. Every mode sends the same RPC with the resolved text as `content`, so an exact
retry may switch between `--content`, `--content-file` and `--stdin` as long as the
workspace, revision, digest and resulting bytes are identical; the daemon then returns the
recorded receipt. Any difference, including a trailing newline (`echo` adds one, `printf`
does not), is a `request_conflict`: use a new request ID for a new change. Details:
[shared-guidance CLI inputs](research/2026-10-14-guidance-cli-input.md).

Verification uses private homes, isolated coordination/Git configuration,
file-secret stores and no agent backend. Source identities are synthetic; no
folder, GitHub account, real credentials, worker or VM is provisioned. Child CLI
tests exercise help and invalid input against an empty private home; they exit
before connecting or autolaunching anything.

```sh
cd packages/cli
bun test test/cowork-cli.test.ts test/cowork-guidance-input.test.ts test/main.test.ts \
  test/cli-verb-gates.test.ts test/memory-cli.test.ts test/credentials-cli.test.ts \
  test/cli-autolaunch.test.ts
# 134 tests, 2059 assertions passed.

# From repository root
bun run typecheck:cli
# Passed.
```

This is CLI metadata integration. The native, encrypted storage, resource,
execution, UI, SDK release/pin and full product gates remain separate.
