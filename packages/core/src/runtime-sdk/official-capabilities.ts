// P8c-4: THE SAME CAPABILITY TOOLS ON THE OFFICIAL LEG, registered from the SAME per-session Winter
// instances the daemon already built for this session (`capabilities/index.ts`'s
// `buildCapabilitiesFor` / `CapabilityServerRecord`) — never a second copy of a tool's definition.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS RATHER THAN CALLING THE ROUTER'S OWN `materializeOfficialMcpServer` (P8c-4)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The phase brief's own Interfaces block names `officialMcpServers`/`materializeOfficialMcpServer`
// (`@yanlinglabs/winter-runtime-sdk`'s `official/mcp-descriptors.ts`) as the intended door. MEASURED
// against the pinned 0.0.2 (both the installed tarball and the `v0.0.2` tag in the sibling
// checkout): neither function, nor `WinterMcpServerDescriptor`, `OfficialMcpModule`,
// `InputShapeFactory`, `createApprovalBridge`, `minimalOsEnvironmentFrom`, `OptionsTemplatePolicy`
// or `OfficialEnvPolicy` are re-exported from the package's public entry point — only `door.ts`'s own
// six names (`createOfficialInputStream`, `isOfficialQuery`, `officialCredentialPlan`,
// `officialConnectionEnv`, `officialUserTurn`, plus the `RouterOfficialInput`/`RouterOfficialPolicy`
// TYPES) cross the `exports` boundary (`package.json`'s `exports` map has exactly one entry, `"."`,
// and bun enforces it — a deep `.../dist/official/mcp-descriptors.js` import throws
// `Cannot find module`). **This is a real, verified contradiction of the brief's "verbatim"
// Interfaces block — carried to router 0.0.3 below and in the lane report, not asserted quietly.**
//
// THE WORKAROUND STAYS INSIDE THE DOCUMENTED CONTRACT, THOUGH, rather than reaching around it:
// `RouterOfficialInput.mcpServers` is door.ts's own escape hatch ("already materialized by the
// host … most hosts never fill this in [since R-8], … a host that genuinely needs [it] …") — built
// for exactly a host that materializes its OWN per-session servers. So this file builds the official
// leg's MCP servers directly against the REAL `@anthropic-ai/claude-agent-sdk`'s own
// `createSdkMcpServer`/`tool` (reached through `create.ts`'s `officialPeer()` — the SAME injected
// module instance the router itself would use, had its own helper been reachable), rather than
// against anything the router exports. `RuntimeSdkOptions.capabilities` still stays `[]` (P8c-4 /
// P8b-36): this file is what materializes them per session for `runtime.official.mcpServers`, never
// the constructor-level list.
//
// THE HANDLER CALLS THE WINTER INSTANCE'S `callTool`, so behaviour is byte-identical on both legs —
// same registry validation, same wording, same `MAX_OUTPUT` truncation, same throw→`isError`
// conversion (`capabilities/server.ts`'s own header makes the identical claim for the Winter leg).
// NOTHING here re-implements a tool; it forwards to what P8b already built.
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { isWinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { z } from "zod";
import type { CapabilityServerRecord } from "../capabilities";

/** The narrow JSON-Schema-object subset Norma's own `registry.specFor` ever emits for a capability
 *  tool (`z.toJSONSchema` over a zod OBJECT schema — the router refuses anything else at
 *  construction on the Winter leg, so this file need not accept a wider shape either). */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  description?: string;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  maxLength?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: readonly JsonSchemaProperty[];
  [key: string]: unknown;
}

/** `(schema) => a zod RAW SHAPE` — the exact `InputShapeFactory` contract the Interfaces block
 *  names, built on Norma's own `zod` dependency rather than a re-export this package does not have. */
export type InputShapeFactory = (schema: JsonSchemaObject) => Record<string, z.ZodTypeAny>;

/** One JSON-Schema property node → one zod type. `nullable` is read off `anyOf: [T, {type:"null"}]`
 *  (the shape `z.toJSONSchema` emits for `.nullable()`) as well as a bare `type: [T, "null"]`. */
