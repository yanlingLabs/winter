import { canonicalHostJson as canonical } from "./host-code-json";
import * as runtime from "@yanlinglabs/winter-agent-runtime";
import type {
  Options,
  BrandProfile,
  PermissionResult,
  RuntimeAgentDefinition,
} from "@yanlinglabs/winter-agent-sdk";
import { createHash } from "node:crypto";
import type {
  HostCodeAuthority,
  HostCodeCall,
  HostCodeInvocation,
  HostCodePromptReceipt,
  HostCodeContext,
} from "./host-code-broker";
import { HostCodeUnavailable } from "./host-code-broker";

type Scope = HostCodeContext["scope"];
type Config = Pick<
  Options,
  | "permissionMode"
  | "permissions"
  | "allowedTools"
  | "disallowedTools"
  | "allowDangerouslySkipPermissions"
  | "additionalDirectories"
  | "sandbox"
>;
interface PermissionRequest {
  scope: Scope;
  toolName: string;
  input: Record<string, unknown>;
}
export interface CanonicalHostCodePolicy {
  config: Config;
  tools?: readonly string[];
  preparedDefinitions?: Readonly<Record<string, RuntimeAgentDefinition>>;
  env?: Record<string, string | undefined>;
  settingsRules?: unknown;
  sessionRoot: string;
  home: string;
  winterHome?: string;
  storeHome?: string;
  trustedWorkspace: boolean;
  brand: BrandProfile;
  outputsDir?: string;
  additionalDirectories?: readonly string[];
  /** Opaque host-owned source/grant identity: changes invalidate all existing receipts. */
  authorityRevision?: unknown;
  /** Supplied only by a host-owned reviewer; absence retains the SDK's normal policy behavior. */
  autoEngine?: unknown;
  hookStage?: unknown;
}
interface PermissionSnapshot extends CanonicalHostCodePolicy {
  scope: Omit<Scope, "toolUseId">;
  policyRevision: number;
  cwd: string;
}
interface Evaluator {
  recordPromptResult(
    receipt: PermissionRequest & {
      cwd: string;
      policyRevision: number;
      result: PermissionResult;
    },
  ): void;
  evaluate(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<{
    status: string;
    policyRevision: number;
    record?: { transformedInput?: Record<string, unknown> };
  }>;
  clearReceipts(): void;
  forgetCall?(
    scope: Pick<Scope, "generationId" | "sessionId" | "toolUseId">,
  ): void;
}
export interface HostCodePolicyAdapter {
  buildContext?(snapshot: PermissionSnapshot): Record<string, unknown>;
  create(input: {
    getCurrentSnapshot(request: PermissionRequest): PermissionSnapshot;
  }): Evaluator;
  settingsSeed(resolved: unknown, options: unknown): unknown;
  /** SDK-owned builtin/custom role resolution and inheritance; no Core approximation. */
  deriveDescendant?(
    policy: CanonicalHostCodePolicy,
    ancestors: readonly HostCodeCall[],
    toolName: string,
    revision: number,
  ): CanonicalHostCodePolicy;
}
export function installedHostCodePolicyAdapter():
  | HostCodePolicyAdapter
  | undefined {
  const api = runtime as unknown as Record<string, unknown>;
  if (
    typeof api.createHostCodePermissionEvaluator !== "function" ||
    typeof api.buildSettingsRuleSeed !== "function" ||
    typeof api.buildHostCodePermissionContext !== "function" ||
    typeof api.resolveHostCodeDescendantPolicy !== "function"
  )
    return undefined;
  return {
    create:
      api.createHostCodePermissionEvaluator as HostCodePolicyAdapter["create"],
    buildContext:
      api.buildHostCodePermissionContext as HostCodePolicyAdapter["buildContext"],
    deriveDescendant: (base, ancestors, toolName, revision) => {
      let policy = { ...base, config: structuredClone(base.config) },
        pool = [
          ...(base.tools ?? [
            "Bash",
            "Monitor",
            "Workflow",
            "Agent",
            "Task",
            "Read",
            "Glob",
            "Grep",
          ]),
        ] as string[],
        allowedAgentTypes: readonly string[] | undefined;
      const build = api.buildHostCodePermissionContext as (
        snapshot: unknown,
      ) => { policy: unknown };
      const derive = api.resolveHostCodeDescendantPolicy as (
        input: Record<string, unknown>,
      ) => {
        policy: { effectiveMode: Options["permissionMode"] };
        tools: string[];
        disallowedTools: string[];
        allowedAgentTypes?: string[];
      };
      for (const ancestor of [...ancestors].reverse()) {
        const agentType = ancestor.input.subagent_type;
        if (typeof agentType !== "string")
          throw new HostCodeUnavailable("host-agent-type-not-observed");
        const parent = build({
          ...policy,
          scope: { generationId: "host-policy", sessionId: "host-policy" },
          policyRevision: revision,
          cwd: policy.sessionRoot,
        }).policy;
        const child = derive({
          parent,
          parentTools: pool,
          preparedDefinitions: base.preparedDefinitions,
          agentType,
          mayNest: true,
          background: ancestor.input.run_in_background === true,
          fork: ancestor.input.fork === true,
          allowedAgentTypes,
          brand: base.brand,
          env: base.env ?? {},
          disableBypassPermissionsMode:
            policy.config.permissions?.disableBypassPermissionsMode === true,
        });
        pool = child.tools;
        allowedAgentTypes = child.allowedAgentTypes;
        policy = {
          ...policy,
          config: {
            ...policy.config,
            permissionMode: child.policy.effectiveMode,
            disallowedTools: [
              ...(policy.config.disallowedTools ?? []),
              ...child.disallowedTools,
            ],
          },
        };
      }
      if (!pool.includes(toolName))
        throw new HostCodeUnavailable("tool-outside-host-descendant-pool");
      return policy;
    },
    settingsSeed:
      api.buildSettingsRuleSeed as HostCodePolicyAdapter["settingsSeed"],
  };
}
/** One authority per prepared query. Every permission decision uses the SDK's actual evaluator;
 * no runtime-supplied approval/configuration, duplicate prompts or Core rule parser is involved. */
export class CanonicalHostCodeAuthority implements HostCodeAuthority {
  private revision = 0;
  private hash: string | undefined;
  private readonly calls = new Map<
    string,
    {
      scope: Scope;
      cwd: string;
      ancestors: readonly HostCodeCall[];
      preHookDecision?: HostCodeInvocation["preHookDecision"];
    }
  >();
  private readonly evaluator: Evaluator;
  constructor(
    private readonly input: {
      getPolicy(): CanonicalHostCodePolicy;
      adapter: HostCodePolicyAdapter;
      immutableWorkflowWorker?: HostCodeAuthority["immutableWorkflowWorker"];
    },
  ) {
    this.evaluator = input.adapter.create({
      getCurrentSnapshot: (request) => this.snapshot(request),
    });
    this.refresh();
  }
  private refresh(): CanonicalHostCodePolicy {
    const policy = this.input.getPolicy();
    const { autoEngine: _auto, hookStage: _hooks, ...facts } = policy;
    const hash = createHash("sha256").update(canonical(facts)).digest("hex");
    if (this.hash !== hash) {
      this.hash = hash;
      this.revision++;
      this.evaluator.clearReceipts();
    }
    return policy;
  }
  policyRevision(): string {
    this.refresh();
    return String(this.revision);
  }
  private snapshot(request: PermissionRequest): PermissionSnapshot {
    const binding = this.calls.get(request.scope.toolUseId);
    if (!binding || canonical(binding.scope) !== canonical(request.scope))
      throw new HostCodeUnavailable("permission-scope-not-host-bound");
    let policy = this.refresh();
    if (binding.ancestors.length) {
      if (!this.input.adapter.deriveDescendant)
        throw new HostCodeUnavailable(
          "host-descendant-policy-capability-missing",
        );
      policy = this.input.adapter.deriveDescendant(
        policy,
        binding.ancestors,
        request.toolName,
        this.revision,
      );
    }
    if (binding.preHookDecision) {
      const decision = structuredClone(binding.preHookDecision);
      policy = {
        ...policy,
        hookStage: {
          async preToolUse() {
            return decision;
          },
          async permissionRequest() {
            return null;
          },
        },
      };
    }
    return {
      ...policy,
      scope: { ...binding.scope },
      policyRevision: this.revision,
      cwd: binding.cwd,
    };
  }
  async authorize(
    invocation: HostCodeInvocation,
    cwd: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!invocation.scope)
      throw new HostCodeUnavailable("host-invocation-scope-missing");
    this.bind(
      invocation.scope,
      cwd,
      invocation.ancestors ?? [],
      invocation.preHookDecision,
    );
    const revision = this.policyRevision();
    const result = await this.evaluator.evaluate(
      {
        scope: invocation.scope,
        toolName: invocation.name,
        input: invocation.input,
      },
      signal,
    );
    return (
      !signal.aborted &&
      this.policyRevision() === revision &&
      String(result.policyRevision) === revision &&
      result.status === "allow" &&
      (!result.record?.transformedInput ||
        canonical(result.record.transformedInput) ===
          canonical(invocation.input))
    );
  }
  buildHookContext(
    invocation: HostCodeInvocation,
    cwd: string,
  ): Record<string, unknown> {
    if (!invocation.scope || !this.input.adapter.buildContext)
      throw new HostCodeUnavailable("host-hook-context-capability-missing");
    this.bind(invocation.scope, cwd, invocation.ancestors ?? []);
    return this.input.adapter.buildContext(
      this.snapshot({
        scope: invocation.scope,
        toolName: invocation.name,
        input: invocation.input,
      }),
    );
  }
  recordPromptResult(receipt: HostCodePromptReceipt): void {
    const scope: Scope = {
      generationId: receipt.generationId,
      sessionId: receipt.sessionId,
      toolUseId: receipt.toolUseId,
      ...(receipt.agentId === undefined ? {} : { agentId: receipt.agentId }),
      ...(receipt.threadId === "main"
        ? {}
        : { parentToolUseId: receipt.threadId }),
    };
    this.bind(
      scope,
      receipt.cwd,
      receipt.ancestors ?? [],
      receipt.preHookDecision,
    );
    if (receipt.policyRevision !== this.policyRevision())
      throw new HostCodeUnavailable("host-prompt-policy-stale");
    this.evaluator.recordPromptResult({
      scope,
      toolName: receipt.toolName,
      input: receipt.input,
      cwd: receipt.cwd,
      policyRevision: this.revision,
      result: receipt.result,
    });
  }
  private bind(
    scope: Scope,
    cwd: string,
    ancestors: readonly HostCodeCall[],
    preHookDecision?: HostCodeInvocation["preHookDecision"],
  ): void {
    this.calls.set(scope.toolUseId, {
      scope: { ...scope },
      cwd,
      ancestors: structuredClone(ancestors),
      ...(preHookDecision
        ? { preHookDecision: structuredClone(preHookDecision) }
        : {}),
    });
    if (this.calls.size > 1024) {
      const oldest = this.calls.keys().next().value!;
      this.forgetCall(oldest);
    }
  }
  forgetCall(callId: string): void {
    const call = this.calls.get(callId);
    if (call) this.evaluator.forgetCall?.(call.scope);
    this.calls.delete(callId);
  }
  dispose(): void {
    this.calls.clear();
    this.evaluator.clearReceipts();
  }
  immutableWorkflowWorker(runId: string, invocation: HostCodeInvocation) {
    return this.input.immutableWorkflowWorker?.(runId, invocation);
  }
}
