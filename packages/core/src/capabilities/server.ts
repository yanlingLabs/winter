// The ONE piece of machinery every Norma capability server is built out of (P8b Tasks 6-7).
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// ONE IMPLEMENTATION, TWO DOORS — and the door is the `ToolDefinition` itself
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// The brief asks for the registry handler's body to be extracted into a named function both doors
// call. This file goes one step further and shares the WHOLE `ToolDefinition` object: each tool
// module now exports a `*ToolDefs(deps)` factory, `register*Tool` registers what it returns on the
// daemon's shared `ToolRegistry`, and a capability server holds the SAME objects in a private
// `ToolRegistry` of its own. The consequences are the point:
//
//   * `listTools()` advertises `registry.specFor(...)` — literally the serializer `tool.list` and
//     ToolSearch use (`toSpec`: `rawParameters ?? z.toJSONSchema(argsFor(def, mode))`), so schema
//     parity is BY CONSTRUCTION rather than by a test that has to keep noticing.
//   * `callTool` runs `registry.execute(...)` — the same zod validation, the same invalid-argument
//     WORDING, the same `MAX_OUTPUT` truncation, the same throw→`isError` conversion. A refusal on
//     the Winter leg reads identically to a refusal on the engine, including chat's read-only
//     `browser` refusal, which is a per-mode SCHEMA failure and not a prose message.
//
// A private registry rather than the shared one because the shared one is a live, daemon-global
// object the plugin supervisor and `tool.register` RPC write into (Norma map §5.6): a capability
// server must advertise exactly its own tools and nothing a plugin happened to add.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE PER-CALL SESSION — the one thing the router does not give us (ROUTER 0.0.3 CARRY)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// `WinterMcpServerInstance.callTool(name, args)` takes no session identity, and the SDK's own
// bridge confirms it end to end: `makeSdkMcpCallHandler` invokes
// `cfg.instance.callTool(req.tool ?? "", req.arguments ?? {})` — the `sdk_mcp_call` control request
// carries `server`/`tool`/`arguments` and nothing else. Capability servers are SHARED across every
// session on the handle (they are construction-time, surface map §1.7), so an in-process server has
// no way to know which session is calling it.
//
// For 8b that is bound host-side: `deps.currentSession()` is a getter Task 16's session driver sets
// around each turn. It is sound today for exactly one reason, stated so it is a known limit rather
// than a discovered bug — ONE daemon, and at most one running turn per session, with the driver
// setting the holder immediately before `query()` drains a prompt and clearing it after the turn's
// `result`. A concurrent second turn in another session would read the wrong identity, which is why
// `currentSession()` returning `undefined` is a TYPED REFUSAL here and never a default context: a
// capability that guessed a session would write a browser tab or a screenshot lease into somebody
// else's transcript.
//
// Recorded as a ROUTER 0.0.3 CARRY: `callTool(name, args, ctx?)` with the calling session's id
// (and, ideally, its mode) would make this exact.
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import type { ComputerUseService } from "../agent/computer-use";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../agent/tools/registry";
import type { SessionMode } from "./names";

/**
 * Everything a capability call needs to know about WHO is calling.
 *
 * Deliberately NOT a `ToolContext`: a `ToolContext` also carries the engine's deferral bookkeeping
 * (`builtinDeferral`, `loadedTools`, `deferThreshold`) and its tool-access sets
 * (`allowTools`/`excludeTools`). Handed a context with `builtinDeferral: true`, this file's private
 * registry would refuse `browser`/`list_sessions`/`computer` with "load its schema via ToolSearch
 * first" — a rule that exists for the ENGINE's prompt budget and means nothing to a spawned Winter
 * child, which was handed the tool list up front. So the session driver supplies identity only, and
 * the `ToolContext` is BUILT here with those fields left unset.
 */
export interface CapabilitySession {
  /** Norma's own session id — what every emitted event is scoped to. */
  sessionId: string;
  /** Resolves `argsByMode` (chat's read-only `browser` subset) exactly as the engine does. */
  mode: SessionMode;
  cwd: string;
  /** `roots[0]` MUST be the primary cwd, as `ToolContext` documents. */
  roots: string[];
  tmpDir?: string;
  outDir?: string;
  /** The turn's abort signal — `computer`'s `wait` and every dispatched panel command honour it. */
  signal?: AbortSignal;
  /** `ModelInfo.supportsVision` for the turn's model. `false` makes `computer` refuse a screenshot
   *  with today's message; unset means unknown and is not a block. */
  visionCapable?: boolean;
  /**
   * Stage a vision image for the model.
   *
   * NO WINTER ANALOG TODAY, and left optional on purpose rather than faked: on the engine the
   * screenshot's `data:` URL is appended to the turn's input as an `{type:"image"}` item
   * (`engine.ts`'s `pendingImages`). A spawned child's turn input is not ours to append to, and the
   * brief pins the MCP result mapping to text, so absent → `computer` returns the label alone and
   * says the image follows only when something is actually staging it. Recorded as a follow-up:
   * MCP `content` admits `{ type: "image" }`, which is the honest fix once it is ruled on.
   */
  attachImage?: (dataUrl: string) => void;
  /**
   * A HUMAN authorized THIS call's navigation to a dangerous-list domain (browser.ts's Task-5
   * seam). Absent/false = no approval, which is the fail-closed answer for every call the daemon
   * has not explicitly stamped — including every Winter-leg call until Task 8's approval bridge
   * stamps it. Never settable from tool ARGUMENTS: it is a context field precisely so the model
   * cannot write it.
   */
  browserDomainApproved?: boolean;
  /** The lease-holding computer-use service for this session, when one is wired. */
  computerUse?: ComputerUseService;
}

