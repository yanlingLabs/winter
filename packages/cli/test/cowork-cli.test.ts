import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COWORK_RPC, type CoworkMethod } from "@yanlinglabs/winter-protocol";
import { startDaemon, FileSecretStore, type RunningDaemon } from "@yanlinglabs/winter-core";
import { CoworkRepository } from "../../core/src/cowork/repository";
import { runtimeStateOnline } from "../../core/src/runtime-state/wiring";
import { WinterClient } from "../src/client";
import { COWORK_CLI_USAGE, parseCoworkArgs, runCoworkRoute, formatCoworkResult, coworkErrorMessage, type CoworkCliRoute } from "../src/cowork-cli";

const ceiling = { toolClasses: ["read"], hostServices: [], connectors: [], network: "none" as const };
const policy = { policyId: "policy-fixture", workspaceId: "workspace-fixture", defaultPolicy: "plan" as const, publication: "manual" as const, ceiling, revision: 2, defaultRevision: 1, publicationRevision: 2 };
const full = COWORK_RPC["workspace.get"].result.parse({ workspaceId: "workspace-fixture", ownership: "project", ownerId: "project-fixture", title: "Fixture", state: "retained", configRevision: 3, grantRevision: 2, instructionRevision: 1, leaseEpoch: 0, power: "stopped", createdAt: "2026-10-11", updatedAt: "2026-10-11", detailState: "complete", policy, sources: [], automaticPublication: false });
const policySummary = { policyId: policy.policyId, workspaceId: policy.workspaceId, defaultPolicy: policy.defaultPolicy, publication: policy.publication, revision: policy.revision, defaultRevision: policy.defaultRevision, publicationRevision: policy.publicationRevision, network: "none" as const, capabilityCounts: { toolClasses: 256, hostServices: 256, connectors: 256 } };
const summary = COWORK_RPC["workspace.get"].result.parse({ workspaceId: full.workspaceId, ownership: full.ownership, ownerId: full.ownerId, title: full.title, state: full.state, configRevision: full.configRevision, grantRevision: full.grantRevision, instructionRevision: full.instructionRevision, leaseEpoch: full.leaseEpoch, power: full.power, createdAt: full.createdAt, updatedAt: full.updatedAt, automaticPublication: false, detailState: "summary", detailReason: "response_limit", policySummary, sourceCount: 22, detailMethods: { sources: "workspace.source.list", policy: "workspace.policy.get" } });
function route(surface: "workspace" | "project", args: string[]): CoworkCliRoute {
  const parsed = parseCoworkArgs(surface, args); if ("help" in parsed) throw new Error("expected command"); return parsed;
}
const mutate = ["--revision", "3", "--request-id", "request-fixture"];

