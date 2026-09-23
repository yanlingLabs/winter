// WS-21 L3.1 (Contract C): the shared runtime home's paths and its two claude-format files.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import { sdkGlobalConfigPath, sdkHomeFor, sdkPluginsRoot, sdkSettingsPath, SDK_PERSISTENT_ENTRIES, storeHomeFor, storeProjectsDir } from "../src/agent/paths";
import { assistantMemoryDirFor, globalMemoryDirFor, memoryDirFor, sanitizeProjectKey } from "../src/agent/memory-dir";
import { userAgentsDir } from "../src/agent/agent-definitions";
import { userWorkflowsDir } from "../src/workflows/store";
import { linkedRouterSupportsRunHome, routerSupportsRunHome, setRunHomeSupportForTests } from "../src/runtime-sdk/run-home-support";
import {
  readSdkGlobalConfig,
  readSdkSettings,
  readSdkSettingsDetailed,
  SdkFileUnreadable,
  updateSdkGlobalConfig,
  updateSdkSettings,
} from "../src/sdk-files";
import { winterSessions } from "../src/runtime-sdk/sessions";

const tmpHome = (): string => realpathSync(mkdtempSync(join(tmpdir(), "winter-sdkfiles-")));

describe("Contract C paths", () => {
  test("sdkHomeFor and the three file/dir helpers", () => {
    expect(sdkHomeFor("/h")).toBe("/h/sdk");
    expect(sdkSettingsPath("/h")).toBe("/h/sdk/settings.json");
    expect(sdkGlobalConfigPath("/h")).toBe("/h/sdk/.winter.json");
    expect(sdkPluginsRoot("/h")).toBe("/h/sdk/plugins");
  });

  test("the persistent set is claude's (F18), in the router's order", () => {
    expect([...SDK_PERSISTENT_ENTRIES]).toEqual(["file-history", "tasks", "teams", "agent-memory", "workflows"]);
  });
});

describe("sdk-files: settings.json", () => {
  test("a missing file reads as {} and reports missing", () => {
    const home = tmpHome();
    expect(readSdkSettings(home)).toEqual({});
    expect(readSdkSettingsDetailed(home).state).toBe("missing");
  });

  test("updateSdkSettings creates sdk/ (0700) and writes the file at 0600", () => {
    const home = tmpHome();
    updateSdkSettings(home, (s) => ({ ...s, permissions: { deny: ["Skill(x)"] } }));
    expect(statSync(sdkHomeFor(home)).mode & 0o777).toBe(0o700);
    expect(statSync(sdkSettingsPath(home)).mode & 0o777).toBe(0o600);
    expect(readSdkSettings(home)).toEqual({ permissions: { deny: ["Skill(x)"] } });
  });

  test("an update preserves every key it did not touch, and leaves no temp file behind", () => {
    const home = tmpHome();
    mkdirSync(sdkHomeFor(home), { recursive: true });
    writeFileSync(sdkSettingsPath(home), JSON.stringify({ theme: "dark", env: { A: "1" } }));
    updateSdkSettings(home, (s) => ({ ...s, outputStyle: "Explanatory" }));
    expect(readSdkSettings(home)).toEqual({ theme: "dark", env: { A: "1" }, outputStyle: "Explanatory" });
    expect(readdirSync(sdkHomeFor(home))).toEqual(["settings.json"]);
    // Rewriting an existing file re-applies 0600 (the temp file is always created 0600).
    expect(statSync(sdkSettingsPath(home)).mode & 0o777).toBe(0o600);
  });

  test("an unparseable file reads as {} (reported invalid) and a write REFUSES to clobber it", () => {
    const home = tmpHome();
    mkdirSync(sdkHomeFor(home), { recursive: true });
    writeFileSync(sdkSettingsPath(home), '{"permissions": {"allow": ["Bash(ls)"]'); // a half-written edit
    expect(readSdkSettings(home)).toEqual({});
    expect(readSdkSettingsDetailed(home)).toEqual({ state: "invalid", reason: "not JSON" });
    expect(() => updateSdkSettings(home, (s) => ({ ...s, outputStyle: "x" }))).toThrow(SdkFileUnreadable);
    expect(readFileSync(sdkSettingsPath(home), "utf8")).toBe('{"permissions": {"allow": ["Bash(ls)"]');
  });

  test("a JSON array or scalar is not a settings object", () => {
    const home = tmpHome();
    mkdirSync(sdkHomeFor(home), { recursive: true });
    writeFileSync(sdkSettingsPath(home), "[1,2]");
    expect(readSdkSettingsDetailed(home).state).toBe("invalid");
    expect(() => updateSdkSettings(home, (s) => s)).toThrow(SdkFileUnreadable);
  });

  test("a mutator that throws leaves the file untouched", () => {
    const home = tmpHome();
    updateSdkSettings(home, () => ({ outputStyle: "a" }));
    expect(() => updateSdkSettings(home, (s) => { s.outputStyle = "b"; throw new Error("boom"); })).toThrow("boom");
    expect(readSdkSettings(home)).toEqual({ outputStyle: "a" });
  });

  test("a concurrent reader in another process never sees a torn file", async () => {
    const home = tmpHome();
    const big = (n: number) => ({ n, permissions: { allow: Array.from({ length: 2000 }, (_, i) => `Bash(echo ${n}-${i})`) } });
    updateSdkSettings(home, () => big(0));
    const reader = Bun.spawn([process.execPath, "-e", `
      const { readFileSync } = require("node:fs");
      const path = ${JSON.stringify(sdkSettingsPath(home))};
      const until = Date.now() + 1500;
      let reads = 0, torn = 0;
      while (Date.now() < until) {
        try { JSON.parse(readFileSync(path, "utf8")); reads++; } catch (e) { if (e && e.code !== "ENOENT") torn++; }
      }
      console.log(JSON.stringify({ reads, torn }));
    `], { stdout: "pipe" });
    const until = Date.now() + 1200;
    let n = 1;
    while (Date.now() < until) { updateSdkSettings(home, () => big(n++)); await Bun.sleep(0); }
    const out = JSON.parse(await new Response(reader.stdout).text()) as { reads: number; torn: number };
    await reader.exited;
    expect(out.reads).toBeGreaterThan(0);
    expect(out.torn).toBe(0);
    expect(n).toBeGreaterThan(5);
  });
});

