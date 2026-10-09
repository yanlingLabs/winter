// ComputerV2 (2026-10-08): a `computer_v2` tool row shows its `title`, else "apps · verbs" derived from the
// code, else "Using the computer" — never the raw script (R10, spine §8).
import { describe, expect, test } from "bun:test";
import { computerV2Label, toolHeadFor } from "../../src/tui/format";
import { extractToolDetail } from "../../src/subagent-display";

const args = (o: Record<string, unknown>) => JSON.stringify(o);

describe("the ComputerV2 row label", () => {
  test("the model's title wins", () => {
    expect(computerV2Label(args({ code: "await apps.open('Notes')", title: "Add milk to the list" }))).toBe("Add milk to the list");
  });

  test("else the apps it opens and the verbs it uses, in order, de-duplicated", () => {
    const code = "const n = await apps.open(\"Notes\")\nawait n.click(3)\nawait n.paste('x')\nawait n.click(4)\nawait n.state()\nconst t = await apps.open('TextEdit')";
    expect(computerV2Label(args({ code }))).toBe("Notes, TextEdit · click, paste, state");
    expect(computerV2Label(args({ code: "print(await screen.windows())" }))).toBe("windows");
    expect(computerV2Label(args({ code: "print(1 + 1)" }))).toBe("Using the computer");
    expect(computerV2Label(args({ code: "const s = await app.state()" }))).toBe("state");
  });

  test("a partial or malformed stream still labels", () => {
    expect(computerV2Label('{"code":"await apps.open(\\"No')).toBe("Using the computer");
    expect(computerV2Label("")).toBe("Using the computer");
  });

  test("the row head: ComputerV2 + label for the host name; every other tool unchanged", () => {
    expect(toolHeadFor("computer_v2", args({ code: "await apps.open('Notes')" }))).toEqual({ name: "ComputerV2", head: "Notes" });
    expect(toolHeadFor("bash", '{"command":"ls"}')).toEqual({ name: "bash", head: '{"command":"ls"}' });
    expect(extractToolDetail("computer_v2", args({ code: "await apps.open('Mail')" }))).toBe("Mail");
  });
});
