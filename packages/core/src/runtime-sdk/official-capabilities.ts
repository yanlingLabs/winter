// P8c-4: THE SAME CAPABILITY TOOLS ON THE OFFICIAL LEG, registered from the SAME per-session Winter
// instances the daemon already built for this session (`capabilities/index.ts`'s
// `buildCapabilitiesFor` / `CapabilityServerRecord`) — never a second copy of a tool's definition.
//
// Fix round 1 (item 0): router 0.0.3 publishes `officialMcpServers`/`officialBranchLabel` at the
// package root (checkpoint b measured the 0.0.2 export gap and worked around it with a hand-rolled
// `createSdkMcpServer`/`tool` path — that workaround is now DELETED for THOSE two). The router's own
// `capabilityServerDescriptor`/`capabilityServerDescriptors` — the converters that would take
// Winter's `McpSdkServerConfigWithInstance` values verbatim — are declared in the installed 0.0.3's
// `official/mcp-descriptors.d.ts` but are NOT re-exported from the package root (measured directly
// against the installed tarball; a router 0.0.4 carry, P8c ledger). So THIS file still builds the
// descriptor BY HAND (`descriptorFromWinterConfig`, ~130 lines below) from the same
// `listTools()`/`callTool()` the Winter leg already calls — byte-identical behaviour on both legs,
// but with this file's own handler code, not the router's converter. `officialMcpServers` is the
// one piece that IS the router's own, taking the hand-built descriptors from here.
import type { McpSdkServerConfigWithInstance, WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { isWinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { officialBranchLabel, officialMcpServers } from "@yanlinglabs/winter-runtime-sdk";
import type { BrandProfile, InputShapeFactory as RouterInputShapeFactory, OfficialMcpModule as RouterOfficialMcpModule, WinterMcpServerDescriptor, WinterMcpToolDescriptor } from "@yanlinglabs/winter-runtime-sdk";
import { z } from "zod";
import type { CapabilityServerRecord } from "../capabilities";
import { CORE_BRAND } from "./brand";

/** The narrow JSON-Schema-object subset Winter's own `registry.specFor` ever emits for a capability
 *  tool (`z.toJSONSchema` over a zod OBJECT schema — the router refuses anything else at
 *  construction on the Winter leg, so this file need not accept a wider shape either). Structurally
 *  wider than the router's own exported `JsonSchemaObject` (`properties?: Record<string, unknown>`),
 *  so a real schema the router hands `jsonSchemaToZodShape` always satisfies it — see that
 *  function's own cast. */
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

/** `(schema) => a zod RAW SHAPE` — Winter's own `InputShapeFactory`, built on Winter's `zod`
 *  dependency. Structurally assignable to the router's own exported `InputShapeFactory` (both are
 *  `(schema) => unknown`-shaped; ours is a narrower return type, which is always fine). */
export type InputShapeFactory = (schema: JsonSchemaObject) => Record<string, z.ZodTypeAny>;

/** One JSON-Schema property node → one zod type. `nullable` is read off `anyOf: [T, {type:"null"}]`
 *  (the shape `z.toJSONSchema` emits for `.nullable()`) as well as a bare `type: [T, "null"]`.
 *  A MIXED `anyOf` of two or more non-null primitives (fix round 1, m3) becomes `z.union` rather
 *  than collapsing to the first branch or to `z.unknown()`. */
function zodTypeFor(prop: JsonSchemaProperty): z.ZodTypeAny {
  const anyOfNullable = prop.anyOf?.find((a) => a.type === "null");
  if (prop.anyOf !== undefined && anyOfNullable !== undefined) {
    const rest = prop.anyOf.filter((a) => a.type !== "null");
    const nullableBase = rest.length === 0 ? z.unknown() : rest.length === 1 ? zodTypeFor(rest[0]!) : z.union(rest.map((r) => zodTypeFor(r)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return prop.description === undefined ? nullableBase.nullable() : nullableBase.nullable().describe(prop.description);
  }
  if (prop.anyOf !== undefined && prop.anyOf.length > 1) {
    const union = z.union(prop.anyOf.map((a) => zodTypeFor(a)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return prop.description === undefined ? union : union.describe(prop.description);
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

/** The router's own `InputShapeFactory`/`OfficialMcpModule` types name their schema/module params
 *  more loosely (`properties?: Record<string, unknown>`) than this file's own recursive shape needs
 *  to walk them — this is the ONE cast point, at the seam, rather than threading `unknown` through
 *  every recursive call above. */
/**
 * Lane 3b (P8d-17 root cause): this is ALSO the CONSTRUCTION-level `RuntimeSdkOptions.toInputShape`
 * bridge `create.ts` must forward — see that file's own `advisorFrom`-adjacent wiring. Exported (was
 * a private const) because without it, `deps.toInputShape` inside the router's own
 * `officialCapabilityServers` stays `undefined` forever and — since Winter's construction-level
 * `capabilities` list is `[]` on purpose (P8b-36, capability tools ride the PER-SESSION
 * `officialCapabilityServersFor` door instead) — the router's own early-return fires SILENTLY for
 * EVERY official-leg session: `winterMcpServerDescriptor` (the STANDING server — SendMessage,
 * ListAgents, ReadNotifications, advisor) is never built, and `officialToolAliases`'s redirect
 * targets (`mcp__<brand>__advisor`, etc.) never exist to redirect to. MEASURED (the real 0.3.250
 * binary, `test/runtime-sdk/official-leg.e2e.test.ts`'s P8d-17 test): the official leg's tool list
 * carries bare `SendMessage`/`ListAgents` — the underlying CLI's OWN native subagent-messaging
 * tools, untouched by Winter's canonical implementation — and NOTHING containing "advisor" or
 * "notification" at all, consistent with this diagnosis and not with a stripped/denied tool.
 */
export const routerInputShape: RouterInputShapeFactory = (schema) => jsonSchemaToZodShape(schema as unknown as JsonSchemaObject);

export type { OfficialMcpModule } from "@yanlinglabs/winter-runtime-sdk";

/** `{content, isError}`, unpacked from a `McpSdkServerConfigWithInstance` whose `instance` narrows
 *  to `WinterMcpServerInstance` — the ONLY shape `capabilities/server.ts` ever produces. */
function winterInstanceOf(config: McpSdkServerConfigWithInstance): WinterMcpServerInstance | undefined {
  return isWinterMcpServerInstance(config.instance) ? config.instance : undefined;
}

/**
 * ONE capability server's `McpSdkServerConfigWithInstance` (Winter's own, from
 * `buildCapabilitiesFor`) → the router's `WinterMcpServerDescriptor` shape, hand-built.
 *
 * `capabilityServerDescriptor`/`capabilityServerDescriptors` (the router's own converters for
 * exactly this shape) are declared in the installed 0.0.3's `official/mcp-descriptors.d.ts` but are
 * NOT re-exported from the package root (`dist/index.d.ts` re-exports `materializeOfficialMcpServer`
 * / `officialMcpServers` / `winterMcpServerDescriptor` — the STANDING server's builder, a different
 * function — /`canonicalToolNames`/`OFFICIAL_MATERIALIZATION_DROPS` from that module and nothing
 * else). Measured directly against the installed tarball. So this file builds the descriptor by
 * hand from the SAME `listTools()`/`callTool()` the Winter leg already calls — `handler` forwards
 * to `instance.callTool` verbatim, which is what keeps behaviour byte-identical on both legs even
 * without the router's own converter. `exposure`/`permissionClass` carry no meaning for a Winter
 * capability tool (Winter-native concepts for the STANDING server's own advisories); `"eager"`/
 * `"custom"` are inert placeholders `officialMcpServers` does not gate materialization on.
 */
function descriptorFromWinterConfig(config: McpSdkServerConfigWithInstance): WinterMcpServerDescriptor | undefined {
  const instance = winterInstanceOf(config);
  if (instance === undefined) return undefined;
  const tools: WinterMcpToolDescriptor[] = instance.listTools().map((def) => ({
    tool: def.name,
    description: def.description ?? "",
    inputSchema: def.inputSchema as unknown as WinterMcpToolDescriptor["inputSchema"],
    exposure: "eager",
    permissionClass: "custom",
    handler: async (args) => {
      const outcome = await instance.callTool(def.name, (args ?? {}) as Record<string, unknown>);
      return { content: outcome.content as Array<{ type: "text"; text: string }>, ...(outcome.isError === undefined ? {} : { isError: outcome.isError }) };
    },
  }));
  return { name: config.name, version: "1.0.0", tools };
}

/**
 * Builds the official leg's `mcpServers` from the SAME per-session record the Winter leg already
 * has (`buildCapabilitiesFor`'s `CapabilityServerRecord`) — through the router's OWN
 * `officialMcpServers` (router 0.0.3; fix round 1 deleted the hand-rolled `createSdkMcpServer`/
 * `tool` path checkpoint b used against the 0.0.2 export gap). Names stay `winter__<key>` (the
 * record's own keys, `capabilities/names.ts`'s `capabilityServerName`), so
 * `mcp__winter__<key>__<tool>` comes out the same canonical name on both legs (P8b-35/P8c-4) — the
 * hand-built descriptor's `name` is that same key.
 */
export function officialCapabilityServersFor(
  record: CapabilityServerRecord,
  module: RouterOfficialMcpModule,
  toInputShape: RouterInputShapeFactory = routerInputShape,
  brand: Pick<BrandProfile, "mcpServerName" | "processLabel" | "projectDirName"> = CORE_BRAND,
): Record<string, unknown> {
  const branchLabel = officialBranchLabel(brand);
  const out: Record<string, unknown> = {};
  for (const config of Object.values(record)) {
    const descriptor = descriptorFromWinterConfig(config);
    if (descriptor === undefined) continue;
    Object.assign(out, officialMcpServers({ descriptor, module, toInputShape, branchLabel }));
  }
  return out;
}
