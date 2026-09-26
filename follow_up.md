# Follow-ups

The canonical list of known, deliberately parked work. Nothing here blocks a release. When an item ships, delete its line in the same commit; when new work gets parked, add it here rather than in a private note.

## MCP
- [ ] MCP OAuth.
- [ ] Retire or replace the daemon's own `McpManager` stdio client in favour of the SDK's.
- [ ] `mcp.add`'s wire schema drops a server's `versionNegotiation` (the settings file and `external-mcp.ts` carry it; the RPC does not).
- [ ] The SDK's `auto` version negotiation has caveats on SSE and stdio transports.
- [ ] Classify `EraNegotiationFailed` by its cause; add an HTTP server leg to `verify:mcp-compiled`; test a server parked while still connecting.

## Hooks
- [ ] `async` hooks.
- [ ] A direct hook invoker for embedded (Worker) sessions.
- [ ] `mcp_server` provenance on hook inputs.
- [ ] The bash reviewer's classifier forced choice (fails safe today: it escalates).

## Models and providers
- [ ] xAI `reasoning_tokens` in the usage event.
- [ ] The chat-completions adapters' OpenAI-URL fallback pattern.
- [ ] Session pickers should hide `toolCalling: none` rows.
- [ ] Persist the one-time sticky fallback flags (a rejected beta or feature) across process restarts; they are per-process today.
- [ ] Watch: on OpenAI, the request right after a plan-mode switch reads no cache (`cached=0`).
- [ ] The Mac/CLI renderer assumes `anthropic` for `console/*` entries.
- [ ] `provider-runtime`'s `createEndpointResolver2` caches by `modelKey` alone and echoes the first caller's `family`/`continuationDomain`, which can raise a spurious lossy-switch prompt. Key the cache on the whole origin (the daemon can mirror `memoisedPerOrigin` in `providers/registry.ts` meanwhile).
- [ ] A parallel tool batch sent to a chat-completions provider (DeepSeek, GLM, other OpenAI-compatible endpoints) goes out as one assistant message per call; those providers may reject it. Merge the batch for those dialects.

## Subagents and forks
- [ ] A subagent's own object-form MCP servers get no first-turn wait, so a slow server's tools miss its first request.
- [ ] A subagent's MCP server with the same name as a parent server replaces the parent's registrations for everyone while it runs, and its teardown unregisters them.
- [ ] Control requests queue during the startup MCP wait (the input loop starts after it).
- [ ] A fork that loads a tool through ToolSearch mid-run gets "No such tool" (its offered set is the parent's exact request layout).

## Worktrees
- [ ] Listing surfaces check trust on the cwd's own path and read `<cwd>/.winter/…` only, so in a worktree of a trusted repo they under-report what a session loads: `agents.list`, the output-style listing, project workflows, the project memory RPC and `loadPermissionDirs`. Move them to `projectScopeRootFor`/`projectScopeTrusted`.

## Plugins
- [ ] The plugin supervisor is keyed by bare plugin name, so two marketplaces' same-named plugins collide.
- [ ] Project- and local-scope plugins can show as consented yet never run (only user scope hot-starts); the consent sheet should say so.
- [ ] A stray folder under `<home>/plugins` triggers Migration C.
- [ ] A revoked consent resurrects after a Migration C rollback and re-migrate.
- [ ] Dead code: `pluginMcpEligible` / `pluginSkillsEligible`.

## Model switching
- [ ] An end-to-end test for the compaction-on-switch prompt.
- [ ] `reviewSwitch`'s hard-coded mid-turn-abort flag.

## Embedded runtime
- [ ] Orphaned process groups when a session's Worker is terminated.

## Phone
- [ ] `hook_notice` and `continuity_warning` on the phone: the history/remote-stream allowlists, a kit tag and the iOS bump.

## Tests and infrastructure
- [ ] The SDK test network guard does not cover shell children (`exec`/`execSync`).
- [ ] The SDK N2 RSS test asserts absolute process RSS, so it fails inside the shared-process full suite; measure a delta or run it in a child process.
- [ ] Retire the router: fold run homes and messaging into the SDK.
- [ ] The pre-existing `mock-module-tripwire` (`checkMockModuleLeaks`) test failure, also on `main`.