describe("Cowork CLI pre-connection parser", () => {
  test("defaults to a bounded list and has socket-free help", () => {
    expect(route("workspace", [])).toEqual({ method: "workspace.list", params: { limit: 100 }, json: false });
    expect(route("project", ["list", "--limit", "2", "--cursor", "workspace-cursor", "--json"])).toEqual({ method: "project.list", params: { limit: 2, cursor: "workspace-cursor" }, json: true });
    expect(parseCoworkArgs("workspace", ["--help"])).toEqual({ help: true });
    expect(COWORK_CLI_USAGE).toContain("Creation is unavailable"); expect(COWORK_CLI_USAGE).toContain("opaque host selection ID");
  });
  test("routes every supported read and mutation to the canonical typed RPC", () => {
    const cases: ["workspace" | "project", string[], CoworkMethod][] = [
      ["workspace", ["get", "workspace-fixture"], "workspace.get"], ["project", ["get", "project-fixture"], "project.get"],
      ["workspace", ["update", "workspace-fixture", "--title", "Updated", ...mutate], "workspace.update"], ["project", ["update", "project-fixture", "--title", "Updated", ...mutate], "project.update"],
      ["workspace", ["source", "list", "workspace-fixture", "--revision", "3", "--cursor", "opaque", "--limit", "5"], "workspace.source.list"],
      ["workspace", ["source", "get", "workspace-fixture", "source-fixture"], "workspace.source.get"],
      ["workspace", ["source", "remove", "workspace-fixture", "source-fixture", ...mutate], "workspace.source.remove"],
      ["workspace", ["source", "revoke", "workspace-fixture", "source-fixture", ...mutate], "workspace.source.revoke"],
      ["workspace", ["source", "add-folder", "workspace-fixture", "--selection-id", "folder-choice", ...mutate], "workspace.source.addFolder"],
      ["workspace", ["source", "add-repository", "workspace-fixture", "--selection-id", "repo-choice", ...mutate], "workspace.source.addRepository"],
      ["workspace", ["policy", "get", "workspace-fixture", "--revision", "2"], "workspace.policy.get"],
      ["workspace", ["policy", "set-default", "workspace-fixture", "--policy", "ask", ...mutate], "workspace.setDefaultPolicy"],
      ["project", ["policy", "set-default", "project-fixture", "--policy", "ask", ...mutate], "project.setDefaultPolicy"],
      ["workspace", ["policy", "set-publication", "workspace-fixture", "--publication", "manual", ...mutate], "workspace.setPublicationPolicy"],
      ["workspace", ["policy", "set-ceiling", "workspace-fixture", "--ceiling-json", JSON.stringify(ceiling), ...mutate], "workspace.setCapabilityCeiling"],
      ["workspace", ["operation", "get", "workspace-fixture", "operation-fixture"], "workspace.operation.get"],
    ];
    for (const [surface, args, method] of cases) { const parsed = route(surface, args); expect(parsed.method).toBe(method); expect(COWORK_RPC[parsed.method].params.safeParse(parsed.params).success).toBe(true); }
    expect(route("project", ["policy", "set-default", "project-fixture", "--policy", "plan", ...mutate]).params).toEqual({ projectId: "project-fixture", requestId: "request-fixture", expectedRevision: 3, defaultPolicy: "plan" });
  });
  test("requires explicit mutation identity/revision and refuses unexpected, duplicate or malformed inputs", () => {
    for (const args of [["update", "workspace-fixture", "--title", "New"], ["update", "workspace-fixture", "--title", "New", "--revision", "3"], ["list", "extra"], ["get", "workspace-fixture", "--path", "/private"], ["list", "--limit", "0"], ["list", "--limit", "100.5"], ["list", "--limit", "101"], ["list", "--limit", "2", "--limit", "3"], ["get", "workspace-fixture", "--json", "--json"], ["list", "--cursor"], ["source", "add-folder", "workspace-fixture", "--selection-id", "/private", ...mutate]]) expect(() => route("workspace", args)).toThrow();
    expect(() => route("workspace", ["create"])).toThrow("creation is unavailable");
    expect(() => route("project", ["source", "list", "project-fixture"])).toThrow();
    expect(() => route("workspace", ["policy", "set-ceiling", "workspace-fixture", "--ceiling-json", '{"toolClasses":[]}', ...mutate])).toThrow();
  });
  test("inline flag values preserve option-shaped titles and reject ambiguous duplicates", () => {
    expect(route("workspace", ["update", "workspace-fixture", "--title=--draft", "--revision=3", "--request-id=request-fixture"]).params)
      .toEqual({ workspaceId: "workspace-fixture", title: "--draft", expectedRevision: 3, requestId: "request-fixture" });
    expect(() => route("workspace", ["list", "--limit=2", "--limit", "3"])).toThrow("Duplicate option --limit");
    expect(() => route("workspace", ["list", "--json=true"])).toThrow("--json does not accept a value");
    expect(() => route("workspace", ["update", "workspace-fixture", "--title=", ...mutate])).toThrow("Invalid arguments");
  });
  test("opaque source selections and complete ceilings cannot accept raw authority fields", () => {
    const added = route("workspace", ["source", "add-repository", "workspace-fixture", "--selection-id", "repo-choice", ...mutate]);
    expect(added.params).toEqual({ workspaceId: "workspace-fixture", requestId: "request-fixture", expectedRevision: 3, selectionId: "repo-choice" });
    expect(() => route("workspace", ["source", "add-folder", "workspace-fixture", "--selection-id", "folder-choice", "--grant-ref", "private-grant-handle", ...mutate])).toThrow("Unsupported option --grant-ref");
    try { route("workspace", ["policy", "set-ceiling", "workspace-fixture", "--ceiling-json", JSON.stringify({ ...ceiling, grantRef: "private-grant-handle" }), ...mutate]); throw new Error("expected rejection"); }
    catch (error) { expect((error as Error).message).not.toContain("private-grant-handle"); }
  });
});

