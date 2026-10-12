import { COWORK_RPC, type CoworkMethod, type CoworkParams, type CoworkResult, type CoworkWorkspace, type CoworkWorkspacePolicy } from "@yanlinglabs/winter-protocol";
import type { WinterClient } from "./client";

export const COWORK_CLI_USAGE = `usage:
  winter workspace|project [list] [--limit N] [--cursor TOKEN] [--json]
  winter workspace|project get <id> [--json]
  winter workspace|project update <id> --title TEXT --revision N --request-id ID [--json]
  winter workspace source list <workspaceId> [--limit N] [--cursor TOKEN] [--revision N] [--json]
  winter workspace source get <workspaceId> <sourceId> [--json]
  winter workspace source remove|revoke <workspaceId> <sourceId> --revision N --request-id ID [--json]
  winter workspace source add-folder|add-repository <workspaceId> --selection-id ID --revision N --request-id ID [--json]
  winter workspace policy get <workspaceId> [--limit N] [--cursor TOKEN] [--revision N] [--json]
  winter workspace|project policy set-default <id> --policy POLICY --revision N --request-id ID [--json]
  winter workspace policy set-publication <workspaceId> --publication manual|github-only-feature-branches --revision N --request-id ID [--json]
  winter workspace policy set-ceiling <workspaceId> --ceiling-json JSON --revision N --request-id ID [--json]
  winter workspace operation get <workspaceId> <operationId> [--json]

Creation is unavailable. Source provisioning is gated by the daemon; add commands
accept an existing opaque host selection ID. This CLI does not issue selections.
POLICY: plan|dont-ask|ask|accept-edits|auto|bypass.`;

