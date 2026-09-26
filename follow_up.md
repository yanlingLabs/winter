# Follow-ups

The canonical list of known, deliberately parked work. Nothing here blocks a release. When an item ships, delete its line in the same commit; when new work gets parked, add it here rather than in a private note.

## Winter runtime (0.118.0, WS-23)

### MCP
- [ ] MCP OAuth.
- [ ] Retire or replace the daemon's own `McpManager` stdio client in favour of the SDK's.
- [ ] `mcp.add`'s wire schema drops a server's `versionNegotiation` (the settings file and `external-mcp.ts` carry it; the RPC does not).
- [ ] The SDK's `auto` version negotiation has caveats on SSE and stdio transports.
- [ ] Classify `EraNegotiationFailed` by its cause; add an HTTP server leg to `verify:mcp-compiled`; test a server parked while still connecting.

### Hooks
- [ ] `async` hooks.
- [ ] A direct hook invoker for embedded (Worker) sessions.
- [ ] `mcp_server` provenance on hook inputs.
- [ ] The bash reviewer's classifier forced choice (fails safe today: it escalates).

### Models and providers
- [ ] xAI `reasoning_tokens` in the usage event.
- [ ] The chat-completions adapters' OpenAI-URL fallback pattern.
- [ ] Session pickers should hide `toolCalling: none` rows.
- [ ] Persist the one-time sticky fallback flags (a rejected beta or feature) across process restarts; they are per-process today.
- [ ] Watch: on OpenAI, the request right after a plan-mode switch reads no cache (`cached=0`).
- [ ] The Mac/CLI renderer assumes `anthropic` for `console/*` entries.

### Model switching
- [ ] An end-to-end test for the compaction-on-switch prompt.
- [ ] `reviewSwitch`'s hard-coded mid-turn-abort flag.

### Embedded runtime
- [ ] Orphaned process groups when a session's Worker is terminated.

### Phone
- [ ] `hook_notice` and `continuity_warning` on the phone: the history/remote-stream allowlists, a kit tag and the iOS bump.

### Tests and infrastructure
- [ ] The SDK test network guard does not cover shell children (`exec`/`execSync`).
- [ ] The SDK N2 RSS test asserts absolute process RSS, so it fails inside the shared-process full suite; measure a delta or run it in a child process.
- [ ] Retire the router: fold run homes and messaging into the SDK.

## Carried over from WS-21 (shared SDK home)

### Correctness
- [ ] `provider-runtime`'s `createEndpointResolver2` caches by `modelKey` alone and echoes the first caller's `family`/`continuationDomain`, which can raise a spurious lossy-switch prompt. Key the cache on the whole origin (the daemon can mirror `memoisedPerOrigin` in `providers/registry.ts` meanwhile).
- [ ] A parallel tool batch handed to a chat-completions provider (DeepSeek, GLM, other OpenAI-compatible endpoints) is sent as one assistant message per call; those providers may reject it. Merge the batch for those dialects.

### Worktrees
- [ ] Listing surfaces check trust on the cwd's own path and read `<cwd>/.winter/…` only, so in a worktree of a trusted repo they under-report what the run home loads: `agents.list`, the output-style listing, project workflows, the project memory RPC and `loadPermissionDirs`. Move them to `projectScopeRootFor`/`projectScopeTrusted`.

### Subagents, forks, ToolSearch
- [ ] A subagent's own object-form MCP servers get no first-turn wait, so a slow server's tools miss its first request.
- [ ] A subagent's MCP server with the same name as a parent server replaces the parent's registrations for everyone while it runs, and its teardown unregisters them.
- [ ] Control requests queue during the startup MCP wait (the input loop starts after it).
- [ ] A fork that loads a tool through ToolSearch mid-run gets "No such tool" (its offered set is the parent's exact request layout).
- [ ] A parent's direct call to a subagent's tool gets the "use ToolSearch to select it" answer, which leads nowhere; answer "No such tool available".

### Tool results
- [ ] Large tool outputs are returned inline instead of being written to `tool-results` with a preview.
- [ ] Resumed tool results show only the preview.

### Plugins
- [ ] The plugin supervisor is keyed by bare plugin name.
- [ ] Dead code: `pluginMcpEligible` / `pluginSkillsEligible`.
- [ ] Project- and local-scope plugins can show as consented yet never run (only user scope hot-starts); the consent sheet should say so.
- [ ] The inline `{name: {source | content}}` object-map form of plugin `commands` is not loaded.
- [ ] A stray folder under `<home>/plugins` triggers Migration C.
- [ ] A revoked consent resurrects after a Migration C rollback and re-migrate.

### Sandbox profile (all fail closed)
- [ ] `allowRead` has no rendering in the sandbox profile.
- [ ] The directory-metadata read allowance is not ported.
- [ ] Permission rules supplied through `Options`, `canUseTool` or plugins never reach the profile (settings tiers only).
- [ ] Paths under a `[`-named root keep `\[` and never match.

### Other
- [ ] The pre-existing `mock-module-tripwire` (`checkMockModuleLeaks`) test failure, also on `main`.
- [ ] Router test and doc nits from the WS-21 touch reviews (direct `expected` assertions, the `mcp_status` probe timeout, narrow timing margins); moot once the router is retired.