describe("Cowork CLI result and retry/refusal output", () => {
  test("complete results show actual capabilities, summaries show omissions and scoped recovery", () => {
    const parsed = route("workspace", ["get", "workspace-fixture"]);
    const complete = formatCoworkResult(parsed, full).join("\n"), limited = formatCoworkResult(parsed, summary).join("\n");
    expect(complete).toContain('Tool classes: ["read"]'); expect(complete).toContain("Details: complete");
    expect(limited).toContain("22 source(s)"); expect(limited).toContain("Capability details omitted"); expect(limited).toContain('"toolClasses":256');
    expect(limited).toContain("winter workspace policy get workspace-fixture --revision 2"); expect(limited).not.toContain("Tool classes: []");
    expect(limited).toContain("Automatic publication default: disabled"); expect(limited).not.toContain("blocked");
    const asJson = JSON.parse(formatCoworkResult({ ...parsed, json: true }, summary)[0]!);
    expect(asJson.detailState).toBe("summary"); expect(asJson.policy).toBeUndefined(); expect(asJson).toEqual(summary);
    const unsafe = COWORK_RPC["workspace.get"].result.parse({ ...summary, title: "Fixture\u001b[2J" });
    expect(formatCoworkResult(parsed, unsafe).join("\n")).toContain("Fixture\\u001b[2J"); expect(formatCoworkResult(parsed, unsafe).join("\n")).not.toContain("\u001b");
  });
  test("human output makes bidi and invisible controls visible without changing JSON values", () => {
    const parsed = route("workspace", ["get", "workspace-fixture"]);
    const controls = "\u061c\u180e\u200e\u200f\u202e\u2060\u2066\u2069\ufeff";
    const unsafe = COWORK_RPC["workspace.get"].result.parse({ ...full, title: `Title${controls}`, policy: { ...policy, ceiling: { ...ceiling, toolClasses: [`read${controls}`] } } });
    const lines = formatCoworkResult(parsed, unsafe).join("\n");
    for (const control of controls) {
      expect(lines).not.toContain(control);
      expect(lines).toContain(`\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`);
      expect(coworkErrorMessage(new Error(`refused${control}`))).not.toContain(control);
    }
    expect(JSON.parse(formatCoworkResult({ ...parsed, json: true }, unsafe)[0]!)).toEqual(unsafe);
  });
  test("paged source/policy results retain continuation cursors and operation summaries remain explicit", () => {
    const sources = formatCoworkResult(route("workspace", ["source", "list", "workspace-fixture"]), { sources: [], nextCursor: "opaque-cursor" });
    expect(sources).toContain("Next cursor: opaque-cursor");
    const page = formatCoworkResult(route("workspace", ["policy", "get", "workspace-fixture"]), { policy: policySummary, entries: [{ kind: "toolClasses", name: "read" }], nextCursor: "opaque-policy" });
    expect(page).toContain("toolClasses: read"); expect(page).toContain("Next cursor: opaque-policy");
    const receipt = COWORK_RPC["workspace.setPublicationPolicy"].result.parse({ operationId: "operation-fixture", workspaceId: "workspace-fixture", revision: 3, value: { detailState: "summary", detailReason: "response_limit", policySummary, detailMethod: "workspace.policy.get" } });
    const lines = formatCoworkResult(route("workspace", ["policy", "set-publication", "workspace-fixture", "--publication", "manual", ...mutate]), receipt).join("\n");
    expect(lines).toContain("Policy details: summary"); expect(lines).toContain("Capability details omitted"); expect(lines).toContain("winter workspace operation get workspace-fixture operation-fixture"); expect(lines).not.toContain("ready");
  });
  test("typed errors separate blocked provisioning, stale pages, revision conflicts and refused authority", () => {
    const err = (code: string, currentRevision?: number) => Object.assign(new Error("Cowork request refused"), { rpc: { data: { code, currentRevision } } });
    expect(coworkErrorMessage(err("unsupported_topology"))).toContain("Provisioning is blocked");
    expect(coworkErrorMessage(err("stale_cursor"))).toContain("restart pagination without --cursor");
    expect(coworkErrorMessage(err("revision_conflict", 8))).toContain("current revision (8)");
    expect(coworkErrorMessage(err("request_conflict"))).toContain("original arguments or a new request ID");
    expect(coworkErrorMessage(err("authority_denied"))).toContain("Current host authority refused");
    expect(coworkErrorMessage(new Error("connection closed"))).toBe("connection closed");
  });
  test("the command runner makes one typed call and never retries or invents authority", async () => {
    const parsed = route("workspace", ["source", "revoke", "workspace-fixture", "source-fixture", ...mutate]); const calls: unknown[] = [];
    const error = Object.assign(new Error("refused"), { rpc: { data: { code: "revision_conflict", currentRevision: 4 } } });
    const client = { cowork: async (...args: unknown[]) => { calls.push(args); throw error; } };
    await expect(runCoworkRoute(client, parsed)).rejects.toBe(error); expect(calls).toEqual([[parsed.method, parsed.params]]);
  });
});