export interface CoworkCliRoute { method: CoworkMethod; params: CoworkParams<CoworkMethod>; json: boolean }
export type CoworkCliResult = CoworkResult<CoworkMethod>;
type Flags = Record<string, string | true>;
const visible = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Strict pre-connection parsing: no paths/grants, silently ignored options or invented defaults. */
export function parseCoworkArgs(surface: "workspace" | "project", args: string[]): CoworkCliRoute | { help: true } {
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!)) return { help: true };
  const flags: Flags = {}, positions: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) { positions.push(argument); continue; }
    const equals = argument.indexOf("="), word = equals < 0 ? argument : argument.slice(0, equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    if (Object.hasOwn(flags, word)) throw new Error(`Duplicate option ${word}`);
    if (word === "--json") {
      if (inline !== undefined) throw new Error("--json does not accept a value");
      flags[word] = true; continue;
    }
    const value = inline ?? args[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`Missing value for ${word}`);
    flags[word] = value;
  }
  const [verb = "list", sub, id, extra] = positions;
  let method: CoworkMethod, params: Record<string, unknown>, allowed: string[];
  const identity = (value?: string) => surface === "project" ? { projectId: value } : { workspaceId: value };
  const number = (flag: string) => {
    const value = flags[flag];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} must be a positive integer`);
    return Number(value);
  };
  const page = () => ({ cursor: flags["--cursor"], limit: number("--limit"), expectedRevision: number("--revision") });
  const mutation = () => ({ requestId: flags["--request-id"], expectedRevision: number("--revision") });
  const arity = (count: number) => { if (positions.length !== count) throw new Error("Unexpected or missing positional arguments"); };
  if (verb === "list") {
    if (positions.length > 1) throw new Error("list takes no positional arguments");
    method = surface === "project" ? "project.list" : "workspace.list";
    params = { cursor: flags["--cursor"], limit: number("--limit") }; allowed = ["--cursor", "--limit"];
  } else if (verb === "get") {
    arity(2); method = surface === "project" ? "project.get" : "workspace.get"; params = identity(sub); allowed = [];
  } else if (verb === "update") {
    arity(2); method = surface === "project" ? "project.update" : "workspace.update"; params = { ...identity(sub), ...mutation(), title: flags["--title"] }; allowed = ["--title", "--revision", "--request-id"];
  } else if (verb === "source" && surface === "workspace") {
    allowed = sub === "list" ? ["--cursor", "--limit", "--revision"] : sub === "get" ? [] : ["--revision", "--request-id"];
    if (sub === "list") { arity(3); method = "workspace.source.list"; params = { workspaceId: id, ...page() }; }
    else if (sub === "get") { arity(4); method = "workspace.source.get"; params = { workspaceId: id, sourceId: extra }; }
    else if (sub === "remove" || sub === "revoke") { arity(4); method = sub === "revoke" ? "workspace.source.revoke" : "workspace.source.remove"; params = { workspaceId: id, sourceId: extra, ...mutation() }; }
    else if (sub === "add-folder" || sub === "add-repository") {
      arity(3); method = sub === "add-folder" ? "workspace.source.addFolder" : "workspace.source.addRepository"; params = { workspaceId: id, selectionId: flags["--selection-id"], ...mutation() }; allowed.push("--selection-id");
    } else throw new Error("Unknown workspace source command");
  } else if (verb === "policy") {
    allowed = sub === "get" ? ["--cursor", "--limit", "--revision"] : ["--revision", "--request-id"];
    arity(3);
    if (sub === "get" && surface === "workspace") { method = "workspace.policy.get"; params = { workspaceId: id, ...page() }; }
    else if (sub === "set-default") { method = surface === "project" ? "project.setDefaultPolicy" : "workspace.setDefaultPolicy"; params = { ...identity(id), ...mutation(), defaultPolicy: flags["--policy"] }; allowed.push("--policy"); }
    else if (sub === "set-publication" && surface === "workspace") { method = "workspace.setPublicationPolicy"; params = { workspaceId: id, ...mutation(), publication: flags["--publication"] }; allowed.push("--publication"); }
    else if (sub === "set-ceiling" && surface === "workspace") {
      method = "workspace.setCapabilityCeiling"; let ceiling: unknown;
      try { ceiling = JSON.parse(String(flags["--ceiling-json"])); } catch { throw new Error("--ceiling-json must contain a complete capability ceiling JSON object"); }
      params = { workspaceId: id, ...mutation(), ceiling }; allowed.push("--ceiling-json");
    } else throw new Error("Unknown workspace/Project policy command; use workspace policy get with the workspace ID for details");
  } else if (verb === "operation" && sub === "get" && surface === "workspace") {
    arity(4); method = "workspace.operation.get"; params = { workspaceId: id, operationId: extra }; allowed = [];
  } else if (verb === "create") throw new Error("Cowork creation is unavailable; production provisioning and host selection issuance remain gated");
  else throw new Error("Unknown workspace/Project command");
  for (const flag of Object.keys(flags)) if (flag !== "--json" && !allowed.includes(flag)) throw new Error(`Unsupported option ${flag}`);
  const result = COWORK_RPC[method].params.safeParse(params);
  if (!result.success) throw new Error(`Invalid arguments: ${result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
  return { method, params: result.data, json: flags["--json"] === true };
}

export async function runCoworkRoute(client: Pick<WinterClient, "cowork">, route: CoworkCliRoute): Promise<CoworkCliResult> {
  return client.cowork(route.method, route.params);
}

function policyLines(policy: CoworkWorkspacePolicy) {
  return [`Default policy: ${policy.defaultPolicy}`, `Publication policy: ${policy.publication}`, `Network ceiling: ${policy.ceiling.network}`,
    `Tool classes: ${visible(JSON.stringify(policy.ceiling.toolClasses))}`, `Host services: ${visible(JSON.stringify(policy.ceiling.hostServices))}`, `Connectors: ${visible(JSON.stringify(policy.ceiling.connectors))}`];
}
function workspaceLines(value: CoworkWorkspace): string[] {
  const lines = [`${value.workspaceId} · ${value.ownership} ${value.ownerId} · ${visible(value.title)}`, `State: ${value.state}; power: ${value.power}; configuration revision: ${value.configRevision}`, `Automatic publication default: ${value.automaticPublication ? "enabled" : "disabled"}`];
  if (value.detailState === "summary") {
    lines.push(`Details: summary (${value.detailReason}); ${value.sourceCount} source(s)`, `Default policy: ${value.policySummary.defaultPolicy}; publication: ${value.policySummary.publication}; network: ${value.policySummary.network}`,
      `Capability details omitted; counts: ${JSON.stringify(value.policySummary.capabilityCounts)}`, `Read details: winter workspace source list ${value.workspaceId}; winter workspace policy get ${value.workspaceId} --revision ${value.policySummary.revision}`);
  } else lines.push("Details: complete", ...policyLines(value.policy), ...value.sources.map(source => `Source ${source.sourceId}: ${visible(source.label)} · ${source.state} · ${source.desired} · ${source.access}`));
  return lines;
}

