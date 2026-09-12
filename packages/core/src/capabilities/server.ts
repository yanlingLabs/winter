// The ONE piece of machinery every Winter capability server is built out of (P8b Tasks 6-7).
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// ONE IMPLEMENTATION, TWO DOORS — and the door is the `ToolDefinition` itself
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// The brief asks for the registry handler's body to be extracted into a named function both doors
// call. This file goes one step further and shares the WHOLE `ToolDefinition` object: each tool
// module exports a `*ToolDefs(deps)` factory, `register*Tool` registers what it returns on the
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
// object the plugin supervisor and `tool.register` RPC write into (Winter map §5.6): a capability
// server must advertise exactly its own tools and nothing a plugin happened to add.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// P8b-36: A CAPABILITY SERVER IS BUILT **PER SESSION**, WITH THE SESSION BAKED IN
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// `WinterMcpServerInstance.callTool(name, args)` carries no session identity — measured, not
// inferred: the SDK's `makeSdkMcpCallHandler` invokes
// `cfg.instance.callTool(req.tool ?? "", req.arguments ?? {})`, and the router's own forwarding
// (`capabilityServerDescriptor`) does the same. The `sdk_mcp_call` control request carries
// `server` / `tool` / `arguments` and nothing else.
//
// The first cut of this file answered that with a daemon-wide "currently bound session" slot. That
// was WRONG, and the reason is worth keeping written down: the slot is per-DAEMON, so two Winter
// sessions running turns concurrently cross-attribute — and because `ctx.mode` comes from the same
// slot and is what resolves `browser`'s `argsByMode`, a CHAT session's call landing while a CODE
// session was bound would have been handed the full interact verb set. The read-only subset would
// have been bypassed silently.
//
// The fix needs no router change, because 8b is Winter-leg-only (P8b-1) and the router forwards a
// caller's own `Options.mcpServers` straight through to the Winter leg: the daemon builds the
// capability servers FOR ONE SESSION and passes them on that session's own `Options`. Identity is a
// closure, not a lookup; `mode` cannot be another session's; and there is no unbound state to
// refuse — `capabilityServer(spec, session)` takes a non-optional `CapabilitySession`, so "no
// session" is a compile error rather than a runtime branch.
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import type { ComputerUseService } from "../agent/computer-use";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../agent/tools/registry";
import { WINTER_CAPABILITY_TOOLS, capabilityServerName, capabilityToolName, type SessionMode } from "./names";

/**
 * Everything a capability call needs to know about WHO is calling. Fixed for the life of the
 * server, because the server is built for exactly one session.
 *
 * Deliberately NOT a `ToolContext`: a `ToolContext` also carries the engine's deferral bookkeeping
 * (`builtinDeferral`, `loadedTools`, `deferThreshold`) and its tool-access sets
 * (`allowTools`/`excludeTools`). Handed a context with `builtinDeferral: true`, this file's private
 * registry would refuse `browser`/`list_sessions`/`computer` with "load its schema via ToolSearch
 * first" — a rule that exists for the ENGINE's prompt budget and means nothing to a spawned Winter
 * child, which was handed the tool list up front. So the session driver supplies identity only, and
 * the `ToolContext` is BUILT here with those fields left unset.
 *
 * The fields are read at CALL time, so a driver that keeps one mutable session object per session
 * (updating `signal` at each turn boundary, say) works without rebuilding the servers.
 */
export interface CapabilitySession {
  /** Winter's own session id — what every emitted event is scoped to. */
  sessionId: string;
  /** THIS session's mode. Resolves `argsByMode` (chat's read-only `browser` subset) exactly as the
   *  engine does, and decides which schema `listTools()` advertises. */
  mode: SessionMode;
  cwd: string;
  /** `roots[0]` MUST be the primary cwd, as `ToolContext` documents. */
  roots: string[];
  /** ⚠️ REQUIRED for `web_fetch`, which saves its converted page under it and THROWS when it is
   *  unset. A driver that omits it makes every code-mode fetch fail; pinned by a test. */
  tmpDir?: string;
  outDir?: string;
  /** The session's abort signal — `computer`'s `wait` and every dispatched panel command honour it. */
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
  /** A per-session override of the daemon's `ComputerUseService`. Normally unset — the `computer`
   *  capability reads the daemon's single holder instead. */
  computerUse?: ComputerUseService;
}