let daemon: RunningDaemon | undefined; const homes: string[] = [], clients: WinterClient[] = [];
afterEach(async () => { clients.splice(0).forEach(client => client.close()); if (daemon) { await daemon.stop(); daemon = undefined; } homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); });
async function boot() {
  const home = mkdtempSync(join(tmpdir(), "winter-cowork-cli-")); homes.push(home);
  daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "secrets")), agentProvider: null });
  const records = new CoworkRepository(runtimeStateOnline(daemon.runtimeState)!.db);
  const client = await WinterClient.connect({ socketPath: daemon.socketPath, token: daemon.tokens.harness, clientName: "cowork-cli-fixture", onEvent: () => {} }); clients.push(client);
  return { records, client };
}
describe("typed Cowork CLI against a private daemon with disabled production provisioning", () => {
  test("actual command help and invalid arguments exit before connection, home creation or autolaunch", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-cowork-help-")); homes.push(home);
    for (const [args, expected, output] of [[["workspace", "--help"], 0, "Creation is unavailable"], [["project", "update", "project-fixture"], 1, "Invalid arguments"], [["workspace", "create"], 1, "creation is unavailable"]] as const) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), ...args], { env: { ...process.env, WINTER_HOME: home, WINTER_NO_AUTOLAUNCH: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(expected); expect(stdout + stderr).toContain(output); expect(readdirSync(home)).toEqual([]);
    }
  });
  test("source/detail pages, metadata mutation and exact retry use the canonical RPCs", async () => {
    const { records, client } = await boot();
    const made = records.create({ principalId: "fixture-seed", requestId: "fixture" }, { ownership: "project", title: "Fixture", sources: [{ kind: "githubRepository", label: "Fixture repository", access: "read-write", detail: { repositoryId: "private-repository-id", authorityRef: "private-authority-ref", initialRef: "main" } }], ceiling }), workspaceId = made.workspaceId;
    const get = route("workspace", ["get", workspaceId, "--json"]), snapshot = await runCoworkRoute(client, get);
    expect(JSON.stringify(snapshot)).not.toContain("private-authority-ref"); expect(JSON.stringify(snapshot)).not.toContain("private-repository-id");
    const sources = await runCoworkRoute(client, route("workspace", ["source", "list", workspaceId, "--limit", "1"])); expect("sources" in sources && sources.sources[0]!.state).toBe("preparing");
    const title = route("project", ["update", made.value.workspace.ownerId, "--title", "Updated", "--revision", "1", "--request-id", "rename"]);
    const changed = await runCoworkRoute(client, title); expect(await runCoworkRoute(client, title)).toEqual(changed); expect(records.get(workspaceId).title).toBe("Updated");
    const narrowed = route("workspace", ["policy", "set-publication", workspaceId, "--publication", "manual", "--revision", "2", "--request-id", "publication-off"]);
    const receipt = await runCoworkRoute(client, narrowed); expect("value" in receipt && "detailState" in receipt.value && receipt.value.detailState).toBe("complete");
    expect(records.policy(workspaceId).publication).toBe("manual");
    await expect(runCoworkRoute(client, route("workspace", ["source", "add-repository", workspaceId, "--selection-id", "opaque-choice", "--revision", "3", "--request-id", "add"]))).rejects.toMatchObject({ rpc: { data: { code: "unsupported_topology" } } });
    expect(records.sources(workspaceId)).toHaveLength(1);
  });
  test("legacy summary pages and narrow policy receipts remain typed; malformed results are rejected", async () => {
    const { records, client } = await boot(), names = Array.from({ length: 256 }, (_value, index) => `${index}-` + "x".repeat(187));
    const large = { toolClasses: names, hostServices: names, connectors: names, network: "internet" as const };
    const made = records.create({ principalId: "fixture-seed", requestId: "legacy" }, { ownership: "project", title: "Legacy", sources: [{ kind: "githubRepository", label: "Fixture", access: "read-write", detail: { repositoryId: "private-repo", authorityRef: "private-account", initialRef: "main" } }], ceiling: large }), workspaceId = made.workspaceId;
    const snapshot = await client.cowork("workspace.get", { workspaceId }); expect(snapshot.detailState).toBe("summary");
    const page = await client.cowork("workspace.policy.get", { workspaceId, limit: 1 }); expect(page.entries).toHaveLength(1); expect(page.nextCursor).toStartWith("policy:");
    const narrowed = await runCoworkRoute(client, route("workspace", ["policy", "set-ceiling", workspaceId, "--ceiling-json", JSON.stringify({ ...large, network: "none" }), "--revision", "1", "--request-id", "network-off"]));
    expect("value" in narrowed && "detailState" in narrowed.value && narrowed.value.detailState).toBe("summary"); expect(records.policy(workspaceId).ceiling.network).toBe("none");
    // The typed client validates on both sides of its request boundary; no malformed caller
    // authority is sent, and a server response cannot silently supply an empty summary grant.
    await expect(client.cowork("workspace.get", { workspaceId, grantRef: "forged" } as never)).rejects.toThrow();
    const fake = Object.create(WinterClient.prototype) as WinterClient;
    Object.assign(fake, { request: async () => ({ ...summary, policy: { ceiling: {} } }) });
    await expect(fake.cowork("workspace.get", { workspaceId })).rejects.toThrow("invalid result from server");
  });
});

