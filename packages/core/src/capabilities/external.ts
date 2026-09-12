// The `external` capability server (Phase 8c Lane 3, Task 3.4) — plugin-contributed tools, forwarded
// to the OWNING plugin over its existing RPC (the pre-8c `tool.register`/`plugin_tool_invoke` door,
// `ipc/server.ts` + `plugins/supervisor.ts`'s `invoke()`), now advertised through a per-session
// `mcp__norma__external__<tool>` server instead of the shared, name-mangled `plugin__<pluginId>__
// <tool>` registry entry that door still also writes (that write is untouched — Lane 3 owns
// `plugins/*` GLUE, not the `tool.register` handler itself, which no lane touches in 8c).
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS TAKES AN INJECTED LIST RATHER THAN READING THE SHARED REGISTRY ITSELF
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// `agent/tools/registry.ts`'s `ToolRegistry` has no public method to enumerate its defs by name
// prefix (only `has`/`specFor`/`execute`/`unregisterByPrefix` — a write-only prefix operation, no
// read-only equivalent) and that file is outside Lane 3's owned files for 8c (the lane map's row
// for this lane names `capabilities/external.ts`, one registration line in `capabilities/index.ts`,
// `plugins/*` glue, `diffs/*`, `agent/lsp/*` and tests — not `agent/tools/registry.ts`). Rather than
// add a method to a file no lane claims, this module takes the already-filtered, already-bare-named
// tool list as a dependency (`ExternalCapabilityDeps.tools()`), snapshotted once when the session's
// capability servers are built (mirrors every other capability's session-lifetime contract, and
// `capabilityServer`'s own "session keeps what it started with" design).
//
// **The real source is wired (P8c integration round 2, `daemon.ts`).** `agent/tools/registry.ts`
// gained a read-only `listByPrefix(prefix)` (a listing, not a write, so it does not collide with
// the "no lane owns registry.ts" constraint that held through the lane phase); `daemon.ts` reads
// `sharedRegistry.listByPrefix("plugin__")`, splits each `plugin__<pluginId>__<name>` back into its
// two halves (`tool.register`'s own namespacing), and builds one `ExternalToolSource` per row whose
// `invoke` closes over `sharedRegistry.execute(fullName, args, ctx)` — the SAME dispatch
// `capabilityServer`'s own private-registry `callTool` uses for every other capability (MAX_OUTPUT
// truncation, the same invalid-argument wording, throw→isError), which in turn reaches the
// unchanged `tool.register` handler's `run()` closure (`supervisor.invoke(pluginId, name,
// argsJson)`) — one plugin-RPC path, never a second. `deps.tools` takes the session (widened from a
// zero-arg factory) so that `ctx` can be session-scoped rather than a placeholder. An absent/no-op
// `daemon.ts` wiring (a test harness with no `sharedRegistry`) still reads as `[]` — inert, not
// broken, matching every OTHER capability server's "kept, advertising nothing" contract
// (`capabilities/index.ts`'s own doc comment).
//
// SNAPSHOT AT SESSION-BUILD TIME: a plugin that registers a tool AFTER a session's servers were
// already built never appears in that already-running session (documented, matches every other
// capability's contract) — a FRESH session picks it up because `buildCapabilitiesFor` calls
// `deps.tools()` again for it.
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { z } from "zod";
import type { Mode, ToolDefinition } from "../agent/tools/registry";
import { capabilityServer, type CapabilitySession } from "./server";

/** One plugin-contributed tool, alive at session-build time. `name` is the BARE tool name the
 *  plugin declared (never the shared registry's `plugin__<pluginId>__<name>` form) — it becomes
 *  `mcp__norma__external__<name>` on the wire, the router's own `mcp__<server>__<tool>` convention
 *  (`capabilities/names.ts`'s header) applied to THIS server's name (`norma__external`). */
export interface ExternalToolSource {
  /** Which plugin owns this tool — carried only for the invoke bridge and error messages; never
   *  part of the advertised wire name (that would defeat the point of a bare name). */
  pluginId: string;
  name: string;
  description: string;
  /** The plugin author's raw JSON schema, passed through verbatim — the same "core never
   *  re-validates plugin-supplied argument shapes beyond 'is an object'" contract the pre-8c
   *  `tool.register` handler already applies (`ipc/server.ts`'s own comment on `rawParameters`). */
  parameters?: Record<string, unknown>;
  /** Which session modes may see this tool. Absent ⇒ `["code"]` — the SAME restrictive default
   *  `ToolDefinition.modes` documents (a dynamically registered tool "stays code-only, matching
   *  their reachability today"); this is "the plugin's declared modes (default code)" the brief
   *  asks for, expressed as data on the source rather than a static `NORMA_CAPABILITY_TOOLS` row
   *  (impossible here: tool names are runtime-defined per plugin, not a fixed enumerable set). */
  modes?: Mode[];
  /** Forwards this call to the OWNING plugin over its existing RPC — the caller's job to bind to
   *  `PluginSupervisor.invoke(pluginId, name, argsJson)` (or an equivalent), which is what produces
   *  `plugin_tool_invoke` on the wire, unchanged from the pre-8c door. Never throws by contract:
   *  a transport/timeout/circuit-open failure is reported as `{ok:false, message}`, converted below
   *  into the SAME isError tool_result shape `ToolRegistry.execute`'s throw-catch already produces
   *  for every other tool. */
  invoke(argsJson: string): Promise<{ ok: true; resultJson: string } | { ok: false; message: string }>;
}

export interface ExternalCapabilityDeps {
  /** Every plugin-contributed tool alive right now — see this module's header for the snapshot
   *  contract. Absent (or omitted by a caller) reads as `() => []`.
   *
   *  P8c integration round 2: takes the session so a real `daemon.ts` wiring can build each
   *  source's `invoke` closure with a session-scoped `ToolContext` (the shared `ToolRegistry`'s
   *  `execute()` requires one) — the real-wiring carry this module's header names is now closed.
   *  Existing callers built against the old zero-arg shape (`tools: () => sources`) keep compiling
   *  unchanged: a function declaring FEWER parameters than a call site offers is always assignable
   *  to a slot expecting more (TS's ordinary function-arity variance), so this is additive. */
  tools?(session: CapabilitySession): readonly ExternalToolSource[];
}

/** A permissive passthrough schema — core never re-validates plugin-supplied argument shapes
 *  beyond "is an object" (mirrors `ipc/server.ts`'s `tool.register` handler's own `args` field). */
const PASSTHROUGH_ARGS = z.object({}).passthrough();

export function externalCapability(session: CapabilitySession, deps: ExternalCapabilityDeps): McpSdkServerConfigWithInstance {
  const sources = deps.tools?.(session) ?? [];
  const defs: ToolDefinition[] = sources.map((source) => ({
    name: source.name,
    description: source.description,
    args: PASSTHROUGH_ARGS,
    ...(source.parameters === undefined ? {} : { rawParameters: source.parameters }),
    ...(source.modes === undefined ? {} : { modes: source.modes }),
    async run(args) {
      const result = await source.invoke(JSON.stringify(args));
      if (result.ok) return result.resultJson;
      // Throwing here is deliberate (mirrors the pre-8c `tool.register` handler's own run()):
      // `ToolRegistry.execute`'s catch turns a thrown Error's message into `{output, isError:true}`
      // — the only way a `run()` that returns a plain string produces an isError tool_result.
      throw new Error(`plugin ${source.pluginId} tool ${source.name}: ${result.message}`);
    },
  }));
  return capabilityServer({ key: "external", defs }, session);
}
