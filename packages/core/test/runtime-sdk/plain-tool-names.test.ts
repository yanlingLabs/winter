// The 2026-10-01 tool-surface ruling's NAME compatibility: the capability tools the model now calls by
// plain names (`SpawnSession`, `ListSessions`, `ManageSession`, `Computer`, `Browser`) and the SDK's
// `Search` built-in are classified, carded, rendered and ruled EXACTLY as their old `mcp__winter__…`
// spellings were — and the old spellings (saved rules, old transcripts, a call the runtime reports under
// the old spelling because a rule or matcher named it) keep working.
import { describe, expect, test } from "bun:test";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";
import { connectorFactsFor, isConnectorToolName, type ConnectorPermissionSource } from "../../src/agent/mcp/connector-permissions";
import { WINTER_CAPABILITY_TOOLS, capabilityToolName, type CapabilityToolFacts } from "../../src/capabilities/names";
import { sdkAllowRulesFor, winterGateRulesFromSdk } from "../../src/runtime-sdk/mode-options";
import { gateClassFor, gateToolNameFor, hostToolNameFor } from "../../src/runtime-sdk/tool-names";

const POLICIES: SessionApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass", "chat"];

/** Each plain name, beside the old spelling it replaced. */
const PAIRS: ReadonlyArray<readonly [plain: string, old: string]> = [
  ["SpawnSession", capabilityToolName("sessions", "session_spawn")],
  ["ListSessions", capabilityToolName("sessions", "list_sessions")],
  ["ManageSession", capabilityToolName("sessions", "manage_session")],
  ["Computer", capabilityToolName("computer", "computer")],
  ["ComputerV2", capabilityToolName("computer_v2", "script")],
  ["Browser", capabilityToolName("browser", "browser")],
  // Not a capability tool any more — the agent SDK's built-in — but the daemon's old spelling must
  // still mean the same thing to every reader.
  ["Search", capabilityToolName("research", "Search")],
];

describe("plain names ↔ old spellings", () => {
  test("every plain name in the capability table is one of the pairs", () => {
    const plain = Object.values(WINTER_CAPABILITY_TOOLS as Readonly<Record<string, CapabilityToolFacts>>).flatMap((f) => (f.plainName === undefined ? [] : [f.plainName]));
    // `Search` became a runtime built-in; `ManageSession` was removed from Dispatch (2026-10-02) — both
    // keep their pair so an old transcript's call still maps.
    expect(plain.sort()).toEqual(PAIRS.map(([p]) => p).filter((p) => p !== "Search" && p !== "ManageSession").sort());
  });

  test("map onto the SAME host name — so the renderers, the cards and the gate see one tool", () => {
    for (const [plain, old] of PAIRS) {
      expect({ plain, host: hostToolNameFor(plain) }).toEqual({ plain, host: hostToolNameFor(old) });
      expect(hostToolNameFor(plain)).toBeDefined();
      expect(gateToolNameFor(plain)).toBe(gateToolNameFor(old));
      expect(gateClassFor(plain)).toBe(gateClassFor(old));
    }
    expect(hostToolNameFor("SpawnSession")).toBe("session_spawn");
    expect(hostToolNameFor("Browser")).toBe("browser");
    expect(hostToolNameFor("Search")).toBe("Search");
  });

  test("get the same verdict under every policy (chat's Browser and Search included)", () => {
    const gate = new PermissionGate();
    for (const [plain, old] of PAIRS) {
      for (const policy of POLICIES) {
        expect({ plain, policy, v: gate.evaluate(gateClassFor(plain), policy) }).toEqual({ plain, policy, v: gate.evaluate(gateClassFor(old), policy) });
      }
    }
    // The load-bearing two: chat's own Browser and Search are ALLOWED there, never a typed deny.
    expect(gate.evaluate(gateClassFor("Browser"), "chat")).toBe("allow");
    expect(gate.evaluate(gateClassFor("Search"), "chat")).toBe("allow");
  });

  test("are never connector actions — by name, and with the runtime's stated server either", () => {
    const source: ConnectorPermissionSource = { table: () => ({ winter__browser: { "*": "deny" } }), readOnly: () => true };
    for (const [plain, old] of PAIRS) {
      expect(isConnectorToolName(plain)).toBe(false);
      expect(isConnectorToolName(old)).toBe(false);
      expect(connectorFactsFor(source, plain, "/tmp", { name: "winter__browser", configName: "winter__browser" })).toBeUndefined();
      expect(connectorFactsFor(source, old, "/tmp", { name: "winter__browser", configName: "winter__browser" })).toBeUndefined();
    }
  });

  test("a saved computer rule keeps its OLD spelling on the way out and is read back from either", () => {
    // The runtime honours `mcp__winter__computer__computer` as an equivalent identity of `Computer`, so the
    // saved form works on runtimes before and after the rename.
    expect(sdkAllowRulesFor(["Computer"])).toEqual(["mcp__winter__computer__computer"]);
    expect(winterGateRulesFromSdk(["mcp__winter__computer__computer"])).toEqual(["Computer"]);
  });
});
