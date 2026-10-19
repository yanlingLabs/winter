// Session door D4b: `winter workspace session create|list`, parsed strictly before any connection, through session.create
// {mode: "cowork"} and a session.list filtered by the row's workspace reference. Every production daemon refuses the create.
import { expect, test } from "bun:test";
import { COWORK_CLI_USAGE, parseCoworkSessionArgs, runCoworkSessionRoute } from "../src/cowork-cli";

test("create parses to a Cowork binding with no invented defaults; list takes the workspace only", () => {
  expect(parseCoworkSessionArgs(["session", "create", "w1", "--source", "src1", "--request-id", "r1"])).toEqual({ kind: "session-create", scope: "global", workspaceId: "w1", requestId: "r1", location: { kind: "source", sourceId: "src1" }, json: false });
  expect(parseCoworkSessionArgs(["session", "create", "w1", "--source", "src1", "--cwd", "docs/a", "--request-id", "r1", "--json"])).toMatchObject({ location: { kind: "source", sourceId: "src1", relativeCwd: "docs/a" }, json: true });
  expect(parseCoworkSessionArgs(["session", "list", "w1"])).toEqual({ kind: "session-list", workspaceId: "w1", json: false });
  for (const [args, message] of [
    [["session", "create", "w1", "--request-id", "r1"], "--source is required"],
    [["session", "create", "w1", "--source", "s"], "--request-id is required"],
    [["session", "create", "w1", "--source", "s", "--request-id", "r", "--policy", "bypass"], "Unsupported option --policy"],
    [["session", "create", "w1", "--source", "s", "--request-id", "r", "--cwd", "../up"], "Invalid arguments"],
    [["session", "create", "w1", "--source", "s", "--request-id", "r", "--cwd", "/abs"], "Invalid arguments"],
    [["session", "list", "w1", "--source", "s"], "Unsupported option --source"],
    [["session", "delete", "w1"], "Unknown workspace session command"],
    [["session", "list"], "Unexpected or missing positional arguments"],
  ] as [string[], string][]) expect(() => parseCoworkSessionArgs(args)).toThrow(message);
  expect(COWORK_CLI_USAGE).toContain("winter workspace session create <workspaceId> --source ID [--cwd RELATIVE] --request-id ID [--json]");
});

test("create sends session.create {mode: cowork} and prints the id; list shows only that workspace's Cowork rows", async () => {
  const sent: unknown[] = [];
  const client = {
    createCoworkSession: async (scope: string, cowork: unknown) => { sent.push({ scope, cowork }); return { sessionId: "s_0123456789ab", trusted: false }; },
    listSessions: async () => ({ sessions: [
      { sessionId: "s_aaaaaaaaaaaa", title: "Ours", cowork: { workspaceId: "w1", projectId: "p1" } },
      { sessionId: "s_bbbbbbbbbbbb", cowork: { workspaceId: "w2", projectId: null } },
      { sessionId: "s_cccccccccccc", title: "Code" },
    ] }),
  } as never;
  expect(await runCoworkSessionRoute(client, parseCoworkSessionArgs(["session", "create", "w1", "--source", "src1", "--request-id", "r1"]))).toEqual(["Cowork conversation s_0123456789ab in w1"]);
  expect(sent).toEqual([{ scope: "global", cowork: { workspaceId: "w1", requestId: "r1", location: { kind: "source", sourceId: "src1" } } }]);
  expect(await runCoworkSessionRoute(client, parseCoworkSessionArgs(["session", "list", "w1"]))).toEqual(["s_aaaaaaaaaaaa · Ours"]);
  expect(JSON.parse((await runCoworkSessionRoute(client, parseCoworkSessionArgs(["session", "list", "w1", "--json"])))[0]!)).toEqual({ sessions: [{ sessionId: "s_aaaaaaaaaaaa", projectId: "p1", title: "Ours" }] });
  expect(await runCoworkSessionRoute(client, parseCoworkSessionArgs(["session", "list", "w3"]))).toEqual(["(no Cowork conversations)"]);
});
