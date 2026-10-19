// Cowork session door D2: the guest's tool surface (docs/research/2026-10-18-cowork-session-door-design.md 4.2-4.4).
// One composition decides what an incarnation is offered: `coworkToolsFor` (runtime-sdk/mode-options.ts) is
// `coworkOfferedTools` (cowork/session-profile.ts) over inputs whose `withheldTools` carry the guest profile's cap.
// The launch takes that list as is (`confinedToolVisibility`), and the prompt is built from the same normalised inputs,
// so the prompt, the tool list and the guest's own refusal rules cannot disagree. Every class, policy, readiness and
// network combination is swept.
import { describe, expect, test } from "bun:test";
import { CAPABILITY_SERVER_KEYS } from "../../src/capabilities/names";
import {
  COWORK_GUEST_PROFILE_TOOLS, COWORK_READINESS, COWORK_TOOL_ALLOWLIST, COWORK_UNBUILT_CAPABILITY_SERVERS, coworkOfferedTools, coworkProfileWithheldTools, coworkSystemPrompt,
  type CoworkReadinessKey,
} from "../../src/cowork/session-profile";
import { confinedToolVisibility } from "../../src/cowork/guest-runtime";
import { CoworkError } from "../../src/cowork/types";
import { COWORK_CAPABILITY_SERVERS, coworkGuestToolInputs, coworkToolsFor, type CoworkGuestToolInputs } from "../../src/runtime-sdk/mode-options";
import type { ApprovalPolicy } from "@yanlinglabs/winter-protocol";

const POLICIES: ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
const CLASSES = ["read", "write", "execute"];
const KEYS = Object.keys(COWORK_READINESS) as CoworkReadinessKey[];
const PROFILE: string[] = ["Bash", "Edit", "Read", "Write"];
const ORDER: string[] = ["Read", "Edit", "Write", "Bash"];
const subsets = <T,>(values: readonly T[]): T[][] => Array.from({ length: 1 << values.length }, (_unused, mask) => values.filter((_value, bit) => mask & (1 << bit)));
const refused = (run: () => unknown): string => { try { run(); return "accepted"; } catch (error) { return error instanceof CoworkError ? error.code : String(error); } };
const base = (over: Partial<CoworkGuestToolInputs> = {}): CoworkGuestToolInputs =>
  ({ profile: "host-query-v1", approvalPolicy: "auto", toolClasses: CLASSES, network: "internet", readiness: KEYS, ...over });

