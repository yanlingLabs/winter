# Follow-ups

The canonical list of known, deliberately parked work. Nothing here blocks a release. When an item ships, delete its line in the same commit; when new work gets parked, add it here rather than in a private note.

## MCP
- [ ] The runtime does not read `mcpServers` from an agent definition FILE (only a programmatic definition carries them); the daemon already lists and keys those servers.
- [ ] An elicitation a server raises outside any tool call is cancelled when an unrelated call on the same connection ends, and the runtime does not handle MCP's `-32042` URL-elicitation-required error.
- [ ] Form-mode elicitation is declined; only URL mode cards. The phone shows no elicitation card (a daemon chat viewed there shows the tool running until the Mac answers).

## Credentials and Keychain
- [ ] Bun's own environment-level launcher switches still let another process running as the same user make a compiled Bun binary (`winter-core` included) run arbitrary code under its signed identity; closing that needs a patched Bun build. (The workflow workers already refuse to run outside a sandbox that denies them the Keychain.)

## Models and providers
- [ ] Catalog tool-calling evidence still missing (no vendor statement found 2026-09-27): the ERNIE rows on `qianfan-anthropic`, the two role-play rows on `tencent-tokenhub-anthropic`, `tabitoken`'s four, three `wafer` rows absent from its live list, `agentrouter/gpt-5.6-sol`, `nvidia/stockmark/stockmark-2-100b-instruct` and `nvidia/meta/llama-4-maverick-17b-128e-instruct`; each needs a keyed live probe.
- [ ] Catalog refresh from the 2026-09-27 research: missing providers (Databricks, Cloudflare Workers AI, Replicate, Snowflake Cortex, IBM watsonx, OVHcloud, Crusoe, Parasail, GMI, Tinfoil, Aleph Alpha), missing and retired models per provider (DeepInfra lists none), and the core fields (context, max output, reasoning, pricing) still missing on about 700 rows.

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
