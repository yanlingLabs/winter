import { posix } from "node:path";
import { coworkGuestPolicyFor, coworkGuestRootFor, coworkOutputsOf, type CoworkRunBinding } from "./conversation-set";
import { CoworkPolicyTransitionMachine, type CoworkTransitionSnapshot } from "./policy-transition";
import { CoworkError, type CapabilityCeiling, type WorkspaceSource } from "./types";

/*
 * Cowork session door D3 (D3b: either location): the host ports the APPROVALS lane's projection reads for ONE conversation's
 * incarnation (the approval bridge's injected `cowork` dependency). Built only by the Cowork session driver, which production never constructs
 * (no provider route). The HOST decides every path's class here, from the conversation's own guest views; nothing the
 * guest says is consulted.
 *
 * The transition machine starts STABLE at the binding's real policy and effective ceiling (the policy the conversation set
 * does NOT carry: it sends plan or ask, `conversation-set.ts`). D3 has no policy-change path, so its ports refuse: a change
 * would have to close admission and install a view in the guest, which no slice provides yet.
 */

/** A path's class for the host policy matrix. Plain strings: this module names no matrix symbol. */
export type CoworkApprovalPathClass = "admitted" | "shared-instructions" | "outputs" | "scratch" | "planScratch" | "protected" | "outside";

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * The class of an absolute guest path for this conversation:
 *   - `admitted`: its root (the source's guest root plus its relative cwd) and below, and the memory root;
 *   - `shared-instructions`: the workspace guidance file;
 *   - `outputs` / `scratch`: its OWN outputs and scratch directories (O1, owner decision 2026-10-18);
 *   - `planScratch`: `/workspace/plan/<sid>/<epoch>` and below, for any segments (APPROVALS #112). The projection narrows it
 *     to the conversation's own session id at the CURRENT epoch (`planScratchEpoch`); every other plan path is `outside`
 *     there. `/workspace/plan` itself and a bare `/workspace/plan/<sid>` are `outside`;
 *   - `protected`: everything else under `/workspace/.winter` and `/workspace/outputs` (other conversations' stores,
 *     outputs and scratch, the skeleton), `/run/winter` (run homes, the provider socket) and `/workspace` itself;
 *   - `outside`: anything else, including the rest of the source above the cwd and the workspace's other sources.
 * A relative, empty or NUL-bearing path is `protected`.
 */
export function coworkClassifyGuestPath(path: string, input: { readonly sessionId: string; readonly root: string | null }): CoworkApprovalPathClass {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return "protected";
  const at = posix.normalize(path).replace(/\/+$/, "") || "/";
  // An outputs-located conversation (D3b) has no source root: its cwd IS its own outputs folder, which stays `outputs`.
  if (input.root !== null && under(at, input.root)) return "admitted";
  if (under(at, "/workspace/.winter/memory")) return "admitted";
  if (at === "/workspace/.winter/WINTER.md") return "shared-instructions";
  if (under(at, `/workspace/outputs/${input.sessionId}`)) return "outputs";
  if (under(at, `/workspace/.winter/scratch/${input.sessionId}`)) return "scratch";
  if (at.startsWith("/workspace/plan/") && at.split("/").length >= 5) return "planScratch";
  if (at === "/workspace" || under(at, "/workspace/.winter") || under(at, "/workspace/outputs") || under(at, "/run/winter")) return "protected";
  return "outside";
}

/**
 * The ports, structurally: the APPROVALS lane's own port type is named only by the approval bridge and its projection
 * (their wiring pin), so the driver hands this shape through `CoworkApprovalPort` and test/cowork/approval-ports.test.ts
 * proves it assignable to theirs at compile time.
 */
export interface CoworkHostApprovalPorts {
  identity(): { readonly workspaceId: string; readonly sourceRevision: number; readonly outputsFolder?: string };
  snapshot(): CoworkTransitionSnapshot;
  classifyPath(absolutePath: string): string;
  planViewInstalled(): boolean;
  /** The policy machine's CURRENT epoch: the plan scratch is `/workspace/plan/<sid>/<this epoch>`. */
  planScratchEpoch(): number | undefined;
}

export interface CoworkHostApprovalInput {
  /** A source binding, or a discriminated conversation of either location (D3b). */
  readonly binding: CoworkRunBinding;
  /** A source binding's admitted source (its revision is the card's source revision); absent for the outputs location,
   *  whose cards say source revision 0 (there is no source). */
  readonly source?: Readonly<WorkspaceSource>;
  /** The conversation's effective ceiling at admission (`CoworkAuthority.effectiveCapabilities`). */
  readonly ceiling: Readonly<CapabilityCeiling>;
  /** The plan execution view is MOUNTED for this incarnation: read-only roots AND a scratch view separate from (or scoped to
   *  the policy epoch of) the writable one (APPROVALS #84's NEED). No slice mounts it yet, so the driver passes nothing and
   *  `planViewInstalled` is false: plan's `allow-in-plan-view` calls are refused, never run in a writable view. */
  readonly planViewMounted?: boolean;
}

const refused = (): Promise<never> => Promise.reject(new CoworkError("unsupported_topology"));

export function coworkApprovalPortsFor(input: CoworkHostApprovalInput): CoworkHostApprovalPorts {
  const { binding, source } = input;
  // The cwd is validated for either location; only a source root is `admitted`.
  const cwd = coworkGuestRootFor(binding, source), root = coworkOutputsOf(binding) === undefined ? cwd : null;
  const ceiling: CapabilityCeiling = { toolClasses: [...input.ceiling.toolClasses], hostServices: [...input.ceiling.hostServices], connectors: [...input.ceiling.connectors], network: input.ceiling.network };
  const machine = new CoworkPolicyTransitionMachine({ policy: binding.policy, ceiling }, { closeAdmission: refused, drain: refused, installView: refused });
  const plan = coworkGuestPolicyFor(binding.policy) === "plan" && input.planViewMounted === true;
  // An outputs-located conversation's cards name its own outputs folder (APPROVALS #112 wording).
  const outputs = coworkOutputsOf(binding);
  const identity = Object.freeze({ workspaceId: binding.workspaceId, sourceRevision: source?.revision ?? 0, ...(outputs === undefined ? {} : { outputsFolder: cwd }) });
  return Object.freeze({
    identity: () => identity,
    snapshot: () => machine.snapshot(),
    classifyPath: (absolutePath: string) => coworkClassifyGuestPath(absolutePath, { sessionId: binding.sessionId, root }),
    // True only under plan AND with the plan view mounted (see `planViewMounted`).
    planViewInstalled: () => plan,
    planScratchEpoch: () => machine.snapshot().epoch,
  });
}
