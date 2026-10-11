// ComputerV2 Phase 4: a saved script's call reads as "script <name>" in the row label (never its source); saving one
// is not a call of one — the saved function's own verbs still show.
import { describe, expect, test } from "bun:test";
import { computerV2Label } from "../../src/tui/format";

const args = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("computerV2Label for saved scripts", () => {
  test("scripts.<name>( is shown as script <name>, among the verbs in the order the code uses them", () => {
    expect(computerV2Label(args({ code: "await scripts.exportCsv(sheet, '/tmp/a.csv')" }))).toBe("script exportCsv");
    expect(computerV2Label(args({ code: "await apps.open('Numbers'); await scripts.exportCsv(s, p); await n.state()" }))).toBe("Numbers · script exportCsv, state");
    expect(computerV2Label(args({ code: "await scripts.fill(a, 'x'); await scripts.fill(a, 'y')" }))).toBe("script fill");
  });
  test("scripts.save( is not a saved script's call; the saved function's verbs show", () => {
    expect(computerV2Label(args({ code: "await scripts.save('fill', async (app, v) => { await app.click(3); await app.type(v) })" }))).toBe("click, type");
    expect(computerV2Label(args({ code: "await scripts.save('noop', () => 1)" }))).toBe("Using the computer");
  });
});