test("workspace schedule metadata CLI is strict, bounded and never accepts a guest cwd", () => {
  expect(parseCoworkArgs("workspace", ["schedule", "list", "workspace-one", "--limit", "10"])).toMatchObject({ method: "workspace.schedule.list", params: { workspaceId: "workspace-one", limit: 10 } });
  expect(parseCoworkArgs("workspace", ["schedule", "status", "workspace-one", "schedule-one"])).toMatchObject({ method: "workspace.schedule.status", params: { workspaceId: "workspace-one", scheduleId: "schedule-one" } });
  expect(parseCoworkArgs("workspace", ["schedule", "cancel", "workspace-one", "schedule-one", "--revision", "1"])).toMatchObject({ method: "workspace.schedule.cancel", params: { expectedRevision: 1 } });
  const definition = { target: { kind: "project", projectId: "project-one" }, sourceId: "source-one", prompt: "fixture", timing: { kind: "once", at: 1000 }, timezone: "UTC", savedCeiling: { toolClasses: [], hostServices: [], connectors: [], network: "none" }, policy: "ask", overlap: "one-active-one-pending" };
  expect(parseCoworkArgs("workspace", ["schedule", "create", "workspace-one", "--definition-json", JSON.stringify(definition), "--request-id", "create-one"])).toMatchObject({ method: "workspace.schedule.create", params: { definition } });
  expect(() => parseCoworkArgs("workspace", ["schedule", "create", "workspace-one", "--definition-json", JSON.stringify({ ...definition, cwd: "/workspace/source" }), "--request-id", "create-one"])).toThrow("Invalid arguments");
  expect(() => parseCoworkArgs("workspace", ["schedule", "list", "workspace-one", "--cwd", "/workspace/source"])).toThrow("Unsupported option");
  expect(() => parseCoworkArgs("project", ["schedule", "list", "project-one"])).toThrow("Unknown workspace/Project command");
});

test("shared guidance parser carries only content/revision/digest and renders terminal controls safely", () => {
  const args = ["instructions", "update", "workspace", "--instruction-revision", "2", "--digest", "a".repeat(64), "--content", "shared", "--request-id", "request"];
  expect(route("workspace", args)).toEqual({ method: "workspace.instructions.update", params: { workspaceId: "workspace", requestId: "request", expectedInstructionRevision: 2, expectedDigest: "a".repeat(64), content: "shared" }, json: false });
  expect(() => route("workspace", [...args, "--path", "/untrusted"])).toThrow("Unsupported option");
  const get = route("workspace", ["instructions", "get", "workspace"]);
  const lines = formatCoworkResult(get, { workspaceId: "workspace", instructionRevision: 2, digest: "a".repeat(64), bytes: 3, refreshState: "refresh-required", contentBase64: Buffer.from("\u001b[2J").toString("base64"), encoding: "utf-8" });
  expect(lines.join("\n")).not.toContain("\u001b"); expect(lines.join("\n")).toContain("\\u001b");
});