describe("the host-query-v1 profile's cap", () => {
  test("is the agent SDK profile's tool set, frozen, and each is a guest tool that needs only the compartment", () => {
    // Literal mirror of agent SDK packages/runtime/src/guest/linux-host-query-profile.ts at main 68e57c646f23
    // (`const tools = new Set(["Read", "Write", "Edit", "Bash"])`). The pinned SDK predates the profile, so this test never
    // reads it; Track A's repin pairs the host and guest SDK versions with its own test (G3/G8).
    expect(Object.keys(COWORK_GUEST_PROFILE_TOOLS)).toEqual(["host-query-v1"]);
    expect([...COWORK_GUEST_PROFILE_TOOLS["host-query-v1"]] as string[]).toEqual(PROFILE);
    expect(Object.isFrozen(COWORK_GUEST_PROFILE_TOOLS)).toBe(true); expect(Object.isFrozen(COWORK_GUEST_PROFILE_TOOLS["host-query-v1"])).toBe(true);
    for (const name of PROFILE) {
      const row = COWORK_TOOL_ALLOWLIST.find(candidate => candidate.name === name);
      expect([name, row?.runs, row?.brokers, row?.needs]).toEqual([name, "guest", [], ["guest-compartment"]]);
    }
  });

  test("withholds every other allowlisted name, the host brokers included (G4), and Edit with Read or Write", () => {
    const others = COWORK_TOOL_ALLOWLIST.map(row => row.name).filter(name => !PROFILE.includes(name)).sort();
    expect(others.length).toBeGreaterThan(20);
    expect(coworkProfileWithheldTools("host-query-v1")).toEqual(others);
    for (const broker of ["SendMessage", "ListAgents", "TaskStop", "AskUserQuestion", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskOutput", "Agent", "ToolSearch", "CronCreate", "WebFetch"]) {
      expect([broker, coworkProfileWithheldTools("host-query-v1").includes(broker)]).toEqual([broker, true]);
    }
    expect(coworkProfileWithheldTools("host-query-v1", ["Read"])).toEqual([...others, "Edit", "Read"].sort());
    expect(coworkProfileWithheldTools("host-query-v1", ["Write"])).toEqual([...others, "Edit", "Write"].sort());
    expect(coworkProfileWithheldTools("host-query-v1", ["Bash"])).toEqual([...others, "Bash"].sort());
    expect(coworkProfileWithheldTools("host-query-v1", ["Edit"])).toEqual([...others, "Edit"].sort());
    expect(coworkProfileWithheldTools("host-query-v1", ["Glob", "Glob"])).toEqual(others);
    expect(refused(() => coworkProfileWithheldTools("host-query-guided-v1" as never))).toBe("invalid_request");
    expect(refused(() => coworkProfileWithheldTools("toString" as never))).toBe("invalid_request");
    expect(refused(() => coworkProfileWithheldTools("host-query-v1", ["Teleport"]))).toBe("invalid_request");
    expect(refused(() => coworkProfileWithheldTools("host-query-v1", [7 as never]))).toBe("invalid_request");
    expect(refused(() => coworkProfileWithheldTools("host-query-v1", "Read" as never))).toBe("invalid_request");
  });
});

describe("coworkToolsFor: one composition, swept across every combination", () => {
  test("every class x policy x readiness x network combination: inside the cap, the class rule exactly, and the launch takes it as is", () => {
    let combinations = 0;
    for (const toolClasses of subsets(CLASSES)) for (const approvalPolicy of POLICIES) for (const readiness of subsets(KEYS)) for (const network of ["none", "internet"] as const) {
      const input = base({ toolClasses, approvalPolicy, readiness, network }), tools = coworkToolsFor(input);
      combinations++;
      // The ONE function, over the ONE normalisation.
      expect(tools as string[]).toEqual(coworkOfferedTools(coworkGuestToolInputs(input)));
      // Never beyond the profile, and exactly the class rule once the compartment is declared (nothing else matters).
      const compartment = readiness.includes("guest-compartment"), has = (name: string) => toolClasses.includes(name);
      const expected = compartment ? [has("execute") && "Bash", has("read") && has("write") && "Edit", has("read") && "Read", has("write") && "Write"].filter((name): name is string => typeof name === "string") : [];
      if (JSON.stringify(tools) !== JSON.stringify(expected)) expect([toolClasses, approvalPolicy, readiness, network, tools]).toEqual([toolClasses, approvalPolicy, readiness, network, expected]);
      // The guest launch's list is the same set, in the guest's order, and never throws for an offered list.
      const launch = confinedToolVisibility(tools);
      if (JSON.stringify(launch) !== JSON.stringify(ORDER.filter(name => (tools as string[]).includes(name)))) expect(launch as readonly string[]).toEqual(ORDER.filter(name => (tools as string[]).includes(name)));
    }
    expect(combinations).toBe(8 * 6 * 512 * 2);
  });

  test("a host withholding keeps the profile's Edit rule: withholding Read or Write also removes Edit, so the guest never refuses the list", () => {
    for (const withheld of subsets(PROFILE)) {
      const tools = coworkToolsFor(base({ withheldTools: withheld }));
      expect(tools.filter(name => withheld.includes(name))).toEqual([]);
      expect(tools.includes("Edit")).toBe(!withheld.includes("Edit") && !withheld.includes("Read") && !withheld.includes("Write"));
      expect(() => confinedToolVisibility(tools)).not.toThrow();
    }
  });

  test("the normalisation forces no MCP server and keeps the caller's own fields", () => {
    const input = base({ exposure: { mcpServers: true, toolSearch: true, exaKeyPresent: false }, withheldTools: ["Bash"] });
    const normalised = coworkGuestToolInputs(input);
    expect(normalised.exposure).toEqual({ mcpServers: false, toolSearch: true, exaKeyPresent: false });
    expect("profile" in normalised).toBe(false);
    expect(normalised).toMatchObject({ approvalPolicy: "auto", toolClasses: CLASSES, network: "internet", readiness: KEYS });
    expect(normalised.withheldTools).toEqual(coworkProfileWithheldTools("host-query-v1", ["Bash"]));
    // An admitted MCP server would add ToolSearch to an unnormalised offer; the guest's offer never has it.
    expect(coworkOfferedTools({ ...input, exposure: { mcpServers: true } })).toContain("ToolSearch");
    expect(coworkToolsFor(input)).toEqual(["Edit", "Read", "Write"]);
    expect(input.exposure).toEqual({ mcpServers: true, toolSearch: true, exaKeyPresent: false }); // the caller's object is untouched
  });

  test("bad inputs refuse typed, never offer: an unknown profile, policy, network, class list, readiness key or withheld name", () => {
    expect(refused(() => coworkToolsFor(base({ profile: "host-query-guided-v1" as never })))).toBe("invalid_request");
    expect(refused(() => coworkToolsFor(base({ approvalPolicy: "chat" as never })))).toBe("invalid_request");
    expect(refused(() => coworkToolsFor(base({ network: "lan" as never })))).toBe("invalid_request");
    expect(refused(() => coworkToolsFor(base({ toolClasses: "read" as never })))).toBe("invalid_request");
    expect(refused(() => coworkToolsFor(base({ readiness: ["made-up" as never] })))).toBe("invalid_request");
    expect(refused(() => coworkToolsFor(base({ withheldTools: ["Teleport"] })))).toBe("invalid_request");
  });
});

describe("the prompt names only what the guest is offered (G4)", () => {
  // Every name the profile withholds that the prompt could otherwise mention, and the sentences that introduce them.
  const NEVER = ["SendMessage", "ListAgents", "TaskStop", "AskUserQuestion", "CronCreate", "CronList", "CronDelete", "ScheduleWakeup", "ExitPlanMode", "WebFetch", "WebSearch", "ToolSearch",
    "Agent starts a subagent", "Search the web", "Workflow still asks", "# Scheduling"];
  test("for every policy, network, ceiling and ownership, with every readiness key declared", () => {
    for (const approvalPolicy of POLICIES) for (const network of ["none", "internet"] as const) for (const toolClasses of subsets(CLASSES)) for (const ownership of ["standalone", "project"] as const) {
      const input = base({ approvalPolicy, network, toolClasses });
      const prompt = coworkSystemPrompt({ ...coworkGuestToolInputs(input), ownership, sessionId: "s_0123456789ab", workspaceTitle: "Fixture" });
      for (const phrase of NEVER) if (prompt.includes(phrase)) expect([approvalPolicy, network, toolClasses, ownership, phrase]).toEqual([approvalPolicy, network, toolClasses, ownership, "absent"]);
      // ...and the file and shell tools it does name are exactly the offered ones.
      const tools = coworkToolsFor(input), hands = tools.length > 0;
      expect(prompt.includes("Your shell, your file tools and your subagents all run inside it.")).toBe(hands);
    }
  });

  test("the same facts without the profile's cap would name the brokers: the cap is what keeps them out", () => {
    const facts = { approvalPolicy: "auto" as const, toolClasses: CLASSES, network: "internet" as const, readiness: KEYS, ownership: "project" as const, sessionId: "s_0123456789ab" };
    expect(coworkSystemPrompt(facts)).toContain("SendMessage");
    expect(coworkSystemPrompt({ ...facts, ...coworkGuestToolInputs({ ...facts, profile: "host-query-v1" }) })).not.toContain("SendMessage");
  });
});

describe("the launch's visibility takes the offered list and fails closed", () => {
  test("canonical order, frozen, and the same set", () => {
    expect(confinedToolVisibility(["Bash", "Write", "Read", "Edit"]) as readonly string[]).toEqual(ORDER);
    expect(confinedToolVisibility(["Write", "Read"])).toEqual(["Read", "Write"]);
    expect(confinedToolVisibility([])).toEqual([]);
    expect(Object.isFrozen(confinedToolVisibility(["Read"]))).toBe(true);
  });

  test("refuses a stale ceiling-class argument, an unknown or repeated name, and Edit without both Read and Write", () => {
    for (const bad of [["read", "write"], ["execute"], ["Glob"], ["Read", "Read"], ["Edit"], ["Edit", "Read"], ["Edit", "Write"], ["Bash", "mcp__x__y"], "Read", [7]]) {
      expect([bad, refused(() => confinedToolVisibility(bad as never))]).toEqual([bad, "invalid_request"]);
    }
    // ...and a stale caller fails at COMPILE time (`tsc` reports an unused directive if either line ever compiles).
    // @ts-expect-error a ceiling class is not a guest tool
    expect(refused(() => confinedToolVisibility(["read", "write"]))).toBe("invalid_request");
    const fromAnywhere: string[] = ["Read"];
    // @ts-expect-error an arbitrary string list is not a guest tool list
    expect(refused(() => confinedToolVisibility(fromAnywhere))).toBe("accepted");
  });
});

describe("no capability server for a Cowork incarnation", () => {
  test("the server list is empty and frozen, and every server key is unbuilt in the profile", () => {
    expect(COWORK_CAPABILITY_SERVERS).toEqual([]);
    expect(Object.isFrozen(COWORK_CAPABILITY_SERVERS)).toBe(true);
    const unbuilt = COWORK_UNBUILT_CAPABILITY_SERVERS.map(row => row.key).sort();
    expect(unbuilt).toEqual([...CAPABILITY_SERVER_KEYS].sort());
    expect(CAPABILITY_SERVER_KEYS.filter(key => !unbuilt.includes(key))).toEqual([...COWORK_CAPABILITY_SERVERS]);
  });
});
