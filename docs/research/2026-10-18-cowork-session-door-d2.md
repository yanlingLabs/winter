# Cowork session door, D2: the guest tool surface (wired behind the refusal)

Slice D2 of [the session door design](2026-10-18-cowork-session-door-design.md), section 4. One composition now decides what a Cowork guest incarnation is offered. The prompt, the tool list and the guest launch all start from it.

Nothing becomes creatable or runnable. `session.create {mode: "cowork"}` still answers `unsupported_topology` in production, and nothing in src constructs the guest runtime supervisor that calls the composition.

Owner decision applied (2026-10-18): G4, which withholds the message, question and task tools by profile.

## What landed

| Piece | Where |
|---|---|
| `COWORK_GUEST_PROFILE_TOOLS` (`host-query-v1`: Bash, Edit, Read, Write) and `coworkProfileWithheldTools(profile, withheld)` | `packages/core/src/cowork/session-profile.ts` |
| `COWORK_CAPABILITY_SERVERS` (empty), `coworkGuestToolInputs` (the one normalisation), `coworkToolsFor` | `packages/core/src/runtime-sdk/mode-options.ts` |
| `confinedToolVisibility(offered)` and `GuestRuntimeSupervisorDeps.readiness` | `packages/core/src/cowork/guest-runtime.ts` |

### The composition

1. `coworkProfileWithheldTools` returns a sorted list of:
   - the host's own withholdings;
   - every allowlisted name the profile cannot carry. For `host-query-v1` that is everything except Bash, Edit, Read and Write, including the host brokers SendMessage, ListAgents, TaskStop and AskUserQuestion, the Task tools, TaskOutput, Agent and ToolSearch;
   - Edit, whenever Read or Write is withheld, because the SDK profile refuses Edit without both.
2. `coworkGuestToolInputs` folds that list into `withheldTools` and forces `mcpServers: false`. The guest refuses a non-empty `mcpServers`, and no capability server is built.
3. `coworkToolsFor(input)` is `coworkOfferedTools(coworkGuestToolInputs(input))`. A prompt built from `{...coworkGuestToolInputs(input), ...}` names exactly those tools (G4).
4. `confinedToolVisibility(offered)` takes the offered list and returns it in the guest's order (Read, Edit, Write, Bash). It derives nothing from the ceiling. It refuses `invalid_request` on any of:
   - an unknown or repeated name;
   - a ceiling class passed by a stale caller;
   - Edit without both Read and Write.
5. The supervisor computes the offered list from:
   - the binding's policy;
   - the captured ceiling's classes and network;
   - `deps.readiness`, which absent reads as none.

   Until the native environment declares `guest-compartment` from the verified image pin, a launch carries no tool at all.

The profile set mirrors the agent SDK literally: `packages/runtime/src/guest/linux-host-query-profile.ts` at main `68e57c646f23`, `const tools = new Set(["Read", "Write", "Edit", "Bash"])`. The SDK version this repository pins predates the profile, so the test never reads the SDK. Pairing the host and guest SDK versions is Track A's job at the repin (G3/G8).

## Tests

- **`packages/core/test/cowork/guest-tool-surface.test.ts`** (new):
  - the cap and its provenance;
  - the withheld list (G4 brokers, the Edit rule, typed refusals);
  - a sweep of every class × policy × readiness × network combination (49,152). Each must equal the one composition, follow the class rule exactly once `guest-compartment` is declared, offer nothing without it, and be accepted unchanged by the launch;
  - host withholdings never leave an Edit the guest would refuse;
  - the normalisation (no MCP server, caller fields kept, caller object untouched);
  - the prompt over every policy, network, ceiling and ownership names none of the withheld tools, which only the cap keeps out;
  - the launch's fail-closed visibility;
  - the empty server list against `CAPABILITY_SERVER_KEYS`.
- **`packages/core/test/cowork/guest-query.test.ts`:**
  - the fixture declares `guest-compartment`, one added dep;
  - a new case: with readiness absent, empty, or lacking the compartment, the query and the launch offer no tool, `mcpServers` is `{}` and `strictMcpConfig` is true.
- **`packages/core/test/cowork/session-profile.test.ts`:**
  - the class-visibility case now checks the class rule and that the launch takes the list as is;
  - the anti-wiring pin moves from "no src importer" to "wired behind the refusal". It requires all of:
    - `mode-options.ts` is the only src importer, with exactly its one import line;
    - only `guest-runtime.ts` calls the composition, judged on code with comments stripped;
    - no src module constructs the supervisor;
    - no other src file names any profile export.
  - The owner document's generated blocks are unchanged: the test passes without `COWORK_PROFILE_DOC_UPDATE`.

Mutations: 20 of 20 killed:

- the cap: widened, not applied, not folded in (3);
- the Edit rule (2) and its second gate in the launch (1);
- the typed refusals: unknown profile or withheld name, unknown or repeated launch name (4);
- the forced `mcpServers: false`;
- the empty server list;
- the normalisation bypass;
- absent readiness (1);
- the launch re-deriving from the ceiling or ignoring the list (2);
- the four anti-wiring pins.

Two inputs are equivalent today, so no mutant targets them: the supervisor's policy and network. None of the four guest tools is policy- or network-gated.

## Not in D2

- The `system/init` check (`toolSurfaceViolations(init.tools, offered, new Set())`, aborting `tool_surface_unenforced`) needs the driver. It is D3's.
- "No `winter__<key>` server is built for a Cowork incarnation" cannot be observed before a driver exists. D2 pins what can be pinned: the server list is empty, every key is unbuilt, and the guest query carries `mcpServers: {}` with `strictMcpConfig`.
- **A trap for D3.** The SDK profile's `configKeys` has no `resume`, but `GuestRuntimeLaunch.runtime` adds `resume` whenever `identity.resume` is true, and the guest would refuse that whole launch. D3's driver must answer `cold_resume_unavailable` (G6) before it ever builds a resume launch.

## Review follow-up (2026-10-19)

The DOOR review found D2 clean. Its one LOW is fixed here. `confinedToolVisibility` now takes only the profile's own tool names (`CoworkGuestTool`, which is `COWORK_GUEST_PROFILE_TOOLS`' union), and `coworkToolsFor` returns that type. A stale caller that passes ceiling classes, or an arbitrary string list, is now a compile error and not only a run-time `invalid_request`. Two `@ts-expect-error` lines pin this: widening the parameter back to `string[]` fails `tsc`, because the directives become unused. #88's review fixes are merged in.