export interface CapabilityServerSpec {
  /** The P8b-12 server key — `sessions`, `computer`, `browser`, `office`, `research`, `web`. The
   *  server's WIRE name is `capabilityServerName(key)`; see `names.ts` for why they differ. */
  key: string;
  /** THE definitions — the same objects the daemon's shared registry holds. Filtered to this
   *  session's mode before anything is advertised or executed; see `modesFor` below. */
  defs: readonly ToolDefinition[];
  /** Extra `ToolContext` wiring this server's tools need beyond identity (e.g. `computer`'s
   *  service). Applied UNDER the identity-derived fields (n1): an extras function that returned
   *  `mode` or `sessionId` must never be able to override the session it was built for — that is
   *  precisely how chat's read-only `browser` subset would be weakened. */
  contextExtras?(session: CapabilitySession): Partial<ToolContext>;
}

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * P8b-37 — MODE SCOPING IS STRUCTURAL HERE, not only a string list in Task 9
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * P8b-12 assigned mode scoping to Task 9's per-mode `disallowedTools`, and that ruling's premise was
 * a capability set that was construction-time and MODE-BLIND. P8b-36 retired that premise: the
 * session — and therefore its mode — is now baked into every server. So the filter is one line, and
 * it is worth having as belt and braces for a reason C1 demonstrated: a `disallowedTools` entry is a
 * STRING, and a string that does not match the name the child actually registered denies nothing,
 * silently. A structural filter cannot miss.
 *
 * Without it, a chat session's `sessions` server would advertise AND execute `manage_session` —
 * which can background, archive or interrupt any session by id — and its `web` server would serve
 * `web_fetch`/`web_search`, neither of which chat is ever offered today. `ToolRegistry.execute` does
 * NOT enforce `modes` (mode there resolves `argsFor` and deferral only; the engine's mode gate is
 * `namesForMode`, which runs at ADVERTISEMENT time), so nothing downstream would have caught it.
 *
 * The source of truth is `WINTER_CAPABILITY_TOOLS`, deliberately: it is the same table Task 9 derives
 * `CAPABILITY_TOOL_MODES` from, so the two gates cannot disagree — and `names.test.ts` pins every
 * row of it against the real `ToolDefinition`s, so the table cannot drift from the tools either.
 * A tool absent from the table falls back to the registry's own documented default (`["code"]`),
 * which is the restrictive answer; `wire-names.test.ts` proves the absent case is unreachable.
 */
function modesFor(serverKey: string, def: ToolDefinition): readonly SessionMode[] {
  const facts = (WINTER_CAPABILITY_TOOLS as Readonly<Record<string, { modes: readonly SessionMode[] }>>)[
    capabilityToolName(serverKey, def.name)
  ];
  return facts?.modes ?? (def.modes as readonly SessionMode[] | undefined) ?? ["code"];
}

/** `{ content: [{ type: "text", text }], isError }` — the registry's `ToolOutcome` → MCP mapping,
 *  in one place. `isError` is always present (the SDK forwards it only when defined, and an
 *  omitted flag on a failure reads as success on the far side). */
function textResult(text: string, isError: boolean): { content: unknown[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Build one capability server FOR ONE SESSION.
 *
 * The returned object is exactly `McpSdkServerConfigWithInstance`: `{ type: "sdk", name, instance }`.
 * `tools` is deliberately NOT set — the SDK populates the wire-safe list from `instance.listTools()`
 * itself (`toWireMcpServers`), so declaring it by hand would be a second copy that could drift.
 */
export function capabilityServer(
  spec: CapabilityServerSpec,
  session: CapabilitySession,
): McpSdkServerConfigWithInstance {
  // P8b-37: THIS SESSION'S tools, and only those. Everything below — the private registry, the
  // advertised list, and the name set `callTool` answers for — is built from the filtered set, so a
  // tool this mode is not offered is indistinguishable from one that does not exist.
  const defs = spec.defs.filter((def) => modesFor(spec.key, def).includes(session.mode));
  const registry = new ToolRegistry();
  for (const def of defs) registry.register(def);
  const names = new Set(defs.map((d) => d.name));

  const instance: WinterMcpServerInstance = {
    listTools() {
      return defs.map((def) => {
        // `specFor` is the registry's own renderer — `rawParameters ?? z.toJSONSchema(...)`. Never
        // undefined here: the name was just registered and none of these defs carries a `scope`.
        //
        // THE MODE IS THIS SESSION'S (m2). Per-session servers make the advertised schema exact:
        // a chat session is shown `browser`'s READ-ONLY schema, which is what the registry shows a
        // chat session today, rather than the full one it would then be refused for using.
        const rendered = registry.specFor(def.name, undefined, session.mode);
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
      // Unknown tool FIRST, and worded exactly as `ToolRegistry.execute` words it. A tool filtered
      // out by mode (P8b-37) lands here too, and that is the right answer: to this session it does
      // not exist, which is exactly what the registry door tells a mode that was never offered it.
      if (!names.has(name)) return textResult(`unknown tool: ${name}`, true);
      const ctx: ToolContext = {
        // Extras UNDER identity (n1) — see `contextExtras`' own doc comment.
        ...spec.contextExtras?.(session),
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
      };
      try {
        // The registry's own execute: same validation, same wording, same truncation, same
        // throw→isError. Deferral never fires — `builtinDeferral` is unset above, on purpose.
        const outcome = await registry.execute(name, args, ctx);
        // `outcome.fileDiff` IS DELIBERATELY DROPPED (m3), and dropping it is the faithful port.
        // `fileDiff` is not model-visible on the registry door either: `execute` returns it beside
        // `output`, and the ENGINE spreads it onto the emitted `tool_result` EVENT for the Mac/iOS
        // renderers — the model only ever sees `output`. An MCP result has no event channel, so
        // carrying it here would SHOW the model something it is not shown today. No capability tool
        // produces one (`diff-report.ts` serves edit/write, which are class (a) and retire), and if
        // one ever does, the diff belongs on the projector's `tool_result` (Task 11), not in this
        // return value.
        return textResult(outcome.output, outcome.isError);
      } catch (err) {
        // `execute` already converts a tool throw; this catches the pathological rest (a def whose
        // schema itself throws). NEVER rethrow: the SDK would render it as `sdk_tool_threw`, which
        // is a transport fault, not a tool result the model can read and recover from.
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  };

  return { type: "sdk", name: capabilityServerName(spec.key), instance };
}
