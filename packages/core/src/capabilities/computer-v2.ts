// The `computer_v2` capability server (ComputerV2, 2026-10-08) — ONE tool, `script`, shown to the model as
// `ComputerV2`: JavaScript the model writes against ready-made functions, run in the session's sandboxed
// automation worker, every function a daemon-checked call (`computer-use/service.ts`).
//
//  - code + dispatch only, deferred in both (`WINTER_CAPABILITY_TOOLS`); built only while computer use is on and
//    `computerUse.legacyComputer` is not set (`index.ts`) — never beside the old `computer`.
//  - CONCURRENCY-SAFE WITH NO LANE: the daemon's per-target locks replace the lane.
//  - the DESCRIPTION is generated per incarnation from the session's model: without image input there is no
//    `screenshot`, `show` or `Point` (`computer-use/description.ts`).
//  - the RESULT is built by the daemon — ordered text and images, capped, fenced when the screen was read —
//    and travels as `ToolRunResult.content`, which `server.ts` hands over as MCP content in that order.
//  - no card per script (R16): the call itself is allowed under every policy (`gate.ts`'s SELF_GATED, the
//    `computerV2AllowHook`); the policy is per APP, inside the call (`computer-use/policy.ts`).
import type { McpSdkServerConfigWithInstance } from "@yanlinglabs/winter-agent-sdk";
import { z } from "zod";
import type { ToolDefinition } from "../agent/tools/registry";
import { imagesAcceptedBy, rowForTag } from "../runtime-sdk/provider-selection";
import { WINTER_TEST_PREFIX } from "../runtime-sdk/model-tag";
import { COMPUTER_V2_INPUT_SCHEMA, computerV2Description } from "../computer-use/description";
import type { ScriptCall, ScriptInput, ScriptResult } from "../computer-use/service";
import { capabilityServer, type CapabilitySession } from "./server";

export interface ComputerV2CapabilityDeps {
  /** The daemon's one `ComputerV2Service` (absent: the tool answers that ComputerV2 is not available here). */
  service?: { run(call: ScriptCall, input: ScriptInput): Promise<ScriptResult> };
}

/** Does `model` accept images? A `winter-test/*` double and an unknown model read as yes (not a block). */
export function visionFor(model: string | undefined): boolean {
  if (model === undefined || model.startsWith(WINTER_TEST_PREFIX)) return true;
  const row = rowForTag(model);
  return row === undefined ? true : imagesAcceptedBy(row);
}

const ARGS = z.object({
  code: z.string(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  reset: z.boolean().optional(),
  title: z.string().max(80).optional(),
}).strict();

export function computerV2ToolDefs(session: Pick<CapabilitySession, "sessionId" | "model">, deps: ComputerV2CapabilityDeps): ToolDefinition[] {
  const vision = visionFor(session.model);
  const def: ToolDefinition<typeof ARGS> = {
    name: "script",
    description: computerV2Description({ vision }),
    args: ARGS,
    rawParameters: COMPUTER_V2_INPUT_SCHEMA,
    modes: ["code", "dispatch"],
    async run(args, ctx) {
      const service = deps.service;
      if (service === undefined) return { output: "ComputerV2 is not available in this daemon.", isError: true };
      const result = await service.run(
        { sessionId: ctx.sessionId, vision, ...(session.model === undefined ? {} : { model: session.model }), ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) },
        { code: args.code, ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }), ...(args.reset === undefined ? {} : { reset: args.reset }), ...(args.title === undefined ? {} : { title: args.title }) },
      );
      // `output` is the plain-text view (logs, a caller that reads only text); `content` is what the model gets.
      const output = result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("");
      return { output, content: result.content, isError: result.isError };
    },
  };
  return [def as unknown as ToolDefinition];
}

export function computerV2Capability(session: CapabilitySession, deps: ComputerV2CapabilityDeps): McpSdkServerConfigWithInstance {
  return capabilityServer({ key: "computer_v2", defs: computerV2ToolDefs(session, deps) }, session);
}
