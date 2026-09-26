import { describe, expect, test } from "bun:test";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { assertVersionMatrix, SUPPORTED } from "@yanlinglabs/winter-runtime-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { WINTER_PEER_VERSIONS, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";
import { readResolvedManifestVersion } from "@yanlinglabs/winter-runtime-sdk";

describe("peer versions", () => {
  test("the RESOLVED installed versions are the ones 8b was written against", () => {
    expect(SDK_VERSION).toBe(REQUIRED_WINTER_AGENT_SDK);          // resolved, not the ^ range
    expect(readResolvedManifestVersion("@yanlinglabs/winter-runtime-sdk")).toBe(REQUIRED_WINTER_RUNTIME_SDK);
  });
  test("WINTER_PEER_VERSIONS is host-declared from SDK_VERSION and the matrix accepts it", () => {
    // WS-23: the Winter peer is the only one — no `claudeAgentSdk` key, whatever node_modules holds.
    expect(WINTER_PEER_VERSIONS).toEqual({ winterAgentSdk: SDK_VERSION });
    const report = assertVersionMatrix({ winter }, WINTER_PEER_VERSIONS);
    expect(report.winterAgentSdk.source).toBe("host-declared");
    expect(SUPPORTED.winterAgentSdk).toBeDefined();
  });
  test("the spawn seam is on the INSTALLED barrel", () => {
    expect(typeof winter.resolveRuntimeExecutable).toBe("function");
    expect(typeof winter.defaultSpawn).toBe("function");
  });
});
