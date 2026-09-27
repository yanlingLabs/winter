# Follow-ups

The canonical list of known, deliberately parked work. Nothing here blocks a release. When an item ships, delete its line in the same commit; when new work gets parked, add it here rather than in a private note.

## MCP
- [ ] Move the daemon's `McpManager` status probe onto the public `@yanlinglabs/winter-agent-runtime/mcp-client` (the SDK exports it since 0.0.28) and retire the hand-written stdio client.
- [ ] URL-mode elicitation (`onElicitation` is unwired in the daemon), a second auth path some newer MCP servers use.
- [ ] Two same-named plugins from different marketplaces that register the same tool name still collide in the chat-side external tool name (`mcp__winter__external__<tool>`).
- [ ] `winter mcp remove` leaves the server's connector permissions behind, and there is no `winter mcp rename` (permissions are keyed by server name, so they don't follow a rename).
- [ ] Connector permissions don't reach a subagent definition's own inline MCP servers (renamed `<name>_2` on a clash, or unique names) or a plugin server enabled only for a project from a directory marketplace without an install record, until a value is stored under that exact name.
- [ ] A turn that starts while a server is reconnecting doesn't see that server's tools (the next turn does).
- [ ] `oauth-doors.ts`'s follow-up failure path still logs only the error's name.
- [ ] `winter mcp set-secret`'s hint names `winter` even when invoked as `winter-dev`.

## Credentials and Keychain
- [ ] Bun's own environment-level launcher switches still let another process running as the same user make a compiled Bun binary (`winter-core` included) run arbitrary code under its signed identity; closing that needs a patched Bun build. (The workflow workers already refuse to run outside a sandbox that denies them the Keychain.)

## Models and providers
- [ ] Catalog tool-calling evidence: the 48 Anthropic-dialect rows on third-party hosts (e.g. `zai-anthropic`, `qianfan-*-anthropic`, `tencent-*-anthropic`) are hidden from session pickers only because upstream never stated tool support; probe or overlay them. Same for `nvidia/openai/gpt-oss-{120b,20b}` and the two NVIDIA Llama rows marked tool-less by a third-party registry.
- [ ] `reviewModelSwitch` accepts `midTurnAbort`, but no caller passes it yet.

## Plan mode
- [ ] A one-line plan-mode reminder every few turns in long plan-mode sessions (the `entered` notice drifts further from the tail).
- [ ] Deliver the plan-mode notice as an OpenAI `developer` input item instead of a user reminder.
- [ ] `SystemPromptInput.hostPlanBody` is never set by the engine, so a host's `planModeInstructions` never reaches the model.
- [ ] An engine test for the plan-mode notice as a `role: "system"` message on a row with mid-conversation system messages.

## Subagents and forks
- [ ] A grandchild that declares a server name while the root's same-named server is still pending doesn't see the name as taken.
- [ ] Forks don't inherit the parent's rejected features, so each wastes one request per feature.
- [ ] Restoring the client-tool-search refusal on resume is reasoned, not tested.

## Run homes (router)
- [ ] Project skills and commands are still live links into the repository, not snapshots.
- [ ] The local settings tier is read before the "shipped by the repository" check (a local-process race only).
- [ ] The daemon's `gitRootFor` could tell "not a git repository" apart from "git failed" and pass it to the router, retiring the router's `.git`-walk heuristic.
- [ ] Retire the router: fold run homes and messaging into the SDK.

## Tests and infrastructure
- [ ] WinterKit's `FakePhoneConformanceTests.testStreamingDeltasReachThePhone…` fails on `main` (timing-sensitive, real-daemon).
- [ ] The core suite prints "Cannot use a closed database" lines from teardown ordering (no test fails).
