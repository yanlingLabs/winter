import { describe, expect, test } from "bun:test";
import { SDK_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { assertVersionMatrix, SUPPORTED } from "@yanlinglabs/winter-runtime-sdk";
import * as winter from "@yanlinglabs/winter-agent-sdk";
import { NORMA_PEER_VERSIONS, REQUIRED_CLAUDE_AGENT_SDK, REQUIRED_WINTER_AGENT_SDK, REQUIRED_WINTER_RUNTIME_SDK } from "../../src/runtime-sdk/versions";
import { readResolvedManifestVersion } from "@yanlinglabs/winter-runtime-sdk";

describe("peer versions", () => {
  test("the RESOLVED installed versions are the ones 8b was written against", () => {
    expect(SDK_VERSION).toBe(REQUIRED_WINTER_AGENT_SDK);          // resolved, not the ^ range
    expect(readResolvedManifestVersion("@yanlinglabs/winter-runtime-sdk")).toBe(REQUIRED_WINTER_RUNTIME_SDK);
  });
  test("NORMA_PEER_VERSIONS is host-declared from SDK_VERSION and the matrix accepts it", () => {
    // P8c-1: `claudeAgentSdk` is present here because this dev/test environment has the optional
    // `@anthropic-ai/claude-agent-sdk` peer installed (the pinned 0.3.250) — a Winter-only host
    // (the peer absent) reports the field OMITTED, which `create.test.ts`'s own peer-absence test
    // pins directly on `createNormaRuntimeSdk`'s output rather than on this process-wide constant.
    expect(NORMA_PEER_VERSIONS).toEqual({ winterAgentSdk: SDK_VERSION, claudeAgentSdk: REQUIRED_CLAUDE_AGENT_SDK });
    const report = assertVersionMatrix({ winter }, NORMA_PEER_VERSIONS);
    expect(report.winterAgentSdk.source).toBe("host-declared");
    expect(SUPPORTED.winterAgentSdk).toBeDefined();
  });
  test("the spawn seam is on the INSTALLED barrel", () => {
    expect(typeof winter.resolveRuntimeExecutable).toBe("function");
    expect(typeof winter.defaultSpawn).toBe("function");
  });
});
