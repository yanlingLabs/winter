// A redirection GLUED to a wrapper's argument (`timeout x>FILE`, `nice -n5>FILE`, `time -p>FILE ls`) is still
// a redirection to bash -- it writes FILE even when the duration is invalid or `timeout` is not installed. The
// agent SDK's bypass write floor once let the wrapper's argument word swallow it (security review, agent SDK
// 0.0.40). Winter's own static matchers are pinned here against the same shapes: the protected-path Bash
// fence (`bashProtectedWriteHit`, every policy) and the sandbox-escape floor (`escapeFloorHit`).
import { describe, expect, test } from "bun:test";
import { bashProtectedWriteHit, escapeFloorHit } from "../../src/runtime-sdk/hooks";

const HOME = "/Users/someone/.winter";

/** The glued shapes, each writing `target`. */
function gluedShapes(target: string): string[] {
  return [
    `timeout x>${target}`,
    `timeout x>>${target}`,
    `timeout x>|${target}`,
    `timeout x&>${target}`,
    `timeout 5>${target}`,
    `timeout 5 >${target} ls`,
    `nice -n5>${target}`,
    `nice -n 5>${target} ls`,
    `timeout -k1>${target} 5 ls`,
    `time -p>${target} ls`,
    `nohup x>${target}`,
    `env A=1>${target} ls`,
    `sudo -u x>${target} ls`,
    `command -p>${target} ls`,
    `exec 3>${target}`,
    `stdbuf -o0>${target} ls`,
  ];
}

describe("glued redirections reach Winter's static write matchers", () => {
  test("the protected-path Bash fence sees every glued redirect into a protected directory", () => {
    for (const target of [".winter/rules/x.md", ".winter/skills/s/SKILL.md", ".winter/agents/a.md"]) {
      for (const cmd of gluedShapes(target)) expect({ cmd, hit: bashProtectedWriteHit(cmd) !== undefined }).toEqual({ cmd, hit: true });
    }
  });

  test("the sandbox-escape floor sees every glued redirect into a self-grant store", () => {
    for (const target of [`${HOME}/sdk/settings.json`, `${HOME}/trust.json`, ".winter/settings.local.json", ".winter/mcp.json", `${HOME}/run/core.sock`]) {
      for (const cmd of gluedShapes(target)) expect({ cmd, hit: escapeFloorHit(cmd, HOME, "/tmp/project") !== undefined }).toEqual({ cmd, hit: true });
    }
  });

  test("the escape floor's write-position-only paths (cache, plugins, sdk/projects) are caught behind a glued redirect too", () => {
    for (const target of [`${HOME}/cache/runs/r1/x`, `${HOME}/plugins/p/hooks/hooks.json`, `${HOME}/sdk/plugins/p/x`, `${HOME}/sdk/projects/k/transcript.jsonl`]) {
      for (const cmd of gluedShapes(target)) expect({ cmd, hit: escapeFloorHit(cmd, HOME, "/tmp/project") !== undefined }).toEqual({ cmd, hit: true });
    }
    // ...while reading them through a wrapper stays allowed (plugin skill scripts must still run).
    for (const cmd of [`timeout 5 cat ${HOME}/plugins/p/skills/s/run.sh`, `nice -n5 ls ${HOME}/cache`]) {
      expect({ cmd, hit: escapeFloorHit(cmd, HOME, "/tmp/project") }).toEqual({ cmd, hit: undefined });
    }
  });

  test("the same wrappers reading (not writing) those paths stay unflagged by the protected fence", () => {
    for (const cmd of ["timeout 5 cat .winter/rules/x.md", "nice -n5 ls .winter/skills", "time -p cat .winter/agents/a.md"]) {
      expect({ cmd, hit: bashProtectedWriteHit(cmd) }).toEqual({ cmd, hit: undefined });
    }
  });
});