/** The one dependency every capability server takes: who is calling, right now. */
export interface CapabilitySessionDeps {
  currentSession(): CapabilitySession | undefined;
}

export interface CapabilityServerSpec {
  /** The P8b-12 server key — `sessions`, `computer`, `browser`, `office`, `research`. Forwarded to
   *  the Winter leg as the MCP server's OWN name (surface map §1.7). */
  key: string;
  /** THE definitions — the same objects the daemon's shared registry holds. */
  defs: readonly ToolDefinition[];
  /**
   * Which mode's schema `listTools()` advertises: the WIDEST mode this server serves.
   *
   * Only `browser` has an `argsByMode`, so for every other server this is inert — but the rule is
   * stated per server rather than defaulted, because getting it wrong is silent. `undefined` (the
   * registry's own fail-closed resolution) would advertise `browser`'s NARROW chat schema to a code
   * session, which would be told it may not call a verb `callTool` in that same session would
   * happily accept. Per-CALLER narrowing still happens at call time, from `session.mode`.
   */
  schemaMode: SessionMode;
  /** Extra `ToolContext` wiring this server's tools need beyond identity (e.g. `computer`'s
   *  service). Applied on top of the identity-derived context, never under it. */
  contextExtras?(session: CapabilitySession): Partial<ToolContext>;
}

/** `{ content: [{ type: "text", text }], isError }` — the registry's `ToolOutcome` → MCP mapping,
 *  in one place. `isError` is always present (the SDK forwards it only when defined, and an
 *  omitted flag on a failure reads as success on the far side). */
function textResult(text: string, isError: boolean): { content: unknown[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Build one capability server.
 *
 * The returned object is exactly `McpSdkServerConfigWithInstance`: `{ type: "sdk", name, instance }`.
 * `tools` is deliberately NOT set — the SDK populates the wire-safe list from `instance.listTools()`
 * itself (`toWireMcpServers`), so declaring it by hand would be a second copy that could drift.
 */
export function capabilityServer(
  spec: CapabilityServerSpec,
  deps: CapabilitySessionDeps,
): McpSdkServerConfigWithInstance {
  const registry = new ToolRegistry();
  for (const def of spec.defs) registry.register(def);
  const names = new Set(spec.defs.map((d) => d.name));

  const instance: WinterMcpServerInstance = {
    listTools() {
      return spec.defs.map((def) => {
        // `specFor` is the registry's own renderer — `rawParameters ?? z.toJSONSchema(...)`. Never
        // undefined here: the name was just registered and none of these defs carries a `scope`.
        const rendered = registry.specFor(def.name, undefined, spec.schemaMode);
        if (!rendered) throw new Error(`capability ${spec.key}: ${def.name} has no spec`);
        return {
          name: rendered.name,
          description: rendered.description,
          // The router refuses any capability tool whose `inputSchema` is not a JSON-Schema OBJECT
          // (`capabilityInputSchema`), at CONSTRUCTION — so a def whose schema is not an object
          // shape would take down `createRuntimeSdk`, not just this tool.
          inputSchema: rendered.parameters as Record<string, unknown>,
        };
      });
    },

    async callTool(name: string, args: Record<string, unknown>) {
      // Unknown tool FIRST, and worded exactly as `ToolRegistry.execute` words it — a name this
      // server does not serve is answerable without knowing anything about the caller.
      if (!names.has(name)) return textResult(`unknown tool: ${name}`, true);
      const session = deps.currentSession();
      if (!session) {
        // Never a guessed identity: see this file's header. A capability with no bound session
        // would open panel tabs, take screenshots and spawn children against the wrong transcript.
        return textResult(
          `${name} is not available right now: no Norma session is bound to this call`,
          true,
        );
      }
      const ctx: ToolContext = {
        cwd: session.cwd,
        roots: session.roots,
        sessionId: session.sessionId,
        mode: session.mode,
        ...(session.tmpDir === undefined ? {} : { tmpDir: session.tmpDir }),
        ...(session.outDir === undefined ? {} : { outDir: session.outDir }),
        ...(session.signal === undefined ? {} : { signal: session.signal }),
        ...(session.visionCapable === undefined ? {} : { visionCapable: session.visionCapable }),
        ...(session.attachImage === undefined ? {} : { attachImage: session.attachImage }),
        ...(session.browserDomainApproved === undefined ? {} : { browserDomainApproved: session.browserDomainApproved }),
        ...(session.computerUse === undefined ? {} : { computerUse: session.computerUse }),
        ...spec.contextExtras?.(session),
      };
      try {
        // The registry's own execute: same validation, same wording, same truncation, same
        // throw→isError. Deferral never fires — `builtinDeferral` is unset above, on purpose.
        const outcome = await registry.execute(name, args, ctx);
        return textResult(outcome.output, outcome.isError);
      } catch (err) {
        // `execute` already converts a tool throw; this catches the pathological rest (a def whose
        // schema itself throws). NEVER rethrow: the SDK would render it as `sdk_tool_threw`, which
        // is a transport fault, not a tool result the model can read and recover from.
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };

  return { type: "sdk", name: spec.key, instance };
}