describe("sdk-files: .winter.json", () => {
  test("user and local MCP servers round-trip, other keys preserved", () => {
    const home = tmpHome();
    mkdirSync(sdkHomeFor(home), { recursive: true });
    writeFileSync(sdkGlobalConfigPath(home), JSON.stringify({ numStartups: 3 }));
    updateSdkGlobalConfig(home, (c) => ({ ...c, mcpServers: { a: { command: "x" } }, projects: { "/r": { mcpServers: { b: { command: "y" } } } } }));
    expect(readSdkGlobalConfig(home)).toEqual({ numStartups: 3, mcpServers: { a: { command: "x" } }, projects: { "/r": { mcpServers: { b: { command: "y" } } } } });
    expect(statSync(sdkGlobalConfigPath(home)).mode & 0o777).toBe(0o600);
  });
});

// The runtime-facing directories follow the LINKED router (`storeHomeFor`): `<home>/sdk` once it
// applies run homes, `<home>` before that — because the agent SDK 0.0.20 child and router 0.0.11 write
// and scan `<home>/projects`/`<home>/agents`, and their stores refuse a symlinked `projects/` level.
describe("the store home follows the linked router (storeHomeFor)", () => {
  afterEach(() => setRunHomeSupportForTests(undefined));

  test("with no override, the store home is the linked router's answer (router 0.0.11 on the lane branch: <home>)", async () => {
    const linked = routerSupportsRunHome(await import("@yanlinglabs/winter-runtime-sdk"));
    expect(linkedRouterSupportsRunHome()).toBe(linked);
    expect(storeHomeFor("/h")).toBe(linked ? "/h/sdk" : "/h");
  });

  test("routerSupportsRunHome feature-detects a callable buildRunHome only", () => {
    expect(routerSupportsRunHome({ buildRunHome: async () => ({}) })).toBe(true);
    expect(routerSupportsRunHome({ buildRunHome: "x" })).toBe(false);
    expect(routerSupportsRunHome({})).toBe(false);
    expect(routerSupportsRunHome(null)).toBe(false);
  });

  for (const supported of [true, false]) {
    const root = supported ? "/h/sdk" : "/h";
    test(`run homes ${supported ? "applied" : "not applied"}: memory, assistant memory, agents and workflows under ${root}`, () => {
      setRunHomeSupportForTests(supported);
      expect(storeHomeFor("/h")).toBe(root);
      expect(storeProjectsDir("/h")).toBe(`${root}/projects`);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-sdkfiles-cwd-")));
      expect(memoryDirFor(cwd, { winterHome: "/h" })).toBe(`${root}/projects/${sanitizeProjectKey(cwd)}/memory`);
      expect(assistantMemoryDirFor({ winterHome: "/h" })).toBe(`${root}/projects/_assistant/memory`);
      expect(globalMemoryDirFor({ winterHome: "/h" })).toBe(`${root}/projects/_global/memory`);
      expect(userAgentsDir("/h")).toBe(`${root}/agents`);
      expect(userWorkflowsDir("/h")).toBe(`${root}/workflows`);
    });

    test(`run homes ${supported ? "applied" : "not applied"}: winterSessions (hasTranscript's door) finds a transcript under ${root}/projects`, async () => {
      setRunHomeSupportForTests(supported);
      const home = tmpHome();
      const store = new WinterCompatibilitySessionStore({ winterHome: supported ? sdkHomeFor(home) : home });
      const sessionId = crypto.randomUUID();
      await store.append({ projectKey: "p", sessionId }, [
        { type: "user", uuid: crypto.randomUUID(), parentUuid: null, sessionId, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } } as never,
      ]);
      expect(await winterSessions(home).getSessionInfo(sessionId)).toBeDefined();
      // …and the OTHER layout's store does not have it.
      setRunHomeSupportForTests(!supported);
      await expect(winterSessions(home).getSessionInfo(sessionId)).rejects.toThrow();
    });
  }
});