function zodTypeFor(prop: JsonSchemaProperty): z.ZodTypeAny {
  const anyOfNullable = prop.anyOf?.find((a) => a.type === "null");
  if (prop.anyOf !== undefined && anyOfNullable !== undefined) {
    const rest = prop.anyOf.find((a) => a.type !== "null");
    return rest === undefined ? z.unknown().nullable() : zodTypeFor(rest).nullable();
  }
  const types = Array.isArray(prop.type) ? prop.type : prop.type === undefined ? undefined : [prop.type];
  const nullable = types?.includes("null") ?? false;
  const primary = types?.find((t) => t !== "null");
  let base: z.ZodTypeAny;
  switch (primary) {
    case "string": {
      let s = z.string();
      if (typeof prop.maxLength === "number") s = s.max(prop.maxLength);
      if (typeof prop.minLength === "number") s = s.min(prop.minLength);
      base = prop.enum !== undefined && prop.enum.length > 0 ? z.enum(prop.enum.map(String) as [string, ...string[]]) : s;
      break;
    }
    case "number": {
      let n = z.number();
      if (typeof prop.minimum === "number") n = n.min(prop.minimum);
      if (typeof prop.maximum === "number") n = n.max(prop.maximum);
      base = n;
      break;
    }
    case "integer": {
      let n = z.number().int();
      if (typeof prop.minimum === "number") n = n.min(prop.minimum);
      if (typeof prop.maximum === "number") n = n.max(prop.maximum);
      base = n;
      break;
    }
    case "boolean":
      base = z.boolean();
      break;
    case "array":
      base = z.array(prop.items !== undefined ? zodTypeFor(prop.items) : z.unknown());
      break;
    case "object":
      base = z.object(jsonSchemaToZodShape({ properties: prop.properties ?? {}, required: prop.required ?? [] }));
      break;
    default:
      base = z.unknown();
  }
  if (prop.description !== undefined) base = base.describe(prop.description);
  return nullable ? base.nullable() : base;
}

/**
 * `(schema) => Record<string, z.ZodTypeAny>` — the `InputShapeFactory` every official-leg MCP
 * server's `tool()` call needs. A field absent from `required` is `.optional()`; every other
 * behaviour is `zodTypeFor`'s.
 */
export const jsonSchemaToZodShape: InputShapeFactory = (schema) => {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const field = zodTypeFor(prop);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
};

/**
 * The narrow structural surface this file needs from the injected official peer — a LOCAL type,
 * never imported from the router (see this file's header): `create.ts`'s `OfficialPeer` already IS
 * this shape at runtime (the real `@anthropic-ai/claude-agent-sdk` exports both), so a caller passes
 * the SAME module instance straight through.
 */
export interface OfficialMcpModule {
  createSdkMcpServer(options: { name: string; version?: string; tools?: unknown[]; instructions?: string }): unknown;
  tool(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>,
  ): unknown;
}

/** `{content, isError}`, unpacked from a `McpSdkServerConfigWithInstance` whose `instance` narrows
 *  to `WinterMcpServerInstance` — the ONLY shape `capabilities/server.ts` ever produces (a plugin
 *  supervisor server, which is not session-scoped and never reaches this door, would fail this
 *  guard and is skipped rather than mis-forwarded). */
function winterInstanceOf(config: McpSdkServerConfigWithInstance): WinterMcpServerInstance | undefined {
  return isWinterMcpServerInstance(config.instance) ? config.instance : undefined;
}

/**
 * Builds the official leg's `mcpServers` from the SAME per-session record the Winter leg already
 * has (`buildCapabilitiesFor`'s `CapabilityServerRecord`), one official `createSdkMcpServer` per
 * entry, registered under the IDENTICAL key the Winter leg uses (`record`'s own keys are already
 * `norma__<key>`, `capabilities/names.ts`'s `capabilityServerName`) — so `mcp__norma__<key>__<tool>`
 * comes out the same canonical name on both legs (P8b-35/P8c-4).
 *
 * A record entry whose `instance` is not a `WinterMcpServerInstance` (never true for anything
 * `buildCapabilitiesFor` returns today) is skipped rather than thrown — a host-shaped invariant this
 * file cannot repair belongs to whichever door is producing it, and this door's job is to mirror
 * what IS there, faithfully.
 */
export function officialCapabilityServersFor(
  record: CapabilityServerRecord,
  module: OfficialMcpModule,
  toInputShape: InputShapeFactory = jsonSchemaToZodShape,
): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(record)) {
    const instance = winterInstanceOf(config);
    if (instance === undefined) continue;
    const tools = instance.listTools().map((def) =>
      module.tool(
        def.name,
        def.description ?? "",
        toInputShape(def.inputSchema as JsonSchemaObject),
        async (args) => {
          const outcome = await instance.callTool(def.name, args);
          return { content: outcome.content, ...(outcome.isError === undefined ? {} : { isError: outcome.isError }) };
        },
      ),
    );
    servers[name] = module.createSdkMcpServer({ name, tools });
  }
  return servers;
}