export function formatCoworkResult(route: CoworkCliRoute, result: CoworkCliResult): string[] {
  if (route.json) return [JSON.stringify(result, null, 2)];
  if ("workspaces" in result) return [...(result.workspaces.length ? result.workspaces.flatMap(workspaceLines) : ["(no workspaces)"]), ...(result.nextCursor ? [`Next cursor: ${result.nextCursor}`] : [])];
  if ("projects" in result) return [...(result.projects.length ? result.projects.flatMap(project => workspaceLines(project.workspace)) : ["(no Projects)"]), ...(result.nextCursor ? [`Next cursor: ${result.nextCursor}`] : [])];
  if ("workspace" in result) return workspaceLines(result.workspace);
  if ("ownership" in result) return workspaceLines(result);
  if ("operationId" in result) {
    if ("value" in result) {
      const lines = [`Operation ${result.operationId} recorded at configuration revision ${result.revision}; guest effects are not confirmed`, `Check: winter workspace operation get ${result.workspaceId} ${result.operationId}`], value = result.value;
      if ("detailState" in value && value.detailState === "summary") lines.push(`Policy details: summary (${value.detailReason}); publication: ${value.policySummary.publication}; network: ${value.policySummary.network}`, `Capability details omitted; counts: ${JSON.stringify(value.policySummary.capabilityCounts)}`, `Read: winter workspace policy get ${result.workspaceId} --revision ${value.policySummary.revision}`);
      else if ("ceiling" in value) lines.push(...policyLines(value));
      else if ("sourceId" in value) lines.push(`Source ${value.sourceId}: ${value.state} · ${value.desired}`);
      else if ("title" in value) lines.push(`Title: ${visible(value.title)}`);
      return lines;
    }
    return [`Operation ${result.operationId}: ${result.status}; terminal: ${result.terminal}; configuration revision: ${result.revision}`];
  }
  if ("entries" in result) return [`Policy ${result.policy.policyId}; revision: ${result.policy.revision}; default: ${result.policy.defaultPolicy}; publication: ${result.policy.publication}; network: ${result.policy.network}`, `Capability counts: ${JSON.stringify(result.policy.capabilityCounts)}`, ...result.entries.map(entry => `${entry.kind}: ${visible(entry.name)}`), ...(result.nextCursor ? [`Next cursor: ${result.nextCursor}`] : [])];
  if ("sources" in result) return [...(result.sources.length ? result.sources.map(source => `${source.sourceId}: ${visible(source.label)} · ${source.state} · ${source.desired} · ${source.access}`) : ["(no sources on this page)"]), ...(result.nextCursor ? [`Next cursor: ${result.nextCursor}`] : [])];
  if ("sourceId" in result) return [`${result.sourceId}: ${visible(result.label)} · ${result.state} · ${result.desired} · ${result.access}; source revision: ${result.revision}`];
  throw new Error("Unsupported Cowork result");
}

export function coworkErrorMessage(error: unknown): string {
  const data = (error as { rpc?: { data?: { code?: unknown; currentRevision?: unknown } } } | null)?.rpc?.data;
  const code = typeof data?.code === "string" ? data.code : undefined;
  const revision = typeof data?.currentRevision === "number" && Number.isSafeInteger(data.currentRevision) && data.currentRevision > 0 ? data.currentRevision : undefined;
  const note = code === "unsupported_topology" ? "Provisioning is blocked by the host integration gates." : code === "stale_cursor" ? "Visible details changed; restart pagination without --cursor." : code === "revision_conflict" ? `Refresh the record and retry with its current revision${revision === undefined ? "." : ` (${revision}).`}` : code === "request_conflict" ? "This request ID already records different arguments; use its original arguments or a new request ID for a new change." : code === "authority_denied" ? "Current host authority refused the request." : undefined;
  const message = error instanceof Error ? error.message : "Cowork command failed";
  return `${visible(message)}${code ? ` [${visible(code)}]` : ""}${note ? ` ${note}` : ""}`;
}
